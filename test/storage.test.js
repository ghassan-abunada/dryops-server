'use strict';
// Storage billing per job (storage.js): GET shape, invoice source
// classification, the PUT role gate and the flag-flip note. Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const mount = require('../storage');
const { suppEligibility } = require('../suppEligibility');

const STORAGE_ITEM = 'mestzfhuma6y3nosvqj9ctt';
const JOB_ID = '2d1f4f3e-6b2a-4c1e-9d7f-0a1b2c3d4e5f';

// The run's helpers, copied from server.js so the module's filter matches.
function suppItemHasStorage(items) {
  return (items || []).some(it => it && (it.jnid === STORAGE_ITEM || /offsite content storage/i.test(it.name || '')));
}
function suppLooksLikeSupplemental(inv, suppPrice) {
  const items = inv.items || [];
  if (items.length !== 1) return false;
  if (suppItemHasStorage(items)) return true;
  return suppPrice > 0 && Math.abs((Number(inv.total) || 0) - suppPrice) < 0.01;
}

const jnJob = (over) => ({
  jnid: 'JN1', name: 'Smith Contents', record_type_name: 'Contents', status_name: 'In storage',
  cf_boolean_1: true, cf_double_1: 250, cf_long_1: 2, is_active: true, is_archived: false,
  date_status_change: 1760000000,
  ...over,
});

// secs for a Denver-safe noon UTC on a date
const secs = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d, 17, 0, 0) / 1000);

const invoices = () => [
  { jnid: 'I1', number: 101, status: 1, date_invoice: secs(2026, 11, 1), total: 250, total_paid: 0, due: 250,
    external_id: 'supp-JN1-2026-11', items: [{ jnid: STORAGE_ITEM, name: 'Contents - Offsite Content Storage' }] },
  { jnid: 'I2', number: 95, status: 4, status_name: 'Closed', date_invoice: secs(2026, 9, 15), total: 500, total_paid: 500, due: 0,
    external_id: 'supp-JN1-catchup-2026-07-2026-08', items: [{ jnid: STORAGE_ITEM }, { jnid: STORAGE_ITEM }] },
  { jnid: 'I3', number: 90, status: 2, date_invoice: secs(2026, 6, 3), total: 250, total_paid: 100, due: 150,
    external_id: '', items: [{ jnid: 'other', name: 'Storage month of June' }] },
  // the mitigation invoice on the same job: not storage
  { jnid: 'I4', number: 80, status: 4, date_invoice: secs(2026, 5, 1), total: 8000, items: [{ jnid: 'x' }, { jnid: 'y' }] },
  // deleted
  { jnid: 'I5', number: 70, status: 1, is_active: false, date_invoice: secs(2026, 4, 1), total: 250, items: [{ jnid: STORAGE_ITEM }] },
];

const runs = () => [
  { month: '2026-11', mode: 'live', report: { created: [{ jnid: 'JN1', total: 250 }], skipped: [], errors: [] } },
  { month: '2026-10', mode: 'dryrun', report: { created: [{ jnid: 'JN1', dryrun: true }], skipped: [], errors: [] } },
  { month: '2026-10', mode: 'reminder-7d', report: { notifications: [] } },
  { month: '2026-09', mode: 'live', report: { created: [], skipped: [{ jnid: 'JN1', reason: 'already billed this month (manual)' }], errors: [] } },
  { month: '2026-08', mode: 'live', report: { created: [], skipped: [], errors: [{ jnid: 'JN1', error: 'invoice create 500' }] } },
  { month: '2026-07', mode: 'live', report: { created: [{ jnid: 'OTHER' }], skipped: [], errors: [] } },
];

function setup(state = {}) {
  const routes = {};
  const app = {
    get: (p, mw, h) => { routes[`GET ${p}`] = h; },
    put: (p, mw, h) => { routes[`PUT ${p}`] = h; },
  };
  const calls = { jn: [], patches: [], notes: [] };
  const jnSeq = state.jnSeq || [jnJob()];
  let jnIdx = 0;
  const deps = {
    sbGet: async (q) => {
      if (q.startsWith('jobs?')) return state.job === null ? [] : [state.job || { id: JOB_ID, jn_id: 'JN1', name: 'Smith Contents', number: '1234', record_type: 'Contents', status: 'In storage', location_id: 'loc-a', locations: { jn_location_id: 7, jn_note_tag: '@GTA' } }];
      if (q.startsWith('supplemental_billing_runs')) return state.runs || runs();
      return [];
    },
    sbPatch: async (t, f, p) => { if (state.patchError) throw new Error(state.patchError); calls.patches.push([t, f, p]); return [p]; },
    jnSendJson: async (method, path, body) => {
      calls.jn.push([method, path, body]);
      if (method === 'GET') return { ok: true, status: 200, body: { results: state.invoices || invoices() } };
      if (state.jnPutFails) return { ok: false, status: 400, text: 'nope' };
      return { ok: true, status: 200, body: {} };
    },
    jnGetJobFull: async () => { const j = jnSeq[Math.min(jnIdx, jnSeq.length - 1)]; jnIdx++; if (j instanceof Error) throw j; return j; },
    jnAddNote: async (jnid, text, opts) => { calls.notes.push([jnid, text, opts]); return { ok: true, id: 'n1' }; },
    requireAuth: (req, res, next) => next(),
    loadActor: async () => state.actor === null ? null : (state.actor || { id: 'u1', role: 'admin', name: 'Gus Admin', jn_user_id: 'jnu1', locs: [], perms: {} }),
    suppEligibility,
    suppLooksLikeSupplemental,
    suppItemHasStorage,
    denverNextFirst: () => ({ monthKey: '2026-12', monthLabel: 'December 2026', daysUntil: 22 }),
    config: { SUPP_BILLING_LIVE: state.live !== false, SUPP_BILLING_DAY: 1, SUPP_STORAGE_ITEM_JNID: STORAGE_ITEM },
    jnInvoicesUrl: (jnid) => `v2/invoices?size=100&related=${jnid}`,
    jobInvoicesPageUrl: (jnid) => `https://app.jobnimbus.com/job/${jnid}/payments-and-invoices`,
  };
  mount(app, deps);
  const call = async (method, body) => {
    let status = 200, json = null;
    const res = { status(s) { status = s; return this; }, json(j) { json = j; return this; } };
    await routes[`${method} /jobs/:id/storage`]({ params: { id: state.id || JOB_ID }, body, userId: 'u1' }, res);
    return { status, json };
  };
  return { call, calls };
}

test('GET: the full shape for an in-storage Contents job', async () => {
  const { call, calls } = setup();
  const { status, json } = await call('GET');
  assert.strictEqual(status, 200);
  assert.strictEqual(json.record_type, 'Contents');
  assert.strictEqual(json.status, 'In storage');
  assert.strictEqual(json.in_storage, true);
  assert.strictEqual(json.vaults, 2);
  assert.strictEqual(json.monthly_price, 250);
  assert.deepStrictEqual(json.eligibility, { eligible: true, placeholder: false, reasons: [] });
  assert.deepStrictEqual(json.billing, { mode: 'live', next_run: '2026-12-01', day: 1 });
  assert.strictEqual(json.can_edit, true);
  assert.strictEqual(json.last_storage_invoice, '2026-11-01');
  // invoices: storage ones only, newest first, deleted and the mitigation invoice dropped
  assert.deepStrictEqual(json.invoices.map((i) => i.jnid), ['I1', 'I2', 'I3']);
  const [i1, i2, i3] = json.invoices;
  assert.deepStrictEqual(i1, {
    jnid: 'I1', number: 101, status: 1, status_name: 'Draft', date_invoice: '2026-11-01', total: 250, total_paid: 0, due: 250,
    month: '2026-11', source: 'auto', external_id: 'supp-JN1-2026-11', jn_url: 'https://app.jobnimbus.com/job/JN1/payments-and-invoices',
  });
  assert.strictEqual(i2.source, 'catchup');
  assert.strictEqual(i2.status_name, 'Closed');
  assert.strictEqual(i2.month, '2026-09'); // no single month in the id → the invoice date
  assert.strictEqual(i3.source, 'manual');
  assert.strictEqual(i3.status_name, 'Sent');
  assert.strictEqual(i3.month, '2026-06');
  // runs: this job's outcome per run, reminder runs and other jobs skipped
  assert.deepStrictEqual(json.runs, [
    { month: '2026-11', mode: 'live', outcome: 'created', reason: 'Draft created' },
    { month: '2026-10', mode: 'dryrun', outcome: 'created', reason: 'Dry run — would be created' },
    { month: '2026-09', mode: 'live', outcome: 'skipped', reason: 'already billed this month (manual)' },
    { month: '2026-08', mode: 'live', outcome: 'error', reason: 'invoice create 500' },
  ]);
  // JN was read once and the invoices once; nothing written
  assert.deepStrictEqual(calls.jn.map((c) => c[0]), ['GET']);
  assert.strictEqual(calls.patches.length, 0);
});

test('GET: an ineligible job explains itself; technicians see can_edit false; dryrun mode', async () => {
  const { call } = setup({
    live: false,
    jnSeq: [jnJob({ status_name: 'Attorney', cf_double_1: 0 })],
    actor: { id: 't', role: 'technician', name: 'Tech', locs: ['loc-a'], perms: {} },
  });
  const { status, json } = await call('GET');
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(json.eligibility, { eligible: false, placeholder: false, reasons: ['Status excluded: Attorney'] });
  assert.strictEqual(json.can_edit, false);
  assert.strictEqual(json.billing.mode, 'dryrun');
  assert.strictEqual(json.monthly_price, 0);
});

test('GET: location scope — a technician elsewhere is refused; bad id / missing job', async () => {
  assert.strictEqual((await setup({ actor: { id: 't', role: 'technician', name: 'T', locs: ['loc-b'], perms: {} } }).call('GET')).status, 403);
  assert.strictEqual((await setup({ id: 'nope' }).call('GET')).status, 400);
  assert.strictEqual((await setup({ job: null }).call('GET')).status, 404);
  assert.strictEqual((await setup({ actor: null }).call('GET')).status, 403);
});

test('GET: a job with no JobNimbus id answers with nulls and a reason', async () => {
  const { call, calls } = setup({ job: { id: JOB_ID, jn_id: null, record_type: 'Contents', status: 'Lead', location_id: 'loc-a' } });
  const { status, json } = await call('GET');
  assert.strictEqual(status, 200);
  assert.strictEqual(json.in_storage, null);
  assert.deepStrictEqual(json.eligibility.reasons, ['Not in JobNimbus']);
  assert.deepStrictEqual(json.invoices, []);
  assert.deepStrictEqual(json.runs, []);
  assert.strictEqual(calls.jn.length, 0);
});

test('PUT: only admins and owners; expansion managers in scope are refused', async () => {
  const mgr = setup({ actor: { id: 'm', role: 'expansion_manager', name: 'Mgr', locs: ['loc-a'], perms: { edit_job_fields: true } } });
  const r = await mgr.call('PUT', { in_storage: false });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(mgr.calls.jn.length, 0);
  const owner = setup({ actor: { id: 'o', role: 'owner', name: 'Own', locs: [], perms: {} }, jnSeq: [jnJob(), jnJob({ cf_long_1: 3 })] });
  assert.strictEqual((await owner.call('PUT', { vaults: 3 })).status, 200);
});

test('PUT: bad types are 400 before JobNimbus is touched', async () => {
  const { call, calls } = setup();
  assert.strictEqual((await call('PUT', { in_storage: 'yes' })).status, 400);
  assert.strictEqual((await call('PUT', { vaults: 1.5 })).status, 400);
  assert.strictEqual((await call('PUT', { vaults: -1 })).status, 400);
  assert.strictEqual((await call('PUT', { monthly_price: 'abc' })).status, 400);
  assert.strictEqual((await call('PUT', {})).status, 400);
  assert.strictEqual(calls.jn.length, 0);
  assert.strictEqual(calls.patches.length, 0);
});

test('PUT: flag flip → JN first, read back, local mirror, one note', async () => {
  const { call, calls } = setup({ jnSeq: [jnJob({ cf_boolean_1: true }), jnJob({ cf_boolean_1: false })] });
  const { status, json } = await call('PUT', { in_storage: false });
  assert.strictEqual(status, 200);
  const put = calls.jn.find((c) => c[0] === 'PUT');
  assert.deepStrictEqual(put, ['PUT', 'jobs/JN1', { record_type_name: 'Contents', cf_boolean_1: false }]);
  assert.strictEqual(calls.patches.length, 1);
  const [table, filter, patch] = calls.patches[0];
  assert.strictEqual(table, 'jobs');
  assert.strictEqual(filter, `id=eq.${JOB_ID}`);
  assert.strictEqual(patch.in_storage, false);
  assert.strictEqual(patch.storage_vaults, 2);
  assert.strictEqual(patch.storage_monthly_price, 250);
  assert.ok(patch.last_synced);
  assert.strictEqual(calls.notes.length, 1);
  assert.strictEqual(calls.notes[0][0], 'JN1');
  assert.strictEqual(calls.notes[0][1], 'In Storage turned off by Gus Admin — DryOps');
  assert.deepStrictEqual(calls.notes[0][2], { createdBy: 'jnu1', tag: '@GTA', jnLocationId: 7 });
  assert.strictEqual(json.note_ok, true);
  // the answer is the fresh snapshot
  assert.strictEqual(json.in_storage, false);
  assert.deepStrictEqual(json.eligibility.reasons, []); // status "In storage" still bills it
});

test('PUT: price / vault edits without a flip write JN and the row but post no note', async () => {
  const { call, calls } = setup({ jnSeq: [jnJob(), jnJob({ cf_double_1: 300, cf_long_1: 3 })] });
  const { status, json } = await call('PUT', { monthly_price: 300.004, vaults: 3 });
  assert.strictEqual(status, 200);
  const put = calls.jn.find((c) => c[0] === 'PUT');
  assert.deepStrictEqual(put[2], { record_type_name: 'Contents', cf_long_1: 3, cf_double_1: 300 });
  assert.strictEqual(calls.notes.length, 0);
  assert.strictEqual(json.monthly_price, 300);
  assert.strictEqual(json.vaults, 3);
  assert.strictEqual(json.note_ok, undefined);
  // setting the flag to what it already is: no note either
  const same = setup({ jnSeq: [jnJob(), jnJob()] });
  assert.strictEqual((await same.call('PUT', { in_storage: true })).status, 200);
  assert.strictEqual(same.calls.notes.length, 0);
});

test('PUT: null clears price and vaults (0 in JobNimbus, null locally)', async () => {
  const { call, calls } = setup({ jnSeq: [jnJob(), jnJob({ cf_double_1: 0, cf_long_1: 0 })] });
  const { status, json } = await call('PUT', { monthly_price: null, vaults: null });
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(calls.jn.find((c) => c[0] === 'PUT')[2], { record_type_name: 'Contents', cf_long_1: 0, cf_double_1: 0 });
  assert.deepStrictEqual(json.eligibility, { eligible: true, placeholder: true, reasons: ['No price yet — $0 placeholder'] });
});

test('PUT: JobNimbus refusing or not taking the flag → 502, row untouched', async () => {
  const refused = setup({ jnPutFails: true });
  assert.strictEqual((await refused.call('PUT', { in_storage: false })).status, 502);
  assert.strictEqual(refused.calls.patches.length, 0);
  const ignored = setup({ jnSeq: [jnJob({ cf_boolean_1: true }), jnJob({ cf_boolean_1: true })] });
  assert.strictEqual((await ignored.call('PUT', { in_storage: false })).status, 502);
  assert.strictEqual(ignored.calls.patches.length, 0);
  assert.strictEqual(ignored.calls.notes.length, 0);
});

test('PUT: missing storage columns give a plain message', async () => {
  const { call } = setup({ jnSeq: [jnJob(), jnJob({ cf_boolean_1: false })], patchError: "400 Could not find the 'in_storage' column of 'jobs' in the schema cache" });
  const r = await call('PUT', { in_storage: false });
  assert.strictEqual(r.status, 500);
  assert.match(r.json.error, /add_job_storage\.sql/);
});

test('storageCols mirrors the three fields for jnJobFields; absent keys leave columns alone', () => {
  assert.deepStrictEqual(mount.storageCols({ name: 'x' }), {});
  assert.deepStrictEqual(mount.storageCols({ cf_boolean_1: false, cf_long_1: 2, cf_double_1: 250 }),
    { in_storage: false, storage_vaults: 2, storage_monthly_price: 250 });
  assert.deepStrictEqual(mount.storageCols({ 'In Storage?': true, '# of Vaults': '', 'Supplemental Price': null }),
    { in_storage: true, storage_vaults: null, storage_monthly_price: null });
});

test('invoice source and month classification', () => {
  assert.strictEqual(mount.invoiceSource('supp-JN1-2026-11'), 'auto');
  assert.strictEqual(mount.invoiceSource('supp-JN1-catchup-2026-07-2026-08'), 'catchup');
  assert.strictEqual(mount.invoiceSource('catchup-JN1-2026-07'), 'catchup');
  assert.strictEqual(mount.invoiceSource(''), 'manual');
  assert.strictEqual(mount.invoiceSource(undefined), 'manual');
  assert.strictEqual(mount.invoiceSource('xact-1234'), 'manual');
  assert.strictEqual(mount.invoiceMonth({ external_id: 'supp-JN1-2026-03' }), '2026-03');
  assert.strictEqual(mount.invoiceMonth({ external_id: '', date_invoice: secs(2026, 2, 1) }), '2026-02');
  assert.strictEqual(mount.invoiceMonth({ external_id: '' }), null);
});
