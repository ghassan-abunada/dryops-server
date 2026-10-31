'use strict';
// ── Push summary for inbound texts ──────────────────────────────────────────
// Owner 2026-10-30: the lock-screen push for a customer text should read as a
// short summary, not the raw message. Google LSA leads arrive wrapped in
// Google's template ("You have received a new message ... Customer name: ...
// Service: ... Message: ... [Notes from LSA: ...]") plus a separate "Replies to
// this number will be sent to the customer..." relay notice; both read badly on
// a lock screen.
//
//   1. The relay notice is not a customer message → no push at all.
//   2. LSA template → parsed (twin of the app's lib/messages/lsa.ts).
//   3. Short text (≤ SHORT_MAX) → sent as is; nothing to summarise.
//   4. Longer text → one small LLM call (Gemini Flash-Lite by default,
//      PUSH_SUMMARY_MODEL to change, PUSH_SUMMARY=off to disable) with a hard
//      timeout; any failure falls back to the cleaned text, clipped.
//
// The stored message is never changed; this only shapes the notification.

const { z } = require('zod');
const { makeProvider, envBool } = require('./noteReader');

const SHORT_MAX = 100;   // fits the lock screen in ~2 lines; summarising adds nothing
const BODY_MAX = 140;    // hard cap on what we send to Expo
const TIMEOUT_MS = 4000; // a push a few seconds late beats no push

const RELAY_NOTICE = /^Replies to this number will be sent to the customer/i;
const LSA_HEADER = /^You have received a new message from a customer via Google Local Services Ads\.?/i;

const SERVICE_LABELS = {
  water_damage_cleanup_repair: 'Water damage cleanup',
  water_damage_mold_removal: 'Mold removal',
  water_damage_mold_inspection: 'Mold inspection',
  water_damage_remodeling: 'Water damage remodeling',
  water_damage_sewage_cleanup: 'Sewage cleanup',
  water_damage_other: 'Water damage (other)',
  water_damage_flooring: 'Water damage flooring',
  water_damage_plumbing: 'Water damage plumbing',
  water_damage_painting: 'Water damage painting',
  fire_damage_cleanup_repair: 'Fire damage cleanup',
};
function serviceLabel(code) {
  const c = String(code || '').trim();
  if (!c) return null;
  if (SERVICE_LABELS[c]) return SERVICE_LABELS[c];
  const s = c.split('_').filter(Boolean).join(' ');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : null;
}

/** Google's LSA lead template → facts, or null. Server twin of the app's parseLsa. */
function parseLsa(content) {
  let raw = String(content || '').replace(/\r\n/g, '\n').trim();
  const pm = raw.match(/^\((\d+\/\d+)\)\s*/);
  if (pm) raw = raw.slice(pm[0].length);
  const hm = raw.match(LSA_HEADER);
  if (!hm) return null;
  const rest = raw.slice(hm[0].length);
  const field = (re) => { const m = rest.match(re); const v = m ? m[1].trim() : ''; return v || null; };
  const name = field(/Customer name:[ \t]*(.*?)[ \t]*(?:,[ \t]*Location:|\n|[ \t]+Service:|$)/);
  const location = field(/Location:[ \t]*(.*?)[ \t]*(?:\n|[ \t]+Service:|$)/);
  const service = field(/Service:[ \t]*([a-z0-9_]*)/);
  const mm = rest.match(/Message:\s*([\s\S]*)$/);
  let text = mm ? mm[1] : '';
  let notes = [];
  const nm = text.match(/\s*\[Notes from LSA:\s*([^\]]*)\]?\.?\s*$/);
  if (nm) {
    text = text.slice(0, nm.index);
    notes = nm[1].split(/\(\d+\)/).map((n) => n.trim().replace(/^this customer has\s+/i, '')).filter(Boolean)
      .map((n) => n.charAt(0).toUpperCase() + n.slice(1));
  }
  text = text.trim().replace(/\s+\.$/, '').replace(/\.\.$/, '.').replace(/^([\d\s()+-]{7,})\.$/, '$1').replace(/\s+/g, ' ').trim();
  return { name, location, service, serviceLabel: serviceLabel(service), text, notes };
}

const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
function clip(s, n = BODY_MAX) {
  const t = oneLine(s);
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

/**
 * Pure first pass. Returns
 *   { skip: true }                                   — not worth a push (relay notice)
 *   { title, body, summarize: bool, input }          — `input` is what the LLM would read
 */
function prepare({ customerName, phoneLabel, content, mediaUrls }) {
  const raw = String(content || '').trim();
  if (RELAY_NOTICE.test(raw)) return { skip: true };
  const lsa = parseLsa(raw);
  if (lsa) {
    const facts = [lsa.location, lsa.serviceLabel].filter(Boolean).join(' · ');
    const title = `${lsa.name || customerName || phoneLabel || 'Google lead'} · Google lead`;
    const wantsQuote = lsa.notes.some((n) => /quote/i.test(n));
    const fallback = [facts, lsa.text].filter(Boolean).join(': ') + (wantsQuote ? ' (wants a quote)' : '');
    const input = [facts && `Lead: ${facts}`, lsa.text && `Customer wrote: ${lsa.text}`, lsa.notes.length && `Google notes: ${lsa.notes.join('; ')}`]
      .filter(Boolean).join('\n');
    return { title, body: clip(fallback || 'New Google lead'), summarize: oneLine(fallback).length > SHORT_MAX, input };
  }
  const title = customerName || phoneLabel || 'New text';
  const text = oneLine(raw);
  if (!text) {
    const n = Array.isArray(mediaUrls) ? mediaUrls.length : 0;
    return { title, body: n ? `Sent ${n > 1 ? `${n} photos` : 'a photo'}` : 'New text message', summarize: false, input: '' };
  }
  return { title, body: clip(text), summarize: text.length > SHORT_MAX, input: `Customer wrote: ${text}` };
}

const SYSTEM_PROMPT = `You write the body of a phone push notification for a water damage restoration company's office staff. The input is a text message from a customer (sometimes a Google Local Services lead with location, service and notes).
Write ONE plain summary line of at most 90 characters that tells staff what the customer needs: the problem, key facts (where, how bad, standing water, insurance), and what they ask for (quote, call back, a time). Use the customer's facts only; never invent details, names, prices or times. No greeting, no quotes, no emoji, no "Customer says". Lead with the problem, e.g. "Plumbing leak, one room, shallow standing water — wants a quote".`;

const Schema = z.object({ summary: z.string() });

function makeSummarizer({ anthropic, spec = process.env.PUSH_SUMMARY_MODEL, timeoutMs = TIMEOUT_MS, provider: injected } = {}) {
  const enabled = envBool('PUSH_SUMMARY', true);
  let provider = injected || null;
  if (!provider && enabled) {
    try {
      provider = makeProvider(spec || 'gemini:gemini-3.1-flash-lite', anthropic, {
        schema: Schema, systemPrompt: SYSTEM_PROMPT, thinkingEnv: 'PUSH_SUMMARY_GEMINI_THINKING', envName: 'PUSH_SUMMARY_MODEL', maxOutputTokens: 512,
      }).provider;
    } catch (e) { console.warn('[push-summary]', e.message); }
  }
  if (!provider && enabled && !injected) console.warn('[push-summary] no model key; pushes use the cleaned text');

  /** → { title, body } or null (do not push). Never throws. */
  return async function summarizeForPush(args) {
    const p = prepare(args);
    if (p.skip) return null;
    if (!p.summarize || !provider) return { title: p.title, body: p.body };
    let timer;
    try {
      const r = await Promise.race([
        provider.classify(p.input),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), timeoutMs); }),
      ]);
      const s = clip(r && r.parsed && r.parsed.summary, BODY_MAX);
      return { title: p.title, body: s || p.body };
    } catch (e) {
      console.warn('[push-summary] fallback:', e.message);
      return { title: p.title, body: p.body };
    } finally { clearTimeout(timer); }
  };
}

module.exports = { makeSummarizer, prepare, parseLsa, clip, SHORT_MAX, BODY_MAX };
