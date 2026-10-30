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
