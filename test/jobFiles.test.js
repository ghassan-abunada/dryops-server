'use strict';
// Job files listing + signed download links (jobFiles.js). Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const mount = require('../jobFiles');
const { signFileLink, verifyFileLink, fileKind, fileUrl, publicFile, contentDisposition, LINK_TTL_SECS } = mount;

const SECRET = 'test-secret';
const NOW = 1_800_000_000;

test('signer: 32 hex chars over "<jnid>|<exp>", stable, secret-bound', () => {
  const a = signFileLink(SECRET, 'abc123', NOW + 60);
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.strictEqual(a, signFileLink(SECRET, 'abc123', NOW + 60));
  assert.notStrictEqual(a, signFileLink(SECRET, 'abc124', NOW + 60));
  assert.notStrictEqual(a, signFileLink(SECRET, 'abc123', NOW + 61));
  assert.notStrictEqual(a, signFileLink('other', 'abc123', NOW + 60));
  assert.strictEqual(signFileLink('', 'abc123', NOW + 60), null);
});

test('verifier accepts a fresh signature and refuses tampering, expiry and junk', () => {
  const exp = NOW + 600;
  const sig = signFileLink(SECRET, 'file-1', exp);
  assert.strictEqual(verifyFileLink(SECRET, 'file-1', String(exp), sig, NOW), true);
  assert.strictEqual(verifyFileLink(SECRET, 'file-1', exp, sig, exp), true); // last second
  assert.strictEqual(verifyFileLink(SECRET, 'file-1', exp, sig, exp + 1), false); // expired
  assert.strictEqual(verifyFileLink(SECRET, 'file-2', exp, sig, NOW), false); // other file
  assert.strictEqual(verifyFileLink(SECRET, 'file-1', exp + 1, sig, NOW), false); // exp edited
  assert.strictEqual(verifyFileLink(SECRET, 'file-1', exp, sig.slice(0, 31) + 'x', NOW), false);
  assert.strictEqual(verifyFileLink(SECRET, 'file-1', exp, '', NOW), false);
  assert.strictEqual(verifyFileLink(SECRET, 'file-1', 'soon', sig, NOW), false);
  assert.strictEqual(verifyFileLink('', 'file-1', exp, sig, NOW), false);
  assert.strictEqual(verifyFileLink(SECRET, '../etc', exp, signFileLink(SECRET, '../etc', exp), NOW), false);
});

test('fileUrl carries sig, a one-hour exp and the encoded name; it round-trips', () => {
  const url = fileUrl(SECRET, 'f1abc2', 'Work Auth (signed).pdf', NOW);
  const m = url.match(/^\/jnfile\/f1abc2\?sig=([0-9a-f]{32})&exp=(\d+)&name=(.+)$/);
  assert.ok(m, url);
  assert.strictEqual(Number(m[2]), NOW + LINK_TTL_SECS);
  assert.strictEqual(decodeURIComponent(m[3]), 'Work Auth (signed).pdf');
  assert.strictEqual(verifyFileLink(SECRET, 'f1abc2', m[2], m[1], NOW + 10), true);
  assert.strictEqual(fileUrl('', 'f1abc2', 'x.pdf', NOW), null);
});

test('fileKind: image by flag / subtype / content type, pdf by type or name, else doc', () => {
  assert.strictEqual(fileKind({ is_image: true }), 'image');
  assert.strictEqual(fileKind({ subtype: 'image', content_type: 'application/octet-stream' }), 'image');
  assert.strictEqual(fileKind({ content_type: 'image/heic' }), 'image');
  assert.strictEqual(fileKind({ content_type: 'application/pdf' }), 'pdf');
  assert.strictEqual(fileKind({ content_type: 'application/octet-stream', filename: 'Estimate.PDF' }), 'pdf');
  assert.strictEqual(fileKind({ content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', filename: 'a.docx' }), 'doc');
  assert.strictEqual(fileKind({}), 'doc');
});

test('publicFile maps a JN file record', () => {
  const f = { jnid: 'f9', filename: 'auth.pdf', content_type: 'application/pdf', size: '20480', date_created: 1700000000,
    created_by_name: 'Jane Tech', description: ' signed ', record_type_name: 'Work Authorization', is_image: false };
  const p = publicFile(f, SECRET, NOW);
  assert.deepStrictEqual({ ...p, url: undefined }, {
    jnid: 'f9', filename: 'auth.pdf', content_type: 'application/pdf', kind: 'pdf', size: 20480, date_created: 1700000000,
    by: 'Jane Tech', description: 'signed', record_type_name: 'Work Authorization', url: undefined,
  });
  assert.match(p.url, /^\/jnfile\/f9\?sig=/);
  const bare = publicFile({ id: 'f10' }, SECRET, NOW);
  assert.strictEqual(bare.filename, 'file-f10');
  assert.strictEqual(bare.size, null);
  assert.strictEqual(bare.kind, 'doc');
});

test('contentDisposition quotes safely and offers the UTF-8 name', () => {
  assert.strictEqual(contentDisposition('a"b\r\n.pdf', false), 'inline; filename="a_b__.pdf"; filename*=UTF-8\'\'a_b__.pdf');
  assert.strictEqual(contentDisposition('Señor.pdf', true), 'attachment; filename="Se_or.pdf"; filename*=UTF-8\'\'Se%C3%B1or.pdf');
});

// ── Endpoint with fake deps ─────────────────────────────────────────────────
const JOB_ID = '22222222-2222-4222-8222-222222222222';
function setup(over = {}) {
  const routes = {};
  const app = { get: (p, ...h) => { routes[p] = h[h.length - 1]; } };
  const state = {
    actor: { id: 'u1', role: 'technician', name: 'T', locs: ['loc-a'], perms: {} },
    job: { id: JOB_ID, jn_id: 'JNJOB1', location_id: 'loc-a' },
    scope: null,
    files: [
      { jnid: 'p1', filename: 'IMG_1.jpg', content_type: 'image/jpeg', date_created: 10, is_image: true },
      { jnid: 'd1', filename: 'auth.pdf', content_type: 'application/pdf', date_created: 20, is_image: false },
      { jnid: 'd2', filename: 'notes.txt', content_type: 'text/plain', date_created: 30, is_image: false },
    ],
    ...over,
  };
  const listCalls = [];
  mount(app, {
    requireAuth: (req, res, next) => next(),
    loadActor: async () => state.actor,
    sbGet: async () => (state.job ? [state.job] : []),
    jnListJobFiles: async (jnid, opts) => { listCalls.push([jnid, opts]); return opts && opts.imagesOnly ? state.files.filter((f) => f.is_image) : state.files; },
    loadJnScopeProfile: async () => state.scope,
    JN_BASE: 'https://jn.example/api1', JN_TOKEN: 'tok', FILE_LINK_SECRET: SECRET,
  });
  const call = async (query = {}) => {
    let status = 200, json = null;
    const res = { status(s) { status = s; return this; }, json(j) { json = j; return this; } };
    await routes['/jobs/:id/files']({ params: { id: JOB_ID }, query, userId: 'u1' }, res);
    return { status, json };
  };
  return { call, listCalls, state, routes };
}

test('GET /jobs/:id/files lists every file with signed links; kind filters', async () => {
  const { call, listCalls } = setup();
  const all = await call();
  assert.strictEqual(all.status, 200);
  assert.deepStrictEqual(all.json.files.map((f) => [f.jnid, f.kind]), [['p1', 'image'], ['d1', 'pdf'], ['d2', 'doc']]);
  for (const f of all.json.files) assert.match(f.url, new RegExp(`^/jnfile/${f.jnid}\\?sig=[0-9a-f]{32}&exp=\\d+&name=`));
  const docs = await call({ kind: 'docs' });
  assert.deepStrictEqual(docs.json.files.map((f) => f.jnid), ['d1', 'd2']);
  const imgs = await call({ kind: 'images' });
  assert.deepStrictEqual(imgs.json.files.map((f) => f.jnid), ['p1']);
  assert.deepStrictEqual(listCalls[2], ['JNJOB1', { imagesOnly: true }]);
});

test('GET /jobs/:id/files: location scope, missing job, demo scope, no jn_id', async () => {
  assert.strictEqual((await setup({ actor: { id: 'u', role: 'technician', locs: ['loc-b'], perms: {} } }).call()).status, 403);
  assert.strictEqual((await setup({ actor: { id: 'u', role: 'owner', locs: [], perms: {} } }).call()).status, 200);
  assert.strictEqual((await setup({ job: null }).call()).status, 404);
  assert.strictEqual((await setup({ scope: { is_demo: true, location_ids: ['loc-z'] } }).call()).status, 403);
  assert.strictEqual((await setup({ scope: { is_demo: true, location_ids: ['loc-a'] } }).call()).status, 200);
  assert.deepStrictEqual((await setup({ job: { id: JOB_ID, jn_id: null, location_id: 'loc-a' } }).call()).json, { files: [] });
});

test('GET /jnfile/:jnid refuses a bad or expired signature before touching JobNimbus', async () => {
  const { routes } = setup();
  let status = 200;
  const res = { status(s) { status = s; return this; }, json() { return this; } };
  const origFetch = global.fetch; let fetched = 0;
  global.fetch = async () => { fetched++; throw new Error('should not fetch'); };
  try {
    await routes['/jnfile/:jnid']({ params: { jnid: 'd1' }, query: { sig: 'nope', exp: String(NOW + 60) } }, res);
    assert.strictEqual(status, 403);
    const exp = Math.floor(Date.now() / 1000) - 5;
    await routes['/jnfile/:jnid']({ params: { jnid: 'd1' }, query: { sig: signFileLink(SECRET, 'd1', exp), exp: String(exp) } }, res);
    assert.strictEqual(status, 403);
    assert.strictEqual(fetched, 0);
  } finally { global.fetch = origFetch; }
});

test('GET /jnfile/:jnid streams the JN file with type, disposition and private caching', async () => {
  const { routes } = setup();
  const headers = {}; let body = null; let status = 200;
  const res = {
    status(s) { status = s; return this; }, json(j) { body = j; return this; },
    set(k, v) { headers[k] = v; return this; }, send(b) { body = b; return this; },
    headersSent: false,
  };
  const origFetch = global.fetch; let url = null; let auth = null;
  global.fetch = async (u, init) => {
    url = u; auth = init.headers.Authorization;
    return { ok: true, status: 200, headers: new Map([['content-type', 'application/pdf'], ['content-length', '3']]), body: null, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer };
  };
  try {
    const exp = Math.floor(Date.now() / 1000) + 60;
    await routes['/jnfile/:jnid']({ params: { jnid: 'd1' }, query: { sig: signFileLink(SECRET, 'd1', exp), exp: String(exp), name: 'auth.pdf', dl: '1' } }, res);
    assert.strictEqual(status, 200);
    assert.strictEqual(url, 'https://jn.example/api1/files/d1');
    assert.strictEqual(auth, 'bearer tok');
    assert.strictEqual(headers['Content-Type'], 'application/pdf');
    assert.strictEqual(headers['Content-Disposition'], 'attachment; filename="auth.pdf"; filename*=UTF-8\'\'auth.pdf');
    assert.strictEqual(headers['Cache-Control'], 'private, max-age=300');
    assert.strictEqual(headers['Content-Length'], '3');
    assert.deepStrictEqual([...body], [1, 2, 3]);
  } finally { global.fetch = origFetch; }
});
