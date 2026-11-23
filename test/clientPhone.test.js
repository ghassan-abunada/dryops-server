'use strict';
// JobNimbus parent_mobile_phone / parent_home_phone / parent_work_phone →
// jobs.client_phone (jobSync.clientPhoneCol, used by jnJobFields for the
// webhook, the reconcile and the per-job refresh) and the one-time backfill's
// plan. Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const mountJobSync = require('../jobSync');
const { clientPhoneCol } = mountJobSync;
const { planPhoneBackfill, maskPhone, phoneSource } = require('../scripts/backfillClientPhones');

test('clientPhoneCol: mobile only', () => {
  assert.deepStrictEqual(clientPhoneCol({ parent_mobile_phone: '2145550101', parent_home_phone: '', parent_work_phone: null }), { client_phone: '2145550101' });
});

test('clientPhoneCol: home only (mobile empty or null)', () => {
  assert.deepStrictEqual(clientPhoneCol({ parent_mobile_phone: '', parent_home_phone: '(856) 555-0102' }), { client_phone: '(856) 555-0102' });
  assert.deepStrictEqual(clientPhoneCol({ parent_mobile_phone: null, parent_home_phone: '8565550102', parent_work_phone: '' }), { client_phone: '8565550102' });
});

test('clientPhoneCol: work only', () => {
  assert.deepStrictEqual(clientPhoneCol({ parent_mobile_phone: '', parent_home_phone: null, parent_work_phone: '5035550103' }), { client_phone: '5035550103' });
  assert.deepStrictEqual(clientPhoneCol({ parent_work_phone: '5035550103' }), { client_phone: '5035550103' });
});

test('clientPhoneCol: mobile wins over home and work; home wins over work', () => {
  assert.deepStrictEqual(clientPhoneCol({ parent_mobile_phone: '2145550101', parent_home_phone: '8565550102', parent_work_phone: '5035550103' }), { client_phone: '2145550101' });
  assert.deepStrictEqual(clientPhoneCol({ parent_mobile_phone: '', parent_home_phone: '8565550102', parent_work_phone: '5035550103' }), { client_phone: '8565550102' });
});

test('clientPhoneCol: all empty → no write (a stored phone is never cleared)', () => {
  assert.deepStrictEqual(clientPhoneCol({ parent_mobile_phone: '', parent_home_phone: '', parent_work_phone: '' }), {});
  assert.deepStrictEqual(clientPhoneCol({ parent_mobile_phone: null, parent_home_phone: null, parent_work_phone: null }), {});
  // A box holding no digit is not a phone; the next box is used, or nothing.
  assert.deepStrictEqual(clientPhoneCol({ parent_mobile_phone: '  ', parent_home_phone: 'n/a' }), {});
  assert.deepStrictEqual(clientPhoneCol({ parent_mobile_phone: ' ', parent_home_phone: '8565550102' }), { client_phone: '8565550102' });
});

test('clientPhoneCol: payload without the keys → no write', () => {
  assert.deepStrictEqual(clientPhoneCol({ jnid: 'JN1', name: 'Lauren Wyatt (24 - DAL - MIT)', status_name: 'Lead' }), {});
  assert.deepStrictEqual(clientPhoneCol({}), {});
  assert.deepStrictEqual(clientPhoneCol(null), {});
  assert.deepStrictEqual(clientPhoneCol(undefined), {});
});

test('jnJobFields (server.js) takes the client phone from clientPhoneCol, not from one field', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = src.indexOf('function jnJobFields(job)');
  assert.ok(start > 0, 'jnJobFields exists');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.match(body, /Object\.assign\(row, clientPhoneCol\(job\)\)/);
  assert.doesNotMatch(body, /set\('client_phone'/);
});

// The path the reconcile and "Refresh from JobNimbus" take: a job whose number
// sits in Home phone is patched; a payload with no phone leaves the column out
// of the PATCH body, so PostgREST does not touch it.
test('patchFromJn writes a home-phone job and leaves client_phone out when the payload has none', async () => {
  process.env.JOB_RECONCILE_DISABLED = '1';
  const app = { get() {}, post() {} };
  const requests = [];
  const origFetch = global.fetch;
  global.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => [{ id: 'j1' }], text: async () => '' };
  };
  try {
    const jnJobs = {
      JN1: { jnid: 'JN1', name: 'Home phone job', parent_mobile_phone: '', parent_home_phone: '8565550102' },
      JN2: { jnid: 'JN2', name: 'Keys dropped' },
    };
    const sync = mountJobSync(app, {
      SUPABASE_URL: 'https://sb.example', SUPABASE_SERVICE_KEY: 'k',
      jnGetJobFull: async (id) => jnJobs[id],
      jnFetchUpdatedSince: async () => [],
      // The real jnJobFields merges clientPhoneCol; mirror that here.
      jnJobFields: (job) => ({ name: job.name, ...clientPhoneCol(job) }),
      sbSelect: async () => [],
      requireAuth: (req, res, next) => next(), requireAdmin: (req, res, next) => next(), loadActor: async () => null,
    });
    await sync.refreshJobByJnId('JN1');
    await sync.refreshJobByJnId('JN2');
    const patches = requests.filter((r) => r.init && r.init.method === 'PATCH').map((r) => JSON.parse(r.init.body));
    assert.strictEqual(patches.length, 2);
    assert.strictEqual(patches[0].client_phone, '8565550102');
    assert.ok(!('client_phone' in patches[1]), 'no client_phone key in the PATCH when JobNimbus sent none');
  } finally { global.fetch = origFetch; }
});

test('backfill plan: fills only jobs with no phone, from the first box that has a number', () => {
  const local = [
    { jn_id: 'A', record_type: 'Mitigation' },
    { jn_id: 'B', record_type: 'Mitigation' },
    { jn_id: 'C', record_type: 'Contents' },
    { jn_id: 'D', record_type: 'Mitigation' }, // not in JobNimbus's pull
    { jn_id: null, record_type: 'Mitigation' }, // never mirrored
  ];
  const jn = [
    { jnid: 'A', parent_mobile_phone: '', parent_home_phone: '8565550102', parent_work_phone: '' },
    { jnid: 'A', parent_mobile_phone: '', parent_home_phone: '8565550102' }, // page re-fetch dupe
    { jnid: 'B', parent_mobile_phone: null, parent_home_phone: '', parent_work_phone: '' },
    { jnid: 'C', parent_mobile_phone: null, parent_home_phone: null, parent_work_phone: '5035550103' },
    { jnid: 'X', parent_mobile_phone: '2145550101' }, // already has a phone locally: not in `local`
  ];
  const { fills, stats, sawPhoneKey } = planPhoneBackfill(local, jn);
  assert.deepStrictEqual(fills, [
    { jnid: 'A', client_phone: '8565550102', source: 'parent_home_phone', record_type: 'Mitigation' },
    { jnid: 'C', client_phone: '5035550103', source: 'parent_work_phone', record_type: 'Contents' },
  ]);
  assert.deepStrictEqual(stats, {
    missing: 4, foundInJn: 3, toFill: 2, noPhoneInJn: 1, notInPull: 1,
    bySource: { parent_home_phone: 1, parent_work_phone: 1 }, byType: { Mitigation: 1, Contents: 1 },
  });
  assert.strictEqual(sawPhoneKey, true);
});

test('backfill plan: says when JobNimbus sent no phone field at all', () => {
  const { fills, sawPhoneKey } = planPhoneBackfill([{ jn_id: 'A' }], [{ jnid: 'A', date_created: 1 }]);
  assert.deepStrictEqual(fills, []);
  assert.strictEqual(sawPhoneKey, false);
});

test('maskPhone shows the last four digits only; phoneSource names the box', () => {
  assert.strictEqual(maskPhone('(856) 555-0102'), '(***) ***-0102');
  assert.strictEqual(maskPhone('+18565550102'), '(***) ***-0102');
  assert.strictEqual(maskPhone(''), '(***)');
  assert.strictEqual(phoneSource({ parent_mobile_phone: '', parent_home_phone: '8565550102' }), 'parent_home_phone');
  assert.strictEqual(phoneSource({}), null);
});
