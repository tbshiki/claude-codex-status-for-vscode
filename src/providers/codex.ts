import { readFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  NotAuthenticatedError,
  ProviderUsage,
  RateLimitError,
  UsageLimit,
  UsageProvider,
} from './types';

const CODEX_REQUEST_TIMEOUT_MS = 15_000;

interface CodexRateLimitWindow {
  usedPercent?: unknown;
  resetsAt?: unknown;
  windowDurationMins?: unknown;
}

interface CodexRateLimitSnapshot {
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
  individualLimit?: {
    remainingPercent?: unknown;
    resetsAt?: unknown;
  } | null;
}

interface CodexRateLimitResponse {
  rateLimits?: CodexRateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, CodexRateLimitSnapshot> | null;
}

interface CodexAuthFile {
  tokens?: {
    access_token?: unknown;
    account_id?: unknown;
  };
  access_token?: unknown;
  account_id?: unknown;
}

/** OpenAI Codex のローカル認証情報を使い、使用状況 API から取得する。 */
export class CodexProvider implements UsageProvider {
  readonly id = 'codex' as const;
  readonly label = 'Codex';
  readonly icon = '$(zap)';

  async fetchUsage(): Promise<ProviderUsage> {
    const auth = await readCodexAuth(resolveCodexAuthPath());
    const response = await requestWhamUsage(auth);
    return normalizeCodexUsage(response);
  }
}

/** WHAM の直接レスポンスと app-server 形式の両方を受け付ける。 */
export function normalizeCodexUsage(raw: unknown): ProviderUsage {
  if (isRecord(raw) && isRecord(raw.rate_limit)) {
    return normalizeWhamUsage(raw.rate_limit);
  }
  return normalizeCodexRateLimits(raw);
}

function normalizeWhamUsage(raw: Record<string, any>): ProviderUsage {
  const limits: UsageLimit[] = [];
  appendWhamWindow(limits, raw.primary_window, true);
  appendWhamWindow(limits, raw.secondary_window, false);
  if (limits.length === 0) {
    throw new Error('Codex の利用状況にレート制限枠がありません');
  }
  return { limits };
}

function appendWhamWindow(
  limits: UsageLimit[],
  value: unknown,
  primary: boolean
): void {
  if (!isRecord(value) || typeof value.used_percent !== 'number') {
    return;
  }
  const usedPercent = clampPercent(value.used_percent);
  const windowSeconds = typeof value.limit_window_seconds === 'number' && value.limit_window_seconds > 0
    ? value.limit_window_seconds
    : undefined;
  const isFiveHour = primary && windowSeconds === 18_000;
  const isSevenDay = !primary && windowSeconds === 604_800;
  const shortLabel = isFiveHour ? '5h' : isSevenDay ? '7d' : primary ? '全体' : '7d';
  const label = isFiveHour ? 'セッション(5h)' : isSevenDay ? '週' : primary ? '全体' : '週';
  const resetsAt = toIsoTimestamp(value.reset_at) ?? toIsoTimestampAfter(value.reset_after_seconds);
  const remainingPercent = 100 - usedPercent;
  limits.push({
    label,
    shortLabel,
    utilization: remainingPercent,
    resetsAt,
    primary,
    active: remainingPercent < 100,
    severity: severityFor(usedPercent),
    percentageKind: 'remaining',
  });
}

/**
 * Codex の非公開プロトコルを表示側の共通形式へ変換する。
 * 複数バケットがある新形式を優先し、旧形式の rateLimits にも対応する。
 */
export function normalizeCodexRateLimits(raw: unknown): ProviderUsage {
  if (!isRecord(raw)) {
    throw new Error('Codex の利用状況レスポンス形式が不正です');
  }

  const response = raw as CodexRateLimitResponse;
  const mappedBuckets = response.rateLimitsByLimitId && isRecord(response.rateLimitsByLimitId)
    ? Object.values(response.rateLimitsByLimitId)
    : [];
  const buckets = mappedBuckets.length > 0
    ? mappedBuckets
    : response.rateLimits
      ? [response.rateLimits]
      : [];

  const limits: UsageLimit[] = [];
  for (const bucket of buckets) {
    if (!isRecord(bucket)) {
      continue;
    }
    appendWindow(limits, bucket.primary, '5h', '5時間');
    appendWindow(limits, bucket.secondary, '7d', '週');

    const individual = bucket.individualLimit;
    if (isRecord(individual) && typeof individual.remainingPercent === 'number') {
      const resetsAt = toIsoTimestamp(individual.resetsAt);
      limits.push({
        label: '契約枠',
        shortLabel: 'plan',
        utilization: clampPercent(100 - individual.remainingPercent),
        resetsAt,
        primary: false,
        active: true,
        severity: severityFor(100 - individual.remainingPercent),
      });
    }
  }

  if (limits.length === 0) {
    throw new Error('Codex の利用状況にレート制限枠がありません');
  }
  return { limits };
}

function appendWindow(
  limits: UsageLimit[],
  value: unknown,
  fallbackShortLabel: string,
  fallbackLabel: string
): void {
  if (!isRecord(value) || typeof value.usedPercent !== 'number') {
    return;
  }
  const duration = typeof value.windowDurationMins === 'number'
    ? value.windowDurationMins
    : undefined;
  const shortLabel = duration === 10080 ? '7d' : duration === 300 ? '5h' : fallbackShortLabel;
  const label = duration === 10080 ? '週' : duration === 300 ? 'セッション(5h)' : fallbackLabel;
  const utilization = clampPercent(value.usedPercent);
  limits.push({
    label,
    shortLabel,
    utilization,
    resetsAt: toIsoTimestamp(value.resetsAt),
    primary: shortLabel === '5h' || shortLabel === '7d',
    active: utilization > 0,
    severity: severityFor(utilization),
  });
}

async function readCodexAuth(authPath: string): Promise<{ accessToken: string; accountId?: string }> {
  let raw: string;
  try {
    raw = await readFile(authPath, 'utf8');
  } catch {
    throw new NotAuthenticatedError('Codex の auth.json が見つかりません。codex login を確認してください。');
  }

  let auth: CodexAuthFile;
  try {
    auth = JSON.parse(raw) as CodexAuthFile;
  } catch {
    throw new NotAuthenticatedError('Codex の auth.json を読み取れませんでした。');
  }
  const accessToken = typeof auth.tokens?.access_token === 'string'
    ? auth.tokens.access_token
    : typeof auth.access_token === 'string'
      ? auth.access_token
      : undefined;
  const accountId = typeof auth.tokens?.account_id === 'string'
    ? auth.tokens.account_id
    : typeof auth.account_id === 'string'
      ? auth.account_id
      : undefined;
  if (!accessToken) {
    throw new NotAuthenticatedError('Codex のアクセストークンが見つかりません。codex login を確認してください。');
  }
  return { accessToken, accountId };
}

async function requestWhamUsage(auth: { accessToken: string; accountId?: string }): Promise<unknown> {
  const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CODEX_REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${auth.accessToken}`,
      Accept: 'application/json',
      'User-Agent': 'claude-codex-status/0.1.11',
    };
    if (auth.accountId) {
      headers['ChatGPT-Account-Id'] = auth.accountId;
    }
    const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      headers,
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new NotAuthenticatedError('Codex の認証が切れています。codex login を確認してください。');
    }
    if (response.status === 429) {
      throw new RateLimitError('Codex のレート制限により取得できませんでした');
    }
    if (!response.ok) {
      throw new Error(`Codex の使用状況取得に失敗しました (${response.status})`);
    }
    return await response.json();
  } catch (err) {
    if (err instanceof NotAuthenticatedError || err instanceof RateLimitError) {
      throw err;
    }
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Codex の使用状況取得がタイムアウトしました');
    }
    throw new Error('Codex の使用状況を取得できませんでした');
  } finally {
    clearTimeout(timer);
  }
}

function resolveCodexAuthPath(): string {
  const cfg = vscode.workspace.getConfiguration('claudeCodexStatus');
  const override = cfg.get<string>('codex.authPath', '').trim();
  return override || path.join(os.homedir(), '.codex', 'auth.json');
}

function toIsoTimestamp(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toIsoTimestampAfter(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return new Date(Date.now() + value * 1000).toISOString();
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function severityFor(utilization: number): string {
  return utilization >= 90 ? 'critical' : utilization >= 80 ? 'warning' : 'normal';
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
