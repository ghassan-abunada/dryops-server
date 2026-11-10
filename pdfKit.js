'use strict';
// ── Shared pdfkit primitives for the job PDFs (jobPdf.js) ────────────────────
// Lifted from the photo report (server.js renderPhotoReportPdf) and wipPdf.js:
// LETTER pages with 36pt margins (portrait or landscape), a header band with
// the location logo (PNG) or its name, a title and a key/value line, a table
// that paginates itself and repeats its header on a new page, one-line
// truncation, M/D/YY dates, money, and a "Page n of m · generated <date> ·
// DryOps" footer stamped on every page by finish(). Pure: nothing here
// touches the network or the database.

const PDFDocument = require('pdfkit');

const MARGIN = 36;
const INK = '#0F172A', INK2 = '#334155', MUTED = '#64748B', RULE = '#CBD5E1', LINE = '#E2E8F0', ZEBRA = '#F1F5F9';
const NAVY = '#1E293B', BLUE = '#0369A1', GREEN = '#15803D', GREEN_BG = '#DCFCE7', RED = '#B91C1C', RED_BG = '#FEE2E2';
const COLORS = { INK, INK2, MUTED, RULE, LINE, ZEBRA, NAVY, BLUE, GREEN, GREEN_BG, RED, RED_BG };

/** A new document; `landscape` flips LETTER. Pages are buffered so finish() can number them. */
function newDoc({ landscape = false, title = 'DryOps', author = 'DryOps' } = {}) {
  const doc = new PDFDocument({ size: 'LETTER', layout: landscape ? 'landscape' : 'portrait', margin: MARGIN, bufferPages: true, autoFirstPage: true, info: { Title: title, Author: author, Creator: 'DryOps' } });
  doc.__meta = { generated: new Date() };
  return doc;
}

const pageW = (doc) => doc.page.width;
const pageH = (doc) => doc.page.height;
const contentW = (doc) => doc.page.width - MARGIN * 2;
/** Lowest y content may reach (the footer sits below). */
const bottom = (doc) => doc.page.height - MARGIN - 14;

/** "6/12/26" for YYYY-MM-DD (read as a calendar day, no TZ shift) or any Date-ish value. */
function fmtDate(v) {
  if (!v) return '';
  let d;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) { const m = v.split('-'); return `${Number(m[1])}/${Number(m[2])}/${m[0].slice(2)}`; }
  d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'numeric', day: 'numeric', year: '2-digit' }).format(d);
}
/** "6/12" for YYYY-MM-DD (matrix column heads). */
function fmtMd(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''));
  return m ? `${Number(m[2])}/${Number(m[3])}` : String(v || '');
}
/** "6/12/26 3:02 PM" Central. */
function fmtDateTime(v) {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'numeric', day: 'numeric', year: '2-digit', hour: 'numeric', minute: '2-digit' }).format(d).replace(',', '');
}
/** 1,327.20 */
const money = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** $1,327.20 */
const dollars = (n) => `$${money(n)}`;
/** 12 / 12.5 / 12.25 — numbers without trailing zeros. */
const num = (n, dp = 2) => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: dp }));

/** One-line truncation with an ellipsis at the current font. */
function truncate(doc, text, width) {
  let t = String(text == null ? '' : text).replace(/\s+/g, ' ');
  if (doc.widthOfString(t) <= width) return t;
  while (t.length && doc.widthOfString(t + '…') > width) t = t.slice(0, -1);
  return t + '…';
}

/** Header band: logo (or location name) left, title + key/value line right. Returns the next y. */
function drawHeader(doc, { logoPng, locationName, title, subtitle, kv = [], date }) {
  const x0 = MARGIN, W = contentW(doc);
  let y = MARGIN;
  let textX = x0;
  if (logoPng) {
    try { doc.image(logoPng, x0, y, { fit: [130, 40] }); textX = x0 + 142; } catch (e) { /* unreadable logo bytes: fall back to the name */ }
  }
  if (textX === x0 && locationName) {
    doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text(truncate(doc, locationName, 220), x0, y + 4, { width: 220, lineBreak: false });
    textX = x0 + 232;
  }
  const rightW = x0 + W - textX;
  doc.font('Helvetica-Bold').fontSize(16).fillColor(INK).text(truncate(doc, title, rightW), textX, y, { width: rightW, align: 'right', lineBreak: false });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED);
  if (subtitle) doc.text(truncate(doc, subtitle, rightW), textX, y + 20, { width: rightW, align: 'right', lineBreak: false });
  if (date) doc.text(truncate(doc, date, rightW), textX, y + 32, { width: rightW, align: 'right', lineBreak: false });
  y += 48;
  doc.moveTo(x0, y).lineTo(x0 + W, y).lineWidth(1).strokeColor(NAVY).stroke();
  y += 8;
  const pairs = kv.filter((p) => p && p[1] != null && String(p[1]).trim() !== '');
  if (pairs.length) {
    const perRow = Math.min(pairs.length, W > 600 ? 6 : 4);
    const colW = W / perRow;
    for (let i = 0; i < pairs.length; i += perRow) {
      pairs.slice(i, i + perRow).forEach(([label, value], k) => {
        const x = x0 + k * colW;
        doc.font('Helvetica-Bold').fontSize(6.5).fillColor(MUTED).text(String(label).toUpperCase(), x, y, { width: colW - 8, characterSpacing: 0.6, lineBreak: false });
        doc.font('Helvetica').fontSize(9).fillColor(INK).text(truncate(doc, String(value), colW - 8), x, y + 9, { width: colW - 8, lineBreak: false });
      });
      y += 24;
    }
    doc.moveTo(x0, y).lineTo(x0 + W, y).lineWidth(0.6).strokeColor(RULE).stroke();
    y += 8;
  }
  return y;
}

/** Section title with a hairline under it. Breaks the page when fewer than `keep` points remain. */
function sectionTitle(doc, y, text, { keep = 60, size = 12 } = {}) {
  if (y + keep > bottom(doc)) { doc.addPage(); y = MARGIN; }
  doc.font('Helvetica-Bold').fontSize(size).fillColor(INK).text(text, MARGIN, y, { width: contentW(doc), lineBreak: false });
  y += size + 4;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + contentW(doc), y).lineWidth(0.8).strokeColor(INK).stroke();
  return y + 6;
}

/** A paragraph that wraps and paginates. Returns the next y. */
function paragraph(doc, y, text, { size = 9, color = INK2, font = 'Helvetica', width } = {}) {
  const w = width || contentW(doc);
  doc.font(font).fontSize(size).fillColor(color);
  const h = doc.heightOfString(String(text), { width: w });
  if (y + Math.min(h, 40) > bottom(doc)) { doc.addPage(); y = MARGIN; }
  doc.text(String(text), MARGIN, y, { width: w });
  return doc.y + 4;
}

/**
 * Table: columns [{ key, label, width?, align?, render?(row) → string, fill?(row) → {bg, color}|null }],
 * rows = objects (a row may carry _bold / _muted / _rule / _indent / _height).
 * Column widths without `width` share what is left. Paginates and repeats
 * the header with "(continued)" after the title when `continuedHeader`.
 * Cells wrap when `wrap: true` on the column (height grows); else one line.
 * Returns the next y.
 */
function drawTable(doc, y, { columns, rows, zebra = true, continuedHeader = true, title, font = 9, rowH = 15, x: xOpt, width: wOpt, headerFill = null }) {
  const x0 = xOpt == null ? MARGIN : xOpt;
  const width = wOpt == null ? contentW(doc) - (x0 - MARGIN) : wOpt;
  const fixed = columns.reduce((s, c) => s + (c.width || 0), 0);
  const flex = columns.filter((c) => !c.width).length;
  const cols = columns.map((c) => ({ ...c, w: c.width || Math.max(30, (width - fixed) / Math.max(1, flex)) }));
  const pad = 3;
  const header = (continued) => {
    if (title) {
      doc.font('Helvetica-Bold').fontSize(font + 1).fillColor(INK).text(title + (continued ? ' (continued)' : ''), x0, y, { width, lineBreak: false });
      y += rowH * 1.4;
    }
    if (headerFill) doc.rect(x0, y, width, rowH).fillColor(headerFill).fill();
    doc.font('Helvetica-Bold').fontSize(font - 1.5).fillColor(MUTED);
    let x = x0;
    for (const c of cols) {
      doc.text(truncate(doc, c.label || '', c.w - pad * 2), x + pad, y + (rowH - font) / 2, { width: c.w - pad * 2, align: c.align || 'left', lineBreak: false });
      x += c.w;
    }
    y += rowH;
    doc.moveTo(x0, y).lineTo(x0 + width, y).lineWidth(0.6).strokeColor(RULE).stroke();
  };
  const cellText = (c, r) => {
    if (c.render) { const v = c.render(r); return v == null ? '' : String(v); }
    const v = r[c.key];
    return v == null ? '' : String(v);
  };
  const rowHeight = (r) => {
    if (r._height) return r._height;
    let h = rowH;
    for (const c of cols) {
      if (!c.wrap) continue;
      doc.font(r._bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(font);
      const th = doc.heightOfString(cellText(c, r), { width: c.w - pad * 2 }) + 5;
      if (th > h) h = th;
    }
    return h;
  };
  header(false);
  rows.forEach((r, i) => {
    const h = rowHeight(r);
    if (y + h > bottom(doc)) { doc.addPage(); y = MARGIN; if (continuedHeader) header(true); }
    if (zebra && i % 2 === 1) doc.rect(x0, y, width, h).fillColor(ZEBRA).fill();
    let x = x0;
    for (const c of cols) {
      const fill = c.fill ? c.fill(r) : null;
      if (fill && fill.bg) doc.rect(x + 1, y + 1, c.w - 2, h - 2).fillColor(fill.bg).fill();
      doc.font(r._bold || (fill && fill.bold) ? 'Helvetica-Bold' : 'Helvetica').fontSize(font).fillColor((fill && fill.color) || (r._muted ? MUTED : INK));
      const indent = c.key === cols[0].key && r._indent ? r._indent : 0;
      const t = cellText(c, r);
      if (c.wrap) doc.text(t, x + pad + indent, y + 2.5, { width: c.w - pad * 2 - indent, align: c.align || 'left' });
      else doc.text(truncate(doc, t, c.w - pad * 2 - indent), x + pad + indent, y + (h - font) / 2 - 0.5, { width: c.w - pad * 2 - indent, align: c.align || 'left', lineBreak: false });
      x += c.w;
    }
    y += h;
    if (r._rule) doc.moveTo(x0, y).lineTo(x0 + width, y).lineWidth(0.6).strokeColor(RULE).stroke();
  });
  doc.moveTo(x0, y).lineTo(x0 + width, y).lineWidth(0.6).strokeColor(RULE).stroke();
  return y + rowH * 0.6;
}

/** Key/value rows in two columns (label muted, value ink). Returns the next y. */
function kvBlock(doc, y, pairs, { cols = 2, font = 9, rowH = 14 } = {}) {
  const items = pairs.filter((p) => p && p[1] != null && String(p[1]).trim() !== '');
  if (!items.length) return y;
  const W = contentW(doc), colW = W / cols;
  const rowsN = Math.ceil(items.length / cols);
  if (y + rowsN * rowH > bottom(doc)) { doc.addPage(); y = MARGIN; }
  items.forEach(([k, v], i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = MARGIN + col * colW, yy = y + row * rowH;
    doc.font('Helvetica-Bold').fontSize(font - 1).fillColor(MUTED).text(truncate(doc, `${k}`, 90), x, yy, { width: 90, lineBreak: false });
    doc.font('Helvetica').fontSize(font).fillColor(INK).text(truncate(doc, String(v), colW - 100), x + 94, yy, { width: colW - 100, lineBreak: false });
  });
  return y + rowsN * rowH + 4;
}

/** Stamp the footer on every page, end the document and resolve its bytes. */
function finish(doc, { label = 'DryOps' } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const range = doc.bufferedPageRange();
    const gen = fmtDate((doc.__meta && doc.__meta.generated) || new Date());
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      // The footer sits inside the bottom margin; pdfkit would otherwise add a
      // page when text lands past page.maxY(), so lift the margin while stamping.
      const keep = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const y = doc.page.height - MARGIN + 2;
      doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
        .text(`Page ${i - range.start + 1} of ${range.count} · generated ${gen} · ${label}`, MARGIN, y, { width: doc.page.width - MARGIN * 2, align: 'right', lineBreak: false });
      doc.page.margins.bottom = keep;
    }
    doc.end();
  });
}

/** Page count of a buffered document (call before finish()). */
const pageCount = (doc) => doc.bufferedPageRange().count;
/** Page count of finished PDF bytes (pdfkit writes one /Type /Page object per page). */
function countPages(buf) {
  const s = buf.toString('latin1');
  const m = s.match(/\/Type\s*\/Page(?![s])/g);
  return m ? m.length : 0;
}

/** Short codes for the equipment column of a drying log cell ("3 AM · 1 DH"). */
const EQUIPMENT_CODE = { 'Air Mover': 'AM', Dehumidifier: 'DH', 'Dehumidifier - Large': 'DH-L', 'Dehumidifier - XL': 'DH-XL', 'Air Scrubber': 'AS', 'Drying Mats': 'DM', Heater: 'HT', 'Wall Cavity Dryer': 'WCD', 'Injectidry': 'INJ' };
function equipmentCode(type) {
  const t = String(type || 'Equipment');
  if (EQUIPMENT_CODE[t]) return EQUIPMENT_CODE[t];
  const words = t.split(/[\s-]+/).filter(Boolean);
  return words.length > 1 ? words.map((w) => w[0].toUpperCase()).join('').slice(0, 4) : t.slice(0, 3).toUpperCase();
}

module.exports = {
  MARGIN, COLORS, newDoc, pageW, pageH, contentW, bottom,
  fmtDate, fmtMd, fmtDateTime, money, dollars, num, truncate,
  drawHeader, sectionTitle, paragraph, drawTable, kvBlock, finish, pageCount, countPages,
  EQUIPMENT_CODE, equipmentCode,
};
