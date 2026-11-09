'use strict';
// ── Job sales rep (the job page's "Sales rep" row) ───────────────────────────
// Who may change a job's sales rep (owner 2026-11-09): admins and owners,
// expansion managers for jobs at their locations, the location's own sales
// reps (location_sales_reps) and anyone whose app role grants edit_job_fields
// at that location. The change goes to JobNimbus FIRST (jobs.sales_rep = the
// rep's JN user id) and only then to the local row, so the two never disagree.
// JN → DryOps comes back through the job webhook and the 30-minute reconcile:
// profileCol() turns JN's sales_rep user id into jobs.sales_rep_profile_id
// (profiles.jn_user_id), next to the display name jnJobFields already mirrors.
//
//   GET /jobs/:id/sales-rep  → { can_change, current, options[] }
//   PUT /jobs/:id/sales-rep  { profile_id: uuid | null } → { ok, job }
//
// Pure rules (canChangeSalesRep, profileIdFor, pickError) are covered by
// test/salesRep.test.js.

const { uuidRe } = require('./noteReader');

const WRITE_ROLES = new Set(['admin', 'owner']);

// actor = intake.loadActor() shape; job = { location_id }; repIds = profile ids
// listed in location_sales_reps for the job's location.
function canChangeSalesRep(actor, job, repIds) {
  if (!actor || !job) return false;
  if (WRITE_ROLES.has(actor.role)) return true;
  const loc = job.location_id ? String(job.location_id) : null;
  if (!loc || !Array.isArray(actor.locs) || !actor.locs.includes(loc)) return false;
  if (actor.role === 'expansion_manager') return true;
  if (actor.perms && actor.perms.edit_job_fields === true) return true;
  return (repIds || []).some((id) => String(id) === String(actor.id));
}

// JobNimbus's sales_rep is the rep's user id (a string; be tolerant of {id}).
function jnSalesRepId(job) {
  if (!job || job.sales_rep === undefined) return undefined;
  const v = job.sales_rep && typeof job.sales_rep === 'object' ? job.sales_rep.id : job.sales_rep;
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s || null;
}

// profiles with a JN link → the DryOps profile for JN's sales_rep user id.
// undefined when the payload carries no sales_rep key (leave the column alone),
// null when JN has no rep or one DryOps doesn't know.
function profileIdFor(job, byJnUser) {
  const jnId = jnSalesRepId(job);
  if (jnId === undefined) return undefined;
  if (jnId === null) return null;
  return (byJnUser && byJnUser.get(jnId)) || null;
}

// Why a pick is refused, or null when it's fine. rep = the profile row picked.
function pickError(rep, repIds, hasJnJob) {
  if (!rep) return 'That person is no longer a sales rep at this location';
  if (!(repIds || []).some((id) => String(id) === String(rep.id))) return 'That person is not a sales rep at this location';
  if (hasJnJob && !rep.jn_user_id) return `${rep.full_name || 'That rep'} isn't linked to a JobNimbus user yet — link them in Settings → Team first`;
  return null;
}

module.exports = function mountSalesRep(app, deps) {
  const { sbGet, sbPatch, jnSendJson, jnGetJobFull, requireAuth, loadActor, normalizeRepName } = deps;
  const enc = encodeURIComponent;
  const log = (...a) => console.log('[sales-rep]', ...a);

  // ── JN user id → profile id (webhook + reconcile) ─────────────────────────
  let linkCache = { at: 0, map: new Map() };
  async function linkedProfiles(force = false) {
    if (!force && Date.now() - linkCache.at < 10 * 60 * 1000) return linkCache.map;
    const rows = (await sbGet('profiles?select=id,jn_user_id&jn_user_id=not.is.null')) || [];
    const map = new Map();
    for (const p of rows) if (p.jn_user_id) map.set(String(p.jn_user_id).trim(), String(p.id));
    linkCache = { at: Date.now(), map };
    return map;
  }
  // Columns to merge into the mirrored row for a JobNimbus job payload.
  async function profileCol(job) {
    if (!job || job.sales_rep === undefined) return {};
    try {
      let id = profileIdFor(job, await linkedProfiles());
      // A rep linked since the cache filled: one refresh before giving up.
      if (id === null && jnSalesRepId(job)) id = profileIdFor(job, await linkedProfiles(true));
      return { sales_rep_profile_id: id };
    } catch (e) { console.warn('[sales-rep] profile resolve failed', e.message); return {}; }
  }

  // ── Per-job context ───────────────────────────────────────────────────────
  async function repsAt(locationId) {
    if (!locationId) return [];
    const rows = (await sbGet(`location_sales_reps?location_id=eq.${enc(String(locationId))}&select=profile_id,profiles(id,full_name,jn_user_id)`)) || [];
    return rows.map((r) => r.profiles).filter(Boolean)
      .map((p) => ({ id: String(p.id), full_name: p.full_name || null, jn_linked: !!p.jn_user_id, jn_user_id: p.jn_user_id || null }))
      .sort((a, b) => String(a.full_name || '').localeCompare(String(b.full_name || '')));
  }
  async function loadJob(id) {
    const rows = await sbGet(`jobs?id=eq.${enc(id)}&select=id,jn_id,name,number,record_type,location_id,sales_rep,sales_rep_profile_id`);
    return rows && rows[0] ? rows[0] : null;
  }
  async function context(req, res) {
    const id = String(req.params.id || '');
    if (!uuidRe.test(id)) { res.status(400).json({ error: 'Bad job id' }); return null; }
    const actor = await loadActor(req);
    if (!actor) { res.status(403).json({ error: 'Profile not found' }); return null; }
    const job = await loadJob(id);
    if (!job) { res.status(404).json({ error: 'Job not found' }); return null; }
    const seesAll = ['admin', 'owner', 'executive'].includes(actor.role);
    if (!seesAll && !actor.locs.includes(String(job.location_id))) { res.status(403).json({ error: 'Not your location' }); return null; }
    const reps = await repsAt(job.location_id);
    return { actor, job, reps, can: canChangeSalesRep(actor, job, reps.map((r) => r.id)) };
  }
  const publicRep = (r) => ({ id: r.id, full_name: r.full_name, jn_linked: r.jn_linked });

  app.get('/jobs/:id/sales-rep', requireAuth, async (req, res) => {
    try {
      const ctx = await context(req, res);
      if (!ctx) return;
      const { job, reps, can } = ctx;
      const options = reps.map(publicRep);
      // The current rep stays pickable even after leaving the location's list.
      if (job.sales_rep_profile_id && !options.some((o) => o.id === String(job.sales_rep_profile_id))) {
        const rows = await sbGet(`profiles?id=eq.${enc(String(job.sales_rep_profile_id))}&select=id,full_name,jn_user_id`);
        const p = rows && rows[0];
        if (p) options.unshift({ id: String(p.id), full_name: p.full_name || null, jn_linked: !!p.jn_user_id });
      }
      res.json({
        can_change: can,
        current: { profile_id: job.sales_rep_profile_id || null, name: job.sales_rep || null },
        options,
      });
    } catch (err) { res.status(err.status || 502).json({ error: err.message }); }
  });

  app.put('/jobs/:id/sales-rep', requireAuth, async (req, res) => {
    try {
      const ctx = await context(req, res);
      if (!ctx) return;
      const { actor, job, reps, can } = ctx;
      if (!can) return res.status(403).json({ error: 'Only owners, admins, expansion managers and the location\'s sales reps can change the sales rep' });
      const raw = req.body && req.body.profile_id;
      const profileId = raw === null || raw === undefined || raw === '' ? null : String(raw);
      if (profileId && !uuidRe.test(profileId)) return res.status(400).json({ error: 'Bad profile id' });
      const rep = profileId ? reps.find((r) => r.id === profileId) || null : null;
      if (profileId) {
        const why = pickError(rep, reps.map((r) => r.id), !!job.jn_id);
        if (why) return res.status(400).json({ error: why });
      }

      // JobNimbus first. Its answer carries the canonical display name.
      let name = rep ? rep.full_name : null;
      if (job.jn_id) {
        const r = await jnSendJson('PUT', `jobs/${enc(job.jn_id)}`, {
          record_type_name: job.record_type || 'Mitigation',
          sales_rep: rep ? rep.jn_user_id : null,
        });
        if (!r.ok) {
          log('JN write failed', job.jn_id, r.status, r.text);
          return res.status(502).json({ error: `JobNimbus refused the change (${r.status})` });
        }
        try {
          const fresh = await jnGetJobFull(job.jn_id);
          const jnRep = jnSalesRepId(fresh);
          const want = rep ? String(rep.jn_user_id) : null;
          if ((jnRep || null) !== want) {
            log('JN did not take the rep', job.jn_id, 'wanted', want, 'has', jnRep);
            return res.status(502).json({ error: 'JobNimbus did not accept the change — check the job in JobNimbus' });
          }
          if (rep && typeof fresh.sales_rep_name === 'string' && fresh.sales_rep_name.trim()) name = normalizeRepName(fresh.sales_rep_name.trim());
        } catch (e) { log('read-back failed', job.jn_id, e.message); }
      }

      const rows = await sbPatch('jobs', `id=eq.${enc(job.id)}`, {
        sales_rep: name || null,
        sales_rep_profile_id: rep ? rep.id : null,
        last_synced: new Date().toISOString(),
      });
      const saved = rows && rows[0];
      log(`${actor.name} set the rep on ${job.number || job.id} → ${name || 'none'}`);
      res.json({ ok: true, job: { sales_rep: saved ? saved.sales_rep : name || null, sales_rep_profile_id: saved ? saved.sales_rep_profile_id : rep ? rep.id : null } });
    } catch (err) { res.status(err.status || 502).json({ error: err.message }); }
  });

  return { profileCol, canChangeSalesRep };
};

module.exports.canChangeSalesRep = canChangeSalesRep;
module.exports.profileIdFor = profileIdFor;
module.exports.jnSalesRepId = jnSalesRepId;
module.exports.pickError = pickError;
