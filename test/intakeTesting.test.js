// Testing intake (intakeTesting.js): city code, "(CTY - TST)" name candidates,
// lead type, owners and note lines for hand-keyed Testing jobs. Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const {
  isTestingRecordType, normalizeTestTypes, testingServiceMinutes, formatTestTypes,
  testingAbbrFor, testingNameCandidates, testingLeadType, testingOwnersForIntake, testingNoteLines,
} = require('../intakeTesting');
const { USERS } = require('../testingJobs');

test('record types + test type normalisation', () => {
  assert.strictEqual(isTestingRecordType('Testing'), true);
  assert.strictEqual(isTestingRecordType('Abatements'), true);
  assert.strictEqual(isTestingRecordType('Mitigation'), false);
  assert.deepStrictEqual(normalizeTestTypes([' Asbestos ', 'asbestos', '', null, 'Mold  testing']), ['Asbestos', 'Mold testing']);
  assert.deepStrictEqual(normalizeTestTypes('nope'), []);
  assert.strictEqual(formatTestTypes(['Asbestos', 'Lead']), 'Asbestos + Lead');
});

test('on-site minutes: 20 + 15 per type, one type minimum', () => {
  assert.strictEqual(testingServiceMinutes([]), 35);
  assert.strictEqual(testingServiceMinutes(['Asbestos']), 35);
  assert.strictEqual(testingServiceMinutes(['Asbestos', 'Lead']), 50);
  assert.strictEqual(testingServiceMinutes(['Soot', 'Asbestos', 'Lead']), 65);
});

test('city code: address city → linked job suffix → location city_abbr', () => {
  assert.deepStrictEqual(testingAbbrFor({ city: 'Dallas' }), { abbr: 'DAL', from: 'city' });
  assert.deepStrictEqual(testingAbbrFor({ city: 'San Antonio' }), { abbr: 'SAN', from: 'city' });
  assert.deepStrictEqual(testingAbbrFor({ city: 'Fort Worth' }), { abbr: 'FTW', from: 'city' });
  assert.deepStrictEqual(testingAbbrFor({ city: '', linkedJobName: 'Jane Doe (AFF - DAL - MIT)' }), { abbr: 'DAL', from: 'linked job' });
  assert.deepStrictEqual(testingAbbrFor({ city: null, linkedJobName: 'No Suffix', locationCityAbbr: 'den' }), { abbr: 'DEN', from: 'location' });
  assert.deepStrictEqual(testingAbbrFor({}), { abbr: null, from: null });
});

test('name candidates follow the automation: "(DAL - TST)", then 2…9; Abatements → ABT', () => {
  const c = testingNameCandidates('Jane Doe', 'DAL');
  assert.strictEqual(c[0], 'Jane Doe (DAL - TST)');
  assert.strictEqual(c[1], 'Jane Doe (DAL - TST) 2');
  assert.strictEqual(c.length, 9);
  assert.strictEqual(testingNameCandidates('Jane Doe', 'HOU', 'Abatements')[0], 'Jane Doe (HOU - ABT)');
});

test('lead type: requested wins, then the source, internal → Internal Referral, Google, else External Referral', () => {
  assert.strictEqual(testingLeadType({ requested: 'Internal Referral', lead: { lead_type: 'Other' } }), 'Internal Referral');
  assert.strictEqual(testingLeadType({ lead: { lead_type: 'Plumber' } }), 'Plumber');
  assert.strictEqual(testingLeadType({ lead: { lead_type: 'Other', is_internal: true } }), 'Internal Referral');
  assert.strictEqual(testingLeadType({ lead: { company_type: 'Google', name: 'Google' } }), 'Google');
  assert.strictEqual(testingLeadType({ lead: { name: 'AWD Roofing', company_type: 'Other', lead_type: 'Other' } }), 'External Referral');
  assert.strictEqual(testingLeadType({ lead: null }), 'External Referral');
});

test('owners reuse the regional rules — Dallas adds Dom, never Joe Brooks', () => {
  const dal = testingOwnersForIntake({ abbr: 'DAL', locationName: null, state: 'Texas' });
  assert.ok(dal.includes(USERS.saleahCrawford) && dal.includes(USERS.jalisaHillATS) && dal.includes(USERS.dominickGarcia));
  assert.ok(!dal.includes('lpy3vv8z8mnftpa63t1k0j'));
  const den = testingOwnersForIntake({ abbr: 'DEN', locationName: null, state: 'CO' });
  assert.ok(den.includes(USERS.robertMartinez) && den.includes(USERS.hershalJohnson) && !den.includes(USERS.dominickGarcia));
});

test('note lines carry what the form captured that has no JN field', () => {
  const lines = testingNoteLines(
    { test_types: ['Asbestos', 'Lead'], referring_wo: '21165', referring_contact: 'Sam at AWD', availability_note: 'after 2pm', instructions: 'dog in yard' },
    { leadLink: { sender_name: 'Sam', company: 'AWD Roofing' } },
  );
  assert.deepStrictEqual(lines, [
    'Testing requested: Asbestos + Lead',
    'Referring WO #: 21165',
    'Referring contact: Sam at AWD',
    'Availability: after 2pm',
    'Special instructions: dog in yard',
    'Sent by Sam at AWD Roofing via DryOps lead link',
  ]);
  assert.deepStrictEqual(testingNoteLines({}), []);
});
