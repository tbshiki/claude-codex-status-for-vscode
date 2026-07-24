import * as vscode from 'vscode';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  NetworkError,
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

/** 使用状況レスポンスの受信上限。通常は数KBのため、異常応答からメモリを守る保険。 */
const MAX_RESPONSE_BYTES = 1_000_000;

/**
 * 有効期限のこの時間だけ手前で「失効」と見なす余裕(ミリ秒)。
 * 期限ちょうどの境界で送るとリクエスト中に切れて 401 になり得るため、
 * 少し早めに「更新待ち」へ倒して無駄な送信を避ける。
 */
const TOKEN_EXPIRY_SKEW_MS = 30_000;

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
    const token = await this.readAccessToken();
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

  /**
   * 認証情報からアクセストークンを読む。読めない場合は原因を分類して投げる。
   * ここで原因をまとめて握り潰すと、表示側が「未ログイン」しか案内できなくなる。
   */
  private async readAccessToken(): Promise<string> {
    const credPath = this.getCredentialsPath();

    let rawText: string;
    try {
      // ポーリングごとに呼ばれるため、拡張ホストをブロックしない非同期読み込みにする。
      rawText = await fs.promises.readFile(credPath, 'utf8');
    } catch (err) {
      throw readFailureToError(err, credPath);
    }

    let json: unknown;
    try {
      json = JSON.parse(rawText);
    } catch {
      throw new NotAuthenticatedError(
        'credentialsInvalid',
        `認証情報ファイルの JSON を解析できませんでした (${credPath})`,
        'ファイルが壊れている可能性があります。claude login をやり直すと再作成されます。'
      );
    }

    const oauth = (
      json as {
        claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown };
      } | null
    )?.claudeAiOauth;
    const token = oauth?.accessToken;
    if (typeof token !== 'string' || token.length === 0) {
      throw new NotAuthenticatedError(
        'tokenMissing',
        `認証情報に OAuth トークン (claudeAiOauth.accessToken) がありません (${credPath})`,
        'この拡張機能は OAuth ログイン専用のエンドポイントを使うため、ANTHROPIC_API_KEY など ' +
          'APIキー運用では残量を取得できません。claude login で OAuth ログインしてください。'
      );
    }

    // アクセストークンは短命で、Claude Code が refreshToken を使って自動更新する。
    // この拡張機能は自前で更新しないため、期限切れのトークンをそのまま送ると
    // 401/403 になる。事前に expiresAt を見て、失効時は無駄な送信を避け、
    // 「Claude Code 起動で自動復帰する」旨を案内する(フェイルソフト)。
    // expiresAt が数値でない/欠落する場合はチェックせず、そのまま送って
    // API 側の判定(tokenRejected)に委ねる。
    const expiresAt = oauth?.expiresAt;
    if (
      typeof expiresAt === 'number' &&
      Number.isFinite(expiresAt) &&
      Date.now() + TOKEN_EXPIRY_SKEW_MS >= expiresAt
    ) {
      throw new NotAuthenticatedError(
        'tokenExpired',
        `アクセストークンの有効期限が切れています (期限 ${new Date(expiresAt).toLocaleString()})`,
        'Claude Code CLI か公式拡張機能を起動するとトークンが自動更新され、次回の取得で自動的に復帰します。' +
          'この拡張機能は OAuth トークンを自前で更新しないため、期限切れの間だけ残量を取得できません。'
      );
    }
    return token;
  }

  private request(token: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      // タイムアウトや自前の中断は destroy 経由で 'error' に合流するため、
      // 意図した中断理由をここに退避し、接続失敗と取り違えないようにする。
      let aborted: Error | undefined;
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
          res.on('data', (chunk) => {
            data += chunk;
            if (data.length > MAX_RESPONSE_BYTES) {
              // destroy には理由を渡す。省略しても切断として 'error' には来るが、
              // ECONNRESET(socket hang up)に化けて中断理由が失われる。
              aborted = new Error('レスポンスサイズが上限を超えました');
              req.destroy(aborted);
            }
          });
          res.on('end', () => {
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) {
              try {
                resolve(JSON.parse(data));
              } catch {
                reject(new Error('レスポンスのJSON解析に失敗しました'));
              }
            } else if (status === 401 || status === 403) {
              reject(
                new NotAuthenticatedError(
                  'tokenRejected',
                  `アクセストークンが拒否されました (HTTP ${status})`,
                  'トークンが失効している可能性があります。Claude Code CLI か公式拡張機能を起動すると' +
                    'トークンが自動更新され、次回の取得で復帰します。解消しない場合は claude login で再認証してください。'
                )
              );
            } else if (status === 429) {
              reject(
                new RateLimitError(
                  'レート制限(HTTP 429)',
                  parseRetryAfter(res.headers['retry-after'])
                )
              );
            } else {
              reject(new Error(`使用状況を取得できませんでした (HTTP ${status})`));
            }
          });
        }
      );
      req.on('timeout', () => {
        aborted = new NetworkError('使用状況の取得がタイムアウトしました');
        req.destroy(aborted);
      });
      // https.request の 'error' は接続レベルの失敗(DNS/接続拒否/TLS/切断)でのみ
      // 発火する。HTTP ステータス起因のエラーはここへ来ないため、到達不能とみなせる。
      req.on('error', (err) => {
        reject(aborted ?? new NetworkError(`接続に失敗しました (${networkDetail(err)})`));
      });
      req.end();
    });
  }
}

/** 認証情報ファイルの読み取り失敗を、権限・不在などの原因へ振り分ける。 */
function readFailureToError(err: unknown, credPath: string): NotAuthenticatedError {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new NotAuthenticatedError(
      'credentialsMissing',
      `認証情報ファイルが見つかりません (${credPath})`,
      missingCredentialsHint()
    );
  }
  return new NotAuthenticatedError(
    'credentialsUnreadable',
    `認証情報ファイルを読み取れませんでした (${code ?? errorText(err)})`,
    'ファイルのアクセス権限を確認してください。'
  );
}

/**
 * ファイル不在時の案内。macOS の Claude Code は認証情報を Keychain に置き、
 * このファイルを作らないことがあるため、その環境でだけ理由を補足する。
 */
function missingCredentialsHint(): string {
  const base =
    'Claude Code CLI で claude login を実行してください。' +
    '保存先が異なる場合は設定 claudeCodexStatus.claude.credentialsPath でパスを指定できます。';
  if (process.platform === 'darwin') {
    return (
      'macOS の Claude Code は認証情報を Keychain に保存するため、ログイン済みでも' +
      'このファイルが作られないことがあります。その場合、現状この拡張機能では残量を取得できません。' +
      base
    );
  }
  return base;
}

/** 接続失敗の原因を短く表す。errno があればそれを、無ければメッセージを使う。 */
function networkDetail(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code ?? errorText(err);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  const utilization = clampPercent(l.percent);
  const resetsAt = l.resets_at ?? null;
  const active = l.is_active ?? false;
  const model = sanitizeApiText(l.scope?.model?.display_name);

  switch (l.kind) {
    case 'session':
      return limit('セッション(5h)', '5h', utilization, resetsAt, true, active);
    case 'weekly_all':
      return limit('週(全体)', '7d', utilization, resetsAt, true, active);
    case 'weekly_scoped':
      if (model) {
        return limit(`週(${model})`, `${model} 7d`, utilization, resetsAt, false, active);
      }
      return limit('週(スコープ)', 'wk', utilization, resetsAt, false, active);
    default: {
      // 未知の種類も表示だけはできるよう拾う(フェイルソフト)。
      const name = model ?? sanitizeApiText(l.kind) ?? '不明';
      return limit(name, name, utilization, resetsAt, false, active);
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
      limit('セッション(5h)', '5h', clampPercent(raw.five_hour.utilization), raw.five_hour.resets_at ?? null, true, true)
    );
  }
  if (raw.seven_day) {
    out.push(
      limit('週(全体)', '7d', clampPercent(raw.seven_day.utilization), raw.seven_day.resets_at ?? null, true, true)
    );
  }
  return out;
}

/** API 由来の割合を 0-100 の整数へ丸める。数値でなければ 0(フェイルソフト)。 */
function clampPercent(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function limit(
  label: string,
  shortLabel: string,
  utilization: number,
  resetsAt: string | null,
  primary: boolean,
  active: boolean
): UsageLimit {
  return { label, shortLabel, utilization, resetsAt, primary, active };
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
