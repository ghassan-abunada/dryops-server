'use strict';
// ── JobNimbus job sync (pull side) ───────────────────────────────────────────
// Jobs used to reach Supabase only through the JobNimbus webhook. Custom-field
// edits (claim number, carrier, adjuster, tested…) do not always arrive that
// way, so a job could sit stale for days (owner 2026-10-27: claim + carrier
// present in JN, "missing" in WYH). Two fixes:
//   * reconcileJobs(): every JOB_RECONCILE_MINUTES pull /jobs updated since the
//     last pass and PATCH the mirrored fields (jnJobFields, the same mapping
//     the webhook uses) onto rows we already hold. Never inserts.
//   * refreshJob(id | jnId): one GET /jobs/:jnid → PATCH, used by
//     POST /jobs/:id/refresh (the panel's "Refresh from JobNimbus") and by the
//     WYH AI reviewer before it reads a job.
const { uuidRe } = require('./noteReader');

module.exports = function mountJobSync(app, deps) {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, jnGetJobFull, jnFetchUpdatedSince, jnJobFields, sbSelect, requireAuth, loadActor } = deps;
  const RECONCILE_MINUTES = Math.max(5, Number(process.env.JOB_RECONCILE_MINUTES) || 30);
  const DISABLED = /^(1|true|yes|on)$/i.test(String(process.env.JOB_RECONCILE_DISABLED || ''));
  const sbHeaders = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  const warn = (...a) => console.warn('[job-sync]', ...a);

  // Patch the mirrored fields onto the row we hold for this jn_id (no-op when
  // the job is not mirrored, e.g. a deprecated record type).
  async function patchFromJn(job) {
    const jnid = job && (job.jnid || job.id);
    if (!jnid) return null;
    const row = { ...jnJobFields(job), last_synced: new Date().toISOString() };
    // Ordering guard: a reconcile pass reads JobNimbus once and patches for a
    // while; a webhook landing in between carries newer data. Only write when
    // JobNimbus's own stamp on this record is not older than the one we hold.
    const stamp = row.jn_updated ? `&or=(jn_updated.is.null,jn_updated.lte.${encodeURIComponent(row.jn_updated)})` : '';
    const select = 'id,jn_id,number,name,status,insurer,claim_number,adjuster_name,insurance_type,tested,date_loss,cat,lead_type,sales_rep,jn_updated,last_synced';
    const r = await fetch(`${SUPABASE_URL}/rest/v1/jobs?jn_id=eq.${encodeURIComponent(String(jnid))}${stamp}&select=${select}`, {
      method: 'PATCH', headers: sbHeaders, body: JSON.stringify(row),
    });
    if (!r.ok) throw new Error(`jobs patch ${r.status} ${(await r.text()).slice(0, 200)}`);
    const rows = await r.json().catch(() => []);
    if (Array.isArray(rows) && rows[0]) return rows[0];
    // Nothing matched: not mirrored, or we already hold something newer — return what we hold.
    const [held] = await sbSelect('jobs', `select=${select}&jn_id=eq.${encodeURIComponent(String(jnid))}`);
    return held || null;
  }

  async function refreshJobByJnId(jnId) {
    const job = await jnGetJobFull(jnId);
    return patchFromJn(job);
  }
  async function refreshJob(jobId) {
    const [j] = await sbSelect('jobs', `select=id,jn_id,location_id&id=eq.${encodeURIComponent(jobId)}`);
    if (!j) { const e = new Error('job not found'); e.status = 404; throw e; }
    if (!j.jn_id) { const e = new Error('job has no JobNimbus id'); e.status = 400; throw e; }
    return refreshJobByJnId(j.jn_id);
  }

  // ── Reconcile: jobs JobNimbus says changed since the last pass ────────────
  let cursorSecs = Math.floor(Date.now() / 1000) - 2 * RECONCILE_MINUTES * 60;
  let running = false; let last = null;
  async function reconcileJobs() {
    if (running) return last;
    running = true;
    const startedSecs = Math.floor(Date.now() / 1000);
    const stats = { since: new Date(cursorSecs * 1000).toISOString(), fetched: 0, patched: 0, skipped: 0, errors: 0 };
    try {
      const jobs = await jnFetchUpdatedSince('/jobs', cursorSecs - 120); // 2-min overlap
      stats.fetched = jobs.length;
      for (const job of jobs) {
        try {
          const row = await patchFromJn(job);
          if (row) stats.patched++; else stats.skipped++;
        } catch (e) { stats.errors++; if (stats.errors <= 3) warn('patch failed', job && (job.jnid || job.id), e.message); }
      }
      cursorSecs = startedSecs;
      if (stats.patched || stats.errors) console.log('[job-sync]', `reconcile: ${stats.fetched} changed in JN, ${stats.patched} patched, ${stats.skipped} not mirrored, ${stats.errors} errors`);
    } catch (e) {
      stats.errors++; warn('reconcile failed', e.message);
    } finally { running = false; last = { ...stats, finished_at: new Date().toISOString() }; }
    return last;
  }
  if (!DISABLED) {
    setTimeout(reconcileJobs, 3 * 60 * 1000);
    setInterval(reconcileJobs, RECONCILE_MINUTES * 60 * 1000);
    console.log(`[job-sync] reconcile every ${RECONCILE_MINUTES} min`);
  }

  // ── Endpoints ─────────────────────────────────────────────────────────────
  // One job, on demand (admins / owners anywhere, managers inside their locations).
  app.post('/jobs/:id/refresh', requireAuth, async (req, res) => {
    const id = String(req.params.id || '');
    if (!uuidRe.test(id)) return res.status(400).json({ error: 'Bad job id' });
    try {
      const actor = await loadActor(req);
      if (!actor) return res.status(403).json({ error: 'Profile not found' });
      const [j] = await sbSelect('jobs', `select=id,jn_id,location_id&id=eq.${encodeURIComponent(id)}`);
      if (!j) return res.status(404).json({ error: 'Job not found' });
      const seesAll = ['admin', 'owner', 'executive'].includes(actor.role);
      if (!seesAll && !actor.locs.includes(String(j.location_id))) return res.status(403).json({ error: 'Not your location' });
      if (!j.jn_id) return res.status(400).json({ error: 'This job has no JobNimbus id' });
      const row = await refreshJobByJnId(j.jn_id);
      res.json({ ok: !!row, job: row });
    } catch (err) { res.status(err.status || 502).json({ error: err.message }); }
  });
  app.post('/admin/jobs/reconcile', requireAuth, deps.requireAdmin, async (req, res) => {
    try { res.json(await reconcileJobs()); } catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.get('/admin/jobs/reconcile', requireAuth, deps.requireAdmin, (req, res) => res.json({ running, last, every_minutes: RECONCILE_MINUTES, disabled: DISABLED }));

  return { refreshJob, refreshJobByJnId, reconcileJobs };
};
