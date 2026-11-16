// CallRail transcript → [{ speaker, text }] turns (callTranscript.js). Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const { normalizeTranscript, summaryText, MAX_CHARS } = require('../callTranscript');

test('nothing usable is null', () => {
  for (const raw of [null, undefined, '', '   \n ', [], {}, 42, true, [{ speaker: 'agent', phrase: '  ' }], { turns: [] }, { note: 'x' }]) {
    assert.strictEqual(normalizeTranscript(raw), null);
  }
});

test('a string without speaker labels is one turn with no speaker', () => {
  assert.deepStrictEqual(normalizeTranscript('  Hello, my kitchen\nflooded last night.  '), [
    { speaker: '', text: 'Hello, my kitchen flooded last night.' },
  ]);
});

test('a string splits on labels at line starts', () => {
  const raw = 'Agent: Thanks for calling.\nCaller: Hi, my basement flooded.\nAgent: When did it happen?';
  assert.deepStrictEqual(normalizeTranscript(raw), [
    { speaker: 'Agent', text: 'Thanks for calling.' },
    { speaker: 'Caller', text: 'Hi, my basement flooded.' },
    { speaker: 'Agent', text: 'When did it happen?' },
  ]);
});

test('a string splits on labels after sentence breaks, any case, and keeps Speaker N as written', () => {
  const raw = 'AGENT: Thanks for calling. caller: Hi there! customer : One more thing? Speaker 1: Yes. speaker  2: No.';
  assert.deepStrictEqual(normalizeTranscript(raw), [
    { speaker: 'Agent', text: 'Thanks for calling.' },
    { speaker: 'Caller', text: 'Hi there!' },
    { speaker: 'Customer', text: 'One more thing?' },
    { speaker: 'Speaker 1', text: 'Yes.' },
    { speaker: 'speaker 2', text: 'No.' },
  ]);
});

test('a label in the middle of a sentence is not a turn', () => {
  assert.deepStrictEqual(normalizeTranscript('Agent: I told the customer: we can be there at noon.'), [
    { speaker: 'Agent', text: 'I told the customer: we can be there at noon.' },
  ]);
});

test('text before the first label keeps an empty speaker', () => {
  assert.deepStrictEqual(normalizeTranscript('Ringing.\nAgent: Hello.'), [
    { speaker: '', text: 'Ringing.' },
    { speaker: 'Agent', text: 'Hello.' },
  ]);
});

test("CallRail's conversational_transcript array: speaker + phrase, same speaker merged", () => {
  const raw = [
    { speaker: 'agent', phrase: 'Thanks for calling.', start: 0.4 },
    { speaker: 'agent', phrase: 'How can I help?', start: 2.1 },
    { speaker: 'caller', phrase: 'My water heater burst.', start: 4.9 },
    { speaker: 'caller', phrase: '', start: 6 },
    { speaker: 'agent', phrase: 'We can come today.', start: 7.2 },
  ];
  assert.deepStrictEqual(normalizeTranscript(raw), [
    { speaker: 'Agent', text: 'Thanks for calling. How can I help?' },
    { speaker: 'Caller', text: 'My water heater burst.' },
    { speaker: 'Agent', text: 'We can come today.' },
  ]);
});

test('an array reads role / channel and text / content, and plain strings', () => {
  const raw = [{ role: 'Rep', text: 'Hi.' }, { channel: 'left', content: 'Hello.' }, 'loose line', null, { text: 'no speaker' }];
  assert.deepStrictEqual(normalizeTranscript(raw), [
    { speaker: 'Rep', text: 'Hi.' },
    { speaker: 'left', text: 'Hello.' },
    { speaker: '', text: 'loose line no speaker' },
  ]);
});

test('an object with a nested array uses that array', () => {
  const want = [{ speaker: 'Agent', text: 'Hi.' }, { speaker: 'Caller', text: 'Hello.' }];
  const arr = [{ speaker: 'agent', text: 'Hi.' }, { speaker: 'caller', text: 'Hello.' }];
  for (const key of ['conversation', 'turns', 'phrases', 'somethingElse']) {
    assert.deepStrictEqual(normalizeTranscript({ id: 1, [key]: arr }), want);
  }
  assert.deepStrictEqual(normalizeTranscript({ text: 'Agent: Hi.\nCaller: Hello.' }), want);
});

test('total text is capped', () => {
  const long = normalizeTranscript('x'.repeat(MAX_CHARS + 500));
  assert.strictEqual(long.length, 1);
  assert.strictEqual(long[0].text.length, MAX_CHARS);
  const many = normalizeTranscript(Array.from({ length: 50 }, (_, i) => ({ speaker: i % 2 ? 'agent' : 'caller', phrase: 'y'.repeat(2000) })));
  const total = many.reduce((n, t) => n + t.text.length, 0);
  assert.ok(total <= MAX_CHARS);
  assert.strictEqual(many.length, 30);
});

test('summaryText reads a string or an array', () => {
  assert.strictEqual(summaryText('  The caller had a leak. '), 'The caller had a leak.');
  assert.strictEqual(summaryText(['One.', { text: 'Two.' }, { summary: 'Three.' }, null]), 'One. Two. Three.');
  assert.strictEqual(summaryText(''), null);
  assert.strictEqual(summaryText([]), null);
  assert.strictEqual(summaryText(null), null);
  assert.strictEqual(summaryText({ a: 1 }), null);
});
