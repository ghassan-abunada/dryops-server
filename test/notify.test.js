// Channel selection (notify.js loadChannels). Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const { loadChannels } = require('../notify');

const channels = [
  { id: 'all', kind: 'telegram', name: 'Company', location_id: null },
  { id: 'loc', kind: 'slack', name: 'Local', location_id: 'L1' },
];
const fakeSb = (type) => async (q) => (q.startsWith('locations?') ? [{ location_type: type }] : channels);

test('a normal location gets its own and company-wide channels', async () => {
  const rows = await loadChannels(fakeSb('Mitigation'), ['job_created'], 'L1');
  assert.deepStrictEqual(rows.map((r) => r.id), ['all', 'loc']);
});

test('a Demo location never reaches company-wide channels', async () => {
  const rows = await loadChannels(fakeSb('Demo'), ['job_created'], 'L1');
  assert.deepStrictEqual(rows.map((r) => r.id), ['loc']);
});

test('no location → company-wide only, no location lookup', async () => {
  let looked = false;
  const sb = async (q) => { if (q.startsWith('locations?')) looked = true; return channels.filter((c) => c.location_id == null); };
  const rows = await loadChannels(sb, ['job_created'], null);
  assert.deepStrictEqual(rows.map((r) => r.id), ['all']);
  assert.strictEqual(looked, false);
});

test('one channel can list several locations', async () => {
  const rows = [
    { id: 'multi', kind: 'telegram', name: 'Two markets', location_id: 'L1', location_ids: ['L1', 'L2'] },
    { id: 'other', kind: 'telegram', name: 'Elsewhere', location_id: 'L3', location_ids: ['L3'] },
    { id: 'all', kind: 'telegram', name: 'Company', location_id: null, location_ids: [] },
  ];
  const sb = async (q) => (q.startsWith('locations?') ? [{ location_type: 'Mitigation' }] : rows);
  assert.deepStrictEqual((await loadChannels(sb, ['job_created'], 'L2')).map((r) => r.id), ['multi', 'all']);
  assert.deepStrictEqual((await loadChannels(sb, ['job_created'], 'L1')).map((r) => r.id), ['multi', 'all']);
  assert.deepStrictEqual((await loadChannels(sb, ['job_created'], null)).map((r) => r.id), ['all']);
});

test('before the location_ids column exists the lookup falls back to location_id', async () => {
  const asked = [];
  const sb = async (q) => {
    if (q.startsWith('locations?')) return [{ location_type: 'Mitigation' }];
    asked.push(q);
    return q.includes('location_ids') ? null : channels;
  };
  const rows = await loadChannels(sb, ['job_created'], 'L1');
  assert.deepStrictEqual(rows.map((r) => r.id), ['all', 'loc']);
  assert.strictEqual(asked.length, 2);
});
