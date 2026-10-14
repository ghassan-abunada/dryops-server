'use strict';
// ── Monitor note reviewer ────────────────────────────────────────────────────
// Reads each in-progress Mitigation job's JobNimbus notes and writes what a
// dispatcher needs before planning the next monitoring visit to
// public.monitor_reviews (schema: DryOps repo supabase/add_monitor_planner.sql):
// when the job was last monitored, equipment on site, dry status, homeowner
// availability / constraints, access, blockers. Read-only towards JobNimbus.
//
// Sibling of collections.js — same shape (scope → activities → deterministic
// fields → notes_hash → one LLM call per changed job → audit row), sharing
// noteReader.js. Runs land in monitor_review_runs (same columns as
// collections_runs).
//
// Schedules: incremental every MONITOR_INCREMENTAL_HOURS between 06:00 and
// 20:00 America/Denver (only jobs with new JN activity), full pass once per
// Denver day at MONITOR_FULL_HOUR. MONITOR_DISABLED=1 turns the schedulers
// off (endpoints keep working). Spend guards: MONITOR_MAX_LLM_JOBS /
// MONITOR_MAX_COST_USD.

const crypto = require('crypto');
const { z } = require('zod');
const {
  PRICES, DEFAULT_SPEC, envNum, envBool, isHuman, hiddenAuthor, plainNote, isoDay, clip, uuidRe, runPool, withRetry,
  makeProvider, fetchActivities: fetchActs, groupActsByJob, notesHash,
} = require('./noteReader');

const PROMPT_VERSION = 'm1'; // bump to re-read every job on the next full run

const SCOPE_STATUSES = ['Scheduled', 'Pending Results', 'Pending Abatement', 'In Progress'];
const DRY_STATUSES = ['drying', 'nearly_dry', 'dry', 'unknown'];

const MonitorReviewSchema = z.object({
  last_monitored_date: z.string().nullable(),
  last_monitored_cite: z.string().nullable(),
  equipment_on_site: z.array(z.object({ type: z.string(), qty: z.number().nullable() })).nullable(),
  dry_status: z.enum(DRY_STATUSES),
  ready_for_closeout: z.boolean(),
  ho_availability: z.string().nullable(),
  ho_constraints: z.string().nullable(),
  access_instructions: z.string().nullable(),
  special_instructions: z.string().nullable(),
  blockers: z.string().nullable(),
  summary: z.string(),
  confidence: z.number(),
});

const SYSTEM_PROMPT = `You read the JobNimbus notes of ONE active water-mitigation (drying) job and extract what the dispatcher needs to plan the next monitoring visit. Notes are newest first; each has a "when" date and an author ("by"). Report ONLY what the notes state. Return JSON only.

last_monitored_date: the "when" date (YYYY-MM-DD) of the newest note that describes a monitoring visit, moisture/atmospheric readings, or an equipment check on site. Null if no note describes one. last_monitored_cite: "<when> by <author>" of that note, else null.

equipment_on_site: the equipment the notes say is currently placed at the property (air movers, dehumidifiers, air scrubbers, drying mats, etc.) with counts ONLY if a note states them (qty null otherwise). Null if the notes never mention equipment. If a note says equipment was pulled, do not list it.

dry_status: "dry" when the newest relevant note says the materials are dry / at goal / drying is complete; "nearly_dry" when readings are close to goal or one more day is expected; "drying" when equipment is running and readings are still above goal; "unknown" when the notes do not say.

ready_for_closeout: true ONLY when the notes say the structure is dry, readings are at goal, or equipment should be pulled / picked up. Otherwise false.

ho_availability: the homeowner's stated time preferences or availability for visits (days, hours, "after 4pm", "weekends only"), max 160 characters, else null.
ho_constraints: pets, gate codes, call-before-arrival requests, tenant or property-manager contact, parking, max 160 characters, else null.
access_instructions: lockbox, key location, door codes, how to enter when nobody is home, max 160 characters, else null.
special_instructions: anything else a technician must know on site (fragile items, areas off limits, what to photograph), max 160 characters, else null.
blockers: what currently prevents the next visit or progress (waiting on adjuster approval, no power, homeowner unreachable, asbestos test pending), max 160 characters, else null.

summary: max 200 characters, factual, naming the date of the key note. confidence: 0 to 1.

Rules: never invent dates, counts, names or codes; when the notes are silent on a field, return null (or "unknown" / false where the field is not nullable); prefer the newest note when notes conflict; dates come only from the "when" of a note or an explicit date written in a note.`;

// Last two comma-separated address parts: "123 Main St, Denver, CO 80202" →
// "Denver, CO 80202". Null when the address has no comma (a bare street line).
function cityOf(address) {
  const parts = String(address || '').split(',').map(s => s.trim()).filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join(', ') : null;
}

// Group activities per job and derive the deterministic fields + LLM notes.
// Pure: `opts` = { notesPerJob, noteChars, nowISO }.
function buildJobInputs(jobs, acts, opts) {
  const { notesPerJob, noteChars, nowISO } = opts;
  const byJn = groupActsByJob(acts);
  const histogram = {};
  return jobs.map(job => {
    const all = (byJn.get(job.jn_id) || []).slice().sort((x, y) => (y.date_created || 0) - (x.date_created || 0));
    const human = all.filter(isHuman);
    for (const a of all) {
      const k = `${a.record_type_name || '?'}|${hiddenAuthor(a.created_by_name) ? 'system' : 'human'}`;
      histogram[k] = (histogram[k] || 0) + 1;
    }
    const newest = human.slice(0, notesPerJob);
    const fp = notesHash(PROMPT_VERSION, newest);
    const deterministic = {
      job_id: job.id, jn_id: job.jn_id,
      last_human_note_at: human[0] ? new Date(human[0].date_created * 1000).toISOString() : null,
      last_human_note_by: human[0] ? clip(human[0].created_by_name, 80) : null,
      last_note_jnid: all[0]?.jnid || null,
      activity_cursor: all.reduce((m, a) => Math.max(m, a.date_updated || a.date_created || 0), 0) || null,
      note_count: human.length,
      last_synced: nowISO,
    };
    const notes = newest.map(a => ({
      when: isoDay(a.date_created), by: clip(a.created_by_name, 60),
      text: plainNote(a.note).slice(0, noteChars),
    }));
    const payload = {
      job_number: job.number, name: clip(job.name, 120), status: job.status,
      sales_rep: job.sales_rep || null, city: cityOf(job.address), notes,
    };
    return { job, deterministic, notes, fp, payload, _histogram: histogram };
  });
}

const userText = (payload, today) => `Today is ${today}.\n${JSON.stringify(payload, null, 1)}`;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function cleanEquipment(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const e of list) {
    const type = clip(e && e.type, 60);
    if (!type) continue;
    const qty = e.qty == null || e.qty === '' ? NaN : Number(e.qty); // Number(null) is 0 — keep "unstated" as null
    out.push({ type, qty: Number.isFinite(qty) && qty >= 0 ? Math.round(qty) : null });
  }
  return out.length ? out : null;
}

function fullRow(det, fp, llm, model, nowISO) {
  const date = DATE_RE.test(String(llm.last_monitored_date || '')) ? llm.last_monitored_date : null;
  return {
    ...det, notes_hash: fp,
    last_monitored_date: date,
    last_monitored_cite: date ? clip(llm.last_monitored_cite, 160) : null,
    equipment_on_site: cleanEquipment(llm.equipment_on_site),
    dry_status: DRY_STATUSES.includes(llm.dry_status) ? llm.dry_status : 'unknown',
    ready_for_closeout: !!llm.ready_for_closeout,
    ho_availability: clip(llm.ho_availability, 160),
    ho_constraints: clip(llm.ho_constraints, 160),
    access_instructions: clip(llm.access_instructions, 160),
    special_instructions: clip(llm.special_instructions, 160),
    blockers: clip(llm.blockers, 160),
    summary: clip(llm.summary, 200), confidence: Math.max(0, Math.min(1, Number(llm.confidence) || 0)),
    model, prompt_version: PROMPT_VERSION, reviewed_at: nowISO, error: null, error_at: null,
  };
}
// No human notes in the lookback window → written without an LLM call.
const ruleRow = (det, fp, nowISO, lookbackDays) => fullRow(det, fp, {
  last_monitored_date: null, last_monitored_cite: null, equipment_on_site: null,
  dry_status: 'unknown', ready_for_closeout: false,
  ho_availability: null, ho_constraints: null, access_instructions: null, special_instructions: null, blockers: null,
  summary: `No notes in last ${lookbackDays} days`, confidence: 1,
}, 'rule', nowISO);

function mountMonitor(app, deps) {
  const {
    SUPABASE_URL, SUPABASE_SERVICE_KEY, jnGet, jnFetchUpdatedSince,
    sbSelect, sbBulkUpsert, sbInsert, sbPatch, requireAuth, requireAdmin, anthropic, denverNow,
  } = deps;

  const MODEL_SPEC = process.env.MONITOR_MODEL || DEFAULT_SPEC;
  let provider = null, modelName = MODEL_SPEC, providerKind = '';
  try {
    const p = makeProvider(MODEL_SPEC, anthropic, { schema: MonitorReviewSchema, systemPrompt: SYSTEM_PROMPT, thinkingEnv: 'MONITOR_GEMINI_THINKING', envName: 'MONITOR_MODEL' });
    provider = p.provider; modelName = p.model; providerKind = p.kind;
  } catch (err) { console.error('[monitor]', err.message); }
  const SCHEDULERS = !!provider && !envBool('MONITOR_DISABLED', false);
  const LOOKBACK_DAYS = envNum('MONITOR_LOOKBACK_DAYS', 45);
  const NOTES_PER_JOB = envNum('MONITOR_NOTES_PER_JOB', 20);
  const NOTE_CHARS = envNum('MONITOR_NOTE_CHARS', 500);
  const LLM_CONCURRENCY = envNum('MONITOR_LLM_CONCURRENCY', 4);
  const JN_CONCURRENCY = envNum('MONITOR_JN_CONCURRENCY', 3);
  const MAX_LLM_JOBS = envNum('MONITOR_MAX_LLM_JOBS', 1500);
  const MAX_COST_USD = envNum('MONITOR_MAX_COST_USD', 3);
  const FULL_HOUR = envNum('MONITOR_FULL_HOUR', 4);
  const INCREMENTAL_HOURS = envNum('MONITOR_INCREMENTAL_HOURS', 2);
  const INCREMENTAL_WINDOW = [6, 20]; // Denver hours [from, to) for incremental ticks
  const [PRICE_IN, PRICE_OUT] = [
    envNum('MONITOR_PRICE_IN', (PRICES[modelName] || [0, 0])[0]),
    envNum('MONITOR_PRICE_OUT', (PRICES[modelName] || [0, 0])[1]),
  ];
  const costOf = (u) => (u.input * PRICE_IN + (u.output + u.thinking) * PRICE_OUT) / 1e6;
  const inputOpts = { notesPerJob: NOTES_PER_JOB, noteChars: NOTE_CHARS };

  if (!provider) {
    console.warn(`[monitor] disabled: no API key for ${MODEL_SPEC} (set GEMINI_API_KEY or ANTHROPIC_API_KEY)`);
  } else {
    console.log(`[monitor] model ${provider.name}; schedulers ${SCHEDULERS ? 'on' : 'off'}; price $${PRICE_IN}/$${PRICE_OUT} per MTok`);
  }

  const sbHeaders = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` };
  async function sbCount(table, query, col = 'job_id') {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=${col}&${query}`, {
      headers: { ...sbHeaders, Prefer: 'count=exact', 'Range-Unit': 'items', Range: '0-0' },
    });
    if (!r.ok && r.status !== 206 && r.status !== 416) throw new Error(`${table} count ${r.status}`);
    const cr = r.headers.get('content-range') || '';
    const n = Number(cr.split('/')[1]);
    return Number.isFinite(n) ? n : 0;
  }
  async function sbPaged(table, query) {
    const out = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await sbSelect(table, `${query}&limit=1000&offset=${offset}`);
      out.push(...page);
      if (page.length < 1000) break;
    }
    return out;
  }
  const denverDay = () => { const { y, m, d } = denverNow(); return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; };

  // ── Data loading ───────────────────────────────────────────────────────────
  const JOB_COLS = 'id,jn_id,number,name,client_name,status,location_id,sales_rep,address';
  // In-progress Mitigation jobs. is_active null counts as active.
  const scopeFilter = (locationId) => `record_type=eq.Mitigation`
    + `&status=in.${encodeURIComponent(`(${SCOPE_STATUSES.map(s => `"${s}"`).join(',')})`)}`
    + `&or=${encodeURIComponent('(is_active.is.null,is_active.eq.true)')}`
    + (locationId ? `&location_id=eq.${encodeURIComponent(locationId)}` : '');
  async function scopeJobs(locationId) {
    return (await sbPaged('jobs', `select=${JOB_COLS}&${scopeFilter(locationId)}&order=jn_id.asc`)).filter(j => j.jn_id);
  }
  async function prevReviews() {
    const rows = await sbPaged('monitor_reviews', 'select=jn_id,notes_hash,error,reviewed_at');
    return new Map(rows.map(r => [r.jn_id, r]));
  }
  const fetchActivities = (jnIds, sinceSecs, stats) => fetchActs({ jnGet, tag: 'monitor' }, jnIds, sinceSecs, stats);

  // ── The run ────────────────────────────────────────────────────────────────
  let running = null;   // { id, mode, started_at, progress }
  let lastRun = null;

  async function runMonitor(opts = {}) {
    const { mode = 'manual', trigger = 'admin', location_id = null, limit = null, force = false, dry = false } = opts;
    if (dry) return dryRun(opts);
    if (!provider) throw new Error(`Monitor reviewer is disabled: no API key for ${MODEL_SPEC}`);
    if (running) { const e = new Error('a monitor run is already in progress'); e.status = 409; throw e; }

    const nowISO = new Date().toISOString();
    const today = denverDay();
    const stats = { jobs_in_scope: 0, jobs_fetched: 0, llm_calls: 0, skipped_unchanged: 0, no_activity: 0, errors: 0, jn_requests: 0, input_tokens: 0, output_tokens: 0, thinking_tokens: 0 };
    const byStatus = {}; const firstErrors = [];
    let cost = 0; let aborted = null; let ready = 0;

    const params = { location_id, limit, force, lookback_days: LOOKBACK_DAYS };
    const runId = crypto.randomUUID(); // client-minted: return=representation can come back empty (see sbInsert)
    await sbInsert('monitor_review_runs', {
      id: runId, mode, trigger, model: provider.name, prompt_version: PROMPT_VERSION, status: 'running',
      report: { params, denver_day: today },
    });
    running = { id: runId, mode, started_at: nowISO, progress: { phase: 'selecting', done: 0, total: 0 } };
    const finish = async (status) => {
      const patch = {
        ...stats, status, finished_at: new Date().toISOString(), est_cost_usd: Math.round(cost * 10000) / 10000,
        report: { params, denver_day: today, by_dry_status: byStatus, ready_for_closeout: ready, first_errors: firstErrors, aborted },
      };
      lastRun = { id: runId, mode, started_at: nowISO, ...patch, model: provider.name };
      running = null;
      await sbPatch('monitor_review_runs', `id=eq.${runId}`, patch).catch(err => console.error('[monitor] run patch failed:', err.message));
    };

    try {
      // 1. scope
      let jobs = await scopeJobs(location_id);
      const prev = await prevReviews();
      if (mode === 'incremental') {
        const last = await sbSelect('monitor_review_runs', 'select=started_at&status=eq.done&mode=in.(full,incremental)&order=started_at.desc&limit=1');
        if (last.length) {
          const sinceSecs = Math.max(
            Math.floor(new Date(last[0].started_at).getTime() / 1000) - 2 * 3600,
            Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86400,
          );
          const touched = new Set();
          for (const a of await jnFetchUpdatedSince('/activities', sinceSecs, '&fields=jnid,related,date_updated')) {
            for (const rel of Array.isArray(a.related) ? a.related : []) if (rel && rel.type === 'job' && rel.id) touched.add(rel.id);
          }
          jobs = jobs.filter(j => touched.has(j.jn_id) || !prev.has(j.jn_id));
        }
      }
      stats.jobs_in_scope = jobs.length;
      running.progress = { phase: 'activities', done: 0, total: jobs.length };

      // 2. activities (chunks of 15) → inputs
      const sinceSecs = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86400;
      const chunks = [];
      for (let i = 0; i < jobs.length; i += 15) chunks.push(jobs.slice(i, i + 15));
      const detRows = []; const fullRows = []; const errRows = []; const llmQueue = [];
      await runPool(chunks, JN_CONCURRENCY, async (chunk) => {
        const acts = await fetchActivities(chunk.map(j => j.jn_id), sinceSecs, stats);
        stats.jobs_fetched += chunk.length;
        running.progress.done += chunk.length;
        for (const inp of buildJobInputs(chunk, acts, { ...inputOpts, nowISO })) {
          const p = prev.get(inp.job.jn_id);
          if (!inp.notes.length) {
            fullRows.push(ruleRow(inp.deterministic, inp.fp, nowISO, LOOKBACK_DAYS)); stats.no_activity++;
            byStatus.unknown = (byStatus.unknown || 0) + 1;
          } else if (!force && p && p.notes_hash === inp.fp && !p.error) {
            detRows.push(inp.deterministic); stats.skipped_unchanged++;
          } else {
            llmQueue.push(inp);
          }
        }
      });

      // Flush finished rows in batches so a redeploy mid-run keeps what was
      // already read and paid for. One batch per row shape (PostgREST bulk).
      const flush = async (all = false) => {
        for (const batch of [detRows, fullRows, errRows]) {
          while (batch.length >= 200 || (all && batch.length)) {
            const chunk = batch.splice(0, 500);
            await sbBulkUpsert('monitor_reviews', chunk);
            running.progress.written = (running.progress.written || 0) + chunk.length;
          }
        }
      };
      await flush(true);

      // 3. LLM
      const queue = limit ? llmQueue.slice(0, limit) : llmQueue;
      for (const inp of llmQueue.slice(queue.length)) detRows.push(inp.deterministic); // beyond limit: deterministic only
      running.progress = { phase: 'reading', done: 0, total: queue.length };
      let flushing = null;
      await runPool(queue, LLM_CONCURRENCY, async (inp) => {
        if (aborted) { detRows.push(inp.deterministic); return; }
        if (stats.llm_calls >= MAX_LLM_JOBS) { aborted = `max_llm_jobs (${MAX_LLM_JOBS})`; detRows.push(inp.deterministic); return; }
        if (cost >= MAX_COST_USD) { aborted = `max_cost_usd ($${MAX_COST_USD})`; detRows.push(inp.deterministic); return; }
        if (stats.llm_calls >= 20 && stats.errors >= 10 && stats.errors / stats.llm_calls > 0.5) { aborted = 'error_rate'; detRows.push(inp.deterministic); return; }
        stats.llm_calls++;
        try {
          const { parsed, usage } = await withRetry(() => provider.classify(userText(inp.payload, today)));
          stats.input_tokens += usage.input; stats.output_tokens += usage.output; stats.thinking_tokens += usage.thinking;
          cost += costOf(usage);
          const row = fullRow(inp.deterministic, inp.fp, parsed, provider.name, nowISO);
          fullRows.push(row);
          byStatus[row.dry_status] = (byStatus[row.dry_status] || 0) + 1;
          if (row.ready_for_closeout) ready++;
        } catch (err) {
          stats.errors++;
          if (firstErrors.length < 20) firstErrors.push({ job_number: inp.job.number, error: String(err.message).slice(0, 200) });
          errRows.push({ ...inp.deterministic, error: String(err.message).slice(0, 300), error_at: nowISO }); // notes_hash not advanced → retried next run
        }
        running.progress.done++;
        if (fullRows.length + errRows.length + detRows.length >= 200) {
          if (!flushing) flushing = flush().catch(e => console.error('[monitor] flush failed:', e.message)).finally(() => { flushing = null; });
          await flushing;
        }
      });

      // 4. write whatever is left
      running.progress = { ...running.progress, phase: 'writing' };
      if (flushing) await flushing;
      await flush(true);
      console.log(`[monitor] ${mode} done: scope ${stats.jobs_in_scope}, llm ${stats.llm_calls}, unchanged ${stats.skipped_unchanged}, no-notes ${stats.no_activity}, errors ${stats.errors}, ~$${cost.toFixed(3)}${aborted ? `, ABORTED (${aborted})` : ''}`);
      await finish(aborted ? 'aborted' : 'done');
    } catch (err) {
      console.error('[monitor] run failed:', err.message);
      firstErrors.unshift({ fatal: String(err.message).slice(0, 300) });
      await finish('error');
      throw err;
    }
    return lastRun;
  }

  // Dry run: everything except the LLM and the writes. Returns the prompt payloads.
  async function dryRun({ location_id = null, limit = 5, force = false } = {}) {
    const stats = { jn_requests: 0 };
    const nowISO = new Date().toISOString();
    const jobs = (await scopeJobs(location_id)).slice(0, Math.max(1, Math.min(Number(limit) || 5, 100)));
    const prev = await prevReviews();
    const sinceSecs = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86400;
    const out = []; let histogram = {};
    for (let i = 0; i < jobs.length; i += 15) {
      const chunk = jobs.slice(i, i + 15);
      const acts = await fetchActivities(chunk.map(j => j.jn_id), sinceSecs, stats);
      for (const inp of buildJobInputs(chunk, acts, { ...inputOpts, nowISO })) {
        histogram = inp._histogram;
        const p = prev.get(inp.job.jn_id);
        out.push({
          job_number: inp.job.number, name: inp.job.name, fp: inp.fp,
          would_skip: !inp.notes.length ? 'no_notes(rule)' : (!force && p && p.notes_hash === inp.fp && !p.error) ? 'unchanged' : null,
          deterministic: inp.deterministic, payload: inp.payload,
        });
      }
    }
    return { model: provider ? provider.name : null, schedulers: SCHEDULERS, lookback_days: LOOKBACK_DAYS, jn_requests: stats.jn_requests, type_histogram: histogram, jobs: out };
  }

  // Single-job forced re-read (app "Re-read notes" button). Independent of the run lock.
  async function refreshJob(jobId) {
    if (!provider) throw new Error(`Monitor reviewer is disabled: no API key for ${MODEL_SPEC}`);
    const [job] = await sbSelect('jobs', `select=${JOB_COLS}&id=eq.${jobId}`);
    if (!job) { const e = new Error('job not found'); e.status = 404; throw e; }
    if (!job.jn_id) { const e = new Error('job has no JobNimbus id'); e.status = 400; throw e; }
    const nowISO = new Date().toISOString();
    const stats = { jn_requests: 0 };
    const sinceSecs = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86400;
    const acts = await fetchActivities([job.jn_id], sinceSecs, stats);
    const [inp] = buildJobInputs([job], acts, { ...inputOpts, nowISO });
    let row; let usage = { input: 0, output: 0, thinking: 0 }; let error = null;
    if (!inp.notes.length) {
      row = ruleRow(inp.deterministic, inp.fp, nowISO, LOOKBACK_DAYS);
    } else {
      try {
        const r = await withRetry(() => provider.classify(userText(inp.payload, denverDay())));
        usage = r.usage; row = fullRow(inp.deterministic, inp.fp, r.parsed, provider.name, nowISO);
      } catch (err) {
        error = String(err.message).slice(0, 300);
        row = { ...inp.deterministic, error, error_at: nowISO };
      }
    }
    await sbBulkUpsert('monitor_reviews', [row]);
    const cost = costOf(usage);
    await sbInsert('monitor_review_runs', {
      mode: 'refresh', trigger: 'app', model: provider.name, prompt_version: PROMPT_VERSION, status: error ? 'error' : 'done',
      finished_at: new Date().toISOString(), jobs_in_scope: 1, jobs_fetched: 1, llm_calls: inp.notes.length ? 1 : 0,
      no_activity: inp.notes.length ? 0 : 1, errors: error ? 1 : 0, jn_requests: stats.jn_requests,
      input_tokens: usage.input, output_tokens: usage.output, thinking_tokens: usage.thinking,
      est_cost_usd: Math.round(cost * 10000) / 10000, report: { job_id: jobId, job_number: job.number, error },
    }).catch(err => console.error('[monitor] refresh audit failed:', err.message));
    const [fresh] = await sbSelect('monitor_reviews', `select=*&job_id=eq.${jobId}`);
    return fresh || null;
  }

  // ── Schedulers ─────────────────────────────────────────────────────────────
  async function fullCheckDue() {
    if (!SCHEDULERS || running) return;
    const { h } = denverNow();
    if (h !== FULL_HOUR) return;
    try {
      const prior = await sbSelect('monitor_review_runs', `select=id&mode=eq.full&status=in.(done,aborted)&report->>denver_day=eq.${denverDay()}&limit=1`);
      if (prior.length) return;
      await runMonitor({ mode: 'full', trigger: 'schedule' });
    } catch (err) { console.error('[monitor] scheduled full run failed:', err.message); }
  }
  async function incrementalTick() {
    if (!SCHEDULERS || running) return;
    const { h } = denverNow();
    if (h < INCREMENTAL_WINDOW[0] || h >= INCREMENTAL_WINDOW[1]) return; // field hours only
    try { await runMonitor({ mode: 'incremental', trigger: 'schedule' }); }
    catch (err) { console.error('[monitor] scheduled incremental failed:', err.message); }
  }
  if (SCHEDULERS) {
    setTimeout(fullCheckDue, 5 * 60 * 1000);
    setInterval(fullCheckDue, 15 * 60 * 1000);
    setTimeout(incrementalTick, 6 * 60 * 1000);
    setInterval(incrementalTick, Math.max(1, INCREMENTAL_HOURS) * 3600 * 1000);
  }

  // ── Endpoints (admin OR owner — requireAdmin allows both) ──────────────────
  app.post('/admin/monitor/run', requireAuth, requireAdmin, async (req, res) => {
    const b = req.body || {};
    const opts = {
      mode: b.full ? 'full' : 'manual', trigger: 'admin',
      location_id: b.location_id ? String(b.location_id) : null,
      limit: b.limit != null ? Math.max(0, parseInt(b.limit, 10) || 0) || null : null,
      force: !!b.force, dry: !!b.dry,
    };
    try {
      if (opts.dry) return res.json(await dryRun(opts));
      if (!provider) return res.status(503).json({ error: `Monitor reviewer is disabled: no API key for ${MODEL_SPEC}` });
      if (running) return res.status(409).json({ error: 'a monitor run is already in progress', running });
      runMonitor(opts).catch(() => {});
      res.status(202).json({ ok: true, started: true, mode: opts.mode, model: provider.name });
    } catch (err) {
      console.error('[monitor run]', err.message);
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.get('/admin/monitor/status', requireAuth, requireAdmin, async (req, res) => {
    try {
      const since30d = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
      const [recent, costRows, in_scope, reviewed, errors, ready_for_closeout, unknown, stale] = await Promise.all([
        sbSelect('monitor_review_runs', 'select=id,mode,trigger,model,started_at,finished_at,status,jobs_in_scope,llm_calls,skipped_unchanged,no_activity,errors,input_tokens,output_tokens,thinking_tokens,est_cost_usd&order=started_at.desc&limit=10'),
        sbPaged('monitor_review_runs', `select=est_cost_usd&started_at=gte.${since30d}`),
        sbCount('jobs', scopeFilter(null), 'id'),
        sbCount('monitor_reviews', 'reviewed_at=not.is.null'),
        sbCount('monitor_reviews', 'error=not.is.null'),
        sbCount('monitor_reviews', 'ready_for_closeout=is.true'),
        sbCount('monitor_reviews', 'dry_status=eq.unknown'),
        sbCount('monitor_reviews', `last_synced=lt.${new Date(Date.now() - 2 * 86400 * 1000).toISOString()}`),
      ]);
      const last = lastRun || recent.find(r => r.mode !== 'refresh') || null;
      res.json({
        enabled: !!provider, schedulers: SCHEDULERS, model: provider ? provider.name : null, model_spec: MODEL_SPEC, provider: providerKind,
        prompt_version: PROMPT_VERSION, lookback_days: LOOKBACK_DAYS,
        running, last_run: last, recent_runs: recent,
        counts: { in_scope, reviewed, errors, ready_for_closeout, unknown, stale },
        cost: {
          last_run_usd: last ? Number(last.est_cost_usd) || 0 : 0,
          last_30d_usd: Math.round(costRows.reduce((s, r) => s + (Number(r.est_cost_usd) || 0), 0) * 10000) / 10000,
          price_per_mtok: { input: PRICE_IN, output: PRICE_OUT },
        },
      });
    } catch (err) {
      console.error('[monitor status]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/admin/monitor/jobs/:jobId/refresh', requireAuth, requireAdmin, async (req, res) => {
    const jobId = String(req.params.jobId || '');
    if (!uuidRe.test(jobId)) return res.status(400).json({ error: 'invalid job id' });
    try {
      const row = await refreshJob(jobId);
      res.json({ ok: true, review: row });
    } catch (err) {
      console.error('[monitor refresh]', err.message);
      res.status(err.status || 500).json({ error: err.message });
    }
  });
}

module.exports = mountMonitor;
// Pure pieces, exported for test/monitor.test.js.
module.exports.PROMPT_VERSION = PROMPT_VERSION;
module.exports.SCOPE_STATUSES = SCOPE_STATUSES;
module.exports.MonitorReviewSchema = MonitorReviewSchema;
module.exports.cityOf = cityOf;
module.exports.buildJobInputs = buildJobInputs;
module.exports.userText = userText;
module.exports.fullRow = fullRow;
module.exports.ruleRow = ruleRow;
