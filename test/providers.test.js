'use strict';
// プロバイダの通信まわりのテスト。実際の API には送らない。
// Claude は https.request をローカルの HTTP サーバーへ向け、Codex は fetch を差し替える。
// 認証情報は一時フォルダに作ったダミーのファイルを使う(実在の認証情報は読まない)。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const stub = require('./helpers/vscode-stub.js');
const { ClaudeProvider } = require('../out/providers/claude.js');
const { CodexProvider, normalizeCodexUsage } = require('../out/providers/codex.js');
const {
  NetworkError,
  NotAuthenticatedError,
  RateLimitError,
  parseRetryAfter,
} = require('../out/providers/types.js');

const originalRequest = https.request;
const originalFetch = globalThis.fetch;
let tmpDir;
let server;
/** テストごとに差し替える、ローカルサーバーの応答。 */
let handler;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-test-'));
  const claudeCred = path.join(tmpDir, 'credentials.json');
  const codexAuth = path.join(tmpDir, 'auth.json');
  fs.writeFileSync(claudeCred, JSON.stringify({ claudeAiOauth: { accessToken: 'dummy' } }));
  fs.writeFileSync(codexAuth, JSON.stringify({ tokens: { access_token: 'dummy' } }));
  stub.config['claude.credentialsPath'] = claudeCred;
  stub.config['codex.authPath'] = codexAuth;

  server = http.createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  https.request = (options, callback) =>
    http.request({ ...options, hostname: '127.0.0.1', port }, callback);
});

after(async () => {
  https.request = originalRequest;
  globalThis.fetch = originalFetch;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

test('Claude: limits を共通形式へ正規化する', async () => {
  handler = (req, res) =>
    json(res, 200, {
      limits: [
        { kind: 'session', percent: 33.4, resets_at: '2030-01-01T00:00:00Z', is_active: true },
        { kind: 'weekly_all', percent: 94, resets_at: '2030-01-02T00:00:00Z', is_active: true },
        { kind: 'weekly_scoped', percent: 37, scope: { model: { display_name: 'Fable' } } },
      ],
    });
  const usage = await new ClaudeProvider().fetchUsage();
  assert.deepEqual(
    usage.limits.map((l) => [l.shortLabel, l.utilization, l.scopeName]),
    [
      ['5h', 33, undefined],
      ['7d', 94, undefined],
      ['Fable 7d', 37, 'Fable'],
    ]
  );
});

test('Claude: limits が無ければ five_hour / seven_day を使う', async () => {
  handler = (req, res) =>
    json(res, 200, { five_hour: { utilization: 12 }, seven_day: { utilization: 150 } });
  const usage = await new ClaudeProvider().fetchUsage();
  assert.deepEqual(
    usage.limits.map((l) => [l.shortLabel, l.utilization]),
    [
      ['5h', 12],
      ['7d', 100],
    ]
  );
});

test('Claude: モデル名の $( を分断し、アイコンとして解釈させない', async () => {
  handler = (req, res) =>
    json(res, 200, {
      limits: [{ kind: 'weekly_scoped', percent: 1, scope: { model: { display_name: 'a$(error)\nb' } } }],
    });
  const usage = await new ClaudeProvider().fetchUsage();
  assert.equal(usage.limits[0].scopeName, 'a$ (error) b');
});

test('Claude: 本文の途中で切断されたら、待ち続けず接続不可として失敗する', async () => {
  handler = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
    res.write('{"limits":[');
    setTimeout(() => res.socket.destroy(), 20);
  };
  await assert.rejects(new ClaudeProvider().fetchUsage(), NetworkError);
});

test('Claude: チャンクの境界で分かれた多バイト文字を壊さない', async () => {
  const body = Buffer.from(
    JSON.stringify({
      limits: [{ kind: 'weekly_scoped', percent: 37, scope: { model: { display_name: '日本語モデル' } } }],
    })
  );
  // 「本」の 3 バイトの途中で切る。
  const cut = body.indexOf(Buffer.from('本')) + 1;
  handler = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write(body.subarray(0, cut));
    setTimeout(() => res.end(body.subarray(cut)), 20);
  };
  const usage = await new ClaudeProvider().fetchUsage();
  assert.equal(usage.limits[0].label, '週(日本語モデル)');
});

test('Claude: 上限を超える応答を打ち切る', async () => {
  handler = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(Buffer.alloc(1_200_000, 0x20));
  };
  await assert.rejects(new ClaudeProvider().fetchUsage(), /上限/);
});

test('Claude: HTTP ステータスを原因ごとの例外にする', async () => {
  handler = (req, res) => json(res, 401, {});
  await assert.rejects(
    new ClaudeProvider().fetchUsage(),
    (err) => err instanceof NotAuthenticatedError && err.reason === 'tokenRejected'
  );
  handler = (req, res) => json(res, 429, {}, { 'retry-after': '120' });
  await assert.rejects(
    new ClaudeProvider().fetchUsage(),
    (err) => err instanceof RateLimitError && err.retryAfterMs === 120_000
  );
  handler = (req, res) => json(res, 500, {});
  await assert.rejects(
    new ClaudeProvider().fetchUsage(),
    (err) => !(err instanceof NetworkError) && /HTTP 500/.test(err.message)
  );
});

test('Claude: 期限切れのトークンは送らず、更新待ちとして失敗する', async () => {
  const expired = path.join(tmpDir, 'expired.json');
  fs.writeFileSync(
    expired,
    JSON.stringify({ claudeAiOauth: { accessToken: 'dummy', expiresAt: Date.now() - 1000 } })
  );
  const saved = stub.config['claude.credentialsPath'];
  stub.config['claude.credentialsPath'] = expired;
  let requested = false;
  handler = (req, res) => {
    requested = true;
    json(res, 200, {});
  };
  try {
    await assert.rejects(
      new ClaudeProvider().fetchUsage(),
      (err) => err instanceof NotAuthenticatedError && err.reason === 'tokenExpired'
    );
    assert.equal(requested, false);
  } finally {
    stub.config['claude.credentialsPath'] = saved;
  }
});

test('Claude: 認証情報ファイルが無ければ未ログインとして失敗する', async () => {
  const saved = stub.config['claude.credentialsPath'];
  stub.config['claude.credentialsPath'] = path.join(tmpDir, 'missing.json');
  try {
    await assert.rejects(
      new ClaudeProvider().fetchUsage(),
      (err) => err instanceof NotAuthenticatedError && err.reason === 'credentialsMissing'
    );
  } finally {
    stub.config['claude.credentialsPath'] = saved;
  }
});

const wham = (secondarySeconds) => ({
  rate_limit: {
    primary_window: { used_percent: 10, limit_window_seconds: 18_000 },
    secondary_window: { used_percent: 20, limit_window_seconds: secondarySeconds },
  },
});
const names = (usage) => usage.limits.map((l) => `${l.shortLabel}/${l.label}`);

test('Codex: リダイレクトを追わず、トークンを付けて送る', async () => {
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify(wham(604_800)), { status: 200 });
  };
  await new CodexProvider('1.2.3').fetchUsage();
  assert.equal(seen.url, 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal(seen.init.redirect, 'manual');
  assert.equal(seen.init.headers.Authorization, 'Bearer dummy');
  assert.equal(seen.init.headers['User-Agent'], 'claude-codex-status/1.2.3');
});

test('Codex: 2つ目の枠は、7日でないと分かるときだけ実際の長さで表す', () => {
  assert.deepEqual(names(normalizeCodexUsage(wham(604_800))), ['5h/セッション(5h)', '7d/週']);
  assert.deepEqual(names(normalizeCodexUsage(wham(30 * 86_400))), ['5h/セッション(5h)', '30d/30日']);
  assert.deepEqual(names(normalizeCodexUsage(wham(12 * 3_600))), ['5h/セッション(5h)', '12h/12時間']);
  assert.deepEqual(names(normalizeCodexUsage(wham(undefined))), ['5h/セッション(5h)', '7d/週']);
});

test('Codex: 5時間枠が無いときの1つ目の枠は「全体」と表す', () => {
  const usage = normalizeCodexUsage({
    rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 604_800 } },
  });
  assert.deepEqual(names(usage), ['全体/全体']);
});

test('Codex: app-server 形式(rateLimits)も受け付け、枠が無ければ失敗する', () => {
  const usage = normalizeCodexUsage({
    rateLimits: {
      primary: { usedPercent: 16, windowDurationMins: 300, resetsAt: 1_900_000_000 },
      secondary: { usedPercent: 2, windowDurationMins: 10_080 },
    },
  });
  assert.deepEqual(names(usage), ['5h/セッション(5h)', '7d/週']);
  assert.equal(usage.limits[0].resetsAt, new Date(1_900_000_000_000).toISOString());
  assert.throws(() => normalizeCodexUsage({ rate_limit: {} }), /レート制限枠がありません/);
  assert.throws(() => normalizeCodexUsage('oops'), /形式が不正/);
});

test('Codex: 429 の Retry-After を読む', async () => {
  globalThis.fetch = async () => new Response('', { status: 429, headers: { 'retry-after': '120' } });
  await assert.rejects(
    new CodexProvider('0.0.0').fetchUsage(),
    (err) => err instanceof RateLimitError && err.retryAfterMs === 120_000
  );
});

test('Codex: 上限を超える応答を打ち切る', async () => {
  globalThis.fetch = async () => new Response(Buffer.alloc(1_200_000, 0x20), { status: 200 });
  await assert.rejects(new CodexProvider('0.0.0').fetchUsage(), /上限/);
});

test('Codex: 接続の失敗と HTTP の失敗を区別する', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(new CodexProvider('0.0.0').fetchUsage(), NetworkError);
  globalThis.fetch = async () => new Response('', { status: 302, headers: { location: 'https://example.com/' } });
  await assert.rejects(
    new CodexProvider('0.0.0').fetchUsage(),
    (err) => !(err instanceof NetworkError) && /HTTP 302/.test(err.message)
  );
  globalThis.fetch = async () => new Response('', { status: 403 });
  await assert.rejects(
    new CodexProvider('0.0.0').fetchUsage(),
    (err) => err instanceof NotAuthenticatedError && err.reason === 'tokenRejected'
  );
});

test('parseRetryAfter は秒数と日時を読み、読めなければ undefined を返す', () => {
  assert.equal(parseRetryAfter('120'), 120_000);
  assert.equal(parseRetryAfter(['5', '9']), 5_000);
  assert.equal(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT'), 0);
  assert.equal(parseRetryAfter('soon'), undefined);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter(undefined), undefined);
});
