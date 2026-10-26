// WYH note text: the fixture is shared byte for byte with the DryOps app
// (lib/__tests__/fixtures/wyhNote.json ↔ lib/wyh.ts buildWyhNote). Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { buildWyhNote, buildCallFeedbackNote, fmtPhone } = require('../wyhNote');

const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'wyhNote.json'), 'utf8'));

for (const c of cases) {
  test(`fixture: ${c.name}`, () => {
    assert.strictEqual(buildWyhNote(c.input), c.expected);
  });
}

test('fmtPhone', () => {
  assert.strictEqual(fmtPhone('15551234567'), '(555) 123-4567');
  assert.strictEqual(fmtPhone('555-1234'), '555-1234');
  assert.strictEqual(fmtPhone(null), '');
});

test('note never carries a location tag — owners are mentioned by the server, at the bottom', () => {
  const text = buildWyhNote(cases[0].input);
  assert.ok(!/@/.test(text));
  assert.ok(text.startsWith('WYH - Gus Abunada\n'));
});

test('recording link signature is stable and bound to call + expiry', () => {
  const { recordingSig } = require('../wyh');
  const a = recordingSig('secret', 'CAL123', 1700000000000);
  assert.strictEqual(a.length, 32);
  assert.strictEqual(a, recordingSig('secret', 'CAL123', 1700000000000));
  assert.notStrictEqual(a, recordingSig('secret', 'CAL124', 1700000000000));
  assert.notStrictEqual(a, recordingSig('secret', 'CAL123', 1700000000001));
  assert.notStrictEqual(a, recordingSig('other', 'CAL123', 1700000000000));
});

test('call review note: non-opportunity, not handled → issues list', () => {
  const text = buildCallFeedbackNote({ managerName: 'Gus Abunada', callWhen: 'Oct 24, 2:15 PM', callPhone: '5551234567', takenBy: 'Jane Doe', opportunity: false, handled: false, issues: ['longer_than_90s', 'gave_price_over_phone', 'other'], issueOther: 'hung up early' });
  assert.strictEqual(text, 'Call review - Gus Abunada\nCall: Oct 24, 2:15 PM · (555) 123-4567 · taken by Jane Doe\n\nOpportunity: No\nHandled properly: No\nIssues: longer than 90 seconds, gave a price over the phone, other: hung up early');
});

test('call review note: opportunity, not handled → missed reason; handled → no extras', () => {
  assert.strictEqual(buildCallFeedbackNote({ managerName: 'Gus Abunada', callWhen: 'Oct 24, 2:15 PM', callPhone: null, opportunity: true, handled: false, missedReason: 'Never offered an inspection' }),
    'Call review - Gus Abunada\nCall: Oct 24, 2:15 PM\n\nOpportunity: Yes\nHandled properly: No\nMissed opportunity: Never offered an inspection');
  assert.strictEqual(buildCallFeedbackNote({ managerName: 'Gus Abunada', callWhen: 'Oct 24, 2:15 PM', callPhone: null, takenBy: 'Jane Doe', opportunity: true, handled: true, issues: ['other'], issueOther: 'ignored', missedReason: 'ignored' }),
    'Call review - Gus Abunada\nCall: Oct 24, 2:15 PM · taken by Jane Doe\n\nOpportunity: Yes\nHandled properly: Yes');
});
