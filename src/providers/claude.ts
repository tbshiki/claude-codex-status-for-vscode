import * as vscode from 'vscode';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  NotAuthenticatedError,
  ProviderUsage,
  RateLimitError,
  UsageLimit,
  UsageProvider,
} from './types';

/** api.anthropic.com が返す生レスポンス(非公式・非保証)。 */
interface RawLimit {
  kind?: string;
  group?: string;
  percent?: number;
  severity?: string;
  resets_at?: string | null;
  is_active?: boolean;
  scope?: {
    model?: { id?: string | null; display_name?: string | null } | null;
    surface?: unknown;
  } | null;
}

interface RawWindow {
  utilization?: number;
  resets_at?: string | null;
}

interface RawUsageResponse {
  five_hour?: RawWindow;
  seven_day?: RawWindow;
  limits?: RawLimit[];
}

/**
 * Claude Code の OAuth 認証情報を使い、レート制限枠の利用率を取得する。
 * エンドポイントとヘッダは非公式のため、失敗時は例外に委ねてフェイルソフトにする。
 */
export class ClaudeProvider implements UsageProvider {
  readonly id = 'claude' as const;
  readonly label = 'Claude';
  readonly icon = '$(pulse)';

  async fetchUsage(): Promise<ProviderUsage> {
    const raw = (await this.fetchRaw()) as RawUsageResponse;
    return { limits: toLimits(raw) };
  }

  /**
   * 使用状況エンドポイントの生レスポンス(パース済み)を返す。
   * どのウィンドウやフィールドが実際に含まれるかを診断するために使う。
   * レスポンス本体にトークンは含まれない。
   */
  async fetchRaw(): Promise<unknown> {
    const token = this.readAccessToken();
    if (!token) {
      throw new NotAuthenticatedError(
        'credentials.json からトークンを取得できませんでした。claude login を確認してください。'
      );
    }
    return this.request(token);
  }

  private getCredentialsPath(): string {
    const cfg = vscode.workspace.getConfiguration('claudeCodexStatus');
    const override = cfg.get<string>('claude.credentialsPath', '');
    if (override && override.trim().length > 0) {
      return override;
    }
    return path.join(os.homedir(), '.claude', '.credentials.json');
  }

  private readAccessToken(): string | undefined {
    const credPath = this.getCredentialsPath();
    try {
      const rawText = fs.readFileSync(credPath, 'utf8');
      const json = JSON.parse(rawText);
      return json?.claudeAiOauth?.accessToken;
    } catch {
      return undefined;
    }
  }

  private request(token: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'api.anthropic.com',
          path: '/api/oauth/usage',
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            'anthropic-beta': 'oauth-2025-04-20',
          },
          timeout: 10000,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) {
              try {
                resolve(JSON.parse(data));
              } catch {
                reject(new Error('レスポンスのJSON解析に失敗しました'));
              }
            } else if (status === 429) {
              reject(
                new RateLimitError(
                  'レート制限(HTTP 429)',
                  parseRetryAfter(res.headers['retry-after'])
                )
              );
            } else {
              reject(new Error(`HTTP ${status}`));
            }
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    });
  }
}

/**
 * 生レスポンスを UsageLimit[] へ正規化する。
 * 新しい `limits` 配列があればそれを正とし、無ければ旧来の
 * five_hour / seven_day へフォールバックする(フェイルソフト)。
 */
function toLimits(raw: RawUsageResponse): UsageLimit[] {
  if (Array.isArray(raw.limits) && raw.limits.length > 0) {
    return raw.limits.map(mapLimit);
  }
  return legacyLimits(raw);
}

function mapLimit(l: RawLimit): UsageLimit {
  const utilization = Math.round(l.percent ?? 0);
  const resetsAt = l.resets_at ?? null;
  const active = l.is_active ?? false;
  const severity = l.severity ?? 'normal';
  const model = sanitizeApiText(l.scope?.model?.display_name);

  switch (l.kind) {
    case 'session':
      return limit('セッション(5h)', '5h', utilization, resetsAt, true, active, severity);
    case 'weekly_all':
      return limit('週(全体)', '7d', utilization, resetsAt, true, active, severity);
    case 'weekly_scoped':
      if (model) {
        return limit(`週(${model})`, `${model} 7d`, utilization, resetsAt, false, active, severity);
      }
      return limit('週(スコープ)', 'wk', utilization, resetsAt, false, active, severity);
    default: {
      // 未知の種類も表示だけはできるよう拾う(フェイルソフト)。
      const name = model ?? sanitizeApiText(l.kind) ?? '不明';
      return limit(name, name, utilization, resetsAt, false, active, severity);
    }
  }
}

/**
 * API 由来の表示用文字列から制御文字・改行を除き、表示崩れしない長さへ丸める。
 * この文字列は shortLabel 経由でステータスバー本文(StatusBarItem.text)にも
 * 入り、そこでも `$(icon)` が解釈されるため、`$(` はここで分断する。
 * Markdown 記法のエスケープは表示側(statusBar)で行う。
 */
function sanitizeApiText(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const cleaned = value
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\$\(/g, '$ (');
  // サロゲートペアを分断しないようコードポイント単位で丸める。
  const truncated = [...cleaned.trim()].slice(0, 64).join('').trim();
  return truncated.length > 0 ? truncated : undefined;
}

function legacyLimits(raw: RawUsageResponse): UsageLimit[] {
  const out: UsageLimit[] = [];
  if (raw.five_hour) {
    out.push(
      limit('セッション(5h)', '5h', Math.round(raw.five_hour.utilization ?? 0), raw.five_hour.resets_at ?? null, true, true, 'normal')
    );
  }
  if (raw.seven_day) {
    out.push(
      limit('週(全体)', '7d', Math.round(raw.seven_day.utilization ?? 0), raw.seven_day.resets_at ?? null, true, true, 'normal')
    );
  }
  return out;
}

function limit(
  label: string,
  shortLabel: string,
  utilization: number,
  resetsAt: string | null,
  primary: boolean,
  active: boolean,
  severity: string
): UsageLimit {
  return { label, shortLabel, utilization, resetsAt, primary, active, severity };
}

/**
 * Retry-After ヘッダ(秒数 or HTTP-date)をミリ秒へ変換する。
 * 解釈できなければ undefined を返し、呼び出し側の既定バックオフに委ねる。
 */
function parseRetryAfter(
  value: string | string[] | undefined
): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const diff = dateMs - Date.now();
    return diff > 0 ? diff : 0;
  }
  return undefined;
}
