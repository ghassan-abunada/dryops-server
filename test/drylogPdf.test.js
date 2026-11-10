'use strict';
// The drying log PDF in the generator's layout, from the data the desktop
// page builds (fixtures/drylogData.json is DryOps lib/__tests__/fixtures/
// drylogData.json; the app's drylogModel.test.ts regenerates it with GEN=1).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { renderDrylogPdf, validateDrylog, drylogSummary } = require('../drylogPdf');
const { countPages } = require('../pdfKit');

const fixture = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'drylogData.json'), 'utf8'));
const JOB = { name: 'Roe, Jane', client_name: 'Jane Roe', address: '9 Elm St, Dallas, TX', claim_number: 'CLM-77', insurer: 'State Farm', date_loss: '2026-08-10' };

test('validateDrylog accepts the fixture and names what is wrong otherwise', () => {
  assert.strictEqual(validateDrylog(fixture()), null);
  assert.match(validateDrylog(null), /object/);
  assert.match(validateDrylog({ rooms: 'x' }), /rooms must be an array/);
  assert.match(validateDrylog({ rooms: [], days: 0, dateLabels: [] }), /days must be/);
  const short = fixture(); short.rooms[0].materials[0].projection.pop();
  assert.match(validateDrylog(short), /projection must have 6 days/);
  const hot = fixture(); hot.rooms[0].materials[0].projection[0].mc = 140;
  assert.match(validateDrylog(hot), /mc out of range/);
  const noName = fixture(); delete noName.rooms[1].name;
  assert.match(validateDrylog(noName), /rooms\[1\] needs a name/);
});

test('drylogSummary reads like the page toolbar', () => {
  assert.strictEqual(drylogSummary(fixture()), '7 days · 08/12 – 08/18 · 2 rooms · 3 materials');
});

test('renderDrylogPdf: a cover plus one page per room, the legend on the last', async () => {
  const buf = await renderDrylogPdf({ data: fixture(), job: JOB, location: { name: 'A1 Restoration of Dallas' }, logoPng: null, generated: new Date('2026-08-20T12:00:00Z') });
  assert.ok(Buffer.isBuffer(buf));
  assert.strictEqual(buf.slice(0, 5).toString(), '%PDF-');
  assert.strictEqual(countPages(buf), 3);
  assert.ok(buf.length > 2000);
});

test('renderDrylogPdf: many materials chunk across tables; no rooms still renders the cover', async () => {
  const wide = fixture();
  const base = wide.rooms[0].materials[0];
  wide.rooms[0].materials = Array.from({ length: 14 }, (_, i) => ({ ...base, key: `m${i}`, material: `Material ${i + 1}`, demoed: false, demoDay: null, projection: base.projection.map((p) => ({ day: p.day, mc: 30 - i, demoed: false, anchored: false })) }));
  const buf = await renderDrylogPdf({ data: wide, job: JOB, location: null, logoPng: null });
  assert.ok(countPages(buf) >= 3);
  const bare = await renderDrylogPdf({ data: { ...fixture(), rooms: [] }, job: JOB, location: { name: 'X' }, logoPng: null });
  assert.strictEqual(countPages(bare), 1);
});

test('renderDrylogPdf: a photo it was handed prints; a src without bytes is skipped', async () => {
  const data = fixture();
  // A 2×2 JPEG is enough for pdfkit to embed.
  const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKpgA//Z', 'base64');
  data.rooms[0].photos = [{ id: 'p1', src: 'jn:ph-77', caption: 'Under the sink' }, { id: 'p2', src: 'https://nope', caption: null }];
  const photos = new Map([['jn:ph-77', { buf: jpeg, w: 2, h: 2 }]]);
  const buf = await renderDrylogPdf({ data, job: JOB, location: { name: 'X' }, logoPng: null, photos });
  assert.strictEqual(countPages(buf), 3);
  assert.ok(buf.length > 2000);
});
