'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeRateLimiter } = require('../homeowner');
const mount = require('../estimates');

function setup(state) {
  const routes = {};
  const app = { post: (p, h) => { routes[p] = h; } };
  const writes = [];
  const sbGet = async (q) => {
    if (q.startsWith('estimate_links')) return state.link ? [state.link] : [];
    if (q.startsWith('estimate_docs')) return state.doc ? [state.doc] : [];
    if (q.startsWith('estimate_versions')) return state.version ? [state.version] : [];
    if (q.startsWith('jobs')) return [{ id: 'j', name: 'Job', client_name: 'Client' }];
    if (q.startsWith('notification_channels')) return [];
    return [];
  };
  const sbInsert = async (t, row) => { writes.push(['insert', t, row]); return row; };
  const sbPatch = async (t, f, p) => { writes.push(['patch', t, f, p]); return [p]; };
  mount(app, { sbGet, sbInsert, sbPatch, makeRateLimiter, clientIp: () => '1.2.3.4', WEB_APP_URL: 'https://dryops.app' });
  const call = async (token, body) => {
    let status = 200, json = null;
    const res = { status(s) { status = s; return this; }, json(j) { json = j; return this; } };
    await routes['/e/:token/approve']({ params: { token }, body, headers: { 'user-agent': 'ua' } }, res);
    return { status, json };
  };
  return { call, writes };
}

const TOKEN = 'abcdefghijklmnopqrstuvwx';
const base = () => ({
  link: { doc_id: 'd1', revision: null },
  doc: { id: 'd1', job_id: 'j', location_id: 'l', kind: 'estimate', number: 1, status: 'sent', grand_total: 1234.5 },
  version: { revision: 3, body: { v: 1 }, prices: {}, totals: { total: 1234.5 } },
});

test('rejects bad tokens and missing name / agreement', async () => {
  const { call } = setup(base());
  assert.strictEqual((await call('short', { name: 'Ann Lee', agree: true })).status, 404);
  assert.strictEqual((await call(TOKEN, { name: 'A', agree: true })).status, 400);
  assert.strictEqual((await call(TOKEN, { name: 'Ann Lee' })).status, 400);
});

test('refuses a stale revision', async () => {
  const { call, writes } = setup(base());
  const r = await call(TOKEN, { name: 'Ann Lee', agree: true, revision: 2 });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(writes.length, 0);
});

test('records the approval with a hash and marks the estimate approved', async () => {
  const { call, writes } = setup(base());
  const r = await call(TOKEN, { name: '  Ann   Lee ', agree: true, revision: 3 });
  assert.strictEqual(r.status, 200);
  const ins = writes.find((w) => w[0] === 'insert');
  assert.strictEqual(ins[1], 'estimate_approvals');
  assert.strictEqual(ins[2].signer_name, 'Ann Lee');
  assert.strictEqual(ins[2].revision, 3);
  assert.match(ins[2].body_sha256, /^[0-9a-f]{64}$/);
  const patch = writes.find((w) => w[0] === 'patch');
  assert.strictEqual(patch[1], 'estimate_docs');
  assert.strictEqual(patch[3].status, 'approved');
});

test('already approved is a no-op; a revised (draft) estimate is refused', async () => {
  const s = base(); s.doc.status = 'approved';
  assert.deepStrictEqual((await setup(s).call(TOKEN, { name: 'Ann Lee', agree: true })).json, { ok: true, already: true });
  const d = base(); d.doc.status = 'draft';
  assert.strictEqual((await setup(d).call(TOKEN, { name: 'Ann Lee', agree: true })).status, 409);
});
