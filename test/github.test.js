'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  compareVersions,
  parseGitHubRepository,
  parseVersion,
  remainingCooldownMs,
} = require('../out/update/github.js');

test('parseVersion は X.Y.Z と vX.Y.Z だけを受け付ける', () => {
  assert.deepEqual(parseVersion('0.2.15'), [0, 2, 15]);
  assert.deepEqual(parseVersion('v1.20.3'), [1, 20, 3]);
  assert.equal(parseVersion('1.2'), undefined);
  assert.equal(parseVersion('1.2.3-beta.1'), undefined);
  assert.equal(parseVersion('latest'), undefined);
});

test('compareVersions は数値として比べる', () => {
  assert.ok(compareVersions('0.2.20', '0.2.19') > 0);
  assert.ok(compareVersions('0.2.9', '0.2.10') < 0);
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
  assert.equal(compareVersions('v0.2.20', '0.2.20'), 0);
  assert.equal(compareVersions('0.2.20', 'dev'), undefined);
});

test('remainingCooldownMs は公開から間もない版と日時が不明な版を待たせる', () => {
  const hour = 60 * 60 * 1000;
  const cooldown = 72 * hour;
  const now = 1_700_000_000_000;
  assert.equal(remainingCooldownMs(now - 73 * hour, now, cooldown), 0);
  assert.equal(remainingCooldownMs(now - 72 * hour, now, cooldown), 0);
  assert.equal(remainingCooldownMs(now - 70 * hour, now, cooldown), 2 * hour);
  // 公開日時が分からない、または未来(時計のずれ)のときは、最大まで待つ側に倒す。
  assert.equal(remainingCooldownMs(undefined, now, cooldown), cooldown);
  assert.equal(remainingCooldownMs(now + 5 * hour, now, cooldown), cooldown);
});

test('parseGitHubRepository は GitHub の https の URL だけを受け付ける', () => {
  assert.deepEqual(parseGitHubRepository('https://github.com/owner/repo.git'), {
    owner: 'owner',
    repo: 'repo',
  });
  assert.deepEqual(parseGitHubRepository({ url: 'git+https://github.com/owner/my.repo' }), {
    owner: 'owner',
    repo: 'my.repo',
  });
  assert.equal(parseGitHubRepository('https://example.com/owner/repo.git'), undefined);
  assert.equal(parseGitHubRepository('https://github.com.example.com/owner/repo'), undefined);
  assert.equal(parseGitHubRepository('git@github.com:owner/repo.git'), undefined);
  assert.equal(parseGitHubRepository(undefined), undefined);
});
