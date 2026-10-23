'use strict';
// ── Lead-source links (dryops.app/lead/<token>) ───────────────────────────────
// A testing location (Abatement Testing Services, White Tail) hands each
// external lead source a permanent link. The referrer fills one short form —
// customer, address, test types, insurance info, instructions, photos — and
// the server turns it into a Testing job through the same intake path the New
// Job form uses (intake.js createIntakeJob with a system actor), then posts
// the photos onto the JobNimbus job. Nobody retypes a screenshot.
//
//   GET  /lead/:token                 company / location / test types for the form
//   POST /lead/:token/upload-url      signed upload into storage photos/lead-photos/<link>/
//   POST /lead/:token/submit          → lead_submissions row → Testing job → JN photos → alert
//   POST /admin/lead-submissions/:id/retry   re-run a failed submission (admin / owner)
//
// Tables: lead_links, lead_submissions (app repo supabase/add_lead_links.sql).
// Tokens are 22 url-safe chars and only ever travel in the public page's URL.
// Rate limit: 30 submissions per hour per token (in memory).

const crypto = require('crypto');
const { normalizeTestTypes, formatTestTypes, DEFAULT_TEST_TYPES } = require('./intakeTesting');

const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UPLOAD_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/webp': 'webp' };
const MAX_PHOTOS = 10;
const INSURANCE_TYPES = ['Insurance', 'Non-Insurance'];

const clean = (v, max = 300) => (v === undefined || v === null ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, max);
const digits = (v) => String(v || '').replace(/\D/g, '');

// ── Pure pieces (tested in test/leadLinks.test.js) ───────────────────────────

// Validate + normalise a submission body. Returns { ok:true, value } or { ok:false, field, error }.
function validateLeadSubmission(body) {
  const bad = (field, error) => ({ ok: false, field, error });
  if (!body || typeof body !== 'object') return bad('body', 'Missing body');
  const customer = body.customer || {};
  const name = clean(customer.name, 120);
  if (!name) return bad('customer.name', 'Customer name is required');
  const phoneDigits = digits(customer.phone).replace(/^1(?=\d{10}$)/, '');
  if (phoneDigits.length !== 10) return bad('customer.phone', 'A valid 10-digit phone is required');
  const a = body.address || {};
  const line1 = clean(a.line1, 200), city = clean(a.city, 80), state = clean(a.state, 40), zip = clean(a.zip, 12);
  if (!line1) return bad('address.line1', 'Street address is required');
  if (!city) return bad('address.city', 'City is required');
  if (!state) return bad('address.state', 'State is required');
  const testTypes = normalizeTestTypes(body.test_types);
  if (!testTypes.length) return bad('test_types', 'Pick at least one type of testing');
  const ins = body.insurance || {};
  const insType = clean(ins.type, 40) || null;
  if (insType && !INSURANCE_TYPES.includes(insType)) return bad('insurance.type', 'insurance.type must be Insurance or Non-Insurance');
  const photos = Array.isArray(body.photo_paths) ? body.photo_paths.map((p) => clean(p, 300)).filter(Boolean) : [];
  if (photos.length > MAX_PHOTOS) return bad('photo_paths', `At most ${MAX_PHOTOS} photos`);
  if (photos.some((p) => !/^lead-photos\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|heic|webp)$/i.test(p))) return bad('photo_paths', 'Unexpected photo path');
  const clientRequestId = UUID_RE.test(String(body.client_request_id || '')) ? String(body.client_request_id).toLowerCase() : null;
  return {
    ok: true,
    value: {
      client_request_id: clientRequestId,
      sender_name: clean(body.sender_name, 80) || null,
      customer: { name, phone: phoneDigits },
      address: { line1, city, state, zip },
      test_types: testTypes,
      insurance: {
        type: insType,
        claim_number: insType === 'Insurance' ? clean(ins.claim_number, 60) || null : null,
        insurer: insType === 'Insurance' ? clean(ins.insurer, 120) || null : null,
        adjuster_name: insType === 'Insurance' ? clean(ins.adjuster_name, 120) || null : null,
        adjuster_phone: insType === 'Insurance' ? (digits(ins.adjuster_phone) || null) : null,
      },
      instructions: clean(body.instructions, 2000) || null,
      photo_paths: photos,
    },
  };
}

// "Jane Q Doe" → { first: 'Jane Q', last: 'Doe' }; one word → first only.
function splitName(full) {
  const parts = clean(full, 120).split(' ').filter(Boolean);
  if (parts.length <= 1) return { first: parts[0] || '', last: '' };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}

// The POST /jobs/create body for a validated submission.
function submissionToIntakeBody(sub, link, company, clientRequestId) {
  const { first, last } = splitName(sub.customer.name);
  return {
    client_request_id: clientRequestId,
    location_id: link.location_id,
    record_type: 'Testing',
    property_type: 'residential',
    contact: { first_name: first, last_name: last, phone: sub.customer.phone, email: '' },
    address: { street: sub.address.line1, city: sub.address.city, state: sub.address.state, zip: sub.address.zip },
    lead: { lead_source_company_id: link.lead_source_company_id, lead_type: 'External Referral' },
    details: {
      test_types: sub.test_types,
      insurance_type: sub.insurance.type || undefined,
      claim_number: sub.insurance.claim_number || undefined,
      insurer: sub.insurance.insurer || undefined,
      adjuster_name: sub.insurance.adjuster_name || undefined,
      adjuster_phone: sub.insurance.adjuster_phone || undefined,
      instructions: sub.instructions || undefined,
      referring_contact: sub.sender_name ? `${sub.sender_name} (${company && company.name ? company.name : 'lead source'})` : undefined,
    },
    lead_link: { sender_name: sub.sender_name, company: company && company.name },
  };
}

// ── Mount ────────────────────────────────────────────────────────────────────
function mountLeadLinks(app, deps) {
  const {
    SUPABASE_URL, SUPABASE_SERVICE_KEY,
    requireAuth, sbGet, sbInsert, sbPatch,
    jnUploadFile, createIntakeJob, loadActor, makeRateLimiter, clientIp,
    log = (...a) => console.log('[lead-link]', ...a),
    warn = (...a) => console.warn('[lead-link]', ...a),
  } = deps;
  const enc = encodeURIComponent;
  const submitLimiter = makeRateLimiter({ limit: 30, windowMs: 60 * 60 * 1000 });
  const uploadLimiter = makeRateLimiter({ limit: 120, windowMs: 60 * 60 * 1000 });
  const LINK_SELECT = 'id,token,location_id,lead_source_company_id,contact_name,contact_phone,enabled,last_submitted_at';
  const SYSTEM_ACTOR = { id: null, role: 'system', name: 'DryOps lead link', jn_user_id: null, locs: [], perms: {} };

  async function loadLink(token) {
    if (!TOKEN_RE.test(String(token || ''))) return null;
    const rows = await sbGet(`lead_links?token=eq.${enc(token)}&select=${LINK_SELECT}`);
    const link = rows && rows[0];
    if (!link || link.enabled === false) return null;
    const [cos, locs] = await Promise.all([
      sbGet(`lead_source_companies?id=eq.${enc(link.lead_source_company_id)}&select=id,name,status`),
      sbGet(`locations?id=eq.${enc(link.location_id)}&select=id,name,status,location_type`),
    ]);
    const company = cos && cos[0];
    const location = locs && locs[0];
    if (!company || !location || company.status === 'archived') return null;
    return { link, company, location };
  }
  async function testTypesFor(locationId) {
    const rows = await sbGet(`location_planner_settings?location_id=eq.${enc(locationId)}&select=testing_types`).catch(() => null);
    const t = rows && rows[0] && normalizeTestTypes(rows[0].testing_types);
    return t && t.length ? t : DEFAULT_TEST_TYPES;
  }
  async function guard(req, res) {
    const ctx = await loadLink(req.params.token);
    if (!ctx) { res.status(404).json({ ok: false, error: 'NOT_FOUND' }); return null; }
    return ctx;
  }

  app.get('/lead/:token', async (req, res) => {
    try {
      const ctx = await guard(req, res);
      if (!ctx) return;
      res.json({
        ok: true,
        company: { id: ctx.company.id, name: ctx.company.name },
        location: { id: ctx.location.id, name: ctx.location.name },
        contact_name: ctx.link.contact_name || null,
        test_types: await testTypesFor(ctx.location.id),
      });
    } catch (err) { warn('get', err.message); res.status(502).json({ ok: false, error: 'UNAVAILABLE' }); }
  });

  app.post('/lead/:token/upload-url', async (req, res) => {
    try {
      const ctx = await guard(req, res);
      if (!ctx) return;
      if (!uploadLimiter.hit(`${ctx.link.id}|${clientIp(req)}`)) return res.status(429).json({ ok: false, error: 'RATE_LIMITED' });
      const contentType = clean(req.body && req.body.contentType, 60).toLowerCase();
      const ext = UPLOAD_TYPES[contentType];
      if (!ext) return res.status(400).json({ ok: false, error: 'Only JPEG, PNG, HEIC or WebP photos are accepted', code: 'BAD_TYPE' });
      const path = `lead-photos/${ctx.link.id}/${crypto.randomUUID()}.${ext}`;
      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/upload/sign/photos/${path}`, {
        method: 'POST',
        headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !j.url) { warn('upload sign', r.status, j && (j.message || j.error)); return res.status(502).json({ ok: false, error: 'UPLOAD_UNAVAILABLE' }); }
      res.json({ ok: true, path, signedUrl: `${SUPABASE_URL}/storage/v1${j.url}`, token: j.token || null, contentType });
    } catch (err) { warn('upload-url', err.message); res.status(502).json({ ok: false, error: 'UPLOAD_UNAVAILABLE' }); }
  });

  // Pull one uploaded photo back out of storage (service key; bucket may be private).
  async function downloadPhoto(path) {
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/photos/${path}`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    });
    if (!r.ok) throw new Error(`storage ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }

  // Create the job (+ photos) for a submission row. Patches the row with the outcome.
  async function runSubmission(submission, ctx) {
    const sub = submission.payload;
    const body = submissionToIntakeBody(sub, ctx.link, ctx.company, submission.client_request_id);
    let result;
    try {
      result = await createIntakeJob(body, SYSTEM_ACTOR, { system: true, source: 'lead_link' });
    } catch (err) {
      await sbPatch('lead_submissions', `id=eq.${enc(submission.id)}`, { status: 'failed', error: String(err.message || err).slice(0, 500), updated_at: new Date().toISOString() }).catch(() => {});
      throw err;
    }
    const jobJnId = result.job && result.job.jn_id;
    const photos = [];
    for (const p of submission.photo_paths || []) {
      try {
        const buf = await downloadPhoto(p);
        const ext = p.split('.').pop();
        const filename = `lead-${(sub.customer && sub.customer.name ? sub.customer.name : 'photo').replace(/[^A-Za-z0-9]+/g, '_')}-${photos.length + 1}.${ext}`;
        const jnid = jobJnId && !String(jobJnId).startsWith('dryrun') ? await jnUploadFile(jobJnId, filename, buf, `Sent via DryOps lead link${sub.sender_name ? ` by ${sub.sender_name}` : ''}`) : null;
        photos.push({ path: p, jnid });
      } catch (err) {
        warn(submission.id, 'photo', p, err.message);
        photos.push({ path: p, error: String(err.message || err).slice(0, 200) });
      }
    }
    const photoErrors = photos.filter((x) => x.error).length;
    await sbPatch('lead_submissions', `id=eq.${enc(submission.id)}`, {
      status: 'created', job_id: result.job.id || null, jn_id: jobJnId || null,
      error: photoErrors ? `${photoErrors} photo${photoErrors === 1 ? '' : 's'} did not reach JobNimbus` : null,
      payload: { ...sub, photo_results: photos, warnings: result.warnings || [] },
      updated_at: new Date().toISOString(),
    }).catch((e) => warn(submission.id, 'patch', e.message));
    await sbPatch('lead_links', `id=eq.${enc(ctx.link.id)}`, { last_submitted_at: new Date().toISOString() }).catch(() => {});
    return { ok: true, submission_id: submission.id, job: { id: result.job.id, jn_id: jobJnId, name: result.job.name }, photos, warnings: result.warnings || [] };
  }

  const inflight = new Map(); // client_request_id → promise
  app.post('/lead/:token/submit', async (req, res) => {
    let ctx = null;
    try {
      ctx = await guard(req, res);
      if (!ctx) return;
      const v = validateLeadSubmission(req.body);
      if (!v.ok) return res.status(400).json({ ok: false, error: v.error, code: 'VALIDATION', field: v.field });
      const sub = v.value;
      const rid = sub.client_request_id || crypto.randomUUID();

      // Idempotent: the same client_request_id returns the earlier outcome (or waits for it).
      const prior = await sbGet(`lead_submissions?client_request_id=eq.${enc(rid)}&select=id,status,job_id,jn_id,error,payload`);
      const existing = prior && prior[0];
      if (existing && existing.status === 'created') {
        return res.json({ ok: true, replay: true, submission_id: existing.id, job: { id: existing.job_id, jn_id: existing.jn_id, name: existing.payload && existing.payload.job_name } });
      }
      if (inflight.has(rid)) { const out = await inflight.get(rid); return res.json(out); }
      if (!submitLimiter.hit(ctx.link.id)) return res.status(429).json({ ok: false, error: 'Too many requests from this link — try again in an hour.', code: 'RATE_LIMITED' });

      const run = (async () => {
        let submission = existing;
        if (!submission) {
          submission = await sbInsert('lead_submissions', {
            link_id: ctx.link.id, payload: sub, photo_paths: sub.photo_paths, status: 'submitted', client_request_id: rid,
          });
          if (!submission || !submission.id) {
            const back = await sbGet(`lead_submissions?client_request_id=eq.${enc(rid)}&select=id,status,job_id,jn_id,error,payload,photo_paths,client_request_id`);
            submission = back && back[0];
          }
          if (!submission) throw Object.assign(new Error('Could not record the submission'), { status: 502, code: 'STORE_FAILED' });
        }
        submission.payload = submission.payload || sub;
        submission.photo_paths = submission.photo_paths || sub.photo_paths;
        submission.client_request_id = rid;
        const out = await runSubmission(submission, ctx);
        log(ctx.company.name, '→', out.job && out.job.name, `photos=${(out.photos || []).length}`);
        return out;
      })();
      inflight.set(rid, run);
      // Swallow here (the awaiting caller handles the rejection) and let the
      // process exit even with the 30 s forget-timer pending.
      run.then(() => {}, () => {}).then(() => { const t = setTimeout(() => inflight.delete(rid), 30000); if (t.unref) t.unref(); });
      res.json(await run);
    } catch (err) {
      warn('submit', ctx ? ctx.company.name : '?', err.message);
      const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 502;
      res.status(status).json({ ok: false, error: err.message || 'Could not send this request right now.', code: err.code || 'ERROR', ...(err.extra || {}) });
    }
  });

  // Staff: re-run a failed submission (same client_request_id → same idempotency key in intake).
  app.post('/admin/lead-submissions/:id/retry', requireAuth, async (req, res) => {
    try {
      const actor = loadActor ? await loadActor(req) : null;
      if (!actor || !['admin', 'owner'].includes(actor.role)) return res.status(403).json({ ok: false, error: 'Not allowed' });
      if (!UUID_RE.test(String(req.params.id))) return res.status(400).json({ ok: false, error: 'Bad id' });
      const rows = await sbGet(`lead_submissions?id=eq.${enc(req.params.id)}&select=id,link_id,payload,photo_paths,status,job_id,jn_id,client_request_id`);
      const submission = rows && rows[0];
      if (!submission) return res.status(404).json({ ok: false, error: 'Submission not found' });
      if (submission.status === 'created') return res.json({ ok: true, replay: true, submission_id: submission.id, job: { id: submission.job_id, jn_id: submission.jn_id } });
      const links = await sbGet(`lead_links?id=eq.${enc(submission.link_id)}&select=${LINK_SELECT}`);
      const link = links && links[0];
      if (!link) return res.status(404).json({ ok: false, error: 'Lead link not found' });
      if (actor.role !== 'admin' && !actor.locs.includes(String(link.location_id))) return res.status(403).json({ ok: false, error: 'Not allowed' });
      const [cos, locs] = await Promise.all([
        sbGet(`lead_source_companies?id=eq.${enc(link.lead_source_company_id)}&select=id,name,status`),
        sbGet(`locations?id=eq.${enc(link.location_id)}&select=id,name,status,location_type`),
      ]);
      const ctx = { link, company: cos && cos[0], location: locs && locs[0] };
      if (!ctx.company || !ctx.location) return res.status(404).json({ ok: false, error: 'Lead source or location missing' });
      if (!submission.client_request_id) submission.client_request_id = crypto.randomUUID();
      const v = validateLeadSubmission(submission.payload);
      if (!v.ok) return res.status(400).json({ ok: false, error: v.error, code: 'VALIDATION', field: v.field });
      submission.payload = { ...v.value, photo_paths: submission.photo_paths || v.value.photo_paths };
      const out = await runSubmission(submission, ctx);
      res.json(out);
    } catch (err) {
      warn('retry', err.message);
      res.status(err.status || 502).json({ ok: false, error: err.message, code: err.code || 'ERROR' });
    }
  });

  return { loadLink, runSubmission };
}

module.exports = mountLeadLinks;
module.exports.TOKEN_RE = TOKEN_RE;
module.exports.MAX_PHOTOS = MAX_PHOTOS;
module.exports.validateLeadSubmission = validateLeadSubmission;
module.exports.submissionToIntakeBody = submissionToIntakeBody;
module.exports.splitName = splitName;
module.exports.formatTestTypes = formatTestTypes;
