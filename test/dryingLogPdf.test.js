'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { dryingLogModel, renderDryingLogPdf, validateDryingLog, summaryLine } = require('../dryingLogPdf');
const { countPages } = require('../pdfKit');

const fixture = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'dryingLog.json'), 'utf8'));

test('dryingLogModel: days across, rooms and materials down, unread cells null', () => {
  const m = dryingLogModel(fixture());
  assert.deepStrictEqual(m.dates, ['2026-06-10', '2026-06-11', '2026-06-12']);
  assert.deepStrictEqual(m.rooms.map((r) => r.name), ['Kitchen', 'Hallway']);
  const kitchen = m.rooms[0], hall = m.rooms[1];
  assert.deepStrictEqual(kitchen.materials.map((x) => x.type), ['Drywall', 'Baseboard']);
  const drywall = kitchen.materials[0];
  assert.strictEqual(drywall.std, 14);
  assert.deepStrictEqual(Object.keys(drywall.cells), m.dates);
  assert.deepStrictEqual(drywall.cells['2026-06-10'], { mc: 32.5, delta: null, dry: false });
  assert.deepStrictEqual(drywall.cells['2026-06-11'], { mc: 21.1, delta: 11.4, dry: false });
  assert.deepStrictEqual(drywall.cells['2026-06-12'], { mc: 13.5, delta: 7.6, dry: true });
  assert.deepStrictEqual(drywall.last, { mc: 13.5, delta: 7.6, dry: true });
  // The subfloor was not read on 6/11: the cell exists and is null.
  const sub = hall.materials[0];
  assert.strictEqual(sub.std, null);
  assert.strictEqual(sub.cells['2026-06-11'], null);
  assert.strictEqual(sub.cells['2026-06-12'].dry, true);
  // Atmospherics / equipment / outside by date
  assert.deepStrictEqual(kitchen.atmos['2026-06-11'], { temp_f: 82, rh: 40, gpp: 66 });
  assert.deepStrictEqual(kitchen.equipment['2026-06-10'], [{ type: 'Air Mover', qty: 4 }, { type: 'Dehumidifier', qty: 1 }]);
  assert.deepStrictEqual(kitchen.equipment['2026-06-12'], []);
  assert.strictEqual(kitchen.hasDehu, true);
  assert.strictEqual(hall.hasDehu, false);
  assert.strictEqual(m.outside['2026-06-12'], null);
  assert.deepStrictEqual(m.summary, { first_date: '2026-06-10', last_date: '2026-06-12', days: 3, all_dry: true, wet: 0, dry: 3 });
  assert.strictEqual(summaryLine(m), '3 days · 6/10/26 – 6/12/26 · all materials at dry standard');
});

test('dryingLogModel: derives dry from the default standard and counts wet materials', () => {
  const log = fixture();
  log.days.length = 2; // stop after the first monitor: still drying
  delete log.summary;
  for (const d of log.days) for (const r of d.rooms) for (const mat of r.materials) delete mat.dry;
  const m = dryingLogModel(log);
  assert.strictEqual(m.summary.days, 2);
  assert.strictEqual(m.summary.all_dry, false);
  assert.strictEqual(m.summary.wet, 3); // drywall 21.1 > 14, baseboard 15 > 12, subfloor 22 > 16 (default)
  assert.match(summaryLine(m), /3 materials still above standard/);
});

test('validateDryingLog accepts the fixture and rejects bad shapes', () => {
  assert.strictEqual(validateDryingLog(fixture()), null);
  assert.match(validateDryingLog(null), /object/);
  assert.match(validateDryingLog({ v: 2, days: [] }), /v must be 1/);
  assert.match(validateDryingLog({ v: 1, days: {} }), /days must be an array/);
  const bad = fixture(); bad.days[0].date = '06/10/2026';
  assert.match(validateDryingLog(bad), /YYYY-MM-DD/);
  const hot = fixture(); hot.days[0].rooms[0].reading.rh = 140;
  assert.match(validateDryingLog(hot), /rh out of range/);
  const mc = fixture(); mc.days[0].rooms[0].materials[0].mc = -3;
  assert.match(validateDryingLog(mc), /mc out of range/);
  const eq = fixture(); eq.days[0].rooms[0].equipment.push({ type: 'Air Mover' });
  assert.match(validateDryingLog(eq), /equipment needs type and qty/);
});

test('renderDryingLogPdf: portrait single page for 3 days', async () => {
  const m = dryingLogModel(fixture());
  const buf = await renderDryingLogPdf({ model: m, job: { name: 'Delgado, Maria', client_name: 'Delgado, Maria', address: '1600 Sara Ln', claim_number: 'CLM-1', insurer: 'State Farm', date_loss: '2026-06-09' }, location: { name: 'A1 Restoration of Dallas' }, logoPng: null });
  assert.ok(Buffer.isBuffer(buf));
  assert.strictEqual(buf.slice(0, 5).toString(), '%PDF-');
  assert.strictEqual(countPages(buf), 1);
  assert.match(buf.toString('latin1'), /MediaBox \[0 0 612 792\]/);
});

test('renderDryingLogPdf: landscape and chunked past 6 days', async () => {
  const log = fixture();
  for (let i = 3; i < 16; i++) { const d = JSON.parse(JSON.stringify(log.days[1])); d.date = `2026-06-${String(10 + i).padStart(2, '0')}`; log.days.push(d); }
  delete log.summary;
  const m = dryingLogModel(log);
  assert.strictEqual(m.dates.length, 16);
  const buf = await renderDryingLogPdf({ model: m, job: { name: 'Big' }, location: null, logoPng: null });
  assert.strictEqual(buf.slice(0, 5).toString(), '%PDF-');
  assert.match(buf.toString('latin1'), /MediaBox \[0 0 792 612\]/);
  assert.ok(countPages(buf) >= 2, `expected the 16 days to chunk across pages, got ${countPages(buf)}`);
});

test('renderDryingLogPdf: an empty log still renders', async () => {
  const m = dryingLogModel({ v: 1, job: { id: 'x', name: null, address: null }, days: [], summary: { first_date: null, last_date: null, days: 0, all_dry: false } });
  const buf = await renderDryingLogPdf({ model: m, job: { name: 'Empty' }, location: null, logoPng: null });
  assert.strictEqual(countPages(buf), 1);
});
