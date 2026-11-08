const test = require('node:test');
const assert = require('node:assert');
const fixture = require('./fixtures/commissionPayout.json');
const { computePayout } = require('../vendor/commissions/commissions/compute');
const { commissionPayday, commissionReminderDay, paydaysIn } = require('../vendor/commissions/commissions/payroll');
const { buildMessage, reminderDue, createReminder } = require('../commissionReminder');

// Same file and same summary as the app's lib/commissions/__tests__/fixture.test.ts:
// if the compiled rules here drift from the app's, this fails.
test('the compiled rules give the app\'s payout for the shared fixture', () => {
  const { next, split } = computePayout(fixture.feed, fixture.photo);
  assert.deepStrictEqual({
    gross: next.gross,
    total: next.total,
    applied: next.applied.map(l => [l.key, l.owed]),
    carried: next.carried.map(l => [l.key, l.owed]),
    split: split.map(s => [s.locationId, s.total]),
  }, fixture.expected);
});

test('payroll calendar: every other Friday from 10/23/2026, reminder the Tuesday before the first', () => {
  assert.deepStrictEqual(paydaysIn('2026-11'), ['2026-11-06', '2026-11-20']);
  assert.strictEqual(commissionPayday('2026-12'), '2026-12-04');
  assert.strictEqual(commissionReminderDay('2026-12'), '2026-12-01');
  // Fri 1/1/2027 would need the amount Tue 12/29, before December is over: next payroll.
  assert.strictEqual(commissionPayday('2027-01'), '2027-01-15');
  assert.strictEqual(commissionReminderDay('2027-01'), '2027-01-12');
});

test('due only on the reminder Tuesday from 8 AM Central', () => {
  // 2026-12-01 is a Tuesday; Central is UTC-6 in December.
  assert.strictEqual(reminderDue(new Date('2026-12-01T13:59:00Z')).due, false); // 7:59 AM
  assert.strictEqual(reminderDue(new Date('2026-12-01T14:00:00Z')).due, true);  // 8:00 AM
  assert.strictEqual(reminderDue(new Date('2026-12-02T05:59:00Z')).due, true);  // 11:59 PM Tue
  assert.strictEqual(reminderDue(new Date('2026-12-02T06:00:00Z')).due, false); // Wed
  assert.strictEqual(reminderDue(new Date('2026-12-15T15:00:00Z')).due, false); // second payroll's week
  assert.strictEqual(reminderDue(new Date('2026-12-29T15:00:00Z')).due, false); // not for Fri 1/1
  assert.strictEqual(reminderDue(new Date('2027-01-12T15:00:00Z')).due, true);  // Jan: before Fri 1/15
});

test('the message carries the amount, the payday, credits and the split', () => {
  const comp = computePayout(fixture.feed, fixture.photo);
  const m = buildMessage({ repName: 'Colt Smith', payoutMonth: '2026-12', comp, appUrl: 'https://dryops.app' });
  assert.strictEqual(m.amount, 350);
  assert.strictEqual(m.title, 'Commission for the Fri 12/4 payroll: $350');
  assert.match(m.body, /Add \$350 for Colt Smith/);
  assert.match(m.body, /after 2 credits/);
  assert.match(m.html, /Credits taken \(2\)/);
  assert.match(m.html, /A1 Restoration of Dallas/);
  assert.match(m.html, /https:\/\/dryops\.app\/commissions/);
});

test('nothing to pay still says so', () => {
  const comp = computePayout({ ...fixture.feed, jobs: [], payments: [] }, {});
  const m = buildMessage({ repName: 'Colt Smith', payoutMonth: '2026-12', comp, appUrl: 'https://dryops.app' });
  assert.strictEqual(m.amount, 0);
  assert.match(m.body, /Nothing to add for Colt Smith/);
});

function fakeDeps(overrides = {}) {
  const calls = { emails: [], pushes: [], logs: [] };
  const sbGet = async (q) => {
    if (q.startsWith('commission_reps')) return [{ profile_id: 'colt', rep_name: 'Colt Smith' }];
    if (q.startsWith('profiles?role=eq.admin')) return [{ id: 'gus' }];
    if (q.startsWith('commission_managers')) return [{ profile_id: 'mgr' }, { profile_id: 'colt' }];
    if (q.startsWith('commission_reminders')) return overrides.sent ? [{ id: 'x' }] : [];
    return [];
  };
  const realFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    if (url.includes('/rpc/commission_feed')) return new Response(JSON.stringify({ ...fixture.feed, rep: { rep_name: 'Colt Smith' } }));
    if (url.includes('/auth/v1/admin/users/')) return new Response(JSON.stringify({ email: `${url.split('/').pop()}@example.com` }));
    if (url.includes('/rest/v1/commission_reminders')) { calls.logs.push(JSON.parse(init.body)); return new Response('', { status: 201 }); }
    return realFetch(url, init);
  };
  const deps = {
    SUPABASE_URL: 'https://sb.example', SUPABASE_SERVICE_KEY: 'k', sbGet, appUrl: 'https://dryops.app',
    sendEmail: async (to, subject) => { calls.emails.push({ to, subject }); return { ok: true }; },
    push: { toProfiles: async (ids, msg) => { calls.pushes.push({ ids, msg }); return ids.length; } },
    jnGetJson: async () => ({ files: [] }),
    log: { log() {}, warn() {}, error() {} },
  };
  return { deps, calls, restore: () => { global.fetch = realFetch; } };
}

test('sends to admins and approved managers, never the rep, and logs it', async () => {
  const { deps, calls, restore } = fakeDeps();
  try {
    const r = createReminder(deps);
    const dry = await r.run({ dryrun: true });
    assert.strictEqual(dry[0].sent, false);
    assert.strictEqual(calls.emails.length, 0);
    const out = await r.run({ dryrun: false });
    assert.strictEqual(out[0].sent, true);
    assert.deepStrictEqual(calls.emails.map(e => e.to).sort(), ['gus@example.com', 'mgr@example.com']);
    assert.deepStrictEqual(calls.pushes[0].ids.sort(), ['gus', 'mgr']);
    assert.strictEqual(calls.pushes[0].msg.data.url, '/commissions');
    assert.strictEqual(calls.logs[0].amount, 350);
    assert.strictEqual(calls.logs[0].payout_month, '2026-12');
  } finally { restore(); }
});

test('does not send twice for the same payout', async () => {
  const { deps, calls, restore } = fakeDeps({ sent: true });
  try {
    const out = await createReminder(deps).run({ dryrun: false });
    assert.strictEqual(out[0].reason, 'already sent');
    assert.strictEqual(calls.emails.length + calls.pushes.length, 0);
  } finally { restore(); }
});
