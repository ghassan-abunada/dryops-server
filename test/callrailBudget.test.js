const test = require('node:test');
const assert = require('node:assert');
const { createCallrailBudget, orderAccounts } = require('../callrailBudget');

const MIN = 60 * 1000;

test('counts requests per account over a rolling hour and day', () => {
  let t = 1_000_000 * MIN;
  const b = createCallrailBudget({ now: () => t });
  for (let i = 0; i < 5; i++) b.note('A');
  b.note('B');
  assert.deepStrictEqual(b.usage('A'), { hour: 5, day: 5 });
  assert.deepStrictEqual(b.usage('B'), { hour: 1, day: 1 });
  t += 61 * MIN;
  b.note('A');
  assert.deepStrictEqual(b.usage('A'), { hour: 1, day: 6 });
  t += 24 * 60 * MIN;
  assert.deepStrictEqual(b.usage('A'), { hour: 0, day: 0 });
  assert.deepStrictEqual(b.usage('never seen'), { hour: 0, day: 0 });
});

test('background work stops at its share of the hourly and daily limit', () => {
  let t = 2_000_000 * MIN;
  const b = createCallrailBudget({ now: () => t, hourlyLimit: 10, dailyLimit: 20, backgroundShare: 0.5 });
  for (let i = 0; i < 4; i++) b.note('A');
  assert.strictEqual(b.allowBackground('A'), true);
  b.note('A'); // 5 of 10 this hour
  assert.strictEqual(b.allowBackground('A'), false);
  assert.strictEqual(b.allowBackground('B'), true, 'each account has its own budget');
  t += 61 * MIN; // the hour rolls, the day does not
  assert.strictEqual(b.allowBackground('A'), true);
  for (let i = 0; i < 4; i++) b.note('A');
  t += 61 * MIN;
  b.note('A'); // 10 of 20 today
  assert.strictEqual(b.allowBackground('A'), false);
  t += 24 * 60 * MIN;
  assert.strictEqual(b.allowBackground('A'), true);
});

test('a 429 pauses the account, for Retry-After when CallRail sends one', () => {
  let t = 3_000_000 * MIN;
  const b = createCallrailBudget({ now: () => t, blockMs: 10 * MIN });
  b.block('A');
  assert.strictEqual(b.blockedMs('A'), 10 * MIN);
  assert.strictEqual(b.allowBackground('A'), false);
  assert.strictEqual(b.blockedMs('B'), 0);
  t += 10 * MIN;
  assert.strictEqual(b.blockedMs('A'), 0);
  assert.strictEqual(b.allowBackground('A'), true);
  b.block('A', '120');
  assert.strictEqual(b.blockedMs('A'), 2 * MIN);
  b.block('A', '999999'); // never longer than an hour
  assert.strictEqual(b.blockedMs('A'), 60 * MIN);
  const snap = b.snapshot().find((s) => s.account === 'A');
  assert.strictEqual(snap.paused_seconds, 3600);
  assert.strictEqual(snap.background_allowed, false);
  assert.ok(snap.last_429_at);
});

test('orderAccounts puts the owning account first and keeps the rest', () => {
  assert.deepStrictEqual(orderAccounts(['A', 'B', 'C'], 'C'), ['C', 'A', 'B']);
  assert.deepStrictEqual(orderAccounts(['A', 'B', 'C'], null), ['A', 'B', 'C']);
  assert.deepStrictEqual(orderAccounts(['A', 'B'], 'not ours'), ['A', 'B']);
  assert.deepStrictEqual(orderAccounts([], 'A'), []);
});
