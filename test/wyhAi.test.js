// WYH AI reviewer: the pure pieces (prompt assembly, accuracy, cleanup). Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const { buildSystemPrompt, accuracyFrom, cleanSuggestions, sample, BASE_PROMPT, WyhSuggestionSchema } = require('../wyhAi');

test('house rules and lessons are folded into the system prompt', () => {
  const feedback = [
    { question: 'landed', suggested: { value: true }, final: { value: false }, reason: 'Signed WA is not landed until equipment is placed' },
    { question: 'tested', suggested: { value: false }, final: { value: true }, reason: null },
  ];
  const p = buildSystemPrompt(BASE_PROMPT, { instructions: 'Never mark landed from the status alone.' }, feedback.filter(f => f.reason), accuracyFrom([
    ...Array(8).fill({ question: 'packout_sold', accepted: false }), ...Array(2).fill({ question: 'packout_sold', accepted: true }),
  ]));
  assert.ok(p.startsWith(BASE_PROMPT));
  assert.ok(p.includes('House rules from the owner'));
  assert.ok(p.includes('Never mark landed from the status alone.'));
  assert.ok(p.includes('- landed: suggested true, the manager chose false — "Signed WA is not landed until equipment is placed"'));
  assert.ok(p.includes('packout_sold (20% accepted)'));
  // No rules, no lessons → just the base prompt.
  assert.strictEqual(buildSystemPrompt(BASE_PROMPT, { instructions: '  ' }, [], {}), BASE_PROMPT);
});

test('cleanSuggestions clamps, validates and blanks the checklist for a no-job call', () => {
  const llm = WyhSuggestionSchema.parse({
    call_taken_by_name: { value: 'Tarek', confidence: 1.4, why: 'x'.repeat(300) }, call_handled: { value: false, confidence: 0.8, why: 'gave price' }, call_missed_reason: 'Quoted $2,000',
    walked: { value: 'not_yet', confidence: 0.9, why: null }, walk_reason: 'scheduled_later', walk_scheduled_for: 'tomorrow',
    landed: { value: null, confidence: 0, why: null }, not_landed_reason: null, not_landed_note: null,
    photo_moisture: { value: true, confidence: 0.9, why: 'photo 2' }, photo_damage: { value: true, confidence: 0.9, why: 'photo 1' }, photo_wide: { value: false, confidence: 0.6, why: null },
    insurance: { value: 'pending', confidence: 0.5, why: null }, insurance_note: null, has_carrier: { value: false, confidence: 1, why: 'field empty' }, has_claim: { value: true, confidence: 1, why: 'field' },
    tested: { value: null, confidence: 0, why: null }, not_tested_reason: null, year_built: 1700,
    packout_sold: { value: false, confidence: 0.7, why: null }, no_packout_reason: 'small_area',
    info_sufficient: { value: false, confidence: 0.9, why: 'no cause' }, info_missing: 'cause', general_notes: 'g'.repeat(500),
    needs_follow_up: { value: true, confidence: 0.9, why: null }, follow_up_reason: 'major_concerns', follow_up_note: null,
    job_match: null, summary: 's',
  });
  const out = cleanSuggestions(llm, true);
  assert.strictEqual(out.call_taken_by_name.confidence, 1);
  assert.strictEqual(out.call_taken_by_name.why.length, 160);
  assert.strictEqual(out.walk_scheduled_for, null);     // not YYYY-MM-DD
  assert.strictEqual(out.year_built, null);             // implausible
  assert.strictEqual(out.general_notes.length, 400);
  assert.strictEqual(out.no_packout_reason, 'small_area');
  const blank = cleanSuggestions(llm, false);
  assert.strictEqual(blank.walked.value, null);
  assert.strictEqual(blank.call_handled.value, null);
});

test('sample keeps the ends and spreads evenly', () => {
  assert.deepStrictEqual(sample([1, 2, 3], 5), [1, 2, 3]);
  assert.deepStrictEqual(sample([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4), [1, 4, 7, 10]);
  assert.deepStrictEqual(sample([1, 2], 1), [1]);
});
