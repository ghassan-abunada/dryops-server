// Work orders: partner resolution (fixture shared byte for byte with the
// DryOps app, lib/__tests__/fixtures/partnerResolve.json), the intake body
// built for the referred job, and the order flow against fake deps.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const mount = require('../workOrders');
const { resolvePartners, splitAddress, nameParts, canOrder, companyTypeFor, intakeBodyFor, sourceNoteText, requestNoteText } = mount;

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'partnerResolve.json'), 'utf8'));
for (const c of fixture.cases) {
  test(`partner fixture: ${c.name}`, () => {
    assert.deepStrictEqual(resolvePartners(c.service, c.source, c.referrers, fixture.partners), c.expected);
  });
}

test('splitAddress reads the one-line address the app stores', () => {
  assert.deepStrictEqual(splitAddress('123 Main St, Dallas, Texas, 75232'), { street: '123 Main St', city: 'Dallas', state: 'Texas', zip: '75232' });
  assert.deepStrictEqual(splitAddress('500 W 7th St, Suite 200, Fort Worth, TX, 76102'), { street: '500 W 7th St, Suite 200', city: 'Fort Worth', state: 'TX', zip: '76102' });
  assert.deepStrictEqual(splitAddress('9 Elm St, Plano, TX 75024'), { street: '9 Elm St', city: 'Plano', state: 'TX', zip: '75024' });
  assert.deepStrictEqual(splitAddress('9 Elm St'), { street: '9 Elm St', city: '', state: '', zip: '' });
});

test('nameParts drops the JobNimbus suffix', () => {
  assert.deepStrictEqual(nameParts('Lauren Wyatt (24 - DAL - MIT)', null), { first: 'Lauren', last: 'Wyatt' });
  assert.deepStrictEqual(nameParts(null, 'Cher'), { first: 'Cher', last: '' });
  assert.deepStrictEqual(nameParts('', ''), { first: 'Customer', last: '' });
});

test('canOrder: admins anywhere, owners and managers at their locations, custom roles by permission', () => {
  assert.strictEqual(canOrder({ role: 'admin', locs: [] }, 'L1'), true);
  assert.strictEqual(canOrder({ role: 'owner', locs: ['L1'], perms: {} }, 'L1'), true);
  assert.strictEqual(canOrder({ role: 'owner', locs: ['L2'], perms: {} }, 'L1'), false);
  assert.strictEqual(canOrder({ role: 'expansion_manager', locs: ['L1'], perms: {} }, 'L1'), true);
  assert.strictEqual(canOrder({ role: 'technician', locs: ['L1'], perms: {} }, 'L1'), false);
  assert.strictEqual(canOrder({ role: 'technician', locs: ['L1'], perms: { create_work_orders: true } }, 'L1'), true);
  assert.strictEqual(canOrder({ role: 'owner', locs: ['L1'], perms: { create_work_orders: false } }, 'L1'), false);
  assert.strictEqual(canOrder(null, 'L1'), false);
});

test('companyTypeFor', () => {
  assert.strictEqual(companyTypeFor('Mitigation'), 'Mitigation');
  assert.strictEqual(companyTypeFor('Rebuild'), 'Rebuild');
  assert.strictEqual(companyTypeFor('Contents'), 'Other');
});

const SRC = {
  id: '11111111-1111-4111-8111-111111111111', jn_id: 'srcjn', name: 'Lauren Wyatt (24 - DAL - MIT)', client_name: 'Lauren Wyatt (24)', client_phone: '2145550100',
  jn_contact_id: 'contactjn', address: '123 Main St, Dallas, Texas, 75232', lat: 32.7, lng: -96.8, location_id: 'mitA', jn_location_id: 322,
  record_type: 'Mitigation', property_type: 'residential', insurance_type: 'Insurance', claim_number: 'CLM-9', insurer: 'State Farm',
  adjuster_name: 'Pat Adjuster', adjuster_phone: '2145550199', adjuster_email: 'pat@example.com', cat: 'CAT 2', date_loss: '2026-11-01', referring_job_id: null,
};

test('intakeBodyFor: a packout copies the claim, links the contact and names the service', () => {
  const b = intakeBodyFor({ rid: 'r1', service: 'contents', kind: 'packout', src: SRC, targetLocationId: 'conA', leadCompanyId: 'lead1', note: 'Kitchen and living room', sourceLocationName: 'A1 Dallas' });
  assert.strictEqual(b.record_type, 'Contents');
  assert.strictEqual(b.location_id, 'conA');
  assert.strictEqual(b.link_contact_jn_id, 'contactjn');
  assert.deepStrictEqual(b.contact, {});
  assert.deepStrictEqual(b.address, { street: '123 Main St', city: 'Dallas', state: 'Texas', zip: '75232', lat: 32.7, lng: -96.8 });
  assert.deepStrictEqual(b.lead, { lead_source_company_id: 'lead1', lead_type: 'Internal Referral' });
  assert.strictEqual(b.referring_job_id, SRC.id);
  assert.strictEqual(b.details.claim_number, 'CLM-9');
  assert.strictEqual(b.details.insurer, 'State Farm');
  assert.strictEqual(b.details.insurance_type, 'Insurance');
  assert.strictEqual(b.details.date_loss, '2026-11-01');
  assert.deepStrictEqual(b.details.services, ['Packout']);
  assert.strictEqual(b.details.notes, 'Kitchen and living room');
});

test('intakeBodyFor: rebuild gets a scope line, testing its test types, a job with no contact its name', () => {
  const reb = intakeBodyFor({ rid: 'r2', service: 'rebuild', kind: null, src: SRC, targetLocationId: 'reb', leadCompanyId: 'l', note: '', sourceLocationName: 'A1 Dallas' });
  assert.strictEqual(reb.record_type, 'Rebuild');
  assert.match(reb.details.scope_summary, /Rebuild requested by A1 Dallas from Lauren Wyatt/);
  const tst = intakeBodyFor({ rid: 'r3', service: 'testing', kind: null, src: SRC, targetLocationId: 't', leadCompanyId: 'l', note: '', testTypes: ['Asbestos', 'asbestos', 'Lead'] });
  assert.deepStrictEqual(tst.details.test_types, ['Asbestos', 'Lead']);
  const bare = intakeBodyFor({ rid: 'r4', service: 'contents', kind: 'packback', src: { ...SRC, jn_contact_id: null, insurance_type: 'OOP' }, targetLocationId: 'c', leadCompanyId: 'l', note: '' });
  assert.strictEqual(bare.link_contact_jn_id, undefined);
  assert.deepStrictEqual(bare.contact, { first_name: 'Lauren', last_name: 'Wyatt', phone: '2145550100' });
  assert.strictEqual(bare.details.insurance_type, 'Non-Insurance');
  assert.deepStrictEqual(bare.details.services, ['Pack-back']);
});

test('note texts', () => {
  assert.strictEqual(
    sourceNoteText({ service: 'contents', kind: 'packout', jobName: 'Lauren Wyatt (FTW - CON)', jobJnId: 'newjn', targetName: 'FTW Contents', actorName: 'Gus', note: 'Kitchen', created: true }),
    'Packout ordered from FTW Contents: Lauren Wyatt (FTW - CON) (https://app.jobnimbus.com/job/newjn).\nNote: Kitchen\nOrdered by Gus in DryOps.');
  assert.strictEqual(
    requestNoteText({ kind: 'packback', sourceJobName: 'Lauren Wyatt (DAL - REB)', sourceLocationName: 'Dallas Rebuild', actorName: 'Gus', note: '' }),
    'Pack-back requested by Dallas Rebuild (Lauren Wyatt (DAL - REB)).\nOrdered by Gus in DryOps.');
});

// ── The flow against fake deps ──
const LOCS = {
  mitA: { id: 'mitA', name: 'A1 Dallas', location_type: 'Mitigation', jn_location_id: 322, jn_note_tag: '@DAL', record_types: ['Mitigation'], status: 'active' },
  conA: { id: 'conA', name: 'FTW Contents', location_type: 'Contents', jn_location_id: 500, jn_note_tag: '@CON', record_types: ['Contents'], status: 'active' },
  reb: { id: 'reb', name: 'Dallas Rebuild', location_type: 'Rebuild', jn_location_id: 600, jn_note_tag: null, record_types: ['Rebuild'], status: 'active' },
  ats: { id: 'ats', name: 'Abatement Testing Services', location_type: 'Testing', jn_location_id: 198, jn_note_tag: null, record_types: ['Testing'], status: 'active' },
};
function fake(over = {}) {
  const calls = { intake: [], notes: [], inserts: [], notified: [] };
  const jobs = over.jobs || [SRC];
  const partners = over.partners || [{ location_id: 'mitA', service: 'contents', partner_location_id: 'conA', is_default: true }];
  const leadRows = over.leadRows || [];
  const sbGet = async (q) => {
    if (q.startsWith('jobs?id=eq.')) { const id = decodeURIComponent(q.split('id=eq.')[1].split('&')[0]); return jobs.filter((j) => j.id === id); }
    if (q.startsWith('jobs?referring_job_id=eq.')) { const id = decodeURIComponent(q.split('referring_job_id=eq.')[1].split('&')[0]); return jobs.filter((j) => j.referring_job_id === id && j.record_type === 'Contents'); }
    if (q.startsWith('locations?id=eq.')) { const id = decodeURIComponent(q.split('id=eq.')[1].split('&')[0]); return LOCS[id] ? [LOCS[id]] : []; }
    if (q.startsWith('locations?jn_location_id=eq.')) { const n = Number(q.split('jn_location_id=eq.')[1].split('&')[0]); return Object.values(LOCS).filter((l) => l.jn_location_id === n); }
    if (q.startsWith('location_partners?')) return partners;
    if (q.startsWith('lead_source_companies?')) return leadRows;
    if (q.startsWith('work_orders?')) return [{ id: 'wo1' }];
    throw new Error('unexpected sbGet ' + q);
  };
  const deps = {
    requireAuth: (_req, _res, next) => next && next(),
    loadActor: async () => over.actor || { id: 'u1', role: 'owner', name: 'Gus', jn_user_id: 'jnu', locs: ['mitA'], perms: {} },
    createIntakeJob: async (body, actor, opts) => { calls.intake.push({ body, actor, opts }); return { ok: true, job: { id: 'newjob', jn_id: 'newjn', name: 'Lauren Wyatt (FTW - CON)', jn_url: 'https://app.jobnimbus.com/job/newjn' }, warnings: [] }; },
    jnAccountSettings: async () => ({ sources: [{ id: 554, name: 'A1 Dallas', active: true }] }),
    sbGet,
    sbInsert: async (table, row) => { calls.inserts.push({ table, row }); if (table === 'lead_source_companies') { leadRows.push({ id: 'lead-new', jn_source_id: row.jn_source_id }); return { id: 'lead-new' }; } return null; },
    jnAddNote: async (id, text, opts) => { calls.notes.push({ id, text, opts }); return { ok: true }; },
    notifyChannels: async (m) => { calls.notified.push(m); return 1; },
    log: () => {}, warn: () => {},
    ...over.deps,
  };
  const routes = {};
  const app = { post: (p, ...h) => { routes[p] = h[h.length - 1]; } };
  const api = mount(app, deps);
  return { api, calls, routes, deps };
}
const ACTOR = { id: 'u1', role: 'owner', name: 'Gus', jn_user_id: 'jnu', locs: ['mitA'], perms: {} };

test('a packout creates the Contents job at the partner, with the referring location as lead source', async () => {
  const { api, calls } = fake();
  const out = await api.createWorkOrder(SRC.id, { service: 'contents', kind: 'packout', note: 'Kitchen', client_request_id: '22222222-2222-4222-8222-222222222222' }, ACTOR);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.created, true);
  assert.deepStrictEqual(out.target, { id: 'conA', name: 'FTW Contents' });
  assert.strictEqual(out.job.jn_id, 'newjn');
  assert.strictEqual(out.work_order_id, 'wo1');
  assert.deepStrictEqual(out.warnings, []);
  // The lead source row is made on first use, mapped to the JobNimbus source of the same name.
  const lead = calls.inserts.find((i) => i.table === 'lead_source_companies').row;
  assert.deepStrictEqual(lead, { location_id: 'conA', name: 'A1 Dallas', company_type: 'Mitigation', lead_type: 'Internal Referral', is_internal: true, internal_location_id: 'mitA', jn_source_id: 554, jn_source_name: 'A1 Dallas' });
  const { body, opts } = calls.intake[0];
  assert.strictEqual(body.client_request_id, '22222222-2222-4222-8222-222222222222');
  assert.strictEqual(body.location_id, 'conA');
  assert.strictEqual(body.lead.lead_source_company_id, 'lead-new');
  assert.deepStrictEqual(opts, { system: true, source: 'work_order' });
  // A note on the job the order came from, in its own location's feed.
  assert.strictEqual(calls.notes.length, 1);
  assert.strictEqual(calls.notes[0].id, 'srcjn');
  assert.match(calls.notes[0].text, /^Packout ordered from FTW Contents: Lauren Wyatt \(FTW - CON\)/);
  assert.deepStrictEqual(calls.notes[0].opts, { jnLocationId: 322, tag: '@DAL', createdBy: 'jnu' });
  const wo = calls.inserts.find((i) => i.table === 'work_orders').row;
  assert.strictEqual(wo.status, 'created');
  assert.strictEqual(wo.target_job_id, 'newjob');
  assert.strictEqual(wo.kind, 'packout');
});

test('an existing lead source row is reused; an unmapped one warns', async () => {
  const { api, calls } = fake({ leadRows: [{ id: 'lead-old', jn_source_id: null }] });
  const out = await api.createWorkOrder(SRC.id, { service: 'contents' }, ACTOR);
  assert.strictEqual(calls.intake[0].body.lead.lead_source_company_id, 'lead-old');
  assert.ok(!calls.inserts.some((i) => i.table === 'lead_source_companies'));
  assert.deepStrictEqual(out.warnings, ['NO_JN_SOURCE']);
});

test('no partner set: a clear error, except testing which falls back to the automation rule', async () => {
  const { api } = fake({ partners: [] });
  await assert.rejects(() => api.createWorkOrder(SRC.id, { service: 'contents' }, ACTOR), (e) => e.status === 400 && e.code === 'NO_PARTNER' && /A1 Dallas has no packout partner yet/.test(e.message));
  const t = fake({ partners: [] });
  const out = await t.api.createWorkOrder(SRC.id, { service: 'testing', test_types: ['Asbestos'] }, ACTOR);
  assert.deepStrictEqual(out.target, { id: 'ats', name: 'Abatement Testing Services' });
  assert.ok(out.warnings.includes('TESTING_DEFAULT_LOCATION'));
  await assert.rejects(() => t.api.createWorkOrder(SRC.id, { service: 'testing' }, ACTOR), (e) => e.status === 400 && /type of testing/.test(e.message));
});

test('permissions and guards', async () => {
  const { api } = fake();
  await assert.rejects(() => api.createWorkOrder(SRC.id, { service: 'contents' }, { ...ACTOR, locs: ['other'] }), (e) => e.status === 403);
  await assert.rejects(() => api.createWorkOrder(SRC.id, { service: 'nope' }, ACTOR), (e) => e.status === 400);
  await assert.rejects(() => api.createWorkOrder('33333333-3333-4333-8333-333333333333', { service: 'contents' }, ACTOR), (e) => e.status === 404);
  await assert.rejects(() => api.createWorkOrder(SRC.id, { service: 'contents', partner_location_id: 'reb' }, ACTOR), (e) => e.status === 400 && /not a partner/.test(e.message));
  const noAddr = fake({ jobs: [{ ...SRC, address: '' }] });
  await assert.rejects(() => noAddr.api.createWorkOrder(SRC.id, { service: 'contents' }, ACTOR), (e) => e.status === 400 && /address/.test(e.message));
  // The partner must take that record type.
  const wrong = fake({ partners: [{ location_id: 'mitA', service: 'contents', partner_location_id: 'reb', is_default: true }] });
  await assert.rejects(() => wrong.api.createWorkOrder(SRC.id, { service: 'contents' }, ACTOR), (e) => e.status === 400 && /not set up to take Contents jobs/.test(e.message));
});

test('a pack-back on a job whose Contents job exists posts the request there and creates nothing', async () => {
  const CON = { id: '44444444-4444-4444-8444-444444444444', jn_id: 'conjn', name: 'Lauren Wyatt (FTW - CON)', status: 'In storage', record_type: 'Contents', location_id: 'conA', jn_location_id: 500, referring_job_id: SRC.id };
  const { api, calls } = fake({ jobs: [SRC, CON] });
  const out = await api.createWorkOrder(SRC.id, { service: 'contents', kind: 'packback', note: 'Rebuild done Friday' }, ACTOR);
  assert.strictEqual(out.created, false);
  assert.strictEqual(out.job.id, CON.id);
  assert.strictEqual(calls.intake.length, 0);
  assert.strictEqual(calls.notes.length, 2);
  assert.strictEqual(calls.notes[0].id, 'conjn');
  assert.strictEqual(calls.notes[0].text, 'Pack-back requested by A1 Dallas (Lauren Wyatt (24 - DAL - MIT)).\nNote: Rebuild done Friday\nOrdered by Gus in DryOps.');
  assert.deepStrictEqual(calls.notes[0].opts, { jnLocationId: 500, tag: '@CON', createdBy: 'jnu' });
  assert.match(calls.notes[1].text, /^Pack-back requested from FTW Contents on Lauren Wyatt \(FTW - CON\)/);
  const wo = calls.inserts.find((i) => i.table === 'work_orders').row;
  assert.strictEqual(wo.status, 'requested');
  assert.strictEqual(wo.target_job_id, CON.id);
  assert.strictEqual(calls.notified.length, 1);
});

test('a rebuild job orders its packout from the partner of the mitigation location that referred it', async () => {
  const REB_JOB = { ...SRC, id: '55555555-5555-4555-8555-555555555555', jn_id: 'rebjn', name: 'Lauren Wyatt (DAL - REB)', record_type: 'Rebuild', location_id: 'reb', jn_location_id: 600, referring_job_id: SRC.id };
  const partners = [
    { location_id: 'reb', service: 'contents', partner_location_id: 'ats', is_default: true },
    { location_id: 'mitA', service: 'contents', partner_location_id: 'conA', is_default: true },
  ];
  const { api } = fake({ jobs: [SRC, REB_JOB], partners });
  const out = await api.createWorkOrder(REB_JOB.id, { service: 'contents', kind: 'packout' }, { ...ACTOR, locs: ['reb'] });
  assert.deepStrictEqual(out.target, { id: 'conA', name: 'FTW Contents' });
});

test('the route answers with the error code and field', async () => {
  const { routes } = fake({ partners: [] });
  let status = 200; let payload = null;
  const res = { status(s) { status = s; return this; }, json(p) { payload = p; } };
  await routes['/jobs/:id/work-orders']({ params: { id: SRC.id }, body: { service: 'contents' } }, res);
  assert.strictEqual(status, 400);
  assert.strictEqual(payload.code, 'NO_PARTNER');
  assert.strictEqual(payload.field, 'partner_location_id');
});
