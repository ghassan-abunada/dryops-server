'use strict';
// ── Testing intake: the pure pieces ──────────────────────────────────────────
// Hand-keyed Testing / Abatements jobs (New Job form at a testing location, or
// a lead-source link submission) reuse the work-order automation's rules
// (testingJobs.js): "(CTY - TST)" names, regional owners, city codes. This
// file holds what intake.js needs from those rules in testable form.
//   * city code: the address city (overrides + first three letters) → the code
//     in a linked job's own suffix → the DryOps location's city_abbr
//   * lead type (JN cf_string_6): the picked source's own lead_type, else
//     Internal Referral for one of our locations, Google, else External Referral
//   * on-site minutes: 20 + 15 per test type (lib/testing.ts in the app)

const { testingJobName, testingOwnersFor, cityAbbrForCity, cityAbbrFromJobName, stateCode } = require('./testingJobs');

const TESTING_RECORD_TYPES = ['Testing', 'Abatements'];
const TESTING_TYPE_CODE = { Testing: 'TST', Abatements: 'ABT' };
const DEFAULT_TEST_TYPES = ['Asbestos', 'Lead', 'Soot', 'Mold testing', 'Mold protocol'];
const TESTING_BASE_MIN = 20;
const TESTING_PER_TYPE_MIN = 15;

const clean = (v, max = 300) => (v === undefined || v === null ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, max);

function isTestingRecordType(rt) {
  return TESTING_RECORD_TYPES.includes(String(rt || ''));
}

// Trim, drop blanks and case-insensitive duplicates, keep the order given.
function normalizeTestTypes(raw) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(raw) ? raw : []) {
    const t = clean(r, 60);
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

function testingServiceMinutes(types, baseMin = TESTING_BASE_MIN, perTypeMin = TESTING_PER_TYPE_MIN) {
  const n = Math.max(1, (Array.isArray(types) ? types : []).length);
  return baseMin + perTypeMin * n;
}

// "Asbestos + Lead"
function formatTestTypes(types) {
  return normalizeTestTypes(types).join(' + ');
}

// City code for the "(CTY - TST)" suffix. Returns { abbr, from } or { abbr: null }.
function testingAbbrFor({ city, linkedJobName, locationCityAbbr }) {
  const fromCity = cityAbbrForCity(city);
  if (fromCity) return { abbr: fromCity, from: 'city' };
  const fromLinked = cityAbbrFromJobName(linkedJobName);
  if (fromLinked) return { abbr: fromLinked, from: 'linked job' };
  const fromLoc = clean(locationCityAbbr).toUpperCase();
  if (fromLoc) return { abbr: fromLoc, from: 'location' };
  return { abbr: null, from: null };
}

// Name candidates in the dup-retry order intake.js's pickFreeName walks:
// "Jane Doe (DAL - TST)", "Jane Doe (DAL - TST) 2", … 9. Abatements → ABT.
function testingNameCandidates(base, abbr, recordType = 'Testing') {
  const b = clean(base);
  const code = TESTING_TYPE_CODE[recordType] || 'TST';
  const out = [];
  for (let n = 1; n <= 9; n++) {
    const name = code === 'TST' ? testingJobName(b, abbr, n) : `${b} (${abbr} - ${code})${n > 1 ? ` ${n}` : ''}`;
    out.push(name);
  }
  return out;
}

// JobNimbus Lead Type (cf_string_6) for a testing job from the picked source.
function testingLeadType({ requested, lead }) {
  const r = clean(requested);
  if (r) return r;
  const own = clean(lead && lead.lead_type);
  if (own && own !== 'Other' && own !== 'External MIT Company') return own;
  if (lead && lead.is_internal) return 'Internal Referral';
  if (lead && (lead.company_type === 'Google' || /^google$/i.test(clean(lead.name)))) return 'Google';
  return 'External Referral';
}

// Owners for a hand-keyed testing job: the automation's regional rules.
function testingOwnersForIntake({ abbr, locationName, state }) {
  return testingOwnersFor({ abbr, locationName, state: stateCode(state) || state || null });
}

// Extra lines for the intake note (JN) — what the form captured that has no field.
function testingNoteLines(details, ctx = {}) {
  const d = details || {};
  const lines = [];
  const types = formatTestTypes(d.test_types);
  if (types) lines.push(`Testing requested: ${types}`);
  if (clean(d.referring_wo)) lines.push(`Referring WO #: ${clean(d.referring_wo, 80)}`);
  if (clean(d.referring_contact)) lines.push(`Referring contact: ${clean(d.referring_contact, 200)}`);
  if (clean(d.availability_note)) lines.push(`Availability: ${clean(d.availability_note, 500)}`);
  if (clean(d.instructions)) lines.push(`Special instructions: ${clean(d.instructions, 1000)}`);
  if (ctx.leadLink && ctx.leadLink.sender_name) lines.push(`Sent by ${clean(ctx.leadLink.sender_name, 80)} at ${clean(ctx.leadLink.company, 120)} via DryOps lead link`);
  return lines;
}

module.exports = {
  TESTING_RECORD_TYPES, TESTING_TYPE_CODE, DEFAULT_TEST_TYPES, TESTING_BASE_MIN, TESTING_PER_TYPE_MIN,
  isTestingRecordType, normalizeTestTypes, testingServiceMinutes, formatTestTypes,
  testingAbbrFor, testingNameCandidates, testingLeadType, testingOwnersForIntake, testingNoteLines,
};
