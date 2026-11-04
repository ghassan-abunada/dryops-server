const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const express = require('express');
const mount = require('../netsuiteIntake');

const KEY_B64 = crypto.randomBytes(32).toString('base64');
const future = Math.floor(Date.now() / 1000) + 3600;
const TOKEN = `${future}.${'a'.repeat(64)}`;
const SECRET = 'SUPERSECRETVALUE123';
const TBA = { method: 'tba', account_id: '1234567', expense_tagging: 'class', notes: 'hello', consumer_key: 'ckckckckckck', consumer_secret: SECRET, token_id: 'tidtidtidtid', token_secret: 'tstststststs' };

const memStore = () => ({
  row: null,
  async get() { return this.row; },
  async insert(r) { if (this.row) return false; this.row = r; return true; },
});

async function withApp(env, store, fn, onSubmitted) {
  const app = express();
  app.use((req, res, next) => { res.header('Access-Control-Allow-Origin', '*'); next(); });
  const intake = mount(app, { env, store, onSubmitted });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const logs = [];
  const orig = { log: console.log, error: console.error };
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => logs.push(a.join(' '));
  try {
    await fn({ base, intake, logs, post: (body, token = TOKEN) => fetch(`${base}/netsuite/connect/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) }) });
  } finally {
    Object.assign(console, orig);
    await new Promise((r) => server.close(r));
  }
}
const ENV = { NETSUITE_INTAKE_TOKEN: TOKEN, NETSUITE_ENC_KEY: KEY_B64 };

test('tokenValid: match only, and never once expired or malformed', () => {
  assert.equal(mount.tokenValid(TOKEN, TOKEN), true);
  assert.equal(mount.tokenValid(`${TOKEN}x`, TOKEN), false);
  assert.equal(mount.tokenValid(TOKEN, TOKEN, (future + 1) * 1000), false);
  assert.equal(mount.tokenValid('', ''), false);
  assert.equal(mount.tokenValid(undefined, undefined), false);
  assert.equal(mount.tokenValid('short', 'short'), false);
  assert.equal(mount.tokenValid('a'.repeat(64), 'a'.repeat(64)), false, 'a token without an expiry is refused');
});

test('encryption round-trips and rejects tampering or the wrong key', () => {
  const key = mount.parseKey(KEY_B64);
  const stored = mount.encryptSecrets({ a: SECRET }, key);
  assert.ok(!stored.includes(SECRET));
  assert.deepEqual(mount.decryptSecrets(stored, key), { a: SECRET });
  assert.throws(() => mount.decryptSecrets(stored, crypto.randomBytes(32)));
  const parts = stored.split(':');
  parts[3] = Buffer.from('tampered').toString('base64');
  assert.throws(() => mount.decryptSecrets(parts.join(':'), key));
  assert.equal(mount.parseKey('tooshort'), null);
  assert.equal(mount.parseKey(''), null);
});

test('validateSubmission: strips pasted whitespace, needs every field, knows the method', () => {
  const ok = mount.validateSubmission({ ...TBA, token_secret: ' abc def\n123 45 ' });
  assert.equal(ok.value.secrets.token_secret, 'abcdef12345');
  assert.deepEqual(Object.keys(ok.value.secrets).sort(), ['consumer_key', 'consumer_secret', 'token_id', 'token_secret']);
  assert.ok(mount.validateSubmission({ ...TBA, token_id: undefined }).error);
  assert.ok(mount.validateSubmission({ ...TBA, method: 'password' }).error);
  assert.ok(mount.validateSubmission({ ...TBA, account_id: '<script>' }).error);
  assert.ok(mount.validateSubmission(undefined).error);
  assert.ok(mount.validateSubmission({ method: 'oauth2_m2m', account_id: '1234567_SB1', client_id: 'cidcidcidcid', certificate_id: 'certcertcert' }).value);
  assert.equal(mount.validateSubmission({ ...TBA, expense_tagging: 'bogus' }).value.expense_tagging, 'not_sure');
});

test('page is off without the env, with a wrong token, or with a bad key', async () => {
  for (const env of [{}, { NETSUITE_INTAKE_TOKEN: TOKEN }, { NETSUITE_INTAKE_TOKEN: TOKEN, NETSUITE_ENC_KEY: 'bad' }, { NETSUITE_ENC_KEY: KEY_B64 }]) {
    const warn = console.warn; console.warn = () => {};
    await withApp(env, memStore(), async ({ base }) => {
      assert.equal((await fetch(`${base}/netsuite/connect/${TOKEN}`)).status, 404);
    });
    console.warn = warn;
  }
  await withApp(ENV, memStore(), async ({ base, post }) => {
    assert.equal((await fetch(`${base}/netsuite/connect/wrong`)).status, 404);
    assert.equal((await post(TBA, 'wrong')).status, 404);
  });
});

test('form has locked-down headers and offers token auth only without a certificate', async () => {
  await withApp(ENV, memStore(), async ({ base }) => {
    const r = await fetch(`${base}/netsuite/connect/${TOKEN}`);
    const html = await r.text();
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(r.headers.get('access-control-allow-origin'), null);
    assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(html, /consumer_secret/);
    assert.doesNotMatch(html, /certificate_id/);
    assert.equal((await fetch(`${base}/netsuite/connect/${TOKEN}/dryops-netsuite.pem`)).status, 404);
  });
});

test('a submission is stored encrypted, decrypts through load(), and is never logged', async () => {
  const store = memStore();
  let notified = null;
  await withApp(ENV, store, async ({ post, intake, logs }) => {
    const r = await post(TBA);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Credentials received/);
    assert.ok(!JSON.stringify(store.row).includes(SECRET), 'plaintext secret in the stored row');
    assert.equal(store.row.account_id, '1234567');
    assert.equal(store.row.expense_tagging, 'class');
    const loaded = await intake.load();
    assert.equal(loaded.secrets.consumer_secret, SECRET);
    await new Promise((res) => setImmediate(res));
    assert.ok(!logs.join('\n').includes(SECRET));
    assert.deepEqual(notified, { method: 'tba', account_id: '1234567', expense_tagging: 'class' });
  }, async (info) => { notified = info; });
});

test('the link is single-use: a second post cannot replace the first', async () => {
  const store = memStore();
  await withApp(ENV, store, async ({ base, post }) => {
    await post(TBA);
    const first = store.row.secrets;
    assert.match(await (await post({ ...TBA, consumer_secret: 'ATTACKERVALUE123' })).text(), /Credentials received/);
    assert.equal(store.row.secrets, first);
    const page = await (await fetch(`${base}/netsuite/connect/${TOKEN}`)).text();
    assert.match(page, /Credentials received/);
    assert.doesNotMatch(page, /<form/);
  });
});

test('a validation error keeps safe fields, never echoes a secret, and escapes input', async () => {
  const store = memStore();
  await withApp(ENV, store, async ({ post }) => {
    const r = await post({ ...TBA, token_id: '', notes: '<img src=x>' });
    const html = await r.text();
    assert.equal(r.status, 400);
    assert.equal(store.row, null);
    assert.ok(!html.includes(SECRET));
    assert.ok(html.includes('&lt;img src=x&gt;'));
    assert.ok(!html.includes('<img src=x>'));
    assert.match(html, /value="1234567"/);
  });
});

test('a storage failure tells the person nothing was saved and leaks no detail', async () => {
  const store = { async get() { throw new Error('db host secret'); }, async insert() { throw new Error('db host secret'); } };
  await withApp(ENV, store, async ({ base, post }) => {
    for (const r of [await fetch(`${base}/netsuite/connect/${TOKEN}`), await post(TBA)]) {
      const html = await r.text();
      assert.equal(r.status, 503);
      assert.match(html, /Nothing was saved/);
      assert.ok(!html.includes('db host secret'));
    }
  });
});

test('supabaseStore: first write wins through ignore-duplicates, and errors throw', async () => {
  const orig = global.fetch;
  const calls = [];
  let reply = { ok: true, status: 201, json: async () => [{ id: 1 }] };
  global.fetch = async (url, opts) => { calls.push({ url, opts }); return reply; };
  try {
    const s = mount.supabaseStore({ url: 'https://x.supabase.co', serviceKey: 'svc' });
    assert.equal(await s.insert({ id: 1 }), true);
    assert.match(calls[0].url, /netsuite_credentials\?on_conflict=id$/);
    assert.match(calls[0].opts.headers.Prefer, /resolution=ignore-duplicates/);
    reply = { ok: true, status: 200, json: async () => [] };
    assert.equal(await s.insert({ id: 1 }), false);
    assert.equal(await s.get(), null);
    reply = { ok: false, status: 500, json: async () => [] };
    await assert.rejects(s.insert({ id: 1 }));
    await assert.rejects(s.get());
  } finally { global.fetch = orig; }
});
