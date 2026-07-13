/**
 * プロバイダ(Claude / Codex)共通のデータ契約。
 * 非公式なAPIやログ形式への依存をこのレイヤに閉じ込め、
 * 表示側(statusBar)は正規化済みの型だけを扱う。
 */

export type ProviderId = 'claude' | 'codex';

export interface WindowUsage {
  /** 利用率(0-100)。 */
  utilization: number;
  /** ISO8601 文字列、または不明な場合は null。 */
  resetsAt: string | null;
}

export interface ProviderUsage {
  /** 5時間枠。 */
  fiveHour: WindowUsage;
  /** 週枠(7日)。 */
  sevenDay: WindowUsage;
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
