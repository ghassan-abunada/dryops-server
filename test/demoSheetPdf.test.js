'use strict';
// The demo sheet's printable model (what the estimator reads) and its PDF.
// The quantity rules and labels come from the post-demo report block in
// server.js, sliced out of the source like demoReport.test.js does.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { renderDemoSheetPdf, demoSheetModel, demoSheetSummary, roomRows, siteRows, hoursBetween } = require('../demoSheetPdf');
const { countPages } = require('../pdfKit');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = src.indexOf('// ── Post-demo report');
const end = src.indexOf('// The demo sheet PDF (jobPdf.js fileDemoSheet)');
assert.ok(start > 0 && end > start, 'post-demo report block not found in server.js');
const demo = new Function(`${src.slice(start, end)}\nreturn { ...demoSheetDeps(), validateDemoReport };`)();

const eq = (a = 0, d = 0, s = 0, m = 0) => ({ 'Air Mover': a, Dehumidifier: d, 'Air Scrubber': s, 'Drying Mats': m });
const room = (name, o = {}) => ({
  name, profile: 'other', dims: null, flooring: { removed: false, types: [], sqft: null }, baseboard: { kind: 'none', lf: null },
  drywall: { kind: 'none', perimeter: null, lf: null, sqft: null, insulation_removed: null }, cabinets: { removed: [], lf: {} }, appliances: [],
  cabinets_removed: false, appliances_detached: false, special_work: null, equipment_left: eq(), ...o,
});
const report = (o = {}) => {
  const v = demo.validateDemoReport({
    v: 1, pre_docusketch: true, post_docusketch: true, equipment_staged: 'moved', antimicrobial: true, cleaned_floors_cavities: true, equipment_reset: true,
    photos_detailed: true, photos_wide: true, photo_count: null, completed_time: '15:30', notes: null, rooms: [], ...o,
  });
  assert.ok(v.ok, v.errors && v.errors.join('; '));
  return v.report;
};
const KITCHEN = room('Kitchen', {
  profile: 'kitchen', dims: { length_ft: 12, width_ft: 10, ceiling_ft: 8 },
  flooring: { removed: true, types: ['LVP/LVT', 'Subfloor (wood)'], sqft: null }, baseboard: { kind: 'full_perimeter', lf: null },
  drywall: { kind: 'flood_cut_2ft', perimeter: true, lf: null, sqft: null, insulation_removed: true },
  cabinets: { removed: ['Base cabinets', 'Island'], lf: { 'Base cabinets': 10, Island: 6 } }, appliances: ['Refrigerator', 'Dishwasher'],
  special_work: 'island plumbing capped', equipment_left: eq(4, 2, 1),
  extras: { doors: 2, toe_kick_lf: 10, countertop_sf: 30, insulation_lf: 20, dehu_large: 1 },
});
// No room size and nothing typed: the quantities the estimate needs are unknown.
const HALL = room('Hall', { flooring: { removed: true, types: ['Carpet', 'Carpet pad'], sqft: null }, baseboard: { kind: 'full_perimeter', lf: null }, drywall: { kind: 'flood_cut_2ft', perimeter: true, lf: null, sqft: null, insulation_removed: false } });
const LIVING = room('Living Room', { flooring: { removed: true, types: ['Carpet'], sqft: 220 }, baseboard: { kind: 'partial', lf: 30 }, drywall: { kind: 'flood_cut_4ft', perimeter: false, lf: 18, sqft: null, insulation_removed: false }, extras: { trim_lf: 20, doors: 1, doors_removed: 1, drill_holes: 6 } });
const visit = (r, o = {}) => ({ scheduled_date: '2026-06-13', demo_report_by_name: 'Sam Tech', demo_report_submitted_at: '2026-06-13T20:00:00Z', demo_report: r, ...o });
const pick = (rows, item) => rows.filter((r) => r.item === item);

test('room rows: typed figures win, room size fills the rest and is marked, the scope sheet trim rule holds', () => {
  const r = report({ rooms: [KITCHEN, LIVING] });
  const k = roomRows(r.rooms[0], demo);
  assert.deepStrictEqual(k.map((x) => x.item), ['Flooring', 'Baseboard', 'Drywall', 'Insulation', 'Cabinets', 'Cabinets', 'Toe kick', 'Countertop', 'Door trim', 'Detached']);
  assert.deepStrictEqual(pick(k, 'Flooring')[0], { item: 'Flooring', detail: 'LVP/LVT, Subfloor (wood)', sf: 120, sfCalc: true, missing: false });
  assert.deepStrictEqual(pick(k, 'Baseboard')[0], { item: 'Baseboard', detail: 'Full perimeter', lf: 44, lfCalc: true, missing: false });
  assert.deepStrictEqual(pick(k, 'Drywall')[0], { item: 'Drywall', detail: '2 ft flood cut · full perimeter', lf: 44, sf: 88, lfCalc: true, sfCalc: true, missing: false });
  assert.deepStrictEqual(pick(k, 'Insulation')[0], { item: 'Insulation', detail: 'Removed', lf: 20 });
  assert.deepStrictEqual(pick(k, 'Cabinets').map((c) => [c.detail, c.lf]), [['Base cabinets', 10], ['Island', 6]]);
  assert.deepStrictEqual(pick(k, 'Door trim')[0], { item: 'Door trim', detail: '2 doors · 14 LF each', lf: 28, lfCalc: true });
  assert.deepStrictEqual(pick(k, 'Detached')[0], { item: 'Detached', detail: 'Refrigerator, Dishwasher', ea: 2 });

  const l = roomRows(r.rooms[1], demo);
  assert.deepStrictEqual(pick(l, 'Flooring')[0].sfCalc, false);
  assert.deepStrictEqual(pick(l, 'Drywall')[0], { item: 'Drywall', detail: '4 ft flood cut · partial', lf: 18, sf: 72, lfCalc: false, sfCalc: true, missing: false });
  assert.deepStrictEqual(pick(l, 'Door trim')[0], { item: 'Door trim', detail: '1 door', lf: 20 });
  assert.deepStrictEqual(pick(l, 'Doors')[0], { item: 'Doors', detail: 'Removed', ea: 1 });
  assert.deepStrictEqual(pick(l, 'Drill holes')[0].ea, 6);
});

test('a quantity nobody measured is flagged, never guessed', () => {
  const r = report({ rooms: [HALL] });
  const h = roomRows(r.rooms[0], demo);
  assert.deepStrictEqual(h.map((x) => [x.item, x.missing, x.lf == null, x.sf == null]), [['Flooring', true, true, true], ['Baseboard', true, true, true], ['Drywall', true, true, true]]);
  const m = demoSheetModel([visit(report({ rooms: [KITCHEN, HALL] }))], demo);
  assert.strictEqual(m.unmeasured, 3);
  assert.strictEqual(m.anyCalc, true);
  const fl = m.totals.find((t) => t.item === 'Flooring');
  assert.deepStrictEqual([fl.detail, fl.flag, fl.sf, fl.sfCalc], ['2 rooms', '1 not measured', 120, true]);
  assert.strictEqual(demoSheetSummary(m), '2 rooms · 88 SF drywall · 120 SF flooring · 3 quantities not measured');
});

test('totals sum each item across rooms in print order', () => {
  const m = demoSheetModel([visit(report({ rooms: [KITCHEN, LIVING] }))], demo);
  assert.deepStrictEqual(m.totals.map((t) => [t.item, t.lf, t.sf, t.ea]), [
    ['Flooring', null, 340, null], ['Baseboard', 74, null, null], ['Drywall', 62, 160, null], ['Insulation', 20, null, null], ['Cabinets', 16, null, null],
    ['Toe kick', 10, null, null], ['Countertop', null, 30, null], ['Door trim', 48, null, null], ['Doors', null, null, 1], ['Drill holes', null, null, 6], ['Detached', null, null, 2],
  ]);
  assert.strictEqual(m.totals.find((t) => t.item === 'Cabinets').detail, '1 room');
  assert.strictEqual(m.unmeasured, 0);
  assert.strictEqual(m.roomCount, 2);
});

test('site work, equipment, checklist and time on site', () => {
  const bare = report({ rooms: [KITCHEN] });
  assert.deepStrictEqual(siteRows(bare, demo), [], 'a bare "antimicrobial applied" stays on the checklist');
  const full = report({ rooms: [KITCHEN], post_docusketch: false, techs: 3, extras: {
    arrival_time: '08:00', after_hours: true, haul_debris_loads: 2, cleaning: { kind: 'heavy', sf: 400 }, antimicrobial: { coverage: 'floor', sf: 120 },
    protection: { containment: { setup: true, sf: null, zippers: 1, tension_posts: 4 }, floor_protection: { type: 'neoprene_runners', sf: null, runners: 3 }, protective_plastic_sf: 200 },
  } });
  assert.deepStrictEqual(siteRows(full, demo).map((r) => [r.item, r.detail, r.sf == null ? null : r.sf, r.ea == null ? null : r.ea, !!r.missing]), [
    ['Containment', '1 zipper · 4 tension posts', null, null, true], ['Floor protection', 'Neoprene runners', null, 3, false], ['Protective plastic', '', 200, null, false],
    ['Cleaning', 'Heavy', 400, null, false], ['Antimicrobial', 'Floor', 120, null, false], ['Debris haul', '2 loads', null, 2, false],
  ]);
  const day = demoSheetModel([visit(full)], demo).days[0];
  assert.strictEqual(day.onSite, '8:00 AM to 3:30 PM · 7.5 hr');
  assert.deepStrictEqual([day.techs, day.after_hours], [3, true]);
  assert.deepStrictEqual(day.equipment, [
    { room: 'Kitchen', 'Air Mover': '4', Dehumidifier: '2 (1 large)', 'Air Scrubber': '1', 'Drying Mats': '' },
    { room: 'Left on site', _bold: true, 'Air Mover': '4', Dehumidifier: '2', 'Air Scrubber': '1', 'Drying Mats': '' },
  ]);
  assert.deepStrictEqual(day.checklist.filter((c) => c[2]).map((c) => c[0]), ['Sketch after']);
  assert.strictEqual(hoursBetween('15:00', '09:00'), null);
  assert.strictEqual(hoursBetween(null, '09:00'), null);
});

test('renders a PDF: one page for a typical demo, every day of a multi-day demo, and a report with nothing removed', async () => {
  const job = { name: 'Roe, Jane (DAL - MIT)', client_name: 'Roe, Jane', address: '9 Elm St, Dallas, TX', claim_number: 'CLM-77', insurer: 'State Farm' };
  const location = { name: 'A1 Restoration of Dallas' };
  const one = await renderDemoSheetPdf({ job, location, logoPng: null, visits: [visit(report({ rooms: [LIVING, HALL] }))], demo, now: new Date('2026-06-14T12:00:00Z') });
  assert.strictEqual(one.slice(0, 5).toString(), '%PDF-');
  assert.strictEqual(countPages(one), 1);
  const two = await renderDemoSheetPdf({ job, location, logoPng: null, visits: [visit(report({ rooms: [KITCHEN, LIVING] })), visit(report({ rooms: [HALL] }), { scheduled_date: '2026-06-14' })], demo });
  assert.ok(countPages(two) >= 1);
  const empty = await renderDemoSheetPdf({ job, location, logoPng: Buffer.from('not a png'), visits: [visit(report({ rooms: [room('Garage')] }))], demo });
  assert.strictEqual(countPages(empty), 1);
  // 30 rooms (the report's cap) paginate without a room name stranded from its rows
  const many = await renderDemoSheetPdf({ job, location, logoPng: null, visits: [visit(report({ rooms: Array.from({ length: 30 }, (_, i) => ({ ...KITCHEN, name: `Room ${i + 1}` })) }))], demo });
  assert.ok(countPages(many) >= 5);
});
