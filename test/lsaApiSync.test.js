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

function memoryDb({ missing = [] } = {}) {
  const tables = { lsa_leads: new Map(), lsa_campaigns: new Map(), lsa_api_accounts: new Map(), lsa_imports: [], lsa_lead_changes: [] };
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
      let rows = rowsOf(table);
      for (const [k, v] of q) {
        if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
        if (v.startsWith('in.(')) { const ids = v.slice(4, -1).split(','); rows = rows.filter((r) => ids.includes(r[k])); }
        else if (v.startsWith('eq.')) rows = rows.filter((r) => String(r[k]) === v.slice(3));
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
      for (const r of rows) tables[table].set(r[conflictCol], { ...tables[table].get(r[conflictCol]), ...r });
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
function google({ managers, leads = {}, conversations = {}, fail = {} }) {
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
  assert.deepStrictEqual(s.sql_applied, { accounts: false, conversations: false });
  assert.strictEqual(warned.length, 2);
  assert.ok(!g.calls.some((c) => c.kind === 'conversations'));
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
