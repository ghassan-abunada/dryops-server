// CallRail call webhook bodies → the call object (callrailPayload.js).
// Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const { readCallrailCall, describeBody, callId } = require('../callrailPayload');

const call = { resource_id: 'CAL01a1abc', id: 123456, tracking_phone_number: '+12145550000', customer_phone_number: '+14695550101' };

test('reads resource_id as the call id (webhook payloads)', () => {
  assert.strictEqual(readCallrailCall(call).id, 'CAL01a1abc');
  assert.strictEqual(callId({ id: 'CAL99' }), 'CAL99', 'API rows keep id');
  assert.strictEqual(callId({ call_id: 'CAL77' }), 'CAL77');
  assert.strictEqual(callId({ id: 123456 }), '', 'a bare numeric id is not a CAL id');
});

test('unwraps data / call / array envelopes and JSON strings', () => {
  assert.strictEqual(readCallrailCall({ data: call }).id, 'CAL01a1abc');
  assert.strictEqual(readCallrailCall({ call }).id, 'CAL01a1abc');
  assert.strictEqual(readCallrailCall([call]).id, 'CAL01a1abc');
  assert.strictEqual(readCallrailCall({ payload: JSON.stringify(call) }).id, 'CAL01a1abc', 'form-encoded payload=<json>');
  assert.strictEqual(readCallrailCall(JSON.stringify({ data: call })).id, 'CAL01a1abc');
  assert.strictEqual(readCallrailCall({ data: call }).tracking_phone_number, '+12145550000');
});

test('nothing usable → null', () => {
  assert.strictEqual(readCallrailCall({}), null);
  assert.strictEqual(readCallrailCall(null), null);
  assert.strictEqual(readCallrailCall('nope'), null);
  assert.strictEqual(readCallrailCall({ id: 5 }), null);
});

test('describeBody logs keys only, never values', () => {
  const d = describeBody({ resource_id: 'CAL1', customer_phone_number: '+1555' }, 'application/json');
  assert.deepStrictEqual(d, { contentType: 'application/json', type: 'object', keys: ['resource_id', 'customer_phone_number'] });
  assert.ok(!JSON.stringify(d).includes('+1555'));
});
