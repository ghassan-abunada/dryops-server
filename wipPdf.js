// WIP PDF exports (pdfkit). Pure: takes already-loaded data, returns a Buffer.
//
// Both documents are designed to be ONE page. Content is measured first and
// the type size steps down (10 → 9 → 8 → 7.5 pt) until it fits; only when it
// still overflows at the smallest step does the table continue on a second
// page with a "continued" header. Notes are truncated to one line.
const PDFDocument = require('pdfkit');

const PAGE = { w: 612, h: 792, m: 36 };          // LETTER portrait, 0.5" margins
const STEPS = [{ font: 10, row: 16 }, { font: 9, row: 14 }, { font: 8, row: 12 }, { font: 7.5, row: 11 }];
const INK = '#0F172A', MUTED = '#64748B', LINE = '#E2E8F0', ZEBRA = '#F1F5F9', ACC = '#0369A1';

function whole(v) { return '$' + Math.round(Number(v || 0)).toLocaleString('en-US'); }
function money(v) { return '$' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.slice(0, 10) + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function weekLabel(week) { return week ? `${fmtDate(week.start)} – ${fmtDate(week.end)}` : ''; }

// Column: { key, label, width (pt), align: 'left'|'right', money: true|'whole' }
function cellText(col, row) {
  const v = row[col.key];
  if (v == null || v === '') return '';
  if (col.money === 'whole') return whole(v);
  if (col.money) return money(v);
  return String(v);
}
function truncate(doc, text, width) {
  let t = String(text == null ? '' : text);
  if (doc.widthOfString(t) <= width) return t;
  while (t.length && doc.widthOfString(t + '…') > width) t = t.slice(0, -1);
  return t + '…';
}

// Height of a titled table at a given step, without drawing.
function tableHeight(rowCount, step, titled) {
  return (titled ? step.row * 1.5 : 0) + step.row /* header */ + rowCount * step.row + step.row * 0.8 /* gap */;
}

function pageBottom() { return PAGE.h - PAGE.m - 18; }

function drawTable(doc, y, columns, rows, step, opts = {}) {
  const x0 = PAGE.m, width = PAGE.w - PAGE.m * 2;
  const fixed = columns.reduce((s, c) => s + (c.width || 0), 0);
  const flex = columns.filter(c => !c.width).length;
  const cols = columns.map(c => ({ ...c, w: c.width || Math.max(40, (width - fixed) / Math.max(1, flex)) }));
  const title = opts.title;
  const header = (continued) => {
    if (title) {
      doc.font('Helvetica-Bold').fontSize(step.font + 1).fillColor(INK)
        .text(title + (continued ? ' (continued)' : ''), x0, y, { width, lineBreak: false });
      y += step.row * 1.5;
    }
    doc.font('Helvetica-Bold').fontSize(step.font - 1).fillColor(MUTED);
    let x = x0;
    for (const c of cols) {
      doc.text(c.label, x + 3, y + (step.row - step.font) / 2, { width: c.w - 6, align: c.align || 'left', lineBreak: false });
      x += c.w;
    }
    y += step.row;
    doc.moveTo(x0, y).lineTo(x0 + width, y).lineWidth(0.6).strokeColor(LINE).stroke();
  };
  header(false);
  rows.forEach((r, i) => {
    if (y + step.row > pageBottom()) { doc.addPage(); y = PAGE.m; header(true); }
    if (i % 2 === 1) doc.rect(x0, y, width, step.row).fillColor(ZEBRA).fill();
    const bold = !!r._bold;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(step.font).fillColor(r._muted ? MUTED : INK);
    let x = x0;
    for (const c of cols) {
      const t = truncate(doc, cellText(c, r), c.w - 6);
      doc.text(t, x + 3, y + (step.row - step.font) / 2 - 0.5, { width: c.w - 6, align: c.align || 'left', lineBreak: false });
      x += c.w;
    }
    y += step.row;
  });
  doc.moveTo(x0, y).lineTo(x0 + width, y).lineWidth(0.6).strokeColor(LINE).stroke();
  return y + step.row * 0.8;
}

function drawKpis(doc, y, kpis) {
  const width = PAGE.w - PAGE.m * 2, gap = 6;
  const w = (width - gap * (kpis.length - 1)) / kpis.length, h = 40;
  kpis.forEach((k, i) => {
    const x = PAGE.m + i * (w + gap);
    doc.roundedRect(x, y, w, h, 5).lineWidth(0.6).strokeColor(LINE).stroke();
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED).text(k.label.toUpperCase(), x + 6, y + 6, { width: w - 12, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text(k.value, x + 6, y + 17, { width: w - 12, lineBreak: false });
  });
  return y + h + 12;
}

function drawHeader(doc, { title, subtitle, meta, logoPng }) {
  let x = PAGE.m, y = PAGE.m;
  if (logoPng) {
    try { doc.image(logoPng, x, y, { fit: [120, 36] }); x += 130; } catch (e) { /* unreadable logo: skip */ }
  }
  doc.font('Helvetica-Bold').fontSize(18).fillColor(INK).text(title, x, y, { width: PAGE.w - PAGE.m - x - 180, lineBreak: false });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(subtitle, x, y + 22, { width: PAGE.w - PAGE.m - x - 180, lineBreak: false });
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(meta, PAGE.w - PAGE.m - 180, y + 4, { width: 180, align: 'right' });
  y += 46;
  doc.moveTo(PAGE.m, y).lineTo(PAGE.w - PAGE.m, y).lineWidth(0.8).strokeColor(ACC).stroke();
  return y + 10;
}

function drawFooter(doc, label) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
      .text(`${label} · page ${i - range.start + 1} of ${range.count}`, PAGE.m, PAGE.h - PAGE.m - 12, { width: PAGE.w - PAGE.m * 2, align: 'center', lineBreak: false });
  }
}

function pickStep(blocks) {
  // blocks: [{ rows, titled }] — choose the first step where everything fits one page.
  const avail = pageBottom() - (PAGE.m + 56 + 52); // header + KPI strip
  for (const step of STEPS) {
    const h = blocks.reduce((s, b) => s + tableHeight(b.rows, step, b.titled), 0);
    if (h <= avail) return { step, fits: true };
  }
  return { step: STEPS[STEPS.length - 1], fits: false };
}

function finish(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

// One location. data = loadLocation() output + { inProg, coll, ipTotal, cTotal }
// from reportLists(); extra = { collected, invoiced, lastWeek, week, generatedBy }.
async function renderLocationPdf({ data, lists, extra, logoPng }) {
  const doc = new PDFDocument({ size: 'LETTER', margin: PAGE.m, bufferPages: true, info: { Title: `WIP — ${data.label}` } });
  const generated = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  let y = drawHeader(doc, {
    title: `WIP — ${data.label}`,
    subtitle: `Week of ${weekLabel(extra.week)}`,
    meta: `Generated ${generated}${extra.generatedBy ? ' by ' + extra.generatedBy : ''}\n${data.lastUpdate ? 'Owner updated ' + fmtDate(data.lastUpdate) + (data.lastBy ? ' by ' + data.lastBy : '') : 'No owner input yet'}`,
    logoPng,
  });
  y = drawKpis(doc, y, [
    { label: `In Progress · ${lists.inProg.length} job${lists.inProg.length === 1 ? '' : 's'}`, value: whole(lists.ipTotal) },
    { label: `Collecting this week · ${lists.coll.length}`, value: whole(lists.cTotal) },
    { label: 'AR', value: whole(data.arTotal) },
    { label: 'Bank balance', value: data.bank ? whole(data.bank.balance) : 'not entered' },
  ]);
  const { step } = pickStep([{ rows: Math.max(1, lists.inProg.length), titled: true }, { rows: Math.max(1, lists.coll.length), titled: true }]);
  const ipRows = lists.inProg.map(r => ({ name: r.name + (r.oop ? '  · OOP' : ''), status: r.status, started: r.created ? fmtDate(r.created) : '', amount: r.amount, paying: r.collect_amount, note: r.note || '' }));
  const cRows = lists.coll.map(r => ({ name: r.name, status: r.status, due: r.due, amount: r.amount, why: [r.why, r.note].filter(Boolean).join(' · ') }));
  y = drawTable(doc, y, [
    { key: 'name', label: 'Job' },
    { key: 'status', label: 'Status', width: 84 },
    { key: 'started', label: 'Started', width: 60 },
    { key: 'amount', label: 'Worth', width: 64, align: 'right', money: 'whole' },
    { key: 'paying', label: 'Paying this wk', width: 72, align: 'right', money: 'whole' },
    { key: 'note', label: 'Note', width: 130 },
  ], ipRows.length ? ipRows : [{ name: '(none)', _muted: true }], step, { title: `In Progress — ${whole(lists.ipTotal)}` });
  y = drawTable(doc, y, [
    { key: 'name', label: 'Job' },
    { key: 'status', label: 'Status', width: 84 },
    { key: 'due', label: 'They owe', width: 64, align: 'right', money: 'whole' },
    { key: 'amount', label: 'This week', width: 64, align: 'right', money: true },
    { key: 'why', label: 'Why', width: 200 },
  ], cRows.length ? cRows : [{ name: '(none)', _muted: true }], step, { title: `Collecting this week — ${whole(lists.cTotal)}` });
  drawFooter(doc, `DryOps WIP · ${data.label}`);
  return finish(doc);
}

// One manager (or all locations): a single summary table, one row per location.
async function renderManagerPdf({ title, week, lastWeek, generatedBy, rows, totals }) {
  const doc = new PDFDocument({ size: 'LETTER', margin: PAGE.m, bufferPages: true, info: { Title: title } });
  const generated = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  let y = drawHeader(doc, {
    title, subtitle: `Week of ${weekLabel(week)}`,
    meta: `Generated ${generated}${generatedBy ? ' by ' + generatedBy : ''}\n${rows.length} location${rows.length === 1 ? '' : 's'}`,
  });
  // Each location stands on its own: one row each, no totals across locations.
  const { step } = pickStep([{ rows: rows.length, titled: true }]);
  const body = rows.map(r => ({
    label: r.label, ipn: `${r.ipCount}`, ip: r.ipTotal, coln: `${r.cCount}`, col: r.cTotal, ar: r.arTotal, bank: r.bank ? r.bank.balance : null,
    report: [r.lastSent ? 'sent' : 'not sent', r.ipMissing + r.wcMissing ? `${r.ipMissing + r.wcMissing} need a #` : ''].filter(Boolean).join(' · '),
  }));
  drawTable(doc, y, [
    { key: 'label', label: 'Location' },
    { key: 'ipn', label: 'Jobs', width: 32, align: 'right' },
    { key: 'ip', label: 'In Progress', width: 64, align: 'right', money: 'whole' },
    { key: 'coln', label: 'Jobs', width: 32, align: 'right' },
    { key: 'col', label: 'Collecting', width: 64, align: 'right', money: 'whole' },
    { key: 'bank', label: 'Bank', width: 64, align: 'right', money: 'whole' },
    { key: 'ar', label: 'AR', width: 64, align: 'right', money: 'whole' },
    { key: 'report', label: 'Report', width: 118, align: 'right' },
  ], body.length ? body : [{ label: '(no locations)', _muted: true }], step, { title: 'Locations' });
  drawFooter(doc, `DryOps WIP · ${title.replace(/^WIP — /, '')}`);
  return finish(doc);
}

module.exports = { renderLocationPdf, renderManagerPdf, pickStep, tableHeight, STEPS, PAGE };
