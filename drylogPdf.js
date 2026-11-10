'use strict';
// ── Drying log PDF: the drylog.app layout, rendered with pdfkit ──────────────
// The desktop job page builds the log the way the generator's collectData
// does (DryOps lib/drylog/model.ts buildDrylogData; the shape is pinned in
// test/fixtures/drylogData.json, copied from the app) and posts it here. The
// page prints as the generator's PDF does: a cover with the job box and the
// "DRYING LOG: N DAYS | IICRC S500" badge, then one page per room — the
// daily conditions table, the equipment table, the moisture table with the
// dates down and the materials across (dry standard row on top, DEMO cells,
// green at or under the standard, red for the initial reading), the room
// notes and its photos — and the legend. Pure apart from the photo buffers
// handed in; test/drylogPdf.test.js.

const K = require('./pdfKit');

const INK = [26, 26, 26], GRAY = [120, 120, 120], LGRAY = '#F5F5F3', WHITE = '#FFFFFF';
const GREEN = '#1A7A4A', RED = '#C0392B', AMBER = '#B47800', AMBER_BG = '#FFF3DC';
const ACCENT = K.COLORS.NAVY;
const LINE = '#BEBEBE';
const rgb = (a) => `#${a.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
const INK_HEX = rgb(INK), GRAY_HEX = rgb(GRAY);

/** Loose structural check of the client's drying log; an error string or null. */
function validateDrylog(d) {
  if (!d || typeof d !== 'object') return 'drylog must be an object';
  if (!Array.isArray(d.rooms)) return 'drylog.rooms must be an array';
  if (!Number.isInteger(d.days) || d.days < 1 || d.days > 400) return 'drylog.days must be 1–400';
  if (!Array.isArray(d.dateLabels)) return 'drylog.dateLabels must be an array';
  if (d.rooms.length > 60) return 'too many rooms';
  for (let i = 0; i < d.rooms.length; i++) {
    const r = d.rooms[i];
    if (!r || typeof r !== 'object' || typeof r.name !== 'string') return `rooms[${i}] needs a name`;
    if (!Number.isInteger(r.days) || r.days < 1 || r.days > 400) return `rooms[${i}].days must be 1–400`;
    if (!Array.isArray(r.dateLabels) || !Array.isArray(r.materials)) return `rooms[${i}] needs dateLabels and materials`;
    if (r.materials.length > 40) return `rooms[${i}] has too many materials`;
    for (let j = 0; j < r.materials.length; j++) {
      const m = r.materials[j];
      if (!m || typeof m !== 'object' || typeof m.material !== 'string') return `rooms[${i}].materials[${j}] needs a material`;
      if (!Array.isArray(m.projection) || m.projection.length !== r.days) return `rooms[${i}].materials[${j}].projection must have ${r.days} days`;
      for (const p of m.projection) {
        if (!p || typeof p !== 'object') return `rooms[${i}].materials[${j}] has a bad day`;
        if (p.mc != null && !(Number.isFinite(Number(p.mc)) && p.mc >= 0 && p.mc <= 100)) return `rooms[${i}].materials[${j}] mc out of range`;
      }
      if (m.dryStd != null && !(Number.isFinite(Number(m.dryStd)) && m.dryStd >= 0 && m.dryStd <= 100)) return `rooms[${i}].materials[${j}] dryStd out of range`;
    }
    for (const e of r.equipment || []) if (!e || typeof e !== 'object' || typeof e.type !== 'string') return `rooms[${i}] equipment needs a type`;
    for (const p of r.dailyPsychro || []) if (!p || typeof p !== 'object') return `rooms[${i}] dailyPsychro is malformed`;
    for (const ph of r.photos || []) if (!ph || typeof ph !== 'object' || typeof ph.src !== 'string') return `rooms[${i}] photos need a src`;
  }
  return null;
}

/** "Drying log · 12 days · 10/12 – 10/23 · 3 rooms · 7 materials" for the JobNimbus note. */
function drylogSummary(d) {
  const mats = d.rooms.reduce((n, r) => n + (r.materials || []).length, 0);
  const span = d.dateLabels && d.dateLabels.length ? `${d.dateLabels[0]} – ${d.dateLabels[d.dateLabels.length - 1]}` : 'dates not set';
  return `${d.days} day${d.days === 1 ? '' : 's'} · ${span} · ${d.rooms.length} room${d.rooms.length === 1 ? '' : 's'} · ${mats} material${mats === 1 ? '' : 's'}`;
}

const fmtLong = (iso) => {
  if (!iso) return '–';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (!m) return String(iso);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};

/**
 * A grid table in the generator's style: dark header with white labels,
 * hairlines around every cell, zebra body, per-cell styles through
 * `cell(r, c) → { text, color, bold, bg }`. Breaks pages itself and repeats
 * the header. Returns the next y.
 */
function grid(doc, y, { x = K.MARGIN, widths, head, rows, font = 8, rowH = 16, headFill = '#3C3C3C', firstBold = true, firstAlign = 'left' }) {
  const W = widths.reduce((a, b) => a + b, 0);
  const pad = 4;
  const header = () => {
    doc.rect(x, y, W, rowH).fillColor(headFill).fill();
    let cx = x;
    head.forEach((h, i) => {
      doc.font('Helvetica-Bold').fontSize(font - 1).fillColor(WHITE).text(K.truncate(doc, String(h), widths[i] - pad * 2), cx + pad, y + (rowH - font) / 2 - 0.5, { width: widths[i] - pad * 2, align: i === 0 ? firstAlign : 'center', lineBreak: false });
      cx += widths[i];
    });
    y += rowH;
  };
  header();
  rows.forEach((r, ri) => {
    const cells = r.cells;
    const lines = Math.max(1, ...cells.map((c) => (c && c.text ? String(c.text).split('\n').length : 1)));
    const h = rowH + (lines - 1) * (font + 2);
    if (y + h > K.bottom(doc)) { doc.addPage(); y = K.MARGIN; header(); }
    if (r.bg || ri % 2 === 1) doc.rect(x, y, W, h).fillColor(r.bg || '#FAFAFA').fill();
    let cx = x;
    cells.forEach((c, i) => {
      const cell = c || {};
      if (cell.bg) doc.rect(cx, y, widths[i], h).fillColor(cell.bg).fill();
      doc.rect(cx, y, widths[i], h).lineWidth(0.4).strokeColor(LINE).stroke();
      const bold = cell.bold || (i === 0 && firstBold);
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(font).fillColor(cell.color || INK_HEX);
      const text = cell.text == null ? '' : String(cell.text);
      doc.text(text, cx + pad, y + (rowH - font) / 2 - 0.5, { width: widths[i] - pad * 2, align: i === 0 ? firstAlign : 'center', lineBreak: true });
      cx += widths[i];
    });
    y += h;
  });
  return y;
}

/**
 * The document. `photos` maps a photo src to { buf, w, h } (already resized);
 * a src without an entry is skipped the way the generator skips a photo it
 * cannot fetch.
 */
async function renderDrylogPdf({ data, job, location, logoPng, photos = new Map(), generated }) {
  const doc = K.newDoc({ title: 'Drying Log' });
  const M = K.MARGIN, W = K.contentW(doc);
  const company = (location && location.name) || data.companyName || '';
  const claim = data.claim || (job && job.claim_number) || '';
  let y;

  const pageHeader = () => {
    doc.rect(0, 0, K.pageW(doc), 28).fillColor(LGRAY).fill();
    doc.moveTo(0, 28).lineTo(K.pageW(doc), 28).lineWidth(0.6).strokeColor('#DCDCDC').stroke();
    doc.font('Helvetica-Bold').fontSize(8).fillColor(INK_HEX).text(`${company.toUpperCase()}  |  DRYING LOG`, M, 10, { lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(8).fillColor(GRAY_HEX).text(`CLAIM: ${claim || '–'}`, M, 10, { width: W, align: 'right', lineBreak: false });
    y = 44;
  };
  const need = (h) => { if (y + h > K.bottom(doc)) { doc.addPage(); pageHeader(); } };

  // ── Cover ──────────────────────────────────────────────────────────────────
  doc.rect(0, 0, K.pageW(doc), 6).fillColor(ACCENT).fill();
  y = 16;
  let logoBottom = y + 30;
  if (logoPng) {
    try { doc.image(logoPng, M, y, { fit: [156, 40] }); logoBottom = y + 40; }
    catch (e) { doc.font('Helvetica-Bold').fontSize(14).fillColor(INK_HEX).text(company, M, y + 8, { lineBreak: false }); }
  } else {
    doc.font('Helvetica-Bold').fontSize(14).fillColor(INK_HEX).text(company, M, y + 8, { lineBreak: false });
  }
  doc.font('Helvetica').fontSize(8).fillColor(GRAY_HEX).text('IICRC S500 · WATER DAMAGE REPORT', M, y + 14, { width: W, align: 'right', lineBreak: false });
  const sepY = Math.max(y + 44, logoBottom + 10);
  doc.moveTo(M, sepY).lineTo(M + W, sepY).lineWidth(0.6).strokeColor('#DCDCDC').stroke();
  y = sepY + 16;

  // Job info box
  const boxH = 82;
  doc.roundedRect(M, y, W, boxH, 5).fillColor(LGRAY).fill();
  const fields = [
    ['CLIENT', data.client || (job && (job.client_name || job.name)) || '–'],
    ['ADDRESS', data.address || (job && job.address) || '–'],
    ['DATE OF LOSS', fmtLong(data.dateLoss || (job && job.date_loss))],
    ['DRY START DATE', fmtLong(data.dateStart)],
    ['INSURANCE COMPANY', data.insurer || (job && job.insurer) || '–'],
    ['CLAIM NUMBER', claim || '–'],
  ];
  const col1 = M + 12, col2 = M + 12 + W / 2;
  fields.forEach((f, i) => {
    const cx = i % 2 === 0 ? col1 : col2;
    const fy = y + 12 + Math.floor(i / 2) * 23;
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor(GRAY_HEX).text(f[0], cx, fy, { characterSpacing: 0.5, lineBreak: false });
    doc.font('Helvetica').fontSize(9).fillColor(INK_HEX).text(K.truncate(doc, String(f[1]), W / 2 - 24), cx, fy + 9, { lineBreak: false });
  });
  y += boxH + 14;

  // Badge
  const badge = `DRYING LOG: ${data.days} DAYS  |  IICRC S500`;
  doc.font('Helvetica-Bold').fontSize(7.5);
  const bw = doc.widthOfString(badge) + 18;
  doc.roundedRect(M, y, bw, 22, 5).fillColor(ACCENT).fill();
  doc.fillColor(WHITE).text(badge, M + 9, y + 7.5, { lineBreak: false });
  y += 36;

  // Rooms on the cover: one line each so the first page reads as a summary.
  doc.font('Helvetica-Bold').fontSize(7).fillColor(GRAY_HEX).text('ROOMS', M, y, { characterSpacing: 0.6, lineBreak: false });
  y += 12;
  data.rooms.forEach((room, ri) => {
    const mats = room.materials.map((m) => m.material).join(', ');
    const span = room.custom && room.dateLabels.length ? ` · ${room.dateLabels[0]}–${room.dateLabels[room.days - 1]} (${room.days} day${room.days === 1 ? '' : 's'})` : '';
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK_HEX).text(`${ri + 1}. ${room.name}`, M, y, { lineBreak: false });
    doc.font('Helvetica').fontSize(8.5).fillColor(GRAY_HEX).text(K.truncate(doc, `${mats || 'no readings'}${span}`, W - 150), M + 140, y + 0.5, { lineBreak: false });
    y += 14;
  });

  // ── One page per room ──────────────────────────────────────────────────────
  for (let ri = 0; ri < data.rooms.length; ri++) {
    const room = data.rooms[ri];
    doc.addPage();
    pageHeader();
    const labels = room.dateLabels || data.dateLabels || [];
    const suffix = room.custom ? `  —  ${labels[0]}–${labels[room.days - 1]}  (${room.days} DAY${room.days > 1 ? 'S' : ''})` : '';
    doc.rect(M, y, W, 24).fillColor(INK_HEX).fill();
    doc.font('Helvetica-Bold').fontSize(10).fillColor(WHITE).text(K.truncate(doc, `ROOM ${ri + 1}: ${room.name.toUpperCase()}${suffix}`, W - 20), M + 10, y + 7.5, { lineBreak: false });
    y += 34;

    if (room.dailyPsychro && room.dailyPsychro.length) {
      need(60);
      y = grid(doc, y, {
        widths: [60, 60, 50, 50, 60], font: 7, rowH: 14, headFill: '#505050',
        head: ['Date', 'Temp °F', 'RH %', 'GPP', 'Dew Pt °F'],
        rows: room.dailyPsychro.map((p, di) => ({ cells: [{ text: labels[di] || `Day ${di + 1}` }, { text: p.tempF }, { text: p.rh }, { text: p.gpp }, { text: p.dpF }] })),
      });
      y += 10;
    }

    if (room.equipment && room.equipment.length) {
      need(50);
      y = grid(doc, y, {
        widths: [170, 50], font: 8, rowH: 15, headFill: '#505050', firstBold: false,
        head: ['Equipment Type', 'Qty'],
        rows: room.equipment.map((e) => ({ cells: [{ text: e.type === 'Other' && e.label ? e.label : e.type }, { text: e.qty }] })),
      });
      y += 12;
    }

    if (room.materials.length) {
      need(80);
      const mats = room.materials;
      const firstW = 66;
      const matW = Math.max(54, Math.min(110, (W - firstW) / mats.length));
      const widths = [firstW, ...mats.map(() => matW)];
      const rows = [];
      rows.push({ bg: '#F0F0F0', cells: [{ text: 'Dry Std', bold: true }, ...mats.map((m) => ({ text: m.dryStd != null ? `${m.dryStd}%` : 'N/A', bold: true, color: GRAY_HEX }))] });
      for (let di = 0; di < room.days; di++) {
        const cells = [{ text: (labels[di] || `Day ${di + 1}`) + (di === 0 ? '\n(Initial)' : ''), bold: true }];
        for (const m of mats) {
          const p = m.projection[di];
          if (!p) { cells.push({ text: '' }); continue; }
          if (p.demoed && p.mc == null) { cells.push({ text: 'DEMO', color: AMBER, bold: true, bg: AMBER_BG }); continue; }
          if (p.afterDemo) { cells.push({ text: '' }); continue; }
          if (p.notStarted) { cells.push({ text: '–', color: GRAY_HEX }); continue; }
          const isDry = m.dryStd != null && p.mc <= m.dryStd;
          cells.push({ text: `${p.mc}%`, color: isDry ? GREEN : di === 0 ? RED : INK_HEX, bold: isDry || !!p.anchored });
        }
        rows.push({ cells });
      }
      // Chunk the material columns when a room has more than fit the width.
      const perChunk = Math.max(1, Math.floor((W - firstW) / matW));
      for (let c0 = 0; c0 < mats.length; c0 += perChunk) {
        const idx = mats.slice(c0, c0 + perChunk).map((_, k) => c0 + k + 1);
        if (c0 > 0) { need(80); }
        y = grid(doc, y, {
          widths: [firstW, ...idx.map(() => matW)], font: 8, rowH: 16, headFill: '#3C3C3C',
          head: ['Date', ...idx.map((i) => mats[i - 1].material + (mats[i - 1].startDay ? ' (exposed)' : ''))],
          rows: rows.map((r) => ({ bg: r.bg, cells: [r.cells[0], ...idx.map((i) => r.cells[i])] })),
        });
        y += 12;
      }
      void widths;
    } else {
      doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(GRAY_HEX).text('No materials with an initial reading in this room.', M, y, { lineBreak: false });
      y += 18;
    }

    if (room.notes && String(room.notes).trim()) {
      doc.font('Helvetica-Oblique').fontSize(8.5);
      const h = doc.heightOfString(String(room.notes).trim(), { width: W - 8 });
      need(h + 24);
      doc.font('Helvetica-Bold').fontSize(7).fillColor(GRAY_HEX).text('NOTES', M, y, { characterSpacing: 0.6, lineBreak: false });
      doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#505050').text(String(room.notes).trim(), M, y + 12, { width: W - 8 });
      y += h + 24;
    }

    const roomPh = (room.photos || []).map((p) => ({ ...p, img: photos.get(p.src) })).filter((p) => p.img && p.img.buf);
    if (roomPh.length) {
      need(30);
      doc.font('Helvetica-Bold').fontSize(7).fillColor(GRAY_HEX).text('PHOTOS', M, y, { characterSpacing: 0.6, lineBreak: false });
      y += 14;
      const colW = (W - 16) / 2, maxH = 226;
      let col = 0, rowH = 0;
      const anyCaption = roomPh.some((p) => p.caption);
      for (const ph of roomPh) {
        let drawW = colW, drawH = colW * ph.img.h / ph.img.w;
        if (drawH > maxH) { drawH = maxH; drawW = drawH * ph.img.w / ph.img.h; }
        if (col === 0) { need(drawH + 20); rowH = drawH; } else rowH = Math.max(rowH, drawH);
        const x = M + col * (colW + 16);
        try { doc.image(ph.img.buf, x, y, { width: drawW, height: drawH }); } catch (e) { /* bad bytes: leave the slot empty */ }
        if (ph.caption) doc.font('Helvetica').fontSize(6.5).fillColor(GRAY_HEX).text(K.truncate(doc, String(ph.caption).slice(0, 80), drawW), x, y + drawH + 4, { lineBreak: false });
        col++;
        if (col === 2) { y += rowH + (anyCaption ? 18 : 10); col = 0; rowH = 0; }
      }
      if (col !== 0) y += rowH + 10;
      y += 6;
    }
  }

  // ── Legend ─────────────────────────────────────────────────────────────────
  need(60);
  doc.rect(M, y, W, 44).fillColor(LGRAY).fill();
  doc.font('Helvetica-Bold').fontSize(8).fillColor(GRAY_HEX).text('LEGEND', M + 10, y + 11, { lineBreak: false });
  doc.font('Helvetica').fontSize(8).fillColor(RED).text('RED = above dry standard', M + 10, y + 26, { lineBreak: false });
  doc.fillColor(GREEN).text('GREEN = at or below dry standard (IICRC S500)', M + 150, y + 26, { lineBreak: false });
  doc.fillColor(AMBER).text('DEMO = material removed that day', M + 390, y + 26, { lineBreak: false });
  if (generated) doc.__meta.generated = generated;
  return K.finish(doc, { label: company ? `${company} · Confidential – for insurance purposes` : 'DryOps' });
}

module.exports = { renderDrylogPdf, validateDrylog, drylogSummary, grid };
