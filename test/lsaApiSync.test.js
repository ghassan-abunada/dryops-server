// Google Ads API sync for Local Services leads (lsaApiSync.js): the lead mapping, the
// write rule against rows the CSV imports stored, conversations, which accounts a run
// asks about, the request budget, and that a later CSV import leaves API data alone.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const api = require('../lsaApiSync');
const lsa = require('../lsaImport');

const result = (lead = {}, customer = {}) => ({
  localServicesLead: {
    resourceName: 'customers/3776078990/localServicesLeads/349413124', id: '349413124', leadType: 'PHONE_CALL', leadStatus: 'ACTIVE',
    creationDateTime: '2026-11-02 14:42:22.988607', categoryId: 'xcat:service_area_business_water_damage',
    serviceId: 'water_damage_cleanup_repair', contactDetails: { phoneNumber: '+15550100001' },
    campaign: 'customers/3776078990/campaigns/23612765900', locale: 'en', ...lead,
  },
  customer: { id: '3776078990', descriptiveName: 'Example Restoration', ...customer },
});

test('apiLeadRow: the columns the API owns, from one search result', () => {
  const row = api.apiLeadRow(result({ leadCharged: true }), { managerId: '2632285119' });
  assert.deepStrictEqual({ ...row, raw: undefined, row_hash: undefined }, {
    google_lead_id: '349413124', account_id: '3776078990', business_name: 'Example Restoration',
    lead_created_local: '2026-11-02 14:42:22', time_known: true, source_format: 'api', lead_type: 'PHONE_CALL',
    lead_category: 'water_damage', job_type: 'water_damage_cleanup_repair', customer_phone: '+15550100001',
    customer_name: null, customer_email: null, campaign_id: '23612765900', charge_status: 'Charged', charged: true,
    row_hash: undefined, raw: undefined, manager_ids: ['2632285119'],
  });
  assert.match(row.row_hash, /^api:[0-9a-f]{40}$/);
  assert.strictEqual(row.raw.source, 'google-ads-api');
  assert.strictEqual(row.raw.lead.leadStatus, 'ACTIVE');
  assert.deepStrictEqual(row.raw.customer, { id: '3776078990', descriptiveName: 'Example Restoration' });
  assert.ok(!('customer_phone_norm' in row), 'the generated column is never written');
});

test('apiLeadRow: charge states (leadCharged is absent when false), campaign, category, other lead types', () => {
  const of = (lead) => { const r = api.apiLeadRow(result(lead)); return [r.charge_status, r.charged]; };
  assert.deepStrictEqual(of({}), ['Not charged', false]);
  assert.deepStrictEqual(of({ leadCharged: true }), ['Charged', true]);
  assert.deepStrictEqual(of({ leadCharged: true, creditDetails: { creditState: 'CREDITED' } }), ['Credited', false]);
  assert.deepStrictEqual(of({ leadCharged: true, creditDetails: { creditState: 'PENDING' } }), ['In review', null]);
  assert.strictEqual(api.apiLeadRow(result({ campaign: undefined })).campaign_id, null);
  assert.strictEqual(api.apiLeadRow(result({ categoryId: 'xcat:plumbing' })).lead_category, 'plumbing');
  assert.strictEqual(api.apiLeadRow(result({ categoryId: undefined })).lead_category, null);
  assert.strictEqual(api.apiLeadRow(result({ leadType: 'BOOKING' })).lead_type, 'BOOKING');
  assert.strictEqual(api.apiLeadRow(result({ leadType: 'SOMETHING_NEW' })).lead_type, 'SOMETHING_NEW');
  const full = api.apiLeadRow(result({ contactDetails: { phoneNumber: '+15550100002', email: 'a@example.com', consumerName: 'Pat Doe' } }));
  assert.deepStrictEqual([full.customer_phone, full.customer_email, full.customer_name], ['+15550100002', 'a@example.com', 'Pat Doe']);
  assert.strictEqual(api.apiLeadRow(result({ id: undefined })), null);
  // No customer block: the account comes from the lead's resource name.
  assert.strictEqual(api.apiLeadRow({ localServicesLead: result().localServicesLead }).account_id, '3776078990');
  // The hash moves with an owned field and with nothing else.
  assert.notStrictEqual(api.apiLeadRow(result({ leadCharged: true })).row_hash, api.apiLeadRow(result()).row_hash);
  assert.strictEqual(api.apiLeadRow(result({ leadStatus: 'NEW' })).row_hash, api.apiLeadRow(result()).row_hash);
});

const stored = (o = {}) => ({
  google_lead_id: '349413124', account_id: '3776078990', business_name: 'Example Restoration', lead_created_local: '2026-11-02T14:42:22',
  time_known: true, source_format: 'detailed', lead_type: 'PHONE_CALL', lead_category: 'water_damage', job_type: 'water_damage_cleanup_repair',
  customer_phone: '+15550100001', customer_name: 'Pat Doe', customer_email: null, campaign_id: null, charge_status: null, charged: true,
  row_hash: 'abc', manager_ids: ['111'], changed_at: null, ...o,
});

test('diffApiLeads: a new lead is written whole', () => {
  const row = api.apiLeadRow(result({ leadCharged: true }), { managerId: '222' });
  const d = api.diffApiLeads([row], new Map(), ['222'], 'NOW');
  assert.deepStrictEqual(d.counts, { new: 1, changed: 0, same: 0, moved: 0 });
  assert.deepStrictEqual(d.inserts, [{ ...row, manager_ids: ['222'], changed_at: null }]);
  assert.deepStrictEqual(d.updates, []);
});

test('diffApiLeads: a detailed-report row gets only what differs, a first fill is not logged, nulls never win', () => {
  const row = api.apiLeadRow(result({ leadCharged: true }), { managerId: '222' });
  const d = api.diffApiLeads([row], new Map([[row.google_lead_id, stored()]]), ['222'], 'NOW');
  assert.deepStrictEqual(d.counts, { new: 0, changed: 1, same: 0, moved: 0 });
  const [u] = d.updates;
  // customer_name is null from the API and stays 'Pat Doe'; the timestamp is the same moment in another spelling.
  assert.deepStrictEqual(u.patch, { source_format: 'api', campaign_id: '23612765900', charge_status: 'Charged', row_hash: row.row_hash, manager_ids: ['111', '222'] });
  assert.deepStrictEqual(d.changes, [], 'campaign and charge status were empty: filling them is not a change');
  const merged = api.mergedRow(u, { 'Account ID': '3776078990' });
  assert.strictEqual(merged.customer_name, 'Pat Doe');
  assert.deepStrictEqual(merged.raw, { 'Account ID': '3776078990' }, 'the CSV record stays in raw');
  assert.strictEqual(merged.changed_at, 'NOW');
  for (const f of ['geo', 'external_lead_id', 'zipcode', 'booking_local', 'charged_call_local', 'charged_call_seconds', 'dispute_status', 'customer_phone_ext', 'campaign_name', 'customer_phone_norm']) {
    assert.ok(!(f in merged), `${f} is not sent`);
  }
});

test('diffApiLeads: a pay-per-lead placeholder row moves to the real account and gets its time', () => {
  const row = api.apiLeadRow(result({ leadCharged: true }), { managerId: '222' });
  const old = stored({ account_id: 'C23612765900', business_name: '5 Star', lead_created_local: '2026-11-02T00:00:00', time_known: false, source_format: 'ppl', lead_category: 'Water damage', job_type: 'Water damage cleanup repair', campaign_id: '23612765900', charge_status: 'Not charged', charged: false, row_hash: 'ppl:x', manager_ids: ['222'] });
  const d = api.diffApiLeads([row], new Map([[row.google_lead_id, old]]), ['222'], 'NOW');
  assert.deepStrictEqual(d.counts, { new: 0, changed: 1, same: 0, moved: 1 });
  assert.deepStrictEqual(d.updates[0].patch, {
    account_id: '3776078990', business_name: 'Example Restoration', lead_created_local: '2026-11-02 14:42:22', time_known: true, source_format: 'api',
    lead_category: 'water_damage', job_type: 'water_damage_cleanup_repair', charge_status: 'Charged', charged: true, row_hash: row.row_hash,
  });
  assert.deepStrictEqual(d.changes.map((c) => [c.field, c.old_value, c.new_value]), [
    ['account_id', 'C23612765900', '3776078990'], ['charge_status', 'Not charged', 'Charged'], ['charged', 'false', 'true'],
  ]);
  assert.strictEqual(d.fields.account_id, 1);
});

test('diffApiLeads: an unchanged API row is left alone; "In review" does not clear charged; a new manager is recorded', () => {
  const row = api.apiLeadRow(result({ leadCharged: true }), { managerId: '222' });
  const mine = stored({ source_format: 'api', campaign_id: '23612765900', charge_status: 'Charged', customer_name: null, row_hash: row.row_hash, manager_ids: ['222'] });
  let d = api.diffApiLeads([row], new Map([[row.google_lead_id, mine]]), ['222'], 'NOW');
  assert.deepStrictEqual([d.counts.same, d.updates.length], [1, 0]);
  d = api.diffApiLeads([row], new Map([[row.google_lead_id, mine]]), ['222', '333'], 'NOW');
  assert.deepStrictEqual(d.updates.map((u) => [u.patch, u.changed, u.changed_at]), [[{ manager_ids: ['222', '333'] }, false, null]]);
  const review = api.apiLeadRow(result({ leadCharged: true, creditDetails: { creditState: 'PENDING' } }));
  d = api.diffApiLeads([review], new Map([[row.google_lead_id, mine]]), ['222'], 'NOW');
  assert.deepStrictEqual(d.updates[0].patch, { charge_status: 'In review', raw: review.raw, row_hash: review.row_hash });
  assert.strictEqual(api.mergedRow(d.updates[0]).charged, true);
});

test('summarizeConversations: longest consumer call, no recording links, text cut to 500', () => {
  const conv = (o) => ({ localServicesLeadConversation: { lead: 'customers/3776078990/localServicesLeads/349413124', ...o } });
  const by = api.summarizeConversations([
    conv({ eventDateTime: '2026-11-02 15:10:00.5', conversationChannel: 'PHONE_CALL', participantType: 'CONSUMER', phoneCallDetails: { callDurationMillis: '121741', callRecordingUrl: 'https://example.com/signed' } }),
    conv({ eventDateTime: '2026-11-02 14:42:22.9', conversationChannel: 'PHONE_CALL', participantType: 'CONSUMER', phoneCallDetails: { callDurationMillis: '30400' } }),
    conv({ eventDateTime: '2026-11-02 16:00:00', conversationChannel: 'PHONE_CALL', participantType: 'ADVERTISER', phoneCallDetails: { callDurationMillis: '900000' } }),
    conv({ eventDateTime: '2026-11-02 16:05:00', conversationChannel: 'MESSAGE', participantType: 'CONSUMER', messageDetails: { text: 'x'.repeat(700) } }),
    conv({ lead: 'customers/3776078990/localServicesLeads/777', eventDateTime: '2026-11-03 09:00:00', conversationChannel: 'MESSAGE', participantType: 'ADVERTISER', messageDetails: { text: 'hello' } }),
    { localServicesLeadConversation: { lead: 'nonsense' } },
  ]);
  const g = by.get('349413124');
  assert.strictEqual(g.seconds, 122);
  assert.deepStrictEqual(g.list.slice(0, 3), [
    { at: '2026-11-02 14:42:22', channel: 'PHONE_CALL', from: 'CONSUMER', seconds: 30 },
    { at: '2026-11-02 15:10:00', channel: 'PHONE_CALL', from: 'CONSUMER', seconds: 122, has_recording: true },
    { at: '2026-11-02 16:00:00', channel: 'PHONE_CALL', from: 'ADVERTISER', seconds: 900 },
  ]);
  assert.strictEqual(g.list[3].text.length, 500);
  assert.ok(!JSON.stringify([...by.values()]).includes('example.com'));
  assert.deepStrictEqual(by.get('777'), { list: [{ at: '2026-11-03 09:00:00', channel: 'MESSAGE', from: 'ADVERTISER', text: 'hello' }], seconds: null });
  assert.strictEqual(by.size, 2);
  // jsonb gives keys back in its own order: the comparison must not care.
  assert.strictEqual(api.canon([{ b: 1, a: [{ d: 1, c: 2 }] }]), api.canon([{ a: [{ c: 2, d: 1 }], b: 1 }]));
});

const NOW = Date.parse('2026-11-16T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();
const client = (id, o = {}) => ({ id, status: 'ENABLED', managers: ['900'], ...o });

test('chooseAccounts: accounts with leads every run, empty ones weekly and capped, disabled never', () => {
  const clients = [client('1'), client('2'), client('3'), client('4'), client('5'), client('6'), client('7', { status: 'CANCELED' })];
  const memory = new Map([
    ['1', { lead_count: 12, last_checked_at: daysAgo(1) }],
    ['2', { lead_count: 0, last_checked_at: daysAgo(2) }],  // looked at this week: wait
    ['3', { lead_count: 0, last_checked_at: daysAgo(9) }],
    ['4', { lead_count: 0, last_checked_at: daysAgo(30) }],
    ['5', { lead_count: 0, last_checked_at: daysAgo(8) }],
    // 6: never looked at
  ]);
  const pick = (o) => api.chooseAccounts({ clients, memory, nowMs: NOW, ...o });
  let out = pick({ emptyPerRun: 2 });
  assert.deepStrictEqual(out.queue.map((q) => [q.client.id, q.reason]), [['1', 'active'], ['6', 'fresh'], ['4', 'stale'], ['3', 'stale']]);
  assert.deepStrictEqual(out.counts, { enabled: 6, matched: 6, active: 1, fresh: 1, stale: 2, deferred: 1, waiting: 1 });
  // A tight budget: the account with leads keeps its two requests, the rest share what is left.
  out = pick({ budget: 4 });
  assert.deepStrictEqual(out.queue.map((q) => q.client.id), ['1', '6']);
  out = pick({ budget: 1 });
  assert.deepStrictEqual(out.queue, []);
  // full: everything enabled, least recently looked at first; only: by customer or by manager.
  assert.deepStrictEqual(pick({ full: true }).queue.map((q) => q.client.id), ['6', '4', '3', '5', '2', '1']);
  assert.deepStrictEqual(pick({ full: true, budget: 2 }).counts.deferred, 4);
  assert.deepStrictEqual(pick({ only: new Set(['2', '7']) }).queue.map((q) => q.client.id), ['2']);
  assert.strictEqual(pick({ only: new Set(['900']) }).queue.length, 6);
  // No memory table: every enabled account.
  assert.strictEqual(api.chooseAccounts({ clients, memory: null, nowMs: NOW }).queue.length, 6);
});

test('dailyDue: from 05:30 Denver, once a day, and never throws on a bad clock', () => {
  assert.deepStrictEqual(api.dailyDue({ y: 2026, m: 11, d: 16, h: 5, min: 29 }, null), { due: false, dayKey: '2026-11-16' });
  assert.deepStrictEqual(api.dailyDue({ y: 2026, m: 11, d: 16, h: 5, min: 30 }, '2026-11-15'), { due: true, dayKey: '2026-11-16' });
  assert.strictEqual(api.dailyDue({ y: 2026, m: 11, d: 16, h: 14, min: 0 }, '2026-11-16').due, false);
  assert.strictEqual(api.dailyDue(new Date(), null).due, false);
  assert.strictEqual(api.dailyDue(undefined, null).due, false);
  const c = api.denverClock(new Date('2026-11-16T12:30:00Z'));
  assert.deepStrictEqual(c, { y: 2026, m: 11, d: 16, h: 5, min: 30 });
});

// ── a whole run against an in-memory store and a mocked Google ─────────────

function memoryDb({ missing = [], cost = false } = {}) {
  const tables = { lsa_leads: new Map(), lsa_campaigns: new Map(), lsa_api_accounts: new Map(), lsa_imports: [], lsa_lead_changes: [] };
  // supabase_lsa_api_cost.sql: without `cost` the table is not there, as before that file is run.
  if (cost) tables.lsa_campaign_daily = new Map();
  const writes = [];
  const rowsOf = (t) => (Array.isArray(tables[t]) ? tables[t] : [...tables[t].values()]);
  return {
    tables,
    writes,
    async select(table, query) {
      if (missing.includes(table)) throw new Error(`${table} select 404`);
      const q = new URLSearchParams(query);
      const cols = (q.get('select') || '*').split(',');
      if (table === 'lsa_leads' && cols.includes('conversations') && missing.includes('conversations')) throw new Error('lsa_leads select 400');
      if (table === 'lsa_api_accounts' && cols.includes('last_cost_at') && (!cost || missing.includes('last_cost_at'))) throw new Error('lsa_api_accounts select 400');
      let rows = rowsOf(table);
      for (const [k, v] of q) {
        if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
        if (v.startsWith('in.(')) { const ids = v.slice(4, -1).split(','); rows = rows.filter((r) => ids.includes(r[k])); }
        else if (v.startsWith('eq.')) rows = rows.filter((r) => String(r[k]) === v.slice(3));
        else if (v.startsWith('gte.')) rows = rows.filter((r) => String(r[k]) >= v.slice(4));
        else if (v.startsWith('like.')) rows = rows.filter((r) => String(r[k] || '').includes(v.slice(5).replace(/\*/g, '')));
        else throw new Error(`memoryDb: unexpected filter ${k}=${v}`);
      }
      const offset = Number(q.get('offset') || 0);
      rows = rows.slice(offset, offset + Number(q.get('limit') || 1000));
      return rows.map((r) => (cols[0] === '*' ? { ...r } : Object.fromEntries(cols.map((c) => [c, r[c] ?? null]))));
    },
    async upsert(table, rows, conflictCol) {
      const keys = JSON.stringify(Object.keys(rows[0]).sort());
      for (const r of rows) assert.strictEqual(JSON.stringify(Object.keys(r).sort()), keys, 'one upsert, one set of keys');
      writes.push({ op: 'upsert', table, rows });
      if (missing.includes(`${table} upsert`)) throw new Error(`${table} upsert 500`);
      const keyOf = (r) => conflictCol.split(',').map((c) => r[c]).join('|');
      for (const r of rows) tables[table].set(keyOf(r), { ...tables[table].get(keyOf(r)), ...r });
    },
    async update(table, query, patch) {
      writes.push({ op: 'update', table, query, patch });
      const leadIds = /google_lead_id=in\.\(([^)]*)\)/.exec(query);
      if (leadIds) { for (const id of leadIds[1].split(',')) tables[table].set(id, { ...tables[table].get(id), ...patch }); return; }
      const id = /^id=eq\.(.+)$/.exec(query)[1];
      Object.assign(tables[table].find((r) => r.id === id), patch);
    },
    async insert(table, rows) {
      writes.push({ op: 'insert', table, rows });
      const out = rows.map((r, i) => ({ id: `${table}-${tables[table].length + i}`, received_at: new Date().toISOString(), ...r }));
      tables[table].push(...out);
      return out;
    },
  };
}

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const SA = JSON.stringify({ client_email: 'sync@example.iam.gserviceaccount.com', private_key: privateKey });

/** A pretend Google: managers → clients → leads / conversations. `fail` = { '<customer id>': [status, ...] } per lead request. */
function google({ managers, leads = {}, conversations = {}, fail = {}, cost = {}, costFail = {} }) {
  const calls = [];
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const fetchImpl = async (url, init = {}) => {
    if (url === 'https://oauth2.googleapis.com/token') { calls.push({ kind: 'token' }); return reply(200, { access_token: 'tok', expires_in: 3600 }); }
    assert.ok(url.startsWith('https://googleads.googleapis.com/v26/'), url);
    assert.strictEqual(init.headers.Authorization, 'Bearer tok');
    assert.ok(!('developer-token' in init.headers));
    if (url.endsWith('/customers:listAccessibleCustomers')) { calls.push({ kind: 'list' }); return reply(200, { resourceNames: Object.keys(managers).map((m) => `customers/${m}`) }); }
    const cid = /customers\/(\d+)\/googleAds:search$/.exec(url)[1];
    const login = init.headers['login-customer-id'];
    const { query, pageToken } = JSON.parse(init.body);
    if (query.includes('FROM customer_client')) {
      calls.push({ kind: 'clients', cid });
      assert.strictEqual(login, cid);
      const self = { customerClient: { id: cid, manager: true, level: '0', status: 'ENABLED' } };
      return reply(200, { results: [self, ...managers[cid].map((c) => ({ customerClient: { level: '1', status: 'ENABLED', manager: false, descriptiveName: `Account ${c.id}`, timeZone: 'America/Denver', ...c } }))] });
    }
    if (query.includes('FROM local_services_lead_conversation')) {
      calls.push({ kind: 'conversations', cid, login, query });
      return reply(200, { results: conversations[cid] || [] });
    }
    if (query.includes(' FROM campaign ')) {
      calls.push({ kind: 'cost', cid, login, query });
      const status = (costFail[cid] || []).shift();
      if (status) return reply(status, { error: { code: status, status: 'INVALID_ARGUMENT', message: 'no', details: [{ errors: [{ errorCode: { queryError: 'PROHIBITED_METRIC_IN_SELECT_OR_WHERE_CLAUSE' }, message: 'bad metric' }] }] } });
      return reply(200, { results: cost[cid] || [] });
    }
    calls.push({ kind: 'leads', cid, login, query, pageToken });
    const queue = fail[cid] || [];
    if (queue.length) {
      const status = queue.shift();
      return reply(status, { error: { code: status, status: status === 403 ? 'PERMISSION_DENIED' : 'UNAVAILABLE', message: 'no', details: status === 403 ? [{ errors: [{ errorCode: { authorizationError: 'USER_PERMISSION_DENIED' }, message: 'no access' }] }] : [] } });
    }
    const all = leads[cid] || [];
    // Two pages when there are more than two leads, to exercise nextPageToken.
    if (all.length > 2 && !pageToken) return reply(200, { results: all.slice(0, 2), nextPageToken: 'p2' });
    return reply(200, { results: pageToken ? all.slice(2) : all });
  };
  return { fetchImpl, calls, ads: () => calls.filter((c) => c.kind !== 'token') };
}

const quiet = { log() {}, warn() {}, error() {} };
const lead = (id, cid, o = {}) => result({ id, resourceName: `customers/${cid}/localServicesLeads/${id}`, campaign: `customers/${cid}/campaigns/5${cid}`, ...o }, { id: cid, descriptiveName: `Account ${cid}` });
const make = (db, g, o = {}) => api.createLsaApiSync({ db, saJson: SA, fetchImpl: g.fetchImpl, now: () => new Date(NOW), log: quiet, backoffMs: 0, ...o });

test('syncLeads: lists managers and clients once, queries each client under its manager, stores leads, campaigns, conversations and its memory', async () => {
  const db = memoryDb();
  const g = google({
    managers: { 900: [{ id: '11' }, { id: '12' }, { id: '13', status: 'CANCELED' }, { id: '950', manager: true }], 901: [{ id: '11' }] },
    leads: { 11: [lead('1001', '11', { leadCharged: true }), lead('1002', '11'), lead('1003', '11', { leadType: 'MESSAGE' })] },
    conversations: { 11: [{ localServicesLeadConversation: { lead: 'customers/11/localServicesLeads/1001', eventDateTime: '2026-11-02 14:42:30', conversationChannel: 'PHONE_CALL', participantType: 'CONSUMER', phoneCallDetails: { callDurationMillis: '61500', callRecordingUrl: 'https://example.com/r' } } }] },
  });
  const sync = make(db, g);
  const s = await sync.syncLeads({ sinceDays: 14 });
  assert.strictEqual(s.error, null);
  assert.deepStrictEqual([s.managers, s.clients, s.clients_queried, s.clients_with_leads], [2, 3, 2, 1]);
  assert.deepStrictEqual([s.leads_seen, s.leads_new, s.leads_changed, s.leads_same], [3, 3, 0, 0]);
  // 1 list + 2 managers + account 11 (2 pages) + account 12 + conversations for 11
  assert.strictEqual(s.ops_used, 7);
  assert.strictEqual(g.ads().length, 7);
  assert.strictEqual(g.calls.filter((c) => c.kind === 'token').length, 1, 'the token is cached');
  const leadCalls = g.calls.filter((c) => c.kind === 'leads');
  assert.ok(leadCalls.every((c) => c.query.endsWith("WHERE local_services_lead.creation_date_time >= '2026-11-02 00:00:00'")));
  assert.ok(leadCalls.every((c) => c.cid !== '13' && c.cid !== '950'), 'cancelled accounts and sub-managers are not asked');
  const row = db.tables.lsa_leads.get('1001');
  assert.deepStrictEqual([row.account_id, row.charged, row.charge_status, row.source_format, row.manager_ids], ['11', true, 'Charged', 'api', ['900', '901']]);
  assert.strictEqual(row.charged_call_seconds, 62);
  assert.deepStrictEqual(row.conversations, [{ at: '2026-11-02 14:42:30', channel: 'PHONE_CALL', from: 'CONSUMER', seconds: 62, has_recording: true }]);
  assert.deepStrictEqual({ ...db.tables.lsa_campaigns.get('511'), updated_at: 0 }, { campaign_id: '511', account_id: '11', manager_id: '900', updated_at: 0 });
  assert.deepStrictEqual(db.tables.lsa_api_accounts.get('11').lead_count, 3);
  assert.deepStrictEqual([db.tables.lsa_api_accounts.get('12').lead_count, db.tables.lsa_api_accounts.get('12').last_error], [0, null]);
  assert.strictEqual(db.tables.lsa_api_accounts.get('11').last_lead_local, '2026-11-02 14:42:22');
  const [imp] = db.tables.lsa_imports;
  assert.deepStrictEqual([imp.source, imp.filename, imp.row_count, imp.new_count, imp.range_from, imp.range_to], ['api', 'google-ads-api 14d', 3, 3, '2026-11-02', '2026-11-16']);

  // The next day: account 12 had no leads and was looked at a moment ago, so only 11 is asked. Nothing changed.
  const before = g.ads().length;
  const again = await sync.syncLeads({ sinceDays: 14 });
  assert.deepStrictEqual(g.ads().slice(before).filter((c) => c.kind === 'leads').map((c) => c.cid), ['11', '11']);
  assert.deepStrictEqual([again.leads_new, again.leads_changed, again.leads_same, again.conversation_leads_updated], [0, 0, 3, 0]);
  assert.deepStrictEqual(again.selection, { enabled: 2, matched: 2, active: 1, fresh: 0, stale: 0, deferred: 0, waiting: 1 });
  assert.strictEqual(sync.status().ops_last_24h, 7 + 6);
  assert.strictEqual(sync.status().last.run_id, again.run_id);
});

test('syncLeads: rows the CSV imports stored keep their CSV-only fields; a placeholder account is moved and logged', async () => {
  const db = memoryDb();
  db.tables.lsa_leads.set('1001', {
    ...stored({ google_lead_id: '1001', account_id: '11', business_name: 'Account 11', charged: true, row_hash: 'plainhash', manager_ids: ['900'] }),
    geo: 'Denver,Colorado,United States', external_lead_id: '88', zipcode: '80202', charged_call_seconds: 155, dispute_status: 'x', customer_phone_ext: '42', raw: { 'Account ID': '11' },
  });
  db.tables.lsa_leads.set('1002', {
    ...stored({ google_lead_id: '1002', account_id: 'C511', business_name: 'Campaign', lead_created_local: '2026-11-02T00:00:00', time_known: false, source_format: 'ppl', campaign_id: '511', charge_status: 'Charged', charged: true, row_hash: 'ppl:1', manager_ids: ['900'], customer_name: null }),
    campaign_name: 'Pay-per-lead-PMax-Example', raw: { 'Lead ID': '1002' },
  });
  db.tables.lsa_campaigns.set('511', { campaign_id: '511', campaign_name: 'Pay-per-lead-PMax-Example', manager_id: '900', account_id: 'C511' });
  const g = google({
    managers: { 900: [{ id: '11' }] },
    leads: { 11: [lead('1001', '11'), lead('1002', '11', { leadCharged: true, creditDetails: { creditState: 'CREDITED' } })] },
    conversations: { 11: [{ localServicesLeadConversation: { lead: 'customers/11/localServicesLeads/1001', eventDateTime: '2026-11-02 14:42:30', conversationChannel: 'PHONE_CALL', participantType: 'CONSUMER', phoneCallDetails: { callDurationMillis: '9000' } } }] },
  });
  const s = await make(db, g).syncLeads({});
  assert.deepStrictEqual([s.leads_new, s.leads_changed, s.moved_from_placeholder, s.error_count], [0, 2, 1, 0]);
  assert.deepStrictEqual([s.changed_by_source.detailed.leads, s.changed_by_source.ppl.leads, s.changed_by_source.ppl.account_id], [1, 1, 1]);
  assert.deepStrictEqual(s.charge_changes, { 'detailed: none/true -> Not charged/false': 1, 'ppl: Charged/true -> Credited/false': 1 });
  const a = db.tables.lsa_leads.get('1001');
  assert.deepStrictEqual(
    [a.geo, a.external_lead_id, a.zipcode, a.dispute_status, a.customer_phone_ext, a.customer_name, a.raw],
    ['Denver,Colorado,United States', '88', '80202', 'x', '42', 'Pat Doe', { 'Account ID': '11' }],
  );
  assert.deepStrictEqual([a.charged, a.charge_status, a.campaign_id, a.source_format], [false, 'Not charged', '511', 'api']);
  assert.strictEqual(a.charged_call_seconds, 155, 'a call length the report gave is kept');
  assert.strictEqual(a.conversations.length, 1);
  assert.match(a.row_hash, /^api:/);
  const b = db.tables.lsa_leads.get('1002');
  assert.deepStrictEqual([b.account_id, b.lead_created_local, b.time_known, b.charge_status, b.charged, b.campaign_name], ['11', '2026-11-02 14:42:22', true, 'Credited', false, 'Pay-per-lead-PMax-Example']);
  assert.deepStrictEqual(db.tables.lsa_campaigns.get('511').account_id, '11');
  assert.strictEqual(db.tables.lsa_campaigns.get('511').campaign_name, 'Pay-per-lead-PMax-Example', 'the campaign keeps its name');
  const log = db.tables.lsa_lead_changes.map((c) => `${c.google_lead_id} ${c.field} ${c.old_value}>${c.new_value}`).sort();
  assert.deepStrictEqual(log, ['1001 charged true>false', '1002 account_id C511>11', '1002 charge_status Charged>Credited', '1002 charged true>false']);
  assert.ok(db.tables.lsa_lead_changes.every((c) => c.import_id === db.tables.lsa_imports[0].id));
  assert.ok(!db.writes.some((w) => w.op === 'upsert' && w.table === 'lsa_leads' && w.rows.some((r) => 'customer_phone_norm' in r || 'geo' in r)));
});

test('a later CSV import does not undo API data: pay-per-lead patches charge fields only, the detailed report keeps campaign and charge status', async () => {
  const db = memoryDb();
  const g = google({ managers: { 900: [{ id: '11' }] }, leads: { 11: [lead('349780140', '11', { leadCharged: true })] } });
  await make(db, g).syncLeads({});
  const before = { ...db.tables.lsa_leads.get('349780140') };
  assert.ok(lsa.isApiHash(before.row_hash));

  const cols = lsa.PPL_COLUMNS;
  const rec = { 'Lead details': ' +1 555-010-0001', 'First contact date': '2026Nov2', 'Lead status': 'Active', 'Charge status': 'Charged', 'Lead type': 'Phone call', 'Customer name': ' --', 'Additional notes': ' --', 'Service type': 'Water damage cleanup repair', 'Search intent': 'Category', 'Last Updated': '2026Nov3', 'Business category': 'Water damage', 'Lead ID': '349780140', 'Campaign name': 'Pay-per-lead-PMax-Example', 'Campaign ID': '511' };
  const csv = `Pay-per-lead leads report\nAll time\n${cols.join(',')}\n${cols.map((c) => rec[c]).join(',')}\n`;
  const out = await lsa.importReport(db, { csv, managerId: '900', filename: 'ppl.csv' });
  assert.strictEqual(out.status, 200);
  assert.match(out.text, /0 new, 1 matched to existing leads/);
  const after = db.tables.lsa_leads.get('349780140');
  assert.deepStrictEqual(
    [after.account_id, after.lead_created_local, after.time_known, after.source_format, after.lead_category, after.row_hash],
    [before.account_id, before.lead_created_local, true, 'api', 'water_damage', before.row_hash],
  );
  assert.strictEqual(after.campaign_name, 'Pay-per-lead-PMax-Example', 'the one thing only the file knows');
  assert.strictEqual(db.tables.lsa_campaigns.get('511').account_id, '11', 'the campaign stays on the real account');

  // The detailed report sends its own columns; campaign_id and charge_status are not among them.
  const head = lsa.COLUMNS.map((c) => `"${c}"`).join(',');
  const old = { 'Account ID': '11', 'Business Name': 'Account 11', 'Lead Creation Timestamp': '11/2/26 14:42:22', 'Google Ads Lead Id': '349780140', 'Customer Phone Number': '+15550100001', Geo: 'Denver,Colorado,United States', 'Lead Category': 'water_damage', 'Lead Type': 'PHONE_CALL', Charged: 'true', 'Dispute Status': 'NULL' };
  await lsa.importReport(db, { csv: `${head}\n${lsa.COLUMNS.map((c) => `"${old[c] ?? ''}"`).join(',')}\n`, managerId: '900' });
  const last = db.tables.lsa_leads.get('349780140');
  assert.deepStrictEqual([last.campaign_id, last.charge_status, last.geo, last.account_id], ['511', 'Charged', 'Denver,Colorado,United States', '11']);
});

test('syncLeads: dry run reads and diffs but writes nothing; only= walks just that manager', async () => {
  const db = memoryDb();
  db.tables.lsa_leads.set('1002', { ...stored({ google_lead_id: '1002', account_id: 'C511', source_format: 'ppl', row_hash: 'ppl:1' }), raw: {} });
  const g = google({ managers: { 900: [{ id: '11' }], 901: [{ id: '21' }] }, leads: { 11: [lead('1001', '11'), lead('1002', '11')], 21: [lead('2001', '21')] } });
  const s = await make(db, g).syncLeads({ only: '900', dryRun: true });
  assert.deepStrictEqual([s.dry_run, s.leads_seen, s.leads_new, s.leads_changed, s.moved_from_placeholder], [true, 2, 1, 1, 1]);
  assert.deepStrictEqual(g.ads().map((c) => c.kind), ['list', 'clients', 'leads', 'conversations']);
  assert.deepStrictEqual(db.writes, []);
  assert.strictEqual(db.tables.lsa_leads.size, 1);
  // By customer id: every manager has to be walked to find it.
  const t = await make(db, g).syncLeads({ only: '21', dryRun: true });
  assert.deepStrictEqual([t.clients_queried, t.leads_seen], [1, 1]);
});

test('syncLeads: stops at the request budget, and at the 24-hour cap across runs', async () => {
  const db = memoryDb();
  const managers = { 900: Array.from({ length: 60 }, (_, i) => ({ id: String(100 + i) })) };
  const g = google({ managers });
  const sync = make(db, g, { maxOps: 30, maxOpsPerDay: 45 });
  const s = await sync.syncLeads({});
  assert.ok(s.ops_used <= 30, `used ${s.ops_used}`);
  assert.strictEqual(g.ads().length, s.ops_used);
  assert.ok(s.clients_queried >= 15 && s.clients_queried < 30);
  assert.strictEqual(s.selection.deferred, 60 - s.clients_queried);
  const second = await sync.syncLeads({});
  assert.ok(second.ops_cap <= 45 - s.ops_used);
  assert.ok(s.ops_used + second.ops_used <= 45);
  const third = await sync.syncLeads({});
  assert.match(third.error, /budget is spent/);
  assert.strictEqual(g.ads().length, s.ops_used + second.ops_used, 'no request once the day is spent');
});

test('syncLeads: one retry on 5xx, a permission error is recorded and the run goes on, another manager is tried', async () => {
  const db = memoryDb();
  const g = google({
    managers: { 900: [{ id: '11' }, { id: '12' }, { id: '13' }], 901: [{ id: '13' }] },
    leads: { 11: [lead('1001', '11')], 13: [lead('3001', '13')] },
    fail: { 11: [503], 12: [403], 13: [403] },
  });
  const s = await make(db, g).syncLeads({});
  assert.deepStrictEqual([s.leads_new, s.clients_queried, s.error_count], [2, 2, 1]);
  assert.match(s.errors[0], /^account 12: 403 USER_PERMISSION_DENIED/);
  assert.match(db.tables.lsa_api_accounts.get('12').last_error, /USER_PERMISSION_DENIED/);
  assert.deepStrictEqual(g.calls.filter((c) => c.kind === 'leads' && c.cid === '13').map((c) => c.login), ['900', '901']);
  assert.strictEqual(db.tables.lsa_api_accounts.get('13').manager_id, '901');
  assert.strictEqual(db.tables.lsa_imports[0].rejected_count, 1);
});

test('syncLeads: works before supabase_lsa_api_sync.sql is run (no memory, no conversations)', async () => {
  const db = memoryDb({ missing: ['lsa_api_accounts', 'conversations'] });
  const g = google({ managers: { 900: [{ id: '11' }, { id: '12' }] }, leads: { 11: [lead('1001', '11')] } });
  const warned = [];
  const sync = make(db, g, { log: { ...quiet, warn: (m) => warned.push(m) } });
  const s = await sync.syncLeads({});
  assert.deepStrictEqual([s.error, s.leads_new, s.clients_queried], [null, 1, 2]);
  assert.deepStrictEqual(s.sql_applied, { accounts: false, conversations: false, cost: false });
  assert.strictEqual(warned.length, 3);
  assert.ok(!g.calls.some((c) => c.kind === 'conversations' || c.kind === 'cost'));
  assert.ok(!db.writes.some((w) => w.table === 'lsa_api_accounts'));
});

test('syncLeads: a second run is refused while one is going; no key, no run; ranRecently reads the import log', async () => {
  const db = memoryDb();
  const g = google({ managers: { 900: [{ id: '11' }] } });
  const sync = make(db, g);
  const first = sync.syncLeads({ label: 'google-ads-api 14d (daily)' });
  assert.match((await sync.syncLeads({})).error, /already running/);
  await first;
  assert.strictEqual(await sync.ranRecently(), true);
  assert.strictEqual(await make(memoryDb(), g).ranRecently(), false);
  const none = api.createLsaApiSync({ db, saJson: '', log: quiet });
  assert.strictEqual(none.configured, false);
  assert.match((await none.syncLeads({})).error, /GOOGLE_ADS_SA_JSON/);
  assert.strictEqual(api.createLsaApiSync({ db, saJson: '{not json', log: quiet }).configured, false);
});

test('routes: bearer key, 202 with a run id, inline dry run with only=, status', async () => {
  const routes = {};
  const app = { post: (p, h) => { routes[`POST ${p}`] = h; }, get: (p, h) => { routes[`GET ${p}`] = h; } };
  const db = memoryDb();
  const g = google({ managers: { 900: [{ id: '11' }] }, leads: { 11: [lead('1001', '11')] } });
  const sync = api(app, { LSA_IMPORT_KEY: 'k', GOOGLE_ADS_SA_JSON: SA, db, fetchImpl: g.fetchImpl, schedule: false });
  const call = async (name, { key = 'k', query = {} } = {}) => {
    const res = { code: 200, body: null, headersSent: false, status(c) { this.code = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; } };
    await routes[name]({ headers: { authorization: `Bearer ${key}` }, query }, res);
    return res;
  };
  assert.strictEqual((await call('POST /lsa/api-sync', { key: 'wrong' })).code, 401);
  assert.strictEqual((await call('GET /lsa/api-sync/status', { key: 'wrong' })).code, 401);
  const dry = await call('POST /lsa/api-sync', { query: { dry: '1', only: '900', days: '7' } });
  assert.deepStrictEqual([dry.code, dry.body.dry_run, dry.body.leads_new, dry.body.since_days], [200, true, 1, 7]);
  assert.strictEqual(db.tables.lsa_leads.size, 0);
  const started = await call('POST /lsa/api-sync');
  assert.deepStrictEqual([started.code, started.body.status, typeof started.body.run_id], [202, 'started', 'string']);
  assert.strictEqual((await call('POST /lsa/api-sync')).code, 409);
  while (sync.status().running) await new Promise((r) => setTimeout(r, 5));
  const status = await call('GET /lsa/api-sync/status');
  assert.deepStrictEqual([status.body.running, status.body.last.run_id, status.body.last.leads_new], [null, started.body.run_id, 1]);
  assert.strictEqual(db.tables.lsa_leads.size, 1);
});

// ── campaign cost per day (supabase_lsa_api_cost.sql) ──────────────────────

const costResult = (cid, campaignId, day, metrics = {}, campaign = {}) => ({
  campaign: { resourceName: `customers/${cid}/campaigns/${campaignId}`, id: campaignId, name: `Campaign ${campaignId}`, advertisingChannelType: 'LOCAL_SERVICES', status: 'ENABLED', ...campaign },
  customer: { resourceName: `customers/${cid}`, id: cid, currencyCode: 'USD' },
  segments: { date: day },
  metrics,
});

test('apiCostRow: strings to numbers, an absent metric is zero, impression shares stay fractions or null', () => {
  const row = api.apiCostRow(costResult('11', '511', '2026-11-02', {
    costMicros: '1933480000', impressions: '1274', clicks: '152', conversions: 12, topImpressionPercentage: 0.9758, absoluteTopImpressionPercentage: 0.4795,
  }, { name: 'Pay-per-lead-PMax-Example', advertisingChannelType: 'PERFORMANCE_MAX', status: 'PAUSED' }), '11');
  assert.deepStrictEqual(row, {
    account_id: '11', campaign_id: '511', day: '2026-11-02', campaign_name: 'Pay-per-lead-PMax-Example', channel_type: 'PERFORMANCE_MAX', campaign_status: 'PAUSED',
    cost_micros: 1933480000, impressions: 1274, clicks: 152, conversions: 12, top_impression_pct: 0.9758, abs_top_impression_pct: 0.4795, currency_code: 'USD',
  });
  // Google leaves a zero cost out, and sends no share when there were no eligible impressions.
  const zero = api.apiCostRow(costResult('11', '511', '2026-11-03', { impressions: '3' }), '11');
  assert.deepStrictEqual([zero.cost_micros, zero.impressions, zero.clicks, zero.conversions, zero.top_impression_pct, zero.abs_top_impression_pct], [0, 3, 0, 0, null, null]);
  assert.strictEqual(api.apiCostRow(costResult('11', '511', '2026-11-03', { conversions: 2.5, topImpressionPercentage: 0 }), '11').conversions, 2.5);
  assert.strictEqual(api.apiCostRow(costResult('11', '511', '2026-11-03', { topImpressionPercentage: 0 }), '11').top_impression_pct, 0);
  assert.strictEqual(api.apiCostRow(costResult('11', '511', '2026-11-03', { costMicros: 'x' }), '11').cost_micros, 0);
  // The account: the one asked, else the customer block, else the campaign's resource name.
  assert.strictEqual(api.apiCostRow(costResult('11', '511', '2026-11-03'), '11-000').account_id, '11000');
  assert.strictEqual(api.apiCostRow(costResult('11', '511', '2026-11-03')).account_id, '11');
  assert.strictEqual(api.apiCostRow({ campaign: { resourceName: 'customers/12/campaigns/9', id: '9' }, segments: { date: '2026-11-03' } }).account_id, '12');
  const bare = api.apiCostRow({ campaign: { id: '9' }, segments: { date: '2026-11-03' } }, '12');
  assert.deepStrictEqual([bare.campaign_name, bare.channel_type, bare.campaign_status, bare.currency_code, bare.cost_micros], [null, null, null, null, 0]);
  assert.strictEqual(api.apiCostRow(costResult('11', '', '2026-11-03'), '11'), null);
  assert.strictEqual(api.apiCostRow(costResult('11', '511', undefined), '11'), null);
  assert.strictEqual(api.apiCostRow({ campaign: { id: '9' }, segments: { date: '2026-11-03' } }), null);
  assert.strictEqual(api.apiCostRow(null, '11'), null);
});

test('chooseCostAccounts: accounts with leads or recent spend, the one refreshed longest ago first', () => {
  const clients = [client('1'), client('2'), client('3'), client('4'), client('5'), client('6', { status: 'CANCELED' }), client('7', { managers: ['901'] })];
  const leadCounts = new Map([['1', 4], ['2', 0], ['3', 9], ['4', 0], ['5', 1], ['6', 3], ['7', 2]]);
  const pick = (o) => api.chooseCostAccounts({ clients, leadCounts, ...o }).map((c) => c.id);
  assert.deepStrictEqual(pick({}), ['1', '3', '5', '7']);
  assert.deepStrictEqual(pick({ recent: new Set(['4', '6']) }), ['1', '3', '4', '5', '7'], 'spend in the last 60 days counts; a cancelled account never does');
  // Never refreshed first, then oldest refresh; the id only breaks ties.
  const lastCostAt = new Map([['1', daysAgo(1)], ['3', daysAgo(5)], ['7', daysAgo(2)]]);
  assert.deepStrictEqual(pick({ lastCostAt, recent: new Set(['4']) }), ['4', '5', '3', '7', '1']);
  // only: a manager keeps the rule inside its accounts; an account named itself is always taken.
  assert.deepStrictEqual(pick({ only: new Set(['901']) }), ['7']);
  assert.deepStrictEqual(pick({ only: new Set(['900']) }), ['1', '3', '5']);
  assert.deepStrictEqual(pick({ only: new Set(['2']) }), ['2']);
  // Nothing known about leads (no memory table, no lead pass): every enabled account.
  assert.deepStrictEqual(api.chooseCostAccounts({ clients }).map((c) => c.id), ['1', '2', '3', '4', '5', '7']);
});

const week = (cid) => [
  costResult(cid, `5${cid}`, '2026-11-14', { costMicros: '120000000', impressions: '40', clicks: '6', conversions: 2, topImpressionPercentage: 0.9, absoluteTopImpressionPercentage: 0.5 }, { status: 'PAUSED' }),
  costResult(cid, `7${cid}`, '2026-11-14', { costMicros: '80500000', impressions: '25', clicks: '3', conversions: 1 }, { name: 'Pay-per-lead-PMax-Example', advertisingChannelType: 'PERFORMANCE_MAX' }),
  costResult(cid, `7${cid}`, '2026-11-15', { impressions: '9' }, { name: 'Pay-per-lead-PMax-Example', advertisingChannelType: 'PERFORMANCE_MAX' }),
  costResult(cid, `9${cid}`, '2026-11-15', { costMicros: '10000000', impressions: '90', clicks: '1' }, { name: 'Brand search', advertisingChannelType: 'SEARCH' }),
];

test('cost pass: after the leads, one request per account with leads or recent spend; rows, campaign names and the refresh time are stored', async () => {
  const db = memoryDb({ cost: true });
  db.tables.lsa_campaigns.set('912', { campaign_id: '912', campaign_name: null, account_id: 'C912', manager_id: '900' });
  db.tables.lsa_campaign_daily.set('13|713|2026-10-30', { account_id: '13', campaign_id: '713', day: '2026-10-30', cost_micros: 5 });
  db.tables.lsa_campaign_daily.set('14|714|2026-08-01', { account_id: '14', campaign_id: '714', day: '2026-08-01', cost_micros: 5 }); // too long ago
  const g = google({
    managers: { 900: [{ id: '11' }, { id: '12' }, { id: '13' }, { id: '14' }] },
    leads: { 11: [lead('1001', '11', { leadCharged: true })] },
    cost: { 11: week('11'), 12: week('12'), 13: [costResult('13', '713', '2026-11-10', { costMicros: '2000000' })] },
  });
  const sync = make(db, g);
  const s = await sync.syncLeads({});
  assert.strictEqual(s.error, null);
  // The lead passes are what they were: 1 list + 1 manager + 4 accounts + conversations for 11.
  assert.deepStrictEqual(g.ads().slice(0, 7).map((c) => c.kind).sort(), ['clients', 'conversations', 'leads', 'leads', 'leads', 'leads', 'list']);
  assert.deepStrictEqual([s.leads_new, s.clients_queried, s.clients_with_leads], [1, 4, 1]);
  assert.strictEqual(db.tables.lsa_imports[0].filename, 'google-ads-api 14d');
  // Cost: 11 has a lead, 13 spent two weeks ago; 12 (no leads) and 14 (old spend only) are not asked.
  const costCalls = g.ads().slice(7);
  assert.deepStrictEqual(costCalls.map((c) => [c.kind, c.cid, c.login]).sort(), [['cost', '11', '900'], ['cost', '13', '900']]);
  assert.ok(costCalls.every((c) => c.query === `${api.COST_QUERY} WHERE segments.date BETWEEN '2026-11-02' AND '2026-11-16'`));
  assert.strictEqual(s.ops_used, 9);
  assert.deepStrictEqual(
    [s.cost_days, s.cost_from, s.cost_to, s.cost_candidates, s.cost_accounts, s.cost_rows, s.cost_total_micros, s.cost_skipped_budget, s.cost_error],
    [14, '2026-11-02', '2026-11-16', 2, 2, 5, 212500000, 0, null],
  );
  assert.deepStrictEqual(s.cost_by_channel, {
    LOCAL_SERVICES: { rows: 2, cost_micros: 122000000 }, PERFORMANCE_MAX: { rows: 2, cost_micros: 80500000 }, SEARCH: { rows: 1, cost_micros: 10000000 },
  });
  assert.deepStrictEqual(s.sql_applied, { accounts: true, conversations: true, cost: true });
  assert.deepStrictEqual({ ...db.tables.lsa_campaign_daily.get('11|511|2026-11-14'), updated_at: 0 }, {
    account_id: '11', campaign_id: '511', day: '2026-11-14', campaign_name: 'Campaign 511', channel_type: 'LOCAL_SERVICES', campaign_status: 'PAUSED',
    cost_micros: 120000000, impressions: 40, clicks: 6, conversions: 2, top_impression_pct: 0.9, abs_top_impression_pct: 0.5, currency_code: 'USD', updated_at: 0,
  });
  assert.strictEqual(db.tables.lsa_campaign_daily.get('11|711|2026-11-15').cost_micros, 0);
  assert.strictEqual(db.tables.lsa_campaign_daily.size, 2 + 4 + 1);
  // Names: the lead's campaign and the pay-per-lead one get theirs and stay on the real account; a search campaign is not added.
  assert.deepStrictEqual([db.tables.lsa_campaigns.get('511').campaign_name, db.tables.lsa_campaigns.get('511').account_id], ['Campaign 511', '11']);
  assert.deepStrictEqual([db.tables.lsa_campaigns.get('711').campaign_name, db.tables.lsa_campaigns.get('711').account_id], ['Pay-per-lead-PMax-Example', '11']);
  assert.ok(!db.tables.lsa_campaigns.has('911'));
  assert.strictEqual(s.cost_campaigns_named, 3);
  // The memory: the lead pass's own columns are untouched by the refresh time.
  const m11 = db.tables.lsa_api_accounts.get('11');
  assert.deepStrictEqual([m11.lead_count, m11.last_checked_at, m11.last_cost_at], [1, new Date(NOW).toISOString(), new Date(NOW).toISOString()]);
  assert.ok(!('last_cost_at' in db.tables.lsa_api_accounts.get('12')));

  // A re-run overwrites the same days (a late adjustment), it does not add rows.
  g.calls.length = 0;
  const again = await sync.syncLeads({ costDays: 3 });
  assert.deepStrictEqual([again.cost_days, again.cost_from, again.cost_rows], [3, '2026-11-13', 5]);
  assert.strictEqual(db.tables.lsa_campaign_daily.size, 7);
});

test('cost pass: a search campaign already in lsa_campaigns gets its name; cost_only skips the leads and writes no import row; a dry run writes nothing', async () => {
  const db = memoryDb({ cost: true });
  db.tables.lsa_campaigns.set('911', { campaign_id: '911', campaign_name: null, account_id: 'C911', manager_id: '900' });
  db.tables.lsa_api_accounts.set('11', { customer_id: '11', manager_id: '900', lead_count: 2, last_checked_at: daysAgo(1) });
  db.tables.lsa_api_accounts.set('12', { customer_id: '12', manager_id: '900', lead_count: 0, last_checked_at: daysAgo(1) });
  const g = google({ managers: { 900: [{ id: '11' }, { id: '12' }] }, leads: { 11: [lead('1001', '11')] }, cost: { 11: week('11') } });
  const sync = make(db, g);
  const dry = await sync.syncLeads({ costOnly: true, costDays: 60, dryRun: true });
  assert.deepStrictEqual([dry.cost_accounts, dry.cost_rows, dry.cost_total_micros, dry.cost_from], [1, 4, 210500000, '2026-09-17']);
  assert.deepStrictEqual(db.writes, []);
  const s = await sync.syncLeads({ costOnly: true, costDays: 60 });
  assert.deepStrictEqual([s.error, s.cost_only, s.cost_accounts, s.cost_rows, s.leads_seen, s.clients_queried], [null, true, 1, 4, 0, 0]);
  assert.deepStrictEqual(g.ads().map((c) => c.kind), ['list', 'clients', 'cost', 'list', 'clients', 'cost']);
  assert.strictEqual(db.tables.lsa_imports.length, 0);
  assert.strictEqual(db.tables.lsa_leads.size, 0);
  assert.deepStrictEqual([db.tables.lsa_campaigns.get('911').campaign_name, db.tables.lsa_campaigns.get('911').account_id], ['Brand search', '11']);
  assert.deepStrictEqual([db.tables.lsa_api_accounts.get('11').lead_count, db.tables.lsa_api_accounts.get('11').last_cost_at], [2, new Date(NOW).toISOString()]);
  assert.match((await sync.syncLeads({ costOnly: true, costDays: 0 })).error, /nothing to do/);
  // costDays: 0 is a lead sync with no cost request; the window is capped at 400 days.
  const none = await sync.syncLeads({ costDays: 0 });
  assert.deepStrictEqual([none.cost_days, none.cost_accounts, none.leads_new], [0, 0, 1]);
  assert.ok(!g.ads().slice(6).some((c) => c.kind === 'cost'));
  assert.strictEqual((await sync.syncLeads({ costOnly: true, costDays: 9999, dryRun: true })).cost_days, 400);
});

test('cost pass: stops at the request budget, counts what it skipped, and starts with those accounts next time', async () => {
  const ids = Array.from({ length: 30 }, (_, i) => String(101 + i));
  const db = memoryDb({ cost: true });
  for (const id of ids) db.tables.lsa_api_accounts.set(id, { customer_id: id, manager_id: '900', lead_count: 1, last_checked_at: daysAgo(1) });
  const g = google({ managers: { 900: ids.map((id) => ({ id })) }, cost: Object.fromEntries(ids.map((id) => [id, [costResult(id, `5${id}`, '2026-11-15', { costMicros: '1000000' })]])) });
  const costCids = () => g.calls.filter((c) => c.kind === 'cost').map((c) => c.cid);
  // 1 list + 1 manager + 20 accounts = the 22 the first run may spend.
  const first = await make(db, g, { maxOps: 22, maxOpsPerDay: 1000, concurrency: 1 }).syncLeads({ costOnly: true });
  assert.strictEqual(first.error, null);
  assert.deepStrictEqual([first.ops_used, first.cost_candidates, first.cost_accounts, first.cost_skipped_budget, first.cost_rows], [22, 30, 20, 10, 20]);
  assert.deepStrictEqual(costCids(), ids.slice(0, 20));
  g.calls.length = 0;
  const second = await make(db, g, { maxOps: 22, maxOpsPerDay: 1000, concurrency: 1, now: () => new Date(NOW + 3600000) }).syncLeads({ costOnly: true });
  assert.deepStrictEqual(costCids(), [...ids.slice(20), ...ids.slice(0, 10)], 'the accounts never refreshed come first, then the oldest refresh');
  assert.deepStrictEqual([second.cost_accounts, second.cost_skipped_budget], [20, 10]);
  // Several at a time: still never past the cap, and every account is either read or counted as skipped.
  g.calls.length = 0;
  const third = await make(db, g, { maxOps: 22, maxOpsPerDay: 1000, now: () => new Date(NOW + 7200000) }).syncLeads({ costOnly: true });
  assert.deepStrictEqual([third.ops_used, third.cost_accounts + third.cost_skipped_budget, g.ads().length], [22, 30, 22]);
  // With the leads in the same run, cost spends what they leave, on the same counter.
  g.calls.length = 0;
  const both = await make(db, g, { maxOps: 67, maxOpsPerDay: 1000, now: () => new Date(NOW + 10800000) }).syncLeads({});
  assert.deepStrictEqual([both.error, both.clients_queried, both.skipped_budget, both.cost_accounts, both.cost_skipped_budget, both.ops_used], [null, 30, 0, 30, 0, 62]);
  assert.deepStrictEqual(g.ads().slice(32).map((c) => c.kind).filter((k) => k !== 'cost'), [], 'cost comes after every lead request');
});

test('cost pass: without supabase_lsa_api_cost.sql it is skipped with one warning, and the leads load as before', async () => {
  const db = memoryDb(); // no lsa_campaign_daily
  const g = google({ managers: { 900: [{ id: '11' }] }, leads: { 11: [lead('1001', '11')] }, cost: { 11: week('11') } });
  const warned = [];
  const sync = make(db, g, { log: { ...quiet, warn: (m) => warned.push(m) } });
  const s = await sync.syncLeads({});
  const t = await sync.syncLeads({});
  assert.deepStrictEqual([s.error, s.leads_new, t.leads_same, s.cost_accounts, s.cost_rows, s.error_count], [null, 1, 1, 0, 0, 0]);
  assert.deepStrictEqual(s.sql_applied, { accounts: true, conversations: true, cost: false });
  assert.deepStrictEqual(warned.filter((m) => /lsa_campaign_daily/.test(m)).length, 1, 'said once, not on every run');
  assert.match(warned[0], /supabase_lsa_api_cost\.sql/);
  assert.ok(!g.calls.some((c) => c.kind === 'cost'));
  assert.match((await sync.syncLeads({ costOnly: true })).error || 'no error', /no error/);

  // The table without the last_cost_at column: cost still loads, the memory is left alone.
  const db2 = memoryDb({ cost: true, missing: ['last_cost_at'] });
  const s2 = await make(db2, g).syncLeads({});
  assert.deepStrictEqual([s2.cost_accounts, s2.cost_rows, s2.error_count], [1, 4, 0]);
  assert.ok(!('last_cost_at' in db2.tables.lsa_api_accounts.get('11')));
});

test('cost pass: a failing account is recorded and the rest go on; a failing pass never fails the lead sync', async () => {
  const db = memoryDb({ cost: true });
  const g = google({
    managers: { 900: [{ id: '11' }, { id: '12' }] },
    leads: { 11: [lead('1001', '11')], 12: [lead('2001', '12')] },
    cost: { 11: week('11'), 12: week('12') }, costFail: { 11: [400] },
  });
  const s = await make(db, g).syncLeads({});
  assert.deepStrictEqual([s.error, s.leads_new, s.cost_accounts, s.cost_rows, s.error_count], [null, 2, 1, 4, 1]);
  assert.match(s.errors[0], /^account 11 cost: 400 PROHIBITED_METRIC_IN_SELECT_OR_WHERE_CLAUSE/);
  assert.strictEqual(db.tables.lsa_api_accounts.get('11').last_cost_at, undefined, 'not refreshed: first in line next time');
  assert.strictEqual(db.tables.lsa_api_accounts.get('11').last_error, null, 'the lead pass has no complaint about it');

  // The store refuses the cost rows: the account is reported, the leads are in.
  const db2 = memoryDb({ cost: true, missing: ['lsa_campaign_daily upsert'] });
  const g2 = google({ managers: { 900: [{ id: '11' }] }, leads: { 11: [lead('1001', '11')] }, cost: { 11: week('11') } });
  const s2 = await make(db2, g2).syncLeads({});
  assert.deepStrictEqual([s2.error, s2.leads_new, s2.cost_accounts, s2.cost_rows, s2.error_count], [null, 1, 0, 0, 1]);
  assert.match(s2.errors[0], /^account 11 cost store: lsa_campaign_daily upsert 500/);
  assert.strictEqual(db2.tables.lsa_leads.size, 1);
  assert.strictEqual(db2.tables.lsa_imports[0].new_count, 1);

  // The whole pass throws (the store cannot list recent spend): one error, the lead sync is whole.
  const db3 = memoryDb({ cost: true });
  const select = db3.select;
  let probed = false;
  db3.select = async (table, query) => {
    if (table === 'lsa_campaign_daily') { if (probed) throw new Error('lsa_campaign_daily select 500'); probed = true; }
    return select(table, query);
  };
  const s3 = await make(db3, g2).syncLeads({});
  assert.deepStrictEqual([s3.error, s3.leads_new, s3.cost_accounts, s3.error_count], [null, 1, 0, 1]);
  assert.match(s3.cost_error, /lsa_campaign_daily select 500/);

  // Google refuses the query for everyone: the pass gives up after five accounts instead of spending the budget.
  const ids = Array.from({ length: 9 }, (_, i) => String(201 + i));
  const db4 = memoryDb({ cost: true });
  for (const id of ids) db4.tables.lsa_api_accounts.set(id, { customer_id: id, manager_id: '900', lead_count: 1, last_checked_at: daysAgo(1) });
  const g4 = google({ managers: { 900: ids.map((id) => ({ id })) }, costFail: Object.fromEntries(ids.map((id) => [id, [400]])) });
  const s4 = await make(db4, g4, { concurrency: 1 }).syncLeads({ costOnly: true });
  assert.strictEqual(g4.calls.filter((c) => c.kind === 'cost').length, 5);
  assert.match(s4.cost_error, /stopped after 5 failed accounts/);
  assert.strictEqual(s4.error, null);
});

test('routes: cost_days and cost_only', async () => {
  const routes = {};
  const app = { post: (p, h) => { routes[`POST ${p}`] = h; }, get: (p, h) => { routes[`GET ${p}`] = h; } };
  const db = memoryDb({ cost: true });
  db.tables.lsa_api_accounts.set('11', { customer_id: '11', manager_id: '900', lead_count: 2, last_checked_at: daysAgo(1) });
  const g = google({ managers: { 900: [{ id: '11' }] }, leads: { 11: [lead('1001', '11')] }, cost: { 11: week('11') } });
  const sync = api(app, { LSA_IMPORT_KEY: 'k', GOOGLE_ADS_SA_JSON: SA, db, fetchImpl: g.fetchImpl, schedule: false });
  const call = async (name, query = {}) => {
    const res = { code: 200, body: null, headersSent: false, status(c) { this.code = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; } };
    await routes[name]({ headers: { authorization: 'Bearer k' }, query }, res);
    return res;
  };
  // Default: 14 days of cost with the leads. full=1 does not lengthen the cost window.
  let r = await call('POST /lsa/api-sync', { dry: '1', only: '900' });
  assert.deepStrictEqual([r.code, r.body.cost_days, r.body.cost_only, r.body.cost_rows, r.body.leads_new, r.body.sql_applied.cost], [200, 14, false, 4, 1, true]);
  r = await call('POST /lsa/api-sync', { dry: '1', only: '900', full: '1' });
  assert.deepStrictEqual([r.body.full, r.body.since_days, r.body.cost_days], [true, null, 14]);
  r = await call('POST /lsa/api-sync', { dry: '1', only: '900', cost_days: '0' });
  assert.deepStrictEqual([r.body.cost_days, r.body.cost_rows, r.body.leads_new], [0, 0, 1]);
  r = await call('POST /lsa/api-sync', { dry: '1', only: '900', cost_days: '1000', cost_only: '1' });
  assert.deepStrictEqual([r.body.cost_days, r.body.cost_only, r.body.cost_accounts, r.body.cost_total_micros, r.body.cost_skipped_budget, r.body.leads_seen], [400, true, 1, 210500000, 0, 0]);
  assert.strictEqual((await call('POST /lsa/api-sync', { cost_days: '0', cost_only: '1' })).code, 400);
  assert.strictEqual((await call('POST /lsa/api-sync', { cost_days: 'lots' })).code, 400);
  assert.deepStrictEqual(db.writes, []);
  const started = await call('POST /lsa/api-sync', { cost_only: '1', cost_days: '30' });
  assert.strictEqual(started.code, 202);
  while (sync.status().running) await new Promise((res) => setTimeout(res, 5));
  const last = (await call('GET /lsa/api-sync/status')).body.last;
  assert.deepStrictEqual([last.cost_accounts, last.cost_rows, last.cost_total_micros, last.cost_skipped_budget, last.sql_applied.cost], [1, 4, 210500000, 0, true]);
  assert.strictEqual(db.tables.lsa_campaign_daily.size, 4);
});
