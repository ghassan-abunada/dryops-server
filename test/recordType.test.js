'use strict';
// Job record-type change (recordType.js). Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const mount = require('../recordType');
const { remapStatus, statusBucket, workflowsFromSettings, STATUS_WORKFLOWS } = mount;

// ── remapStatus (pure) ──────────────────────────────────────────────────────
test('a status both workflows list is kept', () => {
  assert.deepStrictEqual(remapStatus('In Progress', 'Mitigation', 'Testing'), { status: 'In Progress', how: 'kept' });
  assert.deepStrictEqual(remapStatus('Lead', 'Testing', 'Contents'), { status: 'Lead', how: 'kept' });
  assert.deepStrictEqual(remapStatus('paid & closed', 'Rebuild', 'Abatements'), { status: 'Paid & Closed', how: 'kept' });
});

test('a status the target lacks lands in the same stage bucket', () => {
  // Mitigation-only statuses → Testing
  assert.deepStrictEqual(remapStatus('Pending Approval', 'Mitigation', 'Testing'), { status: 'Estimate Needed', how: 'bucket' });
  assert.deepStrictEqual(remapStatus('Invoice Created', 'Mitigation', 'Testing'), { status: 'Invoiced', how: 'bucket' });
  assert.deepStrictEqual(remapStatus('Pending Abatement', 'Contents', 'Abatements'), { status: 'Scheduled', how: 'bucket' });
  assert.deepStrictEqual(remapStatus('Work Complete', 'Mitigation', 'Testing'), { status: 'Scheduled', how: 'bucket' });
  // Testing-only statuses → Mitigation
  assert.deepStrictEqual(remapStatus('Estimate Submitted', 'Testing', 'Mitigation'), { status: 'Estimate Needed', how: 'bucket' });
  assert.deepStrictEqual(remapStatus('Missing WO/Claim info', 'Abatements', 'Rebuild'), { status: 'Lead', how: 'bucket' });
  assert.deepStrictEqual(remapStatus('Paid to Lead Source', 'Testing', 'Mitigation'), { status: 'Paid & Closed', how: 'bucket' });
  assert.deepStrictEqual(remapStatus('Denied Per Insurance', 'Testing', 'Contents'), { status: 'Non-Opportunity', how: 'bucket' });
});

test('unknown or empty statuses need a human pick', () => {
  assert.strictEqual(remapStatus('Some Custom Status', 'Mitigation', 'Testing'), null);
  assert.strictEqual(remapStatus('', 'Mitigation', 'Testing'), null);
  assert.strictEqual(remapStatus(null, 'Mitigation', 'Testing'), null);
  assert.strictEqual(remapStatus('Lead', 'Mitigation', 'Nope'), null);
});

test('live workflow lists override the built-in ones', () => {
  const live = { Testing: ['Intake', 'Working', 'Billed'] };
  assert.deepStrictEqual(remapStatus('Working', 'Mitigation', 'Testing', live), { status: 'Working', how: 'kept' });
  // Live list has no status in the Lead bucket → ask.
  assert.strictEqual(remapStatus('Lead', 'Mitigation', 'Testing', live), null);
  // Other types still use the fallback lists.
  assert.deepStrictEqual(remapStatus('Estimate Submitted', 'Testing', 'Mitigation', live), { status: 'Estimate Needed', how: 'bucket' });
});

test('every built-in status has a stage bucket', () => {
  for (const list of Object.values(STATUS_WORKFLOWS)) for (const s of list) assert.ok(statusBucket(s), `${s} has no bucket`);
  assert.strictEqual(statusBucket('Attorney'), 'Account Receivable');
  assert.strictEqual(statusBucket('Whatever'), null);
});

test('workflowsFromSettings keeps active job workflows that carry statuses', () => {
  const s = { workflows: [
    { name: 'Mitigation', object_type: 'job', active: true, statuses: ['Lead', 'Done'] },
    { name: 'Testing', object_type: 'job', active: true, statuses: [] },
    { name: 'Rebuild', object_type: 'job', active: false, statuses: ['Lead'] },
    { name: 'Contents', object_type: 'contact', active: true, statuses: ['Lead'] },
    { name: 'Something Else', object_type: 'job', active: true, statuses: ['Lead'] },
  ] };
  assert.deepStrictEqual(workflowsFromSettings(s), { Mitigation: ['Lead', 'Done'] });
  assert.deepStrictEqual(workflowsFromSettings(null), {});
});

// ── Endpoints with fake deps ────────────────────────────────────────────────
const JOB_ID = '11111111-1111-4111-8111-111111111111';
function setup(over = {}) {
  const routes = {};
  const app = {
    get: (p, ...h) => { routes['GET ' + p] = h[h.length - 1]; },
    post: (p, ...h) => { routes['POST ' + p] = h[h.length - 1]; },
  };
  const state = {
    actor: { id: 'u1', role: 'admin', name: 'Gus Admin', jn_user_id: 'jn-gus', locs: [], perms: {} },
    job: { id: JOB_ID, jn_id: 'JNJOB1', name: 'Smith', number: '1001', record_type: 'Mitigation', status: 'Pending Approval', location_id: 'loc-a',
      locations: { id: 'loc-a', name: 'Denver', record_types: ['Mitigation', 'Testing'], jn_location_id: 7, jn_note_tag: '@DEN' } },
    jnFresh: null, // null = mirror the PUT
    ...over,
  };
  const calls = { put: [], patch: [], notes: [] };
  const deps = {
    requireAuth: (req, res, next) => next(),
    loadActor: async () => state.actor,
    sbGet: async (q) => (q.startsWith('jobs?') ? (state.job ? [state.job] : []) : []),
    sbPatch: async (t, f, p) => { calls.patch.push([t, f, p]); return [{ ...state.job, ...p }]; },
    jnSendJson: async (m, p, b) => { calls.put.push([m, p, b]); return state.jnFail ? { ok: false, status: 400, text: 'no' } : { ok: true, status: 200, body: {} }; },
    jnGetJobFull: async () => state.jnFresh || { record_type_name: calls.put[0][2].record_type_name, status_name: calls.put[0][2].status_name },
    jnAddNote: async (id, text, opts) => { calls.notes.push([id, text, opts]); return { ok: true, id: 'n1' }; },
    jnAccountSettings: state.settings ? async () => state.settings : undefined,
  };
  mount(app, deps);
  const call = async (method, body, query = {}) => {
    let status = 200, json = null;
    const res = { status(s) { status = s; return this; }, json(j) { json = j; return this; } };
    await routes[`${method} /jobs/:id/record-type`]({ params: { id: JOB_ID }, body, query, userId: 'u1' }, res);
    return { status, json };
  };
  return { call, calls, state };
}

test('GET lists the five types with location enablement and a suggested status each', async () => {
  const { call } = setup();
  const r = await call('GET');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json.current, { record_type: 'Mitigation', status: 'Pending Approval' });
  assert.strictEqual(r.json.can_change, true);
  assert.strictEqual(r.json.options.length, 5);
  const t = r.json.options.find((o) => o.record_type === 'Testing');
  assert.strictEqual(t.enabled_at_location, true);
  assert.strictEqual(t.suggested_status, 'Estimate Needed');
  assert.ok(t.statuses.includes('Estimate Submitted'));
  const c = r.json.options.find((o) => o.record_type === 'Contents');
  assert.strictEqual(c.enabled_at_location, false);
  assert.strictEqual(c.suggested_status, 'Pending Approval');
});

test('GET: technicians see can_change false; other locations are refused', async () => {
  const tech = setup({ actor: { id: 't', role: 'technician', name: 'T', locs: ['loc-a'], perms: {} } });
  assert.strictEqual((await tech.call('GET')).json.can_change, false);
  const other = setup({ actor: { id: 't', role: 'technician', name: 'T', locs: ['loc-b'], perms: {} } });
  assert.strictEqual((await other.call('GET')).status, 403);
  const gone = setup({ job: null });
  assert.strictEqual((await gone.call('GET')).status, 404);
});

test('POST: only admins and owners', async () => {
  const { call, calls } = setup({ actor: { id: 'm', role: 'expansion_manager', name: 'M', locs: ['loc-a'], perms: {} } });
  assert.strictEqual((await call('POST', { record_type: 'Testing' })).status, 403);
  assert.strictEqual(calls.put.length, 0);
});

test('POST validates the type and the location enablement (?any=1 for admins)', async () => {
  const { call, calls } = setup();
  assert.strictEqual((await call('POST', { record_type: 'Roofing' })).status, 400);
  assert.strictEqual((await call('POST', { record_type: 'Mitigation' })).status, 400);
  assert.match((await call('POST', { record_type: 'Contents' })).json.error, /Denver does not create Contents jobs/);
  assert.strictEqual(calls.put.length, 0);
  const ok = await call('POST', { record_type: 'Contents' }, { any: '1' });
  assert.strictEqual(ok.status, 200);
  const owner = setup({ actor: { id: 'o', role: 'owner', name: 'O', jn_user_id: null, locs: ['loc-a'], perms: {} } });
  assert.strictEqual((await owner.call('POST', { record_type: 'Contents' }, { any: '1' })).status, 400);
});

test('POST writes JobNimbus first, reads back, patches the row and leaves a note', async () => {
  const { call, calls } = setup();
  const r = await call('POST', { record_type: 'Testing' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json.job, { record_type: 'Testing', status: 'Estimate Needed' });
  assert.strictEqual(r.json.status_how, 'bucket');
  assert.deepStrictEqual(calls.put[0], ['PUT', 'jobs/JNJOB1', { record_type_name: 'Testing', status_name: 'Estimate Needed' }]);
  assert.strictEqual(calls.patch.length, 1);
  assert.strictEqual(calls.patch[0][1], `id=eq.${JOB_ID}`);
  assert.strictEqual(calls.patch[0][2].record_type, 'Testing');
  assert.strictEqual(calls.patch[0][2].status, 'Estimate Needed');
  assert.ok(calls.patch[0][2].last_synced);
  const [noteJob, text, opts] = calls.notes[0];
  assert.strictEqual(noteJob, 'JNJOB1');
  assert.strictEqual(text, 'Job type changed Mitigation → Testing by Gus Admin (status Pending Approval → Estimate Needed)');
  assert.deepStrictEqual(opts, { createdBy: 'jn-gus', tag: '@DEN', jnLocationId: 7 });
});

test('POST honours an explicit status and refuses one outside the target workflow', async () => {
  const { call, calls } = setup();
  assert.strictEqual((await call('POST', { record_type: 'Testing', status: 'Pending Approval' })).status, 400);
  const r = await call('POST', { record_type: 'Testing', status: 'estimate submitted' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(calls.put[0][2].status_name, 'Estimate Submitted');
  assert.strictEqual(r.json.status_how, 'picked');
});

test('POST answers 409 needs_status when nobody can map the status', async () => {
  const s = setup(); s.state.job.status = 'Some Custom Status';
  const r = await s.call('POST', { record_type: 'Testing' });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.needs_status, true);
  assert.ok(Array.isArray(r.json.options) && r.json.options.includes('Lead'));
  assert.strictEqual(s.calls.put.length, 0);
});

test('POST: JobNimbus refusal or a read-back mismatch leaves the row alone (502)', async () => {
  const fail = setup({ jnFail: true });
  assert.strictEqual((await fail.call('POST', { record_type: 'Testing' })).status, 502);
  assert.strictEqual(fail.calls.patch.length, 0);
  const mismatch = setup({ jnFresh: { record_type_name: 'Mitigation', status_name: 'Pending Approval' } });
  assert.strictEqual((await mismatch.call('POST', { record_type: 'Testing' })).status, 502);
  assert.strictEqual(mismatch.calls.patch.length, 0);
  assert.strictEqual(mismatch.calls.notes.length, 0);
});

test('POST uses the live JN workflow statuses when account settings carry them', async () => {
  const settings = { workflows: [{ name: 'Testing', object_type: 'job', active: true, statuses: ['Intake', 'Estimate Needed', 'Billed'] }] };
  const { call, calls } = setup({ settings });
  const g = await call('GET');
  assert.deepStrictEqual(g.json.options.find((o) => o.record_type === 'Testing').statuses, ['Intake', 'Estimate Needed', 'Billed']);
  const r = await call('POST', { record_type: 'Testing' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(calls.put[0][2].status_name, 'Estimate Needed');
});
