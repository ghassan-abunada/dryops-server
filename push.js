'use strict';
// Expo push, one sender for every feature (texts, @mentions, call alerts).
//
//   const push = createPush({ SUPABASE_URL, SUPABASE_SERVICE_KEY, sbGet });
//   await push.toProfiles(['<uuid>'], { title, body, data });
//
// Batches of 100 (Expo's limit), drops tokens Expo reports as
// DeviceNotRegistered, and with PUSH_DRYRUN=1 logs who would get what instead
// of sending (call-alert rollout).

const EXPO_SEND = 'https://exp.host/--/api/v2/push/send';
const BATCH = 100;

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** Tokens a batch of tickets reported dead (same order as the messages sent). */
function deadTokens(messages, tickets) {
  const out = [];
  (tickets || []).forEach((t, i) => {
    if (t && t.status === 'error' && t.details && t.details.error === 'DeviceNotRegistered' && messages[i]) out.push(messages[i].to);
  });
  return out;
}

function createPush({ SUPABASE_URL, SUPABASE_SERVICE_KEY, sbGet, fetchImpl, env = process.env, log = console } = {}) {
  const doFetch = fetchImpl || fetch;
  const enc = encodeURIComponent;
  const dryrun = () => /^(1|true|yes)$/i.test(String(env.PUSH_DRYRUN || ''));

  async function tokensFor(profileIds) {
    const ids = [...new Set((profileIds || []).map(String))].filter(Boolean);
    if (!ids.length) return [];
    return (await sbGet(`push_tokens?select=token,profile_id&profile_id=in.(${ids.map(enc).join(',')})`)) || [];
  }

  async function dropTokens(tokens) {
    if (!tokens.length || !SUPABASE_URL) return;
    try {
      await doFetch(`${SUPABASE_URL}/rest/v1/push_tokens?token=in.(${tokens.map((t) => `"${t}"`).map(enc).join(',')})`, {
        method: 'DELETE',
        headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, Prefer: 'return=minimal' },
      });
    } catch (e) { log.warn('[push] token cleanup failed', e.message); }
  }

  /** Send ready-made Expo messages ({ to, title, body, data, sound }). Returns how many were accepted. */
  async function send(messages, tag = 'push') {
    const list = (messages || []).filter((m) => m && m.to);
    if (!list.length) return 0;
    if (dryrun()) {
      log.log(`[push] DRYRUN ${tag}: ${list.length} message(s)`, list.map((m) => ({ to: m.to.slice(0, 28), title: m.title, body: m.body, data: m.data })));
      return 0;
    }
    let ok = 0;
    const dead = [];
    for (const batch of chunk(list, BATCH)) {
      try {
        const r = await doFetch(EXPO_SEND, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(batch) });
        if (!r.ok) { log.warn('[push] expo', tag, r.status, (await r.text()).slice(0, 200)); continue; }
        const j = await r.json().catch(() => null);
        const tickets = (j && j.data) || [];
        ok += tickets.filter((t) => t && t.status === 'ok').length;
        dead.push(...deadTokens(batch, tickets));
      } catch (e) { log.warn('[push] expo send failed', tag, e.message); }
    }
    await dropTokens(dead);
    return ok;
  }

  /** One notification to every device of these profiles. */
  async function toProfiles(profileIds, { title, body, data, sound = 'default', categoryId }, tag) {
    const tokens = await tokensFor(profileIds);
    // categoryId: the notification's action buttons (registered by the app, e.g. 'missed_call' → Call back).
    return send(tokens.map((t) => ({ to: t.token, title, body, sound, data, ...(categoryId ? { categoryId } : {}) })), tag);
  }

  return { send, toProfiles, tokensFor, dryrun };
}

module.exports = createPush;
module.exports.createPush = createPush;
module.exports.deadTokens = deadTokens;
module.exports.chunk = chunk;
module.exports.BATCH = BATCH;
