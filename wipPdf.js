// WIP PDF exports (pdfkit). Pure: takes already-loaded data, returns a Buffer.
//
// Both documents are designed to be ONE page. Content is measured first and
// the type size steps down (10 → 9 → 8 → 7.5 pt) until it fits; only when it
// still overflows at the smallest step does the table continue on a second
// page with a "continued" header. Notes are truncated to one line.
const PDFDocument = require('pdfkit');

const PAGE = { w: 612, h: 792, m: 36 };          // LETTER portrait, 0.5" margins
const STEPS = [{ font: 10, row: 16 }, { font: 9, row: 14 }, { font: 8, row: 12 }, { font: 7.5, row: 11 }];
const INK = '#1c2321', MUTED = '#5f6b66', LINE = '#dde3dd', ZEBRA = '#f3f5f2', ACC = '#1b6e5a';

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
    doc.font('Helvetica').fontSize(6.5).fillColor(MUTED).text(k.label.toUpperCase(), x + 6, y + 6, { width: w - 12, lineBreak: false });
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
    subtitle: `Week of ${weekLabel(extra.week)} · last week = ${weekLabel(extra.lastWeek)}`,
    meta: `Generated ${generated}${extra.generatedBy ? ' by ' + extra.generatedBy : ''}\n${data.lastUpdate ? 'Owner updated ' + data.lastUpdate.slice(0, 10) + (data.lastBy ? ' by ' + data.lastBy : '') : 'No owner input yet'}`,
    logoPng,
  });
  y = drawKpis(doc, y, [
    { label: 'In Progress', value: whole(lists.ipTotal) },
    { label: 'Collecting', value: whole(lists.cTotal) },
    { label: 'AR', value: whole(data.arTotal) },
    { label: 'Bank balance', value: data.bank ? whole(data.bank.balance) : '—' },
    { label: 'Collected last wk', value: extra.collected != null ? whole(extra.collected) : '—' },
    { label: 'Invoiced last wk', value: extra.invoiced != null ? whole(extra.invoiced) : '—' },
  ]);
  const { step } = pickStep([{ rows: Math.max(1, lists.inProg.length), titled: true }, { rows: Math.max(1, lists.coll.length), titled: true }]);
  const ipRows = lists.inProg.map((r, i) => ({ n: i + 1, name: r.name, status: r.status, started: r.created || '', amount: r.amount, note: r.note || '' }));
  const cRows = lists.coll.map((r, i) => ({ n: i + 1, name: r.name, status: r.status, due: r.due, amount: r.amount, note: r.note || '' }));
  y = drawTable(doc, y, [
    { key: 'n', label: '#', width: 22, align: 'right' },
    { key: 'name', label: 'Job' },
    { key: 'status', label: 'Status', width: 86 },
    { key: 'started', label: 'Started', width: 62 },
    { key: 'amount', label: 'Est. value', width: 70, align: 'right', money: 'whole' },
    { key: 'note', label: 'Note', width: 150 },
  ], ipRows.length ? ipRows : [{ name: '(none)', _muted: true }], step, { title: `In Progress — ${whole(lists.ipTotal)}` });
  y = drawTable(doc, y, [
    { key: 'n', label: '#', width: 22, align: 'right' },
    { key: 'name', label: 'Job' },
    { key: 'status', label: 'Status', width: 86 },
    { key: 'due', label: 'They owe', width: 66, align: 'right', money: 'whole' },
    { key: 'amount', label: 'Expected', width: 66, align: 'right', money: true },
    { key: 'note', label: 'Note', width: 150 },
  ], cRows.length ? cRows : [{ name: '(none)', _muted: true }], step, { title: `Collecting — ${whole(lists.cTotal)}` });
  drawFooter(doc, `DryOps WIP · ${data.label}`);
  return finish(doc);
}

// One manager (or all locations): a single summary table, one row per location.
async function renderManagerPdf({ title, week, lastWeek, generatedBy, rows, totals }) {
  const doc = new PDFDocument({ size: 'LETTER', margin: PAGE.m, bufferPages: true, info: { Title: title } });
  const generated = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  let y = drawHeader(doc, {
    title, subtitle: `Week of ${weekLabel(week)} · last week = ${weekLabel(lastWeek)}`,
    meta: `Generated ${generated}${generatedBy ? ' by ' + generatedBy : ''}\n${rows.length} location${rows.length === 1 ? '' : 's'}`,
  });
  y = drawKpis(doc, y, [
    { label: 'In Progress', value: whole(totals.ip) },
    { label: 'Collecting', value: whole(totals.collecting) },
    { label: 'AR', value: whole(totals.ar) },
    { label: 'Bank balance', value: whole(totals.bank) },
    { label: 'Collected last wk', value: whole(totals.collected) },
    { label: 'Invoiced last wk', value: whole(totals.invoiced) },
  ]);
  const { step } = pickStep([{ rows: rows.length + 1, titled: true }]);
  const body = rows.map(r => ({
    label: r.label, ip: r.ipTotal, col: r.cTotal, ar: r.arTotal, bank: r.bank ? r.bank.balance : null,
    collected: r.collected, invoiced: r.invoiced,
    need: r.ipMissing + r.wcMissing ? `${r.ipMissing + r.wcMissing} of ${r.ipCount}` : (r.ipCount ? 'all set' : '—'),
  }));
  body.push({ label: 'Total', ip: totals.ip, col: totals.collecting, ar: totals.ar, bank: totals.bank, collected: totals.collected, invoiced: totals.invoiced, need: totals.missing ? `${totals.missing} of ${totals.ipCount}` : '', _bold: true });
  drawTable(doc, y, [
    { key: 'label', label: 'Location' },
    { key: 'ip', label: 'In Progress', width: 68, align: 'right', money: 'whole' },
    { key: 'col', label: 'Collecting', width: 64, align: 'right', money: 'whole' },
    { key: 'ar', label: 'AR', width: 64, align: 'right', money: 'whole' },
    { key: 'bank', label: 'Bank', width: 64, align: 'right', money: 'whole' },
    { key: 'collected', label: 'Collected lw', width: 68, align: 'right', money: 'whole' },
    { key: 'invoiced', label: 'Invoiced lw', width: 68, align: 'right', money: 'whole' },
    { key: 'need', label: 'Need a #', width: 56, align: 'right' },
  ], body, step, { title: 'Locations' });
  drawFooter(doc, `DryOps WIP · ${title.replace(/^WIP — /, '')}`);
  return finish(doc);
}

module.exports = { renderLocationPdf, renderManagerPdf, pickStep, tableHeight, STEPS, PAGE };
