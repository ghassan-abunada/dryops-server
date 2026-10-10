'use strict';
// ── Note reader ──────────────────────────────────────────────────────────────
// Shared plumbing for the modules that read JobNimbus notes with an LLM
// (collections.js, monitor.js): activity fetching + grouping, the human-note
// filter, the notes hash, LLM providers (Gemini / Anthropic) with a caller-
// supplied zod schema + system prompt, retry/pool helpers and price table.
// Pure and side-effect free at load; nothing here touches Supabase or JN on
// its own — callers pass `jnGet`.

const crypto = require('crypto');
const { z } = require('zod');

// Activity types that are never a human note. JN stamps the acting user's
// name on status changes, assignments, etc., so author alone can't tell a
// note from a workflow event (seen in the first prod dry run: "Status
// Changed|human" ×12, "Job Modified|human" ×23).
const SYSTEM_TYPES = new Set([
  'Job Modified', 'Job Created', 'Status Changed', 'Attachment deleted', 'Attachment added',
  'Task Created', 'Task Completed', 'Assigned Job', 'Unassigned Job', 'Assigned Contact',
  'Unassigned Contact', 'Related to task', 'Related to job', 'Related to contact', 'Contact Created',
  'Automation', 'Text Message',
]);
const ACT_FIELDS = 'jnid,note,record_type_name,created_by_name,date_created,date_updated,is_active,is_archived,related';

// $ per 1M tokens [input, output]; output rate also covers thinking tokens.
const PRICES = {
  'gemini-3.1-flash-lite': [0.25, 1.5],
  'gemini-2.5-flash-lite': [0.10, 0.40],
  'gemini-2.5-flash': [0.30, 2.5],
  'claude-haiku-4-5': [1, 5],
  'claude-sonnet-5-5': [2, 10],
};

const DEFAULT_SPEC = 'gemini:gemini-3.1-flash-lite';

const envNum = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v >= 0 ? v : d; };
const envBool = (k, d) => { const v = process.env[k]; return v == null || v === '' ? d : !/^(0|false|no|off)$/i.test(v); };

function plainNote(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x2F;/g, '/')
    .replace(/\s+/g, ' ').trim();
}
const hiddenAuthor = (n) => { const s = String(n || '').trim(); return !s || s === 'None' || s.startsWith('Automation'); };
function isHuman(a) {
  return a.is_active !== false && !a.is_archived
    && !SYSTEM_TYPES.has(a.record_type_name) && !hiddenAuthor(a.created_by_name)
    && plainNote(a.note).length > 0;
}
const isoDay = (secs) => new Date((secs || 0) * 1000).toISOString().slice(0, 10);
const clip = (s, n) => (s == null ? null : String(s).trim().slice(0, n) || null);
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function runPool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it); }
  }));
}

async function withRetry(fn, tries = 4) {
  for (let a = 0; ; a++) {
    try { return await fn(); } catch (err) {
      const status = err.status || err.response?.status || err.statusCode;
      const retryable = status === 429 || status === 408 || (status >= 500 && status < 600)
        || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || /fetch failed|timeout|socket hang up/i.test(err.message || '');
      if (!retryable || a >= tries - 1) throw err;
      await new Promise(r => setTimeout(r, 1500 * 2 ** a + Math.random() * 500));
    }
  }
}

// ── Providers ────────────────────────────────────────────────────────────────
// provider.classify(userText) → { parsed, usage: { input, output, thinking } }
// `schema` is the caller's zod object; `systemPrompt` its instructions.
// `thinkingEnv` names the env var holding the Gemini 3 thinking level.
function geminiProvider(model, { schema: zodSchema, systemPrompt, thinkingEnv = 'COLLECTIONS_GEMINI_THINKING' }) {
  if (!process.env.GEMINI_API_KEY) return null;
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const schema = z.toJSONSchema(zodSchema);
  delete schema.$schema;
  const level = String(process.env[thinkingEnv] || 'low').toUpperCase();
  const thinkingConfig = /^gemini-3/.test(model) ? { thinkingLevel: level } : undefined;
  return {
    name: `gemini:${model}`,
    async classify(userText) {
      const res = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: 'application/json',
          responseJsonSchema: schema,
          temperature: 0,
          maxOutputTokens: 2048,
          ...(thinkingConfig ? { thinkingConfig } : {}),
        },
      });
      const block = res.promptFeedback?.blockReason;
      const fr = res.candidates?.[0]?.finishReason;
      if (block || (fr && fr !== 'STOP')) throw new Error(`gemini finish ${block || fr}`);
      const text = res.text;
      if (!text) throw new Error('gemini returned no text');
      const parsed = zodSchema.parse(JSON.parse(text));
      const u = res.usageMetadata || {};
      return { parsed, usage: { input: u.promptTokenCount || 0, output: u.candidatesTokenCount || 0, thinking: u.thoughtsTokenCount || 0 } };
    },
  };
}

function anthropicProvider(model, anthropic, { schema: zodSchema, systemPrompt }) {
  if (!anthropic) return null;
  const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
  return {
    name: `anthropic:${model}`,
    async classify(userText) {
      const r = await anthropic.messages.parse({
        model,
        max_tokens: 1024,
        system: systemPrompt,
        output_config: { format: zodOutputFormat(zodSchema) }, // no `effort`: Haiku 4.5 rejects it
        messages: [{ role: 'user', content: userText }],
      });
      if (r.stop_reason === 'refusal' || !r.parsed_output) throw new Error(`model returned no decision (${r.stop_reason})`);
      return { parsed: r.parsed_output, usage: { input: r.usage.input_tokens || 0, output: r.usage.output_tokens || 0, thinking: 0 } };
    },
  };
}

// spec = "gemini:<model>" | "anthropic:<model>". `envName` only labels the
// error so a bad COLLECTIONS_MODEL / MONITOR_MODEL names itself.
function makeProvider(spec, anthropic, { schema, systemPrompt, thinkingEnv, envName = 'COLLECTIONS_MODEL' }) {
  const [kind, ...rest] = String(spec || DEFAULT_SPEC).split(':');
  const model = rest.join(':');
  const opts = { schema, systemPrompt, thinkingEnv };
  if (kind === 'gemini') return { provider: geminiProvider(model || 'gemini-3.1-flash-lite', opts), model: model || 'gemini-3.1-flash-lite', kind };
  if (kind === 'anthropic') return { provider: anthropicProvider(model || 'claude-haiku-4-5', anthropic, opts), model: model || 'claude-haiku-4-5', kind };
  throw new Error(`${envName}: unknown provider "${kind}" (use gemini:<model> or anthropic:<model>)`);
}

// ── Activities ───────────────────────────────────────────────────────────────
// Activities for ≤15 jobs, newest-first within the lookback window.
// `stats.jn_requests` is incremented per JN request.
async function fetchActivities({ jnGet, tag = 'collections' }, jnIds, sinceSecs, stats) {
  const filter = JSON.stringify({ must: [
    { terms: { 'related.id': jnIds } },
    { range: { date_created: { gte: sinceSecs } } },
  ] });
  const out = [];
  let count = Infinity;
  for (let from = 0; from + 500 <= 10000 && out.length < count; from += 500) {
    const q = new URLSearchParams({ filter, size: '500', from: String(from), fields: ACT_FIELDS });
    const d = await withRetry(() => jnGet(`activities?${q}`));
    stats.jn_requests++;
    const rows = d.activity || d.results || [];
    count = d.count ?? d.total ?? rows.length;
    out.push(...rows);
    if (rows.length < 500) break;
  }
  if (count > 10000) console.warn(`[${tag}] ES 10k cap hit for a ${jnIds.length}-job chunk starting ${jnIds[0]}`);
  return out;
}

// Map job jnid → activities related to it (insertion order, unsorted).
function groupActsByJob(acts) {
  const byJn = new Map();
  for (const a of acts) {
    for (const rel of Array.isArray(a.related) ? a.related : []) {
      if (!rel || rel.type !== 'job' || !rel.id) continue;
      if (!byJn.has(rel.id)) byJn.set(rel.id, []);
      byJn.get(rel.id).push(a);
    }
  }
  return byJn;
}

// sha1 over the prompt version + the identity/update stamp of each note that
// will be sent to the model. Unchanged hash → the LLM call is skipped.
function notesHash(promptVersion, notes) {
  const h = crypto.createHash('sha1').update(promptVersion);
  for (const a of notes) h.update(`${a.jnid}:${a.date_updated || a.date_created}|`);
  return h.digest('hex');
}

module.exports = {
  SYSTEM_TYPES, ACT_FIELDS, PRICES, DEFAULT_SPEC,
  envNum, envBool, plainNote, hiddenAuthor, isHuman, isoDay, clip, uuidRe, runPool, withRetry,
  geminiProvider, anthropicProvider, makeProvider,
  fetchActivities, groupActsByJob, notesHash,
};
