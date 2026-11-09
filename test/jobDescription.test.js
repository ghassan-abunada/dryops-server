'use strict';
// JobNimbus description → jobs.description (jobSync.descriptionCol + the
// refresh select). Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const mountJobSync = require('../jobSync');
const { descriptionCol } = mountJobSync;

test('descriptionCol: absent key leaves the column alone; empty clears; text is trimmed', () => {
  assert.deepStrictEqual(descriptionCol({}), {});
  assert.deepStrictEqual(descriptionCol(null), {});
  assert.deepStrictEqual(descriptionCol({ description: '  Water heater burst, 3 rooms  ' }), { description: 'Water heater burst, 3 rooms' });
  assert.deepStrictEqual(descriptionCol({ description: '' }), { description: null });
  assert.deepStrictEqual(descriptionCol({ description: '   ' }), { description: null });
  assert.deepStrictEqual(descriptionCol({ description: null }), { description: null });
});

test('patchFromJn writes the description and selects it back', async () => {
  process.env.JOB_RECONCILE_DISABLED = '1';
  const app = { get() {}, post() {} };
  const requests = [];
  const origFetch = global.fetch;
  global.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => [{ id: 'j1', description: 'Water heater burst' }], text: async () => '' };
  };
  try {
    const sync = mountJobSync(app, {
      SUPABASE_URL: 'https://sb.example', SUPABASE_SERVICE_KEY: 'k',
      jnGetJobFull: async () => ({ jnid: 'JN1', description: ' Water heater burst ' }),
      jnFetchUpdatedSince: async () => [],
      // The real jnJobFields merges descriptionCol; mirror that here.
      jnJobFields: (job) => ({ name: job.name, ...descriptionCol(job) }),
      sbSelect: async () => [],
      requireAuth: (req, res, next) => next(), requireAdmin: (req, res, next) => next(), loadActor: async () => null,
    });
    const row = await sync.refreshJobByJnId('JN1');
    assert.deepStrictEqual(row, { id: 'j1', description: 'Water heater burst' });
    const patch = requests.find((r) => r.init && r.init.method === 'PATCH');
    assert.ok(patch, 'a PATCH went to Supabase');
    assert.match(patch.url, /\/rest\/v1\/jobs\?jn_id=eq\.JN1/);
    assert.match(patch.url, /select=[^&]*\bdescription\b/);
    assert.strictEqual(JSON.parse(patch.init.body).description, 'Water heater burst');
  } finally { global.fetch = origFetch; }
});
