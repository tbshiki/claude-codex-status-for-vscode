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
 * 手動更新の最小間隔。手動はバックオフを無視して再取得できるため、
 * 連打してもこの間隔以下ではリクエストを送らないことで負荷を抑える。
 */
const MANUAL_MIN_INTERVAL_MS = 15_000;

/**
 * 複数プロバイダの残量を1つのステータスバー項目に統合表示する。
 * 各プロバイダの状態は独立して保持し、片方の失敗が他方の表示を壊さない。
 */
export class StatusBarManager {
  private readonly item: vscode.StatusBarItem;
  private readonly states = new Map<ProviderId, ProviderStatus>();
  private readonly monitoringEnabled = new Map<ProviderId, boolean>();
  private readonly backoff = new Map<ProviderId, { until: number; failures: number }>();
  private readonly lastManualAttempt = new Map<ProviderId, number>();
  private pollTimer: NodeJS.Timeout | undefined;

  constructor(private readonly providers: UsageProvider[]) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.item.command = 'claudeCodexStatus.refresh';
    for (const p of providers) {
      this.states.set(p.id, { kind: 'loading' });
      this.monitoringEnabled.set(p.id, true);
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
      this.pollTimer = undefined;
    }
    if (!this.providers.some((p) => this.isMonitoringEnabled(p.id))) {
      return;
    }
    const cfg = vscode.workspace.getConfiguration('claudeCodexStatus');
    const intervalSec = Math.max(
      MIN_INTERVAL_SEC,
      cfg.get<number>('pollIntervalSeconds', 60)
    );
    void this.refreshAll();
    this.pollTimer = setInterval(() => void this.refreshAll(), intervalSec * 1000);
  }

  /** 指定プロバイダの自動監視だけを停止・再開する。 */
  toggleProviderMonitoring(id: ProviderId): void {
    this.monitoringEnabled.set(id, !this.isMonitoringEnabled(id));
    this.restartPolling();
    this.render();
  }

  /**
   * id を省略すると有効な全プロバイダを更新する。
   * manual(コマンド・クリック起点)の場合はバックオフや監視停止を無視して
   * 再取得を試みるが、MANUAL_MIN_INTERVAL_MS より短い間隔では送信しない。
   */
  async refresh(id?: ProviderId, opts?: { manual?: boolean }): Promise<void> {
    const manual = opts?.manual ?? false;
    const targets = this.enabledProviders().filter(
      (p) => (!id && (manual || this.isMonitoringEnabled(p.id))) || (id && p.id === id)
    );
    await Promise.all(targets.map((p) => this.refreshOne(p, manual)));
    this.render();
  }

  private async refreshAll(): Promise<void> {
    await this.refresh();
  }

  private async refreshOne(provider: UsageProvider, manual = false): Promise<void> {
    const prev = this.states.get(provider.id);
    const { usage: last, at: lastFetchedAt } = lastGood(prev);
    const now = Date.now();

    // バックオフ中は API を叩かず、待機状態のまま据え置く(Claude 側の負荷を避ける)。
    // 手動更新だけは待機が長い場合の救済としてバックオフを突破できる。
    const b = this.backoff.get(provider.id);
    if (!manual && b && now < b.until) {
      this.states.set(provider.id, {
        kind: 'rateLimited',
        retryAt: b.until,
        last,
        lastFetchedAt,
      });
      return;
    }

    if (manual) {
      const lastAttempt = this.lastManualAttempt.get(provider.id);
      if (lastAttempt !== undefined && now - lastAttempt < MANUAL_MIN_INTERVAL_MS) {
        const waitSec = Math.ceil(
          (MANUAL_MIN_INTERVAL_MS - (now - lastAttempt)) / 1000
        );
        vscode.window.setStatusBarMessage(
          `${provider.label}: 直前に更新済みです。約${waitSec}秒後に再試行できます`,
          3000
        );
        return;
      }
      this.lastManualAttempt.set(provider.id, now);
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
    const tooltip = new vscode.MarkdownString();
    tooltip.isTrusted = true;
    tooltip.supportThemeIcons = true;

    enabled.forEach((provider, index) => {
      if (index > 0) {
        tooltip.appendMarkdown('\n\n---\n\n');
      }
      this.appendProviderSection(tooltip, provider);
    });

    tooltip.appendMarkdown('\n\n$(refresh) クリックで今すぐ更新');
    return tooltip;
  }

  private appendProviderSection(
    tooltip: vscode.MarkdownString,
    provider: UsageProvider
  ): void {
    const state = this.states.get(provider.id) ?? { kind: 'loading' as const };
    const monitoring = this.isMonitoringEnabled(provider.id);
    const refreshCommand = provider.id === 'claude'
      ? 'claudeCodexStatus.refreshClaude'
      : 'claudeCodexStatus.refreshCodex';
    const toggleCommand = provider.id === 'claude'
      ? 'claudeCodexStatus.toggleClaudeMonitoring'
      : 'claudeCodexStatus.toggleCodexMonitoring';

    tooltip.appendMarkdown(`**${provider.icon} ${provider.label}**`);
    if (!monitoring) {
      tooltip.appendMarkdown(' *(監視停止中)*');
    }
    tooltip.appendMarkdown(
      `　[更新](command:${refreshCommand} "今すぐ再取得")` +
        `　[監視を${monitoring ? '停止' : '再開'}](command:${toggleCommand})`
    );

    switch (state.kind) {
      case 'loading':
        tooltip.appendMarkdown('\n\n$(sync~spin) 取得中…');
        break;
      case 'unauthenticated':
        tooltip.appendMarkdown('\n\n$(account) 未ログイン: ');
        tooltip.appendText(state.message);
        break;
      case 'notReady':
        tooltip.appendMarkdown('\n\n$(tools) 準備中: ');
        tooltip.appendText(state.message);
        break;
      case 'ok':
        tooltip.appendMarkdown(`\n\n${limitsTable(state.usage)}`);
        tooltip.appendMarkdown(`\n$(history) 最終取得 ${formatTime(state.fetchedAt)}`);
        break;
      case 'rateLimited': {
        const secs = Math.max(0, Math.ceil((state.retryAt - Date.now()) / 1000));
        tooltip.appendMarkdown(
          `\n\n$(clock) レート制限(429)中 — 約${secs}秒後に自動再取得` +
            '(「更新」で今すぐ再試行)'
        );
        if (state.last) {
          tooltip.appendMarkdown(`\n\n${limitsTable(state.last)}`);
          if (state.lastFetchedAt) {
            tooltip.appendMarkdown(
              `\n$(history) 最終正常取得 ${formatTime(state.lastFetchedAt)}`
            );
          }
        }
        break;
      }
      case 'error':
        tooltip.appendMarkdown('\n\n$(alert) 取得エラー: ');
        tooltip.appendText(state.message);
        if (state.last) {
          tooltip.appendMarkdown(`\n\n${limitsTable(state.last)}`);
          if (state.lastFetchedAt) {
            tooltip.appendMarkdown(
              `\n$(history) 最終正常取得 ${formatTime(state.lastFetchedAt)}`
            );
          }
        }
        break;
    }
  }

  private isMonitoringEnabled(id: ProviderId): boolean {
    return this.monitoringEnabled.get(id) ?? true;
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

/** ツールチップ用の枠一覧を Markdown テーブルで返す。 */
function limitsTable(usage: ProviderUsage): string {
  if (usage.limits.length === 0) {
    return '(枠情報なし)';
  }
  const rows = usage.limits.map(
    (l) => `| ${l.label} | ${usageCell(l)} | ${resetCell(l)} |`
  );
  return ['| 枠 | 使用状況 | リセット |', '| :-- | :-- | :-- |', ...rows].join('\n');
}

/** 「▰▰▰▰▱▱▱▱▱▱ 残量 62%」形式のメーター付きセル。未開始の枠は「-」。 */
function usageCell(l: UsageLimit): string {
  const pct = formatPercent(l);
  if (pct === '-%') {
    return '-';
  }
  // メーターは常に「残量を塗り、使用分を中抜き」で統一する。
  // Codex は utilization が残量率(100-使用)、Claude は使用率なので変換する。
  const remaining =
    l.percentageKind === 'remaining' ? l.utilization : 100 - l.utilization;
  const kind = l.percentageKind === 'remaining' ? '残量' : '使用';
  return `${meter(remaining)} ${kind} ${pct}${severityIcon(l.severity)}`;
}

/** 残量率(0-100)を10段の「▰(残)▱(使用済)」バーにする。 */
function meter(remainingPercent: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(remainingPercent / 10)));
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

function severityIcon(severity: string): string {
  if (severity === 'critical' || severity === 'error') {
    return ' $(error)';
  }
  if (severity === 'warning') {
    return ' $(warning)';
  }
  return '';
}

function resetCell(l: UsageLimit): string {
  if (l.resetsAt === null) {
    return '-';
  }
  return `${formatResetIn(l.resetsAt)} (${formatResetClock(l.resetsAt)})`;
}

/** リセット時刻が未設定(枠未開始)なら「-%」、それ以外は利用率を返す。 */
function formatPercent(l: UsageLimit): string {
  return l.percentageKind === 'remaining' || l.resetsAt !== null
    ? `${l.utilization}%`
    : '-%';
}

/**
 * リセット時刻を利用者のローカル時間軸で表す。
 * 当日なら「19時02分」、別日なら「M/D 19時02分」。
 */
function formatResetClock(resetsAt: string): string {
  const d = new Date(resetsAt);
  if (Number.isNaN(d.getTime())) {
    return '-';
  }
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = `${d.getHours()}時${d.getMinutes().toString().padStart(2, '0')}分`;
  return sameDay ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
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
