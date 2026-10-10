// Homeowner window-offer texts: the fixture is shared byte for byte with the
// DryOps app (lib/__tests__/fixtures/hoOfferMessage.json). Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { hoOfferMessage, hoReminderMessage, hoConfirmMessage, hoFollowUpMessage, firstName, dayWord, fmtWindow } = require('../hoOffer');

const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'hoOfferMessage.json'), 'utf8'));

for (const c of cases) {
  test(`fixture: ${c.name}`, () => {
    const i = c.input;
    let got;
    if (c.kind === 'reminder') got = hoReminderMessage(i.taskType, i.date, i.today, i.options, i.url);
    else if (c.kind === 'confirm') got = hoConfirmMessage(i.window, i.date, i.today);
    else got = hoOfferMessage(i);
    assert.strictEqual(got, c.expected);
  });
}

test('firstName: first word, "Last, First", trailing punctuation', () => {
  assert.strictEqual(firstName('John Smith'), 'John');
  assert.strictEqual(firstName('Smith, Jane'), 'Jane');
  assert.strictEqual(firstName('  Ali.  '), 'Ali');
  assert.strictEqual(firstName(null), '');
  assert.strictEqual(firstName(''), '');
});

test('dayWord: today / tomorrow / "on Dow Mon D" across a month boundary', () => {
  assert.strictEqual(dayWord('2026-10-13', '2026-10-13'), 'today');
  assert.strictEqual(dayWord('2026-11-01', '2026-10-31'), 'tomorrow');
  assert.strictEqual(dayWord('2026-10-20', '2026-10-13'), 'on Tue Oct 20');
});

test('fmtWindow uses an en dash and drops :00', () => {
  assert.strictEqual(fmtWindow({ startMin: 600, endMin: 720 }), '10am–12pm');
  assert.strictEqual(fmtWindow({ startMin: 750, endMin: 870 }), '12:30pm–2:30pm');
});

test('follow-up text', () => {
  assert.strictEqual(hoFollowUpMessage(), "Thanks — we'll follow up to confirm a time.");
});
