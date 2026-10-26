// WYH note text: the fixture is shared byte for byte with the DryOps app
// (lib/__tests__/fixtures/wyhNote.json ↔ lib/wyh.ts buildWyhNote). Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { buildWyhNote, fmtPhone } = require('../wyhNote');

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

test('fmtMonD / fmtWindow are calendar-only', () => {
  const { fmtMonD, fmtWindow } = require('../wyhNote');
  assert.strictEqual(fmtMonD('2026-11-03'), 'Tue 11/3');
  assert.strictEqual(fmtMonD('2026-12-31T05:00:00Z'), 'Thu 12/31');
  assert.strictEqual(fmtWindow(600, 720), '10am–12pm');
  assert.strictEqual(fmtWindow(840, 990), '2pm–4:30pm');
  assert.strictEqual(fmtWindow(null, 720), '');
});
