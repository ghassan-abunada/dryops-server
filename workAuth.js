'use strict';
// Work authorizations signed in DryOps (owner 2026-11-19).
//
// On Site › Documents › + › Work authorization: the technician opens the
// location's agreement with the job's details filled in, the customer signs on
// the phone, and this module makes the signed PDF and files it on the job in
// DryOps (documents) and in JobNimbus (the job's files).
//
//   GET  /jobs/:id/work-authorization       → { available, agreement, preview_url, signer_name, signer_email, signed[] }
//   GET  /work-authorization/preview/:id.pdf?exp=&sig=   the UNSIGNED agreement as a PDF, for the app's viewer
//                                           (no login: the signed link is the key, like /jnfile)
//   POST /jobs/:id/work-authorization/sign  { signer_name, signer_email?, signature: { width, height, strokes } }
//                                           → { ok, id, name, storage_url, jn_filed, emailed, email_error }
//
// Flow (owner 2026-11-19): the agreement PDF is read in the app, Sign now asks who is signing and their
// email, the signature is drawn full screen in landscape, and the signed copy is emailed to that address.
//
// Tables (dryops repo supabase/add_work_authorizations.sql): work_auth_templates
// (one agreement per location) and work_authorizations (every signed copy, with
// the exact text that was signed). The text is merged HERE, from the server's
// own read of the job, both for showing and for signing, so what the customer
// read is what is filed.
//
// Pure parts (mergeAgreement, cleanSignature, renderWorkAuthPdf) are covered by
// test/workAuth.test.js.

const crypto = require('crypto');
const { uuidRe } = require('./noteReader');

const PREVIEW_TTL_SECS = 2 * 60 * 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const MAX_STROKES = 400;
const MAX_POINTS = 6000;
const MIN_INK = 12; // points: a dot or a stray tap is not a signature

const squash = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/** HMAC for the preview link: "<job id>|<exp>" → 32 hex chars; null without a secret. */
function signPreview(secret, jobId, exp) {
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(`wa-preview|${jobId}|${exp}`).digest('hex').slice(0, 32);
}
function verifyPreview(secret, jobId, exp, sig, nowSecs = Math.floor(Date.now() / 1000)) {
  const e = Number(exp);
  if (!secret || !Number.isFinite(e) || e < nowSecs) return false;
  const want = signPreview(secret, jobId, e);
  const got = String(sig || '');
  return !!want && got.length === want.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got));
}

/** A typed email → trimmed lower-case, '' when left empty, or null when it is not an address. */
function cleanEmail(v) {
  const e = squash(v).toLowerCase();
  if (!e) return '';
  return e.length <= 200 && EMAIL_RE.test(e) ? e : null;
}

/** "Nov 19, 2026" / "Nov 19, 2026 3:42 PM CT" in Central time. */
function centralDate(d, withTime) {
  const opts = { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric' };
  if (withTime) Object.assign(opts, { hour: 'numeric', minute: '2-digit', hour12: true });
  const s = new Intl.DateTimeFormat('en-US', opts).format(d);
  return withTime ? `${s.replace(/,(?=[^,]*$)/, '')} CT` : s;
}

/** The customer's name without the location suffix JobNimbus keeps on it, "Testy McWorkflow (THN)". */
const customerName = (name) => squash(String(name || '').replace(/\s*\([^)]*\)\s*$/, ''));

/**
 * The agreement with its fill-ins replaced. A fill-in with no value leaves no gap and no stray comma:
 * "insurance company {{InsuranceCompany}} to pay" reads "insurance company to pay".
 *   template = work_auth_templates row; ctx = { customerName, propertyAddress, insuranceCompany, date }
 */
function mergeAgreement(template, ctx) {
  const values = {
    CustomerName: squash(ctx.customerName),
    PropertyAddress: squash(ctx.propertyAddress),
    InsuranceCompany: squash(ctx.insuranceCompany),
    CompanyName: squash(template.company_name),
    CompanyAddress: squash(template.company_address),
    Date: squash(ctx.date),
  };
  const fill = (text) => squash(String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => (k in values ? values[k] : '')))
    .replace(/\s+([,.;:])/g, '$1').replace(/,(\s*,)+/g, ',');
  const clauses = Array.isArray(template.clauses) ? template.clauses : [];
  return {
    title: squash(template.title) || 'WORK AUTHORIZATION AGREEMENT',
    company: { name: values.CompanyName, address: values.CompanyAddress || null, phone: squash(template.company_phone) || null },
    intro: fill(template.intro),
    clauses: clauses.map((c) => ({ heading: squash(c && c.heading), text: fill(c && c.text) })).filter((c) => c.heading || c.text),
  };
}

/** What is missing before this job's agreement can be signed (the blanks JobNimbus left empty). */
function missingForAgreement(ctx) {
  const out = [];
  if (!squash(ctx.customerName)) out.push('the customer\'s name');
  if (!squash(ctx.propertyAddress)) out.push('the property address');
  return out;
}

/**
 * A drawn signature as sent by the phone → a safe, bounded copy, or an error string.
 *   { width, height, strokes: [[{x, y}, …], …] } in the pad's own points.
 */
function cleanSignature(sig) {
  const w = Number(sig && sig.width);
  const h = Number(sig && sig.height);
  if (!(w > 20 && w < 5000 && h > 20 && h < 5000)) return { error: 'The signature did not come through. Sign again.' };
  const raw = Array.isArray(sig.strokes) ? sig.strokes : [];
  if (raw.length > MAX_STROKES) return { error: 'That signature is too long. Clear it and sign again.' };
  const strokes = [];
  let points = 0;
  for (const s of raw) {
    if (!Array.isArray(s)) continue;
    const pts = [];
    for (const p of s) {
      if (!p || typeof p !== 'object' || typeof p.x !== 'number' || typeof p.y !== 'number') continue;
      const { x, y } = p;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      pts.push({ x: Math.round(Math.min(w, Math.max(0, x)) * 10) / 10, y: Math.round(Math.min(h, Math.max(0, y)) * 10) / 10 });
    }
    if (pts.length) { strokes.push(pts); points += pts.length; }
    if (points > MAX_POINTS) return { error: 'That signature is too long. Clear it and sign again.' };
  }
  if (points < MIN_INK) return { error: 'Sign in the box first.' };
  return { signature: { width: w, height: h, strokes } };
}

/**
 * The signed agreement as a PDF (Letter). `PDFDocument` is pdfkit.
 *   agreement = mergeAgreement(...); signed = { signerName, signature, signedAt: Date, via, collectedBy, recordId }
 *   signed = null renders the UNSIGNED agreement (the preview read before signing): a blank signature line.
 */
function renderWorkAuthPdf(PDFDocument, agreement, signed) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margins: { top: 54, bottom: 60, left: 54, right: 54 }, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const W = doc.page.width - 108;

    // Company block, top right, as on the JobNimbus document.
    doc.font('Times-Roman').fontSize(10).fillColor('#000');
    for (const line of [agreement.company.name, ...(agreement.company.address ? String(agreement.company.address).split(/\n|,\s*(?=[A-Za-z ]+,\s*[A-Z]{2}\b)/) : []), agreement.company.phone].filter(Boolean)) {
      doc.text(String(line).trim(), 54, doc.y, { width: W, align: 'right' });
    }
    doc.moveDown(1.6);
    doc.font('Times-Bold').fontSize(12).text(agreement.title, 54, doc.y, { width: W, align: 'center', underline: true });
    doc.moveDown(0.9);
    doc.font('Times-Roman').fontSize(10).text(agreement.intro, 54, doc.y, { width: W, align: 'left', lineGap: 1 });
    for (const c of agreement.clauses) {
      doc.moveDown(0.7);
      doc.font('Times-Bold').fontSize(10).text(`${c.heading} `, 54, doc.y, { width: W, continued: true, lineGap: 1 });
      doc.font('Times-Roman').text(c.text, { width: W, lineGap: 1 });
    }

    // Signature block, kept together on one page.
    const BLOCK = 175;
    if (doc.y + BLOCK > doc.page.height - doc.page.margins.bottom) doc.addPage();
    doc.moveDown(2.2);
    const boxW = 260;
    const boxH = 64;
    const x0 = 54;
    const y0 = doc.y;
    if (!signed) {
      const y = y0 + boxH + 4;
      doc.moveTo(x0, y).lineTo(x0 + boxW, y).lineWidth(0.6).strokeColor('#666').stroke();
      doc.fillColor('#444').font('Helvetica').fontSize(9).text('Customer signature', x0, y + 5, { width: boxW });
      doc.moveDown(2);
      doc.fillColor('#000').font('Times-Roman').fontSize(10).text('Company Representative: ______________________________', x0, doc.y, { width: W });
      const r0 = doc.bufferedPageRange();
      for (let i = 0; i < r0.count; i += 1) {
        doc.switchToPage(r0.start + i);
        doc.page.margins.bottom = 0;
        doc.font('Helvetica').fontSize(8).fillColor('#777');
        doc.text('Not signed yet', 54, doc.page.height - 40, { width: W - 80, lineBreak: false });
        doc.text(`Page ${i + 1} of ${r0.count}`, 54, doc.page.height - 40, { width: W, align: 'right', lineBreak: false });
      }
      doc.end();
      return;
    }
    const sig = signed.signature;
    const scale = Math.min(boxW / sig.width, boxH / sig.height);
    const ox = x0 + (boxW - sig.width * scale) / 2;
    const oy = y0 + (boxH - sig.height * scale) / 2;
    doc.save().lineWidth(1.3).lineCap('round').lineJoin('round').strokeColor('#111');
    for (const s of sig.strokes) {
      if (s.length === 1) { doc.circle(ox + s[0].x * scale, oy + s[0].y * scale, 0.7).fillColor('#111').fill(); continue; }
      doc.moveTo(ox + s[0].x * scale, oy + s[0].y * scale);
      for (let i = 1; i < s.length; i += 1) doc.lineTo(ox + s[i].x * scale, oy + s[i].y * scale);
      doc.stroke();
    }
    doc.restore();
    const lineY = y0 + boxH + 4;
    doc.moveTo(x0, lineY).lineTo(x0 + boxW, lineY).lineWidth(0.6).strokeColor('#666').stroke();
    doc.fillColor('#000').font('Helvetica').fontSize(9).text(signed.signerName, x0, lineY + 5, { width: boxW });
    doc.fontSize(7.5).fillColor('#444').text(
      `Signed ${centralDate(signed.signedAt, true)} · ${signed.via === 'link' ? 'from a link sent to the customer' : 'on site, on the technician\'s phone'} · DryOps record ${String(signed.recordId || '').slice(0, 8)}`,
      x0, doc.y + 2, { width: W },
    );
    doc.moveDown(2);
    doc.fillColor('#000').font('Times-Roman').fontSize(10).text(`Company Representative: ${signed.collectedBy || '______________________________'}`, x0, doc.y, { width: W });

    // Footer on every page.
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i += 1) {
      doc.switchToPage(range.start + i);
      // Below the bottom margin: without this pdfkit starts a new page for every footer line.
      doc.page.margins.bottom = 0;
      const y = doc.page.height - 40;
      doc.font('Helvetica').fontSize(8).fillColor('#777');
      doc.text(`Signed electronically in DryOps. Record ${signed.recordId || ''}`, 54, y, { width: W - 80, lineBreak: false });
      doc.text(`Page ${i + 1} of ${range.count}`, 54, y, { width: W, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}

const safeFile = (s) => squash(s).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

module.exports = function mountWorkAuth(app, deps) {
  const {
    requireAuth, loadActor, sbGet, sbInsert, sbPatch, jnUploadFile, PDFDocument,
    SUPABASE_URL, SUPABASE_SERVICE_KEY, fetchFn = (...a) => fetch(...a), now = () => new Date(), newId = () => crypto.randomUUID(),
    FILE_LINK_SECRET = '', RESEND_API_KEY = '', EMAIL_FROM = '', jnGetContact = null,
  } = deps;
  const secret = String(FILE_LINK_SECRET || '').trim();
  const enc = encodeURIComponent;
  const log = (...a) => console.log('[work-auth]', ...a);
  const sbHeaders = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` };
  const encPath = (p) => p.split('/').map(enc).join('/');

  // Who may open and collect one: anyone signed in who works at the job's location (admins and owners: any job).
  // Referral partners and executives do not collect signatures.
  async function context(req, res) {
    const id = String(req.params.id || '');
    if (!uuidRe.test(id)) { res.status(400).json({ error: 'Bad job id' }); return null; }
    const actor = await loadActor(req);
    if (!actor) { res.status(403).json({ error: 'Profile not found' }); return null; }
    if (['lead_source', 'executive'].includes(actor.role)) { res.status(403).json({ error: 'Not allowed to collect a work authorization' }); return null; }
    const rows = await sbGet(`jobs?id=eq.${enc(id)}&select=id,jn_id,jn_contact_id,name,client_name,address,insurer,location_id`);
    const job = rows && rows[0];
    if (!job) { res.status(404).json({ error: 'Job not found' }); return null; }
    if (!['admin', 'owner'].includes(actor.role) && !actor.locs.includes(String(job.location_id))) { res.status(403).json({ error: 'Not your location' }); return null; }
    const tRows = job.location_id ? await sbGet(`work_auth_templates?location_id=eq.${enc(String(job.location_id))}&is_active=eq.true&select=*&limit=1`) : null;
    return { actor, job, template: (tRows && tRows[0]) || null, tablesMissing: tRows === null && !!job.location_id };
  }
  const ctxOf = (job) => ({
    customerName: customerName(job.client_name || job.name),
    propertyAddress: job.address,
    insuranceCompany: job.insurer,
    date: centralDate(now(), false),
  });

  app.get('/jobs/:id/work-authorization', requireAuth, async (req, res) => {
    try {
      const c = await context(req, res);
      if (!c) return;
      const signed = (await sbGet(`work_authorizations?job_id=eq.${enc(c.job.id)}&select=id,signer_name,signed_at,signed_via,storage_url,collected_by_name&order=signed_at.desc&limit=5`)) || [];
      if (!c.template) {
        return res.json({ available: false, reason: c.tablesMissing ? 'Work authorizations are not set up yet (supabase/add_work_authorizations.sql).' : 'This location has no work authorization in DryOps yet.', signed });
      }
      const ctx = ctxOf(c.job);
      const exp = Math.floor(now().getTime() / 1000) + PREVIEW_TTL_SECS;
      const sig = signPreview(secret, c.job.id, exp);
      // The customer's email as JobNimbus has it, to prefill "who is signing". Best effort, never blocks.
      let email = '';
      if (jnGetContact && c.job.jn_contact_id) {
        try { email = cleanEmail(((await jnGetContact(c.job.jn_contact_id)) || {}).email) || ''; } catch { email = ''; }
      }
      res.json({
        available: true, agreement: mergeAgreement(c.template, ctx), signer_name: ctx.customerName, signer_email: email,
        preview_url: sig ? `/work-authorization/preview/${c.job.id}.pdf?exp=${exp}&sig=${sig}` : null,
        can_email: !!(RESEND_API_KEY && EMAIL_FROM), missing: missingForAgreement(ctx), signed,
      });
    } catch (err) { res.status(err.status || 502).json({ error: err.message }); }
  });

  // The unsigned agreement as a PDF, for the app's viewer. No login: the signed link is the key.
  app.get('/work-authorization/preview/:file', async (req, res) => {
    try {
      const id = String(req.params.file || '').replace(/\.pdf$/i, '');
      if (!uuidRe.test(id) || !verifyPreview(secret, id, req.query.exp, req.query.sig)) return res.status(403).json({ error: 'Link expired or invalid' });
      const rows = await sbGet(`jobs?id=eq.${enc(id)}&select=id,jn_id,jn_contact_id,name,client_name,address,insurer,location_id`);
      const job = rows && rows[0];
      const tRows = job && job.location_id ? await sbGet(`work_auth_templates?location_id=eq.${enc(String(job.location_id))}&is_active=eq.true&select=*&limit=1`) : null;
      const template = tRows && tRows[0];
      if (!job || !template) return res.status(404).json({ error: 'No work authorization for this job' });
      const pdf = await renderWorkAuthPdf(PDFDocument, mergeAgreement(template, ctxOf(job)), null);
      res.set('Content-Type', 'application/pdf').set('Content-Disposition', 'inline; filename="Work Authorization.pdf"').set('Cache-Control', 'private, no-store').send(pdf);
    } catch (err) { res.status(err.status || 502).json({ error: err.message }); }
  });

  /** The signed copy by email (Resend). Resolves to { ok } or { ok: false, error }; never throws. */
  async function emailSignedCopy(to, agreement, signerName, filename, pdf) {
    if (!RESEND_API_KEY || !EMAIL_FROM) return { ok: false, error: 'Email is not set up on the server' };
    const esc = (v) => String(v).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const html = `<p>Hello ${esc(signerName)},</p><p>Attached is your signed copy of the Work Authorization Agreement with ${esc(agreement.company.name)}.</p>`
      + `<p>Please keep it for your records.${agreement.company.phone ? ` If you have any questions, call us at ${esc(agreement.company.phone)}.` : ''}</p><p>${esc(agreement.company.name)}</p>`;
    try {
      const r = await fetchFn('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: EMAIL_FROM, to: [to], subject: `Your signed Work Authorization - ${agreement.company.name}`, html,
          attachments: [{ filename, content: pdf.toString('base64') }],
        }),
      });
      if (r.ok) return { ok: true };
      const j = await r.json().catch(() => null);
      return { ok: false, error: (j && j.message) || `Email service answered ${r.status}` };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  app.post('/jobs/:id/work-authorization/sign', requireAuth, async (req, res) => {
    try {
      const c = await context(req, res);
      if (!c) return;
      if (!c.template) return res.status(409).json({ error: 'This location has no work authorization in DryOps yet.' });
      const signerName = squash(req.body && req.body.signer_name).slice(0, 120);
      if (signerName.length < 2) return res.status(400).json({ error: 'Type the name of the person signing.' });
      const signerEmail = cleanEmail(req.body && req.body.signer_email);
      if (signerEmail === null) return res.status(400).json({ error: 'That email address does not look right. Fix it, or leave it empty.' });
      const cleaned = cleanSignature(req.body && req.body.signature);
      if (cleaned.error) return res.status(400).json({ error: cleaned.error });
      const ctx = ctxOf(c.job);
      const missing = missingForAgreement(ctx);
      if (missing.length) return res.status(409).json({ error: `Add ${missing.join(' and ')} to the job first (Job Details), so the agreement is complete.` });

      const agreement = mergeAgreement(c.template, ctx);
      const signedAt = now();
      const id = newId();
      const pdf = await renderWorkAuthPdf(PDFDocument, agreement, {
        signerName, signature: cleaned.signature, signedAt, via: 'phone', collectedBy: c.actor.name, recordId: id,
      });
      const filename = `Work Authorization - ${safeFile(ctx.customerName)} - signed ${signedAt.toISOString().slice(0, 10)}.pdf`;

      // DryOps storage first: the signed copy must exist before anything says "signed".
      const path = `${c.job.id}/${signedAt.getTime()}-${filename}`;
      const up = await fetchFn(`${SUPABASE_URL}/storage/v1/object/documents/${encPath(path)}`, { method: 'POST', headers: { ...sbHeaders, 'Content-Type': 'application/pdf', 'x-upsert': 'false' }, body: pdf });
      if (!up.ok) throw Object.assign(new Error(`The signed copy could not be stored (${up.status}). Nothing was filed; try again.`), { status: 502 });
      const storageUrl = `${SUPABASE_URL}/storage/v1/object/public/documents/${encPath(path)}`;

      // JobNimbus: best effort. A failure is reported, never undoes the signing.
      let jnFileId = null;
      if (c.job.jn_id && jnUploadFile) {
        try { jnFileId = await jnUploadFile(c.job.jn_id, filename, pdf, `Work Authorization signed in DryOps by ${signerName} · collected by ${c.actor.name}`); }
        catch (e) { console.warn('[work-auth] JobNimbus upload failed', c.job.id, e.message); }
      }

      let documentId = null;
      try {
        const made = await sbInsert('documents', { job_id: c.job.id, name: filename, storage_url: storageUrl, jn_file_id: jnFileId, type: 'work_authorization', size: pdf.length });
        documentId = (made && made.id) || null;
      } catch (e) { console.warn('[work-auth] documents insert failed', c.job.id, e.message); }

      // The signed copy to the signer's email, when one was given. Reported, never fatal.
      const mail = signerEmail ? await emailSignedCopy(signerEmail, agreement, signerName, filename, pdf) : null;

      const record = {
        id, job_id: c.job.id, template_id: c.template.id, template_version: c.template.version || 1, body: agreement,
        signer_name: signerName, signature: cleaned.signature, signed_at: signedAt.toISOString(), signed_via: 'phone',
        collected_by: c.actor.id, collected_by_name: c.actor.name, storage_url: storageUrl, document_id: documentId, jn_file_id: jnFileId ? String(jnFileId) : null,
      };
      // signer_email / emailed_at arrive with supabase/add_work_auth_email.sql; before it is run the record is kept without them.
      try {
        await sbInsert('work_authorizations', { ...record, signer_email: signerEmail || null, emailed_at: mail && mail.ok ? now().toISOString() : null });
      } catch (e) {
        console.warn('[work-auth] record without the email columns:', e.message);
        await sbInsert('work_authorizations', record);
      }
      log(c.job.id, `signed by ${signerName}, collected by ${c.actor.name}, ${pdf.length}B`, jnFileId ? `jn:${jnFileId}` : 'not in JobNimbus');
      res.json({ ok: true, id, name: filename, storage_url: storageUrl, jn_filed: !!jnFileId, in_jobnimbus: !!c.job.jn_id, emailed_to: mail && mail.ok ? signerEmail : null, email_error: mail && !mail.ok ? mail.error : null });
    } catch (err) { res.status(err.status || 502).json({ error: err.message }); }
  });

  // sbPatch is accepted for the link flow that follows; unused here.
  void sbPatch;
};

module.exports.mergeAgreement = mergeAgreement;
module.exports.missingForAgreement = missingForAgreement;
module.exports.cleanSignature = cleanSignature;
module.exports.renderWorkAuthPdf = renderWorkAuthPdf;
module.exports.centralDate = centralDate;
module.exports.customerName = customerName;
module.exports.signPreview = signPreview;
module.exports.verifyPreview = verifyPreview;
module.exports.cleanEmail = cleanEmail;
