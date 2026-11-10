'use strict';
// ── Estimate money, geometry and wording (Node twin of the app's lib/estimate) ──
// Faithful port of lib/estimate/pricing.ts (lineMoney, docTotals, pcts,
// priceKey), ops.ts (lineNumbers, lineDesc), rooms.ts (shapeGeometry,
// roomGeometry, dimensionBlock, fmtFeet, OPENING_LABEL), format.ts (money,
// area) and printCover.ts (clientForPrint, estimateName). Per-line money is
// NOT stored on estimate_docs — the app computes it from body + the frozen
// price snapshot — so the PDF recomputes it the same way and jobPdf.js refuses
// to print when the total disagrees with estimate_docs.grand_total.
//
// The catalog rows come from estimateCatalog.json, a dump of the app's
// lib/estimate/catalogData.ts (the app adds a drift test against this file).
// Pure; test/estimatePricing.test.js.

const CATALOG = require('./estimateCatalog.json');

const CATALOG_VERSION = CATALOG.version;
const CATEGORY_LABEL = CATALOG.category_label;
const GROUP_LABEL = CATALOG.group_label;
const ROOM_GROUPS = CATALOG.room_groups;
const ROW_BY_ID = new Map(CATALOG.rows.map((r) => [r.id, r]));
const GENERAL = 'general';

const c2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const r2 = (n) => Math.round(n * 100) / 100;

// ── Money (pricing.ts) ──────────────────────────────────────────────────────
const rowOf = (line, rows = ROW_BY_ID) => (line && line.row ? rows.get(line.row) || null : null);

function facts(l, rows) {
  if (l.custom) return { act: l.custom.act, tax: l.custom.tax, cat: l.custom.cat };
  const r = rowOf(l, rows);
  return { act: (r && r.act) || '+', tax: (r && r.tax) || 'none', cat: (r && r.cat) || 'WTR' };
}

/** Price key: the Xactimate wording (two rows printing the same words share a price) or the custom line's own id. */
const priceKey = (l, rows = ROW_BY_ID) => (l.row ? ((rows.get(l.row) || {}).desc || l.row) : `custom:${l.id}`);

function lineMoney(l, prices, money, rows = ROW_BY_ID) {
  const p = prices && prices[priceKey(l, rows)];
  const qty = l.qty == null ? 0 : Number(l.qty);
  const { tax } = facts(l, rows);
  if (!p) return { remove: 0, replace: 0, tax: 0, total: 0, unitRemove: 0, unitReplace: 0, priced: false, matTax: 0, cleanMatTax: 0, cleanTax: 0 };
  const remove = c2(qty * Number(p.remove || 0));
  const replace = c2(qty * Number(p.replace || 0));
  const base = c2(remove + replace);
  const matBase = qty * Number(p.mat || 0);
  const matTax = tax === 'material' ? c2(matBase * Number(money.tax.material || 0)) : 0;
  const cleanMatTax = tax === 'cleaning' ? c2(matBase * Number(money.tax.cleaningMaterial || 0)) : 0;
  const cleanTax = tax === 'cleaning' ? c2(base * Number(money.tax.cleaning || 0)) : 0;
  const t = c2(matTax + cleanMatTax + cleanTax);
  return { remove, replace, tax: t, total: c2(base + t), unitRemove: Number(p.remove || 0), unitReplace: Number(p.replace || 0), priced: true, matTax, cleanMatTax, cleanTax };
}

/** Percentages that add to exactly 100.00 (largest remainder). */
function pcts(amounts) {
  const sum = amounts.reduce((a, b) => a + b, 0);
  if (sum <= 0) return amounts.map(() => 0);
  const raw = amounts.map((a) => (a / sum) * 10000);
  const floor = raw.map(Math.floor);
  let left = 10000 - floor.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => [v - floor[i], i]).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) { if (left <= 0) break; floor[i] += 1; left--; }
  return floor.map((v) => v / 100);
}

function docTotals(d, prices, money, rows = ROW_BY_ID) {
  const sections = [];
  const byCat = new Map();
  let lineItemTotal = 0, materialTax = 0, cleaningMaterialTax = 0, cleaningTax = 0;
  const unpriced = [];
  const run = (id, name, lines) => {
    let lt = 0, tx = 0;
    for (const l of lines) {
      const m = lineMoney(l, prices, money, rows);
      if (!m.priced && (l.qty == null ? 0 : l.qty) > 0) unpriced.push(l.id);
      const base = c2(m.remove + m.replace);
      lt = c2(lt + base); tx = c2(tx + m.tax);
      materialTax = c2(materialTax + m.matTax); cleaningMaterialTax = c2(cleaningMaterialTax + m.cleanMatTax); cleaningTax = c2(cleaningTax + m.cleanTax);
      const cat = facts(l, rows).cat;
      byCat.set(cat, c2((byCat.get(cat) || 0) + base));
    }
    lineItemTotal = c2(lineItemTotal + lt);
    sections.push({ id, name, lineTotal: lt, tax: tx, total: c2(lt + tx) });
  };
  const general = Array.isArray(d.general) ? d.general : [];
  const roomsList = Array.isArray(d.rooms) ? d.rooms : [];
  if (general.length) run(GENERAL, 'General', general);
  for (const r of roomsList) run(r.id, r.name, Array.isArray(r.lines) ? r.lines : []);
  const subtotal = c2(lineItemTotal + materialTax + cleaningMaterialTax);
  const overhead = c2(lineItemTotal * (Number(money.overheadPct) || 0));
  const profit = c2(lineItemTotal * (Number(money.profitPct) || 0));
  const total = c2(subtotal + cleaningTax + overhead + profit);
  const roomP = pcts(sections.map((s) => s.lineTotal));
  const label = (k) => CATEGORY_LABEL[k] || String(k);
  const cats = [...byCat.entries()].filter(([, v]) => v > 0).sort((a, b) => label(a[0]).localeCompare(label(b[0])));
  const catP = pcts(cats.map(([, v]) => v));
  return {
    sections, lineItemTotal, materialTax, cleaningMaterialTax, cleaningTax, subtotal, overhead, profit, total,
    recapByRoom: sections.map((s, i) => ({ name: s.name, amount: s.lineTotal, pct: roomP[i] })),
    recapByCategory: cats.map(([k, v], i) => ({ label: label(k), amount: v, pct: catP[i] })),
    unpriced,
  };
}

// ── Wording (ops.ts) ────────────────────────────────────────────────────────
/** Line numbers as they print: 1, 2, 3 … through General then each room. */
function lineNumbers(d) {
  const m = new Map();
  let n = 0;
  for (const l of d.general || []) m.set(l.id, ++n);
  for (const r of d.rooms || []) for (const l of r.lines || []) m.set(l.id, ++n);
  return m;
}
const lineDesc = (l, rows = ROW_BY_ID) => (l.custom && l.custom.desc) || (l.row ? ((rows.get(l.row) || {}).desc || l.row) : '');
const lineUnit = (l, rows = ROW_BY_ID) => (l.custom && l.custom.unit) || (l.row ? ((rows.get(l.row) || {}).unit || 'EA') : 'EA');
/** Group a line prints under inside a room (general-group lines print with the extraction lines, no heading). */
const roomGroupOf = (l) => (l.group === 'general' ? 'extraction' : l.group || 'extraction');

// ── Geometry (rooms.ts) ─────────────────────────────────────────────────────
function emptyGeometry() {
  return { HH: null, F: null, C: null, W: null, WC: null, PF: null, PC: null, SY: null, LW: null, SW: null, WOSF: null, EPW: null, source: 'none' };
}

/** Room values from L×W×H and openings; sketch values win field by field. */
function shapeGeometry(s) {
  const g = emptyGeometry();
  const shape = s || {};
  const L = shape.L == null ? 0 : Number(shape.L), Wd = shape.W == null ? 0 : Number(shape.W), H = shape.H == null ? 0 : Number(shape.H);
  const openings = Array.isArray(shape.openings) ? shape.openings : [];
  if (L > 0 && Wd > 0) {
    let pf = 2 * (L + Wd), pc = pf;
    let wallOff = 0;
    for (const o of openings) {
      const w = Math.max(0, Number(o.w) || 0), h = Math.max(0, Number(o.h) || 0);
      switch (o.kind) {
        case 'missing_wall': pf -= w; pc -= w; break;
        case 'door': case 'missing_wall_floor': pf -= w; wallOff += w * h; break;
        case 'missing_wall_ceiling': pc -= w; wallOff += w * h; break;
        case 'window': case 'missing_wall_neither': wallOff += w * h; break;
        default: break;
      }
    }
    g.F = r2(L * Wd);
    g.C = g.F;
    g.SY = r2(g.F / 9);
    g.PF = r2(Math.max(0, pf));
    g.PC = r2(Math.max(0, pc));
    if (H > 0) {
      g.HH = H;
      g.W = r2(Math.max(0, pc * H - wallOff));
      g.WC = r2(g.W + g.C);
      g.LW = r2(Math.max(L, Wd) * H);
      g.SW = r2(Math.min(L, Wd) * H);
      g.WOSF = r2(wallOff);
    }
    g.source = 'derived';
  }
  const sk = shape.sketch;
  if (sk) {
    let any = false;
    for (const k of ['F', 'C', 'W', 'WC', 'PF', 'PC', 'SY']) {
      const v = sk[k];
      if (typeof v === 'number' && Number.isFinite(v)) { g[k] = v; any = true; }
    }
    if (any) {
      if (sk.WC == null && g.W != null && g.C != null) g.WC = r2(g.W + g.C);
      if (sk.SY == null && g.F != null) g.SY = r2(g.F / 9);
      g.source = 'docusketch';
    }
  }
  return g;
}

function roomGeometry(room) {
  const g = shapeGeometry(room.shape);
  if (Array.isArray(room.subrooms) && room.subrooms.length) g.subrooms = room.subrooms.map((s) => shapeGeometry(s.shape));
  return g;
}

/** The two-column block printed under a room name. */
function dimensionBlock(g) {
  return [
    { label: 'SF Walls', value: g.W }, { label: 'SF Ceiling', value: g.C },
    { label: 'SF Walls & Ceiling', value: g.WC }, { label: 'SF Floor', value: g.F },
    { label: 'SY Flooring', value: g.SY }, { label: 'LF Floor Perimeter', value: g.PF },
    { label: 'LF Ceil. Perimeter', value: g.PC },
  ];
}

const OPENING_LABEL = {
  door: 'Door', window: 'Window', missing_wall: 'Missing Wall',
  missing_wall_floor: 'Missing Wall - Goes to Floor', missing_wall_ceiling: 'Missing Wall - Goes to Ceiling',
  missing_wall_neither: 'Missing Wall - Goes to neither Floor/Ceiling',
};

/** Feet as Xactimate prints them: 2' 6 5/8" (to the 1/16"), 8' when whole. */
function fmtFeet(ft) {
  if (ft == null || !Number.isFinite(Number(ft))) return '';
  const total16 = Math.round(Number(ft) * 12 * 16);
  const feet = Math.floor(total16 / (12 * 16));
  const rem16 = total16 - feet * 12 * 16;
  const inches = Math.floor(rem16 / 16);
  let frac = rem16 - inches * 16, den = 16;
  while (frac && frac % 2 === 0) { frac /= 2; den /= 2; }
  const inchPart = inches || frac ? ` ${inches ? inches : ''}${frac ? `${inches ? ' ' : ''}${frac}/${den}` : ''}"` : '';
  return `${feet}'${inchPart}`;
}

// ── Format (format.ts) ──────────────────────────────────────────────────────
const money = (n) => Number(n == null ? 0 : n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const area = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

// ── Cover (printCover.ts) ───────────────────────────────────────────────────
/** "Delgado, Maria" (JobNimbus) → "Maria Delgado" as the cover prints it. */
function clientForPrint(name) {
  if (!name) return null;
  const m = /^\s*([^,]+),\s*(.+)$/.exec(String(name));
  return m ? `${m[2].trim()} ${m[1].trim()}` : String(name).trim();
}
const estimateName = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');

/** Money facts of an estimate_docs row the way the app passes them to docTotals. */
function moneyFacts(row) {
  const tax = (row && row.tax) || {};
  return {
    tax: { material: Number(tax.material) || 0, cleaningMaterial: Number(tax.cleaningMaterial) || 0, cleaning: Number(tax.cleaning) || 0 },
    overheadPct: Number(row && row.overhead_pct) || 0,
    profitPct: Number(row && row.profit_pct) || 0,
  };
}

module.exports = {
  CATALOG_VERSION, CATEGORY_LABEL, GROUP_LABEL, ROOM_GROUPS, ROW_BY_ID, GENERAL,
  rowOf, priceKey, lineMoney, pcts, docTotals, lineNumbers, lineDesc, lineUnit, roomGroupOf,
  emptyGeometry, shapeGeometry, roomGeometry, dimensionBlock, OPENING_LABEL, fmtFeet,
  money, area, clientForPrint, estimateName, moneyFacts, c2,
};
