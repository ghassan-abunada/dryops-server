// Call pushes (callAlerts.js): who gets which push for which call, the push
// copy, the once-per-call claim and the shared Expo sender (push.js).
// Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const callAlerts = require('../callAlerts');
const createPush = require('../push');
const { recipientsFor, ownerAlertEligible, managerReviewKind, ownerMessage, managerMessage, createCallAlerts } = callAlerts;

const LOC = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const base = { callrail_id: 'CAL123', direction: 'inbound', location_id: LOC, job_id: null, customer_name: 'Jane Smith', customer_phone_number: '+14695550101' };

test('ownerAlertEligible: ringing inbound new caller at a known location only', () => {
  assert.strictEqual(ownerAlertEligible(base, true), true);
  assert.strictEqual(ownerAlertEligible(base, false), false, 'finished calls are not alerts');
  assert.strictEqual(ownerAlertEligible({ ...base, job_id: 'j1' }, true), false, 'existing job → not a new caller');
  assert.strictEqual(ownerAlertEligible({ ...base, location_id: null }, true), false, 'unassigned number');
  assert.strictEqual(ownerAlertEligible({ ...base, direction: 'outbound' }, true), false);
});

test('managerReviewKind: missed always, answered first-timers once the recording exists', () => {
  assert.strictEqual(managerReviewKind({ ...base, answered: false, duration: 0 }), 'missed');
  assert.strictEqual(managerReviewKind({ ...base, answered: true, voicemail: true, duration: 30 }), 'missed');
  assert.strictEqual(managerReviewKind({ ...base, answered: true, first_call: true, duration: 120 }, { hasRecording: true }), 'answered');
  assert.strictEqual(managerReviewKind({ ...base, answered: true, first_call: true, duration: 120 }), 'wait');
  assert.strictEqual(managerReviewKind({ ...base, answered: true, first_call: false, duration: 120 }, { hasRecording: true }), null, 'repeat caller');
  assert.strictEqual(managerReviewKind({ ...base }), null, 'not finished yet');
  assert.strictEqual(managerReviewKind({ ...base, answered: false }, { preCall: true }), null);
  assert.strictEqual(managerReviewKind({ ...base, location_id: null, answered: false, duration: 0 }), null);
  assert.strictEqual(managerReviewKind({ ...base, direction: 'outbound', answered: false, duration: 0 }), null);
});

test('recipientsFor: role + assigned location, minus people who switched it off', () => {
  const profiles = [
    { id: 'o1', role: 'owner', location_ids: [LOC] },
    { id: 'o2', role: 'owner', location_id: LOC, location_ids: [] },
    { id: 'o3', role: 'owner', location_ids: [OTHER] },
    { id: 'm1', role: 'expansion_manager', location_ids: [LOC, OTHER] },
    { id: 'm2', role: 'expansion_manager', location_ids: [OTHER] },
    { id: 'a1', role: 'admin', location_ids: [LOC] },
  ];
  assert.deepStrictEqual(recipientsFor(profiles, LOC, 'owner', [], 'call_alerts'), ['o1', 'o2']);
  assert.deepStrictEqual(recipientsFor(profiles, LOC, 'owner', [{ profile_id: 'o2', call_alerts: false }], 'call_alerts'), ['o1']);
  assert.deepStrictEqual(recipientsFor(profiles, LOC, 'owner', [{ profile_id: 'o2', call_reviews: false }], 'call_alerts'), ['o1', 'o2'], 'other switch ignored');
  assert.deepStrictEqual(recipientsFor(profiles, LOC, 'expansion_manager', [], 'call_reviews'), ['m1'], 'a manager of other locations only is never pushed');
  assert.deepStrictEqual(recipientsFor(profiles, null, 'owner', [], 'call_alerts'), []);
  // Admins too (owner 2026-11-03), only where they are assigned.
  assert.deepStrictEqual(recipientsFor(profiles, LOC, callAlerts.OWNER_ROLES, [], 'call_alerts'), ['o1', 'o2', 'a1']);
  assert.deepStrictEqual(recipientsFor(profiles, LOC, callAlerts.MANAGER_ROLES, [], 'call_reviews'), ['m1', 'a1']);
  assert.deepStrictEqual(recipientsFor(profiles, OTHER, callAlerts.OWNER_ROLES, [], 'call_alerts'), ['o3']);
});

test('push copy: no company name, deep link to the call screen', () => {
  const o = ownerMessage(base, 'A1 Dallas (A1 - DAL)');
  assert.strictEqual(o.title, 'New caller · A1 Dallas');
  assert.match(o.body, /^Jane Smith \(469\) 555-0101 is calling/);
  assert.deepStrictEqual(o.data, { kind: 'call_alert', callrail_id: 'CAL123', url: '/calls/CAL123?mode=owner' });
  const m = managerMessage({ ...base, duration: 245 }, 'A1 Dallas', 'answered');
  assert.strictEqual(m.title, 'Call to review · A1 Dallas');
  assert.match(m.body, /Jane Smith · new caller · 4 min/);
  assert.strictEqual(m.data.url, '/calls/CAL123?mode=review');
  assert.match(managerMessage({ ...base, voicemail: true }, null, 'missed').body, /left a voicemail/);
  assert.strictEqual(managerMessage({ ...base }, null, 'missed').title, 'Missed call');
});

// Minimal Supabase + Expo stand-in for the runtime.
function harness({ owners = [{ id: 'o1', role: 'owner', location_ids: [LOC] }], managers = [], calls = {}, prefs = [] } = {}) {
  const claimed = new Set();
  const sent = [];
  const sbGet = async (q) => {
    if (q.startsWith('profiles?')) return decodeURIComponent(q).includes('owner') ? owners : managers;
    if (q.startsWith('locations?')) return [{ name: 'A1 Dallas' }];
    if (q.startsWith('push_prefs?')) return prefs;
    if (q.startsWith('push_tokens?')) {
      const ids = decodeURIComponent(q.match(/profile_id=in\.\(([^)]*)\)/)[1]).split(',');
      return [{ token: 'ExponentPushToken[abc]', profile_id: 'o1' }, { token: 'ExponentPushToken[m]', profile_id: 'm1' }].filter((t) => ids.includes(t.profile_id));
    }
    if (q.startsWith('calls?')) { const id = decodeURIComponent(q.match(/callrail_id=eq\.([^&]+)/)[1]); return calls[id] ? [calls[id]] : []; }
    return [];
  };
  const fetchImpl = async (url, opts) => {
    if (url.includes('/call_push_log')) {
      const row = JSON.parse(opts.body);
      const key = `${row.callrail_id}:${row.kind}`;
      const fresh = !claimed.has(key);
      claimed.add(key);
      return { ok: true, json: async () => (fresh ? [row] : []) };
    }
    if (url.includes('exp.host')) {
      const batch = JSON.parse(opts.body);
      sent.push(...batch);
      return { ok: true, json: async () => ({ data: batch.map(() => ({ status: 'ok' })) }) };
    }
    return { ok: true, json: async () => [] };
  };
  const quiet = { log() {}, warn() {}, error() {} };
  const push = createPush({ SUPABASE_URL: 'https://sb', SUPABASE_SERVICE_KEY: 'k', sbGet, fetchImpl, env: {}, log: quiet });
  const alerts = createCallAlerts({ SUPABASE_URL: 'https://sb', SUPABASE_SERVICE_KEY: 'k', sbGet, push, fetchImpl, log: quiet });
  return { alerts, sent };
}

test('owner alert sends once per call even when CallRail retries the pre-call', async () => {
  const { alerts, sent } = harness();
  await alerts.onCallEvent(base, { preCall: true });
  await alerts.onCallEvent(base, { preCall: true });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].title, 'New caller · A1 Dallas');
  assert.strictEqual(sent[0].data.url, '/calls/CAL123?mode=owner');
});

test('owner alert skips owners who switched alerts off', async () => {
  const { alerts, sent } = harness({ prefs: [{ profile_id: 'o1', call_alerts: false }] });
  const out = await alerts.onCallEvent(base, { preCall: true });
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(out.reason, 'no owners');
});

test('manager review: missed call pushes once; repeat answered caller does not', async () => {
  const missed = { ...base, callrail_id: 'CALM', answered: false, voicemail: false, duration: 0 };
  const repeat = { ...base, callrail_id: 'CALR', answered: true, first_call: false, duration: 90, recording_url: 'x' };
  const { alerts, sent } = harness({ managers: [{ id: 'm1', role: 'expansion_manager', location_ids: [LOC] }], calls: { CALM: missed, CALR: repeat } });
  await alerts.onCallEvent(missed, { preCall: false });
  await alerts.onCallEvent(missed, { preCall: false });
  await alerts.onCallEvent(repeat, { preCall: false });
  // Once each: the owner's Call back push and the manager's review push; the repeat caller gets neither.
  assert.strictEqual(sent.length, 2);
  const owner = sent.find((m) => m.data.kind === 'call_missed');
  const manager = sent.find((m) => m.data.kind === 'call_review');
  assert.strictEqual(owner.categoryId, 'missed_call');
  assert.strictEqual(owner.data.url, '/calls/CALM?mode=owner');
  assert.strictEqual(manager.title, 'Missed call · A1 Dallas');
  assert.strictEqual(manager.data.url, '/calls/CALM?mode=review');
});

test('manager review: answered first-timer waits for the recording', async () => {
  const call = { ...base, callrail_id: 'CALA', answered: true, first_call: true, duration: 200, recording_url: null };
  const { alerts, sent } = harness({ managers: [{ id: 'm1', role: 'expansion_manager', location_ids: [LOC] }], calls: { CALA: call } });
  const out = await alerts.reviewCall('CALA', 99); // attempt past the retry list: no timer scheduled
  assert.deepStrictEqual(out, { waiting: true });
  assert.strictEqual(sent.length, 0);
  call.recording_url = 'https://rec';
  await alerts.reviewCall('CALA');
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].body, /new caller · 3 min/);
});

test('push.js: dry run sends nothing; dead tokens are pruned', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: opts.method });
    if (url.includes('exp.host')) return { ok: true, json: async () => ({ data: [{ status: 'ok' }, { status: 'error', details: { error: 'DeviceNotRegistered' } }] }) };
    return { ok: true, json: async () => [] };
  };
  const quiet = { log() {}, warn() {} };
  const dry = createPush({ SUPABASE_URL: 'https://sb', SUPABASE_SERVICE_KEY: 'k', sbGet: async () => [], fetchImpl, env: { PUSH_DRYRUN: '1' }, log: quiet });
  assert.strictEqual(await dry.send([{ to: 'ExponentPushToken[a]', title: 't' }]), 0);
  assert.strictEqual(calls.length, 0);
  const live = createPush({ SUPABASE_URL: 'https://sb', SUPABASE_SERVICE_KEY: 'k', sbGet: async () => [], fetchImpl, env: {}, log: quiet });
  const ok = await live.send([{ to: 'ExponentPushToken[a]', title: 't' }, { to: 'ExponentPushToken[dead]', title: 't' }]);
  assert.strictEqual(ok, 1);
  const del = calls.find((c) => c.method === 'DELETE');
  assert.ok(del && decodeURIComponent(del.url).includes('ExponentPushToken[dead]'));
  assert.deepStrictEqual(createPush.chunk([1, 2, 3], 2), [[1, 2], [3]]);
});

test('a ringing call that looks missed is not pushed as missed (2026-11-03 bug)', async () => {
  const { callSettled } = callAlerts;
  const now = Date.now();
  // CallRail's ringing delivery: answered false, duration 0, 2 seconds old → not over.
  assert.strictEqual(callSettled({ start_time: new Date(now - 2000).toISOString(), duration: 0 }, now), false);
  // A real miss, 90 seconds old → over.
  assert.strictEqual(callSettled({ start_time: new Date(now - 90 * 1000).toISOString(), duration: 0 }, now), true);
  // A 3-minute answered call only settles a minute after it ends.
  assert.strictEqual(callSettled({ start_time: new Date(now - 200 * 1000).toISOString(), duration: 180 }, now), false);
  assert.strictEqual(callSettled({ start_time: new Date(now - 260 * 1000).toISOString(), duration: 180 }, now), true);

  const ringing = { ...base, callrail_id: 'CALRING', answered: false, voicemail: false, duration: 0, start_time: new Date(now - 2000).toISOString() };
  const { alerts, sent } = harness({ managers: [{ id: 'm1', role: 'expansion_manager', location_ids: [LOC] }], calls: { CALRING: ringing } });
  const out = await alerts.reviewCall('CALRING', 99); // past the retry list: no timer
  assert.deepStrictEqual(out, { waiting: true, reason: 'not settled' });
  assert.strictEqual(sent.length, 0, 'nobody is told it was missed while it rings');
  // The post-call delivery says it is over: now it is a real miss.
  await alerts.reviewCall('CALRING', 0, { settled: true });
  assert.ok(sent.some((m) => m.title.startsWith('Missed call')));
});
