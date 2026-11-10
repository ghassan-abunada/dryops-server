'use strict';
// ── Mitigation report PDF ────────────────────────────────────────────────────
// The job's whole mitigation story in one document: the job band (client,
// address, claim, insurer, adjuster, CAT / class, dates), Scope of work per
// room (materials with initial / final MC against the dry standard and
// whether they were demoed; equipment with placed / pulled dates and the
// 24-hour periods billed), the Drying log matrix (dryingLogPdf.js, scaled to
// portrait), the Scope sheet summary (General then each room's groups with
// qty + unit, wording straight from the reviewed scope_sheets.sheet) and a
// Photos grid (Supabase photos, 3 per row, oldest first). Pure: the router
// loads and resizes everything first.

const K = require('./pdfKit');
const { drawDryingMatrix, summaryLine } = require('./dryingLogPdf');
const { clientForPrint } = require('./estimatePricing');

const DAY_MS = 86400000;
const ROOM_GROUPS = ['extraction', 'detach', 'demo', 'equipment', 'sanitize'];

/** Noon on a date-only value when no timestamp was recorded (sheet.ts `at`). */
function at(stamp, date) {
  if (stamp) { const d = new Date(stamp); if (!Number.isNaN(d.getTime())) return d; }
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(String(date))) return new Date(`${date}T12:00:00`);
  return null;
}
/** 24-hour periods between two instants, at least one (sheet.ts periodsBetween). */
const periodsBetween = (from, to) => Math.max(1, Math.ceil((to.getTime() - from.getTime()) / DAY_MS));

/** Equipment row → { placed, removed, periods, on_site } using the same rules as the scope sheet. */
function equipmentPeriods(e, now = new Date()) {
  const placed = at(e.placed_at, e.placed_on);
  const removed = at(e.removed_at, e.removed_on);
  if (!placed) return { placed: null, removed, periods: null, on_site: !removed };
  const end = removed || now;
  return { placed, removed, periods: periodsBetween(placed, end), on_site: !removed };
}

const fmtDims = (r) => {
  const L = r.length_ft, Wd = r.width_ft, H = r.ceiling_ft;
  if (L == null && Wd == null) return '';
  return `${K.num(L)}' x ${K.num(Wd)}'${H != null ? ` x ${K.num(H)}'` : ''}`;
};
const qtyText = (q) => (q && q.value != null ? K.num(q.value) : q && q.formula ? q.formula : '—');

function scopeOfWork(doc, y, { rooms, materials, equipment, now }) {
  y = K.sectionTitle(doc, y, 'Scope of work');
  if (!rooms.length) return K.paragraph(doc, y, 'No rooms recorded.', { size: 9 });
  for (const room of rooms) {
    const mats = materials.filter((m) => m.room_id === room.id);
    const eq = equipment.filter((e) => e.room_id === room.id);
    const bits = [fmtDims(room), room.flooring_type, room.on_slab ? 'on slab' : null, room.water_category ? `Cat ${room.water_category}` : null, room.water_class ? `Class ${room.water_class}` : null].filter(Boolean);
    if (y + 60 > K.bottom(doc)) { doc.addPage(); y = K.MARGIN; }
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(K.COLORS.INK).text(room.name, K.MARGIN, y, { width: K.contentW(doc) - 220, lineBreak: false });
    if (bits.length) doc.font('Helvetica').fontSize(8.5).fillColor(K.COLORS.MUTED).text(bits.join(' · '), K.MARGIN + K.contentW(doc) - 220, y + 1.5, { width: 220, align: 'right', lineBreak: false });
    y += 15;
    if (mats.length) {
      y = K.drawTable(doc, y, {
        font: 8.5, rowH: 13, zebra: true,
        columns: [
          { key: 'type', label: 'Material' },
          { key: 'initial', label: 'Initial MC', width: 70, align: 'right' },
          { key: 'final', label: 'Final MC', width: 70, align: 'right', fill: (r) => r._fill },
          { key: 'std', label: 'Dry standard', width: 80, align: 'right' },
          { key: 'demoed', label: 'Demoed', width: 90 },
        ],
        rows: mats.map((m) => {
          const std = m.dry_standard_mc;
          const fin = m.final_mc;
          const dry = fin != null && std != null ? Number(fin) <= Number(std) : fin != null ? Number(fin) <= 16 : null;
          return {
            type: m.type, initial: m.initial_mc != null ? `${K.num(m.initial_mc, 1)}%` : '—', final: fin != null ? `${K.num(fin, 1)}%` : '—',
            std: std != null ? `${K.num(std, 1)}%` : '—', demoed: m.demoed ? `Yes${m.demo_date ? ` · ${K.fmtDate(m.demo_date)}` : ''}` : 'No',
            _fill: dry == null ? null : dry ? { bg: K.COLORS.GREEN_BG, color: K.COLORS.GREEN, bold: true } : { bg: K.COLORS.RED_BG, color: K.COLORS.RED, bold: true },
          };
        }),
      });
    } else {
      y = K.paragraph(doc, y, 'No materials recorded.', { size: 8.5, color: K.COLORS.MUTED });
    }
    if (eq.length) {
      y = K.drawTable(doc, y, {
        font: 8.5, rowH: 13, zebra: true,
        columns: [
          { key: 'type', label: 'Equipment' },
          { key: 'qty', label: 'Units', width: 50, align: 'right' },
          { key: 'placed', label: 'Placed', width: 110 },
          { key: 'removed', label: 'Pulled', width: 110 },
          { key: 'periods', label: '24-hr periods', width: 80, align: 'right' },
        ],
        rows: eq.map((e) => {
          const p = equipmentPeriods(e, now);
          return {
            type: `${e.type || 'Equipment'}${e.label ? ` · ${e.label}` : ''}`, qty: String(e.qty == null ? '' : e.qty),
            placed: p.placed ? (e.placed_at ? K.fmtDateTime(p.placed) : K.fmtDate(e.placed_on)) : '—',
            removed: p.removed ? (e.removed_at ? K.fmtDateTime(p.removed) : K.fmtDate(e.removed_on)) : (p.on_site ? 'on site' : '—'),
            periods: p.periods == null ? '—' : `${p.periods}${p.on_site ? ' so far' : ''}`,
          };
        }),
      });
    }
    y += 4;
  }
  return y;
}

function scopeSheetSummary(doc, y, sheet) {
  y = K.sectionTitle(doc, y, `Scope sheet${sheet.catalog_version ? ` · catalog ${sheet.catalog_version}` : ''}`);
  const columns = [
    { key: 'n', label: '', width: 24, align: 'right' },
    { key: 'desc', label: 'Description', wrap: true },
    { key: 'qty', label: 'Qty', width: 70, align: 'right' },
    { key: 'unit', label: 'Unit', width: 40 },
  ];
  const rows = [];
  let n = 0;
  const add = (l, indent) => {
    if (l.removed) return;
    n += 1;
    rows.push({ n: `${n}.`, desc: `${l.description}${l.note ? ` (${l.note})` : ''}`, qty: qtyText(l.qty), unit: l.unit || '', _indent: indent });
  };
  rows.push({ n: '', desc: 'GENERAL', _bold: true, _height: 13 });
  for (const l of sheet.general || []) add(l, 0);
  for (const r of sheet.rooms || []) {
    rows.push({ n: '', desc: r.name ? r.name.toUpperCase() : 'ROOM', _bold: true, _height: 15 });
    for (const gk of ROOM_GROUPS) {
      const lines = ((r.groups && r.groups[gk]) || []).filter((l) => !l.removed);
      if (!lines.length) continue;
      if (gk !== 'extraction') rows.push({ n: '', desc: gk.toUpperCase(), _muted: true, _bold: true, _height: 12, _indent: 8 });
      for (const l of lines) add(l, 8);
    }
  }
  y = K.drawTable(doc, y, { columns, rows, zebra: false, font: 8.5, rowH: 13, continuedHeader: true });
  const t = sheet.totals;
  if (t) y = K.paragraph(doc, y, `Areas — ${K.num(t.sf_floor)} SF floor · ${K.num(t.sf_walls)} SF walls · ${K.num(t.lf_floor_perimeter)} LF floor perimeter`, { size: 8.5, color: K.COLORS.MUTED });
  return y;
}

function photoGrid(doc, y, photos) {
  const W = K.contentW(doc), COLS = 3, GAP = 12, colW = (W - GAP * (COLS - 1)) / COLS, imgH = Math.round(colW * 0.75), rowH = imgH + 10;
  doc.addPage(); y = K.MARGIN;
  y = K.sectionTitle(doc, y, `Photos (${photos.length})`);
  for (let i = 0; i < photos.length; i += COLS) {
    if (y + imgH > K.bottom(doc)) { doc.addPage(); y = K.MARGIN; }
    photos.slice(i, i + COLS).forEach((p, k) => {
      const x = K.MARGIN + k * (colW + GAP);
      try { doc.image(p.buf, x, y, { fit: [colW, imgH], align: 'center', valign: 'center' }); }
      catch (e) { doc.font('Helvetica').fontSize(8).fillColor(K.COLORS.MUTED).text(`[photo could not be embedded${p.caption ? `: ${p.caption}` : ''}]`, x, y, { width: colW }); }
    });
    y += rowH;
  }
  return y;
}

/**
 * Render the Mitigation Report → Buffer.
 *   job, location, logoPng; sheet: ScopeSheet v1 | null; dryingModel: dryingLogModel() | null;
 *   rooms / materials / equipment: Supabase rows; photos: [{ buf, caption }] (already resized) or []
 */
async function renderMitigationReportPdf({ job, location, logoPng, sheet, dryingModel, rooms = [], materials = [], equipment = [], photos = [], now = new Date() }) {
  const doc = K.newDoc({ landscape: false, title: 'Mitigation Report' });
  const client = clientForPrint(job.client_name || job.name) || '';
  const catClass = [sheet && sheet.category ? `Cat ${sheet.category}` : (job.cat ? `Cat ${job.cat}` : null), sheet && sheet.class ? `Class ${sheet.class}` : null].filter(Boolean).join(' / ');
  const adjuster = [job.adjuster_name, job.adjuster_phone, job.adjuster_email].filter(Boolean).join(' · ');
  let y = K.drawHeader(doc, {
    logoPng, locationName: location && location.name,
    title: 'Mitigation Report', subtitle: client, date: K.fmtDate(now),
    kv: [
      ['Job', job.name || job.number], ['Address', job.address], ['Claim', job.claim_number], ['Insurance', job.insurer], ['Adjuster', adjuster],
      ['Loss', [sheet && sheet.loss_type ? `${sheet.loss_type} loss` : null, catClass].filter(Boolean).join(' · ')],
      ['Date of loss', K.fmtDate(job.date_loss)], ['Started', K.fmtDate(job.date_start)], ['Work complete', K.fmtDate(job.date_end)], ['Record type', job.record_type],
    ],
  });
  if (location && location.office_address) y = K.paragraph(doc, y, `${location.name || ''}${location.name ? ' · ' : ''}${location.office_address}`, { size: 8.5, color: K.COLORS.MUTED });

  const sorted = [...rooms].sort((a, b) => ((a.sort_order == null ? 1e9 : a.sort_order) - (b.sort_order == null ? 1e9 : b.sort_order)) || String(a.created_at || '').localeCompare(String(b.created_at || '')));
  y = scopeOfWork(doc, y, { rooms: sorted, materials, equipment, now });

  y = K.sectionTitle(doc, y, 'Drying log', { keep: 120 });
  if (dryingModel && dryingModel.dates.length) {
    y = K.paragraph(doc, y, summaryLine(dryingModel), { size: 9, color: K.COLORS.INK, font: 'Helvetica-Bold' });
    y = drawDryingMatrix(doc, y, dryingModel, { font: 7, rowH: 12, labelW: 120, minDateW: 58 });
    y = K.paragraph(doc, y, dryingModel.dry_standard_note, { size: 7.5, color: K.COLORS.MUTED });
  } else {
    y = K.paragraph(doc, y, 'No drying log recorded yet.', { size: 9, color: K.COLORS.MUTED });
  }

  if (sheet) y = scopeSheetSummary(doc, y, sheet);
  if (photos.length) photoGrid(doc, y, photos);
  return K.finish(doc);
}

module.exports = { renderMitigationReportPdf, equipmentPeriods, periodsBetween };
