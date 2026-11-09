'use strict';
// ── Estimate / invoice PDF in the Xactimate contractor layout ────────────────
// Mirrors the app's components/estimates/EstimatePrint.tsx: cover (company
// block, client "First Last", property, claim, estimator, type of estimate,
// date entered, price list), General, then each room with its name + Height,
// the dimension block (SF walls / ceiling / floor, SY, LF perimeters), its
// openings, the numbered lines DESCRIPTION · QTY · UNIT · REMOVE · REPLACE ·
// TAX · TOTAL and "Totals: <room>", then Line Item Totals, Summary, Recap by
// Room, Recap by Category. The invoice variant is titled "Invoice INV-n" and
// adds Amount paid / Balance due plus the approval block. Money comes from
// estimatePricing.js over the body + frozen prices (never from stored
// per-line numbers — there are none). Pure.

const K = require('./pdfKit');
const P = require('./estimatePricing');

const COLS = { n: 24, qty: 72, remove: 60, replace: 60, tax: 56, total: 72 };

function sectionHead(doc, y, name, right) {
  if (y + 80 > K.bottom(doc)) { doc.addPage(); y = K.MARGIN; }
  const W = K.contentW(doc);
  doc.font('Helvetica-Bold').fontSize(12).fillColor(K.COLORS.INK).text(name, K.MARGIN, y, { width: W - 120, lineBreak: false });
  if (right) doc.font('Helvetica').fontSize(9.5).fillColor(K.COLORS.INK2).text(right, K.MARGIN + W - 120, y + 2, { width: 120, align: 'right', lineBreak: false });
  y += 16;
  doc.moveTo(K.MARGIN, y).lineTo(K.MARGIN + W, y).lineWidth(0.8).strokeColor(K.COLORS.INK).stroke();
  return y + 5;
}

/** Two-column dimension block: value (bold, right) then label. */
function dims(doc, y, g) {
  const items = P.dimensionBlock(g);
  const W = K.contentW(doc), colW = W / 2, rowH = 12;
  const rows = Math.ceil(items.length / 2);
  items.forEach((d, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = K.MARGIN + col * colW, yy = y + row * rowH;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(K.COLORS.INK).text(P.area(d.value), x, yy, { width: 60, align: 'right', lineBreak: false });
    doc.font('Helvetica').fontSize(8.5).fillColor(K.COLORS.INK2).text(d.label, x + 66, yy, { width: colW - 70, lineBreak: false });
  });
  return y + rows * rowH + 4;
}

function openings(doc, y, list) {
  const W = K.contentW(doc);
  doc.font('Helvetica').fontSize(8.5).fillColor(K.COLORS.INK2);
  for (const o of list) {
    if (y + 12 > K.bottom(doc)) { doc.addPage(); y = K.MARGIN; }
    doc.text(P.OPENING_LABEL[o.kind] || o.kind || 'Opening', K.MARGIN, y, { width: W * 0.4, lineBreak: false });
    doc.text(`${P.fmtFeet(o.w)} X ${P.fmtFeet(o.h)}`, K.MARGIN + W * 0.4, y, { width: W * 0.25, lineBreak: false });
    if (o.opens_into) doc.text(`Opens into ${String(o.opens_into).toUpperCase().replace(/\s+/g, '_')}`, K.MARGIN + W * 0.65, y, { width: W * 0.35, lineBreak: false });
    y += 12;
  }
  return y + 2;
}

function lineColumns() {
  return [
    { key: 'n', label: '', width: COLS.n, align: 'right' },
    { key: 'desc', label: 'DESCRIPTION', wrap: true },
    { key: 'qty', label: 'QTY', width: COLS.qty, align: 'right' },
    { key: 'remove', label: 'REMOVE', width: COLS.remove, align: 'right' },
    { key: 'replace', label: 'REPLACE', width: COLS.replace, align: 'right' },
    { key: 'tax', label: 'TAX', width: COLS.tax, align: 'right' },
    { key: 'total', label: 'TOTAL', width: COLS.total, align: 'right' },
  ];
}

function lineRow(l, n, prices, money) {
  const m = P.lineMoney(l, prices, money);
  const qty = l.qty == null ? 0 : Number(l.qty);
  const row = {
    n: `${n}.`, desc: P.lineDesc(l), qty: `${qty.toFixed(2)} ${P.lineUnit(l)}`,
    remove: P.money(m.unitRemove), replace: P.money(m.unitReplace), tax: P.money(m.tax), total: P.money(m.total),
  };
  if (l.note) row.desc = `${row.desc}\n${l.note}`;
  if (!m.priced && qty > 0) row._muted = true;
  return row;
}

function sectionTable(doc, y, { lines, isRoom, numbers, prices, money, sectionName, totals }) {
  const rows = [];
  const order = isRoom ? ['extraction', ...P.ROOM_GROUPS.filter((x) => x !== 'extraction')] : ['general'];
  for (const gk of order) {
    const ls = lines.filter((l) => (isRoom ? P.roomGroupOf(l) : 'general') === gk);
    if (!ls.length) continue;
    const label = gk === 'general' || gk === 'extraction' ? '' : P.GROUP_LABEL[gk] || gk.toUpperCase();
    if (label) rows.push({ n: '', desc: label, _bold: true, _height: 13 });
    for (const l of ls) rows.push(lineRow(l, numbers.get(l.id) || 0, prices, money));
  }
  rows.push({ n: '', desc: `Totals:  ${sectionName}`, tax: P.money(totals ? totals.tax : 0), total: P.money(totals ? totals.total : 0), _bold: true, _rule: true });
  return K.drawTable(doc, y, { columns: lineColumns(), rows, zebra: false, font: 8.5, rowH: 14, continuedHeader: true });
}

/** Boxed block with a centered title and label/value rows. */
function box(doc, y, title, rows, { rightW = 110, pctW = 60 } = {}) {
  const W = K.contentW(doc), rowH = 13, pad = 10;
  const h = pad * 2 + 16 + rows.length * rowH;
  if (y + h > K.bottom(doc)) { doc.addPage(); y = K.MARGIN; }
  doc.roundedRect(K.MARGIN, y, W, h, 5).lineWidth(0.6).strokeColor(K.COLORS.RULE).stroke();
  doc.font('Helvetica-Bold').fontSize(11).fillColor(K.COLORS.INK).text(title, K.MARGIN, y + pad, { width: W, align: 'center', lineBreak: false });
  let yy = y + pad + 16;
  for (const r of rows) {
    if (r.rule) { doc.moveTo(K.MARGIN + pad, yy).lineTo(K.MARGIN + W - pad, yy).lineWidth(0.5).strokeColor(K.COLORS.RULE).stroke(); yy += 2; }
    doc.font(r.strong ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(K.COLORS.INK);
    doc.text(r.k, K.MARGIN + pad, yy, { width: W - pad * 2 - rightW - pctW, lineBreak: false });
    doc.text(r.v, K.MARGIN + W - pad - rightW - pctW, yy, { width: rightW, align: 'right', lineBreak: false });
    if (r.pct != null) doc.text(`${Number(r.pct).toFixed(2)}%`, K.MARGIN + W - pad - pctW, yy, { width: pctW, align: 'right', lineBreak: false });
    yy += rowH;
  }
  return y + h + 10;
}

/**
 * Render an estimate or invoice.
 *   body: EstDoc v1; prices: PriceSnapshot; money: { tax, overheadPct, profitPct } (estimatePricing.moneyFacts)
 *   cover: { title, client, property, claim, insurer, estimator, typeOfEstimate, dateEntered, priceList, company, companyAddress }
 *   kind: 'estimate' | 'invoice'; number; amountPaid; approval: { signer_name, signed_at } | null; status
 */
async function renderEstimatePdf({ body, prices, money, cover, kind, number, logoPng, amountPaid = 0, approval = null, status = null, revision = null }) {
  const isInvoice = kind === 'invoice';
  const docTitle = isInvoice ? `Invoice INV-${number}` : `Estimate E-${number}`;
  const doc = K.newDoc({ landscape: false, title: `${docTitle} · ${cover.client || ''}`.trim() });
  const totals = P.docTotals(body, prices, money);
  const numbers = P.lineNumbers(body);
  const W = K.contentW(doc);
  let y = K.MARGIN;

  // Cover head: logo or company, centered.
  if (logoPng) {
    try { doc.image(logoPng, K.MARGIN + (W - 200) / 2, y, { fit: [200, 56], align: 'center', valign: 'center' }); y += 60; } catch (e) { logoPng = null; }
  }
  if (!logoPng && cover.company) {
    doc.font('Helvetica-Bold').fontSize(18).fillColor(K.COLORS.INK).text(cover.company, K.MARGIN, y, { width: W, align: 'center', lineBreak: false });
    y += 24;
  }
  if (cover.companyAddress) {
    doc.font('Helvetica').fontSize(9.5).fillColor(K.COLORS.MUTED).text(cover.companyAddress, K.MARGIN, y, { width: W, align: 'center', lineBreak: false });
    y += 14;
  }
  doc.font('Helvetica-Bold').fontSize(14).fillColor(K.COLORS.INK).text(docTitle, K.MARGIN, y + 4, { width: W, align: 'center', lineBreak: false });
  if (status && status !== 'draft') doc.font('Helvetica').fontSize(8.5).fillColor(K.COLORS.MUTED).text(`${status.toUpperCase()}${revision != null ? ` · revision ${revision}` : ''}`, K.MARGIN, y + 22, { width: W, align: 'center', lineBreak: false });
  y += 36;

  // Cover grid between two rules.
  doc.moveTo(K.MARGIN, y).lineTo(K.MARGIN + W, y).lineWidth(0.8).strokeColor(K.COLORS.RULE).stroke();
  y += 8;
  const kv = [
    ['Client', cover.client], ['Property', cover.property], ['Claim', cover.claim], ['Insurance', cover.insurer], ['Estimator', cover.estimator],
    ['Type of Estimate', cover.typeOfEstimate || (body.mold ? 'Microbial' : `Water Damage · Category ${body.category || 2}`)],
    ['Date Entered', cover.dateEntered], ['Price List', cover.priceList], [isInvoice ? 'Invoice' : 'Estimate', cover.title],
  ].filter((p) => p[1] != null && String(p[1]).trim() !== '');
  for (const [k, v] of kv) {
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(K.COLORS.INK2).text(`${k}:`, K.MARGIN, y, { width: 120, align: 'right', lineBreak: false });
    doc.font('Helvetica').fontSize(9.5).fillColor(K.COLORS.INK).text(K.truncate(doc, String(v), W - 130), K.MARGIN + 128, y, { width: W - 130, lineBreak: false });
    y += 13;
  }
  y += 4;
  doc.moveTo(K.MARGIN, y).lineTo(K.MARGIN + W, y).lineWidth(0.8).strokeColor(K.COLORS.RULE).stroke();
  y += 14;

  // Sections
  const general = Array.isArray(body.general) ? body.general : [];
  const rooms = Array.isArray(body.rooms) ? body.rooms : [];
  const sections = [];
  if (general.length) sections.push({ id: P.GENERAL, name: 'General', room: null, lines: general });
  for (const r of rooms) sections.push({ id: r.id, name: r.name, room: r, lines: Array.isArray(r.lines) ? r.lines : [] });
  for (const sec of sections) {
    const t = totals.sections.find((x) => x.id === sec.id);
    const H = sec.room && sec.room.shape && sec.room.shape.H;
    y = sectionHead(doc, y, sec.name, H ? `Height: ${P.fmtFeet(H)}` : '');
    if (sec.room) {
      const g = P.roomGeometry(sec.room);
      if (g.F != null) y = dims(doc, y, g);
      const ops = sec.room.shape && Array.isArray(sec.room.shape.openings) ? sec.room.shape.openings : [];
      if (ops.length) y = openings(doc, y, ops);
    }
    y = sectionTable(doc, y, { lines: sec.lines, isRoom: !!sec.room, numbers, prices, money, sectionName: sec.name, totals: t });
    y += 6;
  }
  if (!sections.length) y = K.paragraph(doc, y, 'No line items.', { size: 9.5 });

  // Line Item Totals (double rule)
  if (y + 30 > K.bottom(doc)) { doc.addPage(); y = K.MARGIN; }
  doc.moveTo(K.MARGIN, y).lineTo(K.MARGIN + W, y).lineWidth(2.2).strokeColor(K.COLORS.INK).stroke();
  y += 5;
  const allTax = P.c2(totals.materialTax + totals.cleaningMaterialTax + totals.cleaningTax);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(K.COLORS.INK);
  doc.text(`Line Item Totals:  ${cover.title || docTitle}`, K.MARGIN, y, { width: W - COLS.tax - COLS.total - 6, lineBreak: false });
  doc.text(P.money(allTax), K.MARGIN + W - COLS.tax - COLS.total, y, { width: COLS.tax - 3, align: 'right', lineBreak: false });
  doc.text(P.money(P.c2(totals.total - totals.overhead - totals.profit)), K.MARGIN + W - COLS.total, y, { width: COLS.total - 3, align: 'right', lineBreak: false });
  y += 22;

  // Summary
  const hasTax = totals.materialTax || totals.cleaningMaterialTax || totals.cleaningTax;
  const sum = [{ k: 'Line Item Total', v: P.money(totals.lineItemTotal) }];
  if (totals.materialTax) sum.push({ k: 'Material Sales Tax', v: P.money(totals.materialTax) });
  if (totals.cleaningMaterialTax) sum.push({ k: 'Cleaning Mtl Tax', v: P.money(totals.cleaningMaterialTax) });
  if (hasTax) sum.push({ k: 'Subtotal', v: P.money(totals.subtotal), rule: true });
  if (totals.cleaningTax) sum.push({ k: 'Cleaning Sales Tax', v: P.money(totals.cleaningTax) });
  if (totals.overhead) sum.push({ k: `Overhead (${(money.overheadPct * 100).toFixed(1)}%)`, v: P.money(totals.overhead) });
  if (totals.profit) sum.push({ k: `Profit (${(money.profitPct * 100).toFixed(1)}%)`, v: P.money(totals.profit) });
  sum.push({ k: 'Total', v: `$${P.money(totals.total)}`, strong: true, rule: true });
  if (isInvoice) {
    const paid = Number(amountPaid) || 0;
    sum.push({ k: 'Amount paid', v: `$${P.money(paid)}` });
    sum.push({ k: 'Balance due', v: `$${P.money(P.c2(totals.total - paid))}`, strong: true, rule: true });
  }
  y = box(doc, y, 'Summary', sum, { pctW: 0 });

  // Recaps
  y = box(doc, y, 'Recap by Room', [
    ...totals.recapByRoom.map((r) => ({ k: r.name, v: P.money(r.amount), pct: r.pct })),
    { k: 'Total', v: P.money(totals.lineItemTotal), pct: totals.lineItemTotal ? 100 : 0, strong: true },
  ]);
  y = box(doc, y, 'Recap by Category', [
    ...totals.recapByCategory.map((r) => ({ k: r.label, v: P.money(r.amount), pct: r.pct })),
    { k: 'Subtotal', v: P.money(totals.lineItemTotal), strong: true },
  ]);

  // Approval (invoice, or an approved estimate)
  if (approval && approval.signer_name) {
    if (y + 50 > K.bottom(doc)) { doc.addPage(); y = K.MARGIN; }
    doc.roundedRect(K.MARGIN, y, W, 42, 5).lineWidth(0.6).strokeColor(K.COLORS.RULE).stroke();
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(K.COLORS.INK).text('Approved', K.MARGIN + 10, y + 9, { width: W - 20, lineBreak: false });
    doc.font('Helvetica').fontSize(9).fillColor(K.COLORS.INK2).text(`${approval.signer_name} · ${K.fmtDateTime(approval.signed_at)}${approval.revision != null ? ` · revision ${approval.revision}` : ''}`, K.MARGIN + 10, y + 24, { width: W - 20, lineBreak: false });
    y += 52;
  }
  if (cover.estimator) {
    if (y + 30 > K.bottom(doc)) { doc.addPage(); y = K.MARGIN; }
    doc.font('Helvetica-Bold').fontSize(10).fillColor(K.COLORS.INK).text(cover.estimator, K.MARGIN, y + 14, { width: W, align: 'center', lineBreak: false });
  }
  return K.finish(doc, { label: `DryOps · catalog ${P.CATALOG_VERSION}` });
}

module.exports = { renderEstimatePdf };
