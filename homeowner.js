'use strict';
// ── Homeowner portal API (dryops.app/h/<token>) ──────────────────────────────
// The public page reads through the anon-safe get_homeowner_job RPC (DryOps
// repo supabase/add_homeowner_portal.sql); every WRITE comes here with the
// service role. Token = homeowner_links.token (32 hex, one per job).
//
//   GET  /h/:token/ping                 liveness
//   POST /h/:token/choose-window        { visitId, choice: 1|2|'more'|'none' }
//   POST /h/:token/prefs                availability grid, access notes, contact pref
//   POST /h/:token/verify               { last4 } of the phone on file → verified_at
//   POST /h/:token/claim                insurer / claim # / adjuster → jobs + JobNimbus (verified only)
//   POST /h/:token/upload-url           signed upload into storage bucket photos/homeowner/<job>/
//   POST /h/:token/requests             reschedule | issue | equipment | question | photo → staff
//   Staff (requireAuth): POST /jobs/:id/homeowner-link, GET /admin/homeowner/requests,
//   POST /admin/homeowner/requests/:id
//
// Homeowner texts (stage changes, request acknowledgements) go through
// notifyHomeowner(): one per (job, dedupe_key), 8–20 local only (outside that
// the row is queued with error='quiet_hours' and a 15-min sweep sends it).
// Texts never name the company. Env: PORTAL_BASE_URL (default
// https://dryops.app), HO_NOTIFY_DISABLED=1, HO_SMS_DRYRUN=1.

const crypto = require('crypto');
const { notifyChannels } = require('./notify');

const TOKEN_RE = /^[a-f0-9]{32}$/;
const UUID_RE_LOCAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE_LOCAL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ── Pure pieces (tested in test/homeowner.test.js) ───────────────────────────

// Mirror of public.homeowner_stage(status). null = not shown in the portal.
const STAGE_BY_STATUS = {
  'Lead': 'inspection', 'Initial Inspection': 'inspection', 'Estimate Needed': 'inspection',
  'Pending Approval': 'inspection', 'Customer Requested Hold': 'inspection', 'Revision Requested': 'inspection',
  'Scheduled': 'demo', 'Pending Results': 'demo', 'Pending Abatement': 'demo',
  'In Progress': 'drying',
  'Work Complete': 'pickup',
  'Invoice Created': 'complete', 'Invoiced': 'complete', 'Pending Payment': 'complete', 'Payment Plan': 'complete',
  'Paid & Closed': 'complete', 'Attorney': 'complete', 'Public Adjuster': 'complete',
};
const STAGE_RANK = { inspection: 0, demo: 1, drying: 2, pickup: 3, complete: 4 };
function stageOf(status) {
  return STAGE_BY_STATUS[String(status || '').trim()] || null;
}
// True when the job advanced to a later stage (an unknown/previous-null stage
// counts as "before inspection", so a first move into demo+ sends).
function stageMovedForward(prevStage, nextStage) {
  if (!nextStage || !(nextStage in STAGE_RANK)) return false;
  const prev = prevStage && prevStage in STAGE_RANK ? STAGE_RANK[prevStage] : -1;
  return STAGE_RANK[nextStage] > prev;
}
const STAGE_TEXT = {
  demo: (url) => `Your water-damage cleanup is scheduled. Track your job and tell us the best times to visit here: ${url}`,
  drying: (url) => `Demo is done and drying equipment is running. Please keep it on — details and what to expect: ${url}`,
  pickup: (url) => `Your home has reached its drying goal. We'll schedule the equipment pickup; pick a time or see details here: ${url}`,
  complete: (url) => `Thank you — your drying job is complete. If anything comes up, reply here or visit ${url}`,
};
const REQUEST_TEXT = {
  acknowledged: 'We got your request and are on it.',
  resolved: 'Your request has been handled — reply here if anything else comes up.',
};

const REQUEST_KINDS = ['reschedule', 'issue', 'equipment', 'question', 'photo'];
const KIND_LABEL = {
  reschedule: 'Reschedule', issue: 'Issue', equipment: 'Equipment', question: 'Question', photo: 'Photo', claim_info: 'Claim info',
};

// Sliding-window counter: `limit` hits per `windowMs` per key.
function makeRateLimiter({ limit, windowMs, now = () => Date.now() }) {
  const hits = new Map(); // key → [timestamps]
  let lastGc = 0;
  function gc(t) {
    if (t - lastGc < windowMs) return;
    lastGc = t;
    for (const [k, arr] of hits) { const keep = arr.filter((x) => t - x < windowMs); if (keep.length) hits.set(k, keep); else hits.delete(k); }
  }
  return {
    hit(key) {
      const t = now();
      gc(t);
      const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
      if (arr.length >= limit) { hits.set(key, arr); return false; }
      arr.push(t); hits.set(key, arr); return true;
    },
    count(key) { const t = now(); return (hits.get(key) || []).filter((x) => t - x < windowMs).length; },
    reset(key) { hits.delete(key); },
  };
}

// Two-hour presets inside the workday that don't overlap any of the tech's
// other open visits that day. Busy intervals follow lib/schedule/engine.ts
// capacityRange(): full_day = whole day (hulled with the slot), half_day =
// AM/PM half (hulled), window = the slot itself; a slotless window blocks nothing.
const PRESETS_2H = [[480, 600], [600, 720], [720, 840], [840, 960], [960, 1080]];
function busyInterval(v, s) {
  const ws = s.work_start_min, we = s.work_end_min, split = s.half_day_split;
  const hull = (a, b) => (b.startMin == null || b.endMin == null ? a : { startMin: Math.min(a.startMin, b.startMin), endMin: Math.max(a.endMin, b.endMin) });
  const slot = { startMin: v.slot_start_min, endMin: v.slot_end_min };
  if (v.block_kind === 'full_day') return hull({ startMin: ws, endMin: we }, slot);
  if (v.block_kind === 'half_day') {
    if (slot.startMin == null) return null;
    return slot.startMin < split ? hull({ startMin: ws, endMin: split }, slot) : hull({ startMin: split, endMin: we }, slot);
  }
  if (slot.startMin == null || slot.endMin == null) return null;
  return slot;
}
function freePresets({ visits, settings, excludeId }) {
  const s = {
    work_start_min: (settings && settings.work_start_min) || 480,
    work_end_min: (settings && settings.work_end_min) || 1080,
    half_day_split: (settings && settings.half_day_split) || 720,
  };
  const busy = (visits || []).filter((v) => !excludeId || String(v.id) !== String(excludeId)).map((v) => busyInterval(v, s)).filter(Boolean);
  return PRESETS_2H
    .filter(([a, b]) => a >= s.work_start_min && b <= s.work_end_min)
    .filter(([a, b]) => !busy.some((x) => a < x.endMin && x.startMin < b))
    .map(([startMin, endMin]) => ({ startMin, endMin }));
}

function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.ip || (req.socket && req.socket.remoteAddress) || '?';
}

// ── Mount ────────────────────────────────────────────────────────────────────
module.exports = function mountHomeowner(app, deps) {
  const {
    SUPABASE_URL, SUPABASE_SERVICE_KEY, WEB_APP_URL,
    requireAuth, sbGet, sbInsert, sbPatch, sbUpsert,
    jnSendJson, jnAddNote, sendSms, normPhone, toE164,
    loadScheduleSettings, syncVisitJnTask, hooks,
  } = deps;
  const UUID_RE = deps.UUID_RE || UUID_RE_LOCAL;
  const EMAIL_RE = deps.EMAIL_RE || EMAIL_RE_LOCAL;
  const { chooseWindow } = require('./hoWindows');
  const { hoConfirmMessage } = require('./hoOffer');

  const PORTAL_BASE_URL = (process.env.PORTAL_BASE_URL || 'https://dryops.app').trim().replace(/\/$/, '');
  const APP_URL = (WEB_APP_URL || 'https://dryops.app').replace(/\/$/, '');
  const NOTIFY_DISABLED = ['1', 'true'].includes(String(process.env.HO_NOTIFY_DISABLED || '').trim().toLowerCase());
  const SMS_DRYRUN = process.env.HO_SMS_DRYRUN === '1';
  const QUIET_START = 8, QUIET_END = 20; // local hours [8, 20)

  const log = (...a) => console.log('[homeowner]', ...a);
  const warn = (...a) => console.warn('[homeowner]', ...a);
  const enc = encodeURIComponent;
  const clean = (v, max = 500) => (v === undefined || v === null ? '' : String(v)).trim().slice(0, max);
  const nowISO = () => new Date().toISOString();

  // ── Location / timezone helpers ───────────────────────────────────────────
  const locCache = new Map(); // id → { at, row }
  async function loadLocation(locationId) {
    if (!locationId) return null;
    const key = String(locationId);
    const c = locCache.get(key);
    if (c && Date.now() - c.at < 60000) return c.row;
    const rows = await sbGet(`locations?id=eq.${enc(key)}&select=id,name,timezone,office_phone,jn_location_id,jn_note_tag`);
    const row = (rows && rows[0]) || null;
    locCache.set(key, { at: Date.now(), row });
    return row;
  }
  async function tzFor(locationId) {
    try {
      const loc = await loadLocation(locationId);
      if (loc && loc.timezone) return loc.timezone;
      const s = await loadScheduleSettings();
      if (s && s.default_timezone) return s.default_timezone;
    } catch (e) { warn('tz lookup failed', e.message); }
    return 'America/Denver';
  }
  function todayIn(tz, at = new Date()) {
    const f = (z) => new Intl.DateTimeFormat('en-CA', { timeZone: z, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
    try { return f(tz); } catch { return f('America/Denver'); }
  }
  function hourIn(tz, at = new Date()) {
    const f = (z) => Number(new Intl.DateTimeFormat('en-US', { timeZone: z, hourCycle: 'h23', hour: '2-digit' }).formatToParts(at).find((p) => p.type === 'hour').value);
    try { return f(tz); } catch { return f('America/Denver'); }
  }
  async function portalEnabledFor(locationId) {
    if (!locationId) return false;
    const rows = await sbGet(`location_planner_settings?location_id=eq.${enc(String(locationId))}&select=portal_enabled`);
    return !!(rows && rows[0] && rows[0].portal_enabled);
  }
  async function noteContext(job) {
    const loc = await loadLocation(job.location_id).catch(() => null);
    return { tag: (loc && loc.jn_note_tag) || null, jnLocationId: (loc && loc.jn_location_id) || job.jn_location_id || null };
  }

  // ── Links ─────────────────────────────────────────────────────────────────
  const LINK_SELECT = 'job_id,token,phone_norm,language,disabled,verified_at,created_at,rotated_at';
  function portalUrl(token) { return `${PORTAL_BASE_URL}/h/${token}`; }
  async function loadJob(jobId) {
    const rows = await sbGet(`jobs?id=eq.${enc(String(jobId))}&select=id,jn_id,name,client_name,client_phone,client_phone_norm,address,status,location_id,record_type,is_active,claim_number,insurer,adjuster_name,adjuster_phone,adjuster_email,insurance_type,jn_location_id`);
    return (rows && rows[0]) || null;
  }
  // → { token, url (null while disabled), link }. Inserts the row on first use.
  async function ensureHomeownerLink(jobId, job) {
    const id = String(jobId);
    let rows = await sbGet(`homeowner_links?job_id=eq.${enc(id)}&select=${LINK_SELECT}`);
    if (!rows || !rows[0]) {
      const j = job || (await loadJob(id));
      if (!j) throw new Error('Job not found');
      const phone_norm = j.client_phone_norm || normPhone(j.client_phone) || null;
      // ignore-duplicates semantics: a concurrent insert wins, we read it back.
      await sbUpsert('homeowner_links', { job_id: id, phone_norm }, 'job_id');
      rows = await sbGet(`homeowner_links?job_id=eq.${enc(id)}&select=${LINK_SELECT}`);
      if (!rows || !rows[0]) throw new Error('Link row was not created');
    }
    const link = rows[0];
    return { token: link.token, url: link.disabled ? null : portalUrl(link.token), disabled: !!link.disabled, link };
  }

  // ── Homeowner SMS ─────────────────────────────────────────────────────────
  async function smsOut(phone, body) {
    if (SMS_DRYRUN) { log('sms dryrun →', phone.slice(-4), JSON.stringify(body)); return { ok: true, sid: 'dryrun', dryrun: true }; }
    return sendSms(phone, body);
  }
  // One text per (job, dedupe_key). Skips: notifications off, no phone, the
  // location's portal is off, already sent. Outside 8–20 local → queued.
  async function notifyHomeowner(job, kind, dedupeKey, body, opts = {}) {
    if (NOTIFY_DISABLED) return { ok: false, skipped: 'disabled' };
    const phone = toE164(job.client_phone || job.client_phone_norm);
    if (!phone) return { ok: false, skipped: 'no_phone' };
    if (!opts.portalChecked && !(await portalEnabledFor(job.location_id))) return { ok: false, skipped: 'portal_disabled' };
    const prior = await sbGet(`homeowner_notifications?job_id=eq.${enc(job.id)}&dedupe_key=eq.${enc(dedupeKey)}&select=id,sent_at,error`);
    const row = prior && prior[0];
    if (row && (row.sent_at || row.error !== 'quiet_hours')) return { ok: false, skipped: 'duplicate' };
    const base = { job_id: job.id, kind, dedupe_key: dedupeKey, to_phone: phone, body };
    const tz = await tzFor(job.location_id);
    const h = hourIn(tz);
    if (h < QUIET_START || h >= QUIET_END) {
      await sbUpsert('homeowner_notifications', { ...base, error: 'quiet_hours' }, 'job_id,dedupe_key');
      return { ok: false, queued: true };
    }
    const r = await smsOut(phone, body);
    await sbUpsert('homeowner_notifications', { ...base, sms_sid: r.ok ? r.sid || null : null, sent_at: r.ok ? nowISO() : null, error: r.ok ? null : String(r.error || 'send failed').slice(0, 300) }, 'job_id,dedupe_key');
    if (!r.ok) warn('sms failed', kind, r.error);
    return r.ok ? { ok: true, sid: r.sid } : { ok: false, error: r.error };
  }
  // Rows parked by quiet hours: send once the job's location is inside 8–20.
  let quietSweepRunning = false;
  async function sweepQuietHours() {
    if (quietSweepRunning || NOTIFY_DISABLED) return;
    quietSweepRunning = true;
    try {
      const rows = (await sbGet(`homeowner_notifications?error=eq.quiet_hours&sent_at=is.null&select=id,job_id,kind,dedupe_key,to_phone,body,created_at,jobs(location_id,is_active)&order=created_at.asc&limit=100`)) || [];
      for (const n of rows) {
        const loc = n.jobs && n.jobs.location_id;
        const h = hourIn(await tzFor(loc));
        if (h < QUIET_START || h >= QUIET_END) continue;
        if (n.jobs && n.jobs.is_active === false) { await sbPatch('homeowner_notifications', `id=eq.${enc(n.id)}`, { error: 'job_inactive' }).catch(() => {}); continue; }
        if (Date.now() - new Date(n.created_at).getTime() > 3 * 86400000) { await sbPatch('homeowner_notifications', `id=eq.${enc(n.id)}`, { error: 'expired' }).catch(() => {}); continue; }
        const r = await smsOut(n.to_phone, n.body);
        await sbPatch('homeowner_notifications', `id=eq.${enc(n.id)}`, r.ok
          ? { sms_sid: r.sid || null, sent_at: nowISO(), error: null }
          : { error: String(r.error || 'send failed').slice(0, 300) }).catch((e) => warn('quiet sweep patch', e.message));
      }
    } catch (e) { warn('quiet sweep', e.message); } finally { quietSweepRunning = false; }
  }
  if (!NOTIFY_DISABLED) {
    setTimeout(sweepQuietHours, 90 * 1000).unref();
    setInterval(sweepQuietHours, 15 * 60 * 1000).unref();
  }

  // ── Stage texts (JobNimbus status webhook) ────────────────────────────────
  async function onJobStatusChanged({ jnId, prevStatus, newStatus }) {
    if (NOTIFY_DISABLED) return;
    const next = stageOf(newStatus);
    if (!stageMovedForward(stageOf(prevStatus), next) || !STAGE_TEXT[next]) return;
    const rows = await sbGet(`jobs?jn_id=eq.${enc(String(jnId))}&select=id,jn_id,client_name,client_phone,client_phone_norm,location_id,is_active,status`);
    const job = rows && rows[0];
    if (!job || job.is_active === false) return;
    if (!(await portalEnabledFor(job.location_id))) return;
    const link = await ensureHomeownerLink(job.id, job);
    if (!link.url) return;
    const r = await notifyHomeowner(job, 'stage', `stage:${next}`, STAGE_TEXT[next](link.url), { portalChecked: true });
    log('stage', next, job.id, JSON.stringify(r));
  }
  if (hooks) hooks.jobStatusChanged = (ev) => onJobStatusChanged(ev).catch((e) => warn('stage hook', e.message));

  // ── Token guard + rate limits ─────────────────────────────────────────────
  const writeLimiter = makeRateLimiter({ limit: 30, windowMs: 10 * 60 * 1000 });
  const verifyMisses = makeRateLimiter({ limit: 5, windowMs: 10 * 60 * 1000 });
  const JOB_EMBED = 'jobs(id,jn_id,name,client_name,client_phone,client_phone_norm,address,status,location_id,record_type,is_active,claim_number,insurer,adjuster_name,adjuster_phone,adjuster_email,insurance_type,jn_location_id)';
  async function hoGuard(req, res, next) {
    try {
      const token = String(req.params.token || '');
      if (!TOKEN_RE.test(token)) return res.status(404).json({ error: 'not_found' });
      const rows = await sbGet(`homeowner_links?token=eq.${token}&disabled=eq.false&select=${LINK_SELECT},${JOB_EMBED}`);
      const link = rows && rows[0];
      const job = link && link.jobs;
      if (!link || !job || job.is_active === false || !stageOf(job.status)) return res.status(404).json({ error: 'not_found' });
      if (req.method !== 'GET' && !writeLimiter.hit(`${token}|${clientIp(req)}`)) {
        return res.status(429).json({ error: 'Too many requests — try again in a few minutes.' });
      }
      delete link.jobs;
      req.ho = { link, job, token };
      next();
    } catch (err) {
      warn('guard', err.message);
      res.status(502).json({ error: 'Could not load your page right now.' });
    }
  }

  app.get('/h/:token/ping', hoGuard, (req, res) => res.json({ ok: true }));

  // ── Windows ───────────────────────────────────────────────────────────────
  const CHOOSABLE = ['offered', 'tentative', 'manual', 'none'];
  async function loadVisitForJob(visitId, jobId) {
    if (!UUID_RE.test(String(visitId || ''))) return null;
    const rows = await sbGet(`inspections?id=eq.${enc(String(visitId))}&job_id=eq.${enc(String(jobId))}&select=id,job_id,jn_id,task_type,status,scheduled_date,slot_start_min,slot_end_min,block_kind,assigned_to_ids,location_id,ho_window_options,ho_window_status,ho_chosen`);
    return (rows && rows[0]) || null;
  }
  app.post('/h/:token/choose-window', hoGuard, async (req, res) => {
    try {
      const { job } = req.ho;
      const body = req.body || {};
      const visit = await loadVisitForJob(body.visitId, job.id);
      if (!visit) return res.status(404).json({ error: 'Visit not found' });
      if (visit.status === 'cancelled' || visit.status === 'completed') return res.status(409).json({ error: 'This visit is no longer open', code: 'VISIT_CLOSED' });
      const choice = body.choice;
      const n = choice === 1 || choice === 2 || choice === '1' || choice === '2' ? Number(choice) : null;
      const options = Array.isArray(visit.ho_window_options) ? visit.ho_window_options : [];

      if (n) {
        if (!CHOOSABLE.includes(visit.ho_window_status)) return res.status(409).json({ error: 'This window was already set', code: 'WINDOW_LOCKED', status: visit.ho_window_status });
        if (!options[n - 1]) return res.status(400).json({ error: 'That option is not available', code: 'NO_OPTION' });
        const r = await chooseWindow({ visit, n, replyText: 'portal', sbPatch, syncVisitJnTask });
        if (r.ok && r.status === 'confirmed') {
          const today = todayIn(await tzFor(visit.location_id || job.location_id));
          notifyHomeowner(job, 'window_confirm', `confirm:${visit.id}:${visit.scheduled_date}:${r.window.startMin}`,
            hoConfirmMessage(r.window, visit.scheduled_date, today)).catch((e) => warn('confirm sms', e.message));
        }
        return res.json(r);
      }
      if (choice === 'more') {
        const settings = await loadScheduleSettings().catch(() => null);
        const techId = (visit.assigned_to_ids || [])[0];
        let visits = [];
        if (techId) {
          visits = (await sbGet(`inspections?assigned_to_ids=cs.{${enc(String(techId))}}&scheduled_date=eq.${enc(visit.scheduled_date)}&status=in.(scheduled,in_progress)&select=id,slot_start_min,slot_end_min,block_kind`)) || [];
        }
        return res.json({ ok: true, options: freePresets({ visits, settings, excludeId: visit.id }) });
      }
      if (choice === 'none') {
        await sbPatch('inspections', `id=eq.${enc(visit.id)}`, { ho_window_status: 'declined', ho_replied_at: nowISO(), ho_reply_text: 'portal:none' });
        const text = `Neither offered window works for the ${visit.task_type} on ${visit.scheduled_date}` + (clean(body.body, 500) ? ` — ${clean(body.body, 500)}` : '');
        const request = await createRequest({ job, kind: 'reschedule', body: text, visitId: visit.id, photoUrls: [] });
        return res.json({ ok: true, status: 'declined', request });
      }
      return res.status(400).json({ error: "choice must be 1, 2, 'more' or 'none'" });
    } catch (err) {
      warn('choose-window', err.message);
      res.status(502).json({ error: 'Could not save right now. Please try again.' });
    }
  });

  // ── Preferences ───────────────────────────────────────────────────────────
  const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const PARTS = ['am', 'pm', 'eve'];
  function parseAvailability(v) {
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (typeof v !== 'object' || Array.isArray(v)) throw new Error('availability must be an object of weekday keys');
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (!DAYS.includes(k)) throw new Error(`availability: unknown day "${k}"`);
      if (!val || typeof val !== 'object' || Array.isArray(val)) throw new Error(`availability.${k} must be an object`);
      const day = {};
      for (const [p, b] of Object.entries(val)) {
        if (!PARTS.includes(p)) throw new Error(`availability.${k}: unknown part "${p}"`);
        if (typeof b !== 'boolean') throw new Error(`availability.${k}.${p} must be true/false`);
        day[p] = b;
      }
      out[k] = day;
    }
    return out;
  }
  function prefsNoteText(p) {
    const bits = [];
    if (p.gate_code) bits.push(`gate ${p.gate_code}`);
    if (p.pets) bits.push(p.pets);
    if (p.access_notes) bits.push(p.access_notes);
    if (p.call_first) bits.push('call first');
    if (p.contact_pref) bits.push(`prefers ${p.contact_pref === 'call' ? 'calls' : 'texts'}`);
    if (p.tenant_name || p.tenant_phone) bits.push(`tenant ${[p.tenant_name, p.tenant_phone].filter(Boolean).join(' ')}`);
    return bits.length ? `Homeowner access notes (portal): ${bits.join(' · ')}` : null;
  }
  app.post('/h/:token/prefs', hoGuard, async (req, res) => {
    try {
      const { job, link } = req.ho;
      const b = req.body || {};
      const row = {};
      let availability;
      try { availability = parseAvailability(b.availability); } catch (e) { return res.status(400).json({ error: e.message }); }
      if (availability !== undefined) row.availability = availability;
      for (const f of ['access_notes', 'gate_code', 'pets', 'tenant_name', 'tenant_phone']) {
        if (b[f] !== undefined) {
          if (b[f] !== null && typeof b[f] !== 'string') return res.status(400).json({ error: `${f} must be a string` });
          if (b[f] && b[f].length > 500) return res.status(400).json({ error: `${f} is too long (max 500)` });
          row[f] = clean(b[f], 500) || null;
        }
      }
      if (b.call_first !== undefined) {
        if (typeof b.call_first !== 'boolean') return res.status(400).json({ error: 'call_first must be true/false' });
        row.call_first = b.call_first;
      }
      if (b.contact_pref !== undefined) {
        if (b.contact_pref !== null && !['text', 'call'].includes(b.contact_pref)) return res.status(400).json({ error: "contact_pref must be 'text' or 'call'" });
        row.contact_pref = b.contact_pref;
      }
      let language;
      if (b.language !== undefined) {
        if (!['en', 'es'].includes(b.language)) return res.status(400).json({ error: "language must be 'en' or 'es'" });
        language = b.language;
      }
      if (!Object.keys(row).length && !language) return res.status(400).json({ error: 'Nothing to save' });

      const priorRows = await sbGet(`homeowner_prefs?job_id=eq.${enc(job.id)}&select=job_id`);
      const first = !(priorRows && priorRows[0]);
      if (Object.keys(row).length) {
        await sbUpsert('homeowner_prefs', { job_id: job.id, ...row, updated_at: nowISO(), updated_via: 'portal' }, 'job_id');
      }
      if (language && language !== link.language) await sbPatch('homeowner_links', `job_id=eq.${enc(job.id)}`, { language });
      const saved = await sbGet(`homeowner_prefs?job_id=eq.${enc(job.id)}&select=*`);
      const prefs = (saved && saved[0]) || null;
      if (first && prefs && job.jn_id) {
        const text = prefsNoteText(prefs);
        if (text) {
          const ctx = await noteContext(job);
          jnAddNote(job.jn_id, text, { tag: ctx.tag, jnLocationId: ctx.jnLocationId }).then((r) => { if (!r.ok) warn('prefs note', r.error); }).catch((e) => warn('prefs note', e.message));
        }
      }
      res.json({ ok: true, prefs, language: language || link.language });
    } catch (err) {
      warn('prefs', err.message);
      res.status(502).json({ error: 'Could not save right now. Please try again.' });
    }
  });

  // ── Verify (last 4 of the phone on file) ──────────────────────────────────
  app.post('/h/:token/verify', hoGuard, async (req, res) => {
    try {
      const { job, link, token } = req.ho;
      const last4 = clean(req.body && req.body.last4, 8).replace(/\D/g, '');
      if (!/^\d{4}$/.test(last4)) return res.status(400).json({ error: 'Enter the last 4 digits of your phone number' });
      if (verifyMisses.count(token) >= 5) return res.status(429).json({ error: 'Too many attempts — try again in 10 minutes.' });
      const norm = job.client_phone_norm || normPhone(job.client_phone) || link.phone_norm;
      if (!norm || norm.length < 4) return res.json({ ok: false, code: 'NO_PHONE' });
      const a = Buffer.from(norm.slice(-4)), b = Buffer.from(last4);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        if (!link.verified_at) await sbPatch('homeowner_links', `job_id=eq.${enc(job.id)}`, { verified_at: nowISO() });
        verifyMisses.reset(token);
        return res.json({ ok: true });
      }
      verifyMisses.hit(token);
      res.json({ ok: false });
    } catch (err) {
      warn('verify', err.message);
      res.status(502).json({ error: 'Could not verify right now. Please try again.' });
    }
  });

  // ── Claim info → jobs + JobNimbus ─────────────────────────────────────────
  const CLAIM_FIELDS = { insurer: 'cf_string_9', claim_number: 'cf_string_2', adjuster_name: 'cf_string_3', adjuster_phone: 'cf_string_4', adjuster_email: 'cf_string_5' };
  const CLAIM_LABEL = { insurer: 'Insurer', claim_number: 'Claim #', adjuster_name: 'Adjuster', adjuster_phone: 'Adjuster phone', adjuster_email: 'Adjuster email' };
  app.post('/h/:token/claim', hoGuard, async (req, res) => {
    try {
      const { job, link } = req.ho;
      if (!link.verified_at) return res.status(403).json({ error: 'Verify your phone number first', code: 'NOT_VERIFIED' });
      const b = req.body || {};
      const patch = {};
      for (const f of Object.keys(CLAIM_FIELDS)) {
        if (b[f] === undefined || b[f] === null) continue;
        if (typeof b[f] !== 'string') return res.status(400).json({ error: `${f} must be a string` });
        const v = clean(b[f], 200);
        if (!v) continue;
        if (f === 'adjuster_email' && !EMAIL_RE.test(v)) return res.status(400).json({ error: 'adjuster_email is not a valid email' });
        patch[f] = v;
      }
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to save' });

      await sbPatch('jobs', `id=eq.${enc(job.id)}`, patch);
      const summary = Object.keys(patch).map((f) => `${CLAIM_LABEL[f]} ${patch[f]}`).join(' · ');
      let jnErr = null, noteId = null;
      if (job.jn_id) {
        const jnBody = { record_type_name: job.record_type || 'Mitigation' };
        for (const f of Object.keys(patch)) jnBody[CLAIM_FIELDS[f]] = patch[f];
        try {
          const r = await jnSendJson('PUT', `jobs/${enc(job.jn_id)}`, jnBody);
          if (!r.ok) jnErr = `JobNimbus responded ${r.status}${r.body && (r.body.message || r.body.error) ? ': ' + (r.body.message || r.body.error) : ''}`;
        } catch (e) { jnErr = e.message; }
        const ctx = await noteContext(job);
        const n = await jnAddNote(job.jn_id, `Claim info provided by homeowner via portal: ${summary}`, { tag: ctx.tag, jnLocationId: ctx.jnLocationId }).catch((e) => ({ ok: false, error: e.message }));
        if (n.ok) noteId = n.id; else jnErr = [jnErr, `note: ${n.error}`].filter(Boolean).join('; ');
        if (jnErr) warn('claim JN', job.id, jnErr);
      }
      await sbInsert('homeowner_requests', {
        job_id: job.id, kind: 'claim_info', body: summary, status: 'resolved', resolved_at: nowISO(),
        jn_note_id: noteId, jn_note_error: jnErr ? jnErr.slice(0, 500) : null,
      }).catch((e) => warn('claim audit row', e.message));
      res.json({ ok: true, saved: Object.keys(patch) });
    } catch (err) {
      warn('claim', err.message);
      res.status(502).json({ error: 'Could not save right now. Please try again.' });
    }
  });

  // ── Photo uploads ─────────────────────────────────────────────────────────
  const UPLOAD_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/webp': 'webp' };
  const publicPrefix = (jobId) => `${SUPABASE_URL}/storage/v1/object/public/photos/homeowner/${jobId}/`;
  app.post('/h/:token/upload-url', hoGuard, async (req, res) => {
    try {
      const { job } = req.ho;
      const contentType = clean(req.body && req.body.contentType, 60).toLowerCase();
      const ext = UPLOAD_TYPES[contentType];
      if (!ext) return res.status(400).json({ error: 'Only JPEG, PNG, HEIC or WebP photos are accepted' });
      const path = `homeowner/${job.id}/${crypto.randomUUID()}.${ext}`;
      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/upload/sign/photos/${path}`, {
        method: 'POST',
        headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !j.url) {
        warn('upload sign', r.status, j && (j.message || j.error));
        return res.status(502).json({ error: 'Could not prepare the upload right now.' });
      }
      res.json({ ok: true, path, signedUrl: `${SUPABASE_URL}/storage/v1${j.url}`, token: j.token || null, publicUrl: `${publicPrefix(job.id)}${path.split('/').pop()}`, contentType });
    } catch (err) {
      warn('upload-url', err.message);
      res.status(502).json({ error: 'Could not prepare the upload right now.' });
    }
  });

  // ── Requests ──────────────────────────────────────────────────────────────
  async function createRequest({ job, kind, body, visitId, photoUrls }) {
    const request = await sbInsert('homeowner_requests', { job_id: job.id, kind, body: body || null, visit_id: visitId || null, photo_urls: photoUrls, status: 'open' });
    for (const url of photoUrls) {
      await sbInsert('photos', { job_id: job.id, storage_url: url, taken_at: nowISO(), caption: 'From homeowner (portal)' }).catch((e) => warn('photo row', e.message));
    }
    const label = KIND_LABEL[kind] || kind;
    let noteId = null, noteErr = null;
    if (job.jn_id) {
      const text = [`Homeowner request (portal) · ${label}${body ? `: ${body}` : ''}`, ...photoUrls].join('\n');
      const ctx = await noteContext(job);
      const n = await jnAddNote(job.jn_id, text, { tag: ctx.tag, jnLocationId: ctx.jnLocationId }).catch((e) => ({ ok: false, error: e.message }));
      if (n.ok) noteId = n.id; else noteErr = n.error;
      if (request && request.id) await sbPatch('homeowner_requests', `id=eq.${enc(request.id)}`, { jn_note_id: noteId, jn_note_error: noteErr ? String(noteErr).slice(0, 500) : null }).catch(() => {});
    }
    const lines = [{ b: `🏠 Homeowner request · ${job.client_name || job.name || 'Homeowner'} · ${label}` }];
    if (body) lines.push(body.slice(0, 600));
    if (job.address) lines.push(`📍 ${job.address}`);
    if (photoUrls.length) lines.push(`${photoUrls.length} photo${photoUrls.length === 1 ? '' : 's'} attached`);
    const buttons = [];
    if (job.jn_id) buttons.push({ text: 'Open in JobNimbus', url: `https://app.jobnimbus.com/job/${job.jn_id}` });
    buttons.push({ text: 'Open in DryOps', url: `${APP_URL}/jobs/${job.id}` });
    for (const u of photoUrls.slice(0, 3)) buttons.push({ text: 'View photo', url: u });
    notifyChannels({ sbGet, events: ['homeowner_request', 'job_created'], locationId: job.location_id, msg: { lines, buttons }, log: (...a) => warn('notify', ...a) }).catch(() => {});
    return request ? { ...request, jn_note_id: noteId, jn_note_error: noteErr } : null;
  }
  app.post('/h/:token/requests', hoGuard, async (req, res) => {
    try {
      const { job } = req.ho;
      const b = req.body || {};
      if (!REQUEST_KINDS.includes(b.kind)) return res.status(400).json({ error: `kind must be one of ${REQUEST_KINDS.join(', ')}` });
      const body = clean(b.body, 2000);
      let visitId = null;
      if (b.visit_id) {
        const v = await loadVisitForJob(b.visit_id, job.id);
        if (!v) return res.status(400).json({ error: 'visit_id does not belong to this job' });
        visitId = v.id;
      }
      const prefix = publicPrefix(job.id);
      const photoUrls = [];
      if (b.photo_urls !== undefined) {
        if (!Array.isArray(b.photo_urls) || b.photo_urls.length > 10) return res.status(400).json({ error: 'photo_urls must be a list of at most 10' });
        for (const u of b.photo_urls) {
          if (typeof u !== 'string' || !u.startsWith(prefix) || /[?#]/.test(u)) return res.status(400).json({ error: 'photo_urls must be uploads from this page' });
          photoUrls.push(u);
        }
      }
      if (!body && !photoUrls.length) return res.status(400).json({ error: 'Add a message or a photo' });
      const request = await createRequest({ job, kind: b.kind, body, visitId, photoUrls });
      res.json({ ok: true, request });
    } catch (err) {
      warn('requests', err.message);
      res.status(502).json({ error: 'Could not send right now. Please try again.' });
    }
  });

  // ── Staff routes ──────────────────────────────────────────────────────────
  async function staffActor(req) {
    const rows = await sbGet(`profiles?id=eq.${enc(req.userId)}&select=id,role,full_name,location_id,location_ids`);
    const p = rows && rows[0];
    if (!p) return null;
    const locs = Array.isArray(p.location_ids) && p.location_ids.length ? p.location_ids : (p.location_id ? [p.location_id] : []);
    return { id: String(p.id), role: p.role, name: p.full_name || 'DryOps', locs: locs.map(String) };
  }
  // Same rule as public.staff_can_see_job(): admins/owners, or a member of the job's location.
  const canSeeJob = (actor, job) => ['admin', 'owner'].includes(actor.role) || (job.location_id && actor.locs.includes(String(job.location_id)));

  app.post('/jobs/:id/homeowner-link', requireAuth, async (req, res) => {
    try {
      const actor = await staffActor(req);
      if (!actor) return res.status(403).json({ error: 'Profile not found' });
      if (!UUID_RE.test(String(req.params.id))) return res.status(400).json({ error: 'Bad job id' });
      const job = await loadJob(req.params.id);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      if (!canSeeJob(actor, job)) return res.status(403).json({ error: 'Not allowed' });
      const b = req.body || {};
      let { link } = await ensureHomeownerLink(job.id, job);
      const patch = {};
      if (b.rotate) { patch.token = crypto.randomBytes(16).toString('hex'); patch.rotated_at = nowISO(); patch.verified_at = null; }
      if (b.disable) patch.disabled = true;
      if (b.enable) patch.disabled = false;
      if (Object.keys(patch).length) {
        const out = await sbPatch('homeowner_links', `job_id=eq.${enc(job.id)}`, patch);
        link = (Array.isArray(out) && out[0]) || { ...link, ...patch };
      }
      res.json({
        ok: true, token: link.token, disabled: !!link.disabled, url: link.disabled ? null : portalUrl(link.token),
        verified: !!link.verified_at, language: link.language, portal_enabled: await portalEnabledFor(job.location_id),
      });
    } catch (err) {
      warn('homeowner-link', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  app.get('/admin/homeowner/requests', requireAuth, async (req, res) => {
    try {
      const actor = await staffActor(req);
      if (!actor) return res.status(403).json({ error: 'Profile not found' });
      const status = clean(req.query.status, 20);
      const locationId = clean(req.query.location_id, 80);
      const q = [`select=*,jobs!inner(id,name,client_name,address,location_id,jn_id,status)`, 'order=created_at.desc', 'limit=200'];
      if (['open', 'acknowledged', 'resolved'].includes(status)) q.push(`status=eq.${status}`);
      else if (status === 'all') { /* no filter */ } else q.push('status=neq.resolved');
      if (locationId) {
        if (!['admin', 'owner'].includes(actor.role) && !actor.locs.includes(locationId)) return res.status(403).json({ error: 'Not allowed' });
        q.push(`jobs.location_id=eq.${enc(locationId)}`);
      } else if (!['admin', 'owner'].includes(actor.role)) {
        if (!actor.locs.length) return res.json({ ok: true, requests: [] });
        q.push(`jobs.location_id=in.(${actor.locs.map(enc).join(',')})`);
      }
      const rows = (await sbGet(`homeowner_requests?${q.join('&')}`)) || [];
      res.json({ ok: true, requests: rows.map((r) => ({ ...r, job: r.jobs, jobs: undefined, kind_label: KIND_LABEL[r.kind] || r.kind })) });
    } catch (err) {
      warn('requests list', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  app.post('/admin/homeowner/requests/:id', requireAuth, async (req, res) => {
    try {
      const actor = await staffActor(req);
      if (!actor) return res.status(403).json({ error: 'Profile not found' });
      const id = String(req.params.id);
      if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Bad request id' });
      const status = req.body && req.body.status;
      if (!['acknowledged', 'resolved'].includes(status)) return res.status(400).json({ error: "status must be 'acknowledged' or 'resolved'" });
      const rows = await sbGet(`homeowner_requests?id=eq.${enc(id)}&select=*,${JOB_EMBED}`);
      const r = rows && rows[0];
      if (!r) return res.status(404).json({ error: 'Request not found' });
      const job = r.jobs;
      if (!canSeeJob(actor, job)) return res.status(403).json({ error: 'Not allowed' });
      const patch = { status };
      if (status === 'acknowledged') { patch.acknowledged_by = actor.id; patch.acknowledged_at = nowISO(); }
      else { patch.resolved_by = actor.id; patch.resolved_at = nowISO(); if (!r.acknowledged_at) { patch.acknowledged_by = actor.id; patch.acknowledged_at = patch.resolved_at; } }
      const out = await sbPatch('homeowner_requests', `id=eq.${enc(id)}`, patch);
      const updated = (Array.isArray(out) && out[0]) || { ...r, ...patch };
      delete updated.jobs;
      let notify = null;
      if (r.kind !== 'claim_info') {
        notify = await notifyHomeowner(job, `request_${status}`, `req:${id}:${status}`, REQUEST_TEXT[status]).catch((e) => ({ ok: false, error: e.message }));
      }
      res.json({ ok: true, request: updated, notify });
    } catch (err) {
      warn('request update', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  return { ensureHomeownerLink, portalUrl, portalEnabledFor, notifyHomeowner, tzFor, todayIn, hourIn, loadLocation, loadJob, onJobStatusChanged, sweepQuietHours };
};

module.exports.stageOf = stageOf;
module.exports.stageMovedForward = stageMovedForward;
module.exports.STAGE_RANK = STAGE_RANK;
module.exports.STAGE_TEXT = STAGE_TEXT;
module.exports.REQUEST_TEXT = REQUEST_TEXT;
module.exports.makeRateLimiter = makeRateLimiter;
module.exports.freePresets = freePresets;
module.exports.clientIp = clientIp;
module.exports.KIND_LABEL = KIND_LABEL;
