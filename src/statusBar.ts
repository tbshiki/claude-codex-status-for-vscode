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

/**
 * ステータスバー本文の書式。minimal は「5h : 62%」、verbose はリセットまでの時間付き、
 * orca は Orca のステータスバーに合わせた「▰▰▱▱▱ 33% 2h 17m · 94% 27m」形式。
 */
type DisplayStyle = 'minimal' | 'verbose' | 'orca';

/** ステータスバーのどちら側へ置くか。項目の作成時にしか指定できない。 */
type BarAlignment = 'left' | 'right';

/** ステータスバー上の置き場所。どちらも項目の作成時にしか指定できない。 */
interface BarPlacement {
  alignment: BarAlignment;
  /** 並び順の優先度。左右どちら側でも、大きいほど左に置かれる。 */
  priority: number;
}

/** 右側の既定の優先度。優先度 100 を使う他拡張(Live Server 等)の隣に置く。 */
const DEFAULT_PRIORITY_RIGHT = 100;
/**
 * 左側の既定の優先度。「左に置く」は左端を期待されるため、Git のブランチ表示(10000)より
 * 大きくする。リモートの表示(左端の >< )は VSCode が常に先頭へ置くため、その右隣になる。
 */
const DEFAULT_PRIORITY_LEFT = 1_000_000;

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

/** 全プロバイダ停止時の最小表示。これ自体が再開用のホバー先になる。 */
const PAUSED_ICON = '$(debug-pause)';

const MIN_INTERVAL_SEC = 60;
/**
 * 取得間隔の上限(24時間)。setInterval は約24.8日(2^31-1 ms)を超える値や NaN を
 * 1ms として扱うため、上限と型の確認が無いと、設定値しだいで API を連打してしまう。
 */
const MAX_INTERVAL_SEC = 24 * 60 * 60;
const DEFAULT_INTERVAL_SEC = 300;
/** 429 バックオフの基準(初回)と上限。Retry-After があればそちらを優先。 */
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 15 * 60_000;
/**
 * Retry-After を使うときの下限と上限。0 や極端に短い値でそのまま再取得すると連打になり、
 * 極端に長い値ではいつまでも戻らないため、この範囲へ丸める。
 */
const RETRY_AFTER_MIN_MS = 30_000;
const RETRY_AFTER_MAX_MS = 60 * 60_000;
/** バックオフ明けの再取得を、明ける時刻より少しだけ後ろへずらす余裕。 */
const RETRY_MARGIN_MS = 500;
/**
 * 取得とは別に、表示だけを描き直す間隔。リセットまでの残り時間(verbose / orca の本文と
 * ホバー)は描画した時点の値なので、取得の間も古くならないよう1分ごとに描き直す。
 */
const RERENDER_INTERVAL_MS = 60_000;
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
  /**
   * 全プロバイダが監視停止のときだけ出す最小表示。
   * 停止した項目はバーから消えるため、これが無いと再開用のホバー先が
   * どこにも無くなり、設定を開くまで戻せなくなる。
   */
  private pausedItem: vscode.StatusBarItem;
  /** 項目を作ったときの置き場所。設定と食い違ったら項目を作り直す。 */
  private placement: BarPlacement;
  private readonly states = new Map<ProviderId, ProviderStatus>();
  private readonly monitoringEnabled = new Map<ProviderId, boolean>();
  private readonly backoff = new Map<ProviderId, { until: number; failures: number }>();
  private readonly lastManualAttempt = new Map<ProviderId, number>();
  /** バックオフが明ける時刻に再取得するためのタイマー(プロバイダごと)。 */
  private readonly retryTimers = new Map<ProviderId, NodeJS.Timeout>();
  /** 取得中の処理。同じプロバイダへ重ねて送らないよう、実行中のものに相乗りする。 */
  private readonly inFlight = new Map<ProviderId, Promise<void>>();
  private pollTimer: NodeJS.Timeout | undefined;
  private renderTimer: NodeJS.Timeout | undefined;
  /**
   * 表示モードのメモリ上の現在値。undefined なら設定値に従う。
   * トグルは設定保存の成否に依存させず、まずこの値で即時切替する。
   */
  private displayMode: DisplayMode | undefined;
  /** 警告色のメモリ上の現在値。displayMode と同じ即時切替方式。 */
  private alertColorsEnabled: boolean | undefined;

  constructor(private readonly providers: UsageProvider[]) {
    for (const p of providers) {
      this.states.set(p.id, { kind: 'loading' });
      this.monitoringEnabled.set(p.id, true);
    }
    this.placement = configuredPlacement();
    this.pausedItem = this.createItems();
  }

  /**
   * 現在の placement でプロバイダ項目を作って this.items へ入れ、全停止時の最小表示を返す。
   * 取得済みの値や監視の停止状態(states / monitoringEnabled)には触れないので、
   * 表示位置の変更で作り直しても表示内容は引き継がれる。
   */
  private createItems(): vscode.StatusBarItem {
    const side =
      this.placement.alignment === 'left'
        ? vscode.StatusBarAlignment.Left
        : vscode.StatusBarAlignment.Right;
    const count = this.providers.length;
    const base = this.placement.priority;
    // 項目どうしの優先度の差。他の拡張に間へ割り込まれないよう極小にするが、
    // 優先度が大きいと浮動小数の精度で差が消えるため、大きさに応じて広げる。
    const step = Math.max(1e-9, Math.abs(base) * 1e-12);
    this.providers.forEach((p, index) => {
      // 第1引数の id は必ず項目ごとに変えること。省略すると VSCode 側で
      // id が拡張機能ID そのものになり(extHostStatusBar の update)、
      // 全項目が同じ id を共有する。この id はステータスバー項目の DOM の
      // id 属性にそのまま入るため、重複した id を持つ要素が並び、
      // 項目間でホバーを移すと詳細が出なくなる。
      // 優先度は左右どちら側でも「大きいほど左」なので、定義順(Claude→Codex)で
      // 左から並ぶよう下げていく。基準の優先度ちょうどを使う他拡張より僅かに上に置く。
      const item = vscode.window.createStatusBarItem(
        `claudeCodexStatus.${p.id}`,
        side,
        base + (count - index) * step
      );
      item.name = `${p.label} 残量`;
      item.command = 'claudeCodexStatus.refresh';
      this.items.set(p.id, item);
    });
    // 全停止時はこれだけが残るため、プロバイダ項目と同じ位置へ置く。
    const paused = vscode.window.createStatusBarItem(
      'claudeCodexStatus.paused',
      side,
      base + (count + 1) * step
    );
    paused.name = 'Claude & Codex 監視停止中';
    paused.text = PAUSED_ICON;
    // 全停止の最小表示から復帰する主導線。ここで refresh を割り当てると、
    // 隠れたまま値だけ更新され、クリックしても何も起きないように見える。
    paused.command = 'claudeCodexStatus.resumeAllMonitoring';
    return paused;
  }

  private disposeItems(): void {
    for (const item of this.items.values()) {
      item.dispose();
    }
    this.items.clear();
    this.pausedItem.dispose();
  }

  /**
   * statusBarAlignment / statusBarPriority の設定変更イベントから呼ぶ。置き場所は項目の作成後に変えられないため、
   * 設定と食い違うときだけ項目を作り直す。再取得はせず、手元の状態でそのまま描画する。
   */
  syncPlacementFromConfig(): void {
    const next = configuredPlacement();
    if (
      next.alignment === this.placement.alignment &&
      next.priority === this.placement.priority
    ) {
      return;
    }
    this.placement = next;
    this.disposeItems();
    this.pausedItem = this.createItems();
    this.render();
  }

  /** 全プロバイダの監視を再開する。全停止時の最小表示のクリックから呼ぶ。 */
  resumeAllMonitoring(): void {
    const resumed = this.providers.filter((p) => !this.isMonitoringEnabled(p.id));
    for (const p of resumed) {
      this.monitoringEnabled.set(p.id, true);
    }
    this.syncPollTimer();
    this.render();
    // 再開したプロバイダだけ取得する(もともと監視中のものは次の定期取得に任せる)。
    for (const p of resumed) {
      void this.refresh(p.id);
    }
  }

  start(): void {
    this.render();
    this.restartPolling();
    this.renderTimer = setInterval(() => this.render(), RERENDER_INTERVAL_MS);
  }

  dispose(): void {
    this.stopPollTimer();
    if (this.renderTimer) {
      clearInterval(this.renderTimer);
      this.renderTimer = undefined;
    }
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    this.disposeItems();
  }

  /**
   * 設定変更時に呼ぶ。間隔と有効プロバイダを反映して再始動する。
   * 監視中の全プロバイダをすぐ取得するため、監視の停止・再開のような
   * 「タイマーの要否が変わるだけ」の場面では使わない(syncPollTimer を使う)。
   */
  restartPolling(): void {
    this.stopPollTimer();
    if (!this.anyMonitoring()) {
      return;
    }
    void this.refreshAll();
    this.startPollTimer();
  }

  private anyMonitoring(): boolean {
    return this.providers.some((p) => this.isMonitoringEnabled(p.id));
  }

  private startPollTimer(): void {
    const cfg = vscode.workspace.getConfiguration('claudeCodexStatus');
    const intervalSec = toIntervalSec(cfg.get<unknown>('pollIntervalSeconds'));
    this.pollTimer = setInterval(() => void this.refreshAll(), intervalSec * 1000);
  }

  private stopPollTimer(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  /** 監視中のプロバイダの有無に合わせて、定期取得のタイマーだけを動かす・止める(取得はしない)。 */
  private syncPollTimer(): void {
    if (!this.anyMonitoring()) {
      this.stopPollTimer();
    } else if (!this.pollTimer) {
      this.startPollTimer();
    }
  }

  /**
   * 指定プロバイダの自動監視だけを停止・再開する。
   * 再開したときは、そのプロバイダだけを取得する。停止したときは何も取得しない
   * (切り替えのたびに他方まで取得すると、連続操作で 429 を招く)。
   */
  toggleProviderMonitoring(id: ProviderId): void {
    const next = !this.isMonitoringEnabled(id);
    this.monitoringEnabled.set(id, next);
    if (!next) {
      this.clearRetryTimer(id);
    }
    this.syncPollTimer();
    this.render();
    if (next) {
      void this.refresh(id);
    }
  }

  /** バックオフが明ける時刻に、そのプロバイダだけ再取得する。定期取得の間隔を待たない。 */
  private scheduleRetry(id: ProviderId, delayMs: number): void {
    this.clearRetryTimer(id);
    const timer = setTimeout(() => {
      this.retryTimers.delete(id);
      if (this.isMonitoringEnabled(id)) {
        void this.refresh(id);
      }
    }, delayMs + RETRY_MARGIN_MS);
    this.retryTimers.set(id, timer);
  }

  private clearRetryTimer(id: ProviderId): void {
    const timer = this.retryTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(id);
    }
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
    // 終わったものから描画する(片方の応答が遅くても、もう片方の表示を待たせない)。
    await Promise.all(
      targets.map((p) => this.refreshOne(p, manual).then(() => this.render()))
    );
    this.render();
  }

  private async refreshAll(): Promise<void> {
    await this.refresh();
  }

  private refreshOne(provider: UsageProvider, manual = false): Promise<void> {
    // 取得中に次の取得(定期・手動・バックオフ明け)が重なったら、送らずに相乗りする。
    const running = this.inFlight.get(provider.id);
    if (running) {
      return running;
    }
    const run = this.refreshOneNow(provider, manual).finally(() => {
      this.inFlight.delete(provider.id);
    });
    this.inFlight.set(provider.id, run);
    return run;
  }

  private async refreshOneNow(provider: UsageProvider, manual: boolean): Promise<void> {
    const prev = this.states.get(provider.id);
    const { usage: last, at: lastFetchedAt } = lastGood(prev);
    const now = Date.now();

    // バックオフ中は API を叩かず、待機状態のまま据え置く(Claude 側の負荷を避ける)。
    // 手動更新だけは待機が長い場合の救済としてバックオフを突破できる。
    const b = this.backoff.get(provider.id);
    if (!manual && b && now < b.until) {
      // 監視の再開や設定での再有効化のあとは、再取得の予約が無いことがある。
      // ホバーで案内している時刻に再取得できるよう、無ければ予約し直す。
      if (!this.retryTimers.has(provider.id) && this.isMonitoringEnabled(provider.id)) {
        this.scheduleRetry(provider.id, b.until - now);
      }
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

    // ここから実際に送る。予約済みのバックオフ明けの再取得は不要になる。
    this.clearRetryTimer(provider.id);
    try {
      const usage = await provider.fetchUsage();
      this.backoff.delete(provider.id);
      this.states.set(provider.id, { kind: 'ok', usage, fetchedAt: Date.now() });
    } catch (err) {
      if (err instanceof RateLimitError) {
        const failures = (b?.failures ?? 0) + 1;
        const delay =
          err.retryAfterMs !== undefined
            ? Math.max(RETRY_AFTER_MIN_MS, Math.min(RETRY_AFTER_MAX_MS, err.retryAfterMs))
            : Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
        const until = Date.now() + delay;
        this.backoff.set(provider.id, { until, failures });
        if (this.isMonitoringEnabled(provider.id)) {
          this.scheduleRetry(provider.id, delay);
        }
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
    const style = toDisplayStyle(cfg.get<string>('style', 'minimal'));
    const mode = this.currentDisplayMode();
    const thresholds = getAlertThresholds(cfg);
    // 監視停止したプロバイダはバーから消す。全部消えると再開できなくなるため、
    // その場合だけ最小表示(アイコンのみ)へ畳んでホバー先を残す。
    const allPaused =
      enabled.length > 0 && !enabled.some((p) => this.isMonitoringEnabled(p.id));

    // 全停止時はクリックの意味が「更新」から「再開」に変わるため、案内も変える。
    if (allPaused) {
      this.pausedItem.tooltip = this.renderTooltip(enabled, mode, thresholds, true);
      this.pausedItem.show();
    } else {
      this.pausedItem.hide();
    }

    // orca では Orca と同じく、並びの先頭に「何の%か」の見出しを1つだけ付ける。
    // 項目を増やさず、表示中の左端の項目の本文へ前置きする。
    let heading = style === 'orca' ? `${mode === 'remaining' ? '残り' : '使用済み'}  ` : '';

    for (const p of this.providers) {
      const item = this.items.get(p.id);
      if (!item) {
        continue;
      }
      if (!enabled.includes(p) || !this.isMonitoringEnabled(p.id)) {
        item.hide();
        continue;
      }
      item.text = heading + this.renderSegment(p, style, mode, thresholds);
      heading = '';
      // どの項目にホバーしても全プロバイダの詳細を出すが、ホバーした項目の
      // プロバイダを先頭に置き、内容を項目ごとに必ず変える。並び替えは
      // 見やすさのためだけではない: VSCode はホバーの同一性を Markdown
      // 本文の文字列で判定し(hoverService の getHoverIdFromContent)、
      // 表示中と同一内容の表示要求を無視するため、隣接項目が同一内容だと
      // 項目間の移動でホバーが表示されなくなる。
      const ordered = [p, ...enabled.filter((other) => other !== p)];
      item.tooltip = this.renderTooltip(ordered, mode, thresholds, false);
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
    style: DisplayStyle,
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
        return `${head} ${formatUsage(state.usage, style, mode, thresholds)}`;
      case 'rateLimited':
        return state.last
          ? `${head} ${formatUsage(state.last, style, mode, thresholds)} $(clock)`
          : `${head}: 待機中 $(clock)`;
      case 'offline':
        return state.last
          ? `${head} ${formatUsage(state.last, style, mode, thresholds)} $(cloud-offline)`
          : `${head}: 接続不可 $(cloud-offline)`;
      case 'error':
        return state.last
          ? `${head} ${formatUsage(state.last, style, mode, thresholds)} $(alert)`
          : `${head}: 取得失敗 $(alert)`;
    }
  }

  private renderTooltip(
    enabled: UsageProvider[],
    mode: DisplayMode,
    thresholds: AlertThresholds,
    allPaused: boolean
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
        'claudeCodexStatus.resumeAllMonitoring',
        'claudeCodexStatus.toggleDisplayMode',
        'claudeCodexStatus.toggleAlertColors',
      ],
    };
    tooltip.supportThemeIcons = true;
    // 逼迫枠の文字色付け(<span style="color:...">)に必要。サニタイザにより
    // 許可されるのは span の color/background-color 等ごく一部のみで、
    // API 由来文字列は escapeMarkdown で `<` を潰しているため注入はできない。
    tooltip.supportHtml = true;

    if (allPaused) {
      // バーはアイコンだけになっているため、まず今の状態を明示する。
      tooltip.appendMarkdown(
        `${PAUSED_ICON} **全ての監視を停止中** — ステータスバーの表示を畳んでいます\n\n---\n\n`
      );
    }

    enabled.forEach((provider, index) => {
      if (index > 0) {
        tooltip.appendMarkdown('\n\n---\n\n');
      }
      this.appendProviderSection(tooltip, provider, mode, thresholds);
    });

    const nextModeLabel = mode === 'remaining' ? '使用率' : '残量';
    const colorsEnabled = this.currentAlertColorsEnabled();
    tooltip.appendMarkdown(
      (allPaused
        ? '\n\n$(play) クリックで全ての監視を再開　'
        : '\n\n$(refresh) クリックで今すぐ更新　') +
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
        // 残り秒数は描画した時点の値で古くなるため、再取得する時刻で示す。
        const when = monitoring
          ? `${formatTime(state.retryAt)} ごろに自動再取得`
          : `${formatTime(state.retryAt)} ごろまで待機`;
        tooltip.appendMarkdown(
          `\n\n$(clock) レート制限(429)中 — ${when}` + '(「更新」で今すぐ再試行)'
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
 * 「トークン更新待ち」は期限切れだが、Claude Code 起動で自動更新され自然に復帰する。
 * 「認証情報エラー」はファイル自体の異常で、ログインし直しでは直らないこともある。
 */
function authPresentation(reason: AuthFailureReason): AuthPresentation {
  switch (reason) {
    case 'tokenExpired':
      return { label: 'トークン更新待ち', icon: '$(key)' };
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
  style: DisplayStyle,
  mode: DisplayMode,
  thresholds: AlertThresholds
): string {
  if (style === 'orca') {
    return formatUsageOrca(usage, mode, thresholds);
  }
  const verbose = style === 'verbose';
  // モデル別(Fable 等)も含め全枠を表示。": " の前後に半角スペースを入れる。
  // ステータスバー本文は部分的な色付けができないため、逼迫はアイコンで示す。
  const parts = usage.limits.map((l) => {
    const base = `${l.shortLabel} : ${formatPercent(l, mode)}${alertIcon(limitLevel(l, thresholds))}`;
    return verbose && l.resetsAt ? `${base} (${formatResetIn(l.resetsAt)})` : base;
  });
  return parts.join('  ');
}

/**
 * Orca のステータスバーに合わせた書式。「▰▰▱▱▱ 33% 2h 17m · 94% 27m · 37% Fable」。
 * 枠の名前(5h / 7d)は出さず、%の後ろにリセットまでの時間を添える。モデル別の枠は
 * 時間の代わりにモデル名を添える。先頭のバーは先頭の枠(通常はセッション枠)を表し、
 * 表示中の%(残量なら残量、使用率なら使用率)をそのまま塗る。
 */
function formatUsageOrca(
  usage: ProviderUsage,
  mode: DisplayMode,
  thresholds: AlertThresholds
): string {
  const parts = usage.limits.map((l) => {
    const pct = formatPercent(l, mode);
    const suffix = l.scopeName ?? formatResetCompact(l.resetsAt);
    // 逼迫のアイコンは%と時間の間に挟まず、その枠の末尾に付ける。
    return `${suffix ? `${pct} ${suffix}` : pct}${alertIcon(limitLevel(l, thresholds))}`;
  });
  const lead = usage.limits[0];
  if (!lead) {
    return '';
  }
  const shown = mode === 'remaining' ? 100 - lead.utilization : lead.utilization;
  return `${meter(shown, 5)} ${parts.join(' · ')}`;
}

/** リセットまでの時間を「2d 7h」「2h 17m」「27m」の形で返す。不明なら空文字。 */
function formatResetCompact(resetsAt: string | null): string {
  if (!resetsAt) {
    return '';
  }
  const target = new Date(resetsAt).getTime();
  if (Number.isNaN(target)) {
    return '';
  }
  const totalMin = Math.max(0, Math.floor((target - Date.now()) / 60000));
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

/** 設定の取得間隔(秒)を下限〜上限へ収める。数値でなければ既定値にする。 */
function toIntervalSec(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_INTERVAL_SEC;
  }
  return Math.max(MIN_INTERVAL_SEC, Math.min(MAX_INTERVAL_SEC, value));
}

function toDisplayStyle(value: string | undefined): DisplayStyle {
  return value === 'verbose' || value === 'orca' ? value : 'minimal';
}

/**
 * 設定の置き場所を読む。alignment は 'left' 以外(未設定・想定外の値)なら従来どおり右。
 * priority は数値のときだけ使い、未設定(null)や想定外の値なら側ごとの既定値にする。
 */
function configuredPlacement(): BarPlacement {
  const cfg = vscode.workspace.getConfiguration('claudeCodexStatus');
  const alignment: BarAlignment =
    cfg.get<string>('statusBarAlignment', 'right') === 'left' ? 'left' : 'right';
  const custom = cfg.get<number | null>('statusBarPriority', null);
  const priority =
    typeof custom === 'number' && Number.isFinite(custom)
      ? Math.max(-1e9, Math.min(1e9, custom))
      : alignment === 'left'
        ? DEFAULT_PRIORITY_LEFT
        : DEFAULT_PRIORITY_RIGHT;
  return { alignment, priority };
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

/** 割合(0-100)を「▰(塗り)▱(中抜き)」のバーにする。既定は10段。 */
function meter(percent: number, segments = 10): string {
  const filled = Math.max(
    0,
    Math.min(segments, Math.round((percent / 100) * segments))
  );
  return '▰'.repeat(filled) + '▱'.repeat(segments - filled);
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
