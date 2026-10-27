'use strict';
// ── WYH AI reviewer ──────────────────────────────────────────────────────────
// Reads everything we hold about ONE call → job (JobNimbus notes + fields, the
// job's photos, the CallRail summary / transcript, earlier calls from the same
// number) and suggests the Wash Your Hands checklist answers, each with a
// confidence and a one-line "why". Suggestions land in public.wyh_ai_suggestions
// (DryOps repo supabase/add_wyh_ai.sql) and the app shows them as chips the
// manager accepts or overrides; nothing is written to JobNimbus.
//
// For an answered call with NO job it only does job matching: the model reads
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

const PROMPT_VERSION = 'w1'; // bump to re-read every call on the next full run

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
info_sufficient: true when the job has a date of loss, a water category (cat) and a cause of loss; false otherwise, with info_missing listing what is missing.
general_notes: 1–3 sentences the manager would tell the partner — the one or two things that matter most on this file (max 400 characters); null when nothing stands out.
needs_follow_up: true when the file has major concerns (lost job that should have landed, price given over the phone, customer complaint) or is too incomplete to review (follow_up_reason "major_concerns" / "file_incomplete" / "other", follow_up_note why); false otherwise.
job_match: ONLY for a call that has no JobNimbus job. From the transcript / summary, extract the caller's name and the property address, then compare against "candidate_jobs" (jobs created at the same location around the call). Return the candidates that are the same customer or property with score 0–1 and why; an empty array when none fit. For a call that already has a job return null.
summary: max 200 characters, factual.

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

function buildPayload({ call, job, notes, callrail, priorCalls, candidates, photosAttached, today }) {
  return {
    today,
    call: {
      when: call.start_time, answered: call.answered, voicemail: call.voicemail, duration_sec: call.duration,
      caller: clip(call.customer_name, 80), phone: call.customer_phone_number, tags: call.tags || [],
      summary: clip((callrail && callrail.summary) || call.call_summary, 2000),
      transcript: clip(callrail && callrail.transcript, 6000),
      prior_calls_same_number: (priorCalls || []).map(p => ({ when: p.start_time, answered: p.answered, summary: clip(p.call_summary, 300) })),
    },
    job: job ? {
      number: job.number, name: clip(job.name, 120), status: job.status, stage: job.stage,
      insurance_type: job.insurance_type, insurer: job.insurer, claim_number: job.claim_number, tested: job.tested,
      date_loss: job.date_loss, cat: job.cat, cause: job.cause, lead_type: job.lead_type, sales_rep: job.sales_rep,
      created: job.jn_created, days_call_to_job: job.jn_created ? Math.round(daysBetween(job.jn_created, call.start_time) * 10) / 10 : null,
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

const pick = (s) => (s && typeof s === 'object' ? { value: s.value ?? null, confidence: Math.max(0, Math.min(1, Number(s.confidence) || 0)), why: clip(s.why, 160) } : { value: null, confidence: 0, why: null });
function cleanSuggestions(llm, hasJob) {
  const out = {};
  for (const q of ['call_taken_by_name', 'call_handled', 'walked', 'landed', 'photo_moisture', 'photo_damage', 'photo_wide', 'insurance', 'has_carrier', 'has_claim', 'tested', 'packout_sold', 'info_sufficient', 'needs_follow_up']) out[q] = pick(llm[q]);
  if (!hasJob) for (const q of Object.keys(out)) out[q] = { value: null, confidence: 0, why: null };
  out.call_missed_reason = clip(llm.call_missed_reason, 200);
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
    SUPABASE_URL, SUPABASE_SERVICE_KEY, jnGet, jnFetchUpdatedSince, jnListJobImages, jnDownloadFile,
    sbSelect, sbInsert, sbPatch, requireAuth, requireAdmin, loadActor, anthropic, denverNow,
    callrailApi, CALLRAIL_ACCOUNT_IDS,
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
  // Upsert keyed on call_id (the shared sbBulkUpsert keys on jn_id).
  async function upsertSuggestions(rows) {
    if (!rows.length) return;
    const uniq = [...new Map(rows.map(r => [r.call_id, r])).values()];
    const r = await fetch(`${SUPABASE_URL}/rest/v1/wyh_ai_suggestions?on_conflict=call_id`, {
      method: 'POST', headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(uniq),
    });
    if (!r.ok) throw new Error(`wyh_ai_suggestions upsert ${r.status} ${(await r.text()).slice(0, 200)}`);
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
  const CALL_COLS = 'id,callrail_id,start_time,answered,voicemail,duration,customer_name,customer_phone_number,customer_phone_norm,tags,call_summary,location_id,job_id';
  const JOB_COLS = 'id,jn_id,number,name,client_name,status,stage,insurance_type,insurer,claim_number,tested,date_loss,cat,cause,lead_type,sales_rep,jn_created,location_id,address,client_phone_norm';
  async function selectTargets({ location_id = null, call_id = null } = {}) {
    const since = new Date(Date.now() - CALL_DAYS * 86400000).toISOString();
    const q = `select=${CALL_COLS}&direction=eq.inbound&location_id=not.is.null&start_time=gte.${since}`
      + (location_id ? `&location_id=eq.${encodeURIComponent(location_id)}` : '') + (call_id ? `&id=eq.${encodeURIComponent(call_id)}` : '') + '&order=start_time.desc';
    const calls = await sbPaged('calls', q);
    const locs = new Map((await sbPaged('locations', 'select=id,name,location_type,timezone')).map(l => [l.id, l]));
    const mit = calls.filter(c => { const l = locs.get(c.location_id); return l && (l.location_type == null || l.location_type === 'Mitigation'); });
    const jobIds = [...new Set(mit.map(c => c.job_id).filter(Boolean))];
    const jobs = new Map((await inChunks('jobs', 'id', jobIds, JOB_COLS)).map(j => [j.id, j]));
    const reviews = new Map((await inChunks('wyh_reviews', 'call_id', mit.map(c => c.id), 'call_id,status,kind,completed_manually')).map(r => [r.call_id, r]));
    const insp = await inChunks('inspections', 'job_id', jobIds, 'job_id,status,scheduled_date', '&task_type=eq.inspection&status=neq.cancelled');
    for (const i of insp) {
      const j = jobs.get(i.job_id); if (!j) continue;
      if (i.status === 'completed') { j._inspection_state = 'completed'; j._inspection_date = i.scheduled_date; }
      else if (j._inspection_state !== 'completed') { j._inspection_state = 'scheduled'; j._inspection_date = i.scheduled_date; }
    }
    const nojobSince = Date.now() - NOJOB_DAYS * 86400000;
    const targets = [];
    for (const c of mit) {
      const r = reviews.get(c.id);
      if (r && r.kind === 'not_lead') continue;
      if (c.job_id) {
        const j = jobs.get(c.job_id);
        if (!j || !j.jn_id) continue;
        if (r && r.status === 'complete') continue;
        if (j.jn_created && daysBetween(c.start_time, j.jn_created) > EXISTING_JOB_DAYS) continue; // repeat call on an old job
        targets.push({ call: c, job: j, loc: locs.get(c.location_id), kind: 'wyh' });
      } else if (c.answered === true && !c.voicemail && new Date(c.start_time).getTime() >= nojobSince) {
        targets.push({ call: c, job: null, loc: locs.get(c.location_id), kind: 'match' });
      }
    }
    return targets;
  }
  async function prevRows(callIds) {
    return new Map((await inChunks('wyh_ai_suggestions', 'call_id', callIds, 'call_id,inputs_hash,error,reviewed_at')).map(r => [r.call_id, r]));
  }

  // ── Per-call inputs ────────────────────────────────────────────────────────
  async function callrailDetails(callrailId) {
    if (!callrailApi || !callrailId) return null;
    for (const acct of CALLRAIL_ACCOUNT_IDS || []) {
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
      const sinceSecs = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86400;
      const acts = (await fetchActs({ jnGet, tag: 'wyh-ai' }, [t.job.jn_id], sinceSecs, stats)).filter(isHuman).sort((x, y) => (y.date_created || 0) - (x.date_created || 0)).slice(0, NOTES_PER_JOB);
      fp = notesHash(PROMPT_VERSION, acts);
      notes = acts.map(a => ({ when: isoDay(a.date_created), by: clip(a.created_by_name, 60), text: plainNote(a.note).slice(0, NOTE_CHARS) }));
    }
    const callrail = await callrailDetails(t.call.callrail_id);
    const prior = await priorCallsFor(t.call);
    const candidates = t.kind === 'match' ? await candidateJobsFor(t.call) : null;
    const photos = t.job ? await photosFor(t.job, photosN) : { images: [], ids: [], total: 0 };
    const lessons = lessonsFor(feedback, t.call.location_id);
    const jobStamp = t.job ? [t.job.status, t.job.stage, t.job.insurer, t.job.claim_number, t.job.tested, t.job.date_loss, t.job.cat, t.job.cause, t.job._inspection_state, t.job._inspection_date].join('/') : '';
    const hash = inputsHash([PROMPT_VERSION, fp, jobStamp, settings.updated_at, (callrail && callrail.transcript ? callrail.transcript.length : 0), (callrail && callrail.summary) || t.call.call_summary, photos.ids.join(','), lessons[0] ? lessons[0].id : '', (candidates || []).map(c => c.job_id).join(',')]);
    const payload = buildPayload({ call: t.call, job: t.job, notes, callrail, priorCalls: prior, candidates, photosAttached: photos.images.length, today });
    const systemPrompt = buildSystemPrompt(BASE_PROMPT, settings, lessons, accuracyFrom(feedback.slice(0, 200)));
    return { t, notes, hash, payload, images: photos.images, photoIds: photos.ids, photosTotal: photos.total, systemPrompt, nowISO };
  }

  function rowFrom(inp, llm, usage) {
    const hasJob = !!inp.t.job;
    const sugg = cleanSuggestions(llm, hasJob);
    const match = !hasJob && llm.job_match ? {
      caller_name: clip(llm.job_match.caller_name, 80), address: clip(llm.job_match.address, 120),
      candidates: (llm.job_match.candidates || []).filter(c => uuidRe.test(String(c.job_id || ''))).slice(0, 5).map(c => ({ job_id: c.job_id, score: Math.max(0, Math.min(1, Number(c.score) || 0)), why: clip(c.why, 160) })),
    } : null;
    return {
      call_id: inp.t.call.id, job_id: inp.t.job ? inp.t.job.id : null, location_id: inp.t.call.location_id,
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
      const prev = await prevRows(targets.map(t => t.call.id));
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
          targets = targets.filter(t => !prev.has(t.call.id) || settingsChanged || feedbackChanged || (t.job && touched.has(t.job.jn_id)));
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
          const p = prev.get(t.call.id);
          if (!force && p && p.inputs_hash === inp.hash && !p.error) { stats.skipped_unchanged++; running.progress.done++; return; }
          if (t.kind === 'wyh' && !inp.notes.length && !inp.images.length && !inp.payload.call.summary) { stats.no_activity++; running.progress.done++; return; }
          stats.llm_calls++;
          const { parsed, usage } = await withRetry(() => provider.classify(userText(inp.payload), { images: inp.images, systemPrompt: inp.systemPrompt }));
          stats.input_tokens += usage.input; stats.output_tokens += usage.output; stats.thinking_tokens += usage.thinking;
          cost += costOf(usage);
          const row = rowFrom(inp, parsed, usage);
          if (row.job_match && row.job_match.candidates.length) matches++;
          rows.push(row);
        } catch (err) {
          stats.errors++;
          if (firstErrors.length < 20) firstErrors.push({ call_id: t.call.id, job_number: t.job ? t.job.number : null, error: String(err.message).slice(0, 200) });
          errRows.push({ call_id: t.call.id, job_id: t.job ? t.job.id : null, location_id: t.call.location_id, error: String(err.message).slice(0, 300), error_at: nowISO });
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
    const prev = await prevRows(targets.map(t => t.call.id));
    const sampleT = targets.slice(0, Math.max(1, Math.min(Number(limit) || 5, 25)));
    const ctx = { settings, feedback, nowISO: new Date().toISOString(), today: denverDay() };
    const out = [];
    for (const t of sampleT) {
      const inp = await buildInput(t, ctx, stats);
      const p = prev.get(t.call.id);
      const text = userText(inp.payload);
      out.push({ call_id: t.call.id, kind: t.kind, caller: t.call.customer_name, job_number: t.job ? t.job.number : null, notes: inp.notes.length, photos: inp.images.length, transcript: !!inp.payload.call.transcript, text_chars: text.length, would_skip: p && p.inputs_hash === inp.hash && !p.error ? 'unchanged' : null, payload: inp.payload, system_prompt_chars: inp.systemPrompt.length });
    }
    const pending = targets.filter(t => { const p = prev.get(t.call.id); return !p || p.error; }).length;
    // ~4 chars per token for text, ~260 tokens per image, ~900 output tokens.
    const estTokens = out.length ? out.reduce((s, o) => s + o.text_chars / 4 + o.photos * 260 + 900, 0) / out.length : 0;
    return {
      model: provider ? provider.name : null, schedulers: SCHEDULERS, enabled: !!settings.enabled, photos_per_job: settings.photos_per_job ?? PHOTOS_DEFAULT,
      in_scope: targets.length, wyh_targets: targets.filter(t => t.kind === 'wyh').length, match_targets: targets.filter(t => t.kind === 'match').length, never_reviewed: pending,
      est_cost_per_call_usd: Math.round(estTokens * PRICE_IN / 1e6 * 10000) / 10000, est_cost_full_usd: Math.round(estTokens * PRICE_IN / 1e6 * targets.length * 100) / 100,
      jn_requests: stats.jn_requests, sample: out,
    };
  }

  // One call on demand (the panel's Re-run / Suggest button).
  async function suggestOne(callId) {
    if (!provider) throw new Error(`WYH AI is disabled: no API key for ${MODEL_SPEC}`);
    const [t] = await selectTargets({ call_id: callId });
    if (!t) { const e = new Error('This call is not reviewable (no job, an old job, or the review is complete)'); e.status = 400; throw e; }
    const settings = await loadSettings(); const feedback = await loadFeedback();
    const stats = { jn_requests: 0 };
    const inp = await buildInput(t, { settings, feedback, nowISO: new Date().toISOString(), today: denverDay() }, stats);
    let row; let usage = { input: 0, output: 0, thinking: 0 }; let error = null;
    try {
      const r = await withRetry(() => provider.classify(userText(inp.payload), { images: inp.images, systemPrompt: inp.systemPrompt }));
      usage = r.usage; row = rowFrom(inp, r.parsed, usage);
    } catch (err) {
      error = String(err.message).slice(0, 300);
      row = { call_id: t.call.id, job_id: t.job ? t.job.id : null, location_id: t.call.location_id, error, error_at: inp.nowISO };
    }
    await upsertSuggestions([row]);
    await sbInsert('wyh_ai_runs', {
      mode: 'refresh', trigger: 'app', model: provider.name, prompt_version: PROMPT_VERSION, status: error ? 'error' : 'done', finished_at: new Date().toISOString(),
      jobs_in_scope: 1, jobs_fetched: 1, llm_calls: 1, errors: error ? 1 : 0, jn_requests: stats.jn_requests,
      input_tokens: usage.input, output_tokens: usage.output, thinking_tokens: usage.thinking, est_cost_usd: Math.round(costOf(usage) * 10000) / 10000, report: { call_id: callId, error },
    }).catch(err => console.error('[wyh-ai] refresh audit failed:', err.message));
    const [fresh] = await sbSelect('wyh_ai_suggestions', `select=*&call_id=eq.${callId}`);
    return fresh || null;
  }

  // ── Schedulers ─────────────────────────────────────────────────────────────
  async function enabledNow() { const s = await loadSettings(); return !!s.enabled; }
  async function fullCheckDue() {
    if (!SCHEDULERS || running) return;
    if (denverNow().h !== FULL_HOUR) return;
    try {
      if (!(await enabledNow())) return;
      const prior = await sbSelect('wyh_ai_runs', `select=id&mode=eq.full&status=in.(done,aborted)&report->>denver_day=eq.${denverDay()}&limit=1`);
      if (prior.length) return;
      await runWyhAi({ mode: 'full', trigger: 'schedule' });
    } catch (err) { console.error('[wyh-ai] scheduled full run failed:', err.message); }
  }
  async function incrementalTick() {
    if (!SCHEDULERS || running) return;
    const { h } = denverNow();
    if (h < INCREMENTAL_WINDOW[0] || h >= INCREMENTAL_WINDOW[1]) return;
    try { if (await enabledNow()) await runWyhAi({ mode: 'incremental', trigger: 'schedule' }); }
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

  // On-demand for one call (managers inside their locations).
  app.post('/wyh/calls/:callId/suggest', requireAuth, async (req, res) => {
    const callId = String(req.params.callId || '');
    if (!uuidRe.test(callId)) return res.status(400).json({ error: 'Bad call id' });
    try {
      const actor = await loadActor(req);
      if (!actor) return res.status(403).json({ error: 'Profile not found' });
      if (!['admin', 'owner', 'expansion_manager'].includes(actor.role)) return res.status(403).json({ error: 'Not allowed' });
      const [call] = await sbSelect('calls', `select=id,location_id&id=eq.${callId}`);
      if (!call) return res.status(404).json({ error: 'Call not found' });
      if (actor.role === 'expansion_manager' && !actor.locs.includes(String(call.location_id))) return res.status(403).json({ error: 'Not your location' });
      const row = await suggestOne(callId);
      res.json({ ok: !!row && !row.error, suggestion: row });
    } catch (err) { res.status(err.status || 502).json({ error: err.message }); }
  });
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
