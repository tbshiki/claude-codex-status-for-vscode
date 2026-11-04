/**
 * GitHub Releases から最新版の情報と .vsix を取得する。
 * VSCode API に依存しない(単体で動かして確かめられるようにする)。
 *
 * - 通信先は api.github.com(最新リリースの情報)と github.com(.vsix の取得。
 *   GitHub の配信用ホストへリダイレクトされる)だけ。トークンなどの認証情報は送らない。
 * - API の応答は信用しすぎない。タグ名・ダウンロード先・ハッシュは形式を確かめてから使い、
 *   リリースの本文(利用者向けの文章)は扱わない。
 */
import { createHash } from 'crypto';

const API_BASE = 'https://api.github.com';
const API_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** .vsix の上限。現在は 30KB 程度なので、これを超えるものは想定外として扱う。 */
const MAX_VSIX_BYTES = 20 * 1024 * 1024;

export interface GitHubRepository {
  owner: string;
  repo: string;
}

export interface ReleaseAsset {
  name: string;
  /** https://github.com/<owner>/<repo>/releases/download/... に限る。 */
  downloadUrl: string;
  size: number;
  /** GitHub が計算した SHA-256(小文字の16進)。 */
  sha256: string;
}

export interface LatestRelease {
  /** 先頭の v を除いた版(例: "0.2.15")。 */
  version: string;
  tagName: string;
  /** リリースのページ。API の値は使わず、検証済みのタグ名から組み立てる。 */
  pageUrl: string;
  /** インストールに使える .vsix。見つからない・検証できない場合は undefined。 */
  vsix?: ReleaseAsset;
}

/** GitHub API のレート制限(未認証は IP ごとに 60 回/時)に掛かった。 */
export class GitHubRateLimitError extends Error {
  constructor() {
    super('GitHub API のレート制限中です。しばらくしてから再試行してください。');
    this.name = 'GitHubRateLimitError';
  }
}

/**
 * package.json の repository(文字列、または { url })から GitHub のリポジトリを取り出す。
 * GitHub の https の URL でなければ undefined(アップデートの確認をしない)。
 */
export function parseGitHubRepository(repository: unknown): GitHubRepository | undefined {
  const url =
    typeof repository === 'string'
      ? repository
      : isRecord(repository) && typeof repository.url === 'string'
        ? repository.url
        : undefined;
  if (!url) {
    return undefined;
  }
  const match =
    /^(?:git\+)?https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(
      url.trim()
    );
  return match ? { owner: match[1], repo: match[2] } : undefined;
}

/** "0.2.15" / "v0.2.15" を数値の組にする。それ以外の形式(プレリリース等)は undefined。 */
export function parseVersion(value: string): [number, number, number] | undefined {
  const match = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** a が b より新しければ正、同じなら 0、古ければ負。どちらかが解析できなければ undefined。 */
export function compareVersions(a: string, b: string): number | undefined {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) {
    return undefined;
  }
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) {
      return pa[i] - pb[i];
    }
  }
  return 0;
}

/**
 * 最新のリリース(下書きとプレリリースを除く)を取得する。
 * @param assetBaseName .vsix の名前の先頭(package.json の name)。`<name>-<version>.vsix` を優先して選ぶ。
 */
export function fetchLatestRelease(
  repository: GitHubRepository,
  assetBaseName: string,
  userAgent: string
): Promise<LatestRelease> {
  const { owner, repo } = repository;
  const url = `${API_BASE}/repos/${owner}/${repo}/releases/latest`;
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': userAgent,
  };
  return withTimeout(API_TIMEOUT_MS, '最新リリースの取得', async (signal) => {
    const response = await fetch(url, { headers, signal });
    if (
      response.status === 429 ||
      (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
    ) {
      throw new GitHubRateLimitError();
    }
    if (response.status === 404) {
      throw new Error('公開済みのリリースが見つかりません');
    }
    if (!response.ok) {
      throw new Error(`最新リリースの取得に失敗しました (HTTP ${response.status})`);
    }
    const raw: unknown = await response.json().catch((err: unknown) => {
      if (isAbort(err)) {
        throw err;
      }
      throw new Error('最新リリースの応答を解析できませんでした');
    });
    if (!isRecord(raw) || typeof raw.tag_name !== 'string') {
      throw new Error('最新リリースの応答にタグ名がありません');
    }
    const tagName = raw.tag_name;
    const parsed = parseVersion(tagName);
    if (!parsed) {
      throw new Error('最新リリースのタグ名が想定外の形式です');
    }
    const version = parsed.join('.');
    return {
      version,
      tagName,
      pageUrl: `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(tagName)}`,
      vsix: pickVsixAsset(raw.assets, repository, `${assetBaseName}-${version}.vsix`),
    };
  });
}

/**
 * .vsix をダウンロードし、GitHub が示す SHA-256 と一致した場合だけ中身を返す。
 * 一致しなければ例外を投げる(途中で壊れた・差し替えられたファイルは使わない)。
 */
export function downloadVerifiedAsset(
  asset: ReleaseAsset,
  userAgent: string
): Promise<Uint8Array> {
  if (asset.size > MAX_VSIX_BYTES) {
    return Promise.reject(new Error('.vsix のサイズが想定より大きいため中止しました'));
  }
  const headers = { Accept: 'application/octet-stream', 'User-Agent': userAgent };
  return withTimeout(DOWNLOAD_TIMEOUT_MS, '.vsix のダウンロード', async (signal) => {
    // github.com から GitHub の配信用ホストへリダイレクトされる。
    // 中身は最後に SHA-256 で確かめるため、リダイレクト先のホストは限定しない。
    const response = await fetch(asset.downloadUrl, { headers, signal, redirect: 'follow' });
    if (!response.ok) {
      throw new Error(`.vsix のダウンロードに失敗しました (HTTP ${response.status})`);
    }
    if (!response.url.startsWith('https://')) {
      throw new Error('.vsix のダウンロード先が https ではないため中止しました');
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_VSIX_BYTES) {
      throw new Error('.vsix のサイズが想定より大きいため中止しました');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== asset.sha256) {
      throw new Error('.vsix のハッシュ(SHA-256)がリリースの値と一致しないため中止しました');
    }
    return bytes;
  });
}

/**
 * assets から .vsix を 1 つ選ぶ。`preferredName` と同名のものを優先し、
 * 無ければ .vsix がちょうど 1 つのときだけそれを使う。
 * ダウンロード先が同じリポジトリのリリースでないもの、SHA-256 が無いものは使わない。
 */
function pickVsixAsset(
  assets: unknown,
  repository: GitHubRepository,
  preferredName: string
): ReleaseAsset | undefined {
  if (!Array.isArray(assets)) {
    return undefined;
  }
  const downloadPrefix = `https://github.com/${repository.owner}/${repository.repo}/releases/download/`;
  const candidates: ReleaseAsset[] = [];
  for (const item of assets) {
    if (!isRecord(item) || item.state !== 'uploaded') {
      continue;
    }
    const { name, browser_download_url: downloadUrl, size, digest } = item;
    if (typeof name !== 'string' || !name.endsWith('.vsix')) {
      continue;
    }
    if (typeof downloadUrl !== 'string' || !downloadUrl.startsWith(downloadPrefix)) {
      continue;
    }
    const sha256 =
      typeof digest === 'string' ? /^sha256:([0-9a-f]{64})$/i.exec(digest)?.[1] : undefined;
    if (!sha256 || typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
      continue;
    }
    candidates.push({ name, downloadUrl, size, sha256: sha256.toLowerCase() });
  }
  return (
    candidates.find((asset) => asset.name === preferredName) ??
    (candidates.length === 1 ? candidates[0] : undefined)
  );
}

/**
 * 本文の読み取りまで含めて timeoutMs で打ち切る。
 * fetch 自体の失敗(DNS・接続拒否・TLS)とタイムアウトは、原因の分かる文言にして投げ直す。
 */
async function withTimeout<T>(
  timeoutMs: number,
  what: string,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } catch (err) {
    if (isAbort(err)) {
      throw new Error(`${what}がタイムアウトしました`);
    }
    if (err instanceof TypeError) {
      // fetch の接続失敗は TypeError('fetch failed') になる。cause に詳しい原因が入る。
      const detail = (err as { cause?: unknown }).cause;
      const cause = detail instanceof Error ? detail.message : err.message;
      throw new Error(`${what}で GitHub に接続できませんでした (${cause})`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
