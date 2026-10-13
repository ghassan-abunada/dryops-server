'use strict';
// ── Visit reports (monitor today; inspection / closeout next) ────────────────
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
    const want = equipment.filter((e) => isDehu(e.type)).reduce((n, e) => n + e.qty_present, 0);
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
  };
  if (JSON.stringify(report).length > 64 * 1024) errors.push('report is too large');
  return errors.length ? { ok: false, errors } : { ok: true, report };
}

// ── Completeness ─────────────────────────────────────────────────────────────

const readingComplete = (r) => !!r && r.temp_f != null && r.rh != null;
const dryStandard = (m) => (m.dry_standard_mc != null ? m.dry_standard_mc : DRY_STANDARD_DEFAULT);
const isDry = (mc, standard) => mc != null && mc <= standard;

function isMonitorRoomComplete(room) {
  if (!room || !String(room.name || '').trim()) return false;
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
  if (!readingComplete(r.outside)) return false;
  if (!Array.isArray(r.rooms) || !r.rooms.length || !r.rooms.every(isMonitorRoomComplete)) return false;
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

function monitorRoomLine(room) {
  const seg = [];
  seg.push(fmtReading(room.reading));
  if ((room.materials || []).length) seg.push(room.materials.map(materialPhrase).join(', '));
  const outlets = room.dehu_outlets || [];
  if (outlets.length) seg.push(outlets.map((o, i) => `dehu${outlets.length > 1 ? ` ${i + 1}` : ''} outlet ${fmtReading(o)}`).join(', '));
  const running = equipmentPhrase(countBy(room.equipment, (e) => e.qty_present));
  seg.push(running ? `equipment: ${running}` : 'no equipment running');
  seg.push(room.dry == null ? 'dry: —' : room.dry ? 'dry' : 'not dry');
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
  lines.push(`MONITOR REPORT · ${monthDay(r.session_date)}`);
  lines.push(`Arrived ${fmtClock(r.arrival_time)}${r.departure_time ? ` · left ${fmtClock(r.departure_time)}` : ''}`);
  if (readingComplete(r.outside)) lines.push(`Outside ${fmtReading(r.outside)}`);
  lines.push(`Rooms (${(r.rooms || []).length}):`);
  for (const room of r.rooms || []) lines.push(monitorRoomLine(room));
  const dryRooms = (r.rooms || []).filter((x) => x.dry === true).length;
  lines.push(`Dry rooms: ${dryRooms} of ${(r.rooms || []).length}`);
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
  return `Monitor report: ${dryRooms} of ${n} room${n === 1 ? '' : 's'} dry${pulled ? ` · pulled ${pulled}` : ''}`;
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
  };
}

module.exports = {
  validateMonitorReport, isMonitorRoomComplete, isMonitorReportComplete, summarizeMonitorReport, monitorTaskLine,
  monitorRoomLine, fmtReading, equipmentPhrase, pulledPhrase, placedPhrase, monthDay, isDehu,
  createReportKinds,
};
