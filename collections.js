'use strict';
// ── Collections classifier ───────────────────────────────────────────────────
// Reads each Open AR job's JobNimbus notes and writes a per-job classification
// to public.collections_reviews (schema: DryOps repo supabase/add_collections.sql).
// The app's Collections tab reads the collections_open_ar view. Read-only
// towards JobNimbus — this module never posts notes or changes jobs.
//
// Open AR = status in AR_STATUSES (same list as the hourly AR reconcile and
// public.is_ar_status()) AND approved_invoice_due > 0.
//
// Per run:
//   1. AR jobs from Supabase (biggest balance first).
//   2. Activities from JN, 15 jobs per request, date-bounded ES filter.
//   3. Deterministic fields (last human note, counts) → always written.
//   4. notes_hash of the newest human notes; unchanged → LLM skipped.
//   5. One LLM call per changed job (Gemini or Anthropic, COLLECTIONS_MODEL).
//   6. Audit row in collections_runs with token usage + estimated cost.
//
// Schedules: a full pass once per Denver day at COLLECTIONS_FULL_HOUR and an
// incremental pass (only jobs with new JN activity) every
// COLLECTIONS_INCREMENTAL_HOURS. The first incremental on an empty table is
// the seed. Spend guards: COLLECTIONS_MAX_LLM_JOBS / COLLECTIONS_MAX_COST_USD.

const crypto = require('crypto');
const { z } = require('zod');
const {
  PRICES, envNum, envBool, plainNote, hiddenAuthor, isHuman, isoDay, clip, uuidRe, runPool, withRetry,
  makeProvider, fetchActivities: fetchActs, groupActsByJob, notesHash,
} = require('./noteReader');

const PROMPT_VERSION = 'c1'; // bump to re-classify every job on the next full run

const CATEGORIES = [
  'awaiting_carrier', 'check_issued', 'received_unposted', 'disputed_comparative', 'denied',
  'attorney_pa', 'payment_plan', 'awaiting_customer', 'customer_unresponsive', 'no_activity', 'other',
];

const JobReviewSchema = z.object({
  category: z.enum(CATEGORIES),
  needs_owner: z.boolean(),
  owner_request: z.string().nullable(),
  comparative_sent: z.boolean(),
  comparative_amount: z.number().nullable(),
  summary: z.string(),
  confidence: z.number(),
});

const SYSTEM_PROMPT = `You classify the collections status of ONE invoiced water-damage restoration job from its JobNimbus notes. A central collections team writes the collections notes; the location owner and office staff (the people who read your output) are NOT the collectors. Notes are newest first. Return JSON only.

category (pick one):
- awaiting_carrier: invoice or supplement submitted and waiting on the insurance carrier, adjuster, TPA or reviewer with no decision yet.
- check_issued: the carrier or customer confirmed a check or ACH was issued, mailed or approved for a specific amount and it has not been received yet.
- received_unposted: the notes say payment was received, deposited or picked up but the job still shows a balance (nobody posted it).
- disputed_comparative: the carrier sent a comparative, revised or desk-adjusted estimate lower than our invoice and the difference is being negotiated or disputed.
- denied: the claim or line items were denied, coverage declined, or the carrier refuses to pay.
- attorney_pa: an attorney, public adjuster, appraisal, litigation or lien is involved.
- payment_plan: the customer is on an agreed installment plan.
- awaiting_customer: the customer owes the balance or deductible, or holds the check, and has agreed to pay or send it.
- customer_unresponsive: the collector has repeatedly tried the customer or carrier with no response.
- no_activity: the notes contain nothing about collections.
- other: anything else; explain in summary.

needs_owner: true ONLY when the collector explicitly asks the location, office, owner, manager, technician or sales rep to do or provide something (send documents, photos, moisture or dry logs, a corrected invoice, a signed work authorization, call the customer, approve a reduction, pick up a check, decide on attorney, etc.) or states that the job is stuck until the location acts. Routine collector-to-carrier follow-up is NOT needs_owner. If true, owner_request is one imperative line (max 140 characters) naming what is needed and who asked, with the note date, for example "Send signed work auth and dry logs to adjuster - asked by Maria 2026-09-30". If false, owner_request is null.

comparative_sent: true only if the notes say the adjuster or carrier sent a comparative, revised or desk-adjusted estimate, or stated the amount they will pay. comparative_amount is that carrier figure in dollars if a number is stated; it is never our invoice total, the balance due, a deductible, depreciation or a payment that was made. Null if no carrier figure is stated.

summary: max 160 characters, factual, naming the payer and the date of the key note. confidence: 0 to 1.

Rules: be conservative; never invent amounts, names or dates; when the notes are silent, use awaiting_carrier if an invoice was sent to a carrier, otherwise no_activity; prefer the newest note when notes conflict; amounts are USD.`;

module.exports = function mountCollections(app, deps) {
  const {
    SUPABASE_URL, SUPABASE_SERVICE_KEY, jnGet, jnFetchUpdatedSince, AR_STATUSES,
    sbSelect, sbBulkUpsert, sbInsert, sbPatch, requireAuth, requireAdmin, anthropic, denverNow,
  } = deps;

  const MODEL_SPEC = process.env.COLLECTIONS_MODEL || 'gemini:gemini-3.1-flash-lite';
  let provider = null, modelName = MODEL_SPEC, providerKind = '';
  try {
    const p = makeProvider(MODEL_SPEC, anthropic, { schema: JobReviewSchema, systemPrompt: SYSTEM_PROMPT, thinkingEnv: 'COLLECTIONS_GEMINI_THINKING', envName: 'COLLECTIONS_MODEL' });
    provider = p.provider; modelName = p.model; providerKind = p.kind;
  } catch (err) { console.error('[collections]', err.message); }
  const ENABLED = envBool('COLLECTIONS_ENABLED', !!provider) && !!provider;
  const LOOKBACK_DAYS = envNum('COLLECTIONS_LOOKBACK_DAYS', 120);
  const NOTES_PER_JOB = envNum('COLLECTIONS_NOTES_PER_JOB', 15);
  const NOTE_CHARS = envNum('COLLECTIONS_NOTE_CHARS', 400);
  const LLM_CONCURRENCY = envNum('COLLECTIONS_LLM_CONCURRENCY', 4);
  const JN_CONCURRENCY = envNum('COLLECTIONS_JN_CONCURRENCY', 3);
  const MAX_LLM_JOBS = envNum('COLLECTIONS_MAX_LLM_JOBS', 6000);
  const MAX_COST_USD = envNum('COLLECTIONS_MAX_COST_USD', 10);
  const FULL_HOUR = envNum('COLLECTIONS_FULL_HOUR', 3);
  const INCREMENTAL_HOURS = envNum('COLLECTIONS_INCREMENTAL_HOURS', 6);
  const [PRICE_IN, PRICE_OUT] = [
    envNum('COLLECTIONS_PRICE_IN', (PRICES[modelName] || [0, 0])[0]),
    envNum('COLLECTIONS_PRICE_OUT', (PRICES[modelName] || [0, 0])[1]),
  ];
  const costOf = (u) => (u.input * PRICE_IN + (u.output + u.thinking) * PRICE_OUT) / 1e6;

  if (!provider) {
    console.warn(`[collections] disabled: no API key for ${MODEL_SPEC} (set GEMINI_API_KEY or ANTHROPIC_API_KEY)`);
  } else {
    console.log(`[collections] model ${provider.name}; schedulers ${ENABLED ? 'on' : 'off'}; price $${PRICE_IN}/$${PRICE_OUT} per MTok`);
  }

  const sbHeaders = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` };
  async function sbCount(table, query) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=job_id&${query}`, {
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

  // ── Data loading ───────────────────────────────────────────────────────────
  const JOB_COLS = 'id,jn_id,number,name,client_name,status,record_type,location_id,sales_rep,insurer,claim_number,adjuster_name,approved_invoice_total,approved_invoice_due,last_invoice_date';
  async function arJobs(locationId) {
    const statuses = encodeURIComponent(`(${AR_STATUSES.map(s => `"${s}"`).join(',')})`);
    const q = `select=${JOB_COLS}&status=in.${statuses}&approved_invoice_due=gt.0`
      + (locationId ? `&location_id=eq.${encodeURIComponent(locationId)}` : '')
      + '&order=approved_invoice_due.desc,jn_id.asc';
    return (await sbPaged('jobs', q)).filter(j => j.jn_id);
  }
  async function locationNames() {
    const rows = await sbPaged('locations', 'select=id,name');
    return new Map(rows.map(l => [String(l.id), l.name]));
  }
  async function prevReviews() {
    const rows = await sbPaged('collections_reviews', 'select=jn_id,notes_hash,error,reviewed_at');
    return new Map(rows.map(r => [r.jn_id, r]));
  }

  // Activities for ≤15 jobs, newest-first within the lookback window (noteReader).
  const fetchActivities = (jnIds, sinceSecs, stats) => fetchActs({ jnGet, tag: 'collections' }, jnIds, sinceSecs, stats);

  // Group activities per job and derive the deterministic fields + LLM notes.
  function buildJobInputs(jobs, acts, locNames, nowISO) {
    const byJn = groupActsByJob(acts);
    const histogram = {};
    return jobs.map(job => {
      const all = (byJn.get(job.jn_id) || []).slice().sort((x, y) => (y.date_created || 0) - (x.date_created || 0));
      const human = all.filter(isHuman);
      for (const a of all) {
        const k = `${a.record_type_name || '?'}|${hiddenAuthor(a.created_by_name) ? 'system' : 'human'}`;
        histogram[k] = (histogram[k] || 0) + 1;
      }
      const newest = human.slice(0, NOTES_PER_JOB);
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
        when: isoDay(a.date_created), by: clip(a.created_by_name, 60), type: a.record_type_name || 'Note',
        note: plainNote(a.note).slice(0, NOTE_CHARS),
      }));
      const payload = {
        job_number: job.number, name: clip(job.name, 120), record_type: job.record_type, status: job.status,
        location: locNames.get(String(job.location_id)) || null, sales_rep: job.sales_rep || null,
        insurer: job.insurer || null, adjuster: job.adjuster_name || null, claim_number: job.claim_number || null,
        our_invoice_total: job.approved_invoice_total, balance_due: job.approved_invoice_due,
        last_invoice_date: job.last_invoice_date, notes,
      };
      return { job, deterministic, notes, fp, payload, _histogram: histogram };
    });
  }

  const userText = (payload, today) => `Today is ${today}.\n${JSON.stringify(payload, null, 1)}`;

  function fullRow(det, fp, llm, model, nowISO) {
    const ownerReq = llm.needs_owner ? clip(llm.owner_request, 140) : null;
    const cmp = Number.isFinite(llm.comparative_amount) && llm.comparative_amount > 0 ? Math.round(llm.comparative_amount * 100) / 100 : null;
    return {
      ...det, notes_hash: fp,
      category: CATEGORIES.includes(llm.category) ? llm.category : 'other',
      needs_owner: !!ownerReq, owner_request: ownerReq,
      comparative_sent: !!llm.comparative_sent || cmp != null, comparative_amount: cmp,
      our_amount: det.our_amount ?? null,
      summary: clip(llm.summary, 160), confidence: Math.max(0, Math.min(1, Number(llm.confidence) || 0)),
      model, prompt_version: PROMPT_VERSION, reviewed_at: nowISO, error: null, error_at: null,
    };
  }
  const ruleRow = (det, fp, nowISO) => fullRow(det, fp, {
    category: 'no_activity', needs_owner: false, owner_request: null, comparative_sent: false, comparative_amount: null,
    summary: `No human notes in the last ${LOOKBACK_DAYS} days`, confidence: 1,
  }, 'rule', nowISO);

  // ── The run ────────────────────────────────────────────────────────────────
  let running = null;   // { id, mode, started_at, progress }
  let lastRun = null;

  async function runCollections(opts = {}) {
    const { mode = 'manual', trigger = 'admin', location_id = null, limit = null, force = false, dry = false } = opts;
    if (dry) return dryRun(opts);
    if (!provider) throw new Error(`Collections classifier is disabled: no API key for ${MODEL_SPEC}`);
    if (running) { const e = new Error('a collections run is already in progress'); e.status = 409; throw e; }

    const nowISO = new Date().toISOString();
    const today = nowISO.slice(0, 10);
    const { y, m, d } = denverNow();
    const denverDay = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const stats = { jobs_in_scope: 0, jobs_fetched: 0, llm_calls: 0, skipped_unchanged: 0, no_activity: 0, errors: 0, jn_requests: 0, input_tokens: 0, output_tokens: 0, thinking_tokens: 0 };
    const byCategory = {}; const firstErrors = [];
    let cost = 0; let aborted = null;

    // Mint the id client-side: PostgREST's return=representation has come back
    // empty in prod (see sbInsert), and without the id the run could never
    // patch its own row — leaving it 'running' forever with no cost totals.
    const runId = crypto.randomUUID();
    await sbInsert('collections_runs', {
      id: runId, mode, trigger, model: provider.name, prompt_version: PROMPT_VERSION, status: 'running',
      report: { params: { location_id, limit, force, lookback_days: LOOKBACK_DAYS }, denver_day: denverDay },
    });
    running = { id: runId, mode, started_at: nowISO, progress: { phase: 'selecting', done: 0, total: 0 } };
    const finish = async (status) => {
      const patch = {
        ...stats, status, finished_at: new Date().toISOString(), est_cost_usd: Math.round(cost * 10000) / 10000,
        report: { params: { location_id, limit, force, lookback_days: LOOKBACK_DAYS }, denver_day: denverDay, by_category: byCategory, first_errors: firstErrors, aborted },
      };
      lastRun = { id: runId, mode, started_at: nowISO, ...patch, model: provider.name };
      running = null;
      if (runId) await sbPatch('collections_runs', `id=eq.${runId}`, patch).catch(err => console.error('[collections] run patch failed:', err.message));
    };

    try {
      // 1. scope
      let jobs = await arJobs(location_id);
      const prev = await prevReviews();
      if (mode === 'incremental') {
        const last = await sbSelect('collections_runs', 'select=started_at&status=eq.done&mode=in.(full,incremental)&order=started_at.desc&limit=1');
        if (last.length) {
          const sinceSecs = Math.max(
            Math.floor(new Date(last[0].started_at).getTime() / 1000) - 2 * 3600,
            Math.floor(Date.now() / 1000) - 45 * 86400,
          );
          const touched = new Set();
          for (const a of await jnFetchUpdatedSince('/activities', sinceSecs, `&fields=jnid,related,date_updated`)) {
            for (const rel of Array.isArray(a.related) ? a.related : []) if (rel && rel.type === 'job' && rel.id) touched.add(rel.id);
          }
          jobs = jobs.filter(j => touched.has(j.jn_id) || !prev.has(j.jn_id));
        }
      }
      stats.jobs_in_scope = jobs.length;
      running.progress = { phase: 'activities', done: 0, total: jobs.length };

      // 2. activities (chunks of 15, 3 workers) → inputs
      const locNames = await locationNames();
      const sinceSecs = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86400;
      const chunks = [];
      for (let i = 0; i < jobs.length; i += 15) chunks.push(jobs.slice(i, i + 15));
      const detRows = []; const fullRows = []; const errRows = []; const llmQueue = [];
      await runPool(chunks, JN_CONCURRENCY, async (chunk) => {
        const acts = await fetchActivities(chunk.map(j => j.jn_id), sinceSecs, stats);
        stats.jobs_fetched += chunk.length;
        running.progress.done += chunk.length;
        for (const inp of buildJobInputs(chunk, acts, locNames, nowISO)) {
          inp.deterministic.our_amount = inp.job.approved_invoice_total;
          const p = prev.get(inp.job.jn_id);
          if (!inp.notes.length) {
            fullRows.push(ruleRow(inp.deterministic, inp.fp, nowISO)); stats.no_activity++;
            byCategory.no_activity = (byCategory.no_activity || 0) + 1;
          } else if (!force && p && p.notes_hash === inp.fp && !p.error) {
            detRows.push(inp.deterministic); stats.skipped_unchanged++;
          } else {
            llmQueue.push(inp);
          }
        }
      });

      // Flush finished rows in batches so a redeploy mid-run (Railway restarts
      // on every merge) keeps what was already classified and paid for.
      // PostgREST bulk rows must share one key set → one batch per shape.
      const flush = async (all = false) => {
        for (const batch of [detRows, fullRows, errRows]) {
          while (batch.length >= 200 || (all && batch.length)) {
            const chunk = batch.splice(0, 500);
            await sbBulkUpsert('collections_reviews', chunk);
            running.progress.written = (running.progress.written || 0) + chunk.length;
          }
        }
      };
      await flush(true); // deterministic + rule rows are complete already

      // 3. LLM
      const queue = limit ? llmQueue.slice(0, limit) : llmQueue;
      for (const inp of llmQueue.slice(queue.length)) detRows.push(inp.deterministic); // beyond limit: deterministic only
      running.progress = { phase: 'classifying', done: 0, total: queue.length };
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
          byCategory[row.category] = (byCategory[row.category] || 0) + 1;
        } catch (err) {
          stats.errors++;
          if (firstErrors.length < 20) firstErrors.push({ job_number: inp.job.number, error: String(err.message).slice(0, 200) });
          errRows.push({ ...inp.deterministic, error: String(err.message).slice(0, 300), error_at: nowISO }); // notes_hash not advanced → retried next run
        }
        running.progress.done++;
        if (fullRows.length + errRows.length + detRows.length >= 200) {
          if (!flushing) flushing = flush().catch(e => console.error('[collections] flush failed:', e.message)).finally(() => { flushing = null; });
          await flushing;
        }
      });

      // 4. write whatever is left
      running.progress = { ...running.progress, phase: 'writing' };
      if (flushing) await flushing;
      await flush(true);
      console.log(`[collections] ${mode} done: scope ${stats.jobs_in_scope}, llm ${stats.llm_calls}, unchanged ${stats.skipped_unchanged}, no-activity ${stats.no_activity}, errors ${stats.errors}, ~$${cost.toFixed(3)}${aborted ? `, ABORTED (${aborted})` : ''}`);
      await finish(aborted ? 'aborted' : 'done');
    } catch (err) {
      console.error('[collections] run failed:', err.message);
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
    const jobs = (await arJobs(location_id)).slice(0, Math.max(1, Math.min(Number(limit) || 5, 100)));
    const prev = await prevReviews();
    const locNames = await locationNames();
    const sinceSecs = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86400;
    const out = []; let histogram = {};
    for (let i = 0; i < jobs.length; i += 15) {
      const chunk = jobs.slice(i, i + 15);
      const acts = await fetchActivities(chunk.map(j => j.jn_id), sinceSecs, stats);
      for (const inp of buildJobInputs(chunk, acts, locNames, nowISO)) {
        histogram = inp._histogram;
        const p = prev.get(inp.job.jn_id);
        out.push({
          job_number: inp.job.number, name: inp.job.name, fp: inp.fp,
          would_skip: !inp.notes.length ? 'no_activity(rule)' : (!force && p && p.notes_hash === inp.fp && !p.error) ? 'unchanged' : null,
          deterministic: inp.deterministic, payload: inp.payload,
        });
      }
    }
    return { model: provider ? provider.name : null, enabled: ENABLED, lookback_days: LOOKBACK_DAYS, jn_requests: stats.jn_requests, type_histogram: histogram, jobs: out };
  }

  // Single-job forced refresh (app "Re-check" button). Independent of the run lock.
  async function refreshJob(jobId) {
    if (!provider) throw new Error(`Collections classifier is disabled: no API key for ${MODEL_SPEC}`);
    const [job] = await sbSelect('jobs', `select=${JOB_COLS}&id=eq.${jobId}`);
    if (!job) { const e = new Error('job not found'); e.status = 404; throw e; }
    const nowISO = new Date().toISOString();
    const stats = { jn_requests: 0 };
    const sinceSecs = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86400;
    const acts = await fetchActivities([job.jn_id], sinceSecs, stats);
    const [inp] = buildJobInputs([job], acts, await locationNames(), nowISO);
    inp.deterministic.our_amount = job.approved_invoice_total;
    let row; let usage = { input: 0, output: 0, thinking: 0 }; let error = null;
    if (!inp.notes.length) {
      row = ruleRow(inp.deterministic, inp.fp, nowISO);
    } else {
      try {
        const r = await withRetry(() => provider.classify(userText(inp.payload, nowISO.slice(0, 10))));
        usage = r.usage; row = fullRow(inp.deterministic, inp.fp, r.parsed, provider.name, nowISO);
      } catch (err) {
        error = String(err.message).slice(0, 300);
        row = { ...inp.deterministic, error, error_at: nowISO };
      }
    }
    await sbBulkUpsert('collections_reviews', [row]);
    const cost = costOf(usage);
    await sbInsert('collections_runs', {
      mode: 'refresh', trigger: 'app', model: provider.name, prompt_version: PROMPT_VERSION, status: error ? 'error' : 'done',
      finished_at: new Date().toISOString(), jobs_in_scope: 1, jobs_fetched: 1, llm_calls: inp.notes.length ? 1 : 0,
      no_activity: inp.notes.length ? 0 : 1, errors: error ? 1 : 0, jn_requests: stats.jn_requests,
      input_tokens: usage.input, output_tokens: usage.output, thinking_tokens: usage.thinking,
      est_cost_usd: Math.round(cost * 10000) / 10000, report: { job_id: jobId, job_number: job.number, error },
    }).catch(err => console.error('[collections] refresh audit failed:', err.message));
    const [fresh] = await sbSelect('collections_open_ar', `select=*&job_id=eq.${jobId}`);
    return fresh || null;
  }

  // ── Schedulers ─────────────────────────────────────────────────────────────
  async function fullCheckDue() {
    if (!ENABLED || running) return;
    const { y, m, d, h } = denverNow();
    if (h !== FULL_HOUR) return;
    const day = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    try {
      const prior = await sbSelect('collections_runs', `select=id&mode=eq.full&status=in.(done,aborted)&report->>denver_day=eq.${day}&limit=1`);
      if (prior.length) return;
      await runCollections({ mode: 'full', trigger: 'schedule' });
    } catch (err) { console.error('[collections] scheduled full run failed:', err.message); }
  }
  async function incrementalTick() {
    if (!ENABLED || running) return;
    try { await runCollections({ mode: 'incremental', trigger: 'schedule' }); }
    catch (err) { console.error('[collections] scheduled incremental failed:', err.message); }
  }
  if (ENABLED) {
    setTimeout(fullCheckDue, 3 * 60 * 1000);
    setInterval(fullCheckDue, 15 * 60 * 1000);
    setTimeout(incrementalTick, 4 * 60 * 1000);
    setInterval(incrementalTick, Math.max(1, INCREMENTAL_HOURS) * 3600 * 1000);
  }

  // ── Endpoints (admin OR owner — requireAdmin allows both) ──────────────────
  app.post('/admin/collections/run', requireAuth, requireAdmin, async (req, res) => {
    const b = req.body || {};
    const opts = {
      mode: b.full ? 'full' : 'manual', trigger: 'admin',
      location_id: b.location_id ? String(b.location_id) : null,
      limit: b.limit != null ? Math.max(0, parseInt(b.limit, 10) || 0) || null : null,
      force: !!b.force, dry: !!b.dry,
    };
    try {
      if (opts.dry) return res.json(await dryRun(opts));
      if (!provider) return res.status(503).json({ error: `Collections classifier is disabled: no API key for ${MODEL_SPEC}` });
      if (running) return res.status(409).json({ error: 'a collections run is already in progress', running });
      runCollections(opts).catch(() => {});
      res.status(202).json({ ok: true, started: true, mode: opts.mode, model: provider.name });
    } catch (err) {
      console.error('[collections run]', err.message);
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.get('/admin/collections/status', requireAuth, requireAdmin, async (req, res) => {
    try {
      const [recent, ar_jobs, reviewed, errors, needs_owner, not_followed_up] = await Promise.all([
        sbSelect('collections_runs', 'select=id,mode,trigger,model,started_at,finished_at,status,jobs_in_scope,llm_calls,skipped_unchanged,no_activity,errors,input_tokens,output_tokens,thinking_tokens,est_cost_usd&order=started_at.desc&limit=10'),
        sbCount('collections_open_ar', ''),
        sbCount('collections_open_ar', 'reviewed_at=not.is.null'),
        sbCount('collections_open_ar', 'error=not.is.null'),
        sbCount('collections_open_ar', 'needs_owner=is.true'),
        sbCount('collections_open_ar', 'not_followed_up=is.true'),
      ]);
      res.json({
        enabled: ENABLED, model: provider ? provider.name : null, model_spec: MODEL_SPEC, provider: providerKind,
        prompt_version: PROMPT_VERSION, lookback_days: LOOKBACK_DAYS,
        running, last: lastRun || recent.find(r => r.mode !== 'refresh') || null, recent_runs: recent,
        coverage: { ar_jobs, reviewed, errors, needs_owner, not_followed_up },
      });
    } catch (err) {
      console.error('[collections status]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/admin/collections/jobs/:jobId/refresh', requireAuth, requireAdmin, async (req, res) => {
    const jobId = String(req.params.jobId || '');
    if (!uuidRe.test(jobId)) return res.status(400).json({ error: 'invalid job id' });
    try {
      const row = await refreshJob(jobId);
      res.json({ ok: true, review: row });
    } catch (err) {
      console.error('[collections refresh]', err.message);
      res.status(err.status || 500).json({ error: err.message });
    }
  });
};
