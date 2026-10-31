// Push summary for inbound texts (pushSummary.js). Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const { makeSummarizer, prepare, parseLsa, clip } = require('../pushSummary');

const LSA = `You have received a new message from a customer via Google Local Services Ads.

Customer name: Dana R, Location: McKinney

Service: water_damage_cleanup_repair

Message: Plumbing leak Q: How large is the damaged area? A: Just one room Q: Is there currently standing water? A: Yes, shallow puddles. [Notes from LSA: (1) This customer has requested a quote].`;
const RELAY = 'Replies to this number will be sent to the customer. You can also choose to call the customer through this number (or respond via LSA dashboard: https://g.co/homeservices/wT49a)';

test('relay notice: no push', async () => {
  assert.deepStrictEqual(prepare({ content: RELAY }), { skip: true });
  const s = makeSummarizer({ provider: { classify: async () => { throw new Error('must not call'); } } });
  assert.strictEqual(await s({ customerName: 'Google LSA customer', content: RELAY }), null);
});

test('LSA lead: name from the template, Google lead title, facts + quote in the fallback', () => {
  const l = parseLsa(LSA);
  assert.strictEqual(l.name, 'Dana R');
  assert.strictEqual(l.location, 'McKinney');
  assert.strictEqual(l.serviceLabel, 'Water damage cleanup');
  assert.deepStrictEqual(l.notes, ['Requested a quote']);
  const p = prepare({ customerName: 'Google LSA customer', content: LSA });
  assert.strictEqual(p.title, 'Dana R · Google lead');
  assert.ok(p.summarize);
  assert.match(p.input, /Customer wrote: Plumbing leak/);
  assert.match(p.input, /Google notes: Requested a quote/);
  assert.ok(p.body.length <= 140);
});

test('LSA lead: model summary becomes the body', async () => {
  let seen;
  const s = makeSummarizer({ provider: { classify: async (t) => { seen = t; return { parsed: { summary: 'Plumbing leak, one room, shallow standing water — wants a quote' } }; } } });
  const r = await s({ customerName: 'Google LSA customer', content: LSA });
  assert.deepStrictEqual(r, { title: 'Dana R · Google lead', body: 'Plumbing leak, one room, shallow standing water — wants a quote' });
  assert.match(seen, /McKinney/);
});

test('short text goes out as is without a model call', async () => {
  const s = makeSummarizer({ provider: { classify: async () => { throw new Error('must not call'); } } });
  assert.deepStrictEqual(await s({ customerName: 'Ben K', content: 'Ok see you at 2' }), { title: 'Ben K', body: 'Ok see you at 2' });
});

test('model failure or timeout falls back to the clipped text', async () => {
  const long = 'Hi there, we had a pipe burst under the kitchen sink last night and the water went into the hallway and the living room carpet is soaked, can someone come today?';
  const bad = makeSummarizer({ provider: { classify: async () => { throw new Error('429'); } } });
  const r1 = await bad({ customerName: null, phoneLabel: '(214) 555-0100', content: long });
  assert.strictEqual(r1.title, '(214) 555-0100');
  assert.ok(r1.body.endsWith('…') && r1.body.length <= 140);
  const slow = makeSummarizer({ timeoutMs: 20, provider: { classify: () => new Promise((r) => setTimeout(() => r({ parsed: { summary: 'late' } }), 200)) } });
  assert.strictEqual((await slow({ customerName: 'X', content: long })).body, r1.body);
});

test('photo-only text', () => {
  assert.strictEqual(prepare({ customerName: 'X', content: '', mediaUrls: ['a', 'b'] }).body, 'Sent 2 photos');
});

test('clip cuts on a word', () => {
  assert.strictEqual(clip('water in the kitchen and hallway', 26), 'water in the kitchen and…');
});
