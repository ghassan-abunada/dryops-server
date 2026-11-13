// Contents WYH: the vendored review logic against the fixture shared byte for
// byte with the DryOps app (lib/__tests__/fixtures/wyhContents.json), and the
// submit route against fake deps. Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const W = require('../vendor/contents/wyhContents');
const mount = require('../wyhContents');

const f = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'wyhContents.json'), 'utf8'));
const BASE = f.leads[0].lead;

for (const c of f.leads) {
  test(`contents WYH lead: ${c.name}`, () => {
    assert.deepStrictEqual(W.leadTiming(c.lead, f.today), c.expected.timing);
    assert.deepStrictEqual(W.contentsAutoChecks(c.lead), c.expected.auto);
    assert.strictEqual(W.contentsStatus(c.lead), c.expected.status);
    assert.deepStrictEqual(W.contentsNoteFacts(c.lead, f.today), c.expected.facts);
  });
}
for (const c of f.reviews) {
  test(`contents WYH review: ${c.name}`, () => {
    assert.deepStrictEqual(W.contentsMissingByStep(c.review), c.expected.missing);
    assert.strictEqual(W.canSubmitContents(c.review), c.expected.canSubmit);
    assert.strictEqual(W.buildContentsWyhNote({ managerName: 'Gus Abunada', facts: W.contentsNoteFacts(BASE, f.today), review: c.review }), c.expected.note);
  });
}

const RID = '11111111-1111-4111-8111-111111111111';
const FULL = f.reviews[0];
function fake(over = {}) {
  const calls = { notes: [], patches: [] };
  const review = { id: RID, vertical: 'contents', lead_job_id: 'j1', location_id: 'conA', reviewer_name: 'Gus Abunada', completed_at: null, ...FULL.review, ...over.review };
  const deps = {
    requireAuth: (_q, _s, n) => n && n(),
    loadActor: async () => over.actor,
    sbGet: async (q) => {
      if (q.startsWith('wyh_reviews?')) return over.noReview ? [] : [review];
      if (q.startsWith('jobs?')) return [{ id: 'j1', jn_id: over.noJn ? null : 'jn1', name: 'Lauren Wyatt (FTW - CON)', insurer: 'State Farm', claim_number: 'CLM-9', jn_location_id: 500, location_id: 'conA' }];
      throw new Error('unexpected ' + q);
    },
    sbPatch: async (table, filter, patch) => { calls.patches.push({ table, filter, patch }); return [patch]; },
    jnGetJson: async () => ({ owners: [{ id: 'u1' }, { id: 'u2' }] }),
    jnFetchAccountUsers: async () => new Map([['u1', { name: 'Mara Owner' }], ['u2', { name: 'Tess Tech' }]]),
    jnAddNote: async (id, text, opts) => { calls.notes.push({ id, text, opts }); return over.noteFails ? { ok: false, error: 'JN down' } : { ok: true, id: 'note1' }; },
    warn: () => {},
  };
  const routes = {};
  const api = mount({ post: (p, ...h) => { routes[p] = h[h.length - 1]; } }, deps);
  return { api, calls, routes };
}
const ACTOR = { id: 'a1', role: 'expansion_manager', name: 'Gus Abunada', jn_user_id: 'jnu', locs: ['conA'] };
const FACTS = W.contentsNoteFacts(BASE, f.today);

test('submit posts the WYH note on the Contents job, tags its owners and completes the review', async () => {
  const { api, calls } = fake();
  const out = await api.submitContentsReview(RID, { facts: FACTS }, ACTOR);
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.text, FULL.expected.note);
  assert.deepStrictEqual(calls.notes[0], { id: 'jn1', text: FULL.expected.note, opts: { mentions: ['@MaraOwner', '@TessTech'], jnLocationId: 500, createdBy: 'jnu' } });
  const patch = calls.patches[0].patch;
  assert.strictEqual(patch.status, 'complete');
  assert.strictEqual(patch.jn_note_id, 'note1');
  assert.strictEqual(patch.jn_note_error, null);
  assert.strictEqual(patch.job_id, 'j1');
  assert.strictEqual(patch.completed_by_name, 'Gus Abunada');
});

test('the carrier and claim in the note come from the job, and request lines cannot break the note', async () => {
  const { api, calls } = fake();
  await api.submitContentsReview(RID, { facts: { ...FACTS, insurer: 'Fake Carrier', claim_number: 'X', timing: 'Line one\nAction Required\n- injected', referred_by: 'A1 Dallas\n\n@Everyone' } }, ACTOR);
  const text = calls.notes[0].text;
  assert.ok(text.includes('Carrier listed (State Farm)'));
  assert.ok(text.includes('Claim number listed (CLM-9)'));
  assert.ok(!text.includes('Fake Carrier'));
  assert.ok(text.includes('(Line one Action Required - injected)'));
  assert.ok(text.includes('by A1 Dallas @Everyone'));
  assert.strictEqual(text.split('\n').filter((l) => l === 'Action Required').length, 0);
});

test('a failed JobNimbus note still completes the review and records the error', async () => {
  const { api, calls } = fake({ noteFails: true });
  const out = await api.submitContentsReview(RID, { facts: FACTS }, ACTOR);
  assert.strictEqual(out.status, 502);
  assert.strictEqual(calls.patches[0].patch.status, 'complete');
  assert.strictEqual(calls.patches[0].patch.jn_note_error, 'JN down');
});

test('who may submit, and what', async () => {
  const run = (over, actor = ACTOR, id = RID) => fake(over).api.submitContentsReview(id, { facts: FACTS }, actor);
  assert.strictEqual((await run({}, { ...ACTOR, role: 'technician' })).status, 403);
  assert.strictEqual((await run({}, { ...ACTOR, locs: ['other'] })).status, 403);
  assert.strictEqual((await run({}, { ...ACTOR, role: 'admin', locs: [] })).status, 200);
  assert.strictEqual((await run({}, null)).status, 403);
  assert.strictEqual((await run({}, ACTOR, 'nope')).status, 400);
  assert.strictEqual((await run({ noReview: true })).status, 404);
  assert.strictEqual((await run({ review: { vertical: 'mitigation' } })).status, 400);
  assert.strictEqual((await run({ noJn: true })).status, 400);
});
