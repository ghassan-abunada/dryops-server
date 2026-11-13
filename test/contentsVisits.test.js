// Contents visit reports: the vendored report logic against the fixture shared
// byte for byte with the DryOps app (lib/__tests__/fixtures/contentsReport.json),
// and the submit flow against fake deps. Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const CR = require('../vendor/contents/contentsReport');
const mount = require('../contentsVisits');
const { walkJobPatch, packOutJobPatch, windowLabel } = mount;

const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'contentsReport.json'), 'utf8'));
for (const c of cases) {
  test(`contents report fixture: ${c.name}`, () => {
    assert.deepStrictEqual(CR.contentsReportMissing(c.kind, c.report), c.expected.missing);
    assert.strictEqual(CR.isContentsReportComplete(c.kind, c.report), c.expected.complete);
    assert.strictEqual(CR.summarizeContentsReport(c.kind, c.report), c.expected.summary);
    assert.strictEqual(CR.contentsReportLine(c.kind, c.report), c.expected.line);
    assert.deepStrictEqual(CR.normalizeContentsReport(c.kind, c.report), c.expected.normalized);
  });
}

const WALK = cases.find((c) => c.name === 'initial walk, complete').report;
const PACK_OUT = cases.find((c) => c.name === 'pack out to the warehouse').report;
const PACK_UNIT = cases.find((c) => c.name === 'pack out to a storage unit').report;
const PACK_BACK = cases.find((c) => c.name === 'pack back, everything returned').report;
const PACK_BACK_PART = cases.find((c) => c.name === 'pack back, some left').report;

test('walkJobPatch writes only what the walk learned', () => {
  const job = { insurer: 'State Farm', claim_number: null, adjuster_name: null, insurance_type: null, contents_service: null };
  const p = walkJobPatch(CR.normalizeContentsReport('initial_walk', WALK), job);
  assert.deepStrictEqual(p.local, { contents_service: 'offsite', claim_number: 'CLM-9', adjuster_name: 'Pat Adjuster', adjuster_phone: '2145550199', insurance_type: 'Insurance' });
  assert.deepStrictEqual(p.jn, { cf_string_2: 'CLM-9', cf_string_3: 'Pat Adjuster', cf_string_4: '2145550199', cf_string_7: 'Insurance' });
  // A job that already says everything gets nothing rewritten.
  const same = walkJobPatch(CR.normalizeContentsReport('initial_walk', WALK), { insurer: 'State Farm', claim_number: 'CLM-9', adjuster_name: 'Pat Adjuster', adjuster_phone: '2145550199', insurance_type: 'Insurance', contents_service: 'offsite' });
  assert.deepStrictEqual(same, { local: {}, jn: {} });
});

test('packOutJobPatch sets the storage facts the monthly billing reads', () => {
  const p = packOutJobPatch(CR.normalizeContentsReport('pack_out', PACK_OUT));
  assert.deepStrictEqual(p.local, { in_storage: true, storage_vaults: 3, storage_unit_info: 'Fort Worth warehouse · vaults FTW-001, FTW-002, FTW-003' });
  assert.deepStrictEqual(p.jn, { cf_boolean_1: true, cf_long_1: 3 });
  assert.strictEqual(packOutJobPatch(CR.normalizeContentsReport('pack_out', PACK_UNIT)).local.storage_unit_info, 'CubeSmart Hulen · unit B214 · Gate 4471#');
});

test('windowLabel', () => {
  assert.strictEqual(windowLabel(480, 600), '8am–10am');
  assert.strictEqual(windowLabel(null, null), null);
});

function fake(over = {}) {
  const calls = { patches: [], inserts: [], notes: [], jnPuts: [], synced: [] };
  const visit = { id: 'v1', jn_id: 'jobjn', job_id: 'j1', task_type: 'initial_walk', status: 'scheduled', scheduled_date: '2026-11-13', location_id: 'conA', assigned_to_ids: ['t1', 't2'], ...over.visit };
  const job = { id: 'j1', jn_id: 'jobjn', record_type: 'Contents', location_id: 'conA', insurer: null, claim_number: null, insurance_type: null, contents_service: null, ...over.job };
  const scheduledRows = over.scheduledRows || [];
  const deps = {
    requireAuth: (_q, _s, n) => n && n(),
    appActor: async () => over.actor || { id: 'u1', role: 'owner', name: 'Gus' },
    techGuard: async () => ({ profileId: 't1', name: 'Tess Tech' }),
    loadVisit: async () => (over.noVisit ? null : visit),
    isAssigned: (v, id) => (v.assigned_to_ids || []).includes(id),
    sbGet: async (q) => {
      if (q.startsWith('jobs?id=eq.')) return [job];
      if (q.startsWith('rooms?')) return over.rooms || [];
      if (q.startsWith('inspections?')) return scheduledRows.filter((r) => q.includes(`task_type=eq.${r.task_type}`));
      throw new Error('unexpected sbGet ' + q);
    },
    sbPatch: async (table, filter, patch) => {
      if (over.patchFails && over.patchFails(table, patch)) throw new Error(over.patchError || '400 PGRST204 contents_report');
      calls.patches.push({ table, filter, patch });
      return [{ id: 'v1', ...patch }];
    },
    sbInsert: async (table, row) => {
      if (over.insertFails && over.insertFails(table, row)) throw new Error('409 VS001 double booked');
      calls.inserts.push({ table, row });
      if (table === 'inspections') scheduledRows.push({ id: 'v-new', task_type: row.task_type });
      return null;
    },
    jnSendJson: async (method, p, body) => { calls.jnPuts.push({ method, p, body }); return { ok: true, status: 200 }; },
    jnAddNote: async (id, text, opts) => { calls.notes.push({ id, text, opts }); return { ok: true, id: 'note1' }; },
    visitNoteContext: async () => ({ createdBy: 'jnu', tag: '@CON', jnLocationId: 500 }),
    syncVisitJnTask: async (id) => { calls.synced.push(id); return { ok: true }; },
    warn: () => {},
  };
  const routes = {};
  const app = { post: (p, ...h) => { routes[p] = h[h.length - 1]; } };
  const api = mount(app, deps);
  return { api, calls, routes, visit, job };
}
const ACTOR = { id: 'u1', name: 'Gus' };

test('an initial walk completes the visit, fills the job and books the pack-out', async () => {
  const { api, calls } = fake();
  const out = await api.submitContentsReport({ visitId: 'v1', report: WALK, actor: ACTOR, source: 'app' });
  assert.strictEqual(out.status, 200);
  assert.deepStrictEqual(out.body.warnings, []);
  const done = calls.patches.find((p) => p.table === 'inspections' && p.patch.status === 'completed').patch;
  assert.strictEqual(done.completion_pct, 100);
  assert.strictEqual(done.report_by_name, 'Gus');
  assert.strictEqual(done.contents_report.service, 'offsite');
  assert.deepStrictEqual(done.contents_report.rooms.map((r) => r.name), ['Kitchen', 'Living room', 'Primary bedroom']);
  // Job: service + insurance, here and in JobNimbus.
  const jobPatch = calls.patches.find((p) => p.table === 'jobs').patch;
  assert.deepStrictEqual(jobPatch, { contents_service: 'offsite', insurer: 'State Farm', claim_number: 'CLM-9', adjuster_name: 'Pat Adjuster', adjuster_phone: '2145550199', insurance_type: 'Insurance' });
  assert.deepStrictEqual(calls.jnPuts[0], { method: 'PUT', p: 'jobs/jobjn', body: { record_type_name: 'Contents', cf_string_9: 'State Farm', cf_string_2: 'CLM-9', cf_string_3: 'Pat Adjuster', cf_string_4: '2145550199', cf_string_7: 'Insurance' } });
  // Rooms seeded on a job that had none.
  assert.deepStrictEqual(calls.inserts.filter((i) => i.table === 'rooms').map((i) => i.row.name), ['Kitchen', 'Living room', 'Primary bedroom']);
  // The pack-out is on the schedule with the same technicians.
  const po = calls.inserts.find((i) => i.table === 'inspections').row;
  assert.strictEqual(po.task_type, 'pack_out');
  assert.strictEqual(po.scheduled_date, '2026-11-16');
  assert.strictEqual(po.scheduled_time, '8am–10am');
  assert.deepStrictEqual(po.assigned_to_ids, ['t1', 't2']);
  assert.deepStrictEqual(out.body.scheduled, { id: 'v-new', task_type: 'pack_out', date: '2026-11-16', window: '8am–10am' });
  // One JobNimbus note: the completion line, then the report.
  assert.strictEqual(calls.notes.length, 1);
  assert.ok(calls.notes[0].text.startsWith('Initial Walk complete — Gus\n\nInitial walk report\nService: Offsite storage'));
  assert.deepStrictEqual(calls.notes[0].opts, { createdBy: 'jnu', tag: '@CON', jnLocationId: 500 });
  assert.ok(calls.inserts.some((i) => i.table === 'visit_updates' && i.row.pct === 100 && i.row.source === 'app'));
});

test('an incomplete report is refused with what is missing; a wrong kind and a cancelled visit too', async () => {
  const { api, calls } = fake();
  const out = await api.submitContentsReport({ visitId: 'v1', report: { service: 'offsite' }, actor: ACTOR, source: 'app' });
  assert.strictEqual(out.status, 400);
  assert.strictEqual(out.body.code, 'INVALID_REPORT');
  assert.ok(out.body.missing.includes('Rooms to pack'));
  assert.strictEqual(calls.patches.length, 0);
  assert.strictEqual((await fake({ visit: { task_type: 'monitor' } }).api.submitContentsReport({ visitId: 'v1', report: WALK, actor: ACTOR, source: 'app' })).status, 409);
  assert.strictEqual((await fake({ visit: { status: 'cancelled' } }).api.submitContentsReport({ visitId: 'v1', report: WALK, actor: ACTOR, source: 'app' })).status, 409);
  assert.strictEqual((await fake({ noVisit: true }).api.submitContentsReport({ visitId: 'v1', report: WALK, actor: ACTOR, source: 'app' })).status, 404);
});

test('before the migration the report is refused with the SQL file to run, and nothing else is written', async () => {
  const { api, calls } = fake({ patchFails: (table) => table === 'inspections' });
  const out = await api.submitContentsReport({ visitId: 'v1', report: WALK, actor: ACTOR, source: 'app' });
  assert.strictEqual(out.status, 409);
  assert.strictEqual(out.body.code, 'MIGRATION');
  assert.match(out.body.error, /add_contents_visits\.sql/);
  assert.strictEqual(calls.notes.length, 0);
});

test('a pack-out the schedule refuses still saves the walk, with a warning', async () => {
  const { api } = fake({ insertFails: (table) => table === 'inspections' });
  const out = await api.submitContentsReport({ visitId: 'v1', report: WALK, actor: ACTOR, source: 'app' });
  assert.strictEqual(out.status, 200);
  assert.deepStrictEqual(out.body.warnings, ['PACKOUT_NOT_SCHEDULED']);
  assert.strictEqual(out.body.scheduled.id, null);
  assert.match(out.body.scheduled.error, /double booked/);
});

test('a manipulation walk books a content manipulation, and never a second visit on the same day', async () => {
  const report = { ...WALK, service: 'manipulation' };
  const a = fake();
  const out = await a.api.submitContentsReport({ visitId: 'v1', report, actor: ACTOR, source: 'app' });
  assert.strictEqual(out.body.scheduled.task_type, 'content_manipulation');
  const b = fake({ scheduledRows: [{ id: 'v-old', task_type: 'pack_out' }] });
  const again = await b.api.submitContentsReport({ visitId: 'v1', report: WALK, actor: ACTOR, source: 'app' });
  assert.deepStrictEqual(again.body.scheduled, { id: 'v-old', task_type: 'pack_out', date: '2026-11-16', existing: true });
  assert.ok(!b.calls.inserts.some((i) => i.table === 'inspections'));
});

test('a pack-out puts the job in storage and marks its vaults in use', async () => {
  const { api, calls } = fake({ visit: { task_type: 'pack_out' } });
  const out = await api.submitContentsReport({ visitId: 'v1', report: PACK_OUT, actor: ACTOR, source: 'tech_link' });
  assert.strictEqual(out.status, 200);
  assert.deepStrictEqual(calls.patches.find((p) => p.table === 'jobs').patch, { in_storage: true, storage_vaults: 3, storage_unit_info: 'Fort Worth warehouse · vaults FTW-001, FTW-002, FTW-003' });
  assert.deepStrictEqual(calls.jnPuts[0].body, { record_type_name: 'Contents', cf_boolean_1: true, cf_long_1: 3 });
  const vaults = calls.patches.find((p) => p.table === 'warehouse_vaults');
  assert.strictEqual(vaults.filter, 'id=in.(v1,v2,v3)&warehouse_id=eq.w1');
  assert.strictEqual(vaults.patch.job_id, 'j1');
  assert.ok(calls.notes[0].text.startsWith('Pack Out complete — Gus\n\nPack-out report'));
});

test('a pack-back empties the vaults only when everything came back', async () => {
  const all = fake({ visit: { task_type: 'pack_back' } });
  await all.api.submitContentsReport({ visitId: 'v1', report: PACK_BACK, actor: ACTOR, source: 'app' });
  assert.deepStrictEqual(all.calls.patches.find((p) => p.table === 'warehouse_vaults'), { table: 'warehouse_vaults', filter: 'job_id=eq.j1', patch: { job_id: null, occupied_at: null } });
  assert.deepStrictEqual(all.calls.patches.find((p) => p.table === 'jobs').patch, { in_storage: false, storage_vaults: 0 });
  const part = fake({ visit: { task_type: 'pack_back' } });
  await part.api.submitContentsReport({ visitId: 'v1', report: PACK_BACK_PART, actor: ACTOR, source: 'app' });
  assert.ok(!part.calls.patches.some((p) => p.table === 'warehouse_vaults' || p.table === 'jobs'));
});

test('the signed-in route lets managers and assigned technicians in, nobody else', async () => {
  const run = async (actor) => {
    const f = fake({ actor });
    let status = 200;
    const res = { status(s) { status = s; return this; }, json() {} };
    await f.routes['/visits/:id/contents-report']({ params: { id: 'v1' }, body: { report: WALK } }, res);
    return status;
  };
  assert.strictEqual(await run({ id: 'u1', role: 'owner', name: 'Gus' }), 200);
  assert.strictEqual(await run({ id: 't1', role: 'technician', name: 'Tess' }), 200);
  assert.strictEqual(await run({ id: 'x9', role: 'technician', name: 'Other' }), 403);
});
