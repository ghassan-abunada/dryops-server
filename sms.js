// Two-way texting through CallRail (owner 2026-10-28).
//
// Every Mitigation tracking number can text. CallRail posts each received /
// sent message to POST /webhooks/callrail/sms (installed per company by the
// webhook installer in server.js, keys sms_received_webhook / sms_sent_webhook),
// a 15-minute reconcile pull is the mechanism of record (webhooks are an
// optimisation — same lesson as calls), and the app reads sms_conversations /
// sms_messages under RLS (supabase/add_sms.sql in the DryOps repo).
//
// Routes (JWT unless noted):
//   POST /webhooks/callrail/sms?token=&event=received|sent   CallRail → us
//   POST /sms/conversations/:id/reply      { content, media_url? }
//   POST /sms/conversations                { location_id, tracking_number_id, customer_phone, customer_name?, job_id?, content }
//   POST /sms/conversations/:id/sync       pull the full CallRail history for one thread
//   POST /admin/sms/backfill               { days } (admin/owner/executive; default 90, max 770, paced)
//   GET  /admin/texting/status             backfill / reconcile progress + stored counts (the Twilio ETA-text status keeps /admin/sms/status)
//   POST /jobs/:id/contacts                add a secondary contact to an existing JN job
//   POST /me/push-token                    { token, platform }
//
// CallRail rules: content ≤ 140 chars, 150 sends/hour + 1,000/day per account,
// local US/CA numbers only, texting registration (TCR) required; CallRail adds
// opt-out wording to the first text when we leave it out.
const crypto = require('crypto');
const { makeSummarizer, prepare: prepareSummary } = require('./pushSummary');

const CONTENT_MAX = 140;
const DEDUPE_WINDOW_MS = 2 * 60 * 1000;
const PUSH_THROTTLE_MS = 2 * 60 * 1000;
const RECONCILE_INTERVAL_MS = 15 * 60 * 1000;
const RECONCILE_LOOKBACK_DAYS = 2;
// Pacing (owner 2026-10-28 after the unpaced 25-month pull starved the
// database of disk IO and took the app down): one thread at a time with a
// pause between messages, threads and pages. ~80 database calls a minute.
const PACE_MS = { message: 150, conversation: 600, page: 3000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// CallRail keeps texts for 25 months; the first boot with an empty table pulls all of it.
const BACKFILL_DAYS = 90;          // boot pull + default for POST /admin/sms/backfill (owner: "90 days is fine")
const MAX_BACKFILL_DAYS = 770;     // CallRail keeps 25 months; an explicit admin ask may go that far, paced
const SENDER_ROLES = ['admin', 'owner', 'expansion_manager'];
const SEES_ALL = ['admin', 'owner', 'executive'];

// ── Pure helpers (tested in test/sms.test.js) ────────────────────────────────
function normPhone(v) {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : (d || null);
}
// Strict E.164 for what we hand CallRail (its send endpoint answers 404
// "Could not locate tracking number" to bare 10-digit numbers). Bare US
// numbers get +1; the server.js twin is the same function.
function toE164(v) {
  const raw = String(v ?? '').trim();
  if (/^\+\d{8,15}$/.test(raw)) return raw;
  const d = raw.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null;
}
function previewOf(content, mediaUrls) {
  const t = String(content || '').replace(/\s+/g, ' ').trim();
  if (t) return t.slice(0, 160);
  return Array.isArray(mediaUrls) && mediaUrls.length ? `Photo${mediaUrls.length > 1 ? 's' : ''}` : '';
}
function toISO(v) {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString();
}
/** Where each CallRail webhook key should post: calls to the calls route, texts to the sms route (with the event in the query). */
function webhookTargets(baseUrl, token) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const t = encodeURIComponent(token || '');
  const calls = `${base}/webhooks/callrail/calls?token=${t}`;
  return {
    pre_call_webhook: calls,
    post_call_webhook: calls,
    post_outbound_call_webhook: calls,
    updated_call_webhook: calls,
    sms_received_webhook: `${base}/webhooks/callrail/sms?token=${t}&event=received`,
    sms_sent_webhook: `${base}/webhooks/callrail/sms?token=${t}&event=sent`,
  };
}
/**
 * Read one CallRail text delivery into our shape. `isTracking(norm)` says
 * whether a 10-digit number is one of our tracking numbers; the `event` hint
 * from the installer URL decides direction when neither number is known.
 */
function classifyTextDelivery(payload, isTracking, eventHint) {
  const p = payload && typeof payload === 'object' ? (payload.data && typeof payload.data === 'object' ? payload.data : payload) : {};
  const src = normPhone(p.source_number || p.from || p.customer_phone_number);
  const dst = normPhone(p.destination_number || p.to || p.tracking_phone_number);
  let direction = null, tracking = null, customer = null;
  if (dst && isTracking(dst)) { direction = 'inbound'; tracking = dst; customer = src; }
  else if (src && isTracking(src)) { direction = 'outbound'; tracking = src; customer = dst; }
  else if (eventHint === 'sent') { direction = 'outbound'; tracking = src; customer = dst; }
  else if (eventHint === 'received') { direction = 'inbound'; tracking = dst; customer = src; }
  const media = Array.isArray(p.media_urls) ? p.media_urls.map(String).filter(Boolean) : [];
  const type = String(p.message_type || p.type || (media.length ? 'mms' : 'sms')).toLowerCase() === 'mms' ? 'mms' : 'sms';
  return {
    direction, tracking, customer,
    callrail_message_id: p.id != null ? String(p.id) : (p.resource_id != null ? String(p.resource_id) : null),
    callrail_conversation_id: p.conversation_id != null ? String(p.conversation_id) : null,
    content: p.content != null ? String(p.content) : '',
    message_type: type,
    media_urls: media,
    created_at: toISO(p.timestamp || p.created_at) || new Date().toISOString(),
    lead_status: p.lead_status != null ? String(p.lead_status) : null,
    customer_name: p.customer_name || p.formatted_customer_name || null,
    company_resource_id: p.company_resource_id != null ? String(p.company_resource_id) : null,
  };
}
/** Pick the job for a customer phone: Mitigation first, then the texting location, then active, then newest. */
function rankJobs(rows, locationId) {
  const list = Array.isArray(rows) ? rows : [];
  const rank = (j) => [j.record_type === 'Mitigation' ? 0 : 1, locationId && j.location_id === locationId ? 0 : 1, j.is_active === false ? 1 : 0];
  return list.slice().sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return String(b.jn_created || '').localeCompare(String(a.jn_created || ''));
  })[0] || null;
}
function validateContent(raw) {
  const content = String(raw ?? '').replace(/\r\n/g, '\n').trim();
  if (!content) return { error: 'Type a message first.' };
  if (content.length > CONTENT_MAX) return { error: `CallRail texts are limited to ${CONTENT_MAX} characters (this one is ${content.length}).` };
  return { content };
}
function callrailSendError(r) {
  if (r.status === 429) return "CallRail's hourly texting limit is reached. Try again in a few minutes.";
  const msg = (r.json && (r.json.error || r.json.message || (Array.isArray(r.json.errors) ? r.json.errors.join('; ') : null))) || r.text || '';
  if (r.status === 422 && /opt|stop|unsubscrib/i.test(msg)) return 'This number has opted out of texts.';
  if (r.status === 422 && /regist/i.test(msg)) return 'This CallRail account is not registered for texting yet (TCR). Finish registration in CallRail first.';
  if (r.status === 404 && /locate tracking number/i.test(msg)) return 'CallRail cannot text from this number: it is not text-enabled in this company, or this thread (e.g. a Google Local Services message) cannot be answered by SMS. Check the number under CallRail → Numbers → Texting.';
  return `CallRail rejected the text (${r.status})${msg ? `: ${String(msg).slice(0, 200)}` : ''}`;
}

// Push goes only to people assigned to the text's location (owner 2026-10-30) —
// admins and owners included, even though the inbox shows them every location.
function assignedLocations(p) {
  if (Array.isArray(p.location_ids) && p.location_ids.length) return p.location_ids.map(String);
  return p.location_id ? [String(p.location_id)] : [];
}
function pushRecipientIds(profiles, locationId) {
  if (!locationId) return [];
  return (profiles || []).filter((p) => assignedLocations(p).includes(String(locationId))).map((p) => String(p.id));
}

module.exports = function mountSms(app, deps) {
  const {
    SUPABASE_URL, SUPABASE_SERVICE_KEY, PUBLIC_BASE_URL,
    requireAuth, requireCallAccess, callrailWebhookOk, loadActor,
    sbGet, sbPatch, sbUpsert, jnSendJson, UUID_RE,
    callrailApi, callrailApiWrite, CALLRAIL_ACCOUNT_IDS, CALLRAIL_API_KEY, anthropic,
  } = deps;
  const summarizeForPush = deps.summarizeForPush || makeSummarizer({ anthropic });
  const enc = encodeURIComponent;
  const log = (...a) => console.log('[sms]', ...a);
  const warn = (...a) => console.warn('[sms]', ...a);
  const SB_HEADERS = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' };

  // Insert that returns the row (server.js's sbInsert is return=minimal).
  async function sbInsertRow(table, row) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, { method: 'POST', headers: { ...SB_HEADERS, Prefer: 'return=representation' }, body: JSON.stringify(row) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${table} insert ${r.status} ${text.slice(0, 300)}`);
    let rows = null; try { rows = text ? JSON.parse(text) : null; } catch {}
    return (Array.isArray(rows) ? rows[0] : rows) || row;
  }
  async function patchRow(table, id, patch) {
    const rows = await sbPatch(table, `id=eq.${enc(id)}`, patch);
    return Array.isArray(rows) ? rows[0] : rows;
  }

  // ── Tracking numbers ──────────────────────────────────────────────────────
  let trackingCache = { at: 0, byNorm: new Map() };
  async function trackingNumbers(force = false) {
    if (!force && Date.now() - trackingCache.at < 5 * 60 * 1000 && trackingCache.byNorm.size) return trackingCache.byNorm;
    const rows = (await sbGet('location_tracking_numbers?select=id,location_id,phone_number,phone_norm,callrail_account_id,callrail_company_id,callrail_tracker_id,label,active&active=eq.true')) || [];
    const byNorm = new Map();
    for (const r of rows) if (r.phone_norm) byNorm.set(String(r.phone_norm), r);
    trackingCache = { at: Date.now(), byNorm };
    return byNorm;
  }
  // CallRail tracker names → location_tracking_numbers.label (the app shows the
  // name wherever a number is picked). Hourly, and after an assignment lands.
  let labelsAt = 0;
  async function refreshTrackingLabels(force = false) {
    if (!CALLRAIL_API_KEY || !CALLRAIL_ACCOUNT_IDS.length) return { updated: 0 };
    if (!force && Date.now() - labelsAt < 60 * 60 * 1000) return { updated: 0, skipped: true };
    labelsAt = Date.now();
    const rows = (await sbGet('location_tracking_numbers?select=id,phone_norm,label,callrail_company_id,callrail_account_id&active=eq.true')) || [];
    const byNorm = new Map(rows.map((r) => [String(r.phone_norm), r]));
    let updated = 0;
    for (const acct of CALLRAIL_ACCOUNT_IDS) {
      for (let page = 1; page <= 20; page++) {
        const r = await callrailApi(acct, `trackers.json?per_page=250&page=${page}`);
        if (!r.ok) { warn('trackers', acct, r.status); break; }
        const list = (r.json && (r.json.trackers || r.json.data)) || [];
        for (const t of list) {
          const name = String(t.name || '').trim();
          const companyId = (t.company && t.company.id != null) ? String(t.company.id) : (t.company_id != null ? String(t.company_id) : null);
          const nums = Array.isArray(t.tracking_numbers) ? t.tracking_numbers : (t.tracking_number ? [t.tracking_number] : []);
          for (const n of nums) {
            const row = byNorm.get(normPhone(n) || '');
            if (!row) continue;
            const patch = {};
            if (name && row.label !== name) patch.label = name;
            // Numbers move between CallRail companies; a stale id makes CallRail 404 a send.
            if (companyId && row.callrail_company_id !== companyId) patch.callrail_company_id = companyId;
            if (row.callrail_account_id !== String(acct)) patch.callrail_account_id = String(acct);
            if (Object.keys(patch).length) { await sbPatch('location_tracking_numbers', `id=eq.${enc(row.id)}`, patch).catch(() => {}); Object.assign(row, patch); updated++; }
          }
        }
        if (list.length < 250) break;
      }
    }
    if (updated) log('tracker labels/companies', updated);
    return { updated };
  }
  app.post('/admin/callrail/tracker-labels', requireCallAccess, async (req, res) => {
    try { res.json({ ok: true, ...(await refreshTrackingLabels(true)) }); } catch (e) { res.status(502).json({ error: e.message }); }
  });

  // Which CallRail account owns a tracking number (stored on the row; else try each).
  async function accountFor(trackingRow, convRow) {
    if (convRow && convRow.callrail_account_id) return String(convRow.callrail_account_id);
    if (trackingRow && trackingRow.callrail_account_id) return String(trackingRow.callrail_account_id);
    return CALLRAIL_ACCOUNT_IDS[0] || null;
  }

  // ── Job matching ──────────────────────────────────────────────────────────
  async function matchJobByPhone(custNorm, locationId) {
    if (!custNorm) return null;
    const direct = await sbGet(`jobs?client_phone_norm=eq.${custNorm}&select=id,date_contacted,location_id,record_type,is_active,jn_created&order=jn_created.desc&limit=25`);
    let pick = rankJobs(direct, locationId);
    if (!pick) {
      const viaContact = await sbGet(`job_contacts?phone_norm=eq.${custNorm}&select=job_id,jobs(id,date_contacted,location_id,record_type,is_active,jn_created)&limit=25`);
      pick = rankJobs((Array.isArray(viaContact) ? viaContact : []).map((c) => c.jobs).filter(Boolean), locationId);
    }
    return pick;
  }

  // ── Conversation + message ingest (webhook, reply, sync, backfill) ───────
  async function findConversation({ callrailConversationId, trackingNorm, custNorm }) {
    if (callrailConversationId) {
      const byId = await sbGet(`sms_conversations?callrail_conversation_id=eq.${enc(callrailConversationId)}&select=*&limit=1`);
      if (Array.isArray(byId) && byId[0]) return byId[0];
    }
    if (trackingNorm && custNorm) {
      const byPair = await sbGet(`sms_conversations?tracking_phone_norm=eq.${trackingNorm}&customer_phone_norm=eq.${custNorm}&order=last_message_at.desc.nullslast&limit=5&select=*`);
      const list = Array.isArray(byPair) ? byPair : [];
      // Prefer one still waiting for its CallRail id (we started it), else the newest.
      return list.find((c) => !c.callrail_conversation_id) || list[0] || null;
    }
    return null;
  }

  /**
   * Store one message and roll the conversation up. `m` is the shape from
   * classifyTextDelivery (+ optional sent_by / sent_by_name / job_id /
   * customer_name / source). Returns { conversation, message, inserted }.
   */
  async function ingestMessage(m, { trackingRow: trackingRowIn, notify = true, conv: convIn = null, knownIds = null, skipJobMatch = false } = {}) {
    const trackingNorm = normPhone(m.tracking);
    const custNorm = normPhone(m.customer);
    const trackingRow = trackingRowIn || (trackingNorm ? (await trackingNumbers()).get(trackingNorm) : null) || null;
    let conv = convIn || await findConversation({ callrailConversationId: m.callrail_conversation_id, trackingNorm, custNorm });
    const now = new Date().toISOString();
    if (!conv) {
      conv = await sbInsertRow('sms_conversations', {
        id: crypto.randomUUID(),
        callrail_conversation_id: m.callrail_conversation_id || null,
        callrail_account_id: (trackingRow && trackingRow.callrail_account_id) || m.callrail_account_id || null,
        callrail_company_id: (trackingRow && trackingRow.callrail_company_id) || m.company_resource_id || null,
        location_id: (trackingRow && trackingRow.location_id) || null,
        tracking_phone_number: (trackingRow && trackingRow.phone_number) || m.tracking || null,
        customer_phone_number: m.customer || null,
        customer_name: m.customer_name || null,
        job_id: m.job_id || null,
        source: m.source || null,
        lead_status: m.lead_status || null,
        created_at: m.created_at || now,
      });
    }

    // Dedupe: already stored by CallRail id? (a sync hands us the thread's
    // stored ids in one read, so no per-message lookup there)
    if (m.callrail_message_id) {
      if (knownIds) {
        if (knownIds.has(String(m.callrail_message_id))) return { conversation: conv, message: null, inserted: false };
      } else {
        const dup = await sbGet(`sms_messages?callrail_message_id=eq.${enc(m.callrail_message_id)}&select=id&limit=1`);
        if (Array.isArray(dup) && dup[0]) return { conversation: conv, message: dup[0], inserted: false };
      }
    }
    let message = null;
    // Our own send confirmed by CallRail's sent-webhook: attach the id instead of a second row.
    if (m.direction === 'outbound' && m.callrail_message_id) {
      const pending = await sbGet(`sms_messages?conversation_id=eq.${enc(conv.id)}&direction=eq.outbound&callrail_message_id=is.null&order=created_at.desc&limit=5&select=id,content,created_at`);
      const hit = (Array.isArray(pending) ? pending : []).find((p) => String(p.content || '').trim() === String(m.content || '').trim()
        && Math.abs(new Date(p.created_at).getTime() - new Date(m.created_at).getTime()) < DEDUPE_WINDOW_MS);
      if (hit) message = await patchRow('sms_messages', hit.id, { callrail_message_id: m.callrail_message_id, status: m.status || 'delivered' });
    }
    let inserted = false;
    if (!message) {
      message = await sbInsertRow('sms_messages', {
        id: crypto.randomUUID(),
        callrail_message_id: m.callrail_message_id || null,
        conversation_id: conv.id,
        direction: m.direction,
        content: m.content || null,
        message_type: m.message_type || 'sms',
        media_urls: Array.isArray(m.media_urls) ? m.media_urls : [],
        status: m.status || (m.direction === 'inbound' ? 'received' : 'sent'),
        sent_by: m.sent_by || null,
        sent_by_name: m.direction === 'outbound' ? (m.sent_by_name || null) : null,   // unknown until attributeSender names the CallRail user
        created_at: m.created_at || now,
      });
      inserted = true;
    }

    // Roll-up.
    const at = m.created_at || now;
    const patch = {};
    if (!conv.last_message_at || at >= conv.last_message_at) { patch.last_message_at = at; patch.last_preview = previewOf(m.content, m.media_urls); patch.last_direction = m.direction; }
    if (m.direction === 'inbound') {
      if (!conv.last_inbound_at || at > conv.last_inbound_at) patch.last_inbound_at = at;
      if (!conv.first_inbound_at || at < conv.first_inbound_at) patch.first_inbound_at = at;
    } else {
      if (!conv.last_outbound_at || at > conv.last_outbound_at) patch.last_outbound_at = at;
      const firstIn = conv.first_inbound_at || patch.first_inbound_at;
      if (firstIn && at >= firstIn && (!conv.first_reply_at || at < conv.first_reply_at)) { patch.first_reply_at = at; patch.first_reply_by_name = m.sent_by_name || null; }
    }
    if (!conv.callrail_conversation_id && m.callrail_conversation_id) patch.callrail_conversation_id = m.callrail_conversation_id;
    if (!conv.customer_name && m.customer_name) patch.customer_name = m.customer_name;
    if (m.lead_status && m.lead_status !== conv.lead_status) patch.lead_status = m.lead_status;
    if (!conv.source && m.source) patch.source = m.source;
    // Stored before the tracking number was assigned to a location in Settings →
    // Call Tracking: adopt the location (and account / company) now.
    if (!conv.location_id && trackingRow && trackingRow.location_id) {
      patch.location_id = trackingRow.location_id;
      if (!conv.callrail_account_id && trackingRow.callrail_account_id) patch.callrail_account_id = trackingRow.callrail_account_id;
      if (!conv.callrail_company_id && trackingRow.callrail_company_id) patch.callrail_company_id = trackingRow.callrail_company_id;
    }
    if (!conv.job_id && (m.job_id || !skipJobMatch)) {
      const job = m.job_id ? { id: m.job_id } : await matchJobByPhone(custNorm || conv.customer_phone_norm, patch.location_id || conv.location_id).catch(() => null);
      if (job) patch.job_id = job.id;
    }
    if (Object.keys(patch).length) conv = (await patchRow('sms_conversations', conv.id, patch)) || { ...conv, ...patch };

    // Source (the Google LSA signal) comes from the conversation record, not the webhook.
    if (!conv.source && conv.callrail_conversation_id && CALLRAIL_API_KEY) {
      fetchConversationFacts(conv).then(async (facts) => {
        if (facts && (facts.source || facts.customer_name)) {
          const p = {}; if (facts.source) p.source = facts.source; if (facts.customer_name && !conv.customer_name) p.customer_name = facts.customer_name;
          if (Object.keys(p).length) await patchRow('sms_conversations', conv.id, p).catch(() => {});
        }
      }).catch(() => {});
    }
    if (inserted && m.direction === 'inbound' && notify) pushInbound(conv, message).catch((e) => warn('push', e.message));
    // A text typed in CallRail's own inbox arrives without its sender; the
    // conversation record names the user (owner 2026-10-28: show the person, never "CallRail").
    if (inserted && m.direction === 'outbound' && !m.sent_by_name && m.callrail_message_id) {
      attributeSender(conv, message).catch((e) => warn('attribute sender', e.message));
    }
    return { conversation: conv, message, inserted };
  }

  async function attributeSender(conv, message) {
    const facts = await fetchConversationFacts(conv);
    if (!facts) return;
    const hit = facts.messages.find((x) => String(x.id) === String(message.callrail_message_id));
    const name = hit && hit.user && hit.user.name ? String(hit.user.name).trim() : '';
    if (!name) return;
    await patchRow('sms_messages', message.id, { sent_by_name: name });
    const fresh = await loadConversation(conv.id);
    if (fresh && fresh.first_reply_at && !fresh.first_reply_by_name && fresh.first_reply_at === message.created_at) {
      await patchRow('sms_conversations', conv.id, { first_reply_by_name: name });
    }
  }

  async function fetchConversationFacts(conv) {
    const acct = await accountFor(null, conv);
    if (!acct || !conv.callrail_conversation_id) return null;
    const r = await callrailApi(acct, `text-messages/${enc(conv.callrail_conversation_id)}.json?fields=source,lead_status`);
    if (!r.ok || !r.json) return null;
    const j = r.json;
    return { source: j.source || null, lead_status: j.lead_status || null, customer_name: j.customer_name || j.formatted_customer_name || null, state: j.state || null, messages: Array.isArray(j.messages) ? j.messages : [] };
  }

  // ── Push (Expo; native builds only) ───────────────────────────────────────
  const pushRecent = new Map(); // conversation id → last push ms
  async function pushInbound(conv, message) {
    if (!conv || !conv.location_id) return;
    // Google's "Replies to this number…" relay notice is not the customer talking.
    if (prepareSummary({ content: message && message.content }).skip) return;
    const last = pushRecent.get(conv.id) || 0;
    if (Date.now() - last < PUSH_THROTTLE_MS) return;
    pushRecent.set(conv.id, Date.now());
    const profiles = (await sbGet(`profiles?select=id,role,location_id,location_ids&role=in.(${SENDER_ROLES.join(',')})`)) || [];
    const ids = pushRecipientIds(profiles, conv.location_id);
    if (!ids.length) return;
    const tokens = (await sbGet(`push_tokens?select=token,profile_id&profile_id=in.(${ids.map(enc).join(',')})`)) || [];
    if (!tokens.length) return;
    // Lock-screen summary (pushSummary.js): LSA template parsed, long texts summarised by a small model.
    const sum = await summarizeForPush({
      customerName: conv.customer_name, phoneLabel: fmtPhone(conv.customer_phone_number),
      content: message && message.content, mediaUrls: message && message.media_urls,
    });
    if (!sum) return;
    const { title, body } = sum;
    const messages = tokens.map((t) => ({ to: t.token, title, body, sound: 'default', data: { conversation_id: conv.id, url: `/messages/${conv.id}` } }));
    for (let i = 0; i < messages.length; i += 100) {
      const r = await fetch('https://exp.host/--/api/v2/push/send', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(messages.slice(i, i + 100)) });
      if (!r.ok) warn('expo push', r.status, (await r.text()).slice(0, 200));
    }
  }
  const fmtPhone = (raw) => { const d = String(raw || '').replace(/\D/g, ''); const n = d.length === 11 && d.startsWith('1') ? d.slice(1) : d; return n.length === 10 ? `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}` : String(raw || '').trim(); };

  app.post('/me/push-token', requireAuth, async (req, res) => {
    const token = String((req.body && req.body.token) || '').trim();
    if (!/^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/.test(token)) return res.status(400).json({ error: 'Not an Expo push token' });
    try {
      await sbUpsert('push_tokens', { profile_id: req.userId, token, platform: String((req.body && req.body.platform) || '').slice(0, 20) || null, updated_at: new Date().toISOString() }, 'token');
      res.json({ ok: true });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  // ── Webhook ───────────────────────────────────────────────────────────────
  app.post('/webhooks/callrail/sms', async (req, res) => {
    if (!callrailWebhookOk(req)) {
      warn('rejected delivery: token mismatch or CALLRAIL_WEBHOOK_TOKEN unset');
      return res.status(401).json({ error: 'unauthorized' });
    }
    let body = req.body;
    if (Array.isArray(body)) body = body[0];
    if (!body || typeof body !== 'object') return res.status(200).json({ ok: true, skipped: 'empty' });
    try {
      const byNorm = await trackingNumbers();
      const m = classifyTextDelivery(body, (n) => byNorm.has(n), String(req.query.event || ''));
      if (!m.direction || !m.tracking) return res.status(200).json({ ok: true, skipped: 'no tracking number matched' });
      const trackingRow = byNorm.get(normPhone(m.tracking)) || null;
      const { conversation, message, inserted } = await ingestMessage(m, { trackingRow });
      return res.status(200).json({ ok: true, conversation_id: conversation.id, message_id: message && message.id, inserted, direction: m.direction, location_id: conversation.location_id || null, job_id: conversation.job_id || null });
    } catch (err) {
      // Always 200 after the token check: CallRail retries are noise; the reconcile pull repairs.
      console.error('[sms-webhook] error', err.message);
      return res.status(200).json({ ok: false, error: err.message });
    }
  });

  // ── Access ────────────────────────────────────────────────────────────────
  function canSee(actor, locationId) {
    if (!actor) return false;
    if (SEES_ALL.includes(actor.role)) return true;
    return !!locationId && actor.locs.includes(String(locationId));
  }
  function canSend(actor, locationId) {
    if (!actor) return false;
    if (actor.role === 'admin' || actor.role === 'owner') return true;
    const allowed = actor.role === 'expansion_manager' || (actor.perms && actor.perms.view_messages === true);
    return allowed && !!locationId && actor.locs.includes(String(locationId));
  }
  async function loadConversation(id) {
    if (!UUID_RE.test(String(id))) return null;
    const rows = await sbGet(`sms_conversations?id=eq.${enc(id)}&select=*`);
    return rows && rows[0] ? rows[0] : null;
  }

  // ── Send ──────────────────────────────────────────────────────────────────
  async function sendText({ account, companyId, altCompanyId = null, trackingNumber, customerPhone, content, mediaUrl, hasConversation = false }) {
    if (!CALLRAIL_API_KEY) return { ok: false, error: 'CallRail is not configured on the server' };
    if (!account) return { ok: false, error: 'This tracking number has no CallRail account on file. Re-assign it under Settings → Call Tracking.' };
    const tracking = toE164(trackingNumber), customer = toE164(customerPhone);
    if (!tracking || !customer) return { ok: false, error: 'This thread has a phone number CallRail cannot text (needs a full US/CA number).' };
    // CallRail answers 404 "Could not locate tracking number or related
    // conversation" when the number is not in that company (numbers move
    // between companies; our row may be stale) or when it wants to find the
    // conversation itself. Try: as asked → without the number (an existing
    // conversation is enough) → the other company id we know.
    const attempts = [{ company_id: companyId, tracking_number: tracking }];
    if (hasConversation) attempts.push({ company_id: companyId });
    if (altCompanyId && altCompanyId !== companyId) {
      attempts.push({ company_id: altCompanyId, tracking_number: tracking });
      if (hasConversation) attempts.push({ company_id: altCompanyId });
    }
    let r = null;
    for (const a of attempts) {
      const body = { ...a, customer_phone_number: customer, content };
      if (mediaUrl) body.media_url = mediaUrl;
      r = await callrailApiWrite(account, 'POST', 'text-messages.json', body);
      if (r.ok || r.status !== 404) break;
      warn('send 404', JSON.stringify({ company: a.company_id, tracking: a.tracking_number || '(omitted)', customer }), r.text);
    }
    if (!r.ok) return { ok: false, status: r.status, error: callrailSendError(r), tried: attempts.length };
    const j = r.json || {};
    // The 201 body is not documented in detail; keep whatever ids come back.
    const msgs = Array.isArray(j.messages) ? j.messages : (Array.isArray(j.recent_messages) ? j.recent_messages : []);
    const newest = msgs.find((x) => x && String(x.direction || '').toLowerCase().startsWith('out')) || msgs[0] || null;
    return { ok: true, conversation_id: j.id != null && (msgs.length || j.customer_phone_number) ? String(j.id) : null, message_id: newest && newest.id != null ? String(newest.id) : null };
  }

  app.post('/sms/conversations/:id/reply', requireAuth, async (req, res) => {
    try {
      const conv = await loadConversation(req.params.id);
      if (!conv) return res.status(404).json({ error: 'Conversation not found' });
      const actor = await loadActor(req);
      if (!canSend(actor, conv.location_id)) return res.status(403).json({ error: 'You cannot text from this location' });
      const v = validateContent(req.body && req.body.content);
      if (v.error) return res.status(400).json({ error: v.error });
      const mediaUrl = req.body && req.body.media_url ? String(req.body.media_url).slice(0, 1000) : null;
      const byNorm = await trackingNumbers();
      const trackingRow = byNorm.get(String(conv.tracking_phone_norm || '')) || null;
      const account = await accountFor(trackingRow, conv);
      const companyId = conv.callrail_company_id || (trackingRow && trackingRow.callrail_company_id);
      if (!companyId) return res.status(400).json({ error: 'This tracking number has no CallRail company on file. Re-assign it under Settings → Call Tracking.' });
      const sent = await sendText({ account, companyId, altCompanyId: (trackingRow && trackingRow.callrail_company_id) || null, trackingNumber: conv.tracking_phone_number, customerPhone: conv.customer_phone_number, content: v.content, mediaUrl, hasConversation: !!conv.callrail_conversation_id });
      if (!sent.ok) return res.status(sent.status === 429 ? 429 : 502).json({ error: sent.error });
      const { conversation, message } = await ingestMessage({
        direction: 'outbound', tracking: conv.tracking_phone_number, customer: conv.customer_phone_number,
        callrail_message_id: sent.message_id, callrail_conversation_id: conv.callrail_conversation_id || sent.conversation_id,
        content: v.content, message_type: mediaUrl ? 'mms' : 'sms', media_urls: mediaUrl ? [mediaUrl] : [],
        created_at: new Date().toISOString(), status: 'sent', sent_by: actor.id, sent_by_name: actor.name,
      }, { trackingRow, notify: false });
      res.json({ ok: true, conversation, message });
    } catch (err) { warn('reply failed', err.message); res.status(502).json({ error: err.message }); }
  });

  app.post('/sms/conversations', requireAuth, async (req, res) => {
    try {
      const b = req.body || {};
      const locationId = String(b.location_id || '');
      if (!UUID_RE.test(locationId)) return res.status(400).json({ error: 'location_id required' });
      const actor = await loadActor(req);
      if (!canSend(actor, locationId)) return res.status(403).json({ error: 'You cannot text from this location' });
      const custNorm = normPhone(b.customer_phone);
      if (!custNorm || custNorm.length !== 10) return res.status(400).json({ error: 'Enter a 10-digit phone number' });
      const v = validateContent(b.content);
      if (v.error) return res.status(400).json({ error: v.error });
      const numbers = [...(await trackingNumbers(true)).values()].filter((n) => String(n.location_id) === locationId);
      if (!numbers.length) return res.status(400).json({ error: 'This location has no tracking numbers assigned (Settings → Call Tracking)' });
      const trackingRow = b.tracking_number_id ? numbers.find((n) => String(n.id) === String(b.tracking_number_id)) : (numbers.length === 1 ? numbers[0] : null);
      if (!trackingRow) return res.status(400).json({ error: numbers.length > 1 ? 'Pick which number to send from' : 'Tracking number not found at this location' });
      if (trackingRow.phone_norm === custNorm) return res.status(400).json({ error: 'That is one of your own tracking numbers' });
      let jobId = null;
      if (b.job_id) {
        if (!UUID_RE.test(String(b.job_id))) return res.status(400).json({ error: 'Bad job id' });
        const job = await sbGet(`jobs?id=eq.${enc(b.job_id)}&select=id,location_id`);
        if (!job || !job[0]) return res.status(404).json({ error: 'Job not found' });
        if (!canSee(actor, job[0].location_id)) return res.status(403).json({ error: 'Job outside your locations' });
        jobId = job[0].id;
      }
      let account = await accountFor(trackingRow, null);
      if (!trackingRow.callrail_company_id) return res.status(400).json({ error: 'This tracking number has no CallRail company on file. Re-assign it under Settings → Call Tracking.' });
      let sent = await sendText({ account, companyId: trackingRow.callrail_company_id, trackingNumber: trackingRow.phone_number, customerPhone: custNorm, content: v.content });
      if (!sent.ok && sent.status === 404) {
        // The row's company may be stale (numbers move between CallRail companies): refresh from CallRail and try once more.
        await refreshTrackingLabels(true).catch(() => {});
        const fresh = (await trackingNumbers(true)).get(trackingRow.phone_norm);
        if (fresh && (fresh.callrail_company_id !== trackingRow.callrail_company_id || fresh.callrail_account_id !== trackingRow.callrail_account_id)) {
          account = await accountFor(fresh, null);
          sent = await sendText({ account, companyId: fresh.callrail_company_id, trackingNumber: fresh.phone_number, customerPhone: custNorm, content: v.content });
        }
      }
      if (!sent.ok) return res.status(sent.status === 429 ? 429 : 502).json({ error: sent.error });
      const { conversation, message } = await ingestMessage({
        direction: 'outbound', tracking: trackingRow.phone_number, customer: custNorm,
        callrail_message_id: sent.message_id, callrail_conversation_id: sent.conversation_id,
        content: v.content, message_type: 'sms', media_urls: [],
        created_at: new Date().toISOString(), status: 'sent', sent_by: actor.id, sent_by_name: actor.name,
        customer_name: b.customer_name ? String(b.customer_name).trim().slice(0, 120) : null, job_id: jobId,
      }, { trackingRow, notify: false });
      res.status(201).json({ ok: true, conversation, message });
    } catch (err) { warn('start failed', err.message); res.status(502).json({ error: err.message }); }
  });

  // ── History sync (one thread) and backfill / reconcile (many) ────────────
  function mapCallrailMessage(x, conv, callrailConversationId) {
    const dir = String(x.direction || '').toLowerCase();
    const direction = dir.startsWith('in') || dir === 'received' ? 'inbound' : 'outbound';
    const media = Array.isArray(x.media_urls) ? x.media_urls.map(String).filter(Boolean) : [];
    return {
      direction, tracking: conv.tracking_phone_number, customer: conv.customer_phone_number,
      callrail_message_id: x.id != null ? String(x.id) : null, callrail_conversation_id: callrailConversationId,
      content: x.content != null ? String(x.content) : '', message_type: String(x.type || '').toLowerCase() === 'mms' || media.length ? 'mms' : 'sms', media_urls: media,
      created_at: toISO(x.created_at) || new Date().toISOString(), status: x.status || null,
      sent_by_name: direction === 'outbound' ? ((x.user && x.user.name) || null) : null,
    };
  }
  async function syncConversation(conv) {
    const acct = await accountFor(null, conv);
    if (!acct || !conv.callrail_conversation_id) return { synced: 0 };
    const r = await callrailApi(acct, `text-messages/${enc(conv.callrail_conversation_id)}.json?fields=source,lead_status`);
    if (!r.ok || !r.json) return { synced: 0, error: `CallRail ${r.status}` };
    const j = r.json;
    const msgs = (Array.isArray(j.messages) ? j.messages : []).slice().sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
    const stored = (await sbGet(`sms_messages?conversation_id=eq.${enc(conv.id)}&select=callrail_message_id&limit=2000`)) || [];
    const knownIds = new Set(stored.map((r) => String(r.callrail_message_id || '')).filter(Boolean));
    const fresh = msgs.filter((x) => x.id == null || !knownIds.has(String(x.id)));
    let synced = 0;
    // One job match per thread (not one per message), and only when something is new.
    let jobId = conv.job_id || null;
    if (!jobId && fresh.length) { const job = await matchJobByPhone(conv.customer_phone_norm, conv.location_id).catch(() => null); jobId = job ? job.id : null; }
    for (const x of fresh) {
      const out = await ingestMessage({ ...mapCallrailMessage(x, conv, conv.callrail_conversation_id), source: j.source || null, lead_status: j.lead_status || null, customer_name: j.customer_name || null, job_id: !conv.job_id && jobId ? jobId : null },
        { notify: false, conv, knownIds, skipJobMatch: true });
      if (out.inserted) synced++;
      if (out.conversation) conv = out.conversation;
      await sleep(PACE_MS.message);
    }
    const patch = {};
    if (j.source && !conv.source) patch.source = j.source;
    if (j.state && j.state !== conv.state && ['active', 'archived'].includes(j.state)) patch.state = j.state;
    if (Object.keys(patch).length) await patchRow('sms_conversations', conv.id, patch).catch(() => {});
    return { synced };
  }
  app.post('/sms/conversations/:id/sync', requireAuth, async (req, res) => {
    try {
      const conv = await loadConversation(req.params.id);
      if (!conv) return res.status(404).json({ error: 'Conversation not found' });
      const actor = await loadActor(req);
      if (!canSee(actor, conv.location_id)) return res.status(403).json({ error: 'Not your location' });
      const out = await syncConversation(conv);
      res.json({ ok: true, ...out });
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  // List CallRail conversations changed in the window and store them (+ their messages).
  let pullRunning = false;
  let lastPull = null;   // { tag, days, startedAt, finishedAt, stats }
  async function pullConversations({ days = RECONCILE_LOOKBACK_DAYS, tag = 'reconcile' } = {}) {
    if (!CALLRAIL_API_KEY || !CALLRAIL_ACCOUNT_IDS.length) return { skipped: true };
    if (pullRunning) return { skipped: true, busy: true };
    pullRunning = true;
    const stats = { conversations: 0, messages: 0, errors: 0 };
    try {
      await refreshTrackingLabels().catch((e) => warn('labels', e.message));
      const byNorm = await trackingNumbers(true);
      const end = new Date(Date.now() + 86400 * 1000).toISOString().slice(0, 10);
      const start = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);
      for (const acct of CALLRAIL_ACCOUNT_IDS) {
        for (let page = 1; page <= 40; page++) {
          let r = await callrailApi(acct, `text-messages.json?per_page=250&page=${page}&start_date=${start}&end_date=${end}&fields=source,lead_status`);
          if (!r.ok) r = await callrailApi(acct, `text-messages.json?per_page=250&page=${page}&start_date=${start}&end_date=${end}`);
          if (!r.ok) { stats.errors++; warn(tag, 'list', acct, r.status); break; }
          const list = (r.json && (r.json.conversations || r.json.text_messages || r.json.data)) || [];
          for (const c of list) {
            try {
              const tracking = c.current_tracking_number || c.initial_tracking_number;
              const trackingRow = byNorm.get(normPhone(tracking) || '') || null;
              let conv = await findConversation({ callrailConversationId: c.id != null ? String(c.id) : null, trackingNorm: normPhone(tracking), custNorm: normPhone(c.customer_phone_number) });
              if (!conv) {
                conv = await sbInsertRow('sms_conversations', {
                  id: crypto.randomUUID(), callrail_conversation_id: String(c.id), callrail_account_id: String(acct),
                  callrail_company_id: c.company_id != null ? String(c.company_id) : (trackingRow && trackingRow.callrail_company_id) || null,
                  location_id: (trackingRow && trackingRow.location_id) || null,
                  tracking_phone_number: (trackingRow && trackingRow.phone_number) || tracking || null,
                  customer_phone_number: c.customer_phone_number || null, customer_name: c.customer_name || null,
                  source: c.source || null, lead_status: c.lead_status || null, state: c.state === 'archived' ? 'archived' : 'active',
                  created_at: toISO(c.last_message_at) || new Date().toISOString(),
                });
                stats.conversations++;
              } else {
                const p = {};
                if (!conv.callrail_conversation_id) p.callrail_conversation_id = String(c.id);
                if (!conv.callrail_account_id) p.callrail_account_id = String(acct);
                if (!conv.source && c.source) p.source = c.source;
                if (!conv.customer_name && c.customer_name) p.customer_name = c.customer_name;
                if (!conv.location_id && trackingRow && trackingRow.location_id) {
                  p.location_id = trackingRow.location_id;
                  if (!conv.callrail_company_id && trackingRow.callrail_company_id) p.callrail_company_id = trackingRow.callrail_company_id;
                }
                if (Object.keys(p).length) conv = (await patchRow('sms_conversations', conv.id, p)) || { ...conv, ...p };
              }
              // Full thread when CallRail says there is something newer than we hold.
              if (!conv.last_message_at || (toISO(c.last_message_at) || '') > conv.last_message_at) {
                const s = await syncConversation(conv);
                stats.messages += s.synced || 0;
              }
            } catch (e) { stats.errors++; warn(tag, 'conversation', e.message); }
            await sleep(PACE_MS.conversation);
          }
          if (list.length < 250) break;
          await sleep(PACE_MS.page);
        }
      }
      log(tag, JSON.stringify(stats), `${days}d`);
      lastPull = { ...(lastPull || {}), tag, days, finishedAt: new Date().toISOString(), stats };
      return stats;
    } finally { pullRunning = false; }
  }
  // Every boot: a paced 90-day pull in the background (idempotent — threads
  // we already hold cost one read each, only new messages are written), then
  // the 15-minute 2-day reconcile keeps up.
  async function bootPull() {
    lastPull = { tag: 'backfill-boot', days: BACKFILL_DAYS, startedAt: new Date().toISOString(), finishedAt: null, stats: null };
    return pullConversations({ days: BACKFILL_DAYS, tag: 'backfill-boot' });
  }
  app.get('/admin/texting/status', requireCallAccess, async (req, res) => {
    try {
      const [convs, msgs] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/sms_conversations?select=id`, { method: 'HEAD', headers: { ...SB_HEADERS, Prefer: 'count=exact' } }),
        fetch(`${SUPABASE_URL}/rest/v1/sms_messages?select=id`, { method: 'HEAD', headers: { ...SB_HEADERS, Prefer: 'count=exact' } }),
      ]);
      const count = (r) => { const m = /\/(\d+)$/.exec(r.headers.get('content-range') || ''); return m ? Number(m[1]) : null; };
      res.json({ ok: true, running: pullRunning, last_pull: lastPull, conversations: count(convs), messages: count(msgs), reconcile_minutes: RECONCILE_INTERVAL_MS / 60000 });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });
  app.post('/admin/sms/backfill', requireCallAccess, async (req, res) => {
    const days = Math.max(1, Math.min(Number((req.body && req.body.days) || BACKFILL_DAYS), MAX_BACKFILL_DAYS));
    try { res.json({ ok: true, ...(await pullConversations({ days, tag: 'backfill' })) }); }
    catch (err) { res.status(502).json({ error: err.message }); }
  });
  if (SUPABASE_SERVICE_KEY && CALLRAIL_API_KEY && CALLRAIL_ACCOUNT_IDS.length) {
    setTimeout(() => bootPull().catch((e) => warn('boot pull failed', e.message)), 90 * 1000);
    setInterval(() => pullConversations().catch((e) => warn('reconcile failed', e.message)), RECONCILE_INTERVAL_MS);
  }

  // ── Secondary contact on an existing job ──────────────────────────────────
  const DUP_NAME_RE = /display.?name|duplicate|already exists|already in use/i;
  app.post('/jobs/:id/contacts', requireAuth, async (req, res) => {
    try {
      if (!UUID_RE.test(String(req.params.id))) return res.status(400).json({ error: 'Bad job id' });
      const b = req.body || {};
      const first = String(b.first_name || '').trim().slice(0, 60);
      const last = String(b.last_name || '').trim().slice(0, 60);
      const phone = normPhone(b.phone);
      if (!first && !last) return res.status(400).json({ error: 'A name is required' });
      if (!phone) return res.status(400).json({ error: 'A phone number is required' });
      const jobs = await sbGet(`jobs?id=eq.${enc(req.params.id)}&select=id,jn_id,name,location_id,record_type,jn_contact_id`);
      const job = jobs && jobs[0];
      if (!job) return res.status(404).json({ error: 'Job not found' });
      const actor = await loadActor(req);
      if (!actor || !(actor.role === 'admin' || ((actor.role === 'owner' || actor.role === 'expansion_manager' || (actor.perms && (actor.perms.create_jobs === true || actor.perms.view_messages === true))) && actor.locs.includes(String(job.location_id))))) {
        return res.status(403).json({ error: 'You cannot add contacts to this job' });
      }
      const locs = await sbGet(`locations?id=eq.${enc(job.location_id)}&select=id,jn_location_id`);
      const jnLocId = locs && locs[0] && locs[0].jn_location_id ? Number(locs[0].jn_location_id) : null;
      const relationship = String(b.relationship || '').trim().slice(0, 60);
      const email = String(b.email || '').trim().slice(0, 120);
      let jnContactId = null, jnError = null;
      if (job.jn_id && jnSendJson) {
        const baseName = `${first} ${last}`.trim();
        for (let attempt = 0; attempt < 5 && !jnContactId; attempt++) {
          const displayName = attempt === 0 ? baseName : `${baseName} (${attempt + 1})`;
          const r = await jnSendJson('POST', 'contacts', {
            record_type_name: job.record_type || 'Mitigation', status_name: 'Lead',
            display_name: displayName, first_name: first || undefined, last_name: last || undefined,
            mobile_phone: phone, email: email || undefined,
            location: jnLocId ? { id: jnLocId } : undefined,
            description: `${relationship ? `Relationship: ${relationship}\n` : ''}Secondary contact for ${job.name || 'the job'} (added from a text in DryOps by ${actor.name})`,
            related: [{ id: job.jn_id, type: 'job' }, ...(job.jn_contact_id ? [{ id: job.jn_contact_id, type: 'contact' }] : [])],
          });
          if (r.ok && r.body && (r.body.jnid || r.body.id)) { jnContactId = String(r.body.jnid || r.body.id); break; }
          const msg = (r.body && (r.body.message || r.body.error)) || r.text || '';
          if (!DUP_NAME_RE.test(msg)) { jnError = `JobNimbus ${r.status}: ${String(msg).slice(0, 200)}`; break; }
        }
        if (!jnContactId && !jnError) jnError = 'Every name variant already exists in JobNimbus';
      }
      const contact = await sbInsertRow('job_contacts', {
        id: crypto.randomUUID(), job_id: job.id, jn_contact_id: jnContactId, first_name: first || null, last_name: last || null,
        phone, email: email || null, role: 'secondary', relationship: relationship || null, is_primary: false,
      });
      let conversation = null;
      if (b.conversation_id && UUID_RE.test(String(b.conversation_id))) {
        const conv = await loadConversation(b.conversation_id);
        if (conv && canSee(actor, conv.location_id)) conversation = await patchRow('sms_conversations', conv.id, { job_id: job.id, customer_name: conv.customer_name || `${first} ${last}`.trim() || null });
      }
      res.status(201).json({ ok: true, contact, jn_contact_id: jnContactId, warning: jnError, conversation });
    } catch (err) { warn('add contact failed', err.message); res.status(502).json({ error: err.message }); }
  });

  return { ingestMessage, pullConversations, syncConversation, trackingNumbers };
};

module.exports.webhookTargets = webhookTargets;
module.exports.classifyTextDelivery = classifyTextDelivery;
module.exports.toE164 = toE164;
module.exports.rankJobs = rankJobs;
module.exports.previewOf = previewOf;
module.exports.pushRecipientIds = pushRecipientIds;
module.exports.validateContent = validateContent;
module.exports.callrailSendError = callrailSendError;
module.exports.CONTENT_MAX = CONTENT_MAX;
