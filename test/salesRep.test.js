// Job sales rep rules (salesRep.js). Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const { canChangeSalesRep, profileIdFor, jnSalesRepId, pickError } = require('../salesRep');

const job = { location_id: 'loc-a' };
const reps = ['rep-1', 'rep-2'];
const actor = (over) => ({ id: 'u', role: 'technician', locs: ['loc-a'], perms: {}, ...over });

test('admins and owners change any job', () => {
  assert.strictEqual(canChangeSalesRep(actor({ role: 'admin', locs: [] }), job, reps), true);
  assert.strictEqual(canChangeSalesRep(actor({ role: 'owner', locs: ['loc-b'] }), job, reps), true);
});

test('expansion managers only inside their locations', () => {
  assert.strictEqual(canChangeSalesRep(actor({ role: 'expansion_manager' }), job, reps), true);
  assert.strictEqual(canChangeSalesRep(actor({ role: 'expansion_manager', locs: ['loc-b'] }), job, reps), false);
});

test("the location's sales reps, and edit_job_fields holders there, may change it", () => {
  assert.strictEqual(canChangeSalesRep(actor({ id: 'rep-2' }), job, reps), true);
  assert.strictEqual(canChangeSalesRep(actor({ id: 'rep-2', locs: ['loc-b'] }), job, reps), false);
  assert.strictEqual(canChangeSalesRep(actor({ id: 'other' }), job, reps), false);
  assert.strictEqual(canChangeSalesRep(actor({ id: 'other', role: 'technician_2', perms: { edit_job_fields: true } }), job, reps), true);
  assert.strictEqual(canChangeSalesRep(actor({ id: 'other', role: 'executive' }), job, reps), false);
  assert.strictEqual(canChangeSalesRep(actor({ role: 'expansion_manager' }), { location_id: null }, reps), false);
});

test('JN sales_rep → profile id: absent key leaves the column alone, unknown rep clears it', () => {
  const byJn = new Map([['jn-user-9', 'prof-9']]);
  assert.strictEqual(jnSalesRepId({}), undefined);
  assert.strictEqual(jnSalesRepId({ sales_rep: null }), null);
  assert.strictEqual(jnSalesRepId({ sales_rep: '' }), null);
  assert.strictEqual(jnSalesRepId({ sales_rep: { id: 'jn-user-9' } }), 'jn-user-9');
  assert.strictEqual(profileIdFor({}, byJn), undefined);
  assert.strictEqual(profileIdFor({ sales_rep: 'jn-user-9' }, byJn), 'prof-9');
  assert.strictEqual(profileIdFor({ sales_rep: 'jn-user-x' }, byJn), null);
  assert.strictEqual(profileIdFor({ sales_rep: null }, byJn), null);
});

test('a pick must be a rep of the location, JN-linked when the job lives in JobNimbus', () => {
  const linked = { id: 'rep-1', full_name: 'Jane Smith', jn_user_id: 'jn-1' };
  const unlinked = { id: 'rep-2', full_name: 'Pat Jones', jn_user_id: null };
  assert.strictEqual(pickError(linked, reps, true), null);
  assert.strictEqual(pickError(unlinked, reps, false), null);
  assert.match(pickError(unlinked, reps, true), /Pat Jones isn't linked to a JobNimbus user/);
  assert.match(pickError({ id: 'zzz', full_name: 'X', jn_user_id: 'j' }, reps, true), /not a sales rep at this location/);
  assert.match(pickError(null, reps, true), /no longer a sales rep/);
});
