'use strict';
// StatusBarManager のテスト。時計とタイマーは node:test の mock.timers で進める。
const { test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const stub = require('./helpers/vscode-stub.js');
const { StatusBarManager } = require('../out/statusBar.js');
const { RateLimitError } = require('../out/providers/types.js');

const START = Date.UTC(2030, 0, 1, 0, 0, 0);
const MINUTE = 60_000;
/** 作った manager。テストの後でまとめて破棄する(タイマーを残さない)。 */
let managers = [];

beforeEach(() => {
  stub.reset();
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: START });
});

afterEach(() => {
  for (const m of managers) {
    m.dispose();
  }
  managers = [];
  mock.timers.reset();
});

/** 待っている Promise の続きを進める(setImmediate は差し替えていない)。 */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** 時計を進める。タイマーが起こした非同期の続きも進むよう、1秒刻みで進める。 */
async function advance(ms) {
  for (let left = ms; left > 0; left -= 1000) {
    mock.timers.tick(Math.min(1000, left));
    await flush();
  }
}

const limit = (shortLabel, utilization, minutesToReset, scopeName) => ({
  label: shortLabel,
  shortLabel,
  utilization,
  resetsAt:
    minutesToReset === undefined
      ? null
      : new Date(START + minutesToReset * MINUTE + 30_000).toISOString(),
  primary: true,
  active: true,
  scopeName,
});

/** 呼ばれた回数を数えるプロバイダ。next に積んだ関数があれば、その結果を1回ずつ返す。 */
function provider(id, limits = [limit('5h', 10)]) {
  const p = {
    id,
    label: id === 'claude' ? 'Claude' : 'Codex',
    icon: id === 'claude' ? '$(pulse)' : '$(zap)',
    calls: 0,
    next: [],
    fetchUsage() {
      p.calls++;
      const step = p.next.shift();
      return step ? step() : Promise.resolve({ limits });
    },
  };
  return p;
}

function manager(providers) {
  const m = new StatusBarManager(providers);
  managers.push(m);
  return m;
}

const claudeLimits = [limit('5h', 33, 137), limit('7d', 94, 27), limit('Fable 7d', 37, 3000, 'Fable')];
const codexLimits = [limit('5h', 0, 298), limit('7d', 43, 2 * 1440 + 7 * 60)];

test('orca: Orca に合わせた書式で、見出しは左端の項目にだけ付く', async () => {
  stub.config.style = 'orca';
  stub.config.displayMode = 'used';
  const m = manager([provider('claude', claudeLimits), provider('codex', codexLimits)]);
  await m.refresh();
  assert.equal(
    stub.liveItem('claude').text,
    '使用済み  $(pulse) Claude ▰▰▱▱▱ 33% 2h 17m · 94% 27m $(error) · 37% Fable'
  );
  assert.equal(stub.liveItem('codex').text, '$(zap) Codex ▱▱▱▱▱ 0% 4h 58m · 43% 2d 7h');

  stub.config.displayMode = 'remaining';
  m.syncDisplayModeFromConfig();
  assert.equal(
    stub.liveItem('claude').text,
    '残り  $(pulse) Claude ▰▰▰▱▱ 67% 2h 17m · 6% 27m $(error) · 63% Fable'
  );
});

test('orca: 左端の項目が監視停止で消えたら、見出しは次の項目へ移る', async () => {
  stub.config.style = 'orca';
  stub.config.displayMode = 'used';
  const m = manager([provider('claude', claudeLimits), provider('codex', codexLimits)]);
  await m.refresh();
  m.toggleProviderMonitoring('claude');
  assert.equal(stub.liveItem('claude').visible, false);
  assert.equal(stub.liveItem('codex').text, '使用済み  $(zap) Codex ▱▱▱▱▱ 0% 4h 58m · 43% 2d 7h');
});

test('minimal / verbose: 枠の名前とパーセント、verbose はリセットまでの時間も出す', async () => {
  const m = manager([provider('codex', codexLimits)]);
  await m.refresh();
  assert.equal(stub.liveItem('codex').text, '$(zap) Codex 5h : 100%  7d : 57%');
  stub.config.style = 'verbose';
  m.rerender();
  assert.equal(
    stub.liveItem('codex').text,
    '$(zap) Codex 5h : 100% (4時間58分後)  7d : 57% (2日7時間後)'
  );
});

test('残り時間の表示は、取得しなくても1分ごとに描き直す', async () => {
  stub.config.style = 'verbose';
  const p = provider('codex', [limit('5h', 0, 10)]);
  const m = manager([p]);
  m.start();
  await flush();
  assert.match(stub.liveItem('codex').text, /0時間10分後/);
  await advance(2 * MINUTE);
  assert.match(stub.liveItem('codex').text, /0時間8分後/);
  assert.equal(p.calls, 1);
});

test('表示位置: 左側は既定で Git のブランチ表示(10000)より左に、定義順で並ぶ', () => {
  stub.config.statusBarAlignment = 'left';
  manager([provider('claude'), provider('codex')]);
  const claude = stub.liveItem('claude');
  const codex = stub.liveItem('codex');
  const paused = stub.liveItem('paused');
  assert.equal(claude.alignment, 1);
  assert.ok(paused.priority > claude.priority);
  assert.ok(claude.priority > codex.priority);
  assert.ok(codex.priority > 10_000);
});

test('表示位置: 優先度が大きくても項目どうしの差が消えない', () => {
  stub.config.statusBarPriority = 1e9;
  manager([provider('claude'), provider('codex')]);
  assert.equal(stub.liveItem('claude').alignment, 2);
  assert.ok(stub.liveItem('paused').priority > stub.liveItem('claude').priority);
  assert.ok(stub.liveItem('claude').priority > stub.liveItem('codex').priority);
  assert.ok(stub.liveItem('codex').priority > 1e9);
});

test('表示位置: 変更時は項目を作り直し、値と監視の停止状態を引き継ぐ', async () => {
  const claude = provider('claude');
  const codex = provider('codex');
  const m = manager([claude, codex]);
  await m.refresh();
  m.toggleProviderMonitoring('claude');
  const before = stub.items.length;

  // 設定が変わっていなければ作り直さない。数値でない優先度は既定値として扱う。
  stub.config.statusBarPriority = 'high';
  m.syncPlacementFromConfig();
  assert.equal(stub.items.length, before);

  stub.config.statusBarAlignment = 'left';
  m.syncPlacementFromConfig();
  assert.equal(stub.items.filter((i) => !i.disposed).length, 3);
  assert.equal(stub.liveItem('codex').alignment, 1);
  assert.equal(stub.liveItem('codex').visible, true);
  assert.equal(stub.liveItem('codex').text, '$(zap) Codex 5h : 90%');
  assert.equal(stub.liveItem('claude').visible, false);
  // 作り直しでは取得しない。
  assert.equal(codex.calls, 1);
});

test('全停止: 最小表示だけを出し、再開すると戻る', async () => {
  const m = manager([provider('claude'), provider('codex')]);
  await m.refresh();
  m.toggleProviderMonitoring('claude');
  m.toggleProviderMonitoring('codex');
  assert.equal(stub.liveItem('paused').visible, true);
  assert.equal(stub.liveItem('claude').visible, false);
  assert.equal(stub.liveItem('codex').visible, false);
  m.resumeAllMonitoring();
  await flush();
  assert.equal(stub.liveItem('paused').visible, false);
  assert.equal(stub.liveItem('claude').visible, true);
});

test('取得間隔: 下限と上限へ収め、数値でない値は既定値にする', () => {
  const m = manager([provider('claude')]);
  const seen = [];
  const original = globalThis.setInterval;
  globalThis.setInterval = (fn, ms) => {
    seen.push(ms);
    return original(fn, ms);
  };
  try {
    const cases = [
      [undefined, 300_000],
      [300, 300_000],
      [10, 60_000],
      [-5, 60_000],
      [9_999_999, 86_400_000],
      ['abc', 300_000],
      [Number.NaN, 300_000],
      [Number.POSITIVE_INFINITY, 300_000],
      [null, 300_000],
    ];
    for (const [value, expected] of cases) {
      if (value === undefined) {
        delete stub.config.pollIntervalSeconds;
      } else {
        stub.config.pollIntervalSeconds = value;
      }
      seen.length = 0;
      m.restartPolling();
      assert.deepEqual(seen, [expected], `pollIntervalSeconds=${String(value)}`);
    }
  } finally {
    globalThis.setInterval = original;
  }
});

test('監視の切替: 停止では取得せず、再開ではそのプロバイダだけ取得する', async () => {
  const claude = provider('claude');
  const codex = provider('codex');
  const m = manager([claude, codex]);
  m.start();
  await flush();
  assert.deepEqual([claude.calls, codex.calls], [1, 1]);

  m.toggleProviderMonitoring('codex');
  await flush();
  assert.deepEqual([claude.calls, codex.calls], [1, 1]);

  m.toggleProviderMonitoring('codex');
  await flush();
  assert.deepEqual([claude.calls, codex.calls], [1, 2]);

  // 停止中のプロバイダは定期取得の対象から外れる。
  m.toggleProviderMonitoring('codex');
  await advance(5 * MINUTE);
  assert.deepEqual([claude.calls, codex.calls], [2, 2]);

  // 全停止の間は何も取得しない。
  m.toggleProviderMonitoring('claude');
  await advance(15 * MINUTE);
  assert.deepEqual([claude.calls, codex.calls], [2, 2]);

  m.resumeAllMonitoring();
  await flush();
  assert.deepEqual([claude.calls, codex.calls], [3, 3]);
  await advance(5 * MINUTE);
  assert.deepEqual([claude.calls, codex.calls], [4, 4]);
});

test('dispose のあとは取得しない', async () => {
  const claude = provider('claude');
  const m = manager([claude]);
  m.start();
  await flush();
  m.dispose();
  await advance(30 * MINUTE);
  assert.equal(claude.calls, 1);
});

test('429: 定期取得を待たず、バックオフが明けた時点で再取得する', async () => {
  const claude = provider('claude');
  claude.next = [() => Promise.reject(new RateLimitError('429'))];
  const m = manager([claude]);
  m.start();
  await flush();
  assert.match(stub.liveItem('claude').text, /待機中/);
  await advance(59_000);
  assert.equal(claude.calls, 1);
  await advance(2_000);
  assert.equal(claude.calls, 2);
  assert.match(stub.liveItem('claude').text, /90%/);
});

test('429: 続けて失敗したら待ち時間を倍にする', async () => {
  const claude = provider('claude');
  const reject = () => Promise.reject(new RateLimitError('429'));
  claude.next = [reject, reject];
  const m = manager([claude]);
  m.start();
  await flush();
  await advance(61_000);
  assert.equal(claude.calls, 2);
  await advance(119_000);
  assert.equal(claude.calls, 2);
  await advance(2_000);
  assert.equal(claude.calls, 3);
});

/** Retry-After 付きの 429 を1回返したあと、何ミリ秒後に再取得されたかを返す。 */
async function retryDelay(retryAfterMs, upToMs) {
  const claude = provider('claude');
  claude.next = [() => Promise.reject(new RateLimitError('429', retryAfterMs))];
  const m = manager([claude]);
  m.start();
  await flush();
  for (let elapsed = 0; elapsed < upToMs; elapsed += 1000) {
    await advance(1000);
    if (claude.calls > 1) {
      return elapsed + 1000;
    }
  }
  return undefined;
}

test('Retry-After: 0 秒は 30 秒に切り上げる', async () => {
  assert.equal(await retryDelay(0, 120_000), 31_000);
});

test('Retry-After: 範囲内の値はそのまま使う', async () => {
  assert.equal(await retryDelay(120_000, 300_000), 121_000);
});

test('Retry-After: 24 時間は 1 時間に切り下げる', async () => {
  // ちょうど 1 時間後は定期取得(5 分ごと)とも重なるため、その時点で再取得される。
  assert.equal(await retryDelay(86_400_000, 2 * 3_600_000), 3_600_000);
});

test('429: 監視を止めたら再取得せず、再開したらバックオフ明けに再取得する', async () => {
  const claude = provider('claude');
  claude.next = [() => Promise.reject(new RateLimitError('429', 600_000))];
  const m = manager([claude, provider('codex')]);
  m.start();
  await flush();
  m.toggleProviderMonitoring('claude');
  await advance(100_000);
  m.toggleProviderMonitoring('claude');
  await flush();
  // 再開してもバックオフ中は送らない。
  assert.equal(claude.calls, 1);
  await advance(498_000);
  assert.equal(claude.calls, 1);
  await advance(4_000);
  assert.equal(claude.calls, 2);
});

test('手動更新: バックオフ中でも送るが、15 秒以内の連打は送らない', async () => {
  const claude = provider('claude');
  claude.next = [() => Promise.reject(new RateLimitError('429', 600_000))];
  const m = manager([claude]);
  m.start();
  await flush();
  await m.refresh('claude', { manual: true });
  assert.equal(claude.calls, 2);
  await m.refresh('claude', { manual: true });
  assert.equal(claude.calls, 2);
  await advance(16_000);
  await m.refresh('claude', { manual: true });
  assert.equal(claude.calls, 3);
});

test('取得中に重なった取得は送らず、終わったプロバイダから描画する', async () => {
  const claude = provider('claude');
  const codex = provider('codex');
  let release;
  claude.next = [
    () =>
      new Promise((resolve) => {
        release = () => resolve({ limits: [limit('5h', 10)] });
      }),
  ];
  const m = manager([claude, codex]);
  m.start();
  await flush();
  // Claude の応答を待たずに Codex は表示される。
  assert.equal(stub.liveItem('codex').text, '$(zap) Codex 5h : 90%');
  assert.equal(stub.liveItem('claude').text, '$(pulse) Claude …');

  void m.refresh('claude', { manual: true });
  await flush();
  assert.equal(claude.calls, 1);

  release();
  await flush();
  assert.equal(stub.liveItem('claude').text, '$(pulse) Claude 5h : 90%');
});

test('失敗しても直近の値を残し、原因をアイコンで示す', async () => {
  const { NetworkError, NotAuthenticatedError } = require('../out/providers/types.js');
  const claude = provider('claude');
  const m = manager([claude]);
  await m.refresh();
  claude.next = [() => Promise.reject(new NetworkError('down'))];
  await m.refresh();
  assert.equal(stub.liveItem('claude').text, '$(pulse) Claude 5h : 90% $(cloud-offline)');
  claude.next = [() => Promise.reject(new Error('HTTP 500'))];
  await m.refresh();
  assert.equal(stub.liveItem('claude').text, '$(pulse) Claude 5h : 90% $(alert)');
  // 認証の失敗では古い値を出さない。
  claude.next = [() => Promise.reject(new NotAuthenticatedError('tokenRejected', 'rejected'))];
  await m.refresh();
  assert.equal(stub.liveItem('claude').text, '$(pulse) Claude: 要再ログイン $(key)');
});
