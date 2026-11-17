'use strict';

// Google Local Services leads through the Google Ads API.
//
// The two browser bots (lsa-bot/) download CSV reports; this reads the same leads from
// the API and writes them to the same table, lsa_leads, keyed on Google's lead id. The
// API covers accounts on the old dashboard and accounts already moved into Google Ads,
// and its client customer id IS the old report's "Account ID".
//
// Shape of one run (syncLeads):
//   1. customers:listAccessibleCustomers → the manager accounts the service account is on
//   2. per manager: customer_client → its client accounts
//   3. per chosen client account: local_services_lead (a manager-level query returns nothing)
//   4. per client account that had a lead: local_services_lead_conversation (call length, texts)
//
// The API allows 2,880 operations per rolling 24 hours at our access level and every
// search request is one. So: every Google request is counted, a run stops at
// LSA_API_MAX_OPS, and accounts that never have leads are only looked at once a week
// (lsa_api_accounts remembers which those are). Schema: supabase_lsa_api_sync.sql; the
// sync still loads leads when that file has not been run, it only skips the two extras.
//
// After the leads, the same run reads what each campaign cost per day (costPass):
//   5. per account with leads or recent spend: campaign + segments.date + metrics → lsa_campaign_daily
// One request per account, on the same request counter. Schema: supabase_lsa_api_cost.sql;
// without it the cost pass is skipped and the leads still load.
//
// Pure mapping / diffing / selection is exported for tests; routes are mounted from server.js.

const crypto = require('crypto');
const { keyOk, restDb, isApiHash } = require('./lsaImport');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/adwords';

// The fields the API owns on a lead. Everything else on the row (geo, external_lead_id,
// zipcode, booking_local, charged_call_local, dispute_status, customer_phone_ext,
// campaign_name) only the CSV reports know, and is never sent by this module.
const API_OWNED = [
  'account_id', 'business_name', 'lead_created_local', 'time_known', 'source_format', 'lead_type', 'lead_category',
  'job_type', 'customer_phone', 'customer_name', 'customer_email', 'campaign_id', 'charge_status', 'charged',
];
// Fields whose changes are written to lsa_lead_changes (from a non-null value only).
const API_LOGGED = ['account_id', 'charged', 'charge_status', 'campaign_id'];

const LEAD_QUERY = 'SELECT local_services_lead.id, local_services_lead.lead_type, local_services_lead.lead_status, '
  + 'local_services_lead.creation_date_time, local_services_lead.lead_charged, local_services_lead.credit_details.credit_state, '
  + 'local_services_lead.credit_details.credit_state_last_update_date_time, local_services_lead.category_id, '
  + 'local_services_lead.service_id, local_services_lead.contact_details, local_services_lead.campaign, '
  + 'local_services_lead.locale, customer.id, customer.descriptive_name FROM local_services_lead';
const CONVERSATION_QUERY = 'SELECT local_services_lead_conversation.id, local_services_lead_conversation.lead, '
  + 'local_services_lead_conversation.event_date_time, local_services_lead_conversation.conversation_channel, '
  + 'local_services_lead_conversation.participant_type, local_services_lead_conversation.phone_call_details.call_duration_millis, '
  + 'local_services_lead_conversation.phone_call_details.call_recording_url, local_services_lead_conversation.message_details.text '
  + 'FROM local_services_lead_conversation';
// Level 0 is the account itself (tells us whether it is a manager), level 1 its direct clients.
const CLIENT_QUERY = 'SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.level, '
  + 'customer_client.status, customer_client.time_zone FROM customer_client WHERE customer_client.level <= 1';

// One row per campaign per day that had activity. Every channel is kept: an account moved
// to pay-per-lead has its old LOCAL_SERVICES campaign and a new PERFORMANCE_MAX one.
const COST_QUERY = 'SELECT campaign.id, campaign.name, campaign.advertising_channel_type, campaign.status, '
  + 'customer.id, customer.currency_code, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, '
  + 'metrics.conversions, metrics.top_impression_percentage, metrics.absolute_top_impression_percentage FROM campaign';
// Channels a Local Services lead can come from: their campaigns are added to lsa_campaigns
// by the cost pass. Any other campaign only gets its name refreshed when it is already there.
const LEAD_CHANNELS = ['LOCAL_SERVICES', 'PERFORMANCE_MAX'];
const COST_RECENT_DAYS = 60;

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const digits = (v) => String(v ?? '').replace(/\D/g, '');
const text = (v) => { const s = String(v ?? '').trim(); return s === '' ? null : s; };
// Stored timestamps come back as "2026-10-31T10:08:57"; ours are "2026-10-31 10:08:57".
const show = (v) => (v === null || v === undefined ? null : String(v).replace(/^(\d{4}-\d{2}-\d{2})T/, '$1 '));
const isPseudoAccount = (id) => String(id || '').startsWith('C');
/** "2026-11-02 14:42:22.988607" → "2026-11-02 14:42:22" (account-local, no zone); null when unreadable. */
const cutSeconds = (v) => { const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(String(v ?? '')); return m ? `${m[1]} ${m[2]}` : null; };
/** JSON with object keys in order, so a jsonb value read back compares equal to the one written. */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** The charge columns, with the meanings the pay-per-lead CSV import uses. */
function apiCharge(lead) {
  const credit = lead && lead.creditDetails && lead.creditDetails.creditState;
  if (credit === 'CREDITED') return { charge_status: 'Credited', charged: false };
  if (credit === 'PENDING') return { charge_status: 'In review', charged: null };
  return lead && lead.leadCharged ? { charge_status: 'Charged', charged: true } : { charge_status: 'Not charged', charged: false };
}

function apiHashOf(row) {
  return `api:${crypto.createHash('sha1').update(JSON.stringify(API_OWNED.map((k) => row[k] ?? null))).digest('hex')}`;
}

/**
 * One search result ({ localServicesLead, customer }) → an lsa_leads row, or null when
 * it has no lead id or no account. `managerId` = the manager it was read through.
 */
function apiLeadRow(result, { managerId } = {}) {
  const lead = (result && result.localServicesLead) || {};
  const customer = (result && result.customer) || {};
  const id = digits(lead.id);
  const fromName = /^customers\/(\d+)\//.exec(String(lead.resourceName || ''));
  const account = digits(customer.id) || (fromName && fromName[1]) || '';
  if (!id || !account) return null;
  const contact = lead.contactDetails || {};
  const campaign = /\/campaigns\/(\d+)/.exec(String(lead.campaign || ''));
  const row = {
    google_lead_id: id,
    account_id: account,
    business_name: text(customer.descriptiveName),
    lead_created_local: cutSeconds(lead.creationDateTime),
    time_known: true,
    source_format: 'api',
    lead_type: text(lead.leadType),
    lead_category: text(String(lead.categoryId ?? '').replace(/^xcat:(service_area_business_)?/, '')),
    job_type: text(lead.serviceId),
    customer_phone: text(contact.phoneNumber),
    customer_name: text(contact.consumerName),
    customer_email: text(contact.email),
    campaign_id: campaign ? campaign[1] : null,
    ...apiCharge(lead),
  };
  row.row_hash = apiHashOf(row);
  row.raw = { source: 'google-ads-api', lead, customer: { id: account, descriptiveName: customer.descriptiveName ?? null } };
  row.manager_ids = managerId ? [String(managerId)] : [];
  return row;
}

/**
 * One campaign search result ({ campaign, segments, metrics, customer }) → an
 * lsa_campaign_daily row, or null without a campaign id, a day or an account. Google
 * sends 64-bit numbers as strings and leaves a zero metric out; the two impression
 * shares stay fractions (0..1), null when Google gave none.
 */
function apiCostRow(result, accountId) {
  const campaign = (result && result.campaign) || {};
  const metrics = (result && result.metrics) || {};
  const customer = (result && result.customer) || {};
  const fromName = /^customers\/(\d+)\//.exec(String(campaign.resourceName || ''));
  const account = digits(accountId) || digits(customer.id) || (fromName && fromName[1]) || '';
  const id = digits(campaign.id);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String((result && result.segments && result.segments.date) || '')) ? result.segments.date : null;
  if (!id || !day || !account) return null;
  const whole = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : 0; };
  const number = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const share = (v) => { const n = Number(v); return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n; };
  return {
    account_id: account,
    campaign_id: id,
    day,
    campaign_name: text(campaign.name),
    channel_type: text(campaign.advertisingChannelType),
    campaign_status: text(campaign.status),
    cost_micros: whole(metrics.costMicros),
    impressions: whole(metrics.impressions),
    clicks: whole(metrics.clicks),
    conversions: number(metrics.conversions),
    top_impression_pct: share(metrics.topImpressionPercentage),
    abs_top_impression_pct: share(metrics.absoluteTopImpressionPercentage),
    currency_code: text(customer.currencyCode),
  };
}

/**
 * Which client accounts the cost pass asks about, in order. Pure.
 *   clients     [{ id, status, managers }]
 *   leadCounts  Map(customer id → leads in its last window), or null when nothing is known
 *               (no lsa_api_accounts and no lead pass in this run): then every account
 *   recent      Set of account ids with lsa_campaign_daily rows in the last 60 days
 *   lastCostAt  Map(customer id → ISO time of its last cost refresh)
 *   only        Set of customer / manager ids; an account named itself is always taken
 * Enabled accounts with leads or recent spend, the one refreshed longest ago first (never
 * refreshed before all), so a pass cut short by the budget picks up the rest next time.
 */
function chooseCostAccounts({ clients, leadCounts = null, recent = new Set(), lastCostAt = new Map(), only = null }) {
  let pool = (clients || []).filter((c) => c.status === 'ENABLED');
  if (only && only.size) pool = pool.filter((c) => only.has(c.id) || (c.managers || []).some((m) => only.has(m)));
  const wanted = (c) => !leadCounts || Number(leadCounts.get(c.id)) > 0 || recent.has(c.id) || !!(only && only.has(c.id));
  const at = (c) => { const t = Date.parse(lastCostAt.get(c.id) || ''); return Number.isFinite(t) ? t : 0; };
  return pool.filter(wanted).sort((a, b) => at(a) - at(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Compare API rows (from apiLeadRow) with what is stored. Pure.
 *   existing    Map(google_lead_id → stored row: API_OWNED, row_hash, manager_ids, changed_at)
 *   managerIds  the manager(s) the account was read under
 * A new lead is written whole. A stored lead (from either CSV report or an earlier sync)
 * gets only the API-owned fields that differ, and a null from the API never replaces a
 * stored value: `updates` = [{ google_lead_id, patch, old, changed }], where `changed`
 * is false when only the manager list or the hash moved.
 */
function diffApiLeads(rows, existing, managerIds, nowIso) {
  const inserts = []; const updates = []; const changes = [];
  const counts = { new: 0, changed: 0, same: 0, moved: 0 };
  const fields = {};
  for (const row of rows) {
    const old = existing.get(row.google_lead_id);
    const managers = new Set([...(old ? old.manager_ids || [] : []), ...(managerIds || []).filter(Boolean).map(String)]);
    const manager_ids = [...managers].sort();
    if (!old) {
      counts.new++;
      inserts.push({ ...row, manager_ids, changed_at: null });
      continue;
    }
    const patch = {};
    for (const f of API_OWNED) {
      const next = row[f];
      if (next === null || next === undefined) continue;
      if (show(old[f]) === show(next)) continue;
      patch[f] = next;
      fields[f] = (fields[f] || 0) + 1;
      if (API_LOGGED.includes(f) && old[f] !== null && old[f] !== undefined) {
        changes.push({ google_lead_id: row.google_lead_id, field: f, old_value: show(old[f]), new_value: show(next) });
      }
    }
    const changed = Object.keys(patch).length > 0;
    if (changed) {
      counts.changed++;
      if (patch.account_id && isPseudoAccount(old.account_id)) counts.moved++;
      if (isApiHash(old.row_hash)) patch.raw = row.raw; // our own payload: keep it current. A CSV row keeps its CSV record.
    } else counts.same++;
    if (old.row_hash !== row.row_hash) patch.row_hash = row.row_hash;
    if (manager_ids.join() !== [...(old.manager_ids || [])].sort().join()) patch.manager_ids = manager_ids;
    if (Object.keys(patch).length) updates.push({ google_lead_id: row.google_lead_id, patch, old, changed, changed_at: changed ? nowIso : old.changed_at ?? null });
  }
  return { inserts, updates, changes, counts, fields };
}

/**
 * An update from diffApiLeads → the row to upsert. PostgREST checks NOT NULL before it
 * sees the conflict, so the row carries every required column: the API-owned fields
 * (new value, else the stored one) and the stored raw. Columns not listed are untouched.
 */
function mergedRow(update, storedRaw) {
  const { old, patch } = update;
  const row = { google_lead_id: update.google_lead_id };
  for (const f of API_OWNED) row[f] = patch[f] !== undefined ? patch[f] : old[f] ?? null;
  row.row_hash = patch.row_hash || old.row_hash;
  row.raw = patch.raw || storedRaw || { source: 'google-ads-api' };
  row.manager_ids = patch.manager_ids || old.manager_ids || [];
  row.changed_at = update.changed_at;
  return row;
}

/**
 * Conversation search results → Map(lead id → { list, seconds }). Pure.
 * list    = [{ at, channel, from, seconds?, has_recording?, text? }], oldest first. Recording
 *           links are signed and short-lived, so only the fact that one exists is kept.
 * seconds = the longest consumer phone call, rounded, or null.
 */
function summarizeConversations(results) {
  const byLead = new Map();
  for (const r of results || []) {
    const c = r && r.localServicesLeadConversation;
    const m = c && /\/localServicesLeads\/(\d+)/.exec(String(c.lead || ''));
    if (!m) continue;
    if (!byLead.has(m[1])) byLead.set(m[1], { list: [], seconds: null });
    const g = byLead.get(m[1]);
    const item = { at: cutSeconds(c.eventDateTime), channel: c.conversationChannel || null, from: c.participantType || null };
    const call = c.phoneCallDetails || {};
    const ms = Number(call.callDurationMillis);
    if (call.callDurationMillis !== undefined && Number.isFinite(ms)) {
      item.seconds = Math.round(ms / 1000);
      if (c.conversationChannel === 'PHONE_CALL' && c.participantType === 'CONSUMER') g.seconds = Math.max(g.seconds ?? 0, item.seconds);
    }
    if (call.callRecordingUrl) item.has_recording = true;
    const body = c.messageDetails && c.messageDetails.text;
    if (body) item.text = String(body).slice(0, 500);
    g.list.push(item);
  }
  for (const g of byLead.values()) g.list.sort((a, b) => (String(a.at) < String(b.at) ? -1 : String(a.at) > String(b.at) ? 1 : 0));
  return byLead;
}

/**
 * Which client accounts this run asks Google about. Pure.
 *   clients  [{ id, status, managers: [ids] }]
 *   memory   Map(customer_id → lsa_api_accounts row), or null when the table is not there
 *   budget   how many Google requests the run may still spend on leads + conversations
 * Enabled accounts only. With memory: every account that had leads last time (each costs
 * a lead and a conversation request), then accounts never looked at, then accounts with
 * no leads whose last look is older than `staleDays` (at most `emptyPerRun`, oldest
 * first), so the hundreds of empty accounts cost a few requests a day, not hundreds.
 * `full`, `only` and a missing memory table take every (matching) account, least
 * recently looked at first, so a backfill cut short by the budget continues next time.
 */
function chooseAccounts({ clients, memory = null, nowMs = Date.now(), full = false, only = null, emptyPerRun = 150, staleDays = 7, budget = Infinity, conversations = true }) {
  let pool = (clients || []).filter((c) => c.status === 'ENABLED');
  const enabled = pool.length;
  if (only && only.size) pool = pool.filter((c) => only.has(c.id) || (c.managers || []).some((m) => only.has(m)));
  const mem = (c) => (memory && memory.get(c.id)) || null;
  const checked = (c) => { const m = mem(c); const t = m && m.last_checked_at ? Date.parse(m.last_checked_at) : NaN; return Number.isFinite(t) ? t : 0; };
  const oldestFirst = (a, b) => checked(a) - checked(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const room = Math.max(0, Math.floor(budget));
  const tag = (list, reason) => list.map((client) => ({ client, reason }));

  if (full || (only && only.size) || !memory) {
    const all = [...pool].sort(oldestFirst);
    const take = all.slice(0, room);
    return { queue: tag(take, full ? 'full' : only && only.size ? 'only' : 'all'), counts: { enabled, matched: pool.length, active: 0, fresh: 0, stale: 0, deferred: all.length - take.length } };
  }

  const active = []; const fresh = []; const stale = []; let waiting = 0;
  for (const c of pool) {
    const m = mem(c);
    if (!m || !m.last_checked_at) fresh.push(c);
    else if (Number(m.lead_count) > 0) active.push(c);
    else if (nowMs - checked(c) >= staleDays * 86400000) stale.push(c);
    else waiting++;
  }
  [active, fresh, stale].forEach((l) => l.sort(oldestFirst));
  const perActive = conversations ? 2 : 1;
  const takeActive = active.slice(0, Math.floor(room / perActive));
  // Some of the others will turn out to have leads and want a conversation request too.
  let left = Math.floor((room - takeActive.length * perActive) * (conversations ? 0.85 : 1));
  const takeFresh = fresh.slice(0, Math.max(0, left));
  left -= takeFresh.length;
  const takeStale = stale.slice(0, Math.max(0, Math.min(emptyPerRun, left)));
  return {
    queue: [...tag(takeActive, 'active'), ...tag(takeFresh, 'fresh'), ...tag(takeStale, 'stale')],
    counts: {
      enabled, matched: pool.length, active: takeActive.length, fresh: takeFresh.length, stale: takeStale.length,
      deferred: (active.length - takeActive.length) + (fresh.length - takeFresh.length) + (stale.length - takeStale.length), waiting,
    },
  };
}

/** Wall clock in America/Denver as plain numbers (never a Date: see dailyDue). */
function denverClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t) => parseInt((parts.find((p) => p.type === t) || {}).value, 10);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), min: get('minute') };
}

/** Is the daily run due? From 05:30 Denver, once per calendar day. `clock` = denverClock(). */
function dailyDue(clock, lastDay) {
  const { y, m, d, h, min } = clock || {};
  if (![y, m, d, h, min].every(Number.isFinite)) return { due: false, dayKey: lastDay || null };
  const dayKey = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { due: dayKey !== lastDay && (h > 5 || (h === 5 && min >= 30)), dayKey };
}

class AdsError extends Error {
  constructor(message, { status = 0, code = null } = {}) { super(message); this.status = status; this.code = code; }
}
class BudgetStop extends Error {}

/** Google's error body → AdsError carrying the HTTP status and the first Ads error code. */
function adsError(status, body) {
  const e = (body && body.error) || {};
  let code = e.status || null; let detail = '';
  for (const d of e.details || []) {
    if (d && d.reason && !detail) { code = d.reason; }
    for (const x of (d && d.errors) || []) {
      const first = x.errorCode && Object.values(x.errorCode)[0];
      if (first && !detail) { code = first; detail = x.message || ''; }
    }
  }
  return new AdsError(`${status} ${code || ''} ${detail || e.message || ''}`.replace(/\s+/g, ' ').trim().slice(0, 300), { status, code });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function inPool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const item = items[i++]; await fn(item); }
  }));
}

/**
 * The sync, bound to a store and a service account.
 *   db        restDb-shaped store (select / upsert / update / insert)
 *   saJson    the service account JSON text (GOOGLE_ADS_SA_JSON)
 *   fetchImpl fetch (tests pass a mock)
 */
function createLsaApiSync({
  db, saJson, fetchImpl = (...a) => fetch(...a), now = () => new Date(), log = console,
  apiVersion = (process.env.GOOGLE_ADS_API_VERSION || 'v26').trim() || 'v26',
  maxOps = Number(process.env.LSA_API_MAX_OPS) || 1200,
  maxOpsPerDay = Number(process.env.LSA_API_MAX_OPS_24H) || 2400,
  emptyPerRun = Number(process.env.LSA_API_EMPTY_PER_RUN) || 150,
  concurrency = 4, backoffMs = 4000,
} = {}) {
  const API = `https://googleads.googleapis.com/${apiVersion}`;
  let account = null;
  try { account = saJson ? JSON.parse(saJson) : null; } catch { account = null; }
  const configured = !!(account && account.client_email && account.private_key);

  // Every Google Ads request of the last 24 hours, by time. In memory only: a restart
  // forgets it, so right after a deploy the 24-hour cap is not enforced across runs (the
  // per-run cap still is, and the daily schedule checks lsa_imports before it starts).
  let stamps = [];
  const ops24h = () => { const cut = now().getTime() - 86400000; stamps = stamps.filter((t) => t > cut); return stamps.length; };

  let token = null; // { value, until }
  async function accessToken() {
    if (token && token.until > now().getTime()) return token.value;
    const iat = Math.floor(now().getTime() / 1000);
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: account.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 })}`;
    const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(account.private_key).toString('base64url');
    const r = await fetchImpl(TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new AdsError(`token ${r.status} ${j.error || ''}`.trim(), { status: r.status, code: 'TOKEN' });
    // Refresh five minutes before Google's own expiry.
    token = { value: j.access_token, until: now().getTime() + (Math.max(600, Number(j.expires_in) || 3600) - 300) * 1000 };
    return token.value;
  }

  /** One Google Ads request. Counted; retried once on 429 / 5xx / a dropped connection. */
  async function ads(run, path, { login, body } = {}) {
    for (let attempt = 0; ; attempt++) {
      const tok = await accessToken();
      if (run.ops >= run.cap) throw new BudgetStop('budget');
      run.ops++; stamps.push(now().getTime());
      let r;
      try {
        r = await fetchImpl(`${API}${path}`, {
          method: body ? 'POST' : 'GET',
          headers: { Authorization: `Bearer ${tok}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(login ? { 'login-customer-id': login } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(90000),
        });
      } catch (err) {
        if (attempt === 0) { await sleep(backoffMs); continue; }
        throw new AdsError(`network: ${String(err && err.message).slice(0, 120)}`, { code: 'NETWORK' });
      }
      if (r.ok) return r.json();
      const err = adsError(r.status, await r.json().catch(() => ({})));
      if (r.status === 401) token = null;
      if (attempt === 0 && (r.status === 429 || r.status >= 500 || r.status === 401)) { await sleep(backoffMs); continue; }
      if (r.status === 429) run.cap = run.ops; // Google's own quota is spent: stop asking.
      throw err;
    }
  }

  async function search(run, customerId, login, query) {
    const out = []; let pageToken;
    for (let page = 0; page < 50; page++) {
      const j = await ads(run, `/customers/${customerId}/googleAds:search`, { login, body: pageToken ? { query, pageToken } : { query } });
      for (const r of j.results || []) out.push(r);
      pageToken = j.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }

  // Whether supabase_lsa_api_sync.sql has been run. A yes is remembered; a no is asked again next run.
  const has = { memory: false, conversations: false, cost: false, costAt: false };
  let costWarned = false; // the missing cost table is reported once, not on every run
  async function probe({ cost = false } = {}) {
    if (!has.memory) {
      try { await db.select('lsa_api_accounts', 'select=customer_id&limit=1'); has.memory = true; } catch { log.warn('[lsa-api] lsa_api_accounts is missing (run supabase_lsa_api_sync.sql): every enabled account is queried each run'); }
    }
    if (!has.conversations) {
      try { await db.select('lsa_leads', 'select=conversations&limit=1'); has.conversations = true; } catch { log.warn('[lsa-api] lsa_leads.conversations is missing (run supabase_lsa_api_sync.sql): conversations are skipped'); }
    }
    if (!cost) return;
    if (!has.cost) {
      try { await db.select('lsa_campaign_daily', 'select=account_id&limit=1'); has.cost = true; } catch {
        if (!costWarned) log.warn('[lsa-api] lsa_campaign_daily is missing (run supabase_lsa_api_cost.sql): campaign cost is skipped');
        costWarned = true;
      }
    }
    if (has.cost && has.memory && !has.costAt) {
      try { await db.select('lsa_api_accounts', 'select=last_cost_at&limit=1'); has.costAt = true; } catch { /* cost still loads; the order of accounts is just not remembered */ }
    }
  }

  async function loadMemory() {
    const map = new Map();
    for (let offset = 0; ; offset += 1000) { // PostgREST caps a reply at 1000 rows
      const rows = await db.select('lsa_api_accounts', `select=customer_id,manager_id,lead_count,last_lead_local,last_checked_at,last_error${has.costAt ? ',last_cost_at' : ''}&order=customer_id&limit=1000&offset=${offset}`);
      for (const r of rows) map.set(r.customer_id, r);
      if (rows.length < 1000) break;
    }
    return map;
  }

  /** Managers → their client accounts, a client under two managers once with both remembered. */
  async function discover(run, only) {
    const listed = await ads(run, '/customers:listAccessibleCustomers');
    let managers = (listed.resourceNames || []).map((n) => digits(String(n).split('/')[1])).filter(Boolean);
    run.summary.managers = managers.length;
    // `only` naming nothing but managers we are on: no need to walk the others.
    if (only && only.size && [...only].every((id) => managers.includes(id))) managers = managers.filter((m) => only.has(m));
    const clients = new Map();
    const add = (c, manager) => {
      const id = digits(c.id);
      if (!id) return;
      if (!clients.has(id)) clients.set(id, { id, name: c.descriptiveName || null, timeZone: c.timeZone || null, status: c.status || null, managers: [] });
      const known = clients.get(id);
      if (!known.managers.includes(manager)) known.managers.push(manager);
      if (c.status === 'ENABLED') known.status = 'ENABLED';
    };
    await inPool(managers, concurrency, async (m) => {
      try {
        const rows = (await search(run, m, m, CLIENT_QUERY)).map((r) => r.customerClient).filter(Boolean);
        // Level 0 is the account itself: a manager is skipped here, a plain account the
        // service account is on directly is its own client.
        for (const c of rows) if (!c.manager) add(c, m);
      } catch (err) {
        if (err instanceof BudgetStop) return;
        run.fail(`manager ${m}`, err);
      }
    });
    return [...clients.values()];
  }

  async function readExisting(ids, fields) {
    const map = new Map();
    for (const part of chunk(ids, 150)) {
      const rows = await db.select('lsa_leads', `select=${fields}&google_lead_id=in.(${part.join(',')})`);
      for (const r of rows) map.set(r.google_lead_id, r);
    }
    return map;
  }

  /** Diff one account's leads against the store and (unless dry) write them. */
  async function applyLeads(run, rows, managerIds) {
    const s = run.summary;
    const byId = new Map(rows.map((r) => [r.google_lead_id, r]));
    const leads = [...byId.values()];
    const existing = await readExisting(leads.map((l) => l.google_lead_id), ['google_lead_id', 'row_hash', 'manager_ids', 'changed_at', ...API_OWNED].join(','));
    const { inserts, updates, changes, counts, fields } = diffApiLeads(leads, existing, managerIds, run.nowIso);
    s.leads_seen += leads.length; s.leads_new += counts.new; s.leads_changed += counts.changed; s.leads_same += counts.same;
    s.moved_from_placeholder += counts.moved;
    for (const [f, n] of Object.entries(fields)) s.changed_fields[f] = (s.changed_fields[f] || 0) + n;
    // Where the changed rows came from and what moved, for reading a run (and a dry run) at a glance.
    for (const u of updates) {
      if (!u.changed) continue;
      const from = u.old.source_format || 'detailed';
      const tally = s.changed_by_source[from] || (s.changed_by_source[from] = { leads: 0 });
      tally.leads++;
      for (const f of API_OWNED) if (f in u.patch) tally[f] = (tally[f] || 0) + 1;
      if ('charge_status' in u.patch || 'charged' in u.patch) {
        const was = `${u.old.charge_status ?? 'none'}/${u.old.charged ?? 'null'}`;
        const next = byId.get(u.google_lead_id);
        const key = `${from}: ${was} -> ${next.charge_status}/${next.charged ?? 'null'}`;
        s.charge_changes[key] = (s.charge_changes[key] || 0) + 1;
      }
    }
    if (run.dryRun) return;
    // A CSV-sourced row keeps the CSV record in raw, so read it back to send it along.
    const needRaw = updates.filter((u) => !u.patch.raw).map((u) => u.google_lead_id);
    const raws = await readExisting(needRaw, 'google_lead_id,raw');
    const writes = [...inserts, ...updates.map((u) => mergedRow(u, (raws.get(u.google_lead_id) || {}).raw))];
    const campaigns = new Map();
    for (const l of leads) if (l.campaign_id) campaigns.set(l.campaign_id, { campaign_id: l.campaign_id, account_id: l.account_id, manager_id: (managerIds && managerIds[0]) || null, updated_at: run.nowIso });
    // campaign_name is not sent: a name the pay-per-lead file stored stays.
    for (const part of chunk([...campaigns.values()], 500)) await db.upsert('lsa_campaigns', part, 'campaign_id');
    for (const part of chunk(writes, 250)) await db.upsert('lsa_leads', part, 'google_lead_id');
    for (const part of chunk(changes.map((c) => ({ ...c, import_id: run.importId })), 500)) await db.insert('lsa_lead_changes', part);
  }

  /** Store one account's conversation summaries, and the call length where the lead has none. */
  async function applyConversations(run, byLead) {
    const s = run.summary;
    const ids = [...byLead.keys()];
    const stored = await readExisting(ids, 'google_lead_id,account_id,row_hash,charged_call_seconds,conversations');
    const todo = [];
    for (const [id, g] of byLead) {
      const old = stored.get(id);
      if (!old) { s.conversation_leads_unknown++; continue; } // older than the lead window and never imported
      const seconds = old.charged_call_seconds === null || old.charged_call_seconds === undefined ? g.seconds : old.charged_call_seconds;
      const filled = seconds !== (old.charged_call_seconds ?? null);
      if (!filled && canon(old.conversations) === canon(g.list)) continue;
      s.conversation_leads_updated++;
      if (filled) s.call_seconds_filled++;
      todo.push({ google_lead_id: id, account_id: old.account_id, row_hash: old.row_hash, charged_call_seconds: seconds ?? null, conversations: g.list });
    }
    if (run.dryRun || !todo.length) return;
    // Same upsert trick as mergedRow: the required columns go back as they are.
    const raws = await readExisting(todo.map((t) => t.google_lead_id), 'google_lead_id,raw');
    const rows = todo.filter((t) => raws.has(t.google_lead_id)).map((t) => ({ ...t, raw: raws.get(t.google_lead_id).raw }));
    for (const part of chunk(rows, 250)) await db.upsert('lsa_leads', part, 'google_lead_id');
  }

  /** Account ids that have a campaign day on or after `since` (YYYY-MM-DD). */
  async function recentCostAccounts(since) {
    const ids = new Set();
    for (let offset = 0; offset < 200000; offset += 1000) { // PostgREST caps a reply at 1000 rows
      const rows = await db.select('lsa_campaign_daily', `select=account_id&day=gte.${since}&order=account_id,campaign_id,day&limit=1000&offset=${offset}`);
      for (const r of rows) ids.add(r.account_id);
      if (rows.length < 1000) break;
    }
    return ids;
  }

  /**
   * Step 5: what each campaign cost per day over the last `costDays`, one request per
   * account, upserted on (account, campaign, day) so a later run overwrites Google's
   * adjustments. A failing account is recorded and the pass goes on.
   */
  async function costPass(run, { clients, memory, memoryRows, only, costDays, leadsRan }) {
    const s = run.summary;
    const nowMs = now().getTime();
    const day = (ms) => new Date(ms).toISOString().slice(0, 10);
    const from = day(nowMs - costDays * 86400000); const to = day(nowMs);
    s.cost_from = from; s.cost_to = to;
    const query = `${COST_QUERY} WHERE segments.date BETWEEN '${from}' AND '${to}'`;

    let leadCounts = null;
    const lastCostAt = new Map();
    if (memory || leadsRan) {
      leadCounts = new Map();
      for (const [id, m] of memory || []) { leadCounts.set(id, Number(m.lead_count) || 0); if (m.last_cost_at) lastCostAt.set(id, m.last_cost_at); }
      for (const [id, m] of memoryRows) leadCounts.set(id, Number(m.lead_count) || 0);
    }
    const recent = await recentCostAccounts(day(nowMs - COST_RECENT_DAYS * 86400000));
    const queue = chooseCostAccounts({ clients, leadCounts, recent, lastCostAt, only });
    s.cost_candidates = queue.length;

    const done = []; const campaigns = new Map();
    let failed = 0; let stopped = false;
    let turn = Promise.resolve(); // store writes one account at a time
    const inTurn = (fn) => { const p = turn.then(fn, fn); turn = p.catch(() => {}); return p; };

    await inPool(queue, concurrency, async (client) => {
      if (stopped) return;
      if (run.ops >= run.cap) { s.cost_skipped_budget++; return; }
      // The manager the lead pass got in with first, then the others.
      const known = (memoryRows.get(client.id) || (memory && memory.get(client.id)) || {}).manager_id;
      const logins = [...new Set([known, ...client.managers].filter((m) => m && client.managers.includes(m)))];
      let results = null; let login = null; let failure = null;
      for (const manager of logins) {
        try { results = await search(run, client.id, manager, query); login = manager; break; } catch (err) {
          if (err instanceof BudgetStop) { s.cost_skipped_budget++; return; }
          failure = err;
          if (!(err.status === 403 || err.status === 401)) break; // only a permission problem is worth another manager
        }
      }
      if (!results) {
        run.fail(`account ${client.id} cost`, failure);
        // Five accounts failed and none was read: it is the query or the access, not the accounts.
        if (++failed >= 5 && !done.length && !stopped) {
          stopped = true;
          s.cost_error = `stopped after ${failed} failed accounts and none read: ${String((failure && failure.message) || 'failed').slice(0, 200)}`;
        }
        return;
      }
      const rows = new Map();
      for (const r of results) {
        const row = apiCostRow(r, client.id);
        if (row) rows.set(`${row.campaign_id} ${row.day}`, { ...row, updated_at: run.nowIso });
      }
      try {
        if (!run.dryRun && rows.size) {
          await inTurn(async () => { for (const part of chunk([...rows.values()], 500)) await db.upsert('lsa_campaign_daily', part, 'account_id,campaign_id,day'); });
        }
      } catch (err) {
        run.fail(`account ${client.id} cost store`, err);
        return; // not stored: not counted, and asked first next time
      }
      done.push(client.id);
      s.cost_accounts++;
      if (rows.size) s.cost_accounts_with_rows++;
      for (const row of rows.values()) {
        s.cost_rows++;
        s.cost_total_micros += row.cost_micros;
        const key = row.channel_type || 'UNKNOWN';
        const tally = s.cost_by_channel[key] || (s.cost_by_channel[key] = { rows: 0, cost_micros: 0 });
        tally.rows++; tally.cost_micros += row.cost_micros;
        if (row.campaign_name) {
          campaigns.set(row.campaign_id, { campaign_id: row.campaign_id, campaign_name: row.campaign_name, account_id: row.account_id, manager_id: login, updated_at: run.nowIso, channel: row.channel_type });
        }
      }
    });
    await turn;
    if (run.dryRun) return;

    // Real names for the campaigns: every one already in lsa_campaigns, and new rows for the lead channels.
    try {
      const all = [...campaigns.values()];
      const there = new Set();
      for (const part of chunk(all.map((c) => c.campaign_id), 150)) {
        for (const r of await db.select('lsa_campaigns', `select=campaign_id&campaign_id=in.(${part.join(',')})`)) there.add(r.campaign_id);
      }
      const named = all.filter((c) => there.has(c.campaign_id) || LEAD_CHANNELS.includes(c.channel)).map(({ channel, ...row }) => row);
      for (const part of chunk(named, 500)) await db.upsert('lsa_campaigns', part, 'campaign_id');
      s.cost_campaigns_named = named.length;
    } catch (err) { run.fail('campaign names', err); }

    if (has.costAt && done.length) {
      try {
        for (const part of chunk(done.map((id) => ({ customer_id: id, last_cost_at: run.nowIso })), 500)) await db.upsert('lsa_api_accounts', part, 'customer_id');
      } catch (err) { run.fail('cost memory', err); }
    }
  }

  let running = null; // the run in progress
  let last = null;    // summary of the last finished run
  let seq = 0;

  async function execute(run, { sinceDays, full, only, label, costDays, costOnly }) {
    const s = run.summary;
    await probe({ cost: costDays > 0 });
    s.sql_applied = { accounts: has.memory, conversations: has.conversations, cost: has.cost };
    const clients = await discover(run, only);
    s.clients = clients.length;
    const memory = has.memory ? await loadMemory() : null;
    const memoryRows = new Map(); // what the lead pass learned about each account it asked
    if (!costOnly) await leadPasses(run, { clients, memory, memoryRows, sinceDays, full, only, label });
    if (!(costDays > 0) || !has.cost) return;
    // Cost is an extra: whatever goes wrong here, the leads above are already stored.
    try { await costPass(run, { clients, memory, memoryRows, only, costDays, leadsRan: !costOnly }); } catch (err) {
      s.cost_error = String((err && err.message) || err).slice(0, 300);
      run.fail('cost pass', err);
    }
  }

  /** Steps 3 and 4: leads, then conversations, then the account memory. */
  async function leadPasses(run, { clients, memory, memoryRows, sinceDays, full, only, label }) {
    const s = run.summary;
    const nowMs = now().getTime();
    const { queue, counts } = chooseAccounts({
      clients, memory, nowMs, full, only, emptyPerRun, budget: run.cap - run.ops - 5, conversations: has.conversations,
    });
    s.selection = counts;
    const day = (ms) => new Date(ms).toISOString().slice(0, 10);
    const windowFor = (client) => {
      if (full) return null;
      // An account not looked at for longer than the window gets the gap as well.
      const m = memory && memory.get(client.id);
      const gap = m && m.last_checked_at ? Math.ceil((nowMs - Date.parse(m.last_checked_at)) / 86400000) + 1 : 0;
      return Math.min(400, Math.max(sinceDays, Number.isFinite(gap) ? gap : 0));
    };

    if (!run.dryRun) {
      const [imp] = await db.insert('lsa_imports', [{
        manager_id: null, range_from: full ? null : day(nowMs - sinceDays * 86400000), range_to: day(nowMs),
        filename: label, sha256: null, source: 'api',
      }]);
      run.importId = (imp && imp.id) || null;
    }

    const withLeads = [];
    let turn = Promise.resolve(); // store writes one account at a time
    const inTurn = (fn) => { const p = turn.then(fn, fn); turn = p.catch(() => {}); return p; };

    await inPool(queue, concurrency, async ({ client }) => {
      if (run.ops >= run.cap) { s.skipped_budget++; return; }
      const days = windowFor(client);
      const since = days === null ? null : `${day(nowMs - days * 86400000)} 00:00:00`;
      const query = since ? `${LEAD_QUERY} WHERE local_services_lead.creation_date_time >= '${since}'` : LEAD_QUERY;
      const old = (memory && memory.get(client.id)) || {};
      const note = {
        customer_id: client.id, manager_id: client.managers[0] || null, name: client.name, time_zone: client.timeZone, status: client.status,
        lead_count: Number(old.lead_count) || 0, last_lead_local: old.last_lead_local ?? null, last_checked_at: old.last_checked_at ?? null, last_error: null,
      };
      let results = null; let login = null; let failure = null;
      for (const manager of client.managers) {
        try { results = await search(run, client.id, manager, query); login = manager; break; } catch (err) {
          if (err instanceof BudgetStop) { s.skipped_budget++; return; }
          failure = err;
          if (!(err.status === 403 || err.status === 401)) break; // only a permission problem is worth another manager
        }
      }
      if (!results) {
        run.fail(`account ${client.id}`, failure);
        note.last_error = String((failure && failure.message) || 'failed').slice(0, 300);
        // An account with no known leads goes to the back of the weekly queue; one with leads is asked again next run.
        if (!(note.lead_count > 0)) note.last_checked_at = run.nowIso;
        memoryRows.set(client.id, note);
        return;
      }
      s.clients_queried++;
      const rows = results.map((r) => apiLeadRow(r, { managerId: login })).filter(Boolean);
      note.manager_id = login;
      note.lead_count = rows.length;
      note.last_checked_at = run.nowIso;
      for (const r of rows) if (r.lead_created_local && (!note.last_lead_local || show(note.last_lead_local) < r.lead_created_local)) note.last_lead_local = r.lead_created_local;
      if (rows.length) {
        s.clients_with_leads++;
        withLeads.push({ client, login, since });
        try { await inTurn(() => applyLeads(run, rows, client.managers)); } catch (err) {
          run.fail(`account ${client.id} store`, err);
          note.last_error = String(err.message).slice(0, 300);
          note.last_checked_at = old.last_checked_at ?? null; // not stored: ask for the same window again
        }
      }
      memoryRows.set(client.id, note);
    });
    await turn;

    if (has.conversations) {
      await inPool(withLeads, concurrency, async ({ client, login, since }) => {
        if (run.ops >= run.cap) { s.conversations_skipped_budget++; return; }
        const query = since ? `${CONVERSATION_QUERY} WHERE local_services_lead_conversation.event_date_time >= '${since}'` : CONVERSATION_QUERY;
        try {
          const results = await search(run, client.id, login, query);
          s.conversations_seen += results.length;
          const byLead = summarizeConversations(results);
          if (byLead.size) await inTurn(() => applyConversations(run, byLead));
        } catch (err) {
          if (err instanceof BudgetStop) { s.conversations_skipped_budget++; return; }
          run.fail(`account ${client.id} conversations`, err);
        }
      });
      await turn;
    }

    if (!run.dryRun && has.memory) {
      for (const part of chunk([...memoryRows.values()], 500)) await db.upsert('lsa_api_accounts', part, 'customer_id');
    }
  }

  /**
   * Run one sync. Never throws: the summary carries `error` when the run could not finish.
   *   sinceDays  leads created in the last N days (default 14)
   *   full       every enabled account, no date filter (history backfill)
   *   only       comma-separated customer or manager ids
   *   dryRun     read Google and the store, diff, write nothing
   *   costDays   campaign cost per day for the last N days (default 14, 0 = no cost pass, at most 400)
   *   costOnly   skip the leads and conversations (cost history backfill)
   */
  async function syncLeads({ sinceDays = 14, full = false, only = null, dryRun = false, label = null, costDays = 14, costOnly = false } = {}) {
    if (!configured) return { error: 'GOOGLE_ADS_SA_JSON is not set or not a service account key' };
    if (running) return { error: 'a sync is already running', run_id: running.summary.run_id };
    const days = Math.min(400, Math.max(1, Math.floor(Number(sinceDays)) || 14));
    const costN = Number(costDays);
    const cost = Number.isFinite(costN) ? Math.min(400, Math.max(0, Math.floor(costN))) : 14;
    if (costOnly && cost === 0) return { error: 'cost_only with cost_days=0: nothing to do' };
    const onlySet = new Set(String(only || '').split(',').map(digits).filter(Boolean));
    const started = now();
    const summary = {
      run_id: `${started.getTime().toString(36)}-${++seq}`, started: started.toISOString(), finished: null,
      dry_run: !!dryRun, full: !!full, since_days: full ? null : days, only: onlySet.size ? [...onlySet] : null,
      ops_used: 0, ops_cap: 0, managers: 0, clients: 0, clients_queried: 0, clients_with_leads: 0, skipped_budget: 0,
      leads_seen: 0, leads_new: 0, leads_changed: 0, leads_same: 0, moved_from_placeholder: 0, changed_fields: {}, changed_by_source: {}, charge_changes: {},
      conversations_seen: 0, conversation_leads_updated: 0, call_seconds_filled: 0, conversation_leads_unknown: 0, conversations_skipped_budget: 0,
      cost_only: !!costOnly, cost_days: cost, cost_from: null, cost_to: null, cost_candidates: 0, cost_accounts: 0, cost_accounts_with_rows: 0,
      cost_rows: 0, cost_total_micros: 0, cost_by_channel: {}, cost_skipped_budget: 0, cost_campaigns_named: 0, cost_error: null,
      error_count: 0, errors: [], error: null,
    };
    const run = {
      summary, dryRun: !!dryRun, ops: 0, nowIso: started.toISOString(), importId: null,
      cap: Math.max(0, Math.min(maxOps, maxOpsPerDay - ops24h())),
      fail(what, err) { summary.error_count++; if (summary.errors.length < 8) summary.errors.push(`${what}: ${String((err && err.message) || err).slice(0, 200)}`); },
    };
    summary.ops_cap = run.cap;
    running = run;
    try {
      if (run.cap < 20) throw new Error(`Google Ads request budget is spent (${ops24h()} in the last 24 hours)`);
      const what = full ? 'full' : `${days}d`;
      await execute(run, {
        sinceDays: days, full: !!full, only: onlySet, costDays: cost, costOnly: !!costOnly,
        label: label || `google-ads-api ${what}${onlySet.size ? ` only=${[...onlySet].join(',')}`.slice(0, 120) : ''}`,
      });
    } catch (err) {
      summary.error = err instanceof BudgetStop ? 'stopped: request budget reached' : String((err && err.message) || err).slice(0, 300);
      log.error('[lsa-api] sync failed:', summary.error);
    } finally {
      summary.ops_used = run.ops;
      summary.finished = now().toISOString();
      if (run.importId) {
        const errorText = [summary.error, ...summary.errors].filter(Boolean).join('; ').slice(0, 500) || null;
        await db.update('lsa_imports', `id=eq.${run.importId}`, {
          row_count: summary.leads_seen, new_count: summary.leads_new, changed_count: summary.leads_changed, same_count: summary.leads_same,
          rejected_count: summary.error_count, error: errorText,
        }).catch((err) => log.error('[lsa-api] could not close the lsa_imports row:', err.message));
      }
      last = summary;
      running = null;
      log.log(`[lsa-api] ${summary.dry_run ? 'dry run' : 'run'} ${summary.run_id}: ${summary.ops_used} requests, ${summary.clients_queried} accounts, ${summary.leads_seen} leads (${summary.leads_new} new, ${summary.leads_changed} changed, ${summary.leads_same} same), cost ${summary.cost_accounts} accounts / ${summary.cost_rows} rows, ${summary.error_count} errors`);
    }
    return summary;
  }

  /** Has the daily run already been logged in the last 20 hours? Survives a restart, unlike the in-memory day. */
  async function ranRecently() {
    const rows = await db.select('lsa_imports', 'select=received_at&source=eq.api&filename=like.*daily*&order=received_at.desc&limit=1');
    const at = rows[0] && Date.parse(rows[0].received_at);
    return Number.isFinite(at) && now().getTime() - at < 20 * 3600000;
  }

  return {
    configured,
    syncLeads,
    ranRecently,
    status: () => ({ configured, running: running ? { ...running.summary, ops_used: running.ops } : null, last, ops_last_24h: ops24h(), ops_cap_per_run: maxOps, ops_cap_24h: maxOpsPerDay }),
  };
}

/**
 * POST /lsa/api-sync?days=14&full=0&only=<ids>&dry=1&cost_days=14&cost_only=0     Authorization: Bearer <LSA_IMPORT_KEY>
 *   Starts a run and replies 202 { run_id } at once. With dry=1 AND only= it runs inline
 *   and replies with the summary (a whole-fleet run would outlast the request).
 *   cost_days = days of campaign cost to (re)load, 0 for none, at most 400; full=1 does not
 *   lengthen it. cost_only=1 skips the leads, for loading cost history.
 * GET /lsa/api-sync/status → the running and the last finished run.
 * Daily at 05:30 America/Denver (14 days of leads and of cost) when GOOGLE_ADS_SA_JSON is set.
 */
function mountLsaApiSync(app, { SUPABASE_URL, SUPABASE_SERVICE_KEY, LSA_IMPORT_KEY, GOOGLE_ADS_SA_JSON, db, fetchImpl, schedule = true }) {
  const store = db || restDb({ SUPABASE_URL, SUPABASE_SERVICE_KEY });
  const sync = createLsaApiSync({ db: store, saJson: GOOGLE_ADS_SA_JSON, ...(fetchImpl ? { fetchImpl } : {}) });
  if (GOOGLE_ADS_SA_JSON && !sync.configured) console.error('[lsa-api] GOOGLE_ADS_SA_JSON is set but is not a service account key (client_email + private_key)');

  const gate = (req, res) => {
    if (!LSA_IMPORT_KEY) { res.status(503).json({ error: 'LSA_IMPORT_KEY is not set' }); return false; }
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (!keyOk(bearer && bearer[1], LSA_IMPORT_KEY)) { res.status(401).json({ error: 'Unauthorized' }); return false; }
    if (!sync.configured) { res.status(503).json({ error: 'GOOGLE_ADS_SA_JSON is not set' }); return false; }
    return true;
  };
  const yes = (v) => ['1', 'true', 'yes'].includes(String(v || '').toLowerCase());

  app.post('/lsa/api-sync', async (req, res) => {
    try {
      if (!gate(req, res)) return;
      const costDays = req.query.cost_days === undefined || req.query.cost_days === '' ? 14 : Number(req.query.cost_days);
      if (!Number.isFinite(costDays) || costDays < 0) return res.status(400).json({ error: 'cost_days must be a number from 0 to 400' });
      const opts = {
        sinceDays: Number(req.query.days) || 14, full: yes(req.query.full), only: String(req.query.only || '') || null, dryRun: yes(req.query.dry),
        costDays, costOnly: yes(req.query.cost_only),
      };
      if (opts.costOnly && Math.floor(costDays) === 0) return res.status(400).json({ error: 'cost_only=1 with cost_days=0: nothing to do' });
      if (sync.status().running) return res.status(409).json({ error: 'a sync is already running', run_id: sync.status().running.run_id });
      if (opts.dryRun && opts.only) return res.json(await sync.syncLeads(opts));
      const started = sync.syncLeads(opts); // sets the running summary before its first await
      started.catch((err) => console.error('[lsa-api] run failed:', err && err.message));
      const current = sync.status().running;
      return res.status(202).json({ status: 'started', run_id: current ? current.run_id : null, dry_run: opts.dryRun });
    } catch (err) {
      console.error('[lsa-api] route failed:', err && err.message);
      if (!res.headersSent) res.status(500).json({ error: 'sync could not start' });
    }
  });

  app.get('/lsa/api-sync/status', (req, res) => {
    try { if (gate(req, res)) res.json(sync.status()); } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: 'status failed' });
    }
  });

  if (schedule && sync.configured && SUPABASE_SERVICE_KEY) {
    let lastDay = null;
    // The clock is plain numbers and every step is inside the try: a thrown tick took the
    // whole server down once (netsuiteSync, 2026-11-08).
    const tick = async () => {
      try {
        const { due, dayKey } = dailyDue(denverClock(), lastDay);
        if (!due) return;
        lastDay = dayKey;
        if (await sync.ranRecently()) return; // a restart forgot today's run; the import log did not
        await sync.syncLeads({ sinceDays: 14, costDays: 14, label: 'google-ads-api 14d (daily)' });
      } catch (err) {
        console.error('[lsa-api] daily tick failed:', err && err.message);
      }
    };
    setTimeout(tick, 6 * 60 * 1000);
    setInterval(tick, 10 * 60 * 1000);
  }
  return sync;
}

module.exports = mountLsaApiSync;
Object.assign(module.exports, {
  API_OWNED, API_LOGGED, LEAD_QUERY, CONVERSATION_QUERY, CLIENT_QUERY, COST_QUERY, LEAD_CHANNELS,
  apiCharge, apiHashOf, apiLeadRow, apiCostRow, chooseCostAccounts, diffApiLeads, mergedRow, summarizeConversations, chooseAccounts,
  denverClock, dailyDue, adsError, canon, createLsaApiSync,
});
