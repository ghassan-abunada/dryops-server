'use strict';
// The per-job storage billing decision (suppEligibility.js) — the cases the
// monthly worker's loop used to decide inline. Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const { suppEligibility, storageFields, SUPP_EXCLUDED_STATUSES } = require('../suppEligibility');

const base = (over) => ({
  jnid: 'j1', record_type_name: 'Contents', status_name: 'In storage',
  cf_boolean_1: true, cf_double_1: 250, cf_long_1: 2, is_active: true, is_archived: false,
  date_status_change: 1760000000, // 2025-10-09 Denver — not an ignored date
  ...over,
});

test('a priced, flagged Contents job is eligible with no reasons', () => {
  assert.deepStrictEqual(suppEligibility(base()), { eligible: true, placeholder: false, reasons: [] });
});

test('status "In storage" counts even when the flag is off', () => {
  const v = suppEligibility(base({ cf_boolean_1: false }));
  assert.strictEqual(v.eligible, true);
});

test('the flag counts even when the status is something else', () => {
  const v = suppEligibility(base({ status_name: 'Pending Payment' }));
  assert.strictEqual(v.eligible, true);
});

test('no price → eligible as a $0 placeholder', () => {
  for (const price of [0, null, undefined, '', 'abc']) {
    const v = suppEligibility(base({ cf_double_1: price }));
    assert.deepStrictEqual(v, { eligible: true, placeholder: true, reasons: ['No price yet — $0 placeholder'] }, `price=${price}`);
  }
});

test('not a Contents job', () => {
  const v = suppEligibility(base({ record_type_name: 'Mitigation' }));
  assert.strictEqual(v.eligible, false);
  assert.ok(v.reasons.includes('Not a Contents job'), v.reasons.join('|'));
  assert.strictEqual(v.placeholder, false);
});

test('flag off and not in the storage status', () => {
  const v = suppEligibility(base({ cf_boolean_1: false, status_name: 'In Progress' }));
  assert.deepStrictEqual(v, { eligible: false, placeholder: false, reasons: ['In Storage is off'] });
});

test('every excluded status is refused, with the status named', () => {
  assert.ok(SUPP_EXCLUDED_STATUSES.includes('attorney'));
  const v = suppEligibility(base({ status_name: 'Attorney' }));
  assert.deepStrictEqual(v.reasons, ['Status excluded: Attorney']);
  for (const s of ['Paid & Closed', 'PB complete', 'Lost', 'Non-Opportunity', 'PB In Progress', 'PB Scheduled']) {
    assert.strictEqual(suppEligibility(base({ status_name: s })).eligible, false, s);
  }
});

test('inactive or archived', () => {
  assert.deepStrictEqual(suppEligibility(base({ is_active: false })).reasons, ['Inactive or archived']);
  assert.deepStrictEqual(suppEligibility(base({ is_archived: true })).reasons, ['Inactive or archived']);
});

test('status last changed on the ignored bulk-edit date (Denver)', () => {
  // 2026-01-03 15:00 Denver = 22:00 UTC
  const secs = Math.floor(Date.UTC(2026, 0, 3, 22, 0, 0) / 1000);
  const v = suppEligibility(base({ date_status_change: secs }));
  assert.strictEqual(v.eligible, false);
  assert.deepStrictEqual(v.reasons, ['Status last changed on 2026-01-03 (bulk edit, ignored)']);
  // 2026-01-04 04:00 UTC is still 2026-01-03 21:00 in Denver
  const late = Math.floor(Date.UTC(2026, 0, 4, 4, 0, 0) / 1000);
  assert.strictEqual(suppEligibility(base({ date_status_change: late })).eligible, false);
  // the next Denver day is fine
  const next = Math.floor(Date.UTC(2026, 0, 4, 12, 0, 0) / 1000);
  assert.strictEqual(suppEligibility(base({ date_status_change: next })).eligible, true);
});

test('several problems list every reason; no placeholder line on an ineligible job', () => {
  const v = suppEligibility(base({ record_type_name: 'Mitigation', is_active: false, cf_double_1: 0, status_name: 'Lost', cf_boolean_1: false }));
  assert.strictEqual(v.eligible, false);
  assert.deepStrictEqual(v.reasons, ['Inactive or archived', 'Not a Contents job', 'In Storage is off', 'Status excluded: Lost']);
  assert.strictEqual(v.placeholder, false);
});

test('display-name keys stand in for dropped cf_ keys; config override for other record types', () => {
  const v = suppEligibility({ record_type_name: 'Contents', status_name: 'In Progress', 'In Storage?': true, 'Supplemental Price': '125.5' });
  assert.deepStrictEqual(v, { eligible: true, placeholder: false, reasons: [] });
  const cfg = { config: { recordTypes: ['contents', 'rebuild'] } };
  assert.strictEqual(suppEligibility(base({ record_type_name: 'Rebuild' }), cfg).eligible, true);
  assert.ok(suppEligibility(base({ record_type_name: 'Testing' }), cfg).reasons.includes('Not a storage-billed job'));
});

test('storageFields: cf_ keys first, display names next, absent keys stay undefined, empties go null', () => {
  assert.deepStrictEqual(storageFields({}), {});
  assert.deepStrictEqual(storageFields({ cf_boolean_1: false, cf_long_1: '3', cf_double_1: '99.999' }),
    { in_storage: false, vaults: 3, monthly_price: 100 });
  assert.deepStrictEqual(storageFields({ 'In Storage?': 'true', '# of Vaults': null, 'Supplemental Price': '' }),
    { in_storage: true, vaults: null, monthly_price: null });
  assert.deepStrictEqual(storageFields({ cf_boolean_1: null, 'In Storage?': true }), { in_storage: null });
});
