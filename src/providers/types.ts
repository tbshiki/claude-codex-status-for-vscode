/**
 * プロバイダ(Claude / Codex)共通のデータ契約。
 * 非公式なAPIやログ形式への依存をこのレイヤに閉じ込め、
 * 表示側(statusBar)は正規化済みの型だけを扱う。
 */

export type ProviderId = 'claude' | 'codex';

/**
 * 個々の制限枠(セッション/週/モデル別週など)を正規化したもの。
 * API の `limits` 配列に対応し、モデルスコープ枠(Fable 等)も同じ形で表す。
 */
export interface UsageLimit {
  /** ツールチップ用の表示名(例: "セッション(5h)", "週(Fable)")。 */
  label: string;
  /** ステータスバー用の短縮ラベル(例: "5h", "7d", "Fable7d")。 */
  shortLabel: string;
  /**
   * 利用率(0-100、使用済みの割合)。全プロバイダで「使用率」に統一する。
   * 残量で返す API(Codex WHAM 等)はプロバイダ側で 100 - remaining へ変換する。
   */
  utilization: number;
  /** ISO8601 文字列、または不明・未設定の場合は null。 */
  resetsAt: string | null;
  /** 主要枠(セッション/週全体)。バーに常時表示する。 */
  primary: boolean;
  /** 消費が始まっている等、現在有効な枠か(バー表示の判断に使う)。 */
  active: boolean;
}

export interface ProviderUsage {
  /** 制限枠の一覧。並び順は API のまま(主要枠が先頭)。 */
  limits: UsageLimit[];
}

/**
 * 認証情報が見つからない/読めない場合に投げる。
 * 表示側は「未ログイン」相当の案内に振り分ける。
 */
export class NotAuthenticatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotAuthenticatedError';
  }
}

/**
 * プロバイダが未実装・準備中の場合に投げる。
 * 表示側は「準備中」として区別する。
 */
export class ProviderNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderNotReadyError';
  }
}

/**
 * レート制限(HTTP 429)を受けた場合に投げる。
 * retryAfterMs が分かれば表示側はそれだけバックオフする。
 */
export class RateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = 'RateLimitError';
  }
}

export interface UsageProvider {
  readonly id: ProviderId;
  /** ステータスバーに出す短いラベル(例: "Claude")。 */
  readonly label: string;
  /** codicon 記法のアイコン(例: "$(pulse)")。 */
  readonly icon: string;

  /**
   * 残量を取得する。取得できない場合は例外を投げる。
   * - 認証不可: NotAuthenticatedError
   * - 未実装: ProviderNotReadyError
   * - その他(ネットワーク/429/パース等): 通常の Error
   * 秘密情報(トークン等)を例外メッセージに含めてはならない。
   */
  fetchUsage(): Promise<ProviderUsage>;
}
