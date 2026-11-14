'use strict';
// ── WYH AI reviewer ──────────────────────────────────────────────────────────
// Reads everything we hold about ONE lead → job (JobNimbus notes + fields, the
// job's photos, the CallRail summary / transcript, earlier calls from the same
// number) and suggests the Wash Your Hands checklist answers, each with a
// confidence and a one-line "why". Suggestions land in public.wyh_ai_suggestions
// (DryOps repo supabase/add_wyh_ai.sql) and the app shows them as chips the
// manager accepts or overrides; nothing is written to JobNimbus.
//
// A lead is a call, a Google LSA text thread (the thread replaces the transcript)
// or a JobNimbus job with nothing behind it (a referral: no call questions),
// owner 2026-11-14. Suggestions key on call_id / conversation_id / lead_job_id
// (DryOps supabase/add_wyh_ai_leads.sql); until that SQL runs, only calls.
//
// For an answered call (or a replied text) with NO job it only does job matching: the model reads
// the transcript / summary against the jobs created at that location around
// the call and ranks the ones that look like the same customer (entered under
// another name or number).
//
// Learning loop: the owner's house rules (wyh_ai_settings.instructions) and the
// managers' corrections (wyh_ai_feedback rows with a reason) are folded into
// the system prompt on every run, and the inputs hash includes both, so an
// edit or a new correction re-reads the open calls on the next pass.
//
// Sibling of monitor.js (scope → inputs → hash → one LLM call per changed call
// → audit row). Schedules: incremental every WYH_AI_INCREMENTAL_HOURS between
// 06:00 and 20:00 America/Denver, full pass once per Denver day at
// WYH_AI_FULL_HOUR; WYH_AI_DISABLED=1 or wyh_ai_settings.enabled=false turns
// the schedulers off (endpoints keep working). Spend guards:
// WYH_AI_MAX_LLM_JOBS / WYH_AI_MAX_COST_USD.

const crypto = require('crypto');
const { z } = require('zod');
const {
  PRICES, DEFAULT_SPEC, envNum, envBool, isHuman, plainNote, isoDay, clip, uuidRe, runPool, withRetry,
  makeProvider, fetchActivities: fetchActs, groupActsByJob, notesHash,
} = require('./noteReader');

const PROMPT_VERSION = 'w1';
// The app's own not-a-lead reasons (DryOps lib/wyh.ts NOT_LEAD_REASONS); a manager confirms the AI's pick.
const NOT_LEAD_REASONS = ['Spam / robocall', 'Vendor or sales call', 'Existing customer', 'Wrong number', 'Other']; // bump to re-read every call on the next full run

// Every answer the checklist asks, as { value, confidence, why }.
const sug = (v) => z.object({ value: v.nullable(), confidence: z.number(), why: z.string().nullable() });
const WyhSuggestionSchema = z.object({
  call_taken_by_name: sug(z.string()),
  call_handled: sug(z.boolean()),
  call_missed_reason: z.string().nullable(),
  walked: sug(z.enum(['yes', 'no', 'not_yet'])),
  walk_reason: z.enum(['customer_cancelled', 'scheduled_later', 'other']).nullable(),
  walk_scheduled_for: z.string().nullable(),
  landed: sug(z.boolean()),
  not_landed_reason: z.enum(['quote', 'no_damage', 'coach_to_convert', 'other']).nullable(),
  not_landed_note: z.string().nullable(),
  photo_moisture: sug(z.boolean()),
  photo_damage: sug(z.boolean()),
  photo_wide: sug(z.boolean()),
  insurance: sug(z.enum(['yes', 'no', 'pending'])),
  insurance_note: z.string().nullable(),
  has_carrier: sug(z.boolean()),
  has_claim: sug(z.boolean()),
  tested: sug(z.boolean()),
  not_tested_reason: z.enum(['refused', 'results_provided', 'other']).nullable(),
  year_built: z.number().nullable(),
  packout_sold: sug(z.boolean()),
  no_packout_reason: z.enum(['small_area', 'empty_rooms', 'content_manipulation', 'other']).nullable(),
  info_sufficient: sug(z.boolean()),
  info_missing: z.string().nullable(),
  general_notes: z.string().nullable(),
  needs_follow_up: sug(z.boolean()),
  follow_up_reason: z.enum(['major_concerns', 'file_incomplete', 'other']).nullable(),
  follow_up_note: z.string().nullable(),
  job_match: z.object({
    caller_name: z.string().nullable(),
    address: z.string().nullable(),
    candidates: z.array(z.object({ job_id: z.string(), score: z.number(), why: z.string() })),
  }).nullable(),
  lead_verdict: z.object({
    value: z.enum(['lead', 'not_lead']).nullable(),
    reason: z.enum(NOT_LEAD_REASONS).nullable(),
    confidence: z.number(),
    why: z.string().nullable(),
  }).nullable(),
  summary: z.string(),
});

const QUESTIONS = ['call_taken_by_name', 'call_handled', 'walked', 'landed', 'photo_moisture', 'photo_damage', 'photo_wide', 'insurance', 'has_carrier', 'has_claim', 'tested', 'packout_sold', 'info_sufficient', 'needs_follow_up', 'job_match'];

const BASE_PROMPT = `You are the reviewer behind "Wash Your Hands" (WYH) at a water-damage mitigation company. An expansion manager reviews every inbound phone call that became a JobNimbus job and checks that the operating partner did the right things. You read everything the company holds about ONE call and its job — the JobNimbus notes (newest first, each with a "when" date and an author), the job's fields, the job's photos (attached as images, oldest first), the CallRail call summary and transcript, and earlier calls from the same phone number — and you SUGGEST the checklist answers. A human confirms every answer, so be honest about confidence: 0.9+ only when a note, field, photo or transcript states it outright; 0.5–0.8 when you infer it; below 0.5 when you are guessing. Never invent dates, names, carriers or claim numbers. When the file is silent on a question, return value null with a low confidence and say so in "why". Every "why" is one short sentence (max 160 characters) naming the evidence: the note's "when" and author, the field, "photo 3", or "transcript".

call_taken_by_name: the staff member who answered the call, from the transcript ("Agent Tarek") or a note; null if unknown.
call_handled: true when the call was answered promptly, the caller's name, number and address were taken, an inspection was offered and scheduled, and no price was quoted over the phone; false when the agent took the call off of Google, gave a price, failed to offer an inspection, or lost the caller. call_missed_reason: when false, what should have happened (max 200 characters), else null.
walked: "yes" when a note, photo or field shows the job was inspected or work started on site; "not_yet" when an inspection is scheduled for a later date (walk_reason "scheduled_later", walk_scheduled_for YYYY-MM-DD); "no" when the notes say the customer cancelled (walk_reason "customer_cancelled") or the job was never inspected for another reason (walk_reason "other"). Null when nothing says.
landed: true when the job was sold — a work authorization signed, demo or drying started, equipment placed, status In Progress / Work Complete or later. false when the notes say the customer declined, went with another company, only wanted a quote (not_landed_reason "quote"), no damage was found ("no_damage"), or the partner should have been coached ("coach_to_convert"); "other" with not_landed_note otherwise. Answer only when walked is "yes".
photo_moisture / photo_damage / photo_wide: judge ONLY from the attached photos: true when at least one photo shows a moisture meter reading, visible water damage, or a wide shot of a whole room respectively. When no photos were attached, return null for all three with confidence 0.
insurance: "yes" when the job is an insurance claim (field insurance_type, a carrier, a claim number, adjuster notes); "no" when it is self-pay / cash; "pending" when the notes say the claim is being filed or coverage is not decided (insurance_note: what is pending). Answer only when landed is true.
has_carrier / has_claim: true when the job's insurer field / claim_number field is filled (the fields are given to you); a note naming the carrier does not count as filled.
tested: true when asbestos / lead testing was done or results are in the file; false when it was refused (not_tested_reason "refused"), results were provided by someone else ("results_provided"), or skipped for another reason ("other"). year_built when a note states it. Answer only when insurance is "yes".
packout_sold: true when a contents packout / Contents job was sold or referred; false with no_packout_reason "small_area", "empty_rooms", "content_manipulation" (the customer asked for content manipulation instead) or "other". Answer only when insurance is "yes".
info_sufficient: a general judgement, not a fixed list of fields: true when the JobNimbus file (fields, notes, photos) tells the office and the crew enough to work the job; false when it is thin, with info_missing naming what a manager would want added.
general_notes: 1–3 sentences the manager would tell the partner — the one or two things that matter most on this file (max 400 characters); null when nothing stands out.
needs_follow_up: true when the file has major concerns (lost job that should have landed, price given over the phone, customer complaint) or is too incomplete to review (follow_up_reason "major_concerns" / "file_incomplete" / "other", follow_up_note why); false otherwise.
job_match: ONLY for a call that has no JobNimbus job. From the transcript / summary, extract the caller's name and the property address, then compare against "candidate_jobs" (jobs created at the same location around the call). Return the candidates that are the same customer or property with score 0–1 and why; an empty array when none fit. For a call that already has a job return null.
lead_verdict: ONLY for a lead that has no JobNimbus job (null when it has one). "not_lead" when the call or texts show it is not a water-damage customer: a robocall or spam ("Spam / robocall"), a vendor, recruiter or sales pitch ("Vendor or sales call"), an existing customer about a job already under way ("Existing customer"), a wrong number ("Wrong number"), anything else ("Other"); "lead" when someone describes damage, a leak or asks for service. reason only with "not_lead". Null when the transcript, summary or thread does not say enough to tell. A manager confirms every "not_lead" before it counts, so a confident wrong answer costs them a correction: be strict.
summary: max 200 characters, factual.

The lead is one of three kinds ("lead.type"): "call", a phone call as above; "text", a Google LSA text thread the customer started: "call.text_thread" (oldest first; "us" lines name who replied) replaces the transcript, call_taken_by_name is whoever replied first, and call_handled judges the replies the same way (a prompt reply, name, number and address taken, an inspection offered, no price given); "job", a JobNimbus job with no call or text behind it (a referral; "call" is null): return null with confidence 0 for call_taken_by_name and call_handled, and judge the rest from the job, its notes and photos.

Return JSON only, matching the schema exactly.`;

// ── Prompt assembly: house rules + lessons from corrections ─────────────────
function lessonLine(f) {
  const s = f.suggested && typeof f.suggested === 'object' ? f.suggested.value : f.suggested;
  const v = f.final && typeof f.final === 'object' ? f.final.value : f.final;
  return `- ${f.question}: suggested ${JSON.stringify(s)}, the manager chose ${JSON.stringify(v)}${f.reason ? ` — "${String(f.reason).trim().slice(0, 200)}"` : ''}`;
}
function buildSystemPrompt(base, settings, lessons, accuracy) {
  const parts = [base];
  const rules = settings && String(settings.instructions || '').trim();
  if (rules) parts.push(`House rules from the owner (these override the defaults above):\n${rules.slice(0, 6000)}`);
  if (lessons && lessons.length) parts.push(`Lessons from recent manager corrections (newest first; do not repeat these mistakes):\n${lessons.map(lessonLine).join('\n')}`);
  const weak = Object.entries(accuracy || {}).filter(([, a]) => a.total >= 5 && a.accepted / a.total < 0.7).map(([q, a]) => `${q} (${Math.round(100 * a.accepted / a.total)}% accepted)`);
  if (weak.length) parts.push(`Questions managers most often override, be extra careful: ${weak.join(', ')}.`);
  return parts.join('\n\n');
}
function accuracyFrom(feedback) {
  const acc = {};
  for (const f of feedback) {
    const a = acc[f.question] || (acc[f.question] = { total: 0, accepted: 0 });
    a.total++; if (f.accepted) a.accepted++;
  }
  return acc;
}

// ── Inputs ───────────────────────────────────────────────────────────────────
const daysBetween = (a, b) => (new Date(a).getTime() - new Date(b).getTime()) / 86400000;

function buildPayload({ subject = 'call', call, job, notes, callrail, thread, priorCalls, candidates, photosAttached, today }) {
  const prior = (priorCalls || []).map(p => ({ when: p.start_time, answered: p.answered, summary: clip(p.call_summary, 300) }));
  return {
    today,
    lead: subject === 'job' ? { type: 'job', lead_type: job ? job.lead_type : null, created: job ? job.jn_created : null } : { type: subject },
    call: subject === 'job' ? null : subject === 'text' ? {
      when: call.start_time, replied: !!call.answered, replied_by: clip(call.replied_by, 60), reply_minutes: call.reply_minutes ?? null,
      texter: clip(call.customer_name, 80), phone: call.customer_phone_number, tags: call.tags || [],
      text_thread: thread || [],
      prior_calls_same_number: prior,
    } : {
      when: call.start_time, answered: call.answered, voicemail: call.voicemail, duration_sec: call.duration,
      caller: clip(call.customer_name, 80), phone: call.customer_phone_number, tags: call.tags || [],
      summary: clip((callrail && callrail.summary) || call.call_summary, 2000),
      transcript: clip(callrail && callrail.transcript, 6000),
      prior_calls_same_number: prior,
    },
    job: job ? {
      number: job.number, name: clip(job.name, 120), status: job.status, stage: job.stage,
      insurance_type: job.insurance_type, insurer: job.insurer, claim_number: job.claim_number, tested: job.tested,
      date_loss: job.date_loss, cat: job.cat, loss_type: job.loss_type, lead_type: job.lead_type, sales_rep: job.sales_rep,
      created: job.jn_created, days_call_to_job: job.jn_created && call && subject !== 'job' ? Math.round(daysBetween(job.jn_created, call.start_time) * 10) / 10 : null,
      inspection_state: job._inspection_state || 'none', inspection_date: job._inspection_date || null,
      photos_attached: photosAttached,
    } : null,
    notes: notes || [],
    candidate_jobs: candidates || undefined,
  };
}
const userText = (payload) => JSON.stringify(payload, null, 1);

// Evenly sample up to n items keeping first and last.
function sample(list, n) {
  if (n <= 0) return [];
  if (list.length <= n) return list;
  if (n === 1) return [list[0]];
  const out = [];
  for (let i = 0; i < n; i++) out.push(list[Math.round(i * (list.length - 1) / (n - 1))]);
  return [...new Set(out)];
}

/** The model's lead / not-a-lead call, cleaned: a not-a-lead without a known reason is "Other". */
function cleanVerdict(v) {
  if (!v || typeof v !== 'object' || !['lead', 'not_lead'].includes(v.value)) return null;
  return {
    value: v.value,
    reason: v.value === 'not_lead' ? (NOT_LEAD_REASONS.includes(v.reason) ? v.reason : 'Other') : null,
    confidence: Math.max(0, Math.min(1, Number(v.confidence) || 0)),
    why: clip(v.why, 160),
  };
}
const pick = (s) => (s && typeof s === 'object' ? { value: s.value ?? null, confidence: Math.max(0, Math.min(1, Number(s.confidence) || 0)), why: clip(s.why, 160) } : { value: null, confidence: 0, why: null });
function cleanSuggestions(llm, hasJob, subject = 'call') {
  const out = {};
  for (const q of ['call_taken_by_name', 'call_handled', 'walked', 'landed', 'photo_moisture', 'photo_damage', 'photo_wide', 'insurance', 'has_carrier', 'has_claim', 'tested', 'packout_sold', 'info_sufficient', 'needs_follow_up']) out[q] = pick(llm[q]);
  if (!hasJob) for (const q of Object.keys(out)) out[q] = { value: null, confidence: 0, why: null };
  // A job lead has no call to judge.
  if (subject === 'job') for (const q of ['call_taken_by_name', 'call_handled']) out[q] = { value: null, confidence: 0, why: null };
  out.call_missed_reason = subject === 'job' ? null : clip(llm.call_missed_reason, 200);
  out.walk_reason = llm.walk_reason || null;
  out.walk_scheduled_for = /^\d{4}-\d{2}-\d{2}$/.test(String(llm.walk_scheduled_for || '')) ? llm.walk_scheduled_for : null;
  out.not_landed_reason = llm.not_landed_reason || null; out.not_landed_note = clip(llm.not_landed_note, 200);
  out.insurance_note = clip(llm.insurance_note, 200);
  out.not_tested_reason = llm.not_tested_reason || null;
  out.year_built = Number.isFinite(Number(llm.year_built)) && Number(llm.year_built) > 1800 ? Math.round(Number(llm.year_built)) : null;
  out.no_packout_reason = llm.no_packout_reason || null;
  out.info_missing = clip(llm.info_missing, 200);
  out.general_notes = clip(llm.general_notes, 400);
  out.follow_up_reason = llm.follow_up_reason || null; out.follow_up_note = clip(llm.follow_up_note, 200);
  out.summary = clip(llm.summary, 200);
  return out;
}

function mountWyhAi(app, deps) {
  const {
    SUPABASE_URL, SUPABASE_SERVICE_KEY, jnGet, jnFetchUpdatedSince, jnListJobImages, jnDownloadFile, refreshJobByJnId,
    sbSelect, sbInsert, sbPatch, requireAuth, requireAdmin, loadActor, anthropic, denverNow,
    callrailApi, callrailAccountsFor, callrailBudget, CALLRAIL_ACCOUNT_IDS,
  } = deps;

  const MODEL_SPEC = process.env.WYH_AI_MODEL || DEFAULT_SPEC;
  let provider = null, modelName = MODEL_SPEC, providerKind = '';
  try {
    const p = makeProvider(MODEL_SPEC, anthropic, { schema: WyhSuggestionSchema, systemPrompt: BASE_PROMPT, thinkingEnv: 'WYH_AI_GEMINI_THINKING', envName: 'WYH_AI_MODEL', maxOutputTokens: 4096 });
    provider = p.provider; modelName = p.model; providerKind = p.kind;
  } catch (err) { console.error('[wyh-ai]', err.message); }
  const SCHEDULERS = !!provider && !envBool('WYH_AI_DISABLED', false);
  const CALL_DAYS = envNum('WYH_AI_CALL_DAYS', 21);
  const NOJOB_DAYS = envNum('WYH_AI_NOJOB_DAYS', 7);
  const EXISTING_JOB_DAYS = 14;
  const LOOKBACK_DAYS = envNum('WYH_AI_LOOKBACK_DAYS', 60);
  const NOTES_PER_JOB = envNum('WYH_AI_NOTES_PER_JOB', 25);
  const NOTE_CHARS = envNum('WYH_AI_NOTE_CHARS', 600);
  const PHOTOS_DEFAULT = envNum('WYH_AI_PHOTOS', 12);
  const LLM_CONCURRENCY = envNum('WYH_AI_LLM_CONCURRENCY', 3);
  const JN_CONCURRENCY = envNum('WYH_AI_JN_CONCURRENCY', 3);
  const MAX_LLM_JOBS = envNum('WYH_AI_MAX_LLM_JOBS', 300);
  const MAX_COST_USD = envNum('WYH_AI_MAX_COST_USD', 2);
  const FULL_HOUR = envNum('WYH_AI_FULL_HOUR', 4);
  const INCREMENTAL_HOURS = envNum('WYH_AI_INCREMENTAL_HOURS', 2);
  const INCREMENTAL_WINDOW = [6, 20];
  const [PRICE_IN, PRICE_OUT] = [
    envNum('WYH_AI_PRICE_IN', (PRICES[modelName] || [0, 0])[0]),
    envNum('WYH_AI_PRICE_OUT', (PRICES[modelName] || [0, 0])[1]),
  ];
  const costOf = (u) => (u.input * PRICE_IN + (u.output + u.thinking) * PRICE_OUT) / 1e6;
  const warn = (...a) => console.warn('[wyh-ai]', ...a);

  if (!provider) warn(`disabled: no API key for ${MODEL_SPEC}`);
  else console.log(`[wyh-ai] model ${provider.name}; schedulers ${SCHEDULERS ? 'on' : 'off'}`);

  const sbHeaders = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` };
  async function sbPaged(table, query) {
    const out = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await sbSelect(table, `${query}&limit=1000&offset=${offset}`);
      out.push(...page);
      if (page.length < 1000) break;
    }
    return out;
  }
  // One row per lead, keyed on its own column (the shared sbBulkUpsert keys on jn_id).
  const KEY_COLS = ['call_id', 'conversation_id', 'lead_job_id'];
  const keyColOf = (row) => KEY_COLS.find(c => row[c]) || 'call_id';
  async function upsertSuggestions(rows) {
    if (!rows.length) return;
    for (const col of KEY_COLS) {
      const uniq = [...new Map(rows.filter(r => keyColOf(r) === col).map(r => [r[col], r])).values()];
      if (!uniq.length) continue;
      const r = await fetch(`${SUPABASE_URL}/rest/v1/wyh_ai_suggestions?on_conflict=${col}`, {
        method: 'POST', headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(uniq),
      });
      if (!r.ok) throw new Error(`wyh_ai_suggestions upsert ${r.status} ${(await r.text()).slice(0, 200)}`);
    }
  }
  // Texts and job leads need the columns from add_wyh_ai_leads.sql; until then, calls only.
  let leadsReadyAt = 0; let leadsReady = false;
  async function leadsSupported() {
    if (leadsReady || Date.now() - leadsReadyAt < 10 * 60 * 1000) return leadsReady;
    leadsReadyAt = Date.now();
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/wyh_ai_suggestions?select=conversation_id,lead_job_id&limit=1`, { headers: sbHeaders });
      const f = await fetch(`${SUPABASE_URL}/rest/v1/wyh_ai_feedback?select=conversation_id,lead_job_id&limit=1`, { headers: sbHeaders });
      leadsReady = r.ok && f.ok;
    } catch { leadsReady = false; }
    if (!leadsReady) warn('texts and job leads wait for add_wyh_ai_leads.sql');
    return leadsReady;
  }
  async function inChunks(table, col, ids, select, extra = '') {
    const out = [];
    for (let i = 0; i < ids.length; i += 80) {
      const list = ids.slice(i, i + 80).map(encodeURIComponent).join(',');
      out.push(...await sbSelect(table, `select=${select}&${col}=in.(${list})${extra}`));
    }
    return out;
  }
  const denverDay = () => { const { y, m, d } = denverNow(); return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; };

  // ── Settings, lessons ──────────────────────────────────────────────────────
  async function loadSettings() {
    const [row] = await sbSelect('wyh_ai_settings', 'select=*&id=eq.1').catch(() => []);
    return row || { enabled: false, instructions: '', photos_per_job: PHOTOS_DEFAULT, updated_at: null };
  }
  async function loadFeedback() {
    const rows = await sbSelect('wyh_ai_feedback', 'select=id,call_id,location_id,question,suggested,final,accepted,reason,created_at&order=created_at.desc&limit=400').catch(() => []);
    return rows;
  }
  function lessonsFor(feedback, locationId) {
    const withReason = feedback.filter(f => f.reason && String(f.reason).trim());
    const local = withReason.filter(f => f.location_id === locationId).slice(0, 12);
    const seen = new Set(local.map(f => f.id));
    const global = withReason.filter(f => !seen.has(f.id)).slice(0, 8);
    return [...local, ...global];
  }

  // ── Scope ──────────────────────────────────────────────────────────────────
  const CALL_COLS = 'id,callrail_id,start_time,answered,voicemail,duration,customer_name,customer_phone_number,customer_phone_norm,tags,call_summary,location_id,job_id,job_linked_at';
  // No `cause` column on jobs (prod 2026-10-27): the cause of loss comes from
  // the notes; `loss_type` (water / fire…) is the closest mirrored field.
  const JOB_COLS = 'id,jn_id,number,name,client_name,status,stage,insurance_type,insurer,claim_number,tested,date_loss,cat,loss_type,lead_type,sales_rep,jn_created,location_id,address,client_phone_norm';
  // `call_id` / `conversation_id` / `lead_job_id` narrow it to one lead (the Re-run button).
  async function selectTargets({ location_id = null, call_id = null, conversation_id = null, lead_job_id = null } = {}) {
    const since = new Date(Date.now() - CALL_DAYS * 86400000).toISOString();
    const one = call_id || conversation_id || lead_job_id;
    const leads = await leadsSupported();
    const locs = new Map((await sbPaged('locations', 'select=id,name,location_type,timezone')).map(l => [l.id, l]));
    const isMit = (locId) => { const l = locs.get(String(locId || '')); return !!l && (l.location_type == null || l.location_type === 'Mitigation'); };
    const atLoc = (col) => (location_id ? `&${col}=eq.${encodeURIComponent(location_id)}` : '');

    // Calls.
    const calls = one && !call_id ? [] : await sbPaged('calls', `select=${CALL_COLS}&direction=eq.inbound&location_id=not.is.null&start_time=gte.${since}`
      + atLoc('location_id') + (call_id ? `&id=eq.${encodeURIComponent(call_id)}` : '') + '&order=start_time.desc');
    const mit = calls.filter(c => isMit(c.location_id));

    // Google LSA text threads the customer started (same rule as the wyh_messages feed).
    let texts = [];
    if (leads && (!one || conversation_id)) {
      const rows = await sbPaged('sms_conversations', `select=id,first_inbound_at,first_reply_at,first_reply_by_name,customer_name,customer_phone_number,customer_phone_norm,location_id,job_id`
        + `&location_id=not.is.null&first_inbound_at=gte.${since}&source=ilike.${encodeURIComponent('Google Local Services*')}`
        + atLoc('location_id') + (conversation_id ? `&id=eq.${encodeURIComponent(conversation_id)}` : '') + '&order=first_inbound_at.desc');
      const ours = rows.filter(c => isMit(c.location_id));
      const firstOut = new Map();
      for (const m of await inChunks('sms_messages', 'conversation_id', ours.map(c => c.id), 'conversation_id,created_at', '&direction=eq.outbound&order=created_at.asc')) {
        if (!firstOut.has(m.conversation_id)) firstOut.set(m.conversation_id, m.created_at);
      }
      texts = ours.filter(c => !(firstOut.get(c.id) && firstOut.get(c.id) < c.first_inbound_at));
    }

    // JobNimbus Mitigation jobs with no call or text behind them (same rule as the wyh_job_leads feed).
    let leadJobs = [];
    if (leads && (!one || lead_job_id)) {
      const rows = await sbPaged('jobs', `select=${JOB_COLS},record_type&jn_created=gte.${since}&or=(record_type.is.null,record_type.eq.Mitigation,record_type.eq.)`
        + atLoc('location_id') + (lead_job_id ? `&id=eq.${encodeURIComponent(lead_job_id)}` : '') + '&order=jn_created.desc');
      const ours = rows.filter(j => isMit(j.location_id));
      const ids = ours.map(j => j.id);
      const behind = new Set([
        ...(await inChunks('calls', 'job_id', ids, 'job_id')).map(r => r.job_id),
        ...(await inChunks('sms_conversations', 'job_id', ids, 'job_id')).map(r => r.job_id),
      ]);
      const ownReview = new Set((await inChunks('wyh_reviews', 'lead_job_id', ids, 'lead_job_id')).map(r => r.lead_job_id));
      leadJobs = ours.filter(j => ownReview.has(j.id) || !behind.has(j.id));
    }

    const jobIds = [...new Set([...mit.map(c => c.job_id), ...texts.map(c => c.job_id)].filter(Boolean))];
    const jobs = new Map((await inChunks('jobs', 'id', jobIds, JOB_COLS)).map(j => [j.id, j]));
    for (const j of leadJobs) jobs.set(j.id, j);
    const allJobIds = [...jobs.keys()];
    const REVIEW_COLS = 'call_id,conversation_id,lead_job_id,status,kind,completed_manually';
    const reviews = new Map((await inChunks('wyh_reviews', 'call_id', mit.map(c => c.id), REVIEW_COLS)).map(r => [`call_id:${r.call_id}`, r]));
    for (const r of await inChunks('wyh_reviews', 'conversation_id', texts.map(c => c.id), REVIEW_COLS)) reviews.set(`conversation_id:${r.conversation_id}`, r);
    for (const r of await inChunks('wyh_reviews', 'lead_job_id', leadJobs.map(j => j.id), REVIEW_COLS)) reviews.set(`lead_job_id:${r.lead_job_id}`, r);
    const insp = await inChunks('inspections', 'job_id', allJobIds, 'job_id,status,scheduled_date', '&task_type=eq.inspection&status=neq.cancelled');
    for (const i of insp) {
      const j = jobs.get(i.job_id); if (!j) continue;
      if (i.status === 'completed') { j._inspection_state = 'completed'; j._inspection_date = i.scheduled_date; }
      else if (j._inspection_state !== 'completed') { j._inspection_state = 'scheduled'; j._inspection_date = i.scheduled_date; }
    }
    const nojobSince = Date.now() - NOJOB_DAYS * 86400000;
    const targets = [];
    const lead = (subject, col, id, call, job, kind) => ({ subject, col, id, ref: `${col}:${id}`, call, job, loc: locs.get(String(call.location_id)), kind });
    for (const c of mit) {
      const r = reviews.get(`call_id:${c.id}`);
      if (r && r.kind === 'not_lead') continue;
      if (c.job_id) {
        const j = jobs.get(c.job_id);
        if (!j || !j.jn_id) continue;
        if (r && r.status === 'complete') continue;
        // Another location landed this caller (same number rang several locations):
        // not this call's job unless a manager linked it by hand (app add_wyh_landed_elsewhere.sql).
        if (j.location_id && j.location_id !== c.location_id && !c.job_linked_at) continue;
        if (j.jn_created && daysBetween(c.start_time, j.jn_created) > EXISTING_JOB_DAYS) continue; // repeat call on an old job
        targets.push(lead('call', 'call_id', c.id, c, j, 'wyh'));
      } else if (c.answered === true && !c.voicemail && new Date(c.start_time).getTime() >= nojobSince) {
        targets.push(lead('call', 'call_id', c.id, c, null, 'match'));
      }
    }
    for (const t of texts) {
      const r = reviews.get(`conversation_id:${t.id}`);
      if (r && (r.kind === 'not_lead' || r.status === 'complete')) continue;
      const call = {
        id: t.id, start_time: t.first_inbound_at, answered: !!t.first_reply_at, voicemail: false, duration: null,
        customer_name: t.customer_name, customer_phone_number: t.customer_phone_number, customer_phone_norm: t.customer_phone_norm,
        tags: ['LSA message'], call_summary: null, location_id: t.location_id, job_id: t.job_id,
        replied_by: t.first_reply_by_name || null,
        reply_minutes: t.first_reply_at ? Math.max(0, Math.round((new Date(t.first_reply_at) - new Date(t.first_inbound_at)) / 60000)) : null,
      };
      const j = t.job_id ? jobs.get(t.job_id) : null;
      if (j && j.jn_id) targets.push(lead('text', 'conversation_id', t.id, call, j, 'wyh'));
      else if (!t.job_id && t.first_reply_at && new Date(t.first_inbound_at).getTime() >= nojobSince) targets.push(lead('text', 'conversation_id', t.id, call, null, 'match'));
    }
    for (const j of leadJobs) {
      const r = reviews.get(`lead_job_id:${j.id}`);
      if (!j.jn_id || (r && (r.kind === 'not_lead' || r.status === 'complete'))) continue;
      const call = { id: j.id, start_time: j.jn_created, location_id: j.location_id, customer_name: j.client_name, customer_phone_number: null, customer_phone_norm: j.client_phone_norm, tags: [j.lead_type || 'No lead type'] };
      targets.push(lead('job', 'lead_job_id', j.id, call, jobs.get(j.id) || j, 'wyh'));
    }
    return targets;
  }
  async function prevRows(targets) {
    const out = new Map();
    for (const col of KEY_COLS) {
      const ids = targets.filter(t => t.col === col).map(t => t.id);
      if (!ids.length) continue;
      for (const r of await inChunks('wyh_ai_suggestions', col, ids, `${col},inputs_hash,error,reviewed_at`)) out.set(`${col}:${r[col]}`, r);
    }
    return out;
  }

  // ── Per-call inputs ────────────────────────────────────────────────────────
  async function callrailDetails(callrailId) {
    if (!callrailApi || !callrailId) return null;
    // The owning account first (asking each in turn spent a request per account).
    const accounts = callrailAccountsFor ? await callrailAccountsFor(callrailId) : (CALLRAIL_ACCOUNT_IDS || []);
    for (const acct of accounts) {
      try {
        const r = await callrailApi(acct, `calls/${encodeURIComponent(callrailId)}.json?fields=call_summary,transcription`);
        if (r.ok && r.json) {
          const t = r.json.transcription;
          const transcript = typeof t === 'string' ? t : Array.isArray(t) ? t.map(x => (x && (x.text || x.content)) || '').join(' ') : t && typeof t === 'object' ? JSON.stringify(t).slice(0, 6000) : null;
          return { summary: r.json.call_summary || null, transcript: transcript || null };
        }
      } catch (e) { warn('callrail details', e.message); }
    }
    return null;
  }
  /** A text thread as the model reads it: oldest first, who said what. */
  async function threadFor(conversationId) {
    const rows = await sbSelect('sms_messages', `select=direction,content,created_at,sent_by_name&conversation_id=eq.${encodeURIComponent(conversationId)}&order=created_at.asc&limit=60`).catch(() => []);
    return rows.map(m => ({ when: m.created_at, from: m.direction === 'inbound' ? 'customer' : `us${m.sent_by_name ? ` (${clip(m.sent_by_name, 40)})` : ''}`, text: clip(m.content, 600) }));
  }
  async function priorCallsFor(call) {
    if (!call.customer_phone_norm) return [];
    const since = new Date(new Date(call.start_time).getTime() - 30 * 86400000).toISOString();
    return sbSelect('calls', `select=start_time,answered,call_summary&customer_phone_norm=eq.${encodeURIComponent(call.customer_phone_norm)}&start_time=lt.${encodeURIComponent(call.start_time)}&start_time=gte.${since}&direction=eq.inbound&order=start_time.desc&limit=5`).catch(() => []);
  }
  async function candidateJobsFor(call) {
    const lo = new Date(new Date(call.start_time).getTime() - 3 * 86400000).toISOString();
    const hi = new Date(new Date(call.start_time).getTime() + 10 * 86400000).toISOString();
    const rows = await sbSelect('jobs', `select=id,number,name,client_name,address,status,jn_created,client_phone_norm&location_id=eq.${encodeURIComponent(call.location_id)}&jn_created=gte.${lo}&jn_created=lte.${hi}&order=jn_created.desc&limit=40`).catch(() => []);
    return rows.map(j => ({ job_id: j.id, number: j.number, name: clip(j.name, 100), client_name: clip(j.client_name, 80), address: clip(j.address, 120), status: j.status, created: j.jn_created }));
  }
  async function photosFor(job, n) {
    if (!n || !jnListJobImages || !jnDownloadFile) return { images: [], ids: [], total: 0 };
    let files = [];
    try { files = await jnListJobImages(job.jn_id); } catch (e) { warn('photos list', job.number, e.message); return { images: [], ids: [], total: 0 }; }
    const chosen = sample(files, n);
    const sharp = require('sharp');
    const images = [];
    for (let i = 0; i < chosen.length; i++) {
      const f = chosen[i];
      try {
        const buf = await jnDownloadFile(f.jnid || f.id);
        const small = await sharp(buf).rotate().resize({ width: 768, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
        images.push({ mime: 'image/jpeg', data: small.toString('base64'), caption: `Photo ${i + 1} of ${chosen.length} · ${clip(f.filename, 60) || 'image'} · uploaded ${isoDay(f.date_created)}` });
      } catch (e) { warn('photo', job.number, e.message); }
    }
    return { images, ids: chosen.map(f => f.jnid || f.id), total: files.length };
  }
  function inputsHash(parts) {
    const h = crypto.createHash('sha1');
    for (const p of parts) h.update(String(p == null ? '' : p) + '|');
    return h.digest('hex');
  }

  // Build everything the model sees for one target. `stats.jn_requests` counts.
  async function buildInput(t, ctx, stats) {
    const { settings, feedback, nowISO, today } = ctx;
    const photosN = t.kind === 'wyh' ? Math.max(0, Math.min(24, Number(settings.photos_per_job ?? PHOTOS_DEFAULT))) : 0;
    let notes = []; let fp = null;
    if (t.job) {
      // Fresh fields first: the webhook misses custom-field edits (claim #,
      // carrier…), so pull the job from JobNimbus before judging it.
      if (refreshJobByJnId) {
        try {
          const fresh = await refreshJobByJnId(t.job.jn_id);
          stats.jn_requests++;
          if (fresh) Object.assign(t.job, { status: fresh.status, insurer: fresh.insurer, claim_number: fresh.claim_number, insurance_type: fresh.insurance_type, tested: fresh.tested, date_loss: fresh.date_loss, cat: fresh.cat, lead_type: fresh.lead_type, sales_rep: fresh.sales_rep, name: fresh.name, number: fresh.number });
        } catch (e) { warn('job refresh', t.job.number, e.message); }
      }
      const sinceSecs = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86400;
      const acts = (await fetchActs({ jnGet, tag: 'wyh-ai' }, [t.job.jn_id], sinceSecs, stats)).filter(isHuman).sort((x, y) => (y.date_created || 0) - (x.date_created || 0)).slice(0, NOTES_PER_JOB);
      fp = notesHash(PROMPT_VERSION, acts);
      notes = acts.map(a => ({ when: isoDay(a.date_created), by: clip(a.created_by_name, 60), text: plainNote(a.note).slice(0, NOTE_CHARS) }));
    }
    const subject = t.subject || 'call';
    const callrail = subject === 'call' ? await callrailDetails(t.call.callrail_id) : null;
    const thread = subject === 'text' ? await threadFor(t.call.id) : null;
    const prior = subject === 'job' ? [] : await priorCallsFor(t.call);
    const candidates = t.kind === 'match' ? await candidateJobsFor(t.call) : null;
    const photos = t.job ? await photosFor(t.job, photosN) : { images: [], ids: [], total: 0 };
    const lessons = lessonsFor(feedback, t.call.location_id);
    const jobStamp = t.job ? [t.job.status, t.job.stage, t.job.insurer, t.job.claim_number, t.job.tested, t.job.date_loss, t.job.cat, t.job.loss_type, t.job._inspection_state, t.job._inspection_date].join('/') : '';
    const threadStamp = thread && thread.length ? `${thread.length}/${thread[thread.length - 1].when}` : '';
    const hash = inputsHash([PROMPT_VERSION, subject, fp, jobStamp, settings.updated_at, (callrail && callrail.transcript ? callrail.transcript.length : 0), (callrail && callrail.summary) || t.call.call_summary, threadStamp, photos.ids.join(','), lessons[0] ? lessons[0].id : '', (candidates || []).map(c => c.job_id).join(',')]);
    const payload = buildPayload({ subject, call: t.call, job: t.job, notes, callrail, thread, priorCalls: prior, candidates, photosAttached: photos.images.length, today });
    const systemPrompt = buildSystemPrompt(BASE_PROMPT, settings, lessons, accuracyFrom(feedback.slice(0, 200)));
    return { t, notes, hash, payload, images: photos.images, photoIds: photos.ids, photosTotal: photos.total, systemPrompt, nowISO };
  }

  function rowFrom(inp, llm, usage) {
    const hasJob = !!inp.t.job;
    const sugg = cleanSuggestions(llm, hasJob, inp.t.subject);
    const verdict = !hasJob ? cleanVerdict(llm.lead_verdict) : null;
    const match = !hasJob && (llm.job_match || verdict) ? {
      caller_name: clip(llm.job_match && llm.job_match.caller_name, 80), address: clip(llm.job_match && llm.job_match.address, 120),
      candidates: ((llm.job_match && llm.job_match.candidates) || []).filter(c => uuidRe.test(String(c.job_id || ''))).slice(0, 5).map(c => ({ job_id: c.job_id, score: Math.max(0, Math.min(1, Number(c.score) || 0)), why: clip(c.why, 160) })),
      // A no-job lead's "is this even a lead?" rides on job_match (no SQL change); the ledger offers it for bulk confirm.
      lead_verdict: verdict,
    } : null;
    return {
      [inp.t.col || 'call_id']: inp.t.id || inp.t.call.id, job_id: inp.t.job ? inp.t.job.id : null, location_id: inp.t.call.location_id,
      inputs_hash: inp.hash, suggestions: hasJob ? sugg : null, job_match: match, photos_used: inp.images.length, photos_total: inp.photosTotal,
      notes_used: inp.notes.length, model: provider.name, prompt_version: PROMPT_VERSION, reviewed_at: inp.nowISO,
      error: null, error_at: null, input_tokens: usage.input, output_tokens: usage.output + usage.thinking, est_cost_usd: Math.round(costOf(usage) * 10000) / 10000,
    };
  }

  // ── The run ────────────────────────────────────────────────────────────────
  let running = null; let lastRun = null;
  async function runWyhAi(opts = {}) {
    const { mode = 'manual', trigger = 'admin', location_id = null, limit = null, force = false, dry = false } = opts;
    if (dry) return dryRun(opts);
    if (!provider) throw new Error(`WYH AI is disabled: no API key for ${MODEL_SPEC}`);
    if (running) { const e = new Error('a WYH AI run is already in progress'); e.status = 409; throw e; }
    const nowISO = new Date().toISOString(); const today = denverDay();
    const stats = { jobs_in_scope: 0, jobs_fetched: 0, llm_calls: 0, skipped_unchanged: 0, no_activity: 0, errors: 0, jn_requests: 0, input_tokens: 0, output_tokens: 0, thinking_tokens: 0 };
    const firstErrors = []; let cost = 0; let aborted = null; let matches = 0;
    const params = { location_id, limit, force };
    const runId = crypto.randomUUID();
    await sbInsert('wyh_ai_runs', { id: runId, mode, trigger, model: provider.name, prompt_version: PROMPT_VERSION, status: 'running', report: { params, denver_day: today } });
    running = { id: runId, mode, started_at: nowISO, progress: { phase: 'selecting', done: 0, total: 0 } };
    const finish = async (status) => {
      const patch = { ...stats, status, finished_at: new Date().toISOString(), est_cost_usd: Math.round(cost * 10000) / 10000, report: { params, denver_day: today, job_matches: matches, first_errors: firstErrors, aborted } };
      lastRun = { id: runId, mode, started_at: nowISO, ...patch, model: provider.name };
      running = null;
      await sbPatch('wyh_ai_runs', `id=eq.${runId}`, patch).catch(err => console.error('[wyh-ai] run patch failed:', err.message));
    };
    try {
      const settings = await loadSettings();
      const feedback = await loadFeedback();
      let targets = await selectTargets({ location_id });
      const prev = await prevRows(targets);
      if (mode === 'incremental') {
        const last = await sbSelect('wyh_ai_runs', 'select=started_at&status=eq.done&mode=in.(full,incremental)&order=started_at.desc&limit=1');
        if (last.length) {
          const sinceSecs = Math.max(Math.floor(new Date(last[0].started_at).getTime() / 1000) - 2 * 3600, Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86400);
          const touched = new Set();
          for (const a of await jnFetchUpdatedSince('/activities', sinceSecs, '&fields=jnid,related,date_updated')) {
            for (const rel of Array.isArray(a.related) ? a.related : []) if (rel && rel.type === 'job' && rel.id) touched.add(rel.id);
          }
          const settingsChanged = settings.updated_at && settings.updated_at > last[0].started_at;
          const feedbackChanged = feedback[0] && feedback[0].created_at > last[0].started_at;
          targets = targets.filter(t => !prev.has(t.ref) || settingsChanged || feedbackChanged || (t.job && touched.has(t.job.jn_id)));
        }
      }
      stats.jobs_in_scope = targets.length;
      running.progress = { phase: 'reading', done: 0, total: targets.length };
      const ctx = { settings, feedback, nowISO, today };
      const queue = limit ? targets.slice(0, limit) : targets;
      const rows = []; const errRows = [];
      await runPool(queue, Math.min(LLM_CONCURRENCY, JN_CONCURRENCY), async (t) => {
        if (aborted) return;
        if (stats.llm_calls >= MAX_LLM_JOBS) { aborted = `max_llm_jobs (${MAX_LLM_JOBS})`; return; }
        if (cost >= MAX_COST_USD) { aborted = `max_cost_usd ($${MAX_COST_USD})`; return; }
        if (stats.llm_calls >= 20 && stats.errors >= 10 && stats.errors / stats.llm_calls > 0.5) { aborted = 'error_rate'; return; }
        try {
          const inp = await buildInput(t, ctx, stats);
          stats.jobs_fetched++;
          const p = prev.get(t.ref);
          if (!force && p && p.inputs_hash === inp.hash && !p.error) { stats.skipped_unchanged++; running.progress.done++; return; }
          const said = inp.payload.call ? (inp.payload.call.summary || (inp.payload.call.text_thread || []).length) : 0;
          if (t.kind === 'wyh' && !inp.notes.length && !inp.images.length && !said) { stats.no_activity++; running.progress.done++; return; }
          stats.llm_calls++;
          const { parsed, usage } = await withRetry(() => provider.classify(userText(inp.payload), { images: inp.images, systemPrompt: inp.systemPrompt }));
          stats.input_tokens += usage.input; stats.output_tokens += usage.output; stats.thinking_tokens += usage.thinking;
          cost += costOf(usage);
          const row = rowFrom(inp, parsed, usage);
          if (row.job_match && row.job_match.candidates.length) matches++;
          rows.push(row);
        } catch (err) {
          stats.errors++;
          if (firstErrors.length < 20) firstErrors.push({ lead: t.ref, job_number: t.job ? t.job.number : null, error: String(err.message).slice(0, 200) });
          errRows.push({ [t.col]: t.id, job_id: t.job ? t.job.id : null, location_id: t.call.location_id, error: String(err.message).slice(0, 300), error_at: nowISO });
        }
        running.progress.done++;
        if (rows.length >= 50) { const chunk = rows.splice(0, rows.length); await upsertSuggestions(chunk).catch(e => console.error('[wyh-ai] flush failed:', e.message)); }
      });
      running.progress = { ...running.progress, phase: 'writing' };
      await upsertSuggestions(rows);
      await upsertSuggestions(errRows);
      console.log(`[wyh-ai] ${mode} done: scope ${stats.jobs_in_scope}, llm ${stats.llm_calls}, unchanged ${stats.skipped_unchanged}, errors ${stats.errors}, ~$${cost.toFixed(3)}${aborted ? `, ABORTED (${aborted})` : ''}`);
      await finish(aborted ? 'aborted' : 'done');
    } catch (err) {
      console.error('[wyh-ai] run failed:', err.message);
      firstErrors.unshift({ fatal: String(err.message).slice(0, 300) });
      await finish('error');
      throw err;
    }
    return lastRun;
  }

  // Dry run: scope + inputs for a few calls, no LLM, no writes, an estimate.
  async function dryRun({ location_id = null, limit = 5 } = {}) {
    const stats = { jn_requests: 0 };
    const settings = await loadSettings(); const feedback = await loadFeedback();
    const targets = await selectTargets({ location_id });
    const prev = await prevRows(targets);
    const sampleT = targets.slice(0, Math.max(1, Math.min(Number(limit) || 5, 25)));
    const ctx = { settings, feedback, nowISO: new Date().toISOString(), today: denverDay() };
    const out = [];
    for (const t of sampleT) {
      const inp = await buildInput(t, ctx, stats);
      const p = prev.get(t.ref);
      const text = userText(inp.payload);
      out.push({ lead: t.ref, subject: t.subject, kind: t.kind, caller: t.call.customer_name, job_number: t.job ? t.job.number : null, notes: inp.notes.length, photos: inp.images.length, transcript: !!(inp.payload.call && (inp.payload.call.transcript || (inp.payload.call.text_thread || []).length)), text_chars: text.length, would_skip: p && p.inputs_hash === inp.hash && !p.error ? 'unchanged' : null, payload: inp.payload, system_prompt_chars: inp.systemPrompt.length });
    }
    const pending = targets.filter(t => { const p = prev.get(t.ref); return !p || p.error; }).length;
    // ~4 chars per token for text, ~260 tokens per image, ~900 output tokens.
    const estTokens = out.length ? out.reduce((s, o) => s + o.text_chars / 4 + o.photos * 260 + 900, 0) / out.length : 0;
    return {
      model: provider ? provider.name : null, schedulers: SCHEDULERS, enabled: !!settings.enabled, photos_per_job: settings.photos_per_job ?? PHOTOS_DEFAULT,
      in_scope: targets.length, wyh_targets: targets.filter(t => t.kind === 'wyh').length, match_targets: targets.filter(t => t.kind === 'match').length, never_reviewed: pending,
      by_subject: { call: targets.filter(t => t.subject === 'call').length, text: targets.filter(t => t.subject === 'text').length, job: targets.filter(t => t.subject === 'job').length },
      est_cost_per_call_usd: Math.round(estTokens * PRICE_IN / 1e6 * 10000) / 10000, est_cost_full_usd: Math.round(estTokens * PRICE_IN / 1e6 * targets.length * 100) / 100,
      jn_requests: stats.jn_requests, sample: out,
    };
  }

  // One lead on demand (the panel's Re-run / Suggest button). `col` = call_id | conversation_id | lead_job_id.
  async function suggestOne(col, id) {
    if (!provider) throw new Error(`WYH AI is disabled: no API key for ${MODEL_SPEC}`);
    if (col !== 'call_id' && !(await leadsSupported())) { const e = new Error('AI for texts and job leads needs add_wyh_ai_leads.sql'); e.status = 503; throw e; }
    const [t] = await selectTargets({ [col]: id });
    if (!t) { const e = new Error('This lead is not reviewable (no job, an old job, or the review is complete)'); e.status = 400; throw e; }
    const settings = await loadSettings(); const feedback = await loadFeedback();
    const stats = { jn_requests: 0 };
    const inp = await buildInput(t, { settings, feedback, nowISO: new Date().toISOString(), today: denverDay() }, stats);
    let row; let usage = { input: 0, output: 0, thinking: 0 }; let error = null;
    try {
      const r = await withRetry(() => provider.classify(userText(inp.payload), { images: inp.images, systemPrompt: inp.systemPrompt }));
      usage = r.usage; row = rowFrom(inp, r.parsed, usage);
    } catch (err) {
      error = String(err.message).slice(0, 300);
      row = { [t.col]: t.id, job_id: t.job ? t.job.id : null, location_id: t.call.location_id, error, error_at: inp.nowISO };
    }
    await upsertSuggestions([row]);
    await sbInsert('wyh_ai_runs', {
      mode: 'refresh', trigger: 'app', model: provider.name, prompt_version: PROMPT_VERSION, status: error ? 'error' : 'done', finished_at: new Date().toISOString(),
      jobs_in_scope: 1, jobs_fetched: 1, llm_calls: 1, errors: error ? 1 : 0, jn_requests: stats.jn_requests,
      input_tokens: usage.input, output_tokens: usage.output, thinking_tokens: usage.thinking, est_cost_usd: Math.round(costOf(usage) * 10000) / 10000, report: { lead: `${col}:${id}`, error },
    }).catch(err => console.error('[wyh-ai] refresh audit failed:', err.message));
    const [fresh] = await sbSelect('wyh_ai_suggestions', `select=*&${col}=eq.${encodeURIComponent(id)}`);
    return fresh || null;
  }

  // ── Schedulers ─────────────────────────────────────────────────────────────
  async function enabledNow() { const s = await loadSettings(); return !!s.enabled; }
  // A scheduled run reads one CallRail call per lead. It waits while any account
  // is over the background share of its request budget (callrailBudget.js): a
  // run with the transcripts missing would re-judge every lead twice.
  function callrailBusy() {
    const busy = !!callrailBudget && (CALLRAIL_ACCOUNT_IDS || []).some(a => !callrailBudget.allowBackground(a));
    if (busy) warn('scheduled run skipped: CallRail request budget');
    return busy;
  }
  async function fullCheckDue() {
    if (!SCHEDULERS || running) return;
    if (denverNow().h !== FULL_HOUR) return;
    try {
      if (!(await enabledNow()) || callrailBusy()) return;
      const prior = await sbSelect('wyh_ai_runs', `select=id&mode=eq.full&status=in.(done,aborted)&report->>denver_day=eq.${denverDay()}&limit=1`);
      if (prior.length) return;
      await runWyhAi({ mode: 'full', trigger: 'schedule' });
    } catch (err) { console.error('[wyh-ai] scheduled full run failed:', err.message); }
  }
  async function incrementalTick() {
    if (!SCHEDULERS || running) return;
    const { h } = denverNow();
    if (h < INCREMENTAL_WINDOW[0] || h >= INCREMENTAL_WINDOW[1]) return;
    try { if ((await enabledNow()) && !callrailBusy()) await runWyhAi({ mode: 'incremental', trigger: 'schedule' }); }
    catch (err) { console.error('[wyh-ai] scheduled incremental failed:', err.message); }
  }
  if (SCHEDULERS) {
    setTimeout(fullCheckDue, 7 * 60 * 1000);
    setInterval(fullCheckDue, 15 * 60 * 1000);
    setTimeout(incrementalTick, 8 * 60 * 1000);
    setInterval(incrementalTick, Math.max(1, INCREMENTAL_HOURS) * 3600 * 1000);
  }

  // ── Endpoints ──────────────────────────────────────────────────────────────
  app.post('/admin/wyh-ai/run', requireAuth, requireAdmin, async (req, res) => {
    const b = req.body || {};
    const opts = { mode: b.full ? 'full' : 'manual', trigger: 'admin', location_id: b.location_id ? String(b.location_id) : null, limit: b.limit != null ? Math.max(0, parseInt(b.limit, 10) || 0) || null : null, force: !!b.force, dry: !!b.dry };
    try {
      if (opts.dry) return res.json(await dryRun(opts));
      if (!provider) return res.status(503).json({ error: `WYH AI is disabled: no API key for ${MODEL_SPEC}` });
      if (running) return res.status(409).json({ error: 'a WYH AI run is already in progress', running });
      runWyhAi(opts).catch(() => {});
      res.status(202).json({ ok: true, started: true, mode: opts.mode, model: provider.name });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });

  app.get('/admin/wyh-ai/status', requireAuth, requireAdmin, async (req, res) => {
    try {
      const since30d = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
      const [recent, costRows, feedback, settings, reviewed, errors] = await Promise.all([
        sbSelect('wyh_ai_runs', 'select=id,mode,trigger,model,started_at,finished_at,status,jobs_in_scope,llm_calls,skipped_unchanged,no_activity,errors,input_tokens,output_tokens,est_cost_usd,report&order=started_at.desc&limit=10'),
        sbPaged('wyh_ai_runs', `select=est_cost_usd&started_at=gte.${since30d}`),
        loadFeedback(), loadSettings(),
        sbSelect('wyh_ai_suggestions', 'select=call_id&reviewed_at=not.is.null&limit=1000').then(r => r.length),
        sbSelect('wyh_ai_suggestions', 'select=call_id&error=not.is.null&limit=1000').then(r => r.length),
      ]);
      const last = lastRun || recent.find(r => r.mode !== 'refresh') || null;
      res.json({
        enabled: !!provider && !!settings.enabled, provider_ready: !!provider, schedulers: SCHEDULERS, model: provider ? provider.name : null, model_spec: MODEL_SPEC, provider: providerKind, prompt_version: PROMPT_VERSION,
        settings, running, last_run: last, recent_runs: recent,
        counts: { reviewed, errors, feedback: feedback.length },
        accuracy: accuracyFrom(feedback.slice(0, 200)), recent_corrections: feedback.filter(f => f.reason).slice(0, 25), questions: QUESTIONS,
        cost: { last_run_usd: last ? Number(last.est_cost_usd) || 0 : 0, last_30d_usd: Math.round(costRows.reduce((s, r) => s + (Number(r.est_cost_usd) || 0), 0) * 10000) / 10000, price_per_mtok: { input: PRICE_IN, output: PRICE_OUT } },
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // On demand for one lead (managers inside their locations): a call, a text thread or a job lead.
  const suggestRoute = (path, table, col, noun) => app.post(path, requireAuth, async (req, res) => {
    const id = String(req.params.id || '');
    if (!uuidRe.test(id)) return res.status(400).json({ error: `Bad ${noun} id` });
    try {
      const actor = await loadActor(req);
      if (!actor) return res.status(403).json({ error: 'Profile not found' });
      if (!['admin', 'owner', 'executive', 'expansion_manager'].includes(actor.role)) return res.status(403).json({ error: 'Not allowed' });
      const [row0] = await sbSelect(table, `select=id,location_id&id=eq.${id}`);
      if (!row0) return res.status(404).json({ error: `${noun[0].toUpperCase()}${noun.slice(1)} not found` });
      if (actor.role === 'expansion_manager' && !actor.locs.includes(String(row0.location_id))) return res.status(403).json({ error: 'Not your location' });
      const row = await suggestOne(col, id);
      res.json({ ok: !!row && !row.error, suggestion: row });
    } catch (err) { res.status(err.status || 502).json({ error: err.message }); }
  });
  suggestRoute('/wyh/calls/:id/suggest', 'calls', 'call_id', 'call');
  suggestRoute('/wyh/messages/:id/suggest', 'sms_conversations', 'conversation_id', 'text');
  suggestRoute('/wyh/job-leads/:id/suggest', 'jobs', 'lead_job_id', 'job');
}

module.exports = mountWyhAi;
module.exports.PROMPT_VERSION = PROMPT_VERSION;
module.exports.WyhSuggestionSchema = WyhSuggestionSchema;
module.exports.BASE_PROMPT = BASE_PROMPT;
module.exports.buildSystemPrompt = buildSystemPrompt;
module.exports.accuracyFrom = accuracyFrom;
module.exports.buildPayload = buildPayload;
module.exports.cleanSuggestions = cleanSuggestions;
module.exports.sample = sample;
module.exports.cleanVerdict = cleanVerdict;
module.exports.NOT_LEAD_REASONS = NOT_LEAD_REASONS;
