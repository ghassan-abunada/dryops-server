'use strict';
// ── Job record type (the job page's "Job type" row) ──────────────────────────
// A job created as the wrong type (a Contents lead that is really Mitigation,
// a Testing job that should be Abatements…) is re-typed in JobNimbus FIRST and
// only then on the local row, like the sales rep (salesRep.js). Admins and
// owners only. JobNimbus keeps one status workflow per record type, so the
// status has to move with the type: keep it when the target workflow lists
// it, else land in the same stage bucket (the app's job_stage(): Lead /
// Estimating / In Production / Account Receivable / Completed / Lost), else
// ask the caller to pick (409 needs_status).
//
//   GET  /jobs/:id/record-type → { current, can_change, options[] }
//   POST /jobs/:id/record-type { record_type, status? } → { ok, job }
//
// The per-workflow status lists come from JN account/settings when that
// payload carries them (intake.jnAccountSettings → workflows[].statuses);
// STATUS_WORKFLOWS below is the fallback, copied from the live workflows.
// remapStatus / statusBucket are pure and covered by test/recordType.test.js.

const { uuidRe } = require('./noteReader');

const RECORD_TYPES = ['Mitigation', 'Contents', 'Rebuild', 'Testing', 'Abatements'];
const WRITE_ROLES = new Set(['admin', 'owner']);

const WATER_STATUSES = [
  'Lead', 'Initial Inspection', 'Customer Requested Hold',
  'Estimate Needed', 'Pending Approval',
  'Scheduled', 'Pending Results', 'Pending Abatement', 'In Progress',
  'Work Complete',
  'Invoice Created', 'Invoiced', 'Pending Payment',
  'Paid & Closed', 'Attorney',
  'Non-Opportunity', 'Not Sold',
];
const TESTING_STATUSES = [
  'Lead', 'Initial Inspection',
  'Estimate Needed', 'Estimate Submitted',
  'Customer Requested Hold',
  'Scheduled', 'In Progress', 'Pending Results', 'Missing WO/Claim info',
  'Invoiced', 'Pending Payment',
  'Paid & Closed', 'Paid to Lead Source',
  'Denied Per Insurance', 'Attorney',
  'Non-Opportunity', 'Not Sold',
];
const STATUS_WORKFLOWS = {
  Mitigation: WATER_STATUSES, Contents: WATER_STATUSES, Rebuild: WATER_STATUSES,
  Testing: TESTING_STATUSES, Abatements: TESTING_STATUSES,
};

// Stage buckets — the app's public.job_stage() (supabase/add_job_stage.sql),
// restricted to the statuses the five workflows use.
const STAGE_OF = {
  'Lead': 'Lead', 'Initial Inspection': 'Lead', 'Customer Requested Hold': 'Lead', 'Missing WO/Claim info': 'Lead',
  'Estimate Needed': 'Estimating', 'Estimate Submitted': 'Estimating', 'Pending Approval': 'Estimating',
  'Scheduled': 'In Production', 'Pending Results': 'In Production', 'Pending Abatement': 'In Production',
  'In Progress': 'In Production', 'Work Complete': 'In Production',
  'Invoice Created': 'Account Receivable', 'Invoiced': 'Account Receivable', 'Pending Payment': 'Account Receivable',
  'Attorney': 'Account Receivable',
  'Paid & Closed': 'Completed', 'Paid to Lead Source': 'Completed',
  'Non-Opportunity': 'Lost', 'Not Sold': 'Lost', 'Denied Per Insurance': 'Lost',
};
const norm = (s) => String(s || '').trim().toLowerCase();
function statusBucket(status) {
  const n = norm(status);
  for (const [k, v] of Object.entries(STAGE_OF)) if (norm(k) === n) return v;
  return null;
}

// The status a job in `status` (of workflow `fromType`) should carry once it is
// a `toType` job: { status, how: 'kept' | 'bucket' } or null when nobody can say
// (the caller then asks the user). `workflows` = { type: string[] } overrides
// the built-in lists (the live JN account settings).
function remapStatus(status, fromType, toType, workflows) {
  const lists = { ...STATUS_WORKFLOWS, ...(workflows || {}) };
  const target = Array.isArray(lists[toType]) && lists[toType].length ? lists[toType] : null;
  if (!target) return null;
  const cur = String(status || '').trim();
  if (!cur) return null;
  const kept = target.find((s) => norm(s) === norm(cur));
  if (kept) return { status: kept, how: 'kept' };
  const bucket = statusBucket(cur);
  if (!bucket) return null;
  const first = target.find((s) => statusBucket(s) === bucket);
  return first ? { status: first, how: 'bucket' } : null;
}

// intake.jnAccountSettings workflows → { type: string[] } for the job
// workflows that carry statuses; {} when the payload has none.
function workflowsFromSettings(settings) {
  const out = {};
  for (const w of (settings && Array.isArray(settings.workflows) ? settings.workflows : [])) {
    if (!w || w.active === false || (w.object_type && w.object_type !== 'job')) continue;
    const list = Array.isArray(w.statuses) ? w.statuses.map((s) => String(s || '').trim()).filter(Boolean) : [];
    if (list.length && RECORD_TYPES.includes(w.name)) out[w.name] = list;
  }
  return out;
}

module.exports = function mountRecordType(app, deps) {
  const { sbGet, sbPatch, jnSendJson, jnGetJobFull, jnAddNote, requireAuth, loadActor, jnAccountSettings } = deps;
  const enc = encodeURIComponent;
  const log = (...a) => console.log('[record-type]', ...a);
  let loggedShape = false;

  async function liveWorkflows() {
    if (!jnAccountSettings) return {};
    try {
      const s = await jnAccountSettings();
      const wf = workflowsFromSettings(s);
      if (!loggedShape) {
        loggedShape = true;
        const names = Object.keys(wf);
        log(names.length ? `JN account settings carry statuses for ${names.join(', ')}` : 'JN account settings carry no per-workflow statuses; using the built-in lists');
      }
      return wf;
    } catch (e) { console.warn('[record-type] account settings failed', e.message); return {}; }
  }
  const JOB_SELECT = 'id,jn_id,name,number,record_type,status,location_id,locations(id,name,record_types,jn_location_id,jn_note_tag)';
  async function loadJob(id) {
    const rows = await sbGet(`jobs?id=eq.${enc(id)}&select=${JOB_SELECT}`);
    return rows && rows[0] ? rows[0] : null;
  }
  const enabledAt = (loc) => ((loc && Array.isArray(loc.record_types) && loc.record_types.length) ? loc.record_types : ['Mitigation']);

  async function context(req, res) {
    const id = String(req.params.id || '');
    if (!uuidRe.test(id)) { res.status(400).json({ error: 'Bad job id' }); return null; }
    const actor = await loadActor(req);
    if (!actor) { res.status(403).json({ error: 'Profile not found' }); return null; }
    const job = await loadJob(id);
    if (!job) { res.status(404).json({ error: 'Job not found' }); return null; }
    const seesAll = ['admin', 'owner', 'executive'].includes(actor.role);
    if (!seesAll && !actor.locs.includes(String(job.location_id))) { res.status(403).json({ error: 'Not your location' }); return null; }
    const loc = Array.isArray(job.locations) ? job.locations[0] : job.locations;
    return { actor, job, loc: loc || null, can: WRITE_ROLES.has(actor.role) };
  }
  function optionsFor(job, loc, workflows) {
    const lists = { ...STATUS_WORKFLOWS, ...workflows };
    const enabled = enabledAt(loc);
    return RECORD_TYPES.map((t) => {
      const sug = t === job.record_type ? { status: job.status } : remapStatus(job.status, job.record_type, t, workflows);
      return { record_type: t, enabled_at_location: enabled.includes(t), statuses: lists[t] || [], suggested_status: sug ? sug.status : null };
    });
  }

  app.get('/jobs/:id/record-type', requireAuth, async (req, res) => {
    try {
      const ctx = await context(req, res);
      if (!ctx) return;
      const { job, loc, can } = ctx;
      const workflows = await liveWorkflows();
      res.json({
        current: { record_type: job.record_type || null, status: job.status || null },
        can_change: can,
        options: optionsFor(job, loc, workflows),
      });
    } catch (err) { res.status(err.status || 502).json({ error: err.message }); }
  });

  app.post('/jobs/:id/record-type', requireAuth, async (req, res) => {
    try {
      const ctx = await context(req, res);
      if (!ctx) return;
      const { actor, job, loc, can } = ctx;
      if (!can) return res.status(403).json({ error: 'Only owners and admins can change a job\'s type' });
      const target = String((req.body && req.body.record_type) || '').trim();
      if (!RECORD_TYPES.includes(target)) return res.status(400).json({ error: 'record_type must be Mitigation, Contents, Rebuild, Testing or Abatements' });
      const from = job.record_type || null;
      if (target === from) return res.status(400).json({ error: `This is already a ${target} job` });
      const any = actor.role === 'admin' && /^(1|true|yes)$/i.test(String(req.query.any || ''));
      if (!any && !enabledAt(loc).includes(target)) return res.status(400).json({ error: `${(loc && loc.name) || 'This location'} does not create ${target} jobs` });

      const workflows = await liveWorkflows();
      const targetList = (workflows[target] && workflows[target].length ? workflows[target] : STATUS_WORKFLOWS[target]) || [];
      let status = null; let how = null;
      const asked = req.body && req.body.status != null && String(req.body.status).trim();
      if (asked) {
        status = targetList.find((s) => norm(s) === norm(asked)) || null;
        if (!status) return res.status(400).json({ error: `${asked} is not a ${target} status`, options: targetList });
        how = 'picked';
      } else {
        const r = remapStatus(job.status, from, target, workflows);
        if (!r) return res.status(409).json({ needs_status: true, error: `Pick a ${target} status for this job`, options: targetList });
        status = r.status; how = r.how;
      }

      if (!job.jn_id) return res.status(400).json({ error: 'This job has no JobNimbus id' });
      // JobNimbus first: the type and the status move in one write.
      const w = await jnSendJson('PUT', `jobs/${enc(job.jn_id)}`, { record_type_name: target, status_name: status });
      if (!w.ok) {
        log('JN write failed', job.jn_id, w.status, w.text);
        return res.status(502).json({ error: `JobNimbus refused the change (${w.status})` });
      }
      let fresh = null;
      try { fresh = await jnGetJobFull(job.jn_id); } catch (e) { log('read-back failed', job.jn_id, e.message); }
      if (!fresh || fresh.record_type_name !== target) {
        log('JN did not take the type', job.jn_id, 'wanted', target, 'has', fresh && fresh.record_type_name);
        return res.status(502).json({ error: 'JobNimbus did not accept the change — check the job in JobNimbus' });
      }
      const finalStatus = (typeof fresh.status_name === 'string' && fresh.status_name.trim()) || status;

      const rows = await sbPatch('jobs', `id=eq.${enc(job.id)}`, { record_type: target, status: finalStatus, last_synced: new Date().toISOString() });
      const saved = rows && rows[0];
      const noteText = `Job type changed ${from || '—'} → ${target} by ${actor.name} (status ${job.status || '—'} → ${finalStatus})`;
      const note = await jnAddNote(job.jn_id, noteText, {
        createdBy: actor.jn_user_id || undefined,
        tag: loc && loc.jn_note_tag,
        jnLocationId: loc && loc.jn_location_id,
      });
      if (!note || !note.ok) log('note failed', job.jn_id, note && note.error);
      log(`${actor.name} re-typed ${job.number || job.id}: ${from || '—'} → ${target}, status ${job.status || '—'} → ${finalStatus} (${how})`);
      res.json({
        ok: true,
        job: { record_type: saved ? saved.record_type : target, status: saved ? saved.status : finalStatus },
        status_how: how,
        note_ok: !!(note && note.ok),
      });
    } catch (err) { res.status(err.status || 502).json({ error: err.message }); }
  });

  return { remapStatus };
};

module.exports.RECORD_TYPES = RECORD_TYPES;
module.exports.STATUS_WORKFLOWS = STATUS_WORKFLOWS;
module.exports.remapStatus = remapStatus;
module.exports.statusBucket = statusBucket;
module.exports.workflowsFromSettings = workflowsFromSettings;
