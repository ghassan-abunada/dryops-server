// Owner call backs (callbacks.js) + the missed-call push (callAlerts.js).
// Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const { toE164, callbackRequest, mayCallBack, errorText } = require('../callbacks');
const { ownerMissedEligible, ownerMissedMessage, isPlaceholderName, ownerMessage } = require('../callAlerts');

const LOC = '11111111-1111-1111-1111-111111111111';
const call = { callrail_id: 'CAL1', direction: 'inbound', location_id: LOC, job_id: null, tracking_phone_number: '+12145550000', customer_phone_number: '+14695550101', customer_name: 'Jane Smith' };

test('toE164: US / Canada 10-digit numbers only', () => {
  assert.strictEqual(toE164('(469) 555-0101'), '+14695550101');
  assert.strictEqual(toE164('+1 469 555 0101'), '+14695550101');
  assert.strictEqual(toE164('555-0101'), null);
  assert.strictEqual(toE164('+44 20 7946 0958'), null);
  assert.strictEqual(toE164(''), null);
});

test('callbackRequest: rings the owner, shows the tracking number they called, records', () => {
  assert.deepStrictEqual(callbackRequest(call, '972-555-1234').body, {
    caller_id: '+12145550000', business_phone_number: '+19725551234', customer_phone_number: '+14695550101', recording_enabled: true,
  });
  assert.strictEqual(callbackRequest(call, null).error, 'NO_PHONE');
  assert.strictEqual(callbackRequest({ ...call, customer_phone_number: 'Restricted' }, '9725551234').error, 'NO_CUSTOMER_NUMBER');
  assert.strictEqual(callbackRequest({ ...call, tracking_phone_number: null }, '9725551234').error, 'NO_TRACKING_NUMBER');
  assert.strictEqual(callbackRequest(call, '4695550101').error, 'SAME_NUMBER');
  assert.match(errorText('NO_PHONE'), /Add your phone/);
});

test('mayCallBack: admins anywhere, owners / managers at their locations only', () => {
  assert.strictEqual(mayCallBack({ role: 'admin', location_ids: [] }, call), true);
  assert.strictEqual(mayCallBack({ role: 'owner', location_ids: [LOC] }, call), true);
  assert.strictEqual(mayCallBack({ role: 'owner', location_ids: ['other'] }, call), false);
  assert.strictEqual(mayCallBack({ role: 'expansion_manager', location_id: LOC, location_ids: [] }, call), true);
  assert.strictEqual(mayCallBack({ role: 'technician', location_ids: [LOC] }, call), false);
  assert.strictEqual(mayCallBack(null, call), false);
});

test('owner missed-call push: missed new callers only, with the Call back category', () => {
  assert.strictEqual(ownerMissedEligible({ ...call, answered: false, duration: 0 }), true);
  assert.strictEqual(ownerMissedEligible({ ...call, answered: true, voicemail: true, duration: 40 }), true);
  assert.strictEqual(ownerMissedEligible({ ...call, answered: true, duration: 120 }), false, 'answered');
  assert.strictEqual(ownerMissedEligible({ ...call, job_id: 'j1', answered: false, duration: 0 }), false, 'existing customer');
  assert.strictEqual(ownerMissedEligible({ ...call }), false, 'still ringing');
  assert.strictEqual(ownerMissedEligible({ ...call, location_id: null, answered: false, duration: 0 }), false);
  const m = ownerMissedMessage({ ...call, answered: false }, 'A1 Restoration of Dallas');
  assert.strictEqual(m.title, 'Missed call · A1 Restoration of Dallas');
  assert.strictEqual(m.body, "Jane Smith (469) 555-0101 wasn't answered. Call them back now?");
  assert.strictEqual(m.categoryId, 'missed_call');
  assert.deepStrictEqual(m.data, { kind: 'call_missed', callrail_id: 'CAL1', url: '/calls/CAL1?mode=owner' });
});

test('caller-ID placeholders drop out of the push text', () => {
  assert.strictEqual(isPlaceholderName('WIRELESS CALLER'), true);
  assert.strictEqual(isPlaceholderName('DALLAS TX'), true);
  assert.strictEqual(isPlaceholderName('Jane Smith'), false);
  assert.match(ownerMessage({ ...call, customer_name: 'WIRELESS CALLER' }, 'A1 Dallas').body, /^\(469\) 555-0101 is calling/);
});
