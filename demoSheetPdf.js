'use strict';
// ── Demo sheet PDF ───────────────────────────────────────────────────────────
// What the demo crew took out, printed for whoever writes the estimate: the
// job band, Job totals (every removed quantity summed across rooms), Site work
// (containment, floor protection, plastic, cleaning, antimicrobial, debris),
// then each room's removed items with LF / SF / Count in columns that line up
// down the page, the equipment left running, the crew's checklist and notes.
// Built from the post-demo report(s) on the job's demo visits
// (inspections.demo_report); a job with several demo days prints one block
// per day under shared totals.
//
// Pure: the router loads the rows first. The quantity rules (flood cut LF,
// drywall SF, baseboard LF, flooring SF from the typed figure or the room
// size) and the report's labels live with the report in server.js and are
// passed in as `demo`, so the sheet can never disagree with the JobNimbus
// note. A figure worked out from the room size or door count prints with "*".

const K = require('./pdfKit');
const { clientForPrint } = require('./estimatePricing');

const ITEM_ORDER = ['Flooring', 'Tack strip', 'Baseboard', 'Drywall', 'Insulation', 'Cabinets', 'Toe kick', 'Countertop', 'Shelves', 'Door trim', 'Door jamb', 'Doors', 'Drill holes', 'Detached'];
const typed = (v) => v != null && Number(v) > 0;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const upper1 = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : s);

/**
 * "Cat 2" for the header: the inspection report's water category when the job
 * has one, else the job's JobNimbus Cat field ("CAT 2" / "MOLD" / "FIRE/SMOKE").
 */
function lossCategoryLabel(inspectionCategory, jobCat) {
  const n = Number(inspectionCategory);
  if (Number.isInteger(n) && n >= 1 && n <= 3) return `Cat ${n}`;
  const t = String(jobCat || '').trim();
  if (!t) return null;
  const m = /^cat\s*(\d)$/i.exec(t);
  return m ? `Cat ${m[1]}` : t.toLowerCase().replace(/(^|[\s/])([a-z])/g, (_, a, b) => a + b.toUpperCase());
}

function fmtClock(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  if (!m) return '';
  const h24 = Number(m[1]);
  return `${h24 % 12 === 0 ? 12 : h24 % 12}:${m[2]} ${h24 < 12 ? 'AM' : 'PM'}`;
}
/** Hours between two 'HH:MM' on the same day, one decimal; null when unknown or backwards. */
function hoursBetween(from, to) {
  const a = /^(\d{2}):(\d{2})$/.exec(from || ''), b = /^(\d{2}):(\d{2})$/.exec(to || '');
  if (!a || !b) return null;
  const mins = Number(b[1]) * 60 + Number(b[2]) - (Number(a[1]) * 60 + Number(a[2]));
  return mins > 0 ? Math.round(mins / 6) / 10 : null;
}
function dimsLabel(d) {
  if (!d || !d.length_ft || !d.width_ft) return '';
  return `${K.num(d.length_ft, 1)}' x ${K.num(d.width_ft, 1)}'${d.ceiling_ft ? ` x ${K.num(d.ceiling_ft, 1)}'` : ''}`;
}

/**
 * One room → its removed-item rows. A row: { item, detail, lf?, sf?, ea?,
 * lfCalc?, sfCalc? (worked out from the room size), missing? (the quantity
 * the estimate needs was neither typed nor derivable) }.
 */
function roomRows(room, demo) {
  const rows = [];
  const x = room.extras || {};
  const fl = room.flooring || {};
  if (fl.removed) {
    const sf = demo.flooringSF(room);
    rows.push({ item: 'Flooring', detail: [(fl.types || []).join(', ') || 'Removed', x.tile_on_slab ? 'tile on slab' : null].filter(Boolean).join(' · '), sf, sfCalc: sf != null && !typed(fl.sqft), missing: sf == null });
  }
  if (typed(x.tack_strip_lf)) rows.push({ item: 'Tack strip', detail: '', lf: x.tack_strip_lf });
  const bb = room.baseboard || {};
  if (bb.kind && bb.kind !== 'none') {
    const lf = demo.baseboardLF(room);
    rows.push({ item: 'Baseboard', detail: demo.BASEBOARD_LABEL[bb.kind] || '', lf, lfCalc: lf != null && !typed(bb.lf), missing: lf == null });
  }
  const dw = room.drywall || { kind: 'none' };
  if (dw.kind && dw.kind !== 'none') {
    const cut = /^flood_cut/.test(dw.kind);
    const lf = demo.floodCutLF(room), sf = demo.drywallSF(room);
    rows.push({
      item: 'Drywall',
      detail: [demo.DRYWALL_LABEL[dw.kind] || dw.kind, cut && dw.perimeter === true ? 'full perimeter' : cut && dw.perimeter === false ? 'partial' : null].filter(Boolean).join(' · '),
      lf, sf, lfCalc: lf != null && !typed(dw.lf), sfCalc: sf != null && !typed(dw.sqft), missing: sf == null,
    });
    if (dw.insulation_removed) rows.push({ item: 'Insulation', detail: 'Removed', lf: typed(x.insulation_lf) ? x.insulation_lf : null });
  }
  const cab = room.cabinets || {};
  if ((cab.removed || []).length) {
    for (const c of cab.removed) { const lf = cab.lf && typed(cab.lf[c]) ? cab.lf[c] : null; rows.push({ item: 'Cabinets', detail: c, lf, missing: lf == null }); }
  } else if (room.cabinets_removed) {
    rows.push({ item: 'Cabinets', detail: 'Removed', missing: true });
  }
  if (typed(x.toe_kick_lf)) rows.push({ item: 'Toe kick', detail: '', lf: x.toe_kick_lf });
  if (typed(x.countertop_sf)) rows.push({ item: 'Countertop', detail: '', sf: x.countertop_sf });
  if (typed(x.shelves_lf)) rows.push({ item: 'Shelves', detail: '', lf: x.shelves_lf });
  // Trim follows the scope sheet: the typed figure, else 14 LF per door in the room.
  if (typed(x.trim_lf)) rows.push({ item: 'Door trim', detail: typed(x.doors) ? plural(x.doors, 'door', 'doors') : '', lf: x.trim_lf });
  else if (typed(x.doors)) rows.push({ item: 'Door trim', detail: `${plural(x.doors, 'door', 'doors')} · 14 LF each`, lf: 14 * x.doors, lfCalc: true });
  if (typed(x.doors_removed)) rows.push({ item: 'Doors', detail: 'Removed', ea: x.doors_removed });
  if (typed(x.door_jamb_lf)) rows.push({ item: 'Door jamb', detail: '', lf: x.door_jamb_lf });
  if (typed(x.drill_holes)) rows.push({ item: 'Drill holes', detail: '', ea: x.drill_holes });
  if ((room.appliances || []).length) rows.push({ item: 'Detached', detail: room.appliances.join(', '), ea: room.appliances.length });
  else if (room.appliances_detached) rows.push({ item: 'Detached', detail: 'Appliances' });
  return rows;
}

/** Report-level site work → rows in the same shape as roomRows. */
function siteRows(report, demo) {
  const rows = [];
  const x = report.extras;
  if (x) {
    const c = x.protection.containment, f = x.protection.floor_protection;
    if (c.setup === true) rows.push({ item: 'Containment', detail: [c.zippers ? plural(c.zippers, 'zipper', 'zippers') : null, c.tension_posts ? plural(c.tension_posts, 'tension post', 'tension posts') : null].filter(Boolean).join(' · '), sf: typed(c.sf) ? c.sf : null, missing: !typed(c.sf) });
    if (f.type && f.type !== 'none') {
      const runners = f.type === 'neoprene_runners';
      rows.push({ item: 'Floor protection', detail: upper1(demo.FLOOR_PROTECTION_LABEL[f.type] || f.type), sf: !runners && typed(f.sf) ? f.sf : null, ea: runners && typed(f.runners) ? f.runners : null, missing: runners ? !typed(f.runners) : !typed(f.sf) });
    }
    if (typed(x.protection.protective_plastic_sf)) rows.push({ item: 'Protective plastic', detail: '', sf: x.protection.protective_plastic_sf });
    if (x.cleaning.kind) rows.push({ item: 'Cleaning', detail: x.cleaning.kind === 'heavy' ? 'Heavy' : 'Light', sf: typed(x.cleaning.sf) ? x.cleaning.sf : null });
  }
  const am = x ? x.antimicrobial : null;
  // A bare "applied" is the checklist's line; it becomes site work once it has a coverage or an area.
  if (am && (am.coverage || typed(am.sf))) {
    rows.push({ item: 'Antimicrobial', detail: am.coverage ? upper1(demo.COVERAGE_LABEL[am.coverage] || am.coverage) : 'Applied', sf: typed(am.sf) ? am.sf : null });
  }
  if (x && typed(x.haul_debris_loads)) rows.push({ item: 'Debris haul', detail: plural(x.haul_debris_loads, 'load', 'loads'), ea: x.haul_debris_loads });
  return rows;
}

/** Sum room rows by item, in ITEM_ORDER. `rooms` counts the rooms the item came out of. */
function totalRows(roomsWithRows) {
  const by = new Map();
  for (const r of roomsWithRows) {
    const seen = new Set();
    for (const row of r.rows) {
      const t = by.get(row.item) || { item: row.item, lf: 0, sf: 0, ea: 0, hasLf: false, hasSf: false, hasEa: false, lfCalc: false, sfCalc: false, rooms: 0, unmeasured: 0 };
      if (row.lf != null) { t.lf += Number(row.lf); t.hasLf = true; if (row.lfCalc) t.lfCalc = true; }
      if (row.sf != null) { t.sf += Number(row.sf); t.hasSf = true; if (row.sfCalc) t.sfCalc = true; }
      if (row.ea != null) { t.ea += Number(row.ea); t.hasEa = true; }
      if (row.missing) t.unmeasured += 1;
      if (!seen.has(row.item)) { t.rooms += 1; seen.add(row.item); }
      by.set(row.item, t);
    }
  }
  const order = (i) => { const k = ITEM_ORDER.indexOf(i); return k < 0 ? ITEM_ORDER.length : k; };
  return [...by.values()].sort((a, b) => order(a.item) - order(b.item)).map((t) => ({
    item: t.item,
    detail: plural(t.rooms, 'room', 'rooms'), flag: t.unmeasured ? `${t.unmeasured} not measured` : null,
    lf: t.hasLf ? Math.round(t.lf * 10) / 10 : null, sf: t.hasSf ? Math.round(t.sf * 10) / 10 : null, ea: t.hasEa ? t.ea : null,
    lfCalc: t.lfCalc, sfCalc: t.sfCalc, missing: t.unmeasured > 0, _unmeasured: t.unmeasured,
  }));
}

function equipmentRows(report, demo) {
  const rows = [];
  const total = {};
  for (const t of demo.EQUIPMENT) total[t] = 0;
  for (const room of report.rooms || []) {
    const eq = room.equipment_left || {};
    if (!demo.EQUIPMENT.some((t) => Number(eq[t]) > 0)) continue;
    const row = { room: room.name };
    for (const t of demo.EQUIPMENT) { const n = Number(eq[t]) || 0; total[t] += n; row[t] = n ? String(n) : ''; }
    const x = room.extras || {};
    const sized = [typed(x.dehu_large) ? `${x.dehu_large} large` : null, typed(x.dehu_xl) ? `${x.dehu_xl} XL` : null].filter(Boolean).join(', ');
    if (sized && row.Dehumidifier) row.Dehumidifier = `${row.Dehumidifier} (${sized})`;
    rows.push(row);
  }
  if (rows.length) { const t = { room: 'Total', _bold: true }; for (const k of demo.EQUIPMENT) t[k] = total[k] ? String(total[k]) : ''; rows.push(t); }
  return rows;
}

function checklist(report, demo) {
  const yn = (b) => (b ? 'Yes' : 'No');
  return [
    ['Sketch before', yn(report.pre_docusketch), !report.pre_docusketch],
    ['Sketch after', yn(report.post_docusketch), !report.post_docusketch],
    ['Equipment on arrival', report.equipment_staged ? upper1(demo.STAGED_LABEL[report.equipment_staged]) : '—', false],
    ['Equipment reset', yn(report.equipment_reset), !report.equipment_reset],
    ['Antimicrobial', yn(report.antimicrobial), !report.antimicrobial],
    ['Floors and cavities cleaned', yn(report.cleaned_floors_cavities), !report.cleaned_floors_cavities],
    ['Detailed photos', yn(report.photos_detailed), !report.photos_detailed],
    ['Wide photos', `${yn(report.photos_wide)}${typed(report.photo_count) ? ` · ${report.photo_count} taken` : ''}`, !report.photos_wide],
  ];
}

/**
 * The printable model. `visits`: demo visits with a report, oldest first
 * ({ scheduled_date, demo_report, demo_report_by_name, demo_report_submitted_at }).
 */
function demoSheetModel(visits, demo) {
  const days = (visits || []).filter((v) => v && v.demo_report).map((v) => {
    const r = v.demo_report;
    const x = r.extras || null;
    const rooms = (r.rooms || []).map((room) => ({ name: room.name, dims: dimsLabel(room.dims), rows: roomRows(room, demo), special: room.special_work && String(room.special_work).trim() ? String(room.special_work).trim() : null }));
    const arrival = x && x.arrival_time ? x.arrival_time : null;
    const hours = hoursBetween(arrival, r.completed_time);
    return {
      date: v.scheduled_date || null, by: v.demo_report_by_name || null, submitted_at: v.demo_report_submitted_at || null,
      techs: r.techs || null, after_hours: !!(x && x.after_hours),
      onSite: [arrival ? `${fmtClock(arrival)} to ${fmtClock(r.completed_time)}` : r.completed_time ? `Done ${fmtClock(r.completed_time)}` : null, hours ? `${K.num(hours, 1)} hr` : null].filter(Boolean).join(' · '),
      site: siteRows(r, demo), rooms, equipment: equipmentRows(r, demo), checklist: checklist(r, demo),
      notes: r.notes && String(r.notes).trim() ? String(r.notes).trim() : null,
    };
  });
  const allRooms = days.flatMap((d) => d.rooms);
  const totals = totalRows(allRooms);
  const anyCalc = allRooms.some((r) => r.rows.some((x) => x.lfCalc || x.sfCalc));
  const unmeasured = totals.reduce((s, t) => s + (t._unmeasured || 0), 0) + days.reduce((s, d) => s + d.site.filter((r) => r.missing).length, 0);
  return { days, totals, anyCalc, unmeasured, roomCount: allRooms.length };
}

/** "3 rooms · 216 SF drywall · 2 quantities not measured" for the JobNimbus file description / note. */
function demoSheetSummary(model) {
  const dw = model.totals.find((t) => t.item === 'Drywall');
  const fl = model.totals.find((t) => t.item === 'Flooring');
  return [
    plural(model.roomCount, 'room', 'rooms'),
    dw && dw.sf != null ? `${K.num(dw.sf, 1)} SF drywall` : null,
    fl && fl.sf != null ? `${K.num(fl.sf, 1)} SF flooring` : null,
    model.unmeasured ? `${plural(model.unmeasured, 'quantity', 'quantities')} not measured` : null,
  ].filter(Boolean).join(' · ');
}

// ── Drawing ──────────────────────────────────────────────────────────────────
// Every table on the sheet is the same ledger: rows on hairlines under a
// small muted header, numbers right-aligned. The quantity tables share one
// column set (Item · Detail · LF · SF · Count), so the three number columns
// hold their edges from Job totals to the last room, and a room is a bold
// group row inside one continuous table instead of a table of its own.
const ROW_H = 13, GROUP_H = 20, FONT = 8.5, PAD = 3, STAR_W = 5;
const SF_ITEMS = new Set(['Flooring', 'Drywall', 'Countertop', 'Containment', 'Cleaning', 'Protective plastic']);
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
/** The column a missing quantity belongs in. */
function neededColumn(r) {
  if (r.item === 'Floor protection') return /runner/i.test(r.detail || '') ? 'ea' : 'sf';
  return SF_ITEMS.has(r.item) ? 'sf' : 'lf';
}

/**
 * cols: [{ label, w, align }] (one column without `w` takes what is left).
 * rows: { cells: [{ t, color?, bold?, star?, flag? }] }
 *     | { kind: 'group', name, dims }      a room's name
 *     | { kind: 'span', label, text, muted } text across every column after the first, wrapped
 * Paginates, repeats the header, and keeps a group with its first two rows.
 */
function drawLedger(doc, y, { cols: colsIn, rows }) {
  const x0 = K.MARGIN, W = K.contentW(doc);
  const fixed = colsIn.reduce((s, c) => s + (c.w || 0), 0);
  let x = x0;
  const cols = colsIn.map((c) => { const w = c.w || W - fixed; const out = { ...c, x, w }; x += w; return out; });
  const hline = (yy, color, w = 0.5) => doc.moveTo(x0, yy).lineTo(x0 + W, yy).lineWidth(w).strokeColor(color).stroke();
  const spanW = W - cols[0].w - PAD * 2;
  const header = () => {
    doc.font('Helvetica-Bold').fontSize(FONT - 1.5).fillColor(K.COLORS.MUTED);
    for (const c of cols) {
      const right = c.align === 'right';
      doc.text(c.label || '', c.x + PAD, y + (ROW_H - FONT) / 2, { width: c.w - PAD * 2 - (right ? STAR_W : 0), align: c.align || 'left', lineBreak: false });
    }
    y += ROW_H;
    hline(y, K.COLORS.RULE, 0.6);
  };
  const heightOf = (r) => {
    if (r.kind === 'group') return GROUP_H;
    if (r.kind === 'span') { doc.font('Helvetica').fontSize(FONT); return Math.max(ROW_H, doc.heightOfString(r.text, { width: spanW }) + 5); }
    return ROW_H;
  };
  header();
  rows.forEach((r, i) => {
    const h = heightOf(r);
    const keep = r.kind === 'group' ? h + rows.slice(i + 1, i + 3).filter((n) => n.kind !== 'group').reduce((s, n) => s + heightOf(n), 0) : h;
    if (y + keep > K.bottom(doc)) { doc.addPage(); y = K.MARGIN; header(); }
    const ty = y + (ROW_H - FONT) / 2 - 0.5;
    if (r.kind === 'group') {
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(K.COLORS.INK);
      const name = K.truncate(doc, r.name, W - 200);
      doc.text(name, x0 + PAD, y + 7.5, { lineBreak: false });
      const nameW = doc.widthOfString(name);
      if (r.dims) doc.font('Helvetica').fontSize(8).fillColor(K.COLORS.MUTED).text(r.dims, x0 + PAD + nameW + 8, y + 8.8, { lineBreak: false });
      y += h;
      hline(y, K.COLORS.RULE, 0.6);
      return;
    }
    if (r.kind === 'span') {
      if (r.label) doc.font('Helvetica').fontSize(FONT).fillColor(K.COLORS.INK).text(r.label, x0 + PAD, ty, { width: cols[0].w - PAD * 2, lineBreak: false });
      doc.font('Helvetica').fontSize(FONT).fillColor(r.muted ? K.COLORS.MUTED : K.COLORS.INK2).text(r.text, cols[0].x + cols[0].w + PAD, y + 2.5, { width: spanW });
      y += h;
      hline(y, K.COLORS.LINE);
      return;
    }
    r.cells.forEach((cell, k) => {
      const c = cols[k];
      if (!c || !cell || cell.t == null || cell.t === '') return;
      const right = c.align === 'right';
      const w = c.w - PAD * 2 - (right ? STAR_W : 0);
      doc.font(cell.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(FONT).fillColor(cell.color || K.COLORS.INK);
      if (right) {
        doc.text(String(cell.t), c.x + PAD, ty, { width: w, align: 'right', lineBreak: false });
        if (cell.star) doc.font('Helvetica').fontSize(FONT).fillColor(K.COLORS.MUTED).text('*', c.x + c.w - PAD - STAR_W + 1, ty, { lineBreak: false });
        return;
      }
      const flagW = cell.flag ? doc.widthOfString(`  ${cell.flag}`) : 0;
      const t = K.truncate(doc, cell.t, w - flagW);
      doc.text(t, c.x + PAD, ty, { lineBreak: false });
      if (cell.flag) { const tw = doc.widthOfString(t); doc.font('Helvetica-Bold').fillColor(K.COLORS.RED).text(cell.flag, c.x + PAD + tw + (t ? 7 : 0), ty, { lineBreak: false }); }
    });
    y += h;
    hline(y, K.COLORS.LINE);
  });
  return y + 9;
}

const QTY_COLS = (first) => [{ label: first, w: 116 }, { label: 'Detail' }, { label: 'LF', w: 58, align: 'right' }, { label: 'SF', w: 58, align: 'right' }, { label: 'Count', w: 52, align: 'right' }];
/** A quantity row → ledger cells; a missing quantity prints a red dash in its column. */
function qtyCells(r) {
  const needCol = r.missing ? neededColumn(r) : null;
  const num = (k) => (r[k] != null ? { t: K.num(r[k], 1), star: !!r[`${k}Calc`] } : needCol === k ? { t: '—', color: K.COLORS.RED, bold: true } : null);
  return { cells: [{ t: r.item }, { t: r.detail || '', color: K.COLORS.INK2, flag: r.flag || null }, num('lf'), num('sf'), num('ea')] };
}

function roomLedgerRows(rooms) {
  const out = [];
  for (const room of rooms) {
    out.push({ kind: 'group', name: room.name, dims: room.dims });
    if (room.rows.length) out.push(...room.rows.map(qtyCells));
    else out.push({ kind: 'span', label: '', text: 'Nothing removed in this room.', muted: true });
    if (room.special) out.push({ kind: 'span', label: 'Special work', text: room.special });
  }
  return out;
}

function drawChecklist(doc, y, items) {
  const W = K.contentW(doc), COLS = 4, colW = W / COLS, rowH = 23;
  const rows = Math.ceil(items.length / COLS);
  if (y + rows * rowH > K.bottom(doc)) { doc.addPage(); y = K.MARGIN; }
  items.forEach(([label, value, bad], i) => {
    const x = K.MARGIN + (i % COLS) * colW, yy = y + Math.floor(i / COLS) * rowH;
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor(K.COLORS.MUTED).text(String(label).toUpperCase(), x, yy, { width: colW - 8, characterSpacing: 0.6, lineBreak: false });
    doc.font(bad ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(bad ? K.COLORS.RED : K.COLORS.INK).text(K.truncate(doc, String(value), colW - 8), x, yy + 9, { width: colW - 8, lineBreak: false });
  });
  return y + rows * rowH + 2;
}

const SECTION = { keep: 70, size: 10.5 };
function drawDay(doc, y, day, demo, { heading }) {
  if (heading) y = K.sectionTitle(doc, y + 4, heading, { keep: 110, size: 12 });
  if (day.site.length) {
    y = K.sectionTitle(doc, y, 'Site work', SECTION) - 4;
    y = drawLedger(doc, y, { cols: QTY_COLS('Item'), rows: day.site.map(qtyCells) });
  }
  y = K.sectionTitle(doc, y, `Rooms (${day.rooms.length})`, SECTION) - 4;
  if (day.rooms.length) y = drawLedger(doc, y, { cols: QTY_COLS('Removed'), rows: roomLedgerRows(day.rooms) });
  else y = K.paragraph(doc, y + 6, 'No rooms on this report.', { size: FONT, color: K.COLORS.MUTED }) + 4;
  y = K.sectionTitle(doc, y, 'Equipment left running', SECTION) - 4;
  if (day.equipment.length) {
    y = drawLedger(doc, y, {
      cols: [{ label: 'Room' }, ...demo.EQUIPMENT.map((t) => ({ label: demo.EQUIPMENT_PLURAL[t] ? cap(demo.EQUIPMENT_PLURAL[t][1]) : t, w: 96, align: 'right' }))],
      rows: day.equipment.map((r) => ({ cells: [{ t: r.room, bold: !!r._bold }, ...demo.EQUIPMENT.map((t) => ({ t: r[t], bold: !!r._bold }))] })),
    });
  } else {
    y = K.paragraph(doc, y + 6, 'No equipment left on site.', { size: FONT, color: K.COLORS.MUTED }) + 4;
  }
  y = K.sectionTitle(doc, y, 'Checklist', { keep: 68, size: 10.5 });
  y = drawChecklist(doc, y + 2, day.checklist);
  if (day.notes) {
    y = K.sectionTitle(doc, y, 'Notes', { keep: 50, size: 10.5 });
    y = K.paragraph(doc, y, day.notes, { size: 9, color: K.COLORS.INK });
  }
  return y + 6;
}

/**
 * Render the Demo Sheet → Buffer.
 *   job, location, logoPng; visits (see demoSheetModel); demo: the report's
 *   quantity functions + labels from server.js; lossCategory: the inspection
 *   report's water category (1-3) when there is one; now: the generated stamp.
 */
async function renderDemoSheetPdf({ job, location, logoPng, visits, demo, lossCategory = null, now = new Date() }) {
  const model = demoSheetModel(visits, demo);
  const doc = K.newDoc({ title: 'Demo Sheet' });
  doc.__meta.generated = now;
  const client = clientForPrint(job.client_name || job.name) || '';
  const days = model.days;
  const firstDay = days[0] || {}, lastDay = days[days.length - 1] || {};
  const dates = days.length > 1 && firstDay.date !== lastDay.date ? `${K.fmtDate(firstDay.date)} to ${K.fmtDate(lastDay.date)}` : K.fmtDate(lastDay.date);
  const by = [...new Set(days.map((d) => d.by).filter(Boolean))].join(', ');
  const one = days.length === 1 ? days[0] : null;
  let y = K.drawHeader(doc, {
    logoPng, locationName: location && location.name,
    title: 'Demo Sheet', subtitle: client, date: dates ? `Demo ${dates}` : '',
    kv: [
      ['Job', job.name || job.number], ['Address', job.address], ['Claim', job.claim_number], ['Insurance', job.insurer],
      ['Cat of loss', lossCategoryLabel(lossCategory, job.cat)], ['Reported by', by], ['On site', one ? one.onSite : null], ['Technicians', one && one.techs ? String(one.techs) : null], ['After hours', one && one.after_hours ? 'Yes' : null],
    ],
  });

  // The key to the two marks sits under the first table that can carry them.
  const legend = [
    model.anyCalc ? '* Worked out from the room size or door count the technician entered.' : null,
    model.unmeasured ? `— Not measured on site: take ${model.unmeasured === 1 ? 'it' : 'these'} from the sketch.` : null,
  ].filter(Boolean).join('   ');
  // One room is its own total; the summary earns its place from two rooms up.
  const hasTotals = model.roomCount > 1 && model.totals.length > 0;
  if (hasTotals) {
    y = K.sectionTitle(doc, y, 'Job totals', { size: 12 }) - 4;
    y = drawLedger(doc, y, { cols: QTY_COLS('Removed'), rows: model.totals.map(qtyCells) });
    if (legend) y = K.paragraph(doc, y - 6, legend, { size: 7.5, color: K.COLORS.MUTED }) + 2;
  }

  days.forEach((day) => {
    const heading = days.length > 1 ? [`Demo ${K.fmtDate(day.date)}`, day.by, day.onSite, day.techs ? plural(day.techs, 'technician', 'technicians') : null, day.after_hours ? 'after hours' : null].filter(Boolean).join(' · ') : null;
    y = drawDay(doc, y, day, demo, { heading });
  });
  if (legend && !hasTotals) K.paragraph(doc, y, legend, { size: 7.5, color: K.COLORS.MUTED });
  return K.finish(doc);
}

module.exports = { renderDemoSheetPdf, lossCategoryLabel, demoSheetModel, demoSheetSummary, roomRows, siteRows, totalRows, hoursBetween };
