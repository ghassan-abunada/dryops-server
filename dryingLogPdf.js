'use strict';
// ── Drying log PDF ───────────────────────────────────────────────────────────
// dryingLogModel(log) turns a DryingLog v1 (the app's lib/scope/dryingLog.ts,
// stored on scope_sheets.drying_log) into a matrix — days across, rooms and
// their materials down — the same idea as the app's lib/scope/dryingMatrix.ts
// so the desktop page and the PDF read the same thing. renderDryingLogPdf
// draws it: portrait up to 6 days, landscape past that; MC cells green at or
// under the material's dry standard, red above, with the change since the
// last reading; each room's temp / RH / GPP under its name, dehumidifier
// outlet readings, the units on site (short codes, legend at the bottom) and
// the outside reading on top. Many days chunk across pages, the first column
// repeated. Pure; test/dryingLogPdf.test.js.

const K = require('./pdfKit');
const { clientForPrint } = require('./estimatePricing');

const DRY_STANDARD_DEFAULT = 16;

/** DryingLog v1 → matrix model. */
function dryingLogModel(log) {
  const days = Array.isArray(log && log.days) ? log.days : [];
  const dates = days.map((d) => d.date);
  const outside = {};
  const roomsById = new Map();
  const order = [];
  for (const day of days) {
    outside[day.date] = day.outside || null;
    for (const r of day.rooms || []) {
      let room = roomsById.get(r.room_id);
      if (!room) {
        room = { room_id: r.room_id, name: r.name, atmos: {}, dehu: {}, equipment: {}, materials: [] };
        roomsById.set(r.room_id, room);
        order.push(r.room_id);
      }
      room.atmos[day.date] = r.reading || null;
      room.dehu[day.date] = Array.isArray(r.dehu_outlets) ? r.dehu_outlets : [];
      room.equipment[day.date] = Array.isArray(r.equipment) ? r.equipment : [];
      for (const m of r.materials || []) {
        let mat = room.materials.find((x) => x.material_id === m.material_id);
        if (!mat) {
          mat = { material_id: m.material_id, type: m.type, std: m.dry_standard_mc == null ? null : Number(m.dry_standard_mc), cells: {}, last: null };
          room.materials.push(mat);
        }
        if (m.mc != null && Number.isFinite(Number(m.mc))) {
          const mc = Number(m.mc);
          const std = mat.std == null ? DRY_STANDARD_DEFAULT : mat.std;
          const cell = { mc, delta: m.delta == null ? null : Number(m.delta), dry: typeof m.dry === 'boolean' ? m.dry : mc <= std };
          mat.cells[day.date] = cell;
          mat.last = cell;
        } else {
          mat.cells[day.date] = null;
        }
      }
    }
  }
  const rooms = order.map((id) => roomsById.get(id)).map((room) => ({
    ...room,
    materials: room.materials.map((m) => ({ ...m, cells: Object.fromEntries(dates.map((d) => [d, m.cells[d] || null])) })),
    hasDehu: dates.some((d) => (room.dehu[d] || []).length > 0),
    hasEquipment: dates.some((d) => (room.equipment[d] || []).length > 0),
  }));
  const lasts = rooms.flatMap((r) => r.materials.map((m) => m.last)).filter(Boolean);
  const s = (log && log.summary) || {};
  const last = days[days.length - 1];
  const allDry = typeof s.all_dry === 'boolean' ? s.all_dry : !!last && (last.rooms || []).every((r) => !r.materials || r.materials.length === 0 || r.materials.every((m) => m.dry));
  return {
    dates, outside, rooms,
    job: (log && log.job) || { id: null, name: null, address: null },
    dry_standard_note: (log && log.dry_standard_note) || `Dry standard per material from an unaffected area at inspection; ${DRY_STANDARD_DEFAULT}% when not recorded.`,
    summary: {
      first_date: s.first_date || dates[0] || null,
      last_date: s.last_date || dates[dates.length - 1] || null,
      days: typeof s.days === 'number' ? s.days : dates.length,
      all_dry: allDry,
      wet: lasts.filter((c) => !c.dry).length,
      dry: lasts.filter((c) => c.dry).length,
    },
  };
}

const fmtReading = (r) => (r && r.temp_f != null ? `${K.num(r.temp_f, 0)}°F ${K.num(r.rh, 0)}%${r.gpp != null ? `\n${K.num(r.gpp, 0)} GPP` : ''}` : '');
// Helvetica has no arrow glyphs: the change prints as a signed MC change
// (delta positive = dried since the last reading = negative change).
const fmtCell = (c) => (c ? `${K.num(c.mc, 1)}${c.delta != null && c.delta !== 0 ? (c.delta > 0 ? ` (-${K.num(c.delta, 1)})` : ` (+${K.num(-c.delta, 1)})`) : ''}` : '—');
const fmtUnits = (list) => (list && list.length ? list.map((e) => `${e.qty} ${K.equipmentCode(e.type)}`).join(' · ') : '');

/** Summary sentence shared by the PDF and the JobNimbus note. */
function summaryLine(model) {
  const s = model.summary;
  const span = s.first_date ? ` · ${K.fmtDate(s.first_date)} – ${K.fmtDate(s.last_date || s.first_date)}` : '';
  const state = s.all_dry ? 'all materials at dry standard' : `${s.wet} material${s.wet === 1 ? '' : 's'} still above standard`;
  return `${s.days} day${s.days === 1 ? '' : 's'}${span} · ${state}`;
}

/**
 * Draw the matrix at y. Chunks the date columns to what fits the page width
 * (first column repeated per chunk); a new chunk starts a new page unless the
 * page is still empty. Returns the next y.
 */
function drawDryingMatrix(doc, y, model, { font = 8, rowH = 14, labelW, minDateW = 50 } = {}) {
  const W = K.contentW(doc);
  const lw = labelW || (W > 600 ? 150 : 130);
  const perChunk = Math.max(1, Math.floor((W - lw) / minDateW));
  const dates = model.dates;
  if (!dates.length) return K.paragraph(doc, y, 'No readings recorded yet.', { size: font + 1 });
  const chunks = [];
  for (let i = 0; i < dates.length; i += perChunk) chunks.push(dates.slice(i, i + perChunk));
  const twoLine = rowH * 1.75;
  chunks.forEach((chunk, ci) => {
    if (ci > 0 && y > K.MARGIN + 10) { doc.addPage(); y = K.MARGIN; }
    const dateW = (W - lw) / chunk.length;
    const columns = [{ key: 'label', label: chunks.length > 1 ? `Days ${ci * perChunk + 1}–${ci * perChunk + chunk.length} of ${dates.length}` : '', width: lw }];
    for (const d of chunk) {
      columns.push({
        key: d, label: K.fmtMd(d), width: dateW, align: 'center', wrap: true,
        render: (r) => (r._render ? r._render(d) : ''),
        fill: (r) => (r._fill ? r._fill(d) : null),
      });
    }
    const rows = [];
    rows.push({ label: 'Outside', _render: (d) => fmtReading(model.outside[d]), _height: twoLine, _muted: true, _rule: true });
    for (const room of model.rooms) {
      rows.push({ label: room.name, _bold: true, _render: (d) => fmtUnits(room.equipment[d]), _height: rowH });
      rows.push({ label: 'Temp / RH / GPP', _indent: 8, _muted: true, _render: (d) => fmtReading(room.atmos[d]), _height: twoLine });
      if (room.hasDehu) rows.push({ label: 'Dehu outlet', _indent: 8, _muted: true, _render: (d) => (room.dehu[d] || []).map(fmtReading).join(' | '), _height: twoLine });
      for (const m of room.materials) {
        rows.push({
          label: `${m.type}${m.std != null ? ` (std ${K.num(m.std, 1)}%)` : ''}`, _indent: 8,
          _render: (d) => fmtCell(m.cells[d]),
          _fill: (d) => { const c = m.cells[d]; return c ? (c.dry ? { bg: K.COLORS.GREEN_BG, color: K.COLORS.GREEN, bold: true } : { bg: K.COLORS.RED_BG, color: K.COLORS.RED, bold: true }) : null; },
        });
      }
      rows[rows.length - 1]._rule = true;
    }
    y = K.drawTable(doc, y, { columns, rows, zebra: false, font, rowH, continuedHeader: true });
  });
  // Legend
  const used = new Set();
  for (const room of model.rooms) for (const d of dates) for (const e of room.equipment[d] || []) used.add(e.type);
  if (used.size) {
    const legend = [...used].map((t) => `${K.equipmentCode(t)} = ${t}`).join(' · ');
    y = K.paragraph(doc, y, `Units on site: ${legend}. MC in % with the change since the last reading in parentheses; green = at or under the dry standard, red = above it.`, { size: font - 0.5, color: K.COLORS.MUTED });
  } else {
    y = K.paragraph(doc, y, 'MC in % with the change since the last reading in parentheses; green = at or under the dry standard, red = above it.', { size: font - 0.5, color: K.COLORS.MUTED });
  }
  return y;
}

/** The standalone Drying Log document → Buffer. */
async function renderDryingLogPdf({ model, job, location, logoPng }) {
  const landscape = model.dates.length > 6;
  const doc = K.newDoc({ landscape, title: 'Drying Log' });
  const client = clientForPrint((job && (job.client_name || job.name)) || model.job.name) || '';
  let y = K.drawHeader(doc, {
    logoPng, locationName: location && location.name,
    title: 'Drying Log', subtitle: client, date: model.summary.last_date ? `through ${K.fmtDate(model.summary.last_date)}` : '',
    kv: [
      ['Job', job && (job.name || job.number)], ['Address', (job && job.address) || model.job.address], ['Claim', job && job.claim_number],
      ['Insurance', job && job.insurer], ['Date of loss', job && K.fmtDate(job.date_loss)], ['Days', String(model.summary.days)],
    ],
  });
  y = K.paragraph(doc, y, summaryLine(model), { size: 10, color: K.COLORS.INK, font: 'Helvetica-Bold' });
  y = drawDryingMatrix(doc, y, model, { font: landscape ? 7.5 : 8, rowH: landscape ? 13 : 14 });
  K.paragraph(doc, y, model.dry_standard_note, { size: 8, color: K.COLORS.MUTED });
  return K.finish(doc);
}

/** Loose structural check for a client-supplied DryingLog v1; returns an error string or null. */
function validateDryingLog(log) {
  if (!log || typeof log !== 'object') return 'drying_log must be an object';
  if (log.v !== 1) return 'drying_log.v must be 1';
  if (!Array.isArray(log.days)) return 'drying_log.days must be an array';
  if (log.days.length > 400) return 'drying_log has too many days';
  const inRange = (v, lo, hi) => v == null || (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi);
  const reading = (r, where) => {
    if (r == null) return null;
    if (typeof r !== 'object') return `${where} must be an object`;
    if (!inRange(r.temp_f, -60, 200)) return `${where}.temp_f out of range`;
    if (!inRange(r.rh, 0, 100)) return `${where}.rh out of range`;
    if (!inRange(r.gpp, 0, 1000)) return `${where}.gpp out of range`;
    return null;
  };
  for (let i = 0; i < log.days.length; i++) {
    const d = log.days[i];
    if (!d || typeof d !== 'object') return `days[${i}] must be an object`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d.date || ''))) return `days[${i}].date must be YYYY-MM-DD`;
    let e = reading(d.outside, `days[${i}].outside`); if (e) return e;
    if (!Array.isArray(d.rooms)) return `days[${i}].rooms must be an array`;
    for (let j = 0; j < d.rooms.length; j++) {
      const r = d.rooms[j];
      if (!r || typeof r !== 'object' || !r.room_id || typeof r.name !== 'string') return `days[${i}].rooms[${j}] needs room_id and name`;
      e = reading(r.reading, `days[${i}].rooms[${j}].reading`); if (e) return e;
      for (const o of r.dehu_outlets || []) { e = reading(o, `days[${i}].rooms[${j}].dehu_outlets`); if (e) return e; }
      for (const m of r.materials || []) {
        if (!m || typeof m !== 'object' || !m.material_id || typeof m.type !== 'string') return `days[${i}].rooms[${j}].materials needs material_id and type`;
        if (!inRange(m.mc, 0, 100)) return `days[${i}].rooms[${j}].materials ${m.type} mc out of range`;
        if (!inRange(m.dry_standard_mc, 0, 100)) return `days[${i}].rooms[${j}].materials ${m.type} dry_standard_mc out of range`;
        if (!inRange(m.delta, -100, 100)) return `days[${i}].rooms[${j}].materials ${m.type} delta out of range`;
      }
      for (const q of r.equipment || []) {
        if (!q || typeof q !== 'object' || typeof q.type !== 'string' || !inRange(q.qty, 0, 999) || q.qty == null) return `days[${i}].rooms[${j}].equipment needs type and qty`;
      }
    }
  }
  return null;
}

module.exports = { dryingLogModel, drawDryingMatrix, renderDryingLogPdf, summaryLine, validateDryingLog, DRY_STANDARD_DEFAULT };
