// Two-way texting: the pure parts of sms.js. Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const { webhookTargets, classifyTextDelivery, rankJobs, previewOf, validateContent, callrailSendError, pushRecipientIds, CONTENT_MAX } = require('../sms');

test('webhookTargets: calls keep the calls route, texts go to the sms route with the event in the query', () => {
  const t = webhookTargets('https://dryops-server-production.up.railway.app/', 'a b');
  assert.strictEqual(t.pre_call_webhook, 'https://dryops-server-production.up.railway.app/webhooks/callrail/calls?token=a%20b');
  assert.strictEqual(t.post_call_webhook, t.pre_call_webhook);
  assert.strictEqual(t.post_outbound_call_webhook, t.pre_call_webhook);
  assert.strictEqual(t.updated_call_webhook, t.pre_call_webhook);
  assert.strictEqual(t.sms_received_webhook, 'https://dryops-server-production.up.railway.app/webhooks/callrail/sms?token=a%20b&event=received');
  assert.strictEqual(t.sms_sent_webhook, 'https://dryops-server-production.up.railway.app/webhooks/callrail/sms?token=a%20b&event=sent');
  assert.deepStrictEqual(Object.keys(t).length, 6);
});

const isTracking = (n) => n === '2145550100';

test('classifyTextDelivery: a received text has the tracking number as destination', () => {
  const m = classifyTextDelivery({
    id: 'MSG1', source_number: '+14695551234', destination_number: '+12145550100', content: 'Hi, I have water in my kitchen',
    message_type: 'sms', media_urls: [], timestamp: '2026-10-28T14:02:00Z', lead_status: 'good_lead', conversation_id: 'CONV9', company_resource_id: 'COM1',
  }, isTracking, 'received');
  assert.strictEqual(m.direction, 'inbound');
  assert.strictEqual(m.tracking, '2145550100');
  assert.strictEqual(m.customer, '4695551234');
  assert.strictEqual(m.callrail_message_id, 'MSG1');
  assert.strictEqual(m.callrail_conversation_id, 'CONV9');
  assert.strictEqual(m.message_type, 'sms');
  assert.strictEqual(m.created_at, '2026-10-28T14:02:00.000Z');
  assert.strictEqual(m.lead_status, 'good_lead');
});

test('classifyTextDelivery: a sent text has the tracking number as source; MMS inferred from media', () => {
  const m = classifyTextDelivery({ data: { id: 7, source_number: '2145550100', destination_number: '4695551234', content: '', media_urls: ['https://x/y.jpg'], timestamp: 1761660000000 } }, isTracking, 'sent');
  assert.strictEqual(m.direction, 'outbound');
  assert.strictEqual(m.tracking, '2145550100');
  assert.strictEqual(m.customer, '4695551234');
  assert.strictEqual(m.callrail_message_id, '7');
  assert.strictEqual(m.message_type, 'mms');
  assert.deepStrictEqual(m.media_urls, ['https://x/y.jpg']);
});

test('classifyTextDelivery: unknown numbers fall back to the event hint; no hint → no direction', () => {
  const sent = classifyTextDelivery({ source_number: '1111111111', destination_number: '2222222222' }, () => false, 'sent');
  assert.strictEqual(sent.direction, 'outbound'); assert.strictEqual(sent.tracking, '1111111111'); assert.strictEqual(sent.customer, '2222222222');
  const recv = classifyTextDelivery({ source_number: '1111111111', destination_number: '2222222222' }, () => false, 'received');
  assert.strictEqual(recv.direction, 'inbound'); assert.strictEqual(recv.tracking, '2222222222');
  assert.strictEqual(classifyTextDelivery({ source_number: '1111111111', destination_number: '2222222222' }, () => false, '').direction, null);
});

test('rankJobs: Mitigation first, then the texting location, then active, then newest', () => {
  const rows = [
    { id: 'c', record_type: 'Contents', location_id: 'L1', is_active: true, jn_created: '2026-10-20' },
    { id: 'm-old', record_type: 'Mitigation', location_id: 'L2', is_active: true, jn_created: '2026-01-01' },
    { id: 'm-loc', record_type: 'Mitigation', location_id: 'L1', is_active: false, jn_created: '2026-09-01' },
    { id: 'm-loc-active', record_type: 'Mitigation', location_id: 'L1', is_active: true, jn_created: '2026-08-01' },
  ];
  assert.strictEqual(rankJobs(rows, 'L1').id, 'm-loc-active');
  assert.strictEqual(rankJobs(rows, 'L2').id, 'm-old');
  assert.strictEqual(rankJobs([], 'L1'), null);
});

test('previewOf and validateContent', () => {
  assert.strictEqual(previewOf('  hello\n\nworld  '), 'hello world');
  assert.strictEqual(previewOf('', ['a', 'b']), 'Photos');
  assert.strictEqual(previewOf('', ['a']), 'Photo');
  assert.deepStrictEqual(validateContent('  '), { error: 'Type a message first.' });
  assert.deepStrictEqual(validateContent('ok'), { content: 'ok' });
  const long = 'x'.repeat(CONTENT_MAX + 1);
  assert.match(validateContent(long).error, /140 characters/);
  assert.strictEqual(validateContent('x'.repeat(CONTENT_MAX)).content.length, CONTENT_MAX);
});

test('callrailSendError: rate limit, opt-out and registration read as plain sentences', () => {
  assert.match(callrailSendError({ status: 429, json: null, text: '' }), /hourly texting limit/);
  assert.match(callrailSendError({ status: 422, json: { error: 'Customer has opted out' } }), /opted out/);
  assert.match(callrailSendError({ status: 422, json: { errors: ['Company is not registered for texting'] } }), /registered for texting/);
  assert.match(callrailSendError({ status: 500, json: null, text: 'boom' }), /rejected the text \(500\): boom/);
});

test('toE164: CallRail send gets full E.164 numbers, never bare digits', () => {
  const { toE164 } = require('../sms');
  assert.equal(toE164('+14803728411'), '+14803728411');
  assert.equal(toE164('4803728411'), '+14803728411');
  assert.equal(toE164('(480) 372-8411'), '+14803728411');
  assert.equal(toE164('14803728411'), '+14803728411');
  assert.equal(toE164('12345'), null);
});

test('pushRecipientIds: only people assigned to the location, admins and owners included', () => {
  const profiles = [
    { id: 'a1', role: 'admin', location_ids: ['L1', 'L2'] },
    { id: 'a2', role: 'admin', location_ids: [], location_id: null },
    { id: 'o1', role: 'owner', location_ids: ['L3'] },
    { id: 'm1', role: 'expansion_manager', location_ids: [], location_id: 'L1' },
  ];
  assert.deepEqual(pushRecipientIds(profiles, 'L1'), ['a1', 'm1']);
  assert.deepEqual(pushRecipientIds(profiles, 'L3'), ['o1']);
  assert.deepEqual(pushRecipientIds(profiles, 'L9'), []);
  assert.deepEqual(pushRecipientIds(profiles, null), []);
});
