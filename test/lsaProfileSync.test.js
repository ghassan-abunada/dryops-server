'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const api = require('../lsaProfileSync');

const NOW = Date.parse('2026-11-23T18:00:00Z'); // 11:00 in Denver
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const SA = JSON.stringify({ client_email: 'sync@example.iam.gserviceaccount.com', private_key: privateKey });
const quiet = { log() {}, warn() {}, error() {} };

// Google's own shape: int64 fields arrive as strings, the rest as numbers.
const report = (id, o = {}) => ({
  accountId: id, businessName: `Profile ${id}`, averageWeeklyBudget: 1500, averageFiveStarRating: 4.9, totalReview: 810,
  phoneLeadResponsiveness: 0.92, currentPeriodChargedLeads: '42', previousPeriodChargedLeads: '37', currentPeriodTotalCost: 6300.5,
  previousPeriodTotalCost: 5100, currencyCode: 'USD', currentPeriodPhoneCalls: '60', previousPeriodPhoneCalls: '55',
  currentPeriodConnectedPhoneCalls: '51', previousPeriodConnectedPhoneCalls: '40', impressionsLastTwoDays: '1234', ...o,
});

test('reportWindow: the 30 full days before the day, across a month and a year', () => {
  assert.deepStrictEqual(api.reportWindow('2026-11-23'), { from: '2026-10-24', to: '2026-11-22' });
  assert.deepStrictEqual(api.reportWindow('2027-01-05'), { from: '2026-12-06', to: '2027-01-04' });
});

test('profileRow: strings to numbers, an absent figure is null, no account id is no row', () => {
  const row = api.profileRow(report('9506066111'), { day: '2026-11-23', managerId: '4612399237', nowIso: 'T' });
  assert.deepStrictEqual(row, {
    account_id: '9506066111', day: '2026-11-23', business_name: 'Profile 9506066111', total_reviews: 810, avg_rating: 4.9,
    weekly_budget: 1500, phone_responsiveness: 0.92, period_days: 30, charged_leads: 42, prev_charged_leads: 37, cost: 6300.5,
    prev_cost: 5100, phone_calls: 60, prev_phone_calls: 55, connected_calls: 51, prev_connected_calls: 40, impressions_2d: 1234,
    currency_code: 'USD', manager_ids: ['4612399237'], updated_at: 'T',
  });
  const bare = api.profileRow({ accountId: '77' }, { day: '2026-11-23' });
  assert.deepStrictEqual([bare.total_reviews, bare.avg_rating, bare.cost, bare.charged_leads, bare.manager_ids], [null, null, null, null, []]);
  assert.strictEqual(api.profileRow({ businessName: 'no id' }, { day: '2026-11-23' }), null);
});

test('mergeProfiles: an account under two managers is one row carrying both', () => {
  const a = api.profileRow(report('5'), { day: 'd', managerId: '901' });
  const b = api.profileRow(report('5'), { day: 'd', managerId: '900' });
  const c = api.profileRow(report('6'), { day: 'd', managerId: '900' });
  const out = api.mergeProfiles([a, null, b, c]);
  assert.deepStrictEqual(out.map((r) => [r.account_id, r.manager_ids]), [['5', ['900', '901']], ['6', ['900']]]);
});

function memoryDb({ missing = false } = {}) {
  const rows = new Map();
  const writes = [];
  return {
    rows, writes,
    async select(table, query) {
      if (missing) throw new Error(`${table} select 404`);
      const day = /day=eq\.([\d-]+)/.exec(query);
      return [...rows.values()].filter((r) => !day || r.day === day[1]).slice(0, 1).map((r) => ({ day: r.day }));
    },
    async upsert(table, list, conflictCol) {
      if (missing) throw new Error(`${table} upsert 404`);
      assert.strictEqual(table, 'lsa_account_reports');
      assert.strictEqual(conflictCol, 'account_id,day');
      writes.push(list);
      for (const r of list) rows.set(`${r.account_id}|${r.day}`, r);
    },
  };
}

/** A pretend Google. `reports` = { '<manager id>': [report, ...] }, `fail` = { '<manager id>': [status, ...] }. */
function google({ reports, fail = {} }) {
  const calls = [];
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const fetchImpl = async (url, init = {}) => {
    if (url === 'https://oauth2.googleapis.com/token') { calls.push({ kind: 'token' }); return reply(200, { access_token: 'tok', expires_in: 3600 }); }
    assert.strictEqual(init.headers.Authorization, 'Bearer tok');
    if (url.endsWith('/customers:listAccessibleCustomers')) { calls.push({ kind: 'list' }); return reply(200, { resourceNames: Object.keys(reports).map((m) => `customers/${m}`) }); }
    assert.ok(url.startsWith(`${api.REPORTS_URL}?`), url);
    const q = new URL(url).searchParams;
    const m = /^manager_customer_id:(\d+)$/.exec(q.get('query'))[1];
    calls.push({ kind: 'reports', m, from: `${q.get('startDate.year')}-${q.get('startDate.month')}-${q.get('startDate.day')}`, to: `${q.get('endDate.year')}-${q.get('endDate.month')}-${q.get('endDate.day')}`, page: q.get('pageToken') });
    const status = (fail[m] || []).shift();
    if (status) return reply(status, { error: { code: status, message: status === 403 ? `You do not have access to manager customer id ${m}` : 'Internal error encountered.' } });
    const all = reports[m];
    if (all.length > 1 && !q.get('pageToken')) return reply(200, { accountReports: all.slice(0, 1), nextPageToken: 'p2' });
    return reply(200, { accountReports: q.get('pageToken') ? all.slice(1) : all });
  };
  return { fetchImpl, calls };
}

const make = (db, g, o = {}) => api.createLsaProfileSync({ db, saJson: SA, fetchImpl: g.fetchImpl, now: () => new Date(NOW), log: quiet, backoffMs: 0, ...o });

test('syncProfiles: every manager, the 30-day window, pages followed, one row per account for the Denver day', async () => {
  const db = memoryDb();
  const g = google({ reports: { 900: [report('11'), report('12', { totalReview: 615 })], 901: [report('11')], 902: [] } });
  const sync = make(db, g);
  const s = await sync.syncProfiles();
  assert.deepStrictEqual([s.error, s.day, s.from, s.to], [null, '2026-11-23', '2026-10-24', '2026-11-22']);
  assert.deepStrictEqual([s.managers, s.managers_failed, s.accounts, s.with_reviews, s.stored], [3, 0, 2, 2, 2]);
  const asked = g.calls.filter((c) => c.kind === 'reports');
  assert.deepStrictEqual(asked.map((c) => [c.m, c.page]), [['900', null], ['900', 'p2'], ['901', null], ['902', null]]);
  assert.ok(asked.every((c) => c.from === '2026-10-24' && c.to === '2026-11-22'));
  assert.strictEqual(g.calls.filter((c) => c.kind === 'token').length, 1, 'the token is cached');
  assert.deepStrictEqual(db.rows.get('11|2026-11-23').manager_ids, ['900', '901']);
  assert.strictEqual(db.rows.get('12|2026-11-23').total_reviews, 615);
  assert.strictEqual(await sync.storedToday('2026-11-23'), true);
  assert.strictEqual(await sync.storedToday('2026-11-24'), false);
  assert.strictEqual(sync.status().last.day, '2026-11-23');
});

test('syncProfiles: a passing 403 or 500 is retried; a manager that keeps failing is recorded and the rest are stored', async () => {
  const db = memoryDb();
  const g = google({ reports: { 900: [report('11')], 901: [report('12')] }, fail: { 900: [403, 500], 901: [403, 403, 403, 403] } });
  const s = await make(db, g).syncProfiles();
  assert.deepStrictEqual([s.error, s.managers, s.managers_failed, s.accounts, s.stored], [null, 2, 1, 1, 1]);
  assert.match(s.errors[0], /^manager 901: 403 You do not have access/);
  assert.ok(db.rows.has('11|2026-11-23') && !db.rows.has('12|2026-11-23'));
});

test('syncProfiles: a dry run stores nothing; a missing table is an error in the summary, not a throw; no key, no run', async () => {
  const g = google({ reports: { 900: [report('11')] } });
  const db = memoryDb();
  const dry = await make(db, g).syncProfiles({ dryRun: true });
  assert.deepStrictEqual([dry.accounts, dry.stored, db.writes.length], [1, 0, 0]);
  const s = await make(memoryDb({ missing: true }), g).syncProfiles();
  assert.match(s.error, /lsa_account_reports upsert 404/);
  assert.strictEqual(s.stored, 0);
  const none = api.createLsaProfileSync({ db, saJson: '', log: quiet });
  assert.strictEqual(none.configured, false);
  assert.match((await none.syncProfiles()).error, /GOOGLE_ADS_SA_JSON/);
});

test('routes: bearer key, the summary inline, status', async () => {
  const routes = {};
  const app = { post: (p, h) => { routes[`POST ${p}`] = h; }, get: (p, h) => { routes[`GET ${p}`] = h; } };
  const db = memoryDb();
  const g = google({ reports: { 900: [report('11')] } });
  api(app, { LSA_IMPORT_KEY: 'k', GOOGLE_ADS_SA_JSON: SA, db, fetchImpl: g.fetchImpl, schedule: false });
  const call = async (route, { key = 'k', query = {} } = {}) => {
    const res = { code: 200, body: null, headersSent: false, status(c) { this.code = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; } };
    await routes[route]({ headers: { authorization: `Bearer ${key}` }, query }, res);
    return res;
  };
  assert.strictEqual((await call('POST /lsa/profiles-sync', { key: 'wrong' })).code, 401);
  const dry = await call('POST /lsa/profiles-sync', { query: { dry: '1' } });
  assert.deepStrictEqual([dry.code, dry.body.dry_run, dry.body.accounts, db.writes.length], [200, true, 1, 0]);
  const real = await call('POST /lsa/profiles-sync');
  assert.deepStrictEqual([real.body.stored, db.rows.size], [1, 1]);
  assert.strictEqual((await call('GET /lsa/profiles-sync/status')).body.last.stored, 1);
});
