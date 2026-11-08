const test = require('node:test');
const assert = require('node:assert');
const fixture = require('./fixtures/cardFlags.json');
const { flagTransactions, FLAG_RULES } = require('../cardFlags');

test('card flags match the fixture shared with the app (lib/__tests__/fixtures/cardFlags.json)', () => {
  const flags = flagTransactions(fixture.txns);
  const got = {};
  for (const [id, reasons] of flags) if (reasons.length) got[id] = reasons;
  assert.deepEqual(got, fixture.flags);
});

test('rules carry the tuned thresholds', () => {
  assert.equal(FLAG_RULES.duplicateDays, 1);
  assert.equal(FLAG_RULES.aboveUsualMin, 1000);
  assert.equal(FLAG_RULES.roundMin, 200);
  assert.ok(FLAG_RULES.merchantWords.includes('topgolf'));
});

test('refunds and vendor repeats are never flagged', () => {
  const flags = flagTransactions([
    { id: 'r', cardholder: 'A', vendor_card: false, merchant: 'Town Liquor', account_number: '1', at: '2026-10-01T00:00:00Z', amount: -40 },
    { id: 'v1', cardholder: 'Vendor X', vendor_card: true, merchant: 'Ads', account_number: '1', at: '2026-10-01T00:00:00Z', amount: 2000 },
    { id: 'v2', cardholder: 'Vendor X', vendor_card: true, merchant: 'Ads', account_number: '1', at: '2026-10-01T01:00:00Z', amount: 2000 },
  ]);
  assert.equal(flags.size, 0);
});
