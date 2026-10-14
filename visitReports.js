'use strict';
// ── Visit reports (monitor / inspection / closeout) ─────────────────────────
// Twin of the DryOps app's lib/monitorReport.ts: validation (whitelist
// rebuild, like validateDemoReport), completeness, and the JobNimbus note
// text, which must match the app byte for byte — both repos test the same
// fixture (test/fixtures/monitorReport.json). Pure: no I/O.

const { gpp } = require('./psychrometrics');

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DRY_STANDARD_DEFAULT = 16;
const isDehu = (type) => /dehumidifier/i.test(String(type || ''));

// ── Validation ───────────────────────────────────────────────────────────────

function validateMonitorReport(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['report must be an object'] };
  if (Number(raw.v) !== 1) errors.push('unsupported report version');
  if (raw.kind !== 'monitor') errors.push('kind must be monitor');
  const text = (v, name, max) => {
    if (v == null || v === '') return null;
    if (typeof v !== 'string') { errors.push(`${name} must be text`); return null; }
    const t = v.trim(); if (t.length > max) errors.push(`${name} is longer than ${max} characters`); return t.slice(0, max) || null;
  };
  const numIn = (v, name, lo, hi, allowNull) => {
    if (v == null || v === '') { if (allowNull) return null; errors.push(`${name} is required`); return null; }
    const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) { errors.push(`${name} must be a number ${lo}–${hi}`); return null; } return Math.round(n * 10) / 10;
  };
  const intIn = (v, name, lo, hi, d) => {
    if (v == null || v === '') return d;
    const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) { errors.push(`${name} must be a whole number ${lo}–${hi}`); return d; } return n;
  };
  const id = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 64) : null);
  const reading = (v, name, allowNull) => {
    if (v == null) { if (!allowNull) errors.push(`${name} is required`); return null; }
    if (typeof v !== 'object') { errors.push(`${name} is invalid`); return null; }
    const t = numIn(v.temp_f, `${name} temp`, -40, 150, true);
    const rh = numIn(v.rh, `${name} RH`, 0, 100, true);
    return t == null && rh == null ? null : { temp_f: t, rh };
  };

  const rooms = Array.isArray(raw.rooms) ? raw.rooms : (errors.push('rooms must be a list'), []);
  if (rooms.length > 30) errors.push('too many rooms');
  const outRooms = rooms.slice(0, 30).map((r, i) => {
    const label = `room ${i + 1}`;
    if (!r || typeof r !== 'object') { errors.push(`${label} is invalid`); return null; }
    const name = text(r.name, `${label} name`, 60) || '';
    if (!name) errors.push(`${label} needs a name`);
    const materials = (Array.isArray(r.materials) ? r.materials : []).slice(0, 40).map((m, k) => {
      if (!m || typeof m !== 'object') { errors.push(`${label} material ${k + 1} is invalid`); return null; }
      return {
        material_id: id(m.material_id), type: text(m.type, `${label} material ${k + 1} type`, 40) || 'Material',
        mc: numIn(m.mc, `${label} ${m.type || 'material'} MC`, 0, 100, true),
        dry_standard_mc: numIn(m.dry_standard_mc, `${label} dry standard`, 0, 100, true),
        prev_mc: numIn(m.prev_mc, `${label} previous MC`, 0, 100, true),
      };
    }).filter(Boolean);
    const equipment = (Array.isArray(r.equipment) ? r.equipment : []).slice(0, 20).map((e, k) => {
      if (!e || typeof e !== 'object') { errors.push(`${label} equipment ${k + 1} is invalid`); return null; }
      return {
        equipment_id: id(e.equipment_id), type: text(e.type, `${label} equipment ${k + 1} type`, 40) || 'Equipment',
        qty_before: intIn(e.qty_before, `${label} equipment ${k + 1} before`, 0, 99, 0),
        qty_present: intIn(e.qty_present, `${label} equipment ${k + 1} present`, 0, 99, 0),
      };
    }).filter(Boolean);
    const want = raw.fire === true ? 0 : equipment.filter((e) => isDehu(e.type)).reduce((n, e) => n + e.qty_present, 0);
    const outlets = (Array.isArray(r.dehu_outlets) ? r.dehu_outlets : []).slice(0, want).map((o, k) => reading(o, `${label} dehumidifier ${k + 1} outlet`, true) || { temp_f: null, rh: null });
    while (outlets.length < want) outlets.push({ temp_f: null, rh: null });
    return {
      room_id: id(r.room_id), name,
      reading: reading(r.reading, `${label} temp / RH`, true),
      materials, equipment, dehu_outlets: outlets,
      dry: typeof r.dry === 'boolean' ? r.dry : null,
      notes: text(r.notes, `${label} notes`, 500),
    };
  }).filter(Boolean);

  const report = {
    v: 1, kind: 'monitor',
    session_date: typeof raw.session_date === 'string' && DATE_RE.test(raw.session_date) ? raw.session_date : (errors.push('session_date must be YYYY-MM-DD'), ''),
    arrival_time: typeof raw.arrival_time === 'string' && TIME_RE.test(raw.arrival_time) ? raw.arrival_time : (errors.push('arrival_time must be HH:MM'), ''),
    departure_time: typeof raw.departure_time === 'string' && TIME_RE.test(raw.departure_time) ? raw.departure_time : null,
    outside: reading(raw.outside, 'outside', true),
    rooms: outRooms,
    photos_taken: raw.photos_taken === true,
    notes: text(raw.notes, 'notes', 2000),
    ...(raw.fire === true ? { fire: true } : {}),
  };
  if (JSON.stringify(report).length > 64 * 1024) errors.push('report is too large');
  return errors.length ? { ok: false, errors } : { ok: true, report };
}

// ── Completeness ─────────────────────────────────────────────────────────────

const readingComplete = (r) => !!r && r.temp_f != null && r.rh != null;
const dryStandard = (m) => (m.dry_standard_mc != null ? m.dry_standard_mc : DRY_STANDARD_DEFAULT);
const isDry = (mc, standard) => mc != null && mc <= standard;

function isMonitorRoomComplete(room, fire = false) {
  if (!room || !String(room.name || '').trim()) return false;
  if (fire) return true;   // scrubber counts only
  if (!readingComplete(room.reading)) return false;
  if ((room.materials || []).some((m) => m.mc == null)) return false;
  if ((room.dehu_outlets || []).some((o) => !readingComplete(o))) return false;
  if (room.dry == null) return false;
  return true;
}

function isMonitorReportComplete(r) {
  if (!r || Number(r.v) !== 1 || r.kind !== 'monitor') return false;
  if (!DATE_RE.test(r.session_date || '')) return false;
  if (!TIME_RE.test(r.arrival_time || '')) return false;
  if (!r.fire && !readingComplete(r.outside)) return false;
  if (!Array.isArray(r.rooms) || !r.rooms.length || !r.rooms.every((x) => isMonitorRoomComplete(x, !!r.fire))) return false;
  if (!r.photos_taken) return false;
  return true;
}

// ── Text summary (byte-for-byte twin of lib/monitorReport.ts) ────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  if (!m) return iso || '';
  return `${MONTHS[Number(m[2]) - 1] || m[2]} ${Number(m[3])}`;
}
function fmtClock(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || ''); if (!m) return hhmm || '';
  const h24 = Number(m[1]); const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${m[2]} ${h24 < 12 ? 'AM' : 'PM'}`;
}
const fmtQty = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const check = (b) => (b ? '✓' : '✗');

function fmtReading(r) {
  if (!readingComplete(r)) return '—';
  const g = gpp(r.temp_f, r.rh);
  return `${fmtQty(r.temp_f)}°F/${fmtQty(r.rh)}%${g != null ? ` (${g} GPP)` : ''}`;
}

const EQUIPMENT_PLURAL = {
  'Air Mover': ['air mover', 'air movers'],
  'Dehumidifier': ['dehumidifier', 'dehumidifiers'],
  'Dehumidifier - Large': ['dehumidifier - large', 'dehumidifiers - large'],
  'Dehumidifier - XL': ['dehumidifier - XL', 'dehumidifiers - XL'],
  'Air Scrubber': ['air scrubber', 'air scrubbers'],
  'Drying Mats': ['drying mat', 'drying mats'],
  'Heater': ['heater', 'heaters'],
};
function equipmentWord(type, n) {
  const p = EQUIPMENT_PLURAL[type];
  if (p) return p[n === 1 ? 0 : 1];
  const low = String(type).toLowerCase();
  return n === 1 ? low : low.endsWith('s') ? low : `${low}s`;
}
function equipmentPhrase(counts) {
  return Object.entries(counts).filter(([, n]) => n > 0).map(([t, n]) => `${n} ${equipmentWord(t, n)}`).join(', ');
}
function countBy(list, pick) {
  const out = {};
  for (const e of list || []) { const n = pick(e); if (n > 0) out[e.type] = (out[e.type] || 0) + n; }
  return out;
}

function materialPhrase(m) {
  if (m.mc == null) return `${m.type} —`;
  const std = dryStandard(m);
  let s = `${m.type} ${fmtQty(m.mc)}%`;
  if (m.dry_standard_mc != null) s += ` (dry ${fmtQty(m.dry_standard_mc)}%)`;
  if (m.prev_mc != null && m.prev_mc !== m.mc) {
    const d = Math.round((m.prev_mc - m.mc) * 10) / 10;
    s += d > 0 ? ` ↓${fmtQty(d)}` : ` ↑${fmtQty(-d)}`;
  }
  if (isDry(m.mc, std)) s += ' ✓';
  return s;
}

function monitorRoomLine(room, fire = false) {
  const seg = [];
  if (!fire) seg.push(fmtReading(room.reading));
  if ((room.materials || []).length) seg.push(room.materials.map(materialPhrase).join(', '));
  const outlets = room.dehu_outlets || [];
  if (outlets.length) seg.push(outlets.map((o, i) => `dehu${outlets.length > 1 ? ` ${i + 1}` : ''} outlet ${fmtReading(o)}`).join(', '));
  const running = equipmentPhrase(countBy(room.equipment, (e) => e.qty_present));
  seg.push(running ? `equipment: ${running}` : 'no equipment running');
  if (!fire) seg.push(room.dry == null ? 'dry: —' : room.dry ? 'dry' : 'not dry');
  if (room.notes && String(room.notes).trim()) seg.push(`note: ${String(room.notes).trim()}`);
  return `• ${room.name} — ${seg.join('; ')}`;
}

function pulledPhrase(r) {
  const parts = [];
  for (const room of r.rooms || []) {
    const p = equipmentPhrase(countBy(room.equipment, (e) => Math.max(0, e.qty_before - e.qty_present)));
    if (p) parts.push(`${p} (${room.name})`);
  }
  return parts.join(', ');
}
function placedPhrase(r) {
  const parts = [];
  for (const room of r.rooms || []) {
    const p = equipmentPhrase(countBy(room.equipment, (e) => Math.max(0, e.qty_present - e.qty_before)));
    if (p) parts.push(`${p} (${room.name})`);
  }
  return parts.join(', ');
}

function summarizeMonitorReport(r) {
  const lines = [];
  lines.push(`MONITOR REPORT · ${monthDay(r.session_date)}${r.fire ? ' · fire' : ''}`);
  lines.push(`Arrived ${fmtClock(r.arrival_time)}${r.departure_time ? ` · left ${fmtClock(r.departure_time)}` : ''}`);
  if (readingComplete(r.outside)) lines.push(`Outside ${fmtReading(r.outside)}`);
  lines.push(`Rooms (${(r.rooms || []).length}):`);
  for (const room of r.rooms || []) lines.push(monitorRoomLine(room, !!r.fire));
  const dryRooms = (r.rooms || []).filter((x) => x.dry === true).length;
  if (!r.fire) lines.push(`Dry rooms: ${dryRooms} of ${(r.rooms || []).length}`);
  const pulled = pulledPhrase(r);
  if (pulled) lines.push(`Equipment pulled: ${pulled}`);
  const placed = placedPhrase(r);
  if (placed) lines.push(`Equipment placed: ${placed}`);
  lines.push(`Photos ${check(r.photos_taken)}`);
  if (r.notes && String(r.notes).trim()) lines.push(`Notes: ${String(r.notes).trim()}`);
  return lines.join('\n');
}

function monitorTaskLine(r) {
  const n = (r.rooms || []).length;
  const dryRooms = (r.rooms || []).filter((x) => x.dry === true).length;
  const pulled = pulledPhrase(r);
  if (r.fire) {
    const running = {};
    for (const room of r.rooms) for (const e of room.equipment || []) if (e.qty_present > 0) running[e.type] = (running[e.type] || 0) + e.qty_present;
    const run = equipmentPhrase(running);
    return `Monitor report (fire): ${run ? `${run} running` : 'no equipment running'}${pulled ? ` · pulled ${pulled}` : ''}`;
  }
  return `Monitor report: ${dryRooms} of ${n} room${n === 1 ? '' : 's'} dry${pulled ? ` · pulled ${pulled}` : ''}`;
}

// ── Inspection report (twin of lib/inspectionReport.ts) ──────────────────────

const SOURCES = ['supply_line', 'drain', 'appliance', 'toilet', 'roof', 'sewer', 'groundwater', 'hvac', 'other'];
const SOURCE_LABEL = {
  supply_line: 'Supply line', drain: 'Drain / overflow', appliance: 'Appliance', toilet: 'Toilet', roof: 'Roof / storm',
  sewer: 'Sewer backup', groundwater: 'Groundwater / flood', hvac: 'HVAC', other: 'Other',
};
const AFFECTED = ['walls', 'flooring', 'ceiling', 'cabinets', 'contents'];
const AFFECTED_LABEL = { walls: 'Walls', flooring: 'Flooring', ceiling: 'Ceiling', cabinets: 'Cabinets', contents: 'Contents' };
const EXTERIOR_WALLS = ['none', 'long', 'short', 'both', 'custom'];
const INSPECTION_EQUIPMENT = ['Air Mover', 'Dehumidifier', 'Dehumidifier - Large', 'Dehumidifier - XL', 'Air Scrubber', 'Drying Mats'];
const FIRE_CLEANING = ['walls_ceiling', 'floor', 'baseboard', 'doors', 'cabinets', 'countertop', 'appliances', 'framing'];
const FIRE_CLEANING_LABEL = { walls_ceiling: 'Walls & ceiling', floor: 'Floor', baseboard: 'Baseboard', doors: 'Doors', cabinets: 'Cabinets', countertop: 'Countertop', appliances: 'Appliances', framing: 'Exposed framing' };
const isFire = (r) => !!r && r.loss_type === 'fire';

function validateInspectionReport(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['report must be an object'] };
  if (Number(raw.v) !== 1) errors.push('unsupported report version');
  if (raw.kind !== 'inspection') errors.push('kind must be inspection');
  const text = (v, name, max) => {
    if (v == null || v === '') return null;
    if (typeof v !== 'string') { errors.push(`${name} must be text`); return null; }
    const t = v.trim(); if (t.length > max) errors.push(`${name} is longer than ${max} characters`); return t.slice(0, max) || null;
  };
  const numIn = (v, name, lo, hi) => {
    if (v == null || v === '') return null;
    const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) { errors.push(`${name} must be a number ${lo}–${hi}`); return null; } return Math.round(n * 10) / 10;
  };
  const intIn = (v, name, lo, hi) => {
    if (v == null || v === '') return null;
    const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) { errors.push(`${name} must be a whole number ${lo}–${hi}`); return null; } return n;
  };
  const boolOrNull = (v) => (typeof v === 'boolean' ? v : null);
  const id = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 64) : null);
  const reading = (v, name) => {
    if (v == null) return null;
    if (typeof v !== 'object') { errors.push(`${name} is invalid`); return null; }
    const t = numIn(v.temp_f, `${name} temp`, -40, 150);
    const rh = numIn(v.rh, `${name} RH`, 0, 100);
    return t == null && rh == null ? null : { temp_f: t, rh };
  };
  const oneOf = (v, list) => (list.includes(v) ? v : null);

  const rooms = Array.isArray(raw.rooms) ? raw.rooms : (errors.push('rooms must be a list'), []);
  if (rooms.length > 30) errors.push('too many rooms');
  const outRooms = rooms.slice(0, 30).map((r, i) => {
    const label = `room ${i + 1}`;
    if (!r || typeof r !== 'object') { errors.push(`${label} is invalid`); return null; }
    const name = text(r.name, `${label} name`, 60) || '';
    if (!name) errors.push(`${label} needs a name`);
    let dims = null;
    if (r.dims && typeof r.dims === 'object') {
      const L = numIn(r.dims.length_ft, `${label} length`, 0, 500), W = numIn(r.dims.width_ft, `${label} width`, 0, 500), H = numIn(r.dims.ceiling_ft, `${label} ceiling`, 0, 40);
      if (L != null || W != null || H != null) dims = { length_ft: L, width_ft: W, ceiling_ft: H };
    }
    const affected = (Array.isArray(r.affected) ? r.affected : []).filter((a) => AFFECTED.includes(a)).slice(0, 5);
    const equipment = {};
    for (const t of INSPECTION_EQUIPMENT) equipment[t] = intIn(r.equipment && r.equipment[t], `${label} ${t}`, 0, 99) || 0;
    let fire;
    if (r.fire && typeof r.fire === 'object') {
      const f = r.fire; const d = f.detach && typeof f.detach === 'object' ? f.detach : {};
      fire = {
        soot: oneOf(f.soot, ['light', 'heavy']),
        cleaning: (Array.isArray(f.cleaning) ? f.cleaning : []).filter((c) => FIRE_CLEANING.includes(c)).slice(0, 8),
        detach: { outlets: intIn(d.outlets, `${label} outlets`, 0, 99) || 0, light_fixtures: intIn(d.light_fixtures, `${label} light fixtures`, 0, 99) || 0, registers: intIn(d.registers, `${label} registers`, 0, 99) || 0, blinds: intIn(d.blinds, `${label} blinds`, 0, 99) || 0 },
        cabinets_lf: { lower: numIn(f.cabinets_lf && f.cabinets_lf.lower, `${label} lower cabinets`, 0, 1000), upper: numIn(f.cabinets_lf && f.cabinets_lf.upper, `${label} upper cabinets`, 0, 1000) },
        countertop_sf: numIn(f.countertop_sf, `${label} countertop`, 0, 10000),
        appliances: (Array.isArray(f.appliances) ? f.appliances : []).filter((a) => typeof a === 'string' && a.trim()).map((a) => a.trim().slice(0, 40)).slice(0, 12),
        seal_framing: boolOrNull(f.seal_framing),
      };
    }
    return {
      room_id: id(r.room_id), name, profile: ['kitchen', 'bathroom', 'laundry', 'other'].includes(r.profile) ? r.profile : 'other', dims, affected,
      flooring: { type: text(r.flooring && r.flooring.type, `${label} flooring`, 40), on_slab: boolOrNull(r.flooring && r.flooring.on_slab) },
      materials: (Array.isArray(r.materials) ? r.materials : []).slice(0, 40).map((m, k) => (m && typeof m === 'object' && typeof m.type === 'string' && m.type.trim()
        ? { type: m.type.trim().slice(0, 40), mc: numIn(m.mc, `${label} ${m.type} MC`, 0, 100) } : (errors.push(`${label} material ${k + 1} is invalid`), null))).filter(Boolean),
      doors: intIn(r.doors, `${label} doors`, 0, 50),
      exterior_walls: oneOf(r.exterior_walls, EXTERIOR_WALLS),
      exterior_wall_lf: numIn(r.exterior_wall_lf, `${label} exterior wall LF`, 0, 10000),
      reading: reading(r.reading, `${label} temp / RH`),
      equipment,
      photos_taken: r.photos_taken === true,
      notes: text(r.notes, `${label} notes`, 500),
      ...(fire ? { fire } : {}),
    };
  }).filter(Boolean);

  const e = raw.emergency && typeof raw.emergency === 'object' ? raw.emergency : {};
  const ex = e.extraction && typeof e.extraction === 'object' ? e.extraction : null;
  const cat = intIn(raw.category, 'category', 1, 3), cls = intIn(raw.class, 'class', 1, 4);
  const dry = {};
  if (raw.dry_standards && typeof raw.dry_standards === 'object') for (const [k, v] of Object.entries(raw.dry_standards).slice(0, 60)) dry[String(k).slice(0, 40)] = numIn(v, `dry standard ${k}`, 0, 100);
  const report = {
    v: 1, kind: 'inspection',
    arrival_time: typeof raw.arrival_time === 'string' && TIME_RE.test(raw.arrival_time) ? raw.arrival_time : (errors.push('arrival_time must be HH:MM'), ''),
    departure_time: typeof raw.departure_time === 'string' && TIME_RE.test(raw.departure_time) ? raw.departure_time : null,
    loss_type: oneOf(raw.loss_type, ['water', 'fire', 'mold']),
    source: oneOf(raw.source, SOURCES),
    source_other: text(raw.source_other, 'source_other', 120),
    date_of_loss: typeof raw.date_of_loss === 'string' && DATE_RE.test(raw.date_of_loss) ? raw.date_of_loss : null,
    category: cat, class: cls,
    outside: reading(raw.outside, 'outside'),
    docusketch: boolOrNull(raw.docusketch),
    rooms: outRooms,
    dry_standards: dry,
    emergency: {
      performed: boolOrNull(e.performed),
      after_hours: e.after_hours === true,
      extraction: ex ? { floor: oneOf(ex.floor, ['carpet', 'hard_surface']), whole_room: boolOrNull(ex.whole_room), sf: numIn(ex.sf, 'extraction sq ft', 0, 100000), pump_hr: numIn(ex.pump_hr, 'pump hours', 0, 100) } : null,
      content_block_rooms: intIn(e.content_block_rooms, 'rooms blocked', 0, 99),
      content_manipulation: e.content_manipulation && typeof e.content_manipulation === 'object' ? { techs: intIn(e.content_manipulation.techs, 'content manipulation techs', 0, 99) || 0, hours: numIn(e.content_manipulation.hours, 'content manipulation hours', 0, 100) || 0 } : null,
      floor_protection_sf: numIn(e.floor_protection_sf, 'floor protection', 0, 100000),
      protective_plastic_sf: numIn(e.protective_plastic_sf, 'protective plastic', 0, 100000),
      containment_sf: numIn(e.containment_sf, 'containment', 0, 100000),
      ppe: e.ppe && typeof e.ppe === 'object' ? { techs: intIn(e.ppe.techs, 'PPE techs', 0, 99) || 0, days: intIn(e.ppe.days, 'PPE days', 0, 99) || 0 } : null,
    },
    ...(raw.fire && typeof raw.fire === 'object' ? { fire: {
      hepa_filters: intIn(raw.fire.hepa_filters, 'HEPA filters', 0, 999), supervisory_hours: numIn(raw.fire.supervisory_hours, 'supervisory hours', 0, 1000),
      dumpster_loads: intIn(raw.fire.dumpster_loads, 'dumpster loads', 0, 99), ozone: boolOrNull(raw.fire.ozone), ozone_cf: numIn(raw.fire.ozone_cf, 'ozone CF', 0, 10000000),
    } } : {}),
    moisture_map: raw.moisture_map === true,
    photos_taken: raw.photos_taken === true,
    notes: text(raw.notes, 'notes', 2000),
  };
  if (JSON.stringify(report).length > 64 * 1024) errors.push('report is too large');
  return errors.length ? { ok: false, errors } : { ok: true, report };
}

const needsWaterClass = (r) => r.loss_type === 'water' || r.loss_type == null;

function isInspectionRoomComplete(room, fire = false) {
  if (!room || !String(room.name || '').trim()) return false;
  if (!(room.affected || []).length) return false;
  if ((room.affected || []).includes('flooring') && !(room.flooring && room.flooring.type)) return false;
  if (fire) {
    if (!room.fire || !room.fire.soot) return false;
  } else {
    if ((room.materials || []).some((m) => m.mc == null)) return false;
    if (!readingComplete(room.reading)) return false;
  }
  if (!room.photos_taken) return false;
  return true;
}
function isInspectionReportComplete(r) {
  if (!r || Number(r.v) !== 1 || r.kind !== 'inspection') return false;
  if (!TIME_RE.test(r.arrival_time || '')) return false;
  if (!r.loss_type || !r.source) return false;
  if (needsWaterClass(r) && (r.category == null || r.class == null)) return false;
  const fire = isFire(r);
  if (!fire && !readingComplete(r.outside)) return false;
  if (r.docusketch == null) return false;
  if (!Array.isArray(r.rooms) || !r.rooms.length || !r.rooms.every((x) => isInspectionRoomComplete(x, fire))) return false;
  const e = r.emergency || {};
  if (e.performed == null) return false;
  if (e.performed && e.extraction && e.extraction.floor && !e.extraction.whole_room && !(e.extraction.sf > 0)) return false;
  if (!r.photos_taken) return false;
  return true;
}

function exteriorWallLF(room) {
  if (room.exterior_wall_lf != null) return room.exterior_wall_lf;
  const d = room.dims;
  if (!room.exterior_walls || room.exterior_walls === 'custom') return null;
  if (room.exterior_walls === 'none') return 0;
  if (!d || !d.length_ft || !d.width_ft) return null;
  const long = Math.max(d.length_ft, d.width_ft), short = Math.min(d.length_ft, d.width_ft);
  const r1 = (n) => Math.round(n * 10) / 10;
  return room.exterior_walls === 'long' ? r1(long) : room.exterior_walls === 'short' ? r1(short) : r1(long + short);
}

function dimsLabel(d) {
  if (!d || !d.length_ft || !d.width_ft) return null;
  return `${fmtQty(d.length_ft)}×${fmtQty(d.width_ft)}${d.ceiling_ft ? `, ${fmtQty(d.ceiling_ft)} ft ceiling` : ''}`;
}

function lossLine(r) {
  const parts = [];
  parts.push(r.loss_type ? `${r.loss_type[0].toUpperCase()}${r.loss_type.slice(1)} loss` : 'Loss');
  if (r.source) parts.push(r.source === 'other' && r.source_other ? String(r.source_other).trim() : SOURCE_LABEL[r.source].toLowerCase());
  if (r.date_of_loss) parts.push(`loss ${monthDay(r.date_of_loss)}`);
  return parts.join(' · ');
}

function fireRoomSegments(f) {
  const seg = [];
  if (f.soot) seg.push(`soot: ${f.soot}`);
  const det = [];
  const d = f.detach || {};
  if (d.outlets) det.push(`${d.outlets} outlet${d.outlets === 1 ? '' : 's'}`);
  if (d.light_fixtures) det.push(`${d.light_fixtures} light fixture${d.light_fixtures === 1 ? '' : 's'}`);
  if (d.registers) det.push(`${d.registers} register${d.registers === 1 ? '' : 's'}`);
  if (d.blinds) det.push(`${d.blinds} blind${d.blinds === 1 ? '' : 's'}`);
  if (det.length) seg.push(`detach: ${det.join(', ')}`);
  const cl = f.cleaning || [];
  if (cl.length) {
    seg.push(`clean: ${cl.map((c) => {
      if (c === 'cabinets') { const lf = f.cabinets_lf || {}; const p = [lf.lower != null ? `lower ${fmtQty(lf.lower)} LF` : null, lf.upper != null ? `upper ${fmtQty(lf.upper)} LF` : null].filter(Boolean); return `cabinets${p.length ? ` (${p.join(', ')})` : ''}`; }
      if (c === 'countertop') return `countertop${f.countertop_sf != null ? ` ${fmtQty(f.countertop_sf)} sq ft` : ''}`;
      if (c === 'appliances') return `appliances${(f.appliances || []).length ? ` (${f.appliances.map((a) => a.toLowerCase()).join(', ')})` : ''}`;
      if (c === 'framing') return `framing${f.seal_framing ? ' (seal)' : ''}`;
      return FIRE_CLEANING_LABEL[c].toLowerCase();
    }).join(', ')}`);
  }
  return seg;
}
function fireLine(f) {
  if (!f) return '';
  const parts = [];
  if (f.hepa_filters) parts.push(`${f.hepa_filters} HEPA filter${f.hepa_filters === 1 ? '' : 's'}`);
  if (f.supervisory_hours) parts.push(`supervisory ${fmtQty(f.supervisory_hours)} h`);
  if (f.dumpster_loads) parts.push(`${f.dumpster_loads} dumpster load${f.dumpster_loads === 1 ? '' : 's'}`);
  if (f.ozone) parts.push(`ozone${f.ozone_cf ? ` ${fmtQty(f.ozone_cf)} CF` : ''}`);
  return parts.length ? `Fire: ${parts.join(' · ')}` : '';
}

function inspectionRoomLine(room, dry) {
  const seg = [];
  const dims = dimsLabel(room.dims);
  const head = dims ? `• ${room.name} (${dims}) — ` : `• ${room.name} — `;
  if (!room.fire || readingComplete(room.reading)) seg.push(fmtReading(room.reading));
  if ((room.affected || []).length) seg.push(`affected: ${room.affected.map((a) => AFFECTED_LABEL[a].toLowerCase()).join(', ')}`);
  if (room.flooring && room.flooring.type) seg.push(`${room.flooring.type}${room.flooring.on_slab ? ' on slab' : ''}`);
  if ((room.materials || []).length) {
    seg.push(room.materials.map((m) => {
      const std = dry[m.type];
      return `${m.type} ${m.mc != null ? `${fmtQty(m.mc)}%` : '—'}${std != null ? ` (dry ${fmtQty(std)}%)` : ''}`;
    }).join(', '));
  }
  if (room.fire) seg.push(...fireRoomSegments(room.fire));
  const open = [];
  if (room.doors != null) open.push(`${room.doors} door${room.doors === 1 ? '' : 's'}`);
  const ext = exteriorWallLF(room);
  if (ext != null) open.push(ext === 0 ? 'no exterior walls' : `exterior walls ${fmtQty(ext)} LF`);
  if (open.length) seg.push(open.join(', '));
  const eq = equipmentPhrase(room.equipment || {});
  seg.push(eq ? `equipment: ${eq}` : 'no equipment placed');
  if (room.notes && String(room.notes).trim()) seg.push(`note: ${String(room.notes).trim()}`);
  return head + seg.join('; ');
}

function emergencyLine(e) {
  if (!e || e.performed !== true) return 'Emergency services: none';
  const parts = [];
  if (e.extraction && e.extraction.floor) {
    const qty = e.extraction.whole_room ? 'whole room' : e.extraction.sf != null ? `${fmtQty(e.extraction.sf)} sq ft` : '';
    parts.push(`extraction ${qty ? `${qty} ` : ''}${e.extraction.floor === 'carpet' ? 'carpet' : 'hard surface'}${e.extraction.pump_hr ? ` + pump ${fmtQty(e.extraction.pump_hr)} h` : ''}`);
  }
  if (e.content_block_rooms) parts.push(`${e.content_block_rooms} room${e.content_block_rooms === 1 ? '' : 's'} blocked`);
  if (e.content_manipulation && e.content_manipulation.techs > 0 && e.content_manipulation.hours > 0) parts.push(`content manipulation ${e.content_manipulation.techs}×${fmtQty(e.content_manipulation.hours)} h`);
  if (e.floor_protection_sf) parts.push(`floor protection ${fmtQty(e.floor_protection_sf)} sq ft`);
  if (e.protective_plastic_sf) parts.push(`plastic ${fmtQty(e.protective_plastic_sf)} sq ft`);
  if (e.containment_sf) parts.push(`containment ${fmtQty(e.containment_sf)} sq ft`);
  if (e.ppe && e.ppe.techs > 0 && e.ppe.days > 0) parts.push(`PPE ${e.ppe.techs}×${e.ppe.days}`);
  const body = parts.length ? parts.join(', ') : 'yes';
  return `Emergency: ${body}${e.after_hours ? ' (after hours)' : ''}`;
}

function summarizeInspectionReport(r) {
  const lines = [];
  lines.push('INSPECTION REPORT');
  lines.push(`Arrived ${fmtClock(r.arrival_time)}${r.departure_time ? ` · left ${fmtClock(r.departure_time)}` : ''}`);
  lines.push(lossLine(r));
  if (r.category != null || r.class != null) lines.push(`${r.category != null ? `Cat ${r.category}` : 'Cat —'} / ${r.class != null ? `Class ${r.class}` : 'Class —'}`);
  if (readingComplete(r.outside)) lines.push(`Outside ${fmtReading(r.outside)}`);
  lines.push(`DocuSketch ${check(r.docusketch === true)} · moisture map ${check(!!r.moisture_map)} · photos ${check(!!r.photos_taken)}`);
  lines.push(`Rooms (${(r.rooms || []).length}):`);
  for (const room of r.rooms || []) lines.push(inspectionRoomLine(room, r.dry_standards || {}));
  const ds = Object.entries(r.dry_standards || {}).filter(([, v]) => v != null);
  if (ds.length) lines.push(`Dry standards: ${ds.map(([k, v]) => `${k} ${fmtQty(v)}%`).join(', ')}`);
  const fl = fireLine(r.fire);
  if (fl) lines.push(fl);
  lines.push(emergencyLine(r.emergency));
  if (r.notes && String(r.notes).trim()) lines.push(`Notes: ${String(r.notes).trim()}`);
  return lines.join('\n');
}

function inspectionTaskLine(r) {
  const n = (r.rooms || []).length;
  const eq = {};
  for (const room of r.rooms || []) for (const [t, c] of Object.entries(room.equipment || {})) eq[t] = (eq[t] || 0) + c;
  const placed = equipmentPhrase(eq);
  return `Inspection report: ${lossLine(r)} · ${n} room${n === 1 ? '' : 's'}${placed ? ` · placed ${placed}` : ''}`;
}

// ── Closeout report (twin of lib/closeoutReport.ts) ──────────────────────────

function validateCloseoutReport(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['report must be an object'] };
  if (Number(raw.v) !== 1) errors.push('unsupported report version');
  if (raw.kind !== 'closeout') errors.push('kind must be closeout');
  const text = (v, name, max) => {
    if (v == null || v === '') return null;
    if (typeof v !== 'string') { errors.push(`${name} must be text`); return null; }
    const t = v.trim(); if (t.length > max) errors.push(`${name} is longer than ${max} characters`); return t.slice(0, max) || null;
  };
  const numIn = (v, name, lo, hi, allowNull) => {
    if (v == null || v === '') { if (allowNull) return null; errors.push(`${name} is required`); return null; }
    const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) { errors.push(`${name} must be a number ${lo}–${hi}`); return null; } return Math.round(n * 10) / 10;
  };
  const intIn = (v, name, lo, hi, d) => {
    if (v == null || v === '') return d;
    const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) { errors.push(`${name} must be a whole number ${lo}–${hi}`); return d; } return n;
  };
  const id = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 64) : null);

  const rooms = Array.isArray(raw.rooms) ? raw.rooms : (errors.push('rooms must be a list'), []);
  if (rooms.length > 30) errors.push('too many rooms');
  const outRooms = rooms.slice(0, 30).map((r, i) => {
    const label = `room ${i + 1}`;
    if (!r || typeof r !== 'object') { errors.push(`${label} is invalid`); return null; }
    const name = text(r.name, `${label} name`, 60) || '';
    if (!name) errors.push(`${label} needs a name`);
    const materials = (Array.isArray(r.materials) ? r.materials : []).slice(0, 40).map((m, k) => {
      if (!m || typeof m !== 'object') { errors.push(`${label} material ${k + 1} is invalid`); return null; }
      return {
        material_id: id(m.material_id), type: text(m.type, `${label} material ${k + 1} type`, 40) || 'Material',
        mc: numIn(m.mc, `${label} ${m.type || 'material'} MC`, 0, 100, true),
        dry_standard_mc: numIn(m.dry_standard_mc, `${label} dry standard`, 0, 100, true),
        prev_mc: numIn(m.prev_mc, `${label} previous MC`, 0, 100, true),
      };
    }).filter(Boolean);
    const equipment = (Array.isArray(r.equipment) ? r.equipment : []).slice(0, 20).map((e, k) => {
      if (!e || typeof e !== 'object') { errors.push(`${label} equipment ${k + 1} is invalid`); return null; }
      const onSite = intIn(e.qty_on_site, `${label} equipment ${k + 1} on site`, 0, 99, 0);
      return {
        equipment_id: id(e.equipment_id), type: text(e.type, `${label} equipment ${k + 1} type`, 40) || 'Equipment',
        qty_on_site: onSite,
        qty_removed: Math.min(onSite, intIn(e.qty_removed, `${label} equipment ${k + 1} removed`, 0, 99, 0)),
      };
    }).filter(Boolean);
    return {
      room_id: id(r.room_id), name, materials, equipment,
      final_cleaning: typeof r.final_cleaning === 'boolean' ? r.final_cleaning : null,
      notes: text(r.notes, `${label} notes`, 500),
    };
  }).filter(Boolean);

  const report = {
    v: 1, kind: 'closeout',
    removed_on: typeof raw.removed_on === 'string' && DATE_RE.test(raw.removed_on) ? raw.removed_on : (errors.push('removed_on must be YYYY-MM-DD'), ''),
    arrival_time: typeof raw.arrival_time === 'string' && TIME_RE.test(raw.arrival_time) ? raw.arrival_time : (errors.push('arrival_time must be HH:MM'), ''),
    departure_time: typeof raw.departure_time === 'string' && TIME_RE.test(raw.departure_time) ? raw.departure_time : null,
    rooms: outRooms,
    decontamination_count: raw.decontamination_count == null ? null : intIn(raw.decontamination_count, 'decontamination_count', 0, 999, null),
    photos_post: raw.photos_post === true,
    notes: text(raw.notes, 'notes', 2000),
  };
  if (JSON.stringify(report).length > 64 * 1024) errors.push('report is too large');
  return errors.length ? { ok: false, errors } : { ok: true, report };
}

function isCloseoutRoomComplete(room) {
  if (!room || !String(room.name || '').trim()) return false;
  if ((room.materials || []).some((m) => m.mc == null)) return false;
  if (room.final_cleaning == null) return false;
  return true;
}
function isCloseoutReportComplete(r) {
  if (!r || r.v !== 1 || r.kind !== 'closeout') return false;
  if (!DATE_RE.test(r.removed_on || '')) return false;
  if (!TIME_RE.test(r.arrival_time || '')) return false;
  if (!Array.isArray(r.rooms) || r.rooms.length === 0 || !r.rooms.every(isCloseoutRoomComplete)) return false;
  if (!r.photos_post) return false;
  return true;
}

function closeoutDryness(r) {
  const mats = (r.rooms || []).flatMap((x) => x.materials || []);
  return { dry: mats.filter((m) => isDry(m.mc, dryStandard(m))).length, total: mats.length };
}
function removedCounts(r) {
  const out = {};
  for (const room of r.rooms || []) for (const e of room.equipment || []) if (e.qty_removed > 0) out[e.type] = (out[e.type] || 0) + e.qty_removed;
  return out;
}
const removedPieces = (r) => Object.values(removedCounts(r)).reduce((a, b) => a + b, 0);
function leftPhrase(r) {
  const parts = [];
  for (const room of r.rooms || []) {
    const left = {};
    for (const e of room.equipment || []) { const n = e.qty_on_site - e.qty_removed; if (n > 0) left[e.type] = (left[e.type] || 0) + n; }
    const p = equipmentPhrase(left);
    if (p) parts.push(`${p} (${room.name})`);
  }
  return parts.join(', ');
}
function closeoutRoomLine(room) {
  const seg = [];
  if ((room.materials || []).length) seg.push(room.materials.map(materialPhrase).join(', '));
  const pulled = {};
  const left = {};
  for (const e of room.equipment || []) {
    if (e.qty_removed > 0) pulled[e.type] = (pulled[e.type] || 0) + e.qty_removed;
    const n = e.qty_on_site - e.qty_removed;
    if (n > 0) left[e.type] = (left[e.type] || 0) + n;
  }
  const p = equipmentPhrase(pulled);
  const l = equipmentPhrase(left);
  if (p) seg.push(`pulled: ${p}`);
  if (l) seg.push(`left running: ${l}`);
  if (!p && !l) seg.push('no equipment');
  seg.push(`final cleaning ${room.final_cleaning == null ? '—' : check(room.final_cleaning)}`);
  if (room.notes && room.notes.trim()) seg.push(`note: ${room.notes.trim()}`);
  return `• ${room.name} — ${seg.join('; ')}`;
}
function drynessLine(r) {
  const d = closeoutDryness(r);
  if (d.total === 0) return 'Dry: no materials on record';
  if (d.dry === d.total) return `Dry: all ${d.total} material${d.total === 1 ? '' : 's'} at or below the dry standard`;
  return `Dry: ${d.total - d.dry} of ${d.total} material${d.total === 1 ? '' : 's'} still above the dry standard`;
}
function summarizeCloseoutReport(r) {
  const lines = [];
  lines.push(`CLOSEOUT REPORT · ${monthDay(r.removed_on)}`);
  lines.push(`Arrived ${fmtClock(r.arrival_time)}${r.departure_time ? ` · left ${fmtClock(r.departure_time)}` : ''}`);
  lines.push(`Rooms (${r.rooms.length}):`);
  for (const room of r.rooms) lines.push(closeoutRoomLine(room));
  lines.push(drynessLine(r));
  const removed = equipmentPhrase(removedCounts(r));
  const pieces = removedPieces(r);
  const decon = r.decontamination_count != null ? r.decontamination_count : pieces;
  lines.push(`Equipment removed: ${removed || 'none'}${decon > 0 ? ` · ${decon} piece${decon === 1 ? '' : 's'} decontaminated` : ''}`);
  const left = leftPhrase(r);
  if (left) lines.push(`Equipment left on site: ${left}`);
  lines.push(`Post photos ${check(r.photos_post)}`);
  if (r.notes && r.notes.trim()) lines.push(`Notes: ${r.notes.trim()}`);
  return lines.join('\n');
}
function closeoutTaskLine(r) {
  const pieces = removedPieces(r);
  const d = closeoutDryness(r);
  const dry = d.total === 0 ? 'no readings' : d.dry === d.total ? 'all dry' : `${d.total - d.dry} material${d.total - d.dry === 1 ? '' : 's'} above dry standard`;
  const left = leftPhrase(r);
  return `Closeout report: ${pieces} piece${pieces === 1 ? '' : 's'} pulled · ${dry}${left ? ` · left ${left}` : ''}`;
}

// ── Registry ─────────────────────────────────────────────────────────────────
// The demo functions live in server.js (its test slices them out of the
// source), so the registry is built there with them injected.

function createReportKinds(demo) {
  return {
    demo: {
      column: 'demo_report', label: 'post-demo report',
      validate: demo.validateDemoReport, isComplete: demo.isDemoReportComplete,
      summarize: demo.summarizeDemoReport, taskLine: demo.demoReportTaskLine,
      requiredFromTechLink: true,
    },
    monitor: {
      column: 'monitor_report', label: 'monitor report',
      validate: validateMonitorReport, isComplete: isMonitorReportComplete,
      summarize: summarizeMonitorReport, taskLine: monitorTaskLine,
      requiredFromTechLink: true,
    },
    inspection: {
      column: 'inspection_report', label: 'inspection report',
      validate: validateInspectionReport, isComplete: isInspectionReportComplete,
      summarize: summarizeInspectionReport, taskLine: inspectionTaskLine,
      requiredFromTechLink: true,
    },
    // Optional on the tech link: a closeout can be marked complete without it.
    closeout: {
      column: 'closeout_report', label: 'closeout report',
      validate: validateCloseoutReport, isComplete: isCloseoutReportComplete,
      summarize: summarizeCloseoutReport, taskLine: closeoutTaskLine,
      requiredFromTechLink: false,
    },
  };
}

module.exports = {
  validateInspectionReport, isInspectionRoomComplete, isInspectionReportComplete, summarizeInspectionReport, inspectionTaskLine, exteriorWallLF,
  validateMonitorReport, isMonitorRoomComplete, isMonitorReportComplete, summarizeMonitorReport, monitorTaskLine,
  monitorRoomLine, fmtReading, equipmentPhrase, pulledPhrase, placedPhrase, monthDay, isDehu,
  validateCloseoutReport, isCloseoutRoomComplete, isCloseoutReportComplete, summarizeCloseoutReport, closeoutTaskLine, removedPieces,
  createReportKinds,
};
