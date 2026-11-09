'use strict';
// ── Job PDFs: drying log, mitigation report, estimate, invoice ───────────────
// The job page's "PDF" actions (app lib/jobPdf.ts). Renders with pdfkit from
// what Supabase already holds — scope_sheets (reviewed sheet + DryingLog v1),
// rooms / materials / equipment, photos, estimate_docs + estimate_versions +
// estimate_approvals — and can save the file to the `documents` bucket (+ a
// documents row), upload it to the job's JobNimbus files and post a note.
//
//   GET  /jobs/:id/pdf/:kind   kind ∈ drying-log | mitigation-report | estimate | invoice
//        ?doc_id= (estimate / invoice) &revision= (frozen estimate_versions
//        revision; default live) &version= (scope_sheets version; default
//        latest) &photos=none|supabase (default supabase) &disposition=
//        inline|attachment — with a Bearer token, OR with ?sig=&exp= (the
//        signed link a POST returns, 1h) so a browser tab can open it.
//        Streams application/pdf.
//   POST /jobs/:id/pdf/:kind   { doc_id?, revision?, version?, drying_log?,
//        save?, jn?, note?, filename? } → { ok, kind, filename, bytes, pages,
//        document: { id, storage_url, type } | null, jn_file_id, jn_note_id,
//        pdf_url }. `drying_log` (DryingLog v1) is accepted when the job has
//        no scope_sheets snapshot; with no snapshot and no body → 409
//        { needs_drying_log: true }. A mitigation report without a snapshot
//        renders without the sheet section.
//
// Auth: requireAuth + intake.loadActor + the location scope rule (admin /
// owner / executive see every job; everyone else their locations). Any role
// in scope may read; save / jn / note need admin | owner | expansion_manager.
// Errors: 400 bad kind / body, 403 scope, 404 job / doc, 409 (above, and a
// pricing mismatch: the recomputed estimate total must equal
// estimate_docs.grand_total ±0.01 — the server never prints a number the app
// did not show), 502 JobNimbus / storage.
//
// The signed link reuses jobFiles.js's HMAC signer over a hash of the render
// parameters (and the render id the POST cached for an hour, so a body-supplied
// drying log can be opened too). Pure pieces (renderKey, filenames, canSave,
// parseParams) and the route flow are covered by test/jobPdf.test.js with
// fake deps.

const crypto = require('crypto');
const { uuidRe } = require('./noteReader');
const { signFileLink, verifyFileLink, contentDisposition, LINK_TTL_SECS } = require('./jobFiles');
const K = require('./pdfKit');
const { dryingLogModel, renderDryingLogPdf, validateDryingLog, summaryLine } = require('./dryingLogPdf');
const { renderMitigationReportPdf } = require('./mitigationReportPdf');
const { renderEstimatePdf } = require('./estimatePdf');
const P = require('./estimatePricing');

const KINDS = ['drying-log', 'mitigation-report', 'estimate', 'invoice'];
const DOC_TYPE = { 'drying-log': 'drying_log', 'mitigation-report': 'mitigation_report', estimate: 'estimate', invoice: 'invoice' };
const TITLE = { 'drying-log': 'Drying Log', 'mitigation-report': 'Mitigation Report', estimate: 'Estimate', invoice: 'Invoice' };
const SAVE_ROLES = new Set(['admin', 'owner', 'expansion_manager']);
const PHOTO_CAP = 60;
const PHOTO_PX = 1200;
const CACHE_MAX_ENTRIES = 40;
const CACHE_MAX_BYTES = 250 * 1024 * 1024;
/** Bodies with a drying log can run past the global 2 MB limit; server.js mounts this before it. */
const JSON_LIMIT_PATH = /^\/jobs\/[^/]+\/pdf\//;
const JSON_LIMIT = '10mb';

const seesAll = (actor) => ['admin', 'owner', 'executive'].includes(actor.role);
const canSave = (actor) => !!actor && SAVE_ROLES.has(actor.role);

/** Normalised render parameters from a query or a body. */
function parseParams(src) {
  const s = src || {};
  const str = (v) => (v === undefined || v === null || v === '' ? null : String(v));
  const int = (v) => { const n = Number(v); return v === undefined || v === null || v === '' || !Number.isInteger(n) || n < 0 ? null : n; };
  return {
    doc_id: str(s.doc_id), revision: int(s.revision), version: int(s.version),
    photos: str(s.photos) === 'none' ? 'none' : 'supabase',
    rid: str(s.rid),
  };
}

/** The string the signed link covers: job, kind and every render parameter (+ the cached render id). */
function renderKey(jobId, kind, p) {
  const canonical = ['pdf', jobId, kind, p.doc_id || '', p.revision == null ? '' : p.revision, p.version == null ? '' : p.version, p.photos || 'supabase', p.rid || ''].join('|');
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 48);
}

const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
/** "First Last" for filenames: JobNimbus's "Last, First" flipped, else the job name. */
function clientLabel(job) {
  return safeName(P.clientForPrint(job.client_name) || P.clientForPrint(job.name) || job.number || job.jn_id || 'Job');
}
function filenameFor(kind, job, { date, number } = {}) {
  const client = clientLabel(job);
  switch (kind) {
    case 'drying-log': return `Drying Log - ${client} - ${date}.pdf`;
    case 'mitigation-report': return `Mitigation Report - ${client} - ${date}.pdf`;
    case 'estimate': return `Estimate E-${number} - ${client}.pdf`;
    case 'invoice': return `Invoice INV-${number} - ${client}.pdf`;
    default: return `${client}.pdf`;
  }
}
const todayCentral = (now) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(now);

module.exports = function mountJobPdf(app, deps) {
  const {
    requireAuth, loadActor, sbGet, sbInsert, jnUploadFile, jnAddNote, locationLogoUrl, logoPngFromUrl,
    SUPABASE_URL, SUPABASE_SERVICE_KEY, FILE_LINK_SECRET, fetchFn = (...a) => fetch(...a), sharp = null, now = () => new Date(),
  } = deps;
  const enc = encodeURIComponent;
  const secret = String(FILE_LINK_SECRET || '').trim();
  const log = (...a) => console.log('[job-pdf]', ...a);
  const warn = (...a) => console.warn('[job-pdf]', ...a);
  if (!secret) warn('FILE_LINK_SECRET / JN_WEBHOOK_TOKEN unset — pdf_url links will not be signed');

  // ── Render cache (rid → bytes) so the signed link opens what the POST made ──
  const cache = new Map();
  let cacheBytes = 0;
  function cachePut(buf, filename) {
    const nowS = Math.floor(now().getTime() / 1000);
    for (const [k, v] of cache) if (v.exp < nowS) { cacheBytes -= v.buf.length; cache.delete(k); }
    while (cache.size >= CACHE_MAX_ENTRIES || (cacheBytes + buf.length > CACHE_MAX_BYTES && cache.size)) {
      const k = cache.keys().next().value; cacheBytes -= cache.get(k).buf.length; cache.delete(k);
    }
    const rid = crypto.randomBytes(12).toString('hex');
    cache.set(rid, { buf, filename, exp: nowS + LINK_TTL_SECS });
    cacheBytes += buf.length;
    return rid;
  }
  function cacheGet(rid) {
    const v = rid ? cache.get(rid) : null;
    if (!v) return null;
    if (v.exp < Math.floor(now().getTime() / 1000)) { cache.delete(rid); cacheBytes -= v.buf.length; return null; }
    return v;
  }
  function signedUrl(jobId, kind, p, rid) {
    if (!secret) return null;
    const exp = Math.floor(now().getTime() / 1000) + LINK_TTL_SECS;
    const q = { rid, sig: signFileLink(secret, renderKey(jobId, kind, { ...p, rid }), exp), exp: String(exp), photos: p.photos };
    if (p.doc_id) q.doc_id = p.doc_id;
    if (p.revision != null) q.revision = String(p.revision);
    if (p.version != null) q.version = String(p.version);
    return `/jobs/${enc(jobId)}/pdf/${kind}?${Object.entries(q).map(([k, v]) => `${k}=${enc(v)}`).join('&')}`;
  }

  // ── Loaders ───────────────────────────────────────────────────────────────
  const first = (rows) => (Array.isArray(rows) && rows[0]) || null;
  async function loadJob(id) {
    return first(await sbGet(`jobs?id=eq.${enc(id)}&select=id,jn_id,name,number,client_name,client_phone,address,claim_number,insurer,adjuster_name,adjuster_phone,adjuster_email,cat,date_loss,date_start,date_end,location_id,jn_location_id,record_type,status`));
  }
  async function loadLocation(locationId) {
    if (!locationId) return null;
    // office_address arrived later (add_location_office.sql); fall back when a column is missing.
    return first(await sbGet(`locations?id=eq.${enc(String(locationId))}&select=id,name,logo_url,office_address`))
      || first(await sbGet(`locations?id=eq.${enc(String(locationId))}&select=id,name,logo_url`));
  }
  async function loadSnapshot(jobId, version) {
    const v = version == null ? '' : `&version=eq.${enc(version)}`;
    return first(await sbGet(`scope_sheets?job_id=eq.${enc(jobId)}${v}&order=version.desc&limit=1&select=id,version,status,sheet,drying_log,catalog_version,created_at`));
  }
  async function loadScopeRows(jobId) {
    const rooms = (await sbGet(`rooms?job_id=eq.${enc(jobId)}&select=*&order=sort_order.asc.nullslast,created_at.asc`)) || [];
    if (!rooms.length) return { rooms, materials: [], equipment: [] };
    const ids = rooms.map((r) => enc(r.id)).join(',');
    const [materials, equipment] = await Promise.all([
      sbGet(`materials?room_id=in.(${ids})&select=*&order=created_at.asc`),
      sbGet(`equipment?room_id=in.(${ids})&select=*&order=placed_on.asc.nullsfirst,created_at.asc`),
    ]);
    return { rooms, materials: materials || [], equipment: equipment || [] };
  }
  async function loadLogo(location) {
    if (!location || !locationLogoUrl || !logoPngFromUrl) return null;
    try { const url = await locationLogoUrl(location); return url ? await logoPngFromUrl(url) : null; }
    catch (e) { warn('logo unavailable:', e.message); return null; }
  }
  /** Supabase photos → resized JPEG buffers (oldest first, newest last, capped). */
  async function loadPhotos(jobId) {
    const rows = (await sbGet(`photos?job_id=eq.${enc(jobId)}&select=id,storage_url,caption,taken_at&order=taken_at.asc&limit=${PHOTO_CAP}`)) || [];
    const out = new Array(rows.length).fill(null);
    let next = 0, failed = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (;;) {
        const i = next++;
        if (i >= rows.length) break;
        const p = rows[i];
        try {
          const r = await fetchFn(p.storage_url);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          let buf = Buffer.from(await r.arrayBuffer());
          if (sharp) buf = await sharp(buf).rotate().resize({ width: PHOTO_PX, height: PHOTO_PX, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 78, mozjpeg: true }).toBuffer();
          out[i] = { buf, caption: p.caption || null };
        } catch (e) { failed++; if (failed <= 3) warn('photo skipped', p.id, e.message); }
      }
    }));
    return out.filter(Boolean);
  }

  // ── Storage + documents row ───────────────────────────────────────────────
  const sbHeaders = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` };
  const encPath = (p) => p.split('/').map(enc).join('/');
  async function uploadToStorage(jobId, filename, buf) {
    const path = `${jobId}/${now().getTime()}-${filename}`;
    const put = () => fetchFn(`${SUPABASE_URL}/storage/v1/object/documents/${encPath(path)}`, { method: 'POST', headers: { ...sbHeaders, 'Content-Type': 'application/pdf', 'x-upsert': 'false' }, body: buf });
    let r = await put();
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      if (/bucket not found/i.test(text) || r.status === 404) {
        // The app creates the bucket lazily too (lib/reportGenerator.ts).
        await fetchFn(`${SUPABASE_URL}/storage/v1/bucket`, { method: 'POST', headers: { ...sbHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'documents', name: 'documents', public: true }) }).catch(() => null);
        r = await put();
        if (!r.ok) throw Object.assign(new Error(`storage upload ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`), { status: 502 });
      } else {
        throw Object.assign(new Error(`storage upload ${r.status} ${text.slice(0, 200)}`), { status: 502 });
      }
    }
    return { path, storage_url: `${SUPABASE_URL}/storage/v1/object/public/documents/${encPath(path)}` };
  }
  async function saveDocument(job, kind, filename, buf, jnFileId) {
    const { storage_url } = await uploadToStorage(job.id, filename, buf);
    const row = { job_id: job.id, name: filename, storage_url, jn_file_id: jnFileId || null, type: DOC_TYPE[kind], size: buf.length };
    let made = null;
    try { made = await sbInsert('documents', row); } catch (e) { throw Object.assign(new Error(`documents insert: ${e.message}`), { status: 502 }); }
    if (!made || !made.id) {
      // sbInsert may answer with an empty body (see scopeWriter.insertAndFind): re-select the row.
      made = first(await sbGet(`documents?job_id=eq.${enc(job.id)}&storage_url=eq.${enc(storage_url)}&select=id,storage_url,type,name,size,created_at&order=created_at.desc&limit=1`)) || { ...row, id: null };
    }
    return { id: made.id || null, storage_url: made.storage_url || storage_url, type: made.type || row.type, name: made.name || filename };
  }

  // ── Per-kind render ───────────────────────────────────────────────────────
  class HttpError extends Error { constructor(status, body) { super(typeof body === 'string' ? body : body.error || 'error'); this.status = status; this.body = typeof body === 'string' ? { error: body } : body; } }

  async function renderDryingLog({ job, location, logoPng, p, body }) {
    const snap = await loadSnapshot(job.id, p.version);
    let logData = snap ? snap.drying_log : null;
    if (!logData) {
      if (!body || !body.drying_log) throw new HttpError(409, { error: 'This job has no scope sheet snapshot yet — generate one on the Scope tab, or send the drying log in the request body.', needs_drying_log: true });
      const err = validateDryingLog(body.drying_log);
      if (err) throw new HttpError(400, { error: `Bad drying_log: ${err}` });
      logData = body.drying_log;
    }
    const model = dryingLogModel(logData);
    const buf = await renderDryingLogPdf({ model, job, location, logoPng });
    const date = model.summary.last_date || todayCentral(now());
    return { buf, filename: filenameFor('drying-log', job, { date }), note: `Drying log attached: ${summaryLine(model)}.`, meta: { snapshot_version: snap ? snap.version : null } };
  }

  async function renderMitigation({ job, location, logoPng, p, body }) {
    const snap = await loadSnapshot(job.id, p.version);
    let logData = snap ? snap.drying_log : null;
    if (!logData && body && body.drying_log) {
      const err = validateDryingLog(body.drying_log);
      if (err) throw new HttpError(400, { error: `Bad drying_log: ${err}` });
      logData = body.drying_log;
    }
    const [{ rooms, materials, equipment }, photos] = await Promise.all([loadScopeRows(job.id), p.photos === 'none' ? [] : loadPhotos(job.id)]);
    const buf = await renderMitigationReportPdf({
      job, location, logoPng, sheet: snap ? snap.sheet : null, dryingModel: logData ? dryingLogModel(logData) : null,
      rooms, materials, equipment, photos, now: now(),
    });
    const date = todayCentral(now());
    return { buf, filename: filenameFor('mitigation-report', job, { date }), note: `Mitigation report attached${photos.length ? ` (${photos.length} photos)` : ''}.`, meta: { snapshot_version: snap ? snap.version : null, photos: photos.length } };
  }

  async function renderEstimate({ job, location, logoPng, p, kind }) {
    if (!p.doc_id || !uuidRe.test(p.doc_id)) throw new HttpError(400, { error: 'doc_id is required' });
    const doc = first(await sbGet(`estimate_docs?id=eq.${enc(p.doc_id)}&select=id,job_id,kind,number,title,status,prices,tax,overhead_pct,profit_pct,cover,body,totals,grand_total,amount_paid,revision,sent_at,approved_at,created_by_name,created_at`));
    if (!doc || String(doc.job_id) !== String(job.id)) throw new HttpError(404, { error: 'Estimate not found on this job' });
    if (doc.kind !== kind) throw new HttpError(404, { error: `That document is ${doc.kind === 'invoice' ? 'an invoice' : 'an estimate'}, not ${kind === 'invoice' ? 'an invoice' : 'an estimate'}` });
    let body = doc.body, prices = doc.prices || {}, storedTotal = Number(doc.grand_total), revision = doc.revision;
    if (p.revision != null) {
      const ver = first(await sbGet(`estimate_versions?doc_id=eq.${enc(doc.id)}&revision=eq.${enc(p.revision)}&select=revision,body,prices,totals,frozen_at`));
      if (!ver) throw new HttpError(404, { error: `Revision ${p.revision} was never frozen` });
      body = ver.body; prices = ver.prices || {}; revision = ver.revision;
      if (ver.totals && ver.totals.total != null) storedTotal = Number(ver.totals.total);
    }
    if (!body || body.v !== 1) throw new HttpError(409, { error: 'Estimate body is not a v1 document' });
    const money = P.moneyFacts(doc);
    const totals = P.docTotals(body, prices, money);
    if (!Number.isFinite(storedTotal) || Math.abs(totals.total - storedTotal) > 0.01) {
      throw new HttpError(409, { error: 'pricing mismatch', server_total: totals.total, stored_total: Number.isFinite(storedTotal) ? storedTotal : null });
    }
    const approval = first(await sbGet(`estimate_approvals?doc_id=eq.${enc(doc.id)}&select=signer_name,signed_at,revision&order=signed_at.desc&limit=1`));
    const cover0 = doc.cover || {};
    const client = P.clientForPrint(job.client_name || job.name);
    const cover = {
      title: doc.title || P.estimateName(client || `E_${doc.number}`),
      client, property: job.address || null, claim: job.claim_number || null, insurer: job.insurer || null,
      estimator: cover0.estimator || doc.created_by_name || null, typeOfEstimate: cover0.type_of_estimate || null,
      dateEntered: K.fmtDate(doc.created_at), priceList: cover0.price_list || null,
      company: location ? location.name : null, companyAddress: location ? location.office_address : null,
    };
    const buf = await renderEstimatePdf({ body, prices, money, cover, kind, number: doc.number, logoPng, amountPaid: doc.amount_paid, approval: kind === 'invoice' || doc.status === 'approved' ? approval : null, status: doc.status, revision });
    const label = kind === 'invoice' ? `Invoice INV-${doc.number}` : `Estimate E-${doc.number}`;
    return { buf, filename: filenameFor(kind, job, { number: doc.number }), note: `${label} attached · total $${P.money(totals.total)}${kind === 'invoice' ? ` · balance due $${P.money(P.c2(totals.total - (Number(doc.amount_paid) || 0)))}` : ''}.`, meta: { doc_id: doc.id, revision, total: totals.total } };
  }

  async function render(kind, ctx) {
    if (kind === 'drying-log') return renderDryingLog(ctx);
    if (kind === 'mitigation-report') return renderMitigation(ctx);
    return renderEstimate({ ...ctx, kind });
  }

  // ── Shared request context ────────────────────────────────────────────────
  async function context(req, res, { signed }) {
    const id = String(req.params.id || '');
    const kind = String(req.params.kind || '');
    if (!uuidRe.test(id)) { res.status(400).json({ error: 'Bad job id' }); return null; }
    if (!KINDS.includes(kind)) { res.status(400).json({ error: `Unknown kind "${kind}" — one of ${KINDS.join(', ')}` }); return null; }
    let actor = null;
    if (!signed) {
      actor = await loadActor(req);
      if (!actor) { res.status(403).json({ error: 'Profile not found' }); return null; }
    }
    const job = await loadJob(id);
    if (!job) { res.status(404).json({ error: 'Job not found' }); return null; }
    if (actor && !seesAll(actor) && !actor.locs.includes(String(job.location_id))) { res.status(403).json({ error: 'Not your location' }); return null; }
    const location = await loadLocation(job.location_id);
    return { actor, job, kind, location };
  }
  const sendError = (res, err) => {
    if (err instanceof HttpError) return res.status(err.status).json(err.body);
    console.error('[job-pdf] error', err.message);
    return res.status(err.status || 502).json({ error: err.message });
  };

  // GET with ?sig= skips the bearer check; the signature covers every render parameter.
  const maybeAuth = (req, res, next) => {
    if (req.query && req.query.sig) {
      const p = parseParams(req.query);
      if (!verifyFileLink(secret, renderKey(String(req.params.id || ''), String(req.params.kind || ''), p), req.query.exp, req.query.sig, Math.floor(now().getTime() / 1000))) {
        return res.status(403).json({ error: 'Link expired or invalid' });
      }
      req.pdfSigned = true;
      return next();
    }
    return requireAuth(req, res, next);
  };

  app.get('/jobs/:id/pdf/:kind', maybeAuth, async (req, res) => {
    try {
      const p = parseParams(req.query);
      const attachment = String(req.query.disposition || 'inline') === 'attachment';
      const cached = req.pdfSigned ? cacheGet(p.rid) : null;
      if (cached) {
        return res.set('Content-Type', 'application/pdf').set('Content-Disposition', contentDisposition(cached.filename, attachment)).set('Cache-Control', 'private, no-store').send(cached.buf);
      }
      const ctx = await context(req, res, { signed: !!req.pdfSigned });
      if (!ctx) return;
      const logoPng = await loadLogo(ctx.location);
      const out = await render(ctx.kind, { ...ctx, logoPng, p, body: null });
      log(ctx.kind, ctx.job.id, `${out.buf.length}B`, req.pdfSigned ? 'signed' : `by ${ctx.actor.id}`);
      res.set('Content-Type', 'application/pdf').set('Content-Disposition', contentDisposition(out.filename, attachment)).set('Cache-Control', 'private, no-store').send(out.buf);
    } catch (err) { sendError(res, err); }
  });

  app.post('/jobs/:id/pdf/:kind', requireAuth, async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const ctx = await context(req, res, { signed: false });
      if (!ctx) return;
      const { actor, job, kind } = ctx;
      const wantsSave = body.save === true, wantsJn = body.jn === true, wantsNote = body.note === true;
      if ((wantsSave || wantsJn || wantsNote) && !canSave(actor)) return res.status(403).json({ error: 'Only owners, admins and expansion managers can save or send a PDF' });
      if ((wantsJn || wantsNote) && !job.jn_id) return res.status(409).json({ error: 'Job has no JobNimbus id' });
      const p = parseParams(body);
      const logoPng = await loadLogo(ctx.location);
      const out = await render(kind, { ...ctx, logoPng, p, body });
      const filename = typeof body.filename === 'string' && body.filename.trim() ? `${safeName(body.filename.trim()).replace(/\.pdf$/i, '')}.pdf` : out.filename;
      const pages = K.countPages(out.buf);

      let jnFileId = null, jnNoteId = null, document = null;
      if (wantsJn) {
        try { jnFileId = await jnUploadFile(job.jn_id, filename, out.buf, `${TITLE[kind]} generated by DryOps (${actor.name})`); }
        catch (e) { warn('JN upload failed', job.jn_id, e.message); return res.status(502).json({ error: `JobNimbus upload failed: ${e.message}` }); }
      }
      if (wantsSave) document = await saveDocument(job, kind, filename, out.buf, jnFileId);
      if (wantsNote) {
        const r = await jnAddNote(job.jn_id, `${out.note}${document ? `\n${document.storage_url}` : ''}`, { jnLocationId: job.jn_location_id, createdBy: actor.jn_user_id || undefined });
        if (!r || !r.ok) { warn('JN note failed', job.jn_id, r && r.error); if (!jnFileId && !document) return res.status(502).json({ error: `JobNimbus note failed: ${(r && r.error) || 'unknown'}` }); }
        else jnNoteId = r.id || null;
      }
      const rid = cachePut(out.buf, filename);
      log(kind, job.id, `${out.buf.length}B ${pages}p by ${actor.id}`, wantsSave ? 'saved' : '', wantsJn ? `jn:${jnFileId}` : '', wantsNote ? `note:${jnNoteId}` : '');
      res.json({ ok: true, kind, filename, bytes: out.buf.length, pages, document, jn_file_id: jnFileId, jn_note_id: jnNoteId, pdf_url: signedUrl(job.id, kind, p, rid), ...out.meta });
    } catch (err) { sendError(res, err); }
  });

  return { renderKey, filenameFor, cacheSize: () => cache.size };
};

module.exports.KINDS = KINDS;
module.exports.DOC_TYPE = DOC_TYPE;
module.exports.JSON_LIMIT_PATH = JSON_LIMIT_PATH;
module.exports.JSON_LIMIT = JSON_LIMIT;
module.exports.parseParams = parseParams;
module.exports.renderKey = renderKey;
module.exports.filenameFor = filenameFor;
module.exports.clientLabel = clientLabel;
module.exports.canSave = canSave;
