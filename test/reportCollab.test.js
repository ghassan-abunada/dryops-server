// Shared report drafts (reportCollab.js): two technicians on one visit, run
// against a small in-memory stand-in for the visit_report_parts table.
const test = require('node:test');
const assert = require('node:assert');
const createReportCollab = require('../reportCollab');
const { crewFromParts, crewLine } = createReportCollab;

// ── a tiny PostgREST for one table ───────────────────────────────────────────
function fakeDb() {
  const rows = [];
  const cond = (expr) => {
    // "col=op.value" or "or=(a,b)"
    const [col, rest] = [expr.slice(0, expr.indexOf('=')), expr.slice(expr.indexOf('=') + 1)];
    if (col === 'or') { const parts = rest.slice(1, -1).split(',').map((p) => { const i = p.indexOf('.'); return cond(`${p.slice(0, i)}=${p.slice(i + 1)}`); }); return (r) => parts.some((f) => f(r)); }
    const [op, ...v] = rest.split('.'); const val = decodeURIComponent(v.join('.'));
    if (op === 'eq') return (r) => String(r[col]) === val;
    if (op === 'neq') return (r) => String(r[col]) !== val;
    if (op === 'is') return (r) => (val === 'null' ? r[col] == null : r[col] === (val === 'true'));
    throw new Error(`unsupported filter ${expr}`);
  };
  const match = (qs) => { const fs = qs.split('&').filter((x) => x && !x.startsWith('select=') && !x.startsWith('on_conflict=')).map(cond); return (r) => fs.every((f) => f(r)); };
  const res = (body, ok = true) => ({ ok, status: ok ? 200 : 400, text: async () => JSON.stringify(body), json: async () => body });
  global.fetch = async (url, opts = {}) => {
    const qs = decodeURI(url.split('?')[1] || '').replace(/%3A/gi, ':');
    const method = opts.method || 'GET';
    if (method === 'POST') {
      const row = { owner_id: null, owner_name: null, done: false, removed: false, data: {}, ...JSON.parse(opts.body) };
      const i = rows.findIndex((r) => r.visit_id === row.visit_id && r.part_key === row.part_key);
      if (i < 0) rows.push(row);
      else if (/merge-duplicates/.test(opts.headers.Prefer)) rows[i] = { ...rows[i], ...JSON.parse(opts.body) };
      return res([]);
    }
    if (method === 'PATCH') { const hit = rows.filter(match(qs)); for (const r of hit) Object.assign(r, JSON.parse(opts.body)); return res(hit); }
    if (method === 'DELETE') { const f = match(qs); for (let i = rows.length - 1; i >= 0; i--) if (f(rows[i])) rows.splice(i, 1); return res([]); }
    return res(rows.filter(match(qs)));
  };
  const sbGet = async (pathAndQuery) => rows.filter(match(decodeURI(pathAndQuery.split('?')[1] || '').replace(/%3A/gi, ':'))).map((r) => ({ ...r }));
  return { rows, sbGet };
}

const VISIT = { id: 'v1', task_type: 'demo', report_submitted_at: null, demo_report_submitted_at: null };
const A = { id: 'a', name: 'Andrew Carbaugh' };
const B = { id: 'b', name: 'Kyson Arrington' };
const room = (name, extra = {}) => ({ name, ...extra });

function setup() {
  const db = fakeDb();
  const collab = createReportCollab({ SUPABASE_URL: 'http://db', SB_JSON_HEADERS: {}, sbGet: db.sbGet });
  const sync = async (actor, body = {}, visit = VISIT) => (await collab.sync({ visit, actor, body: { base: null, ...body } })).body;
  return { db, collab, sync };
}

test('the first technician in leads; the second is a helper and cannot write the general answers', async () => {
  const { sync } = setup();
  const a = await sync(A, {});
  assert.strictEqual(a.lead.id, 'a');
  const b = await sync(B, { top: { data: { antimicrobial: true }, steps: ['antimicrobial'] } });
  assert.strictEqual(b.lead.id, 'a');
  assert.strictEqual(b.top, null, 'a helper cannot write top');
  const a2 = await sync(A, { top: { data: { antimicrobial: false }, steps: ['antimicrobial'] } });
  assert.deepStrictEqual(a2.top.data, { antimicrobial: false });
  assert.deepStrictEqual(a2.techs.map((t) => t.id).sort(), ['a', 'b']);
  const b2 = await sync(B, {});
  assert.deepStrictEqual(b2.top.steps, ['antimicrobial']);
});

test('rooms: announce, claim, save, finish — and a second claim is refused until forced', async () => {
  const { sync } = setup();
  await sync(A, { add_rooms: [{ key: 'kitchen', data: room('Kitchen') }, { key: 'hallway', data: room('Hallway') }] });
  const b = await sync(B, { claims: [{ key: 'hallway', force: false, data: room('Hallway') }] });
  assert.strictEqual(b.rooms.find((r) => r.key === 'hallway').owner_id, 'b');
  assert.deepStrictEqual(b.rejected, []);

  const a = await sync(A, { claims: [{ key: 'hallway', force: false, data: room('Hallway') }] });
  assert.deepStrictEqual(a.rejected, [{ key: 'hallway', reason: 'claimed', owner_name: 'Kyson Arrington' }]);

  const b2 = await sync(B, { rooms: [{ key: 'hallway', data: room('Hallway', { lf: 20 }), steps: ['room:hallway:floor'], done: true }] });
  const h = b2.rooms.find((r) => r.key === 'hallway');
  assert.deepStrictEqual(h.data, { name: 'Hallway', lf: 20 });
  assert.strictEqual(h.done, true);

  // A cannot write B's room without taking it over …
  const a2 = await sync(A, { rooms: [{ key: 'hallway', data: room('Hallway', { lf: 1 }), done: false }] });
  assert.deepStrictEqual(a2.rejected.map((x) => x.reason), ['taken']);
  assert.deepStrictEqual(a2.rooms.find((r) => r.key === 'hallway').data, { name: 'Hallway', lf: 20 });
  // … and a forced claim keeps B's answers.
  const a3 = await sync(A, { claims: [{ key: 'hallway', force: true, data: room('Hallway') }] });
  const taken = a3.rooms.find((r) => r.key === 'hallway');
  assert.strictEqual(taken.owner_id, 'a');
  assert.deepStrictEqual(taken.data, { name: 'Hallway', lf: 20 });
  assert.strictEqual(taken.done, false);
  const b3 = await sync(B, { rooms: [{ key: 'hallway', data: room('Hallway', { lf: 99 }), done: true }] });
  assert.deepStrictEqual(b3.rejected.map((x) => x.reason), ['taken']);
});

test('removing a room: only when nobody else is on it; re-adding brings it back', async () => {
  const { sync } = setup();
  await sync(A, { add_rooms: [{ key: 'kitchen', data: room('Kitchen') }, { key: 'bath', data: room('Bath') }] });
  await sync(B, { claims: [{ key: 'kitchen', force: false, data: room('Kitchen') }] });
  const a = await sync(A, { removes: ['kitchen', 'bath'] });
  assert.deepStrictEqual(a.rejected, [{ key: 'kitchen', reason: 'claimed', owner_name: 'Kyson Arrington' }]);
  assert.strictEqual(a.rooms.find((r) => r.key === 'bath').removed, true);
  assert.strictEqual(a.rooms.find((r) => r.key === 'kitchen').removed, false);
  const a2 = await sync(A, { add_rooms: [{ key: 'bath', data: room('Bath'), readd: true }] });
  assert.strictEqual(a2.rooms.find((r) => r.key === 'bath').removed, false);
});

test('taking over the lead, and a submit ends the draft for everyone', async () => {
  const { sync, collab, db } = setup();
  await sync(A, { add_rooms: [{ key: 'kitchen', data: room('Kitchen') }] });
  await sync(B, { claims: [{ key: 'kitchen', force: false, data: room('Kitchen') }] });
  const b = await sync(B, { take_lead: true, top: { data: { notes: 'x' }, steps: [] } });
  assert.strictEqual(b.lead.id, 'b');
  assert.deepStrictEqual(b.top.data, { notes: 'x' });

  const crew = await collab.finish('v1');
  assert.deepStrictEqual(crew, [{ name: 'Kyson Arrington', lead: true, rooms: ['Kitchen'] }]);
  assert.deepStrictEqual(db.rows.map((r) => r.part_key), ['crew']);
  assert.deepStrictEqual(await collab.crewFor('v1'), crew);

  // A's phone still has the old "never submitted" base: it is told the report is in.
  const after = await sync(A, {}, { ...VISIT, demo_report_submitted_at: '2026-11-11T15:00:00+00:00', demo_report_by_name: 'Kyson Arrington' });
  assert.deepStrictEqual(after.submitted, { at: '2026-11-11T15:00:00+00:00', by: 'Kyson Arrington' });
  assert.strictEqual(after.rooms, undefined);
  // A phone that loaded the submitted report (same instant, other spelling) starts a fresh draft.
  const fresh = await sync(A, { base: '2026-11-11T15:00:00.000Z' }, { ...VISIT, demo_report_submitted_at: '2026-11-11T15:00:00+00:00' });
  assert.strictEqual(fresh.lead.id, 'a');
});

test('crew line for the JobNimbus note', () => {
  const parts = [
    { part_key: 'lead', owner_id: 'a', owner_name: 'Andrew Carbaugh' },
    { part_key: 'room:kitchen', owner_id: 'a', owner_name: 'Andrew Carbaugh', data: { v: { name: 'Kitchen' } } },
    { part_key: 'room:hallway', owner_id: 'b', owner_name: 'Kyson Arrington', data: { v: { name: 'Hallway' } } },
    { part_key: 'room:bath', owner_id: 'b', owner_name: 'Kyson Arrington', data: { v: { name: 'Bath' } } },
    { part_key: 'room:gone', owner_id: 'b', owner_name: 'Kyson Arrington', removed: true, data: { v: { name: 'Gone' } } },
    { part_key: 'tech:a', owner_id: 'a', owner_name: 'Andrew Carbaugh' },
  ];
  const crew = crewFromParts(parts);
  assert.strictEqual(crewLine(crew), 'Crew: Andrew Carbaugh (lead) — Kitchen · Kyson Arrington — Hallway, Bath');
  assert.strictEqual(crewLine(crew.slice(0, 1)), '', 'a solo report adds no line');
});
