// Demo-account JobNimbus proxy scope (jnScope.js). Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const { jnRequestJobIds, profileLocationIds, jobsInScope } = require('../jnScope');

test('job read/write by id is allowed and names the job', () => {
  assert.deepStrictEqual(jnRequestJobIds('GET', '/jobs/abc123', {}, null), ['abc123']);
  assert.deepStrictEqual(jnRequestJobIds('put', '/jobs/abc123/', {}, { status_name: 'Lead' }), ['abc123']);
  assert.strictEqual(jnRequestJobIds('DELETE', '/jobs/abc123', {}, null), null);
});

test('files and activity feeds need a single related job', () => {
  assert.deepStrictEqual(jnRequestJobIds('GET', '/files', { size: '200', related: 'abc123' }, null), ['abc123']);
  assert.deepStrictEqual(jnRequestJobIds('GET', '/activities', { related: 'abc123' }, null), ['abc123']);
  assert.strictEqual(jnRequestJobIds('GET', '/files', {}, null), null);
  assert.strictEqual(jnRequestJobIds('GET', '/activities', { related: ['a', 'b'] }, null), null);
  assert.strictEqual(jnRequestJobIds('GET', '/activities', { related: 'a,b' }, null), null);
});

test('posting a note only on jobs', () => {
  const note = { record_type_name: 'Note', related: [{ id: 'j1', type: 'job' }], primary: { id: 'j1', type: 'job' } };
  assert.deepStrictEqual(jnRequestJobIds('POST', '/activities', {}, note), ['j1']);
  assert.strictEqual(jnRequestJobIds('POST', '/activities', {}, { related: [{ id: 'c1', type: 'contact' }] }), null);
  assert.strictEqual(jnRequestJobIds('POST', '/activities', {}, { related: [{ id: 'j1', type: 'job' }, { id: 'c1', type: 'contact' }] }), null);
  assert.strictEqual(jnRequestJobIds('POST', '/activities', {}, {}), null);
});

test('everything else is refused', () => {
  for (const [m, p] of [['GET', '/jobs'], ['GET', '/contacts'], ['POST', '/contacts'], ['POST', '/files'], ['GET', '/account/users'], ['POST', '/jobs'], ['GET', '/jobs/a/../contacts']]) {
    assert.strictEqual(jnRequestJobIds(m, p, {}, {}), null, `${m} ${p}`);
  }
});

test('profileLocationIds prefers location_ids', () => {
  assert.deepStrictEqual(profileLocationIds({ location_id: 'a', location_ids: ['b', 'c'] }), ['b', 'c']);
  assert.deepStrictEqual(profileLocationIds({ location_id: 'a', location_ids: [] }), ['a']);
  assert.deepStrictEqual(profileLocationIds({}), []);
  assert.deepStrictEqual(profileLocationIds(null), []);
});

test('jobsInScope requires every job to be known and in scope', () => {
  const rows = [{ jn_id: 'j1', location_id: 'demo' }, { jn_id: 'j2', location_id: 'real' }, { jn_id: 'j3', location_id: null }];
  assert.strictEqual(jobsInScope(['j1'], rows, ['demo']), true);
  assert.strictEqual(jobsInScope(['j1', 'j2'], rows, ['demo']), false);
  assert.strictEqual(jobsInScope(['j3'], rows, ['demo']), false);
  assert.strictEqual(jobsInScope(['unknown'], rows, ['demo']), false);
  assert.strictEqual(jobsInScope(['j1'], rows, []), false);
  assert.strictEqual(jobsInScope([], rows, ['demo']), false);
});
