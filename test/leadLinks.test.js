// Lead-source links (leadLinks.js): submission validation + the intake body it
// becomes, and one full submit against fake deps. Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const mount = require('../leadLinks');
const { TOKEN_RE, validateLeadSubmission, submissionToIntakeBody, splitName } = mount;

const GOOD = {
  client_request_id: '7b1b1b1b-1111-4111-8111-111111111111',
  sender_name: 'Sam',
  customer: { name: 'Jane Q Doe', phone: '(214) 555-0100' },
  address: { line1: '123 Main St', city: 'Dallas', state: 'TX', zip: '75201' },
  test_types: ['Asbestos', 'lead', 'Asbestos'],
  insurance: { type: 'Insurance', claim_number: 'CLM-1', insurer: 'State Farm', adjuster_name: 'Al', adjuster_phone: '214-555-0199' },
  instructions: 'Gate code 1234',
  photo_paths: ['lead-photos/0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f/1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a.jpg'],
};

test('tokens are 22 url-safe chars', () => {
  assert.ok(TOKEN_RE.test('abcDEF0123456789-_ABCD'));
  assert.ok(!TOKEN_RE.test('abcDEF0123456789-_ABC'));
  assert.ok(!TOKEN_RE.test('abcDEF0123456789-_ABCD!'));
});

test('validateLeadSubmission normalises a good body', () => {
  const v = validateLeadSubmission(GOOD);
  assert.strictEqual(v.ok, true);
  assert.deepStrictEqual(v.value.test_types, ['Asbestos', 'lead']);
  assert.strictEqual(v.value.customer.phone, '2145550100');
  assert.strictEqual(v.value.insurance.adjuster_phone, '2145550199');
  assert.strictEqual(v.value.client_request_id, GOOD.client_request_id);
});

test('validateLeadSubmission rejects what the form must have', () => {
  const bad = (patch, field) => {
    const v = validateLeadSubmission({ ...GOOD, ...patch });
    assert.strictEqual(v.ok, false, field);
    assert.strictEqual(v.field, field);
  };
  bad({ customer: { name: '', phone: '2145550100' } }, 'customer.name');
  bad({ customer: { name: 'Jane', phone: '555' } }, 'customer.phone');
  bad({ address: { line1: '', city: 'Dallas', state: 'TX' } }, 'address.line1');
  bad({ address: { line1: '1 Elm', city: '', state: 'TX' } }, 'address.city');
  bad({ test_types: [] }, 'test_types');
  bad({ insurance: { type: 'Maybe' } }, 'insurance.type');
  bad({ photo_paths: new Array(11).fill(GOOD.photo_paths[0]) }, 'photo_paths');
  bad({ photo_paths: ['../etc/passwd'] }, 'photo_paths');
  // Out-of-pocket drops the claim fields even when sent
  const oop = validateLeadSubmission({ ...GOOD, insurance: { type: 'Non-Insurance', claim_number: 'X' } });
  assert.strictEqual(oop.value.insurance.claim_number, null);
  // a missing client_request_id is fine (the server mints one)
  assert.strictEqual(validateLeadSubmission({ ...GOOD, client_request_id: undefined }).value.client_request_id, null);
});

test('splitName + submissionToIntakeBody build the POST /jobs/create body', () => {
  assert.deepStrictEqual(splitName('Jane Q Doe'), { first: 'Jane Q', last: 'Doe' });
  assert.deepStrictEqual(splitName('Cher'), { first: 'Cher', last: '' });
  const v = validateLeadSubmission(GOOD).value;
  const link = { location_id: 'loc-1', lead_source_company_id: 'co-1' };
  const body = submissionToIntakeBody(v, link, { name: 'AWD Roofing' }, GOOD.client_request_id);
  assert.strictEqual(body.record_type, 'Testing');
  assert.strictEqual(body.location_id, 'loc-1');
  assert.deepStrictEqual(body.lead, { lead_source_company_id: 'co-1', lead_type: 'External Referral' });
  assert.deepStrictEqual(body.contact, { first_name: 'Jane Q', last_name: 'Doe', phone: '2145550100', email: '' });
  assert.strictEqual(body.address.street, '123 Main St');
  assert.deepStrictEqual(body.details.test_types, ['Asbestos', 'lead']);
  assert.strictEqual(body.details.insurance_type, 'Insurance');
  assert.strictEqual(body.details.claim_number, 'CLM-1');
  assert.strictEqual(body.details.instructions, 'Gate code 1234');
  assert.strictEqual(body.details.referring_contact, 'Sam (AWD Roofing)');
  assert.deepStrictEqual(body.lead_link, { sender_name: 'Sam', company: 'AWD Roofing' });
});

// ── One submit end to end against fake Supabase / JN / intake ───────────────
function fakeApp() {
  const routes = {};
  const reg = (method) => (path, ...handlers) => { routes[`${method} ${path}`] = handlers[handlers.length - 1]; };
  return { get: reg('GET'), post: reg('POST'), routes };
}
function fakeRes() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
const TOKEN = 'abcDEF0123456789-_ABCD';

test('POST /lead/:token/submit → submission row → intake job → JN photos → created', async () => {
  const app = fakeApp();
  const db = { lead_submissions: [], patches: [] };
  const link = { id: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f', token: TOKEN, location_id: 'loc-1', lead_source_company_id: 'co-1', contact_name: 'Sam', enabled: true };
  const sbGet = async (q) => {
    if (q.startsWith('lead_links?token=eq.')) return q.includes(TOKEN) ? [link] : [];
    if (q.startsWith('lead_source_companies?')) return [{ id: 'co-1', name: 'AWD Roofing', status: 'active' }];
    if (q.startsWith('locations?')) return [{ id: 'loc-1', name: 'Abatement Testing Services', status: 'active', location_type: 'Testing' }];
    if (q.startsWith('location_planner_settings?')) return [{ testing_types: ['Asbestos', 'Lead'] }];
    if (q.startsWith('lead_submissions?client_request_id=')) return db.lead_submissions.filter((s) => q.includes(s.client_request_id));
    return [];
  };
  const sbInsert = async (table, row) => { const r = { id: `sub-${db.lead_submissions.length + 1}`, ...row }; db[table].push(r); return r; };
  const sbPatch = async (table, filter, patch) => { db.patches.push({ table, filter, patch }); return [patch]; };
  const uploads = [];
  const jnUploadFile = async (jobJnId, filename, buf) => { uploads.push({ jobJnId, filename, bytes: buf.length }); return `file-${uploads.length}`; };
  let intakeCall = null;
  const createIntakeJob = async (body, actor, opts) => { intakeCall = { body, actor, opts }; return { ok: true, job: { id: 'job-1', jn_id: 'jn-1', name: 'Jane Q Doe (DAL - TST)' }, warnings: [] }; };
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
  try {
    mount(app, {
      SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'k', requireAuth: (req, res, next) => next(),
      sbGet, sbInsert, sbPatch, jnUploadFile, createIntakeJob, loadActor: async () => ({ role: 'admin', locs: [] }),
      makeRateLimiter: () => ({ hit: () => true }), clientIp: () => '1.1.1.1', log: () => {}, warn: () => {},
    });
    // GET → form config
    const g = fakeRes();
    await app.routes['GET /lead/:token']({ params: { token: TOKEN } }, g);
    assert.deepStrictEqual(g.body, { ok: true, company: { id: 'co-1', name: 'AWD Roofing' }, location: { id: 'loc-1', name: 'Abatement Testing Services' }, contact_name: 'Sam', test_types: ['Asbestos', 'Lead'] });
    const nf = fakeRes();
    await app.routes['GET /lead/:token']({ params: { token: 'zzzDEF0123456789-_ABCD' } }, nf);
    assert.strictEqual(nf.statusCode, 404);
    // submit
    const res = fakeRes();
    await app.routes['POST /lead/:token/submit']({ params: { token: TOKEN }, body: GOOD, headers: {} }, res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.ok, true);
    assert.deepStrictEqual(res.body.job, { id: 'job-1', jn_id: 'jn-1', name: 'Jane Q Doe (DAL - TST)' });
    assert.strictEqual(intakeCall.body.record_type, 'Testing');
    assert.strictEqual(intakeCall.body.client_request_id, GOOD.client_request_id);
    assert.strictEqual(intakeCall.opts.system, true);
    assert.strictEqual(intakeCall.actor.role, 'system');
    assert.deepStrictEqual(uploads.map((u) => u.jobJnId), ['jn-1']);
    assert.strictEqual(uploads[0].bytes, 3);
    const created = db.patches.find((p) => p.table === 'lead_submissions' && p.patch.status === 'created');
    assert.ok(created, 'submission marked created');
    assert.strictEqual(created.patch.job_id, 'job-1');
    assert.ok(db.patches.some((p) => p.table === 'lead_links' && p.patch.last_submitted_at));
    // replay: same client_request_id returns the earlier job without a second intake call
    db.lead_submissions[0].status = 'created'; db.lead_submissions[0].job_id = 'job-1'; db.lead_submissions[0].jn_id = 'jn-1';
    intakeCall = null;
    const again = fakeRes();
    await app.routes['POST /lead/:token/submit']({ params: { token: TOKEN }, body: GOOD, headers: {} }, again);
    assert.strictEqual(again.body.replay, true);
    assert.strictEqual(intakeCall, null);
    // validation error
    const badRes = fakeRes();
    await app.routes['POST /lead/:token/submit']({ params: { token: TOKEN }, body: { ...GOOD, client_request_id: undefined, test_types: [] }, headers: {} }, badRes);
    assert.strictEqual(badRes.statusCode, 400);
    assert.strictEqual(badRes.body.field, 'test_types');
  } finally {
    global.fetch = origFetch;
  }
});

test('a failed intake marks the submission failed and surfaces the error', async () => {
  const app = fakeApp();
  const patches = [];
  const link = { id: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f', token: TOKEN, location_id: 'loc-1', lead_source_company_id: 'co-1', enabled: true };
  mount(app, {
    SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'k', requireAuth: (req, res, next) => next(),
    sbGet: async (q) => q.startsWith('lead_links?') ? [link] : q.startsWith('lead_source_companies?') ? [{ id: 'co-1', name: 'AWD', status: 'active' }] : q.startsWith('locations?') ? [{ id: 'loc-1', name: 'ATS', status: 'active' }] : [],
    sbInsert: async (t, row) => ({ id: 'sub-9', ...row }),
    sbPatch: async (table, filter, patch) => { patches.push({ table, patch }); return [patch]; },
    jnUploadFile: async () => 'x',
    createIntakeJob: async () => { throw Object.assign(new Error('JobNimbus rejected the job: nope'), { status: 502, code: 'JN_JOB' }); },
    makeRateLimiter: () => ({ hit: () => true }), clientIp: () => '1.1.1.1', log: () => {}, warn: () => {},
  });
  const res = fakeRes();
  await app.routes['POST /lead/:token/submit']({ params: { token: TOKEN }, body: GOOD, headers: {} }, res);
  assert.strictEqual(res.statusCode, 502);
  assert.strictEqual(res.body.ok, false);
  assert.strictEqual(res.body.code, 'JN_JOB');
  const failed = patches.find((p) => p.table === 'lead_submissions' && p.patch.status === 'failed');
  assert.ok(failed && /nope/.test(failed.patch.error));
});
