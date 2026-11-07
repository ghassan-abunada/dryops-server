// A location's commission statement (pdfkit). Pure: takes the frozen statement the
// app saved (lib/commissions/statement.ts) and an optional PNG logo, returns a
// Buffer. It goes to that location's owners: the bonus breakdown per job and what
// they owe the paying location, nothing about performance or other locations.
const PDFDocument = require('pdfkit');

const PAGE = { w: 792, h: 612, m: 36 }; // LETTER landscape, 0.5" margins
const INK = '#0F172A', MUTED = '#475569', LINE = '#E2E8F0', ZEBRA = '#F1F5F9', ACC = '#0369A1';
const ROW = 22, ROW_NOTE = 33, HEAD = 18;

function money(v) {
  const n = Number(v || 0), abs = Math.abs(n);
  const text = Number.isInteger(abs) ? abs.toLocaleString('en-US') : abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '-' : ''}$${text}`;
}
function dash(v) { return v ? money(v) : '-'; }
function usDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return `${m}/${d}/${String(y).slice(2)}`;
}
function truncate(doc, text, width) {
  let t = String(text == null ? '' : text);
  if (doc.widthOfString(t) <= width) return t;
  while (t.length && doc.widthOfString(t + '...') > width) t = t.slice(0, -1);
  return t + '...';
}

const COLS = [
  { key: 'job', label: 'JOB', w: 180 },
  { key: 'type', label: 'TYPE', w: 70 },
  { key: 'after', label: 'AFTER-HOURS CALL', w: 100 },
  { key: 'base', label: 'BASE', w: 40, right: true },
  { key: 'resp', label: 'RESPONSE', w: 52, right: true },
  { key: 'ahl', label: 'AH LANDED', w: 56, right: true },
  { key: 'po', label: 'PACK-OUT', w: 50, right: true },
  { key: 'large', label: 'LARGE', w: 40, right: true },
  { key: 'total', label: 'TOTAL', w: 48, right: true },
  { key: 'status', label: 'STATUS', w: 84, right: true },
];

// "#64257 Starmye Goforth (OSR - DAL - MIT)" -> "#64257 Starmye Goforth". The suffix
// repeats the location the page is already about, and it pushed names off the column.
function jobName(label) {
  return String(label == null ? '' : label).replace(/\s*\([^()]*\)\s*$/, '');
}

function cells(row) {
  const a = row.amounts || {};
  return {
    job: jobName(row.job_label),
    type: row.job_type,
    after: row.after_hours_at || '-',
    base: dash((a.insurance_landed || 0) + (a.oop_landed || 0) + (a.manual || 0)),
    resp: dash(a.after_hours_response),
    ahl: dash(a.after_hours_landed),
    po: dash(a.packout),
    large: dash(a.large_job),
    total: money(row.total),
    status: row.paid_on ? `Paid ${usDate(row.paid_on)}` : 'Not paid yet',
  };
}

function rowNote(row, late) {
  const parts = [];
  if (late) parts.push(`Earned ${row.earned_label}`);
  for (const n of row.notes || []) parts.push(n);
  return parts.join(' · ');
}

function buildCommissionStatementPdf(statement, logoPng) {
  return new Promise((resolve, reject) => {
    const st = statement;
    const doc = new PDFDocument({
      size: 'LETTER', layout: 'landscape', margin: PAGE.m, bufferPages: true,
      info: { Title: `Commission statement: ${st.location_name}, ${st.payout_label}` },
    });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const x0 = PAGE.m, width = PAGE.w - PAGE.m * 2, bottom = PAGE.h - PAGE.m - 18;
    let y = PAGE.m;

    // Header: the location is the subject, so its logo or full name leads.
    let textX = x0;
    if (logoPng) {
      try {
        doc.image(logoPng, x0, y, { fit: [120, 44], valign: 'center' });
        textX = x0 + 132;
      } catch (e) { textX = x0; }
    }
    doc.font('Helvetica-Bold').fontSize(17).fillColor(INK).text(st.location_name, textX, y + 1, { width: 400, lineBreak: false });
    doc.font('Helvetica').fontSize(11).fillColor(MUTED)
      .text(`Commission statement · ${st.rep_name}`, textX, y + 24, { width: 400, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK)
      .text(st.payout_label, x0 + width - 260, y + 3, { width: 260, align: 'right', lineBreak: false });
    doc.font('Helvetica').fontSize(10).fillColor(MUTED)
      .text(`For ${st.earned_label} jobs`, x0 + width - 260, y + 19, { width: 260, align: 'right', lineBreak: false })
      .text(`Prepared ${usDate(st.generated_on)}`, x0 + width - 260, y + 33, { width: 260, align: 'right', lineBreak: false });
    y += 56;

    // What the reader has to do with it.
    doc.rect(x0, y, width, 46).fillColor(ZEBRA).fill();
    const ask = st.is_pay_location
      ? 'Paid directly by this location. No transfer needed.'
      : `Reimburse ${st.pay_location_name || 'the paying location'}`;
    doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text(ask, x0 + 12, y + 16, { width: width - 180, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(20).fillColor(INK).text(money(st.total), x0 + width - 172, y + 12, { width: 160, align: 'right', lineBreak: false });
    y += 60;

    function header(title) {
      doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text(title, x0, y, { width, lineBreak: false });
      y += 18;
      doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED);
      let x = x0;
      for (const c of COLS) {
        doc.text(c.label, x + 3, y + 5, { width: c.w - 6, align: c.right ? 'right' : 'left', lineBreak: false });
        x += c.w;
      }
      y += HEAD;
      doc.moveTo(x0, y).lineTo(x0 + width, y).lineWidth(0.6).strokeColor(LINE).stroke();
    }

    function table(title, rows, late) {
      if (y + 18 + HEAD + ROW > bottom) { doc.addPage(); y = PAGE.m; }
      header(title);
      for (const row of rows) {
        const note = rowNote(row, late);
        const h = note ? ROW_NOTE : ROW;
        if (y + h > bottom) { doc.addPage(); y = PAGE.m; header(`${title} (continued)`); }
        const c = cells(row);
        let x = x0;
        for (const col of COLS) {
          doc.font(col.key === 'total' || col.key === 'job' ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).fillColor(INK);
          const t = truncate(doc, c[col.key], col.w - 6);
          doc.text(t, x + 3, y + 7, { width: col.w - 6, align: col.right ? 'right' : 'left', lineBreak: false });
          x += col.w;
        }
        if (note) {
          doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
          doc.text(truncate(doc, note, width - 6), x0 + 3, y + 20, { width: width - 6, lineBreak: false });
        }
        y += h;
        doc.moveTo(x0, y).lineTo(x0 + width, y).lineWidth(0.4).strokeColor(LINE).stroke();
      }
      y += 16;
    }

    if (st.rows && st.rows.length) table(`${st.earned_label} jobs`, st.rows, false);
    if (st.late_rows && st.late_rows.length) table('Added to this payout from other months', st.late_rows, true);

    // Totals and how the bonuses work.
    if (y + 74 > bottom) { doc.addPage(); y = PAGE.m; }
    const tx = x0 + width - 230;
    const totalRow = (label, value, bold) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10).fillColor(bold ? INK : MUTED);
      doc.text(label, tx, y, { width: 140, lineBreak: false });
      doc.text(value, tx + 140, y, { width: 90, align: 'right', lineBreak: false });
      y += bold ? 18 : 15;
    };
    const topOfTotals = y;
    if (st.paid) totalRow('Already paid', money(st.paid));
    if (st.owed) totalRow('Not paid yet', money(st.owed));
    totalRow('Total', money(st.total), true);

    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(
      'Base: $100 insurance job landed, $25 out-of-pocket job landed. After hours: $25 response, plus $25 when landed. '
      + 'Pack-out sold: $25. Large job, once paid and closed: $25 per full $5,000 collected above $20,000 insurance or $10,000 out-of-pocket.',
      x0, topOfTotals, { width: width - 260, lineGap: 2 },
    );

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.font('Helvetica').fontSize(8).fillColor(MUTED)
        .text(`Page ${i + 1} of ${range.count}`, x0, PAGE.h - PAGE.m - 8, { width, align: 'right', lineBreak: false, height: 10 });
    }
    doc.end();
  });
}

module.exports = { buildCommissionStatementPdf, money, jobName };
