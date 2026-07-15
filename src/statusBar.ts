import * as vscode from 'vscode';
import {
  AuthFailureReason,
  NetworkError,
  NotAuthenticatedError,
  ProviderId,
  ProviderNotReadyError,
  ProviderUsage,
  RateLimitError,
  UsageLimit,
  UsageProvider,
} from './providers/types';

/** パーセントの表示種別。remaining は「あと何%使えるか」、used は「何%使ったか」。 */
type DisplayMode = 'remaining' | 'used';

/** 残量に応じた警告レベル。ステータスバーの背景色とアイコンに使う。 */
type AlertLevel = 'normal' | 'warning' | 'critical';

/** 警告レベルの境界(残量%)。remaining がこの値を下回ると各レベルになる。 */
interface AlertThresholds {
  warning: number;
  critical: number;
}

/**
 * 表示側が扱う状態。取得できない理由ごとに分け、案内文を切り分ける。
 * 認証系(unauthenticated)は利用者の操作が必要で、直近値を出すと
 * 「取れている」と誤解させるため、値は持たせない。
 */
type ProviderStatus =
  | { kind: 'loading' }
  | { kind: 'ok'; usage: ProviderUsage; fetchedAt: number }
  | { kind: 'unauthenticated'; reason: AuthFailureReason; message: string; hint?: string }
  | { kind: 'notReady'; message: string }
  | { kind: 'rateLimited'; retryAt: number; last?: ProviderUsage; lastFetchedAt?: number }
  | { kind: 'offline'; message: string; last?: ProviderUsage; lastFetchedAt?: number }
  | { kind: 'error'; message: string; last?: ProviderUsage; lastFetchedAt?: number };

/** 認証系エラーの見せ方。バー本文・ホバー見出し・アイコンを1か所で決める。 */
interface AuthPresentation {
  /** バー本文の文言(例: "要再ログイン")。 */
  label: string;
  /** バー本文とホバー見出しに付けるアイコン。未ログインは無印にする。 */
  icon: string;
}

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
 * 設定保存失敗時の案内。拡張機能を VSIX で更新した直後は、新しい設定定義が
 * 未登録のまま「登録済みの構成ではない」と拒否されることがあり、
 * ウィンドウの再読み込みで解消する。
 */
const SAVE_FAILURE_HINT =
  '(拡張機能を更新した直後の場合、ウィンドウの再読み込みで解消することがあります。表示自体は切替済みです)';

/**
 * 複数プロバイダの残量を1つのステータスバー項目に統合表示する。
 * 各プロバイダの状態は独立して保持し、片方の失敗が他方の表示を壊さない。
 */
export class StatusBarManager {
  /**
   * プロバイダごとに独立した項目を持つ。1項目のテキスト色は全体一色しか
   * 指定できないため、逼迫したプロバイダだけ色を変えられるよう分割する。
   */
  private readonly items = new Map<ProviderId, vscode.StatusBarItem>();
  private readonly states = new Map<ProviderId, ProviderStatus>();
  private readonly monitoringEnabled = new Map<ProviderId, boolean>();
  private readonly backoff = new Map<ProviderId, { until: number; failures: number }>();
  private readonly lastManualAttempt = new Map<ProviderId, number>();
  private pollTimer: NodeJS.Timeout | undefined;
  /**
   * 表示モードのメモリ上の現在値。undefined なら設定値に従う。
   * トグルは設定保存の成否に依存させず、まずこの値で即時切替する。
   */
  private displayMode: DisplayMode | undefined;
  /** 警告色のメモリ上の現在値。displayMode と同じ即時切替方式。 */
  private alertColorsEnabled: boolean | undefined;

  constructor(private readonly providers: UsageProvider[]) {
    providers.forEach((p, index) => {
      // 定義順(Claude→Codex)で左から並ぶよう優先度を下げていく。
      // 優先度 100 ちょうどを使う他拡張(Live Server 等)より僅かに上に
      // 置き、かつ差を極小にして、2項目の間に割り込まれないようにする。
      const item = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100 + (providers.length - index) * 1e-9
      );
      item.command = 'claudeCodexStatus.refresh';
      this.items.set(p.id, item);
      this.states.set(p.id, { kind: 'loading' });
      this.monitoringEnabled.set(p.id, true);
    });
  }

  start(): void {
    this.render();
    this.restartPolling();
  }

  dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    for (const item of this.items.values()) {
      item.dispose();
    }
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
      cfg.get<number>('pollIntervalSeconds', 300)
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

  /** 表示設定(style 等)だけが変わったとき、再取得せずに描画し直す。 */
  rerender(): void {
    this.render();
  }

  /**
   * 残量⇔使用率の表示を切り替える。まずメモリ上で切り替えて即時描画し、
   * 設定への保存は後追いで行う(保存に失敗しても表示の切替は生かす)。
   */
  async toggleDisplayMode(): Promise<void> {
    const next: DisplayMode =
      this.currentDisplayMode() === 'remaining' ? 'used' : 'remaining';
    this.displayMode = next;
    this.render();
    vscode.window.setStatusBarMessage(
      `表示を「${next === 'remaining' ? '残量' : '使用率'}」に切り替えました`,
      3000
    );
    try {
      await vscode.workspace
        .getConfiguration('claudeCodexStatus')
        .update('displayMode', next, vscode.ConfigurationTarget.Global);
    } catch (err) {
      // 保存できなくても今セッションの表示は切替済み。原因だけ通知する。
      void vscode.window.showWarningMessage(
        `表示モードを設定(displayMode)へ保存できませんでした: ${errorMessage(err)}` +
          SAVE_FAILURE_HINT
      );
    }
  }

  /** displayMode の設定変更イベントから呼ぶ。設定値を正としてメモリ側を破棄する。 */
  syncDisplayModeFromConfig(): void {
    this.displayMode = undefined;
    this.render();
  }

  /**
   * ステータスバーの警告色(黄/赤)を有効/無効に切り替える。
   * displayMode と同様、まずメモリ上で切り替えて設定保存は後追いにする。
   */
  async toggleAlertColors(): Promise<void> {
    const next = !this.currentAlertColorsEnabled();
    this.alertColorsEnabled = next;
    this.render();
    vscode.window.setStatusBarMessage(
      `ステータスバーの警告色を${next ? '有効' : '無効'}にしました`,
      3000
    );
    try {
      await vscode.workspace
        .getConfiguration('claudeCodexStatus')
        .update('statusBarAlertColors', next, vscode.ConfigurationTarget.Global);
    } catch (err) {
      void vscode.window.showWarningMessage(
        `警告色の設定(statusBarAlertColors)へ保存できませんでした: ${errorMessage(err)}` +
          SAVE_FAILURE_HINT
      );
    }
  }

  /** statusBarAlertColors の設定変更イベントから呼ぶ。設定値を正として同期する。 */
  syncAlertColorsFromConfig(): void {
    this.alertColorsEnabled = undefined;
    this.render();
  }

  private currentAlertColorsEnabled(): boolean {
    if (this.alertColorsEnabled !== undefined) {
      return this.alertColorsEnabled;
    }
    return vscode.workspace
      .getConfiguration('claudeCodexStatus')
      .get<boolean>('statusBarAlertColors', true);
  }

  private currentDisplayMode(): DisplayMode {
    if (this.displayMode) {
      return this.displayMode;
    }
    const value = vscode.workspace
      .getConfiguration('claudeCodexStatus')
      .get<string>('displayMode', 'remaining');
    return value === 'used' ? 'used' : 'remaining';
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
          reason: err.reason,
          message: err.message,
          hint: err.hint,
        });
      } else if (err instanceof ProviderNotReadyError) {
        this.states.set(provider.id, { kind: 'notReady', message: err.message });
      } else if (err instanceof NetworkError) {
        // 到達不能は一時的なことが多い。直近値を残して復帰時に自然に戻す。
        this.states.set(provider.id, {
          kind: 'offline',
          message: err.message,
          last,
          lastFetchedAt,
        });
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
    const cfg = vscode.workspace.getConfiguration('claudeCodexStatus');
    const verbose = cfg.get<string>('style', 'minimal') === 'verbose';
    const mode = this.currentDisplayMode();
    const thresholds = getAlertThresholds(cfg);
    // どの項目にホバーしても全プロバイダの詳細を確認できるよう共通にする。
    const tooltip =
      enabled.length > 0
        ? this.renderTooltip(enabled, mode, thresholds)
        : undefined;

    for (const p of this.providers) {
      const item = this.items.get(p.id);
      if (!item) {
        continue;
      }
      if (!enabled.includes(p)) {
        item.hide();
        continue;
      }
      item.text = this.renderSegment(p, verbose, mode, thresholds);
      item.tooltip = tooltip;
      item.color = this.currentAlertColorsEnabled()
        ? alertColor(this.worstLevelFor(p.id, thresholds))
        : undefined;
      item.show();
    }
  }

  /** プロバイダ内の全枠(直近値含む)から最も重い警告レベルを返す。 */
  private worstLevelFor(
    id: ProviderId,
    thresholds: AlertThresholds
  ): AlertLevel {
    const state = this.states.get(id);
    const usage = state?.kind === 'ok' ? state.usage : lastGood(state).usage;
    let worst: AlertLevel = 'normal';
    for (const l of usage?.limits ?? []) {
      const level = limitLevel(l, thresholds);
      if (level === 'critical') {
        return 'critical';
      }
      if (level === 'warning') {
        worst = 'warning';
      }
    }
    return worst;
  }

  private renderSegment(
    provider: UsageProvider,
    verbose: boolean,
    mode: DisplayMode,
    thresholds: AlertThresholds
  ): string {
    const state = this.states.get(provider.id) ?? { kind: 'loading' };
    const head = `${provider.icon} ${provider.label}`;
    switch (state.kind) {
      case 'loading':
        return `${head} …`;
      case 'unauthenticated': {
        const auth = authPresentation(state.reason);
        return `${head}: ${auth.label}${auth.icon ? ` ${auth.icon}` : ''}`;
      }
      case 'notReady':
        return `${head}: 準備中`;
      case 'ok':
        return `${head} ${formatUsage(state.usage, verbose, mode, thresholds)}`;
      case 'rateLimited':
        return state.last
          ? `${head} ${formatUsage(state.last, verbose, mode, thresholds)} $(clock)`
          : `${head}: 待機中 $(clock)`;
      case 'offline':
        return state.last
          ? `${head} ${formatUsage(state.last, verbose, mode, thresholds)} $(cloud-offline)`
          : `${head}: 接続不可 $(cloud-offline)`;
      case 'error':
        return state.last
          ? `${head} ${formatUsage(state.last, verbose, mode, thresholds)} $(alert)`
          : `${head}: 取得失敗 $(alert)`;
    }
  }

  private renderTooltip(
    enabled: UsageProvider[],
    mode: DisplayMode,
    thresholds: AlertThresholds
  ): vscode.MarkdownString {
    const tooltip = new vscode.MarkdownString();
    // 全コマンドを許可(true)せず、自前のコマンドだけに絞る(コマンドリンク注入対策)。
    tooltip.isTrusted = {
      enabledCommands: [
        'claudeCodexStatus.refresh',
        'claudeCodexStatus.refreshClaude',
        'claudeCodexStatus.refreshCodex',
        'claudeCodexStatus.toggleClaudeMonitoring',
        'claudeCodexStatus.toggleCodexMonitoring',
        'claudeCodexStatus.toggleDisplayMode',
        'claudeCodexStatus.toggleAlertColors',
      ],
    };
    tooltip.supportThemeIcons = true;
    // 逼迫枠の文字色付け(<span style="color:...">)に必要。サニタイザにより
    // 許可されるのは span の color/background-color 等ごく一部のみで、
    // API 由来文字列は escapeMarkdown で `<` を潰しているため注入はできない。
    tooltip.supportHtml = true;

    enabled.forEach((provider, index) => {
      if (index > 0) {
        tooltip.appendMarkdown('\n\n---\n\n');
      }
      this.appendProviderSection(tooltip, provider, mode, thresholds);
    });

    const nextModeLabel = mode === 'remaining' ? '使用率' : '残量';
    const colorsEnabled = this.currentAlertColorsEnabled();
    tooltip.appendMarkdown(
      '\n\n$(refresh) クリックで今すぐ更新　' +
        `$(arrow-swap) [${nextModeLabel}表示に切替](command:claudeCodexStatus.toggleDisplayMode "パーセントの表示を残量⇔使用率で切り替え")　` +
        `$(paintcan) [警告色を${colorsEnabled ? '無効化' : '有効化'}](command:claudeCodexStatus.toggleAlertColors "残量逼迫時のステータスバー文字色(黄/赤)の有効/無効")`
    );
    return tooltip;
  }

  private appendProviderSection(
    tooltip: vscode.MarkdownString,
    provider: UsageProvider,
    mode: DisplayMode,
    thresholds: AlertThresholds
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
      case 'unauthenticated': {
        const auth = authPresentation(state.reason);
        tooltip.appendMarkdown(`\n\n${auth.icon || '$(account)'} ${auth.label}: `);
        tooltip.appendText(state.message);
        if (state.hint) {
          // 案内文は原因ごとに異なるため、プロバイダから受け取ったものをそのまま出す。
          tooltip.appendMarkdown('\n\n$(lightbulb) ');
          tooltip.appendText(state.hint);
        }
        break;
      }
      case 'notReady':
        tooltip.appendMarkdown('\n\n$(tools) 準備中: ');
        tooltip.appendText(state.message);
        break;
      case 'ok':
        tooltip.appendMarkdown(`\n\n${limitsTable(state.usage, mode, thresholds)}`);
        tooltip.appendMarkdown(`\n$(history) 最終取得 ${formatTime(state.fetchedAt)}`);
        break;
      case 'rateLimited': {
        const secs = Math.max(0, Math.ceil((state.retryAt - Date.now()) / 1000));
        tooltip.appendMarkdown(
          `\n\n$(clock) レート制限(429)中 — 約${secs}秒後に自動再取得` +
            '(「更新」で今すぐ再試行)'
        );
        appendLastKnown(tooltip, state.last, state.lastFetchedAt, mode, thresholds);
        break;
      }
      case 'offline':
        tooltip.appendMarkdown('\n\n$(cloud-offline) 接続不可: ');
        tooltip.appendText(state.message);
        tooltip.appendMarkdown(
          '\n\n$(lightbulb) ネットワーク接続やプロキシ設定を確認してください。' +
            '復帰すれば次回の取得で自動的に戻ります。'
        );
        appendLastKnown(tooltip, state.last, state.lastFetchedAt, mode, thresholds);
        break;
      case 'error':
        tooltip.appendMarkdown('\n\n$(alert) 取得エラー: ');
        tooltip.appendText(state.message);
        appendLastKnown(tooltip, state.last, state.lastFetchedAt, mode, thresholds);
        break;
    }
  }

  private isMonitoringEnabled(id: ProviderId): boolean {
    return this.monitoringEnabled.get(id) ?? true;
  }
}

/**
 * 認証系エラーの文言とアイコン。
 * 「未ログイン」(まだ始めていない)と「要再ログイン」(切れた)は対処が違うため分ける。
 * 「認証情報エラー」はファイル自体の異常で、ログインし直しでは直らないこともある。
 */
function authPresentation(reason: AuthFailureReason): AuthPresentation {
  switch (reason) {
    case 'tokenRejected':
      return { label: '要再ログイン', icon: '$(key)' };
    case 'credentialsInvalid':
    case 'credentialsUnreadable':
      return { label: '認証情報エラー', icon: '$(alert)' };
    case 'credentialsMissing':
    case 'tokenMissing':
      return { label: '未ログイン', icon: '' };
  }
}

/** 失敗状態で直近の正常値と取得時刻を添える。値が無ければ何も出さない。 */
function appendLastKnown(
  tooltip: vscode.MarkdownString,
  last: ProviderUsage | undefined,
  lastFetchedAt: number | undefined,
  mode: DisplayMode,
  thresholds: AlertThresholds
): void {
  if (!last) {
    return;
  }
  tooltip.appendMarkdown(`\n\n${limitsTable(last, mode, thresholds)}`);
  if (lastFetchedAt) {
    tooltip.appendMarkdown(`\n$(history) 最終正常取得 ${formatTime(lastFetchedAt)}`);
  }
}

function formatUsage(
  usage: ProviderUsage,
  verbose: boolean,
  mode: DisplayMode,
  thresholds: AlertThresholds
): string {
  // モデル別(Fable 等)も含め全枠を表示。": " の前後に半角スペースを入れる。
  // ステータスバー本文は部分的な色付けができないため、逼迫はアイコンで示す。
  const parts = usage.limits.map((l) => {
    const base = `${l.shortLabel} : ${formatPercent(l, mode)}${alertIcon(limitLevel(l, thresholds))}`;
    return verbose && l.resetsAt ? `${base} (${formatResetIn(l.resetsAt)})` : base;
  });
  return parts.join('  ');
}

/** ツールチップ用の枠一覧を Markdown テーブルで返す。 */
function limitsTable(
  usage: ProviderUsage,
  mode: DisplayMode,
  thresholds: AlertThresholds
): string {
  if (usage.limits.length === 0) {
    return '(枠情報なし)';
  }
  const header = mode === 'remaining' ? '残量' : '使用';
  const rows = usage.limits.map(
    (l) =>
      `| ${escapeMarkdown(l.label)} | ${usageCell(l, mode, thresholds)} | ${resetCell(l)} |`
  );
  return [`| 枠 | ${header} | リセット |`, '| :-- | :-- | :-- |', ...rows].join('\n');
}

/**
 * API 由来の文字列(モデル名など)を Markdown へ埋め込む前のエスケープ。
 * テーブルのセル崩れ(`|`)、リンク・強調などの記法、`$(...)` テーマアイコンの
 * 注入を防ぐ。
 *
 * `\(` は Markdown パース時に `(` へ戻り、その後にアイコン置換が走るため、
 * `(` のエスケープだけでは `$(icon)` を無効化できない。パース後のテキストが
 * `\$(icon)`(アイコン置換のリテラル扱い)になるよう、`$` の前に `\\` を足す。
 */
function escapeMarkdown(text: string): string {
  return text
    .replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&')
    .replace(/\$(?=\\\()/g, '\\\\$');
}

/** 「▰▰▰▰▱▱▱▱▱▱ 残量 62%」形式のメーター付きセル。未開始の枠は「-」。 */
function usageCell(
  l: UsageLimit,
  mode: DisplayMode,
  thresholds: AlertThresholds
): string {
  const pct = formatPercent(l, mode);
  if (pct === '-%') {
    return '-';
  }
  // メーターは表示モードによらず「残量を塗り、使用分を中抜き」で統一する。
  const remaining = 100 - l.utilization;
  const kind = mode === 'remaining' ? '残量' : '使用';
  const level = limitLevel(l, thresholds);
  return colorize(`${meter(remaining)} ${kind} ${pct}${alertIcon(level)}`, level);
}

/**
 * 警告レベルに応じて文字色を付ける。VS Code のサニタイザは
 * `color:var(--vscode-…);` 形式(セミコロン必須・空白不可)のみ許可する。
 */
function colorize(text: string, level: AlertLevel): string {
  if (level === 'normal') {
    return text;
  }
  const color =
    level === 'critical'
      ? 'var(--vscode-charts-red)'
      : 'var(--vscode-charts-yellow)';
  return `<span style="color:${color};">${text}</span>`;
}

/** 残量率(0-100)を10段の「▰(残)▱(使用済)」バーにする。 */
function meter(remainingPercent: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(remainingPercent / 10)));
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

/**
 * ステータスバー項目のテキスト色。テーマのチャート色を使い、
 * ホバー内の文字色(charts-yellow / charts-red)と揃える。
 */
function alertColor(level: AlertLevel): vscode.ThemeColor | undefined {
  if (level === 'critical') {
    return new vscode.ThemeColor('charts.red');
  }
  if (level === 'warning') {
    return new vscode.ThemeColor('charts.yellow');
  }
  return undefined;
}

function alertIcon(level: AlertLevel): string {
  if (level === 'critical') {
    return ' $(error)';
  }
  if (level === 'warning') {
    return ' $(warning)';
  }
  return '';
}

/**
 * 設定からしきい値(残量%)を読む。数値でなければ既定値(警告30/危険10)、
 * warning < critical の逆転指定は critical に揃えて破綻を防ぐ。
 */
function getAlertThresholds(cfg: vscode.WorkspaceConfiguration): AlertThresholds {
  const read = (key: string, fallback: number): number => {
    const value = cfg.get<number>(key, fallback);
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.max(0, Math.min(100, value))
      : fallback;
  };
  const critical = read('criticalRemainingPercent', 10);
  const warning = Math.max(read('warningRemainingPercent', 30), critical);
  return { warning, critical };
}

/** 枠単体の警告レベル。未開始の枠(リセット未設定かつ未消費)は対象外。 */
function limitLevel(l: UsageLimit, thresholds: AlertThresholds): AlertLevel {
  if (l.resetsAt === null && !l.active) {
    return 'normal';
  }
  const remaining = 100 - l.utilization;
  if (remaining < thresholds.critical) {
    return 'critical';
  }
  if (remaining < thresholds.warning) {
    return 'warning';
  }
  return 'normal';
}

function resetCell(l: UsageLimit): string {
  if (l.resetsAt === null) {
    return '-';
  }
  return `${formatResetIn(l.resetsAt)} (${formatResetClock(l.resetsAt)})`;
}

/**
 * 表示モードに応じたパーセント文字列を返す。
 * リセット時刻が未設定かつ未消費の枠(未開始)は「-%」。
 */
function formatPercent(l: UsageLimit, mode: DisplayMode): string {
  if (l.resetsAt === null && !l.active) {
    return '-%';
  }
  const value = mode === 'remaining' ? 100 - l.utilization : l.utilization;
  return `${value}%`;
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
  if (prev.kind === 'error' || prev.kind === 'rateLimited' || prev.kind === 'offline') {
    return { usage: prev.last, at: prev.lastFetchedAt };
  }
  return {};
}
