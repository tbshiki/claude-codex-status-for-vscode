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
 * 認証まわりで取得できなかった原因の分類。
 * 表示側はこれだけを見て文言・アイコンを切り分けるため、
 * 新しい原因を足すときは statusBar 側の分岐も揃える。
 */
export type AuthFailureReason =
  /** 認証情報ファイルが存在しない(未ログイン、または保管場所が違う)。 */
  | 'credentialsMissing'
  /** ファイルはあるが権限などで読み取れない。 */
  | 'credentialsUnreadable'
  /** ファイルは読めたが JSON として壊れている。 */
  | 'credentialsInvalid'
  /** JSON は読めたが目的のトークン項目が無い(APIキー運用など)。 */
  | 'tokenMissing'
  /**
   * トークンはあるが有効期限(expiresAt)が切れている。
   * この拡張機能は自前でトークンを更新しないため、Claude Code CLI か公式拡張機能を
   * 起動して自動更新されれば、次回の取得で復帰する(一時的・自動回復する認証状態)。
   */
  | 'tokenExpired'
  /** トークンはあるが API に拒否された(401/403 = 失効・剥奪)。 */
  | 'tokenRejected';

/**
 * 認証情報が無い/読めない/受け付けられない場合に投げる。
 * 表示側は reason で「未ログイン」「要再ログイン」「認証情報エラー」に振り分ける。
 * message と hint は利用者にそのまま見せるため、トークンを含めてはならない。
 */
export class NotAuthenticatedError extends Error {
  constructor(
    readonly reason: AuthFailureReason,
    message: string,
    /** 対処方法の案内(例: `claude login` を実行)。 */
    readonly hint?: string
  ) {
    super(message);
    this.name = 'NotAuthenticatedError';
  }
}

/**
 * ネットワーク層で到達できなかった場合に投げる(DNS・接続拒否・TLS・タイムアウト)。
 * HTTP 応答が返ってきた上でのエラーは含めない(それは通常の Error)。
 * 表示側は「接続不可」として、API 側の異常と区別する。
 */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
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
   * - 認証不可: NotAuthenticatedError(reason で原因を区別)
   * - 未実装: ProviderNotReadyError
   * - レート制限: RateLimitError
   * - 到達不能: NetworkError
   * - その他(HTTP エラー/パース等): 通常の Error
   * 秘密情報(トークン等)を例外メッセージに含めてはならない。
   */
  fetchUsage(): Promise<ProviderUsage>;
}
