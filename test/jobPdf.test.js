'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const mount = require('../jobPdf');
const { parseParams, renderKey, filenameFor, clientLabel, canSave, KINDS, DOC_TYPE, JSON_LIMIT_PATH } = require('../jobPdf');
const P = require('../estimatePricing');

const JOB = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const DOC = '33333333-3333-4333-8333-333333333333';
const SECRET = 'test-secret';
const fixture = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'dryingLog.json'), 'utf8'));
// The drying log as the desktop page sends it (DryOps buildDrylogData); the kind prints only from the body.
const drylog = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'drylogData.json'), 'utf8'));

// A priced estimate body whose docTotals equals grand_total.
const body = {
  v: 1, category: 3, mold: false, after_hours: false,
  general: [{ id: 'g1', row: 'emergency_call', group: 'general', qty: 1 }],
  rooms: [{ id: 'r1', name: 'Kitchen', shape: { L: 10, W: 10, H: 8, openings: [] }, subrooms: [], lines: [{ id: 'l1', row: 'air_mover', group: 'equipment', qty: 12 }] }],
};
const prices = { 'Emergency service call - during business hours': { remove: 0, replace: 215.5, mat: 0 }, 'Air mover (per 24 hour period) - No monitoring': { remove: 0, replace: 38.55, mat: 0 } };
const GRAND = P.docTotals(body, prices, P.moneyFacts({ tax: {} })).total; // 215.50 + 462.60 = 678.10

function setup(state = {}) {
  const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, post: (p, ...h) => { routes[`POST ${p}`] = h; } };
  const writes = [], fetches = [], jn = [];
  const st = {
    actors: {
      admin: { id: 'u-admin', role: 'admin', name: 'Admin', jn_user_id: 'jn-admin', locs: [], perms: {} },
      tech: { id: 'u-tech', role: 'technician', name: 'Tech', jn_user_id: null, locs: ['loc-1'], perms: {} },
      techElsewhere: { id: 'u-far', role: 'technician', name: 'Far', jn_user_id: null, locs: ['loc-9'], perms: {} },
      manager: { id: 'u-mgr', role: 'expansion_manager', name: 'Mgr', jn_user_id: 'jn-mgr', locs: ['loc-1'], perms: {} },
    },
    job: { id: JOB, jn_id: 'jn-job', name: 'Delgado, Maria (DAL - MIT)', client_name: 'Delgado, Maria', address: '1600 Sara Ln', claim_number: 'CLM-1', insurer: 'State Farm', location_id: 'loc-1', jn_location_id: 7, record_type: 'Mitigation' },
    snapshot: null,
    estimate: null, version: null, approvals: [],
    ...state,
  };
  const sbGet = async (q) => {
    if (q.startsWith('jobs?')) return q.includes(`id=eq.${JOB}`) ? [st.job] : [];
    if (q.startsWith('locations?')) return [{ id: 'loc-1', name: 'A1 Restoration of Dallas', logo_url: null, office_address: '123 Main St' }];
    if (q.startsWith('scope_sheets?')) return st.snapshot ? [st.snapshot] : [];
    if (q.startsWith('rooms?')) return [];
    if (q.startsWith('photos?')) return [];
    if (q.startsWith('estimate_docs?')) return st.estimate && q.includes(`id=eq.${st.estimate.id}`) ? [st.estimate] : [];
    if (q.startsWith('estimate_versions?')) return st.version && q.includes(`revision=eq.${st.version.revision}`) ? [st.version] : [];
    if (q.startsWith('estimate_approvals?')) return st.approvals;
    if (q.startsWith('documents?')) return [{ id: 'doc-row', storage_url: 'reselected', type: 'drying_log', name: 'x' }];
    return [];
  };
  const sbInsert = async (t, row) => { writes.push([t, row]); return st.insertReturns === 'empty' ? undefined : { id: 'd-1', ...row }; };
  const fetchFn = async (url, init) => {
    fetches.push({ url, method: (init && init.method) || 'GET', headers: init && init.headers, body: init && init.body });
    if (st.storageFails) return { ok: false, status: 500, text: async () => 'boom' };
    return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
  };
  const jnUploadFile = async (jnid, filename, buf, desc) => { jn.push(['file', jnid, filename, buf.length, desc]); if (st.jnFails) throw new Error('JN down'); return 'jn-file-1'; };
  const jnAddNote = async (jnid, text, opts) => { jn.push(['note', jnid, text, opts]); return { ok: true, id: 'jn-note-1' }; };
  const requireAuth = (req, res, next) => { if (!req.headers || !req.headers.authorization) return res.status(401).json({ error: 'Missing bearer token' }); req.userId = req.headers.authorization.replace('Bearer ', ''); next(); };
  const loadActor = async (req) => st.actors[req.userId] || null;
  const now = () => new Date('2026-06-14T12:00:00Z');
  const api = mount(app, { requireAuth, loadActor, sbGet, sbInsert, jnUploadFile, jnAddNote, locationLogoUrl: async () => null, logoPngFromUrl: async () => null, SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_KEY: 'svc', FILE_LINK_SECRET: SECRET, fetchFn, now });
  async function call(method, { as, kind = 'drying-log', job = JOB, query = {}, body: b = null } = {}) {
    const res = { statusCode: 200, headers: {}, body: undefined, status(s) { this.statusCode = s; return this; }, json(j) { this.body = j; this.sent = true; return this; }, set(k, v) { this.headers[k] = v; return this; }, send(d) { this.body = d; this.sent = true; return this; } };
    const req = { params: { id: job, kind }, query, body: b, headers: as ? { authorization: `Bearer ${as}` } : {} };
    const chain = routes[`${method} /jobs/:id/pdf/:kind`];
    for (const h of chain) {
      let nexted = false;
      await h(req, res, () => { nexted = true; });
      if (!nexted || res.sent) break;
    }
    return res;
  }
  return { call, writes, fetches, jn, st, api };
}

test('pure helpers: params, render key, filenames, roles', () => {
  assert.deepStrictEqual(parseParams({ doc_id: DOC, revision: '2', version: '', photos: 'none' }), { doc_id: DOC, revision: 2, version: null, photos: 'none', rid: null });
  assert.deepStrictEqual(parseParams(undefined).photos, 'supabase');
  const k1 = renderKey(JOB, 'estimate', parseParams({ doc_id: DOC })), k2 = renderKey(JOB, 'estimate', parseParams({ doc_id: DOC, revision: 1 }));
  assert.match(k1, /^[0-9a-f]{48}$/);
  assert.notStrictEqual(k1, k2);
  const job = { client_name: 'Delgado, Maria', name: 'Delgado, Maria (DAL - MIT)' };
  assert.strictEqual(clientLabel(job), 'Maria Delgado');
  assert.strictEqual(filenameFor('drying-log', job, { date: '2026-06-12' }), 'Drying Log - Maria Delgado - 2026-06-12.pdf');
  assert.strictEqual(filenameFor('mitigation-report', job, { date: '2026-06-14' }), 'Mitigation Report - Maria Delgado - 2026-06-14.pdf');
  assert.strictEqual(filenameFor('estimate', job, { number: 2 }), 'Estimate E-2 - Maria Delgado.pdf');
  assert.strictEqual(filenameFor('invoice', { name: 'Smith/Jones: Rebuild' }, { number: 1 }), 'Invoice INV-1 - Smith Jones Rebuild.pdf');
  assert.strictEqual(canSave({ role: 'expansion_manager' }), true);
  assert.strictEqual(canSave({ role: 'technician' }), false);
  assert.deepStrictEqual(KINDS, ['drying-log', 'mitigation-report', 'estimate', 'invoice']);
  assert.deepStrictEqual(Object.values(DOC_TYPE), ['drying_log', 'mitigation_report', 'estimate', 'invoice']);
  assert.ok(JSON_LIMIT_PATH.test(`/jobs/${JOB}/pdf/drying-log`));
  assert.ok(!JSON_LIMIT_PATH.test(`/jobs/${JOB}/files`));
});

test('400 on a bad kind or job id, 401 without a token, 404 unknown job', async () => {
  const { call } = setup();
  assert.strictEqual((await call('GET', { as: 'admin', kind: 'photo-report' })).statusCode, 400);
  assert.strictEqual((await call('GET', { as: 'admin', job: 'nope' })).statusCode, 400);
  assert.strictEqual((await call('GET', {})).statusCode, 401);
  assert.strictEqual((await call('GET', { as: 'admin', job: OTHER })).statusCode, 404);
  assert.strictEqual((await call('POST', { as: 'ghost', body: {} })).statusCode, 403);
});

test('403 outside the actor\'s locations; a technician in scope may read (through the signed link)', async () => {
  const { call } = setup();
  const far = await call('POST', { as: 'techElsewhere', body: { drylog: drylog() } });
  assert.strictEqual(far.statusCode, 403);
  const made = await call('POST', { as: 'tech', body: { drylog: drylog() } });
  assert.strictEqual(made.statusCode, 200, JSON.stringify(made.body));
  const q = Object.fromEntries(new URL(`https://x${made.body.pdf_url}`).searchParams.entries());
  const ok = await call('GET', { query: q });
  assert.strictEqual(ok.statusCode, 200);
  assert.strictEqual(ok.headers['Content-Type'], 'application/pdf');
  assert.match(ok.headers['Content-Disposition'], /^inline; filename="Drying Log - Maria Delgado - 2026-08-18.pdf"/);
  assert.strictEqual(ok.body.slice(0, 5).toString(), '%PDF-');
  const dl = await call('GET', { query: { ...q, disposition: 'attachment' } });
  assert.match(dl.headers['Content-Disposition'], /^attachment;/);
  // A plain GET has no log to print: the page sends it.
  const bare = await call('GET', { as: 'tech' });
  assert.strictEqual(bare.statusCode, 409);
  assert.strictEqual(bare.body.needs_drying_log, true);
});

test('drying log: 409 needs_drying_log without a body log; a body log renders; a bad body is 400', async () => {
  const { call } = setup();
  const r = await call('POST', { as: 'admin', body: {} });
  assert.strictEqual(r.statusCode, 409);
  assert.strictEqual(r.body.needs_drying_log, true);
  const bad = await call('POST', { as: 'admin', body: { drylog: { rooms: 'x' } } });
  assert.strictEqual(bad.statusCode, 400);
  const ok = await call('POST', { as: 'tech', body: { drylog: drylog() } });
  assert.strictEqual(ok.statusCode, 200);
  assert.strictEqual(ok.body.ok, true);
  assert.strictEqual(ok.body.kind, 'drying-log');
  assert.strictEqual(ok.body.filename, 'Drying Log - Maria Delgado - 2026-08-18.pdf');
  assert.strictEqual(ok.body.pages, 3);
  assert.deepStrictEqual({ days: ok.body.days, rooms: ok.body.rooms, photos: ok.body.photos }, { days: 7, rooms: 2, photos: 0 });
  assert.ok(ok.body.bytes > 1000);
  assert.strictEqual(ok.body.document, null);
  assert.strictEqual(ok.body.jn_file_id, null);
  assert.match(ok.body.pdf_url, new RegExp(`^/jobs/${JOB}/pdf/drying-log\\?rid=[0-9a-f]{24}&sig=[0-9a-f]{32}&exp=\\d+&photos=supabase$`));
  // GET through the signed link needs no token and serves the cached render
  const q = Object.fromEntries(new URL(`https://x${ok.body.pdf_url}`).searchParams.entries());
  const signed = await call('GET', { query: q });
  assert.strictEqual(signed.statusCode, 200);
  assert.strictEqual(signed.body.length, ok.body.bytes);
  // a tampered or expired signature is refused
  assert.strictEqual((await call('GET', { query: { ...q, sig: '0'.repeat(32) } })).statusCode, 403);
  assert.strictEqual((await call('GET', { query: { ...q, exp: '1' } })).statusCode, 403);
  assert.strictEqual((await call('GET', { query: { ...q, rid: 'ffffffffffffffffffffffff' } })).statusCode, 403);
});

test('save / jn / note: technicians are refused; owners get a documents row, a JN file and a note', async () => {
  const { call, writes, fetches, jn } = setup();
  const refused = await call('POST', { as: 'tech', body: { save: true, drylog: drylog() } });
  assert.strictEqual(refused.statusCode, 403);
  const r = await call('POST', { as: 'manager', body: { save: true, jn: true, note: true, drylog: drylog() } });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  // storage upload to the documents bucket, then the documents row
  const up = fetches.find((f) => f.url.startsWith('https://sb.test/storage/v1/object/documents/'));
  assert.ok(up, 'uploaded to storage');
  assert.strictEqual(up.method, 'POST');
  assert.strictEqual(up.headers['Content-Type'], 'application/pdf');
  assert.match(up.url, new RegExp(`/documents/${JOB}/\\d+-Drying%20Log%20-%20Maria%20Delgado%20-%202026-08-18.pdf$`));
  assert.strictEqual(writes.length, 1);
  const [table, row] = writes[0];
  assert.strictEqual(table, 'documents');
  assert.strictEqual(row.job_id, JOB);
  assert.strictEqual(row.type, 'drying_log');
  assert.strictEqual(row.name, 'Drying Log - Maria Delgado - 2026-08-18.pdf');
  assert.strictEqual(row.jn_file_id, 'jn-file-1');
  assert.strictEqual(row.size, r.body.bytes);
  assert.match(row.storage_url, /^https:\/\/sb.test\/storage\/v1\/object\/public\/documents\//);
  assert.deepStrictEqual(r.body.document, { id: 'd-1', storage_url: row.storage_url, type: 'drying_log', name: row.name });
  // JobNimbus file + note (note tags the job's location and is attributed to the actor)
  assert.strictEqual(r.body.jn_file_id, 'jn-file-1');
  assert.strictEqual(r.body.jn_note_id, 'jn-note-1');
  const file = jn.find((x) => x[0] === 'file'), note = jn.find((x) => x[0] === 'note');
  assert.strictEqual(file[1], 'jn-job');
  assert.strictEqual(file[2], row.name);
  assert.match(note[2], /^Drying log attached: 7 days · 08\/12 – 08\/18 · 2 rooms · 3 materials\.\n/);
  assert.deepStrictEqual(note[3], { jnLocationId: 7, createdBy: 'jn-mgr' });
});

test('save: an empty insert reply re-selects the row; a storage failure is 502; a JN failure is 502', async () => {
  const a = setup({ insertReturns: 'empty' });
  const r = await a.call('POST', { as: 'admin', body: { save: true, drylog: drylog() } });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.body.document.id, 'doc-row');
  const b = setup({ storageFails: true });
  assert.strictEqual((await b.call('POST', { as: 'admin', body: { save: true, drylog: drylog() } })).statusCode, 502);
  const c = setup({ jnFails: true });
  assert.strictEqual((await c.call('POST', { as: 'admin', body: { jn: true, drylog: drylog() } })).statusCode, 502);
  const d = setup();
  d.st.job = { ...d.st.job, jn_id: null };
  assert.strictEqual((await d.call('POST', { as: 'admin', body: { jn: true, drylog: drylog() } })).statusCode, 409);
});

test('mitigation report renders with or without a snapshot', async () => {
  const none = setup();
  const r0 = await none.call('POST', { as: 'admin', kind: 'mitigation-report', body: { photos: 'none' } });
  assert.strictEqual(r0.statusCode, 200);
  assert.strictEqual(r0.body.snapshot_version, null);
  assert.strictEqual(r0.body.photos, 0);
  assert.strictEqual(r0.body.filename, 'Mitigation Report - Maria Delgado - 2026-06-14.pdf');
  const some = setup({ snapshot: { id: 's1', version: 2, status: 'reviewed', drying_log: fixture(), sheet: { v: 1, catalog_version: 'c', general: [{ id: 'a', description: 'Emergency service call', qty: { value: 1, basis: 'derived' }, unit: 'EA' }], rooms: [], totals: { sf_floor: 1, sf_walls: 2, lf_floor_perimeter: 3 } } } });
  const r1 = await some.call('GET', { as: 'tech', kind: 'mitigation-report', query: { photos: 'none' } });
  assert.strictEqual(r1.statusCode, 200);
  assert.strictEqual(r1.body.slice(0, 5).toString(), '%PDF-');
});

test('estimate / invoice: doc_id required, kind must match, pricing mismatch is 409, totals verified', async () => {
  const estimate = { id: DOC, job_id: JOB, kind: 'estimate', number: 2, title: null, status: 'sent', prices, tax: {}, overhead_pct: 0, profit_pct: 0, cover: { estimator: 'Gus', price_list: 'Dallas · Nov 2026' }, body, totals: null, grand_total: GRAND, amount_paid: 0, revision: 3, created_by_name: 'Gus', created_at: '2026-06-12T15:00:00Z' };
  const s = setup({ estimate });
  assert.strictEqual((await s.call('POST', { as: 'admin', kind: 'estimate', body: {} })).statusCode, 400);
  assert.strictEqual((await s.call('POST', { as: 'admin', kind: 'estimate', body: { doc_id: OTHER } })).statusCode, 404);
  assert.strictEqual((await s.call('POST', { as: 'admin', kind: 'invoice', body: { doc_id: DOC } })).statusCode, 404);
  const ok = await s.call('POST', { as: 'admin', kind: 'estimate', body: { doc_id: DOC } });
  assert.strictEqual(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.strictEqual(ok.body.filename, 'Estimate E-2 - Maria Delgado.pdf');
  assert.strictEqual(ok.body.total, GRAND);
  assert.strictEqual(ok.body.revision, 3);
  assert.match(ok.body.pdf_url, new RegExp(`doc_id=${DOC}`));
  // the stored total disagrees → never print it
  const bad = setup({ estimate: { ...estimate, grand_total: GRAND + 5 } });
  const mm = await bad.call('GET', { as: 'admin', kind: 'estimate', query: { doc_id: DOC } });
  assert.strictEqual(mm.statusCode, 409);
  assert.deepStrictEqual(mm.body, { error: 'pricing mismatch', server_total: GRAND, stored_total: GRAND + 5 });
  // a frozen revision prices from estimate_versions and checks against ITS total
  const frozen = setup({ estimate: { ...estimate, grand_total: 1 }, version: { revision: 2, body, prices, totals: { total: GRAND } } });
  const fr = await frozen.call('POST', { as: 'admin', kind: 'estimate', body: { doc_id: DOC, revision: 2 } });
  assert.strictEqual(fr.statusCode, 200, JSON.stringify(fr.body));
  assert.strictEqual(fr.body.revision, 2);
  assert.strictEqual((await frozen.call('POST', { as: 'admin', kind: 'estimate', body: { doc_id: DOC, revision: 9 } })).statusCode, 404);
  // invoice variant with an approval
  const inv = setup({ estimate: { ...estimate, kind: 'invoice', number: 1, amount_paid: 100 }, approvals: [{ signer_name: 'Maria Delgado', signed_at: '2026-06-13T15:00:00Z', revision: 3 }] });
  const ir = await inv.call('POST', { as: 'manager', kind: 'invoice', body: { doc_id: DOC, jn: true, note: true } });
  assert.strictEqual(ir.statusCode, 200, JSON.stringify(ir.body));
  assert.strictEqual(ir.body.filename, 'Invoice INV-1 - Maria Delgado.pdf');
  assert.strictEqual(inv.jn[0][2], 'Invoice INV-1 - Maria Delgado.pdf');
  assert.match(inv.jn[1][2], /^Invoice INV-1 attached · total \$678\.10 · balance due \$578\.10\./);
});
