import * as vscode from 'vscode';
import {
  NotAuthenticatedError,
  ProviderId,
  ProviderNotReadyError,
  ProviderUsage,
  RateLimitError,
  UsageLimit,
  UsageProvider,
} from './providers/types';

type ProviderStatus =
  | { kind: 'loading' }
  | { kind: 'ok'; usage: ProviderUsage; fetchedAt: number }
  | { kind: 'unauthenticated'; message: string }
  | { kind: 'notReady'; message: string }
  | { kind: 'rateLimited'; retryAt: number; last?: ProviderUsage; lastFetchedAt?: number }
  | { kind: 'error'; message: string; last?: ProviderUsage; lastFetchedAt?: number };

const MIN_INTERVAL_SEC = 60;
/** 429 バックオフの基準(初回)と上限。Retry-After があればそちらを優先。 */
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 15 * 60_000;

/**
 * 複数プロバイダの残量を1つのステータスバー項目に統合表示する。
 * 各プロバイダの状態は独立して保持し、片方の失敗が他方の表示を壊さない。
 */
export class StatusBarManager {
  private readonly item: vscode.StatusBarItem;
  private readonly states = new Map<ProviderId, ProviderStatus>();
  private readonly backoff = new Map<ProviderId, { until: number; failures: number }>();
  private pollTimer: NodeJS.Timeout | undefined;

  constructor(private readonly providers: UsageProvider[]) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.item.command = 'claudeCodexStatus.refresh';
    for (const p of providers) {
      this.states.set(p.id, { kind: 'loading' });
    }
  }

  start(): void {
    this.item.show();
    this.restartPolling();
  }

  dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.item.dispose();
  }

  /** 設定変更時に呼ぶ。間隔と有効プロバイダを反映して再始動する。 */
  restartPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    const cfg = vscode.workspace.getConfiguration('claudeCodexStatus');
    const intervalSec = Math.max(
      MIN_INTERVAL_SEC,
      cfg.get<number>('pollIntervalSeconds', 60)
    );
    void this.refreshAll();
    this.pollTimer = setInterval(() => void this.refreshAll(), intervalSec * 1000);
  }

  /** id を省略すると有効な全プロバイダを更新する。 */
  async refresh(id?: ProviderId): Promise<void> {
    const targets = this.enabledProviders().filter((p) => !id || p.id === id);
    await Promise.all(targets.map((p) => this.refreshOne(p)));
    this.render();
  }

  private async refreshAll(): Promise<void> {
    await this.refresh();
  }

  private async refreshOne(provider: UsageProvider): Promise<void> {
    const prev = this.states.get(provider.id);
    const { usage: last, at: lastFetchedAt } = lastGood(prev);

    // バックオフ中は API を叩かず、待機状態のまま据え置く(Claude 側の負荷を避ける)。
    const b = this.backoff.get(provider.id);
    if (b && Date.now() < b.until) {
      this.states.set(provider.id, {
        kind: 'rateLimited',
        retryAt: b.until,
        last,
        lastFetchedAt,
      });
      return;
    }

    try {
      const usage = await provider.fetchUsage();
      this.backoff.delete(provider.id);
      this.states.set(provider.id, { kind: 'ok', usage, fetchedAt: Date.now() });
    } catch (err) {
      if (err instanceof RateLimitError) {
        const failures = (b?.failures ?? 0) + 1;
        const delay =
          err.retryAfterMs ??
          Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
        const until = Date.now() + delay;
        this.backoff.set(provider.id, { until, failures });
        this.states.set(provider.id, {
          kind: 'rateLimited',
          retryAt: until,
          last,
          lastFetchedAt,
        });
      } else if (err instanceof NotAuthenticatedError) {
        this.backoff.delete(provider.id);
        this.states.set(provider.id, {
          kind: 'unauthenticated',
          message: err.message,
        });
      } else if (err instanceof ProviderNotReadyError) {
        this.states.set(provider.id, { kind: 'notReady', message: err.message });
      } else {
        this.states.set(provider.id, {
          kind: 'error',
          message: errorMessage(err),
          last,
          lastFetchedAt,
        });
      }
    }
  }

  private enabledProviders(): UsageProvider[] {
    const cfg = vscode.workspace.getConfiguration('claudeCodexStatus');
    return this.providers.filter((p) =>
      cfg.get<boolean>(`providers.${p.id}`, true)
    );
  }

  private render(): void {
    const enabled = this.enabledProviders();
    if (enabled.length === 0) {
      this.item.hide();
      return;
    }
    this.item.show();

    const verbose =
      vscode.workspace
        .getConfiguration('claudeCodexStatus')
        .get<string>('style', 'minimal') === 'verbose';

    this.item.text = enabled.map((p) => this.renderSegment(p, verbose)).join('  ');
    this.item.tooltip = this.renderTooltip(enabled);
  }

  private renderSegment(provider: UsageProvider, verbose: boolean): string {
    const state = this.states.get(provider.id) ?? { kind: 'loading' };
    const head = `${provider.icon} ${provider.label}`;
    switch (state.kind) {
      case 'loading':
        return `${head} …`;
      case 'unauthenticated':
        return `${head}: 未ログイン`;
      case 'notReady':
        return `${head}: 準備中`;
      case 'ok':
        return `${head} ${formatUsage(state.usage, verbose)}`;
      case 'rateLimited':
        return state.last
          ? `${head} ${formatUsage(state.last, verbose)} $(clock)`
          : `${head}: 待機中 $(clock)`;
      case 'error':
        return state.last
          ? `${head} ${formatUsage(state.last, verbose)} $(alert)`
          : `${head}: 取得失敗 $(alert)`;
    }
  }

  private renderTooltip(enabled: UsageProvider[]): vscode.MarkdownString {
    const lines: string[] = [];
    for (const provider of enabled) {
      const state = this.states.get(provider.id) ?? { kind: 'loading' };
      lines.push(`**${provider.label}**`);
      switch (state.kind) {
        case 'loading':
          lines.push('- 取得中…');
          break;
        case 'unauthenticated':
          lines.push(`- 未ログイン: ${state.message}`);
          break;
        case 'notReady':
          lines.push(`- 準備中: ${state.message}`);
          break;
        case 'ok':
          lines.push(...tooltipLimits(state.usage));
          lines.push(`- 最終取得: ${formatTime(state.fetchedAt)}`);
          break;
        case 'rateLimited': {
          const secs = Math.max(0, Math.ceil((state.retryAt - Date.now()) / 1000));
          lines.push(`- レート制限(429)中: 約${secs}秒後に再取得します`);
          if (state.last) {
            lines.push('- 直近の正常値:');
            lines.push(...tooltipLimits(state.last).map((l) => `  ${l}`));
            if (state.lastFetchedAt) {
              lines.push(`- 最終正常取得: ${formatTime(state.lastFetchedAt)}`);
            }
          }
          break;
        }
        case 'error':
          lines.push(`- 取得エラー: ${state.message}`);
          if (state.last) {
            lines.push('- 直近の正常値:');
            lines.push(...tooltipLimits(state.last).map((l) => `  ${l}`));
            if (state.lastFetchedAt) {
              lines.push(`- 最終正常取得: ${formatTime(state.lastFetchedAt)}`);
            }
          }
          break;
      }
      lines.push('');
    }
    lines.push('クリックで今すぐ更新');

    const md = new vscode.MarkdownString(lines.join('\n'));
    md.supportThemeIcons = true;
    return md;
  }
}

function formatUsage(usage: ProviderUsage, verbose: boolean): string {
  // モデル別(Fable 等)も含め全枠を表示。": " の前後に半角スペースを入れる。
  const parts = usage.limits.map((l) => {
    const base = `${l.shortLabel} : ${formatPercent(l)}`;
    return verbose && l.resetsAt ? `${base} (${formatResetIn(l.resetsAt)})` : base;
  });
  return parts.join('  ');
}

function tooltipLimits(usage: ProviderUsage): string[] {
  if (usage.limits.length === 0) {
    return ['- (枠情報なし)'];
  }
  return usage.limits.map(
    (l) => `- ${l.label} : ${formatPercent(l)} (リセット ${formatResetIn(l.resetsAt)})`
  );
}

/** リセット時刻が未設定(枠未開始)なら「-%」、それ以外は利用率を返す。 */
function formatPercent(l: UsageLimit): string {
  return l.resetsAt === null ? '-%' : `${l.utilization}%`;
}

function formatResetIn(resetsAt: string | null): string {
  if (!resetsAt) {
    return '-';
  }
  const target = new Date(resetsAt).getTime();
  if (Number.isNaN(target)) {
    return '-';
  }
  const diffMs = target - Date.now();
  if (diffMs <= 0) {
    return 'まもなく';
  }
  const totalMin = Math.floor(diffMs / 60000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return `${days}日${remHours}時間後`;
  }
  return `${hours}時間${mins}分後`;
}

function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString();
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/** 直近の正常値を、失敗やレート制限を挟んでも失わないよう取り出す。 */
function lastGood(prev?: ProviderStatus): { usage?: ProviderUsage; at?: number } {
  if (!prev) {
    return {};
  }
  if (prev.kind === 'ok') {
    return { usage: prev.usage, at: prev.fetchedAt };
  }
  if (prev.kind === 'error' || prev.kind === 'rateLimited') {
    return { usage: prev.last, at: prev.lastFetchedAt };
  }
  return {};
}
