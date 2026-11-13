// Schedule pushes (visitPush.js). Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const { createVisitPush, snapshot, diffVisitPush, composePush, buildItem, windowLabel, dayLabel } = require('../visitPush');

const NOW = new Date('2026-11-13T15:00:00Z');
const visit = (over = {}) => ({
  id: 'v1', status: 'scheduled', scheduled_date: '2026-11-17', slot_start_min: 480, slot_end_min: 600,
  assigned_to_ids: ['a', 'b'], task_type: 'monitor', jobs: { client_name: 'Smith Residence', name: 'DAL - 123' }, ...over,
});
const kinds = (events) => events.map((e) => `${e.profileId}:${e.kind}`).sort();

test('labels', () => {
  assert.strictEqual(windowLabel(480, 600), '8–10 AM');
  assert.strictEqual(windowLabel(660, 780), '11 AM–1 PM');
  assert.strictEqual(windowLabel(870, 990), '2:30–4:30 PM');
  assert.strictEqual(windowLabel(null, null), '');
  assert.strictEqual(dayLabel('2026-11-17'), 'Tue, Nov 17');
});

test('a new visit tells everyone on it', () => {
  assert.deepStrictEqual(kinds(diffVisitPush(null, snapshot(visit()), { now: NOW })), ['a:assigned', 'b:assigned']);
});

test('reassigning tells the person added and the person taken off, not the one who stays', () => {
  const prev = snapshot(visit());
  const cur = snapshot(visit({ assigned_to_ids: ['a', 'c'] }));
  const events = diffVisitPush(prev, cur, { now: NOW });
  assert.deepStrictEqual(kinds(events), ['b:removed', 'c:assigned']);
});

test('a removal quotes the time the person knew', () => {
  const prev = snapshot(visit());
  const moved = visit({ assigned_to_ids: ['a'], scheduled_date: '2026-11-18', slot_start_min: 720, slot_end_min: 840 });
  const [e] = diffVisitPush(prev, snapshot(moved), { now: NOW });
  assert.strictEqual(e.kind, 'removed');
  assert.strictEqual(buildItem(e, moved).line, 'Monitor · Smith Residence · Tue, Nov 17 · 8–10 AM');
});

test('cancelling tells everyone who was on it; restoring tells them again', () => {
  const prev = snapshot(visit());
  const cancelled = snapshot(visit({ status: 'cancelled' }));
  assert.deepStrictEqual(kinds(diffVisitPush(prev, cancelled, { now: NOW })), ['a:cancelled', 'b:cancelled']);
  assert.deepStrictEqual(kinds(diffVisitPush(cancelled, prev, { now: NOW })), ['a:assigned', 'b:assigned']);
});

test('no push: a time-only change, a completed visit, a past visit, a cancelled visit nobody knew', () => {
  const prev = snapshot(visit());
  assert.deepStrictEqual(diffVisitPush(prev, snapshot(visit({ slot_start_min: 600, slot_end_min: 720 })), { now: NOW }), []);
  assert.deepStrictEqual(diffVisitPush(prev, snapshot(visit({ status: 'completed' })), { now: NOW }), []);
  assert.deepStrictEqual(diffVisitPush(null, snapshot(visit({ scheduled_date: '2026-11-10' })), { now: NOW }), []);
  assert.deepStrictEqual(diffVisitPush(null, snapshot(visit({ status: 'cancelled' })), { now: NOW }), []);
});

test('the person who made the change is not told', () => {
  assert.deepStrictEqual(kinds(diffVisitPush(null, snapshot(visit()), { now: NOW, skipProfileId: 'a' })), ['b:assigned']);
});

test('one visit: its own title, line and a tap to that day', () => {
  const v = visit();
  const [e] = diffVisitPush(null, snapshot(v), { now: NOW });
  assert.deepStrictEqual(composePush([buildItem(e, v)]), {
    title: 'New visit assigned',
    body: 'Monitor · Smith Residence · Tue, Nov 17 · 8–10 AM',
    data: { kind: 'visit', url: '/schedule?date=2026-11-17', visit_id: 'v1' },
  });
});

test('other visit types use their typed name', () => {
  const v = visit({ task_type: 'other', task_label: 'Estimate walk-through' });
  const [e] = diffVisitPush(null, snapshot(v), { now: NOW });
  assert.match(buildItem(e, v).line, /^Estimate walk-through · /);
});

function harness(rows) {
  const sent = [];
  const patches = [];
  const vp = createVisitPush({
    push: { toProfiles: async (ids, msg) => { sent.push({ to: ids[0], ...msg }); return 1; } },
    sbGet: async (q) => {
      const id = /id=eq\.([^&]+)/.exec(q)[1];
      if (!(id in rows)) return [];
      return [{ push_state: rows[id] }];
    },
    sbPatch: async (_t, where, body) => { const id = /id=eq\.(.+)$/.exec(where)[1]; rows[id] = body.push_state; patches.push(id); return [{}]; },
    holdMs: 60000, log: { warn() {} }, now: () => NOW,
  });
  return { vp, sent, patches, rows };
}

test('a published run is one push per person; a second sync of the same row sends nothing', async () => {
  const h = harness({ v1: null, v2: null, v3: null });
  for (const id of ['v1', 'v2', 'v3']) await h.vp.onVisitSynced(visit({ id, assigned_to_ids: ['a'] }));
  await h.vp.onVisitSynced(visit({ id: 'v1', assigned_to_ids: ['a'] }));
  await h.vp.flush();
  assert.strictEqual(h.sent.length, 1);
  assert.strictEqual(h.sent[0].to, 'a');
  assert.strictEqual(h.sent[0].title, 'Schedule updated');
  assert.strictEqual(h.sent[0].body, '3 visits: 3 assigned · Tue, Nov 17');
  assert.deepStrictEqual(h.patches, ['v1', 'v2', 'v3']);
});

test('assigned then taken off inside the hold: no push', async () => {
  const h = harness({ v1: null });
  await h.vp.onVisitSynced(visit({ assigned_to_ids: ['a'] }));
  await h.vp.onVisitSynced(visit({ assigned_to_ids: [] }));
  await h.vp.flush();
  assert.strictEqual(h.sent.length, 0);
});

test('reassign end to end: actor skipped, snapshot stored', async () => {
  const h = harness({ v1: snapshot(visit()) });
  const r = await h.vp.onVisitSynced(visit({ assigned_to_ids: ['a', 'c'] }), { actorId: 'c' });
  await h.vp.flush();
  assert.strictEqual(r.events, 1);
  assert.deepStrictEqual(h.sent.map((m) => [m.to, m.title]), [['b', 'Taken off a visit']]);
  assert.deepStrictEqual(h.rows.v1.ids, ['a', 'c']);
});

test('column missing: off, no throw, asked once', async () => {
  let asks = 0;
  const vp = createVisitPush({
    push: { toProfiles: async () => { throw new Error('must not send'); } },
    sbGet: async () => { asks += 1; throw new Error('column inspections.push_state does not exist'); },
    sbPatch: async () => { throw new Error('must not patch'); },
    log: { warn() {} },
  });
  assert.deepStrictEqual(await vp.onVisitSynced(visit()), { events: 0, disabled: true });
  assert.deepStrictEqual(await vp.onVisitSynced(visit()), { events: 0 });
  assert.strictEqual(asks, 1);
});
