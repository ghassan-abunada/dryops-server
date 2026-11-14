// Two-way texting: the pure parts of sms.js. Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const { webhookTargets, classifyTextDelivery, rankJobs, previewOf, validateContent, callrailSendError, pushRecipientIds, CONTENT_MAX } = require('../sms');

test('webhookTargets: calls keep the calls route, texts go to the sms route with the event in the query', () => {
  const t = webhookTargets('https://dryops-server-production.up.railway.app/', 'a b');
  assert.strictEqual(t.pre_call_webhook, 'https://dryops-server-production.up.railway.app/webhooks/callrail/calls?token=a%20b&event=pre_call');
  assert.strictEqual(t.post_call_webhook, 'https://dryops-server-production.up.railway.app/webhooks/callrail/calls?token=a%20b&event=post_call');
  assert.strictEqual(t.post_outbound_call_webhook.split('&')[0], t.pre_call_webhook.split('&')[0], 'same route');
  assert.match(t.updated_call_webhook, /&event=updated$/);
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

const ONLY_MESSAGES = 'This customer requested only message replies (no calls). Reply here or respond via your LSA dashboard: https://ads.google.com/localservices/lead?cid=1234567890123&lid=45678901234567890123&utm_source=sms';
const NOTICE = 'Replies to this number will be sent to the customer. You can also choose to call the customer through this number (or respond via LSA dashboard: https://ads.google.com/localservices/lead?cid=123&lid=456)';

test("isLsaRelayNotice: Google's two automated LSA texts, whole / truncated / part-marked / upper case", () => {
  const { isLsaRelayNotice } = require('../sms');
  assert.strictEqual(isLsaRelayNotice(NOTICE), true);
  assert.ok(NOTICE.length > 160);
  assert.strictEqual(isLsaRelayNotice(NOTICE.slice(0, 160)), true);
  assert.strictEqual(isLsaRelayNotice(`(1/2) ${NOTICE}`), true);
  assert.strictEqual(isLsaRelayNotice(`  ${NOTICE.toUpperCase()}`), true);
  assert.strictEqual(isLsaRelayNotice('Hi, my basement flooded last night. Can someone come out?'), false);
  assert.strictEqual(isLsaRelayNotice('Thanks! Replies to this number will be sent to the customer'), false);
  assert.strictEqual(isLsaRelayNotice(''), false);
  assert.strictEqual(isLsaRelayNotice(null), false);
  assert.strictEqual(isLsaRelayNotice(undefined), false);
  assert.strictEqual(isLsaRelayNotice('This customer requested only message replies (no calls).'), true);
  assert.strictEqual(isLsaRelayNotice(ONLY_MESSAGES), true);
  assert.ok(ONLY_MESSAGES.length > 160);
  assert.strictEqual(isLsaRelayNotice(ONLY_MESSAGES.slice(0, 160)), true);
  assert.strictEqual(isLsaRelayNotice(`(2/2) ${ONLY_MESSAGES}`), true);
  assert.strictEqual(isLsaRelayNotice('This customer requested a quote'), false);
});

test("ingestMessage: Google's LSA notices are stored but never become the preview / latest message, and never push", async () => {
  const mountSms = require('../sms');
  const inserts = []; const patches = []; const pushes = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => { inserts.push({ url: String(url), row: JSON.parse(opts.body) }); return { ok: true, text: async () => opts.body }; };
  try {
    const app = { get() {}, post() {}, put() {}, patch() {}, delete() {}, use() {} };
    const { ingestMessage } = mountSms(app, {
      SUPABASE_URL: 'http://sb.test', SUPABASE_SERVICE_KEY: 'k',
      sbGet: async (q) => (q.startsWith('profiles') ? [{ id: 'p1', role: 'admin', location_ids: [7] }] : q.startsWith('push_tokens') ? [{ token: 'ExponentPushToken[x]', profile_id: 'p1' }] : []),
      sbPatch: async (table, where, patch) => { patches.push(patch); return null; },
      sbUpsert: async () => null,
      summarizeForPush: async () => ({ title: 't', body: 'b' }),
      push: { send: async (messages) => { pushes.push(messages); } },
    });
    const tick = () => new Promise((r) => setImmediate(r));
    const base = { id: 'c1', location_id: 7, source: 'Google LSA', job_id: 'j1', customer_phone_number: '+13035550100' };
    const msg = (content, at) => ({ direction: 'inbound', content, tracking: '+13035550199', customer: '+13035550100', created_at: at });

    // A normal inbound text rolls up and pushes.
    let out = await ingestMessage(msg('My basement flooded', '2026-11-12T10:00:00Z'), { trackingRow: {}, conv: { ...base } });
    await tick(); await tick();
    assert.strictEqual(out.inserted, true);
    assert.strictEqual(out.conversation.last_preview, 'My basement flooded');
    assert.strictEqual(out.conversation.last_message_at, '2026-11-12T10:00:00Z');
    assert.strictEqual(out.conversation.last_direction, 'inbound');
    assert.strictEqual(out.conversation.last_inbound_at, '2026-11-12T10:00:00Z');
    assert.strictEqual(out.conversation.first_inbound_at, '2026-11-12T10:00:00Z');
    assert.strictEqual(pushes.length, 1);

    // The notice that follows is stored, the roll-up and the phones stay as they were.
    const before = out.conversation;
    for (const [id, content] of [['c1a', NOTICE], ['c1b', `(1/2) ${NOTICE}`], ['c1c', ONLY_MESSAGES], ['c1d', `(2/2) ${ONLY_MESSAGES}`]]) {   // fresh ids: the push throttle is per thread
      const nPatches = patches.length; const nInserts = inserts.length;
      out = await ingestMessage({ ...msg(content, '2026-11-12T10:00:05Z'), callrail_conversation_id: 'CR1', customer_name: 'Pat', lead_status: 'good_lead' }, { trackingRow: {}, conv: { ...before, id } });
      await tick(); await tick();
      assert.strictEqual(out.inserted, true);
      assert.strictEqual(inserts.length, nInserts + 1);
      assert.match(inserts[inserts.length - 1].url, /sms_messages$/);
      assert.strictEqual(inserts[inserts.length - 1].row.content, content);
      assert.strictEqual(out.conversation.last_preview, 'My basement flooded');
      assert.strictEqual(out.conversation.last_message_at, '2026-11-12T10:00:00Z');
      assert.strictEqual(out.conversation.last_inbound_at, '2026-11-12T10:00:00Z');
      assert.strictEqual(out.conversation.first_inbound_at, '2026-11-12T10:00:00Z');
      // the other roll-up fields still land
      assert.deepStrictEqual(patches.slice(nPatches), [{ callrail_conversation_id: 'CR1', customer_name: 'Pat', lead_status: 'good_lead' }]);
      assert.strictEqual(pushes.length, 1);
    }

    // A notice that opens a thread leaves it without a preview or inbound stamps.
    out = await ingestMessage(msg(NOTICE, '2026-11-12T11:00:00Z'), { trackingRow: {}, conv: { ...base, id: 'c2' } });
    for (const k of ['last_preview', 'last_message_at', 'last_direction', 'last_inbound_at', 'first_inbound_at']) assert.strictEqual(out.conversation[k], undefined, k);
  } finally {
    global.fetch = realFetch;
  }
});

test('threadNeedsSync compares instants, not strings', () => {
  const { threadNeedsSync } = require('../sms');
  // CallRail's ISO stamp and PostgREST's rendering of the SAME instant: nothing new.
  assert.strictEqual(threadNeedsSync('2026-11-14T05:06:54.573Z', '2026-11-14T05:06:54.573+00:00'), false);
  assert.strictEqual(threadNeedsSync('2026-11-14T05:06:54Z', '2026-11-14T05:06:54+00:00'), false);
  assert.strictEqual(threadNeedsSync('2026-11-13T23:06:54.573-06:00', '2026-11-14T05:06:54.573+00:00'), false);
  // Newer at CallRail: read the thread.
  assert.strictEqual(threadNeedsSync('2026-11-14T05:07:00.000Z', '2026-11-14T05:06:54.573+00:00'), true);
  // Older at CallRail (we stored a later webhook): nothing to read.
  assert.strictEqual(threadNeedsSync('2026-11-14T05:00:00.000Z', '2026-11-14T05:06:54.573+00:00'), false);
  // Never read: read it, with or without a CallRail stamp.
  assert.strictEqual(threadNeedsSync('2026-11-14T05:00:00.000Z', null), true);
  assert.strictEqual(threadNeedsSync(null, null), true);
  // Our stamp never moved (Google relay notice) but we already read it at this CallRail stamp: once is enough.
  const at = Date.parse('2026-11-14T05:00:00.000Z');
  assert.strictEqual(threadNeedsSync('2026-11-14T05:00:00.000Z', null, at), false);
  assert.strictEqual(threadNeedsSync('2026-11-14T05:00:00.000Z', '2026-11-13T01:00:00+00:00', at), false);
  assert.strictEqual(threadNeedsSync('2026-11-14T05:00:01.000Z', '2026-11-13T01:00:00+00:00', at), true);
  // No stamp from CallRail on a thread we hold: leave it.
  assert.strictEqual(threadNeedsSync(null, '2026-11-13T01:00:00+00:00'), false);
});
