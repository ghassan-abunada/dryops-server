// Shared fixture with DryOps lib/__tests__/demoReport.test.ts — the server's
// summary text must match the app's byte for byte. Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// server.js has side effects at load (express app, timers), so pull the pure
// functions out of the source text and evaluate them in isolation.
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = src.indexOf('// ── Post-demo report');
const end = src.indexOf('// Shared by the token route and the signed-in route.\nasync function saveDemoReport');
assert.ok(start > 0 && end > start, 'post-demo report block not found in server.js');
const fns = new Function(`${src.slice(start, end)}\nreturn { validateDemoReport, isDemoReportComplete, summarizeDemoReport, demoReportTaskLine, demoRoomProfile };`)();

const FIXTURE = {
  v: 1,
  pre_docusketch: true,
  equipment_staged: 'moved',
  rooms: [
    { name: 'Kitchen', profile: 'kitchen', dims: { length_ft: 12, width_ft: 10, ceiling_ft: 8 },
      flooring: { removed: true, types: ['LVP/LVT', 'Subfloor (wood)'], sqft: null },
      baseboard: { kind: 'full_perimeter', lf: null },
      drywall: { kind: 'flood_cut_2ft', perimeter: true, lf: null, sqft: null, insulation_removed: true },
      cabinets: { removed: ['Base cabinets', 'Upper cabinets'], lf: { 'Base cabinets': 10, 'Upper cabinets': 8 } },
      appliances: ['Refrigerator', 'Dishwasher'],
      cabinets_removed: true, appliances_detached: true, special_work: 'island plumbing capped',
      equipment_left: { 'Air Mover': 4, 'Dehumidifier': 1, 'Air Scrubber': 0, 'Drying Mats': 0 } },
    { name: 'Living Room', profile: 'other', dims: null,
      flooring: { removed: true, types: ['Carpet', 'Carpet pad'], sqft: 220 },
      baseboard: { kind: 'partial', lf: 20 },
      drywall: { kind: 'full_walls', perimeter: null, lf: null, sqft: 220, insulation_removed: false },
      cabinets: { removed: [], lf: {} }, appliances: [],
      cabinets_removed: false, appliances_detached: false, special_work: null,
      equipment_left: { 'Air Mover': 2, 'Dehumidifier': 0, 'Air Scrubber': 0, 'Drying Mats': 0 } },
  ],
  antimicrobial: true, cleaned_floors_cavities: true, equipment_reset: true,
  photos_detailed: true, photos_wide: true, photo_count: 24, post_docusketch: true,
  completed_time: '15:45', notes: 'homeowner asked to keep the hallway runner',
};
const EXPECTED = [
  'POST-DEMO REPORT',
  'DocuSketch: pre ✓ · post ✓',
  'Equipment on arrival: moved to a non-demo room',
  'Rooms (2):',
  '• Kitchen (12×10, 8 ft ceiling) — floor removed: LVP/LVT, Subfloor (wood) (120 sq ft); baseboard removed: full perimeter (44 LF); walls: 2 ft flood cut, full perimeter (44 LF, ~88 sq ft), insulation removed; cabinets removed: base cabinets (10 LF), upper cabinets (8 LF); detached: refrigerator, dishwasher; special: island plumbing capped; left: 4 air movers, 1 dehumidifier',
  '• Living Room — floor removed: Carpet, Carpet pad (220 sq ft); baseboard removed: partial (20 LF); walls: full walls (~220 sq ft); left: 2 air movers',
  'After demo: antimicrobial ✓ · floors & cavities cleaned ✓ · equipment reset ✓',
  'Equipment left on site: 6 air movers, 1 dehumidifier',
  'Photos: detailed ✓ · wide ✓ (24)',
  'Completed 3:45 PM',
  'Notes: homeowner asked to keep the hallway runner',
].join('\n');

test('summary matches the shared fixture', () => {
  assert.strictEqual(fns.summarizeDemoReport(FIXTURE), EXPECTED);
  assert.strictEqual(fns.demoReportTaskLine(FIXTURE), 'Post-demo report: 2 rooms · 6 air movers, 1 dehumidifier left · DocuSketch pre ✓ post ✓');
});

test('validate accepts the fixture and round-trips', () => {
  const v = fns.validateDemoReport({ ...FIXTURE, junk: 1 });
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.strictEqual(v.report.junk, undefined);
  assert.strictEqual(fns.summarizeDemoReport(v.report), EXPECTED);
  assert.ok(fns.isDemoReportComplete(v.report));
});

test('validate accepts the older room shape and derives the profile', () => {
  const old = { ...FIXTURE, rooms: [{ name: 'Master Bathroom', flooring: { removed: false, types: [] }, drywall: { kind: 'none', perimeter: null, sqft: null },
    cabinets_removed: true, appliances_detached: false, special_work: null, equipment_left: { 'Air Mover': 1, 'Dehumidifier': 0, 'Heater': 0, 'Air Scrubber': 0 } }] };
  const v = fns.validateDemoReport(old);
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.strictEqual(v.report.rooms[0].profile, 'bathroom');
  assert.strictEqual(v.report.rooms[0].cabinets_removed, true);
  assert.strictEqual(v.report.rooms[0].equipment_left['Drying Mats'], 0);
  assert.strictEqual(fns.isDemoReportComplete(v.report), false); // baseboard unanswered
});

test('validate rejects bad shapes; completeness gates', () => {
  assert.strictEqual(fns.validateDemoReport(null).ok, false);
  assert.strictEqual(fns.validateDemoReport({ ...FIXTURE, completed_time: '25:00' }).ok, false);
  assert.strictEqual(fns.validateDemoReport({ ...FIXTURE, rooms: 'x' }).ok, false);
  const v = fns.validateDemoReport({ ...FIXTURE, post_docusketch: false });
  assert.ok(v.ok);
  assert.strictEqual(fns.isDemoReportComplete(v.report), false);
  assert.strictEqual(fns.demoRoomProfile('Laundry Room'), 'laundry');
});
