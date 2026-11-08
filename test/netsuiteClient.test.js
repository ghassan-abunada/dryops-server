const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const c = require('../netsuiteClient');

const secrets = { consumer_key: 'ck', consumer_secret: 'c s&', token_id: 'tid', token_secret: 't/s', };

test('realm and host forms handle production and sandbox accounts', () => {
  assert.equal(c.realmFor('6554817'), '6554817');
  assert.equal(c.hostFor('6554817'), '6554817.suitetalk.api.netsuite.com');
  assert.equal(c.realmFor('1234567-sb1'), '1234567_SB1');
  assert.equal(c.hostFor('1234567_SB1'), '1234567-sb1.suitetalk.api.netsuite.com');
});

test('base string sorts encoded params and encodes RFC 3986 reserved characters', () => {
  assert.equal(c.pct("a b!*'()"), 'a%20b%21%2A%27%28%29');
  assert.equal(
    c.signatureBaseString('post', 'https://x.test/q', { offset: '0', limit: '1', oauth_nonce: 'n n' }),
    'POST&https%3A%2F%2Fx.test%2Fq&limit%3D1%26oauth_nonce%3Dn%2520n%26offset%3D0',
  );
});

test('auth header signs query params and encoded secrets, and leaves realm unsigned', () => {
  const header = c.authHeader({ method: 'POST', baseUrl: 'https://x.test/q', query: { limit: '1' }, accountId: '1234567_sb1', secrets, nonce: 'abc', timestamp: 1700000000 });
  const expectedBase = 'POST&https%3A%2F%2Fx.test%2Fq&limit%3D1%26oauth_consumer_key%3Dck%26oauth_nonce%3Dabc%26oauth_signature_method%3DHMAC-SHA256%26oauth_timestamp%3D1700000000%26oauth_token%3Dtid%26oauth_version%3D1.0';
  const expected = crypto.createHmac('sha256', 'c%20s%26&t%2Fs').update(expectedBase).digest('base64');
  assert.ok(header.startsWith('OAuth realm="1234567_SB1", '));
  assert.ok(header.includes(`oauth_signature="${encodeURIComponent(expected)}"`));
  assert.ok(!header.includes('c%20s') && !header.includes('t%2Fs'), 'secrets stay out of the header');
});

test('suiteql posts transient JSON and raises only the NetSuite detail', async () => {
  const orig = global.fetch;
  const calls = [];
  let reply = { ok: true, status: 200, json: async () => ({ items: [{ n: '3' }] }) };
  global.fetch = async (url, opts) => { calls.push({ url, opts }); return reply; };
  try {
    const out = await c.suiteql({ accountId: '6554817', secrets, q: 'SELECT 1', limit: 5 });
    assert.deepEqual(out.items, [{ n: '3' }]);
    assert.equal(calls[0].url, 'https://6554817.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql?limit=5&offset=0');
    assert.equal(calls[0].opts.headers.Prefer, 'transient');
    assert.deepEqual(JSON.parse(calls[0].opts.body), { q: 'SELECT 1' });
    reply = { ok: false, status: 401, json: async () => ({ 'o:errorDetails': [{ detail: 'Invalid login attempt.' }] }) };
    await assert.rejects(c.suiteql({ accountId: '6554817', secrets, q: 'SELECT 1' }), /NetSuite 401: Invalid login attempt\./);
  } finally { global.fetch = orig; }
});
