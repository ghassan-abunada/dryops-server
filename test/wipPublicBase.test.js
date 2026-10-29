// WIP owner / master links: behind the dryops.app proxy the public base comes
// from the x-dryops-public-base header; anything that is not a bare https
// origin is ignored and the request's own host is used. Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const { publicBase } = require('../wip');

function req(header, { protocol = 'https', host = 'dryops-server-production.up.railway.app' } = {}) {
  const headers = { host };
  if (header !== undefined) headers['x-dryops-public-base'] = header;
  return { protocol, get: (k) => headers[String(k).toLowerCase()] };
}
const RAILWAY = 'https://dryops-server-production.up.railway.app';

test('no header falls back to the request host', () => {
  assert.strictEqual(publicBase(req(undefined)), RAILWAY);
  assert.strictEqual(publicBase(req(undefined, { protocol: 'http', host: 'localhost:3000' })), 'http://localhost:3000');
  assert.strictEqual(publicBase(req('')), RAILWAY);
});

test('a bare https origin is used', () => {
  assert.strictEqual(publicBase(req('https://dryops.app')), 'https://dryops.app');
  assert.strictEqual(publicBase(req('https://dryops.app/')), 'https://dryops.app');
  assert.strictEqual(publicBase(req('  https://DryOps.app  ')), 'https://dryops.app');
  assert.strictEqual(publicBase(req('https://staging.dryops.app:8443')), 'https://staging.dryops.app:8443');
});

test('anything else is ignored', () => {
  for (const bad of [
    'http://dryops.app',
    'https://dryops.app/evil',
    'https://dryops.app/wip',
    'https://dryops.app?x=1',
    'https://dryops.app/#x',
    'https://user:pw@dryops.app',
    'https://dryops.app@evil.test',
    'javascript:alert(1)',
    '//evil.test',
    'dryops.app',
    'not a url',
    'https://evil.test https://dryops.app',
  ]) assert.strictEqual(publicBase(req(bad)), RAILWAY, bad);
});
