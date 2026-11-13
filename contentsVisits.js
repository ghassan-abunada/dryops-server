'use strict';
// ── Contents (packout) visit reports (owner 2026-11-13) ──────────────────────
// Three Contents visits end with a short report: the initial walk, the
// pack-out and the pack-back. Submitting the report COMPLETES the visit (one
// step for the technician) and writes what it learned onto the job:
//
//   initial_walk → jobs.contents_service, the carrier / claim / adjuster (also
//                  to JobNimbus), the rooms, and the pack-out (or content
//                  manipulation) visit on the schedule when a date was picked
//   pack_out     → In Storage, # of Vaults and where the belongings are (also
//                  to JobNimbus), and the warehouse vaults marked in use
//   pack_back    → the job's vaults emptied; In Storage off when everything
//                  came back
//
//   POST /visits/:id/contents-report       { report }          (signed in)
//   POST /tech/visits/:id/contents-report  { token, report }   (tech link)
//   → { ok, visit, summary, warnings, scheduled? }
//
// The report shapes, validation and JobNimbus summary live in the DryOps app
// (lib/contentsReport.ts) and are compiled into vendor/contents by its
// scripts/vendor-contents.sh; test/fixtures/contentsReport.json pins both.
//
// Kept apart from server.js's REPORT_KINDS on purpose: those add their column
// to every visit read, and inspections.contents_report does not exist until
// DryOps supabase/add_contents_visits.sql has run. Nothing here is on the path
// of a mitigation or testing visit.

const CR = require('./vendor/contents/contentsReport');
const { storageInfoLine } = require('./vendor/contents/contents');

const KIND_LABEL = { initial_walk: 'Initial Walk', pack_out: 'Pack Out', pack_back: 'Pack Back' };
const MIGRATION_HINT = 'Contents visit reports are not set up in the database yet (run DryOps supabase/add_contents_visits.sql).';
const MANAGER_ROLES = new Set(['admin', 'owner', 'expansion_manager']);
// JobNimbus has a "Storage unit info" custom field on Contents jobs; its key
// differs per account, so it is set by env (e.g. cf_string_21). Unset = the
// line stays in DryOps and on the visit's note.
const STORAGE_INFO_FIELD = String(process.env.CONTENTS_STORAGE_INFO_FIELD || '').trim();

const clean = (v, max = 400) => (v === undefined || v === null ? '' : String(v)).trim().slice(0, max);
const isMissingColumn = (msg) => /contents_report|PGRST204|42703|schema cache/i.test(String(msg || ''));

/** "8am–10am" for a window in minutes, '' without one (matches the app's label). */
function windowLabel(startMin, endMin) {
  return startMin === null || endMin === null ? null : `${CR.clock(startMin)}–${CR.clock(endMin)}`;
}

/** The job fields an initial walk fills in: only what the walk answered and the job does not already say. */
function walkJobPatch(report, job) {
  const local = {};
  const jn = {};
  const set = (col, jnKey, value) => {
    const v = clean(value);
    if (!v || v === clean(job[col])) return;
    local[col] = v; jn[jnKey] = v;
  };
  if (report.service && report.service !== job.contents_service) local.contents_service = report.service;
  if (!report.insurance.not_insurance) {
    set('insurer', 'cf_string_9', report.insurance.carrier);
    set('claim_number', 'cf_string_2', report.insurance.claim_number);
    set('adjuster_name', 'cf_string_3', report.insurance.adjuster_name);
    set('adjuster_phone', 'cf_string_4', report.insurance.adjuster_phone);
    set('adjuster_email', 'cf_string_5', report.insurance.adjuster_email);
    if (!clean(job.insurance_type)) { local.insurance_type = 'Insurance'; jn.cf_string_7 = 'Insurance'; }
  } else if (!clean(job.insurance_type)) { local.insurance_type = 'Non-Insurance'; jn.cf_string_7 = 'Non-Insurance'; }
  return { local, jn };
}

/** The job fields a pack-out sets. */
function packOutJobPatch(report) {
  const info = report.destination ? storageInfoLine(report.destination) : '';
  const local = { in_storage: true };
  const jn = { cf_boolean_1: true };
  if (report.vault_count !== null) { local.storage_vaults = report.vault_count; jn.cf_long_1 = report.vault_count; }
  if (info) { local.storage_unit_info = info; if (STORAGE_INFO_FIELD) jn[STORAGE_INFO_FIELD] = info; }
  return { local, jn };
}

module.exports = function mountContentsVisits(app, deps) {
  const { requireAuth, appActor, techGuard, loadVisit, isAssigned, sbGet, sbPatch, sbInsert, jnSendJson, jnAddNote, visitNoteContext, syncVisitJnTask } = deps;
  const warn = deps.warn || ((...a) => console.warn('[contents visits]', ...a));
  const enc = encodeURIComponent;
  const safe = async (p) => { try { const r = await p; return Array.isArray(r) ? r : []; } catch { return []; } };

  /** Write job fields here and to JobNimbus; failures become warnings, never a failed report. */
  async function writeJob(job, patch, warnings) {
    if (Object.keys(patch.local).length) {
      try { await sbPatch('jobs', `id=eq.${enc(job.id)}`, patch.local); }
      catch (e) {
        // jobs.contents_service / storage_unit_info come from add_contents_vertical.sql: retry without them.
        const { contents_service, storage_unit_info, ...rest } = patch.local; // eslint-disable-line no-unused-vars
        warn('job patch', e.message);
        warnings.push('JOB_FIELDS_PARTIAL');
        if (Object.keys(rest).length) await sbPatch('jobs', `id=eq.${enc(job.id)}`, rest).catch((e2) => { warn('job patch retry', e2.message); warnings.push('JOB_FIELDS_FAILED'); });
      }
    }
    if (job.jn_id && Object.keys(patch.jn).length) {
      const r = await jnSendJson('PUT', `jobs/${enc(job.jn_id)}`, { record_type_name: job.record_type || 'Contents', ...patch.jn }).catch((e) => ({ ok: false, text: e.message }));
      if (!r.ok) { warn('jn job put', r.status, r.text); warnings.push('JN_FIELDS_FAILED'); }
    }
  }

  async function applyInitialWalk({ visit, job, report, actor, warnings }) {
    await writeJob(job, walkJobPatch(report, job), warnings);
    // Rooms: names only, and only on a job that has none yet.
    try {
      const existing = await sbGet(`rooms?job_id=eq.${enc(job.id)}&select=id&limit=1`);
      if (Array.isArray(existing) && existing.length === 0) {
        for (const [i, r] of report.rooms.entries()) await sbInsert('rooms', { job_id: job.id, name: r.name, sort_order: i });
      }
    } catch (e) { warn('rooms', e.message); warnings.push('ROOMS_FAILED'); }
    // The pack-out (or manipulation) goes on the schedule with the same people.
    if (report.packout.scheduled !== true || !report.packout.date) return null;
    const taskType = report.service === 'manipulation' ? 'content_manipulation' : 'pack_out';
    const dup = await safe(sbGet(`inspections?job_id=eq.${enc(job.id)}&task_type=eq.${taskType}&scheduled_date=eq.${enc(report.packout.date)}&status=neq.cancelled&select=id&limit=1`));
    if (dup[0]) return { id: dup[0].id, task_type: taskType, date: report.packout.date, existing: true };
    const label = windowLabel(report.packout.start_min, report.packout.end_min);
    try {
      await sbInsert('inspections', {
        job_id: job.id, jn_id: job.jn_id || null, scheduled_date: report.packout.date,
        slot_start_min: report.packout.start_min, slot_end_min: report.packout.end_min, scheduled_time: label,
        task_type: taskType, status: 'scheduled', assigned_to_ids: visit.assigned_to_ids || [],
        notes: null, location_id: visit.location_id || job.location_id || null, created_by: actor.id || null,
        block_kind: 'window', crew_size: null, jn_task_dirty: true,
      });
      const back = await safe(sbGet(`inspections?job_id=eq.${enc(job.id)}&task_type=eq.${taskType}&scheduled_date=eq.${enc(report.packout.date)}&status=eq.scheduled&order=created_at.desc&limit=1&select=id`));
      if (back[0]) syncVisitJnTask(back[0].id).catch(() => {});
      return { id: back[0] ? back[0].id : null, task_type: taskType, date: report.packout.date, window: label };
    } catch (e) {
      // The double-booking guard, or the visit types are not in the database yet: the walk is still saved.
      warn('schedule pack-out', e.message);
      warnings.push('PACKOUT_NOT_SCHEDULED');
      return { id: null, task_type: taskType, date: report.packout.date, error: clean(e.message, 300) };
    }
  }

  async function applyPackOut({ job, report, warnings }) {
    await writeJob(job, packOutJobPatch(report), warnings);
    if (report.destination && report.destination.kind === 'warehouse' && report.vault_ids.length) {
      try {
        await sbPatch('warehouse_vaults', `id=in.(${report.vault_ids.map(enc).join(',')})&warehouse_id=eq.${enc(report.destination.warehouse_id)}`, { job_id: job.id, occupied_at: new Date().toISOString() });
      } catch (e) { warn('vaults', e.message); warnings.push('VAULTS_FAILED'); }
    }
  }

  async function applyPackBack({ job, report, warnings }) {
    if (!report.everything_returned) return;
    try { await sbPatch('warehouse_vaults', `job_id=eq.${enc(job.id)}`, { job_id: null, occupied_at: null }); }
    catch (e) { warn('release vaults', e.message); warnings.push('VAULTS_FAILED'); }
    await writeJob(job, { local: { in_storage: false, storage_vaults: 0 }, jn: { cf_boolean_1: false, cf_long_1: 0 } }, warnings);
  }

  async function submitContentsReport({ visitId, report: raw, actor, source }) {
    const visit = await loadVisit(visitId, 'id,jn_id,job_id,task_type,status,scheduled_date,location_id,assigned_to_ids');
    if (!visit) return { status: 404, body: { error: 'Visit not found' } };
    const kind = visit.task_type;
    if (!CR.CONTENTS_REPORT_KINDS.includes(kind)) return { status: 409, body: { error: 'This visit has no contents report', code: 'KIND_MISMATCH' } };
    if (visit.status === 'cancelled') return { status: 409, body: { error: 'This visit was cancelled' } };
    const missing = CR.contentsReportMissing(kind, raw);
    if (missing.length) return { status: 400, body: { error: `Still needed: ${missing.join(', ')}`, code: 'INVALID_REPORT', missing } };
    const report = CR.normalizeContentsReport(kind, raw);
    const summary = CR.summarizeContentsReport(kind, report);
    const now = new Date().toISOString();

    let patched;
    try {
      patched = await sbPatch('inspections', `id=eq.${enc(visitId)}`, {
        contents_report: report, report_submitted_at: now, report_by: actor.id || null, report_by_name: actor.name,
        completion_pct: 100, completion_note: null, completed_by: actor.id || null, completed_by_name: actor.name,
        completed_at: now, status: 'completed', jn_note_error: null, jn_task_dirty: true,
      });
    } catch (e) {
      if (isMissingColumn(e.message)) return { status: 409, body: { error: MIGRATION_HINT, code: 'MIGRATION' } };
      throw e;
    }

    const warnings = [];
    let scheduled = null;
    const jobs = visit.job_id ? await safe(sbGet(`jobs?id=eq.${enc(visit.job_id)}&select=*`)) : [];
    const job = jobs[0] || null;
    if (job) {
      if (kind === 'initial_walk') scheduled = await applyInitialWalk({ visit, job, report, actor, warnings });
      else if (kind === 'pack_out') await applyPackOut({ job, report, warnings });
      else await applyPackBack({ job, report, warnings });
    } else warnings.push('NO_JOB');

    // The JobNimbus note: "<Kind> complete — <who>" then the report, like every other visit.
    let jn = { ok: false, error: 'Visit has no JobNimbus job id' };
    if (visit.jn_id) {
      jn = await jnAddNote(visit.jn_id, `${KIND_LABEL[kind]} complete — ${actor.name}\n\n${summary}`, await visitNoteContext(visit, actor.id)).catch((e) => ({ ok: false, error: e.message }));
    }
    const jnPatch = jn.ok ? { jn_note_id: jn.id, jn_note_error: null } : { jn_note_error: jn.error || 'JobNimbus note failed' };
    await sbPatch('inspections', `id=eq.${enc(visitId)}`, jnPatch).catch(() => {});
    await sbInsert('visit_updates', { visit_id: visitId, actor_id: actor.id || null, actor_name: actor.name, source, pct: 100, note: null, report_snapshot: report, ...jnPatch }).catch((e) => warn('visit_updates', e.message));
    syncVisitJnTask(visitId).catch(() => {});
    if (!jn.ok) warnings.push('NOTE_FAILED');
    return { status: 200, body: { ok: true, visit: { ...(patched && patched[0]), ...jnPatch }, summary, scheduled, warnings } };
  }

  app.post('/tech/visits/:id/contents-report', async (req, res) => {
    try {
      const tech = await techGuard(req, res);
      if (!tech) return;
      const out = await submitContentsReport({ visitId: String(req.params.id), report: req.body && req.body.report, actor: { id: tech.profileId, name: tech.name }, source: 'tech_link' });
      res.status(out.status).json(out.body);
    } catch (err) {
      console.error('[contents report tech]', err.message);
      res.status(502).json({ error: 'Could not save the report right now. Please try again.' });
    }
  });

  app.post('/visits/:id/contents-report', requireAuth, async (req, res) => {
    try {
      const actor = await appActor(req);
      if (!actor) return res.status(403).json({ error: 'Profile not found' });
      const visit = await loadVisit(String(req.params.id), 'id,assigned_to_ids');
      if (!visit) return res.status(404).json({ error: 'Visit not found' });
      if (!MANAGER_ROLES.has(actor.role) && !isAssigned(visit, actor.id)) return res.status(403).json({ error: 'Not allowed' });
      const out = await submitContentsReport({ visitId: String(req.params.id), report: req.body && req.body.report, actor: { id: actor.id, name: actor.name }, source: 'app' });
      res.status(out.status).json(out.body);
    } catch (err) {
      console.error('[contents report]', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  return { submitContentsReport };
};

module.exports.KIND_LABEL = KIND_LABEL;
module.exports.walkJobPatch = walkJobPatch;
module.exports.packOutJobPatch = packOutJobPatch;
module.exports.windowLabel = windowLabel;
