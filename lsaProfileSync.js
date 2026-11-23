'use strict';

// Google Local Services profiles: reviews, rating and the last 30 days per account.
//
// The lead sync (lsaApiSync.js) reads leads and cost through the Google Ads API, which
// knows nothing about a profile's reviews. Google's Local Services API does: its account
// report carries the review count and star rating printed on the ad, the weekly budget,
// and charged leads / cost / calls for a period and for the period before it.
//
// One run:
//   1. customers:listAccessibleCustomers (Google Ads API) → the manager accounts the service account is on
//   2. per manager: accountReports:search (Local Services API) for the last 30 full days
//   3. accounts marked as another company's (lsa_account_overrides.is_excluded) are dropped
//   4. one row per remaining account for today (America/Denver) → lsa_account_reports
//
// Google hands out this report a whole manager at a time, so an account that is not ours
// cannot be left out of the request when it shares a manager with ours: its row is
// thrown away as soon as the reply is read, before anything is counted or stored.
//
// Google keeps no history of the review count, so today's row is the only record of it:
// "reviews gained in 30 days" is the difference between two of our own daily rows. A
// re-run on the same day overwrites that day's row.
//
// The Local Services API must be enabled in the service account's Google Cloud project.
// It has its own quota: none of these requests count against the Google Ads budget the
// lead sync keeps. Schema: supabase_lsa_account_reports.sql; without it the run reads
// Google and stores nothing.
//
// Pure mapping is exported for tests; routes are mounted from server.js.

const crypto = require('crypto');
const { keyOk, restDb, loadExcludedAccounts, dropExcluded } = require('./lsaImport');
const { denverClock } = require('./lsaApiSync');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/adwords';
const REPORTS_URL = 'https://localservices.googleapis.com/v1/accountReports:search';
const PERIOD_DAYS = 30;
const TABLE = 'lsa_account_reports';

const digits = (v) => String(v ?? '').replace(/\D/g, '');
const text = (v) => { const s = String(v ?? '').trim(); return s === '' ? null : s; };
/** A number Google sent as a number or a string; null when absent or unreadable. */
const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const whole = (v) => { const n = num(v); return n === null ? null : Math.round(n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

/** "2026-11-23" shifted by whole days (calendar arithmetic in UTC, so no zone can move it). */
function shiftDay(day, by) {
  const [y, m, d] = String(day).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + by)).toISOString().slice(0, 10);
}

/** The report window for a day: the 30 full days before it. */
function reportWindow(day) {
  return { from: shiftDay(day, -PERIOD_DAYS), to: shiftDay(day, -1) };
}

/** One accountReports row → one lsa_account_reports row; null when it names no account. */
function profileRow(report, { day, managerId = null, nowIso = null } = {}) {
  const accountId = digits(report && report.accountId);
  if (!accountId) return null;
  return {
    account_id: accountId,
    day,
    business_name: text(report.businessName),
    total_reviews: whole(report.totalReview),
    avg_rating: num(report.averageFiveStarRating),
    weekly_budget: num(report.averageWeeklyBudget),
    phone_responsiveness: num(report.phoneLeadResponsiveness),
    period_days: PERIOD_DAYS,
    charged_leads: whole(report.currentPeriodChargedLeads),
    prev_charged_leads: whole(report.previousPeriodChargedLeads),
    cost: num(report.currentPeriodTotalCost),
    prev_cost: num(report.previousPeriodTotalCost),
    phone_calls: whole(report.currentPeriodPhoneCalls),
    prev_phone_calls: whole(report.previousPeriodPhoneCalls),
    connected_calls: whole(report.currentPeriodConnectedPhoneCalls),
    prev_connected_calls: whole(report.previousPeriodConnectedPhoneCalls),
    impressions_2d: whole(report.impressionsLastTwoDays),
    currency_code: text(report.currencyCode),
    manager_ids: managerId ? [String(managerId)] : [],
    updated_at: nowIso,
  };
}

/** An account listed under two managers is stored once, with both managers remembered. */
function mergeProfiles(rows) {
  const byId = new Map();
  for (const row of rows) {
    if (!row) continue;
    const known = byId.get(row.account_id);
    if (!known) { byId.set(row.account_id, { ...row, manager_ids: [...row.manager_ids] }); continue; }
    for (const m of row.manager_ids) if (!known.manager_ids.includes(m)) known.manager_ids.push(m);
  }
  return [...byId.values()].map((r) => ({ ...r, manager_ids: [...r.manager_ids].sort() }));
}

function createLsaProfileSync({
  db, saJson, fetchImpl = (...a) => fetch(...a), now = () => new Date(), log = console,
  apiVersion = (process.env.GOOGLE_ADS_API_VERSION || 'v26').trim() || 'v26',
  attempts = 4, backoffMs = 4000,
} = {}) {
  let account = null;
  try { account = saJson ? JSON.parse(saJson) : null; } catch { account = null; }
  const configured = !!(account && account.client_email && account.private_key);

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
    if (!r.ok || !j.access_token) throw new Error(`token ${r.status} ${j.error || ''}`.trim());
    token = { value: j.access_token, until: now().getTime() + (Math.max(600, Number(j.expires_in) || 3600) - 300) * 1000 };
    return token.value;
  }

  /**
   * One GET, retried. Google answers this API with a passing 403 or 500 often enough
   * (seen 2026-11-23: the same manager refused, failed and then answered within a
   * minute) that one try per manager would leave holes in the day.
   */
  async function get(url) {
    let last = 'no reply';
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt) await sleep(backoffMs);
      let r;
      try {
        r = await fetchImpl(url, { headers: { Authorization: `Bearer ${await accessToken()}` }, signal: AbortSignal.timeout(60000) });
      } catch (err) { last = `network: ${String(err && err.message).slice(0, 120)}`; continue; }
      if (r.ok) return r.json();
      const body = await r.json().catch(() => ({}));
      last = `${r.status} ${String((body.error && body.error.message) || '').slice(0, 160)}`.trim();
      if (r.status === 401) token = null;
      if (r.status === 400 || r.status === 404) break; // a malformed request does not get better
    }
    throw new Error(last);
  }

  async function managerIds() {
    const listed = await get(`https://googleads.googleapis.com/${apiVersion}/customers:listAccessibleCustomers`);
    return (listed.resourceNames || []).map((n) => digits(String(n).split('/')[1])).filter(Boolean);
  }

  async function managerReports(managerId, { from, to }) {
    const out = [];
    const [fy, fm, fd] = from.split('-').map(Number);
    const [ty, tm, td] = to.split('-').map(Number);
    let pageToken = '';
    for (let page = 0; page < 20; page++) {
      const q = new URLSearchParams({
        query: `manager_customer_id:${managerId}`,
        'startDate.year': fy, 'startDate.month': fm, 'startDate.day': fd,
        'endDate.year': ty, 'endDate.month': tm, 'endDate.day': td,
        pageSize: '1000',
      });
      if (pageToken) q.set('pageToken', pageToken);
      const j = await get(`${REPORTS_URL}?${q}`);
      for (const r of j.accountReports || []) out.push(r);
      pageToken = j.nextPageToken || '';
      if (!pageToken) break;
    }
    return out;
  }

  let running = false;
  let last = null;

  /** Run once. Never throws: the summary carries `error` when the run could not finish. */
  async function syncProfiles({ dryRun = false } = {}) {
    if (!configured) return { error: 'GOOGLE_ADS_SA_JSON is not set or not a service account key' };
    if (running) return { error: 'a profile sync is already running' };
    running = true;
    const started = now();
    const c = denverClock(started);
    const day = `${c.y}-${String(c.m).padStart(2, '0')}-${String(c.d).padStart(2, '0')}`;
    const summary = {
      started: started.toISOString(), finished: null, dry_run: !!dryRun, day, ...reportWindow(day),
      managers: 0, managers_failed: 0, accounts: 0, excluded_accounts: 0, excluded_list: null, with_reviews: 0, stored: 0, errors: [], error: null,
    };
    try {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('could not read the Denver date');
      // The accounts that are another company's. When the list cannot be read the run
      // goes on with nobody skipped, and says so.
      const notOurs = await loadExcludedAccounts(db);
      if (notOurs.error) log.warn(`[lsa-profiles] lsa_account_overrides could not be read (${notOurs.error}): no account is skipped as another company's`);
      summary.excluded_list = notOurs.error ? `unavailable: ${notOurs.error}` : 'ok';
      const managers = await managerIds();
      summary.managers = managers.length;
      const rows = [];
      // One manager at a time: there are a couple of dozen, and the API is touchy.
      for (const m of managers) {
        try {
          for (const r of await managerReports(m, summary)) rows.push(profileRow(r, { day, managerId: m, nowIso: started.toISOString() }));
        } catch (err) {
          summary.managers_failed++;
          if (summary.errors.length < 8) summary.errors.push(`manager ${m}: ${String((err && err.message) || err).slice(0, 200)}`);
        }
      }
      const { kept: merged, dropped } = dropExcluded(mergeProfiles(rows), notOurs.ids, (r) => r.account_id);
      summary.excluded_accounts = dropped;
      summary.accounts = merged.length;
      summary.with_reviews = merged.filter((r) => r.total_reviews !== null).length;
      if (!dryRun && merged.length) {
        for (const part of chunk(merged, 500)) await db.upsert(TABLE, part, 'account_id,day');
        summary.stored = merged.length;
      }
    } catch (err) {
      summary.error = String((err && err.message) || err).slice(0, 300);
      log.error('[lsa-profiles] sync failed:', summary.error);
    } finally {
      summary.finished = now().toISOString();
      last = summary;
      running = false;
      log.log(`[lsa-profiles] ${summary.dry_run ? 'dry run' : 'run'} ${summary.day}: ${summary.accounts} accounts from ${summary.managers} managers (${summary.managers_failed} failed)${summary.excluded_accounts ? `, ${summary.excluded_accounts} skipped as another company's` : ''}, ${summary.stored} stored${summary.error ? `, error: ${summary.error}` : ''}`);
    }
    return summary;
  }

  /** Is today's snapshot already stored? Survives a restart, unlike an in-memory day. */
  async function storedToday(day) {
    const rows = await db.select(TABLE, `select=day&day=eq.${day}&limit=1`);
    return rows.length > 0;
  }

  return { configured, syncProfiles, storedToday, status: () => ({ configured, running, last }) };
}

/**
 * POST /lsa/profiles-sync?dry=1     Authorization: Bearer <LSA_IMPORT_KEY>
 *   Runs one profile sync and replies with its summary (a couple of dozen requests).
 * GET /lsa/profiles-sync/status → the last finished run.
 * Daily from 06:00 America/Denver when GOOGLE_ADS_SA_JSON is set.
 */
function mountLsaProfileSync(app, { SUPABASE_URL, SUPABASE_SERVICE_KEY, LSA_IMPORT_KEY, GOOGLE_ADS_SA_JSON, db, fetchImpl, schedule = true }) {
  const store = db || restDb({ SUPABASE_URL, SUPABASE_SERVICE_KEY });
  const sync = createLsaProfileSync({ db: store, saJson: GOOGLE_ADS_SA_JSON, ...(fetchImpl ? { fetchImpl } : {}) });

  const gate = (req, res) => {
    if (!LSA_IMPORT_KEY) { res.status(503).json({ error: 'LSA_IMPORT_KEY is not set' }); return false; }
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (!keyOk(bearer && bearer[1], LSA_IMPORT_KEY)) { res.status(401).json({ error: 'Unauthorized' }); return false; }
    if (!sync.configured) { res.status(503).json({ error: 'GOOGLE_ADS_SA_JSON is not set' }); return false; }
    return true;
  };

  app.post('/lsa/profiles-sync', async (req, res) => {
    try {
      if (!gate(req, res)) return;
      if (sync.status().running) return res.status(409).json({ error: 'a profile sync is already running' });
      return res.json(await sync.syncProfiles({ dryRun: ['1', 'true', 'yes'].includes(String(req.query.dry || '').toLowerCase()) }));
    } catch (err) {
      console.error('[lsa-profiles] route failed:', err && err.message);
      if (!res.headersSent) res.status(500).json({ error: 'profile sync failed' });
    }
  });

  app.get('/lsa/profiles-sync/status', (req, res) => {
    try { if (gate(req, res)) res.json(sync.status()); } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: 'status failed' });
    }
  });

  if (schedule && sync.configured && SUPABASE_SERVICE_KEY) {
    let lastDay = null;
    // Plain numbers and every step inside the try: a thrown tick took the whole server
    // down once (netsuiteSync, 2026-11-08).
    const tick = async () => {
      try {
        const { y, m, d, h } = denverClock();
        if (![y, m, d, h].every(Number.isFinite) || h < 6) return;
        const day = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        if (day === lastDay) return;
        // The table is missing until supabase_lsa_account_reports.sql is run: say nothing, try again tomorrow.
        const there = await sync.storedToday(day).catch(() => null);
        if (there === null) { lastDay = day; return; }
        if (!there) {
          const s = await sync.syncProfiles();
          if (s.error || !s.stored) return; // not remembered: the next tick tries again
        }
        lastDay = day;
      } catch (err) {
        console.error('[lsa-profiles] daily tick failed:', err && err.message);
      }
    };
    setTimeout(tick, 8 * 60 * 1000);
    setInterval(tick, 30 * 60 * 1000);
  }
  return sync;
}

module.exports = mountLsaProfileSync;
Object.assign(module.exports, { PERIOD_DAYS, REPORTS_URL, shiftDay, reportWindow, profileRow, mergeProfiles, createLsaProfileSync });
