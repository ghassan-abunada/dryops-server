'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../estimatePricing');

// A mini catalog, so the money tests do not depend on the real rows.
const MINI = new Map([
  ['svc', { id: 'svc', family: 'svc', desc: 'Emergency service call', unit: 'EA', act: '+', cat: 'WTR', group: 'general', tax: 'none' }],
  ['bag', { id: 'bag', family: 'bag', desc: 'Plastic bag - Large', unit: 'EA', act: '+', cat: 'HMR', group: 'general', tax: 'material' }],
  ['clean', { id: 'clean', family: 'clean', desc: 'Clean floor', unit: 'SF', act: '+', cat: 'CLN', group: 'sanitize', tax: 'cleaning' }],
  ['base', { id: 'base', family: 'base', desc: 'Tear out baseboard', unit: 'LF', act: '-', cat: 'WTR', group: 'demo', tax: 'none' }],
  ['base.c3', { id: 'base.c3', family: 'base', desc: 'Tear out baseboard', unit: 'LF', act: '-', cat: 'WTR', group: 'demo', tax: 'none' }],
]);
const money = { tax: { material: 0.0825, cleaningMaterial: 0.0825, cleaning: 0.0825 }, overheadPct: 0, profitPct: 0 };
const prices = {
  'Emergency service call': { remove: 0, replace: 215.5, mat: 0 },
  'Plastic bag - Large': { remove: 0, replace: 3.19, mat: 2.8 },
  'Clean floor': { remove: 0, replace: 0.47, mat: 0.03 },
  'Tear out baseboard': { remove: 1.33, mat: 0, replace: 0 },
  'custom:c1': { remove: 0, replace: 100, mat: 0 },
};

test('lineMoney: QTY × unit price per column, cents per line, tax by class', () => {
  const svc = P.lineMoney({ id: 'a', row: 'svc', qty: 1 }, prices, money, MINI);
  assert.deepStrictEqual([svc.remove, svc.replace, svc.tax, svc.total, svc.priced], [0, 215.5, 0, 215.5, true]);
  // material class: tax on the material part only
  const bag = P.lineMoney({ id: 'b', row: 'bag', qty: 10 }, prices, money, MINI);
  assert.strictEqual(bag.replace, 31.9);
  assert.strictEqual(bag.matTax, 2.31); // 10 × 2.80 × 0.0825 = 2.31
  assert.strictEqual(bag.tax, 2.31);
  assert.strictEqual(bag.total, 34.21);
  // cleaning class (Texas): the whole line plus its material again
  const cl = P.lineMoney({ id: 'c', row: 'clean', qty: 100 }, prices, money, MINI);
  assert.strictEqual(cl.replace, 47);
  assert.strictEqual(cl.cleanTax, 3.88); // 47 × 0.0825 = 3.8775 → 3.88
  assert.strictEqual(cl.cleanMatTax, 0.25); // 100 × 0.03 × 0.0825 = 0.2475 → 0.25
  assert.strictEqual(cl.tax, 4.13);
  // remove activity lands in the REMOVE column
  const base = P.lineMoney({ id: 'd', row: 'base', qty: 49 }, prices, money, MINI);
  assert.strictEqual(base.remove, 65.17);
  assert.strictEqual(base.replace, 0);
  // unpriced
  const none = P.lineMoney({ id: 'e', row: 'nope', qty: 2 }, prices, money, MINI);
  assert.strictEqual(none.priced, false);
  assert.strictEqual(none.total, 0);
});

test('priceKey: rows with the same wording share a price; custom lines price by id', () => {
  assert.strictEqual(P.priceKey({ row: 'base' }, MINI), P.priceKey({ row: 'base.c3' }, MINI));
  assert.strictEqual(P.priceKey({ id: 'c1', row: null }, MINI), 'custom:c1');
  // the real catalog: baseboard.c3 and baseboard_bag.c3 print the same words
  assert.strictEqual(P.priceKey({ row: 'baseboard.c3' }), P.priceKey({ row: 'baseboard_bag.c3' }));
  assert.strictEqual(P.CATALOG_VERSION, '2026-10-31');
  assert.ok(P.ROW_BY_ID.size > 150);
});

test('docTotals: sections, taxes, O&P and recaps add up', () => {
  const doc = {
    v: 1, category: 2, mold: false, after_hours: false,
    general: [{ id: 'a', row: 'svc', group: 'general', qty: 1 }, { id: 'b', row: 'bag', group: 'general', qty: 10 }],
    rooms: [
      { id: 'r1', name: 'Kitchen', shape: { L: 10, W: 10, H: 8, openings: [] }, subrooms: [], lines: [{ id: 'c', row: 'clean', group: 'sanitize', qty: 100 }, { id: 'd', row: 'base', group: 'demo', qty: 49 }] },
      { id: 'r2', name: 'Hall', shape: { L: null, W: null, H: null, openings: [] }, subrooms: [], lines: [{ id: 'c1', row: null, custom: { desc: 'Custom', unit: 'EA', act: '+', cat: 'DMO', tax: 'none' }, group: 'demo', qty: 1 }, { id: 'x', row: 'nope', group: 'demo', qty: 3 }] },
    ],
  };
  const t = P.docTotals(doc, prices, { ...money, overheadPct: 0.1, profitPct: 0.1 }, MINI);
  assert.deepStrictEqual(t.sections.map((s) => s.name), ['General', 'Kitchen', 'Hall']);
  assert.strictEqual(t.sections[0].lineTotal, 247.4); // 215.50 + 31.90
  assert.strictEqual(t.sections[1].lineTotal, 112.17); // 47 + 65.17
  assert.strictEqual(t.sections[2].lineTotal, 100);
  assert.strictEqual(t.lineItemTotal, 459.57);
  assert.strictEqual(t.materialTax, 2.31);
  assert.strictEqual(t.cleaningMaterialTax, 0.25);
  assert.strictEqual(t.cleaningTax, 3.88);
  assert.strictEqual(t.subtotal, 462.13);
  assert.strictEqual(t.overhead, 45.96);
  assert.strictEqual(t.profit, 45.96);
  assert.strictEqual(t.total, 557.93); // 462.13 + 3.88 + 45.96 + 45.96
  assert.deepStrictEqual(t.unpriced, ['x']);
  // section line totals sum to the line item total; recap percentages sum to 100
  assert.strictEqual(P.c2(t.sections.reduce((s, x) => s + x.lineTotal, 0)), t.lineItemTotal);
  assert.strictEqual(P.c2(t.recapByRoom.reduce((s, r) => s + r.pct, 0)), 100);
  assert.strictEqual(P.c2(t.recapByCategory.reduce((s, r) => s + r.pct, 0)), 100);
  assert.deepStrictEqual(t.recapByCategory.map((r) => r.label), ['CLEANING', 'GENERAL DEMOLITION', 'HAZARDOUS MATERIAL REMEDIATION', 'WATER EXTRACTION & REMEDIATION']);
  // the section tax column is per-line tax
  assert.strictEqual(t.sections[1].tax, 4.13);
  assert.strictEqual(t.sections[1].total, 116.3);
});

test('pcts: largest remainder to exactly 100.00', () => {
  assert.deepStrictEqual(P.pcts([1, 1, 1]), [33.34, 33.33, 33.33]);
  assert.deepStrictEqual(P.pcts([0, 0]), [0, 0]);
});

test('lineNumbers / lineDesc / lineUnit follow the document order and the catalog wording', () => {
  const doc = { general: [{ id: 'a', row: 'emergency_call' }], rooms: [{ id: 'r', lines: [{ id: 'b', row: 'air_mover' }, { id: 'c', row: null, custom: { desc: 'Custom', unit: 'HR' } }] }] };
  const n = P.lineNumbers(doc);
  assert.deepStrictEqual([n.get('a'), n.get('b'), n.get('c')], [1, 2, 3]);
  assert.strictEqual(P.lineDesc({ row: 'emergency_call.ah' }), 'Emergency service call - after business hours');
  assert.strictEqual(P.lineDesc({ row: null, custom: { desc: 'Custom' } }), 'Custom');
  assert.strictEqual(P.lineUnit({ row: 'setup_monitoring' }), 'HR');
  assert.strictEqual(P.lineUnit({ row: null, custom: { unit: 'DA' } }), 'DA');
  assert.strictEqual(P.roomGroupOf({ group: 'general' }), 'extraction');
});

test('shapeGeometry: Xactimate room values with openings (owner estimate rules)', () => {
  // 12 × 10 × 8 with one 3' × 6'8" door and one 4' × 3' window
  const g = P.shapeGeometry({ L: 12, W: 10, H: 8, openings: [{ kind: 'door', w: 3, h: 6.6667 }, { kind: 'window', w: 4, h: 3 }] });
  assert.strictEqual(g.F, 120);
  assert.strictEqual(g.C, 120);
  assert.strictEqual(g.SY, 13.33);
  assert.strictEqual(g.PF, 41); // 44 − door 3
  assert.strictEqual(g.PC, 44);
  assert.strictEqual(g.W, 320); // 44 × 8 − 20 − 12
  assert.strictEqual(g.WC, 440);
  assert.strictEqual(g.source, 'derived');
  // a missing wall comes off both perimeters and is never wall
  const h = P.shapeGeometry({ L: 10, W: 4, H: 8, openings: [{ kind: 'missing_wall', w: 4, h: 8 }] });
  assert.strictEqual(h.PF, 24);
  assert.strictEqual(h.PC, 24);
  assert.strictEqual(h.W, 192);
  // sketch values win field by field
  const s = P.shapeGeometry({ L: 10, W: 10, H: 8, openings: [], sketch: { F: 95.5 } });
  assert.strictEqual(s.F, 95.5);
  assert.strictEqual(s.source, 'docusketch');
  // no dims → nothing
  assert.strictEqual(P.shapeGeometry({ L: null, W: null, H: null, openings: [] }).F, null);
  assert.deepStrictEqual(P.dimensionBlock(g).map((d) => d.label), ['SF Walls', 'SF Ceiling', 'SF Walls & Ceiling', 'SF Floor', 'SY Flooring', 'LF Floor Perimeter', 'LF Ceil. Perimeter']);
});

test('fmtFeet / money / area / clientForPrint / estimateName', () => {
  assert.strictEqual(P.fmtFeet(8), "8'");
  assert.strictEqual(P.fmtFeet(2.5), '2\' 6"');
  assert.strictEqual(P.fmtFeet(6.6667), '6\' 8"');
  assert.strictEqual(P.fmtFeet(2.5521), '2\' 6 5/8"');
  assert.strictEqual(P.fmtFeet(null), '');
  assert.strictEqual(P.money(1327.2), '1,327.20');
  assert.strictEqual(P.money(null), '0.00');
  assert.strictEqual(P.area(null), '—');
  assert.strictEqual(P.area(447.73), '447.73');
  assert.strictEqual(P.clientForPrint('Delgado, Maria'), 'Maria Delgado');
  assert.strictEqual(P.clientForPrint(' Maria Delgado '), 'Maria Delgado');
  assert.strictEqual(P.clientForPrint(null), null);
  assert.strictEqual(P.estimateName('Maria Delgado'), 'MARIA_DELGADO');
  assert.deepStrictEqual(P.moneyFacts({ tax: { material: '0.0825' }, overhead_pct: '0.1', profit_pct: null }), { tax: { material: 0.0825, cleaningMaterial: 0, cleaning: 0 }, overheadPct: 0.1, profitPct: 0 });
});
