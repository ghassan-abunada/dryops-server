'use strict';
// ── Storage billing per job (the job page's Contents › Storage billing) ──────
// A Contents job in storage is billed once a month by the supplemental run in
// server.js ("Supplemental storage billing"). This module shows one job the
// way that run sees it and lets admins / owners set the three JobNimbus
// fields that drive it — "In Storage?" (cf_boolean_1), "# of Vaults"
// (cf_long_1) and "Supplemental Price" (cf_double_1, monthly). Writes go to
// JobNimbus FIRST, are read back, and only then land on the local row, like
// the sales rep (salesRep.js).
//
//   GET /jobs/:id/storage  → { record_type, status, in_storage, vaults,
//        monthly_price, eligibility: { eligible, placeholder, reasons },
//        billing: { mode, next_run, day }, invoices: [...],
//        last_storage_invoice, runs: [...], can_edit }
//   PUT /jobs/:id/storage  { in_storage?, vaults?, monthly_price? } → same shape
//
// `storageCols(job)` is the mirror for jnJobFields (webhook + reconcile):
// JN payload → { in_storage, storage_vaults, storage_monthly_price }. Absent
// keys leave the columns alone (every other mirrored column works that way,
// and a slim webhook payload must not wipe what the full record set).
// Pure bits are covered by test/storage.test.js.

const { uuidRe } = require('./noteReader');
const { storageFields } = require('./suppEligibility');

const WRITE_ROLES = new Set(['admin', 'owner']);
const SEES_ALL = new Set(['admin', 'owner', 'executive']);
// JobNimbus invoice status codes (v2/invoices). The record usually carries
// status_name too; this is the fallback.
const INVOICE_STATUS = { 1: 'Draft', 2: 'Sent', 3: 'Open', 4: 'Closed', 6: 'Void' };

function storageCols(job) {
  const f = storageFields(job);
  const out = {};
  if (f.in_storage !== undefined) out.in_storage = f.in_storage;
  if (f.vaults !== undefined) out.storage_vaults = f.vaults;
  if (f.monthly_price !== undefined) out.storage_monthly_price = f.monthly_price;
  return out;
}

// external_id tells who made a storage invoice: the monthly run
// (supp-<jnid>-<YYYY-MM>), the owner's catch-up link
// (supp-<jnid>-catchup-<from>-<to>) or an office by hand.
function invoiceSource(externalId) {
  const id = String(externalId || '');
  if (!id) return 'manual';
  if (/catchup/i.test(id)) return 'catchup';
  if (/^supp-/i.test(id)) return 'auto';
  return 'manual';
}

const denverDate = (secs) => (Number(secs) > 0
  ? new Date(Number(secs) * 1000).toLocaleDateString('en-CA', { timeZone: 'America/Denver' })
  : null);

// Billed month: the run's external_id names it; otherwise the invoice date.
function invoiceMonth(inv) {
  const m = /^supp-[^-]+-(\d{4}-\d{2})$/.exec(String(inv.external_id || ''));
  if (m) return m[1];
  const d = denverDate(inv.date_invoice);
  return d ? d.slice(0, 7) : null;
}

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v); return Number.isFinite(n) ? n : null;
}

// One JN invoice → the row the job page lists.
function publicInvoice(inv, pageUrl) {
  const status = num(inv.status);
  return {
    jnid: inv.jnid || inv.id || null,
    number: inv.number ?? null,
    status,
    status_name: inv.status_name || (status != null && INVOICE_STATUS[status]) || (status != null ? `Status ${status}` : null),
    date_invoice: denverDate(inv.date_invoice),
    total: num(inv.total),
    total_paid: num(inv.total_paid),
    due: num(inv.due),
    month: invoiceMonth(inv),
    source: invoiceSource(inv.external_id),
    external_id: inv.external_id || null,
    jn_url: pageUrl,
  };
}

// The job's storage invoices: active, carrying the storage catalog item or
// shaped like a supplemental one-liner (the run's own dedupe test).
function storageInvoices(invoices, monthlyPrice, helpers, pageUrl) {
  const price = Number(monthlyPrice) || 0;
  return (invoices || [])
    .filter((i) => i && i.is_active !== false)
    .filter((i) => helpers.suppItemHasStorage(i.items) || helpers.suppLooksLikeSupplemental(i, price))
    .map((i) => publicInvoice(i, pageUrl))
    .sort((a, b) => String(b.date_invoice || '').localeCompare(String(a.date_invoice || '')));
}

// What the recent runs did with this job. The worker's report lists
// created[] (dryrun: true on a preview), skipped[] with a reason and errors[]
// with an error, each keyed by the job's jnid. Reminder runs have none.
function runOutcomes(runs, jnid) {
  const out = [];
  for (const run of runs || []) {
    const rep = run && run.report;
    if (!rep || typeof rep !== 'object') continue;
    const hit = (list) => (Array.isArray(list) ? list.find((x) => x && String(x.jnid) === String(jnid)) : null);
    const created = hit(rep.created);
    if (created) {
      out.push({ month: run.month, mode: run.mode, outcome: 'created',
        reason: created.dryrun ? 'Dry run — would be created' : created.placeholder ? '$0 placeholder draft' : 'Draft created' });
      continue;
    }
    const skipped = hit(rep.skipped);
    if (skipped) { out.push({ month: run.month, mode: run.mode, outcome: 'skipped', reason: skipped.reason || 'Skipped' }); continue; }
    const err = hit(rep.errors);
    if (err) out.push({ month: run.month, mode: run.mode, outcome: 'error', reason: err.error || 'Error' });
  }
  return out;
}

// PUT body → { jn: { cf_… }, local: { … } } or { error }.
function parsePut(body) {
  const b = body && typeof body === 'object' ? body : {};
  const jn = {}, local = {};
  let any = false;
  if (b.in_storage !== undefined) {
    if (typeof b.in_storage !== 'boolean') return { error: 'in_storage must be true or false' };
    jn.cf_boolean_1 = b.in_storage; local.in_storage = b.in_storage; any = true;
  }
  if (b.vaults !== undefined) {
    if (b.vaults !== null && (typeof b.vaults !== 'number' || !Number.isInteger(b.vaults) || b.vaults < 0)) return { error: 'vaults must be a whole number or null' };
    jn.cf_long_1 = b.vaults === null ? 0 : b.vaults; local.storage_vaults = b.vaults; any = true;
  }
  if (b.monthly_price !== undefined) {
    if (b.monthly_price !== null && (typeof b.monthly_price !== 'number' || !Number.isFinite(b.monthly_price) || b.monthly_price < 0)) return { error: 'monthly_price must be a number or null' };
    const p = b.monthly_price === null ? null : Math.round(b.monthly_price * 100) / 100;
    jn.cf_double_1 = p === null ? 0 : p; local.storage_monthly_price = p; any = true;
  }
  if (!any) return { error: 'Nothing to change: send in_storage, vaults or monthly_price' };
  return { jn, local };
}

module.exports = function mountStorage(app, deps) {
  const {
    sbGet, sbPatch, jnSendJson, jnGetJobFull, jnAddNote, requireAuth, loadActor,
    suppEligibility, suppLooksLikeSupplemental, suppItemHasStorage, denverNextFirst,
    config = {}, jnInvoicesUrl, jobInvoicesPageUrl,
  } = deps;
  const enc = encodeURIComponent;
  const log = (...a) => console.log('[storage]', ...a);
  const helpers = { suppLooksLikeSupplemental, suppItemHasStorage };
  const pageUrl = (jnid) => (jobInvoicesPageUrl ? jobInvoicesPageUrl(jnid) : `https://app.jobnimbus.com/job/${jnid}/payments-and-invoices`);
  const JOB_SELECT = 'id,jn_id,name,number,record_type,status,location_id,locations(jn_location_id,jn_note_tag)';

  async function loadJob(id) {
    const rows = await sbGet(`jobs?id=eq.${enc(id)}&select=${JOB_SELECT}`);
    return rows && rows[0] ? rows[0] : null;
  }
  async function context(req, res) {
    const id = String(req.params.id || '');
    if (!uuidRe.test(id)) { res.status(400).json({ error: 'Bad job id' }); return null; }
    const actor = await loadActor(req);
    if (!actor) { res.status(403).json({ error: 'Profile not found' }); return null; }
    const job = await loadJob(id);
    if (!job) { res.status(404).json({ error: 'Job not found' }); return null; }
    if (!SEES_ALL.has(actor.role) && !(Array.isArray(actor.locs) && actor.locs.includes(String(job.location_id)))) {
      res.status(403).json({ error: 'Not your location' }); return null;
    }
    return { actor, job, canEdit: WRITE_ROLES.has(actor.role) };
  }

  function billing() {
    const live = config.SUPP_BILLING_LIVE === true;
    const day = Math.max(1, Math.min(28, Number(config.SUPP_BILLING_DAY) || 1));
    let nextRun = null;
    try { const n = denverNextFirst(); nextRun = `${n.monthKey}-${String(day).padStart(2, '0')}`; } catch { nextRun = null; }
    return { mode: live ? 'live' : 'dryrun', next_run: nextRun, day };
  }

  // The whole GET shape for a job, from a fresh JobNimbus record (or none).
  async function snapshot(job, fresh, canEdit) {
    const fields = fresh ? storageFields(fresh) : {};
    const inStorage = fields.in_storage === undefined ? null : fields.in_storage;
    const vaults = fields.vaults === undefined ? null : fields.vaults;
    const price = fields.monthly_price === undefined ? null : fields.monthly_price;
    const eligibility = fresh
      ? suppEligibility(fresh)
      : { eligible: false, placeholder: false, reasons: ['Not in JobNimbus'] };

    let invoices = [];
    if (job.jn_id) {
      try {
        const r = await jnSendJson('GET', jnInvoicesUrl(job.jn_id));
        if (r.ok) invoices = storageInvoices((r.body && r.body.results) || [], price, helpers, pageUrl(job.jn_id));
        else log('invoice lookup failed', job.jn_id, r.status);
      } catch (e) { log('invoice lookup error', job.jn_id, e.message); }
    }
    let runs = [];
    if (job.jn_id) {
      try {
        const rows = await sbGet('supplemental_billing_runs?select=month,mode,report&order=started_at.desc&limit=12');
        runs = runOutcomes(rows || [], job.jn_id);
      } catch (e) { log('run lookup error', e.message); }
    }
    const lastStorage = invoices.reduce((m, i) => (i.date_invoice && i.date_invoice > m ? i.date_invoice : m), '');
    return {
      record_type: (fresh && fresh.record_type_name) || job.record_type || null,
      status: (fresh && fresh.status_name) || job.status || null,
      in_storage: inStorage,
      vaults,
      monthly_price: price,
      eligibility,
      billing: billing(),
      invoices,
      last_storage_invoice: lastStorage || null,
      runs,
      can_edit: !!canEdit,
    };
  }

  async function freshJob(jnid) {
    if (!jnid) return null;
    try { return await jnGetJobFull(jnid); } catch (e) { log('JN read failed', jnid, e.message); return null; }
  }

  app.get('/jobs/:id/storage', requireAuth, async (req, res) => {
    try {
      const ctx = await context(req, res);
      if (!ctx) return;
      const fresh = await freshJob(ctx.job.jn_id);
      res.json(await snapshot(ctx.job, fresh, ctx.canEdit));
    } catch (err) { res.status(err.status || 502).json({ error: err.message }); }
  });

  app.put('/jobs/:id/storage', requireAuth, async (req, res) => {
    try {
      const ctx = await context(req, res);
      if (!ctx) return;
      const { actor, job, canEdit } = ctx;
      if (!canEdit) return res.status(403).json({ error: 'Only owners and admins can change storage billing' });
      const parsed = parsePut(req.body);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      if (!job.jn_id) return res.status(400).json({ error: 'This job is not in JobNimbus' });

      // Before: so the note fires only when the flag really flips.
      let before = null;
      try { before = await jnGetJobFull(job.jn_id); } catch (e) { log('pre-read failed', job.jn_id, e.message); }
      const wasOn = before ? storageFields(before).in_storage === true : null;

      const r = await jnSendJson('PUT', `jobs/${enc(job.jn_id)}`, {
        record_type_name: (before && before.record_type_name) || job.record_type || 'Contents',
        ...parsed.jn,
      });
      if (!r.ok) {
        log('JN write failed', job.jn_id, r.status, r.text);
        return res.status(502).json({ error: `JobNimbus refused the change (${r.status})` });
      }
      const fresh = await freshJob(job.jn_id);
      if (!fresh) return res.status(502).json({ error: 'JobNimbus did not answer after the change — check the job in JobNimbus' });
      const after = storageFields(fresh);
      if (parsed.jn.cf_boolean_1 !== undefined && after.in_storage !== parsed.jn.cf_boolean_1) {
        log('JN did not take the flag', job.jn_id, 'wanted', parsed.jn.cf_boolean_1, 'has', after.in_storage);
        return res.status(502).json({ error: 'JobNimbus did not accept the change — check the job in JobNimbus' });
      }

      // Local mirror from the read-back (what JN now holds, not what was asked).
      const patch = { last_synced: new Date().toISOString() };
      if (after.in_storage !== undefined) patch.in_storage = after.in_storage;
      if (after.vaults !== undefined) patch.storage_vaults = after.vaults;
      if (after.monthly_price !== undefined) patch.storage_monthly_price = after.monthly_price;
      try {
        await sbPatch('jobs', `id=eq.${enc(job.id)}`, patch);
      } catch (e) {
        if (/in_storage|storage_vaults|storage_monthly_price/.test(e.message)) {
          log('local patch failed — storage columns missing?', e.message);
          return res.status(500).json({ error: 'JobNimbus was updated but the DryOps jobs table has no storage columns yet — run supabase/add_job_storage.sql' });
        }
        throw e;
      }

      let noteOk = null;
      const isOn = after.in_storage === true;
      if (parsed.jn.cf_boolean_1 !== undefined && wasOn !== null && wasOn !== isOn) {
        const loc = job.locations || {};
        const note = await jnAddNote(job.jn_id, `In Storage turned ${isOn ? 'on' : 'off'} by ${actor.name} — DryOps`, {
          createdBy: actor.jn_user_id || undefined,
          tag: loc.jn_note_tag,
          jnLocationId: loc.jn_location_id,
        });
        noteOk = !!(note && note.ok);
        if (!noteOk) log('note failed', job.jn_id, note && note.error);
      }
      log(`${actor.name} set storage on ${job.number || job.id}:`, JSON.stringify(parsed.local));
      const body = await snapshot(job, fresh, canEdit);
      if (noteOk !== null) body.note_ok = noteOk;
      res.json(body);
    } catch (err) { res.status(err.status || 502).json({ error: err.message }); }
  });

  return { storageCols };
};

module.exports.storageCols = storageCols;
module.exports.invoiceSource = invoiceSource;
module.exports.invoiceMonth = invoiceMonth;
module.exports.runOutcomes = runOutcomes;
module.exports.parsePut = parsePut;
module.exports.storageInvoices = storageInvoices;
