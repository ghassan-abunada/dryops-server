// Google "Pay-per-lead leads report" import (lsaImport.js, second format): header
// detection past the title lines, row normalisation, which account a campaign's
// leads are stored under, and the import run against an in-memory store.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const lsa = require('../lsaImport');

const HEAD = lsa.PPL_COLUMNS.join(',');
const SAMPLE = [
  'Pay-per-lead leads report',
  'All time',
  HEAD,
  ' +1 720-454-2873,2026Nov3,Active,Not charged,Phone call, --, --,Water damage cleanup repair,Category,2026Nov3,Water damage,349780140,LocalServicesCampaign:SystemGenerated:00064bfb0d679c9f,23612778212',
  ' +1 207-705-8582 ext. 38614,2026Oct13,New,Charged,Message, --, --,Water damage cleanup repair,Category,2026Oct14,Water damage,345936798,LocalServicesCampaign:SystemGenerated:00064f9706099a72,23761922339',
  ' +1 908-770-5350,2026Nov16,Active,In review,Phone call, --, --,Water damage cleanup repair,Category,2026Nov16,Water damage,352004975,Pay-per-lead-PMax-5 Star Restoration of Philadelphia,24436769692',
  '',
].join('\n');

const rec = (o = {}) => ({
  'Lead details': ' +1 720-454-2873', 'First contact date': '2026Nov3', 'Lead status': 'Active', 'Charge status': 'Charged',
  'Lead type': 'Phone call', 'Customer name': ' --', 'Additional notes': ' --', 'Service type': 'Water damage cleanup repair',
  'Search intent': 'Category', 'Last Updated': '2026Nov3', 'Business category': 'Water damage', 'Lead ID': '349780140',
  'Campaign name': 'Pay-per-lead-PMax-5 Star Restoration of Philadelphia', 'Campaign ID': '24436769692', ...o,
});
const cell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const pplFile = (...recs) => `Pay-per-lead leads report\nAll time\n${HEAD}\n${recs.map((r) => lsa.PPL_COLUMNS.map((c) => cell(String(r[c] ?? ''))).join(',')).join('\n')}\n`;

// The old report, as test/lsaImport.test.js builds it.
const OLD_HEADER = lsa.COLUMNS.map((c) => `"${c}"`).join(',');
const oldLine = (o) => lsa.COLUMNS.map((c) => `"${String(o[c] ?? '').replace(/"/g, '""')}"`).join(',');
const oldCall = (o = {}) => ({
  'Account ID': '1086506690', 'Business Name': 'A1 Restoration', 'Lead Creation Timestamp': '11/3/26 10:08:57',
  'External Lead Id': '8810910048', 'Google Ads Lead Id': '349780140', 'Customer Phone Number': '+17204542873',
  Geo: 'Queen Creek,Arizona,United States', 'Lead Category': 'water_damage', 'Charged Call Timestamp': '11/3/26 10:08:57',
  'Charged Connected Call Duration Seconds': '155', 'Lead Type': 'PHONE_CALL', Charged: 'true', 'Dispute Status': 'NULL', ...o,
});
const oldFile = (...rows) => `${[OLD_HEADER, ...rows.map(oldLine)].join('\n')}\n`;

function memoryDb() {
  const tables = { lsa_leads: new Map(), lsa_campaigns: new Map(), lsa_imports: [], lsa_lead_changes: [], lsa_account_overrides: [] };
  const calls = { update: [], upsert: [] };
  const keyOf = { lsa_leads: 'google_lead_id', lsa_campaigns: 'campaign_id' };
  return {
    tables,
    calls,
    async select(table, query) {
      if (table === 'lsa_account_overrides') return tables.lsa_account_overrides.filter((r) => r.is_excluded).map((r) => ({ account_id: r.account_id }));
      const all = [...tables[table].values()];
      const inList = /(google_lead_id|campaign_id)=in\.\(([^)]*)\)/.exec(query);
      if (inList) { const ids = inList[2].split(','); return all.filter((r) => ids.includes(r[inList[1]])).map((r) => ({ ...r })); }
      const acct = /account_id=eq\.([^&]*)/.exec(query);
      if (acct) return all.filter((r) => r.account_id === decodeURIComponent(acct[1]) && r.business_name).slice(0, 1);
      throw new Error(`memoryDb: unexpected query ${query}`);
    },
    async upsert(table, rows, conflictCol) {
      const keys = JSON.stringify(Object.keys(rows[0]).sort());
      for (const r of rows) assert.strictEqual(JSON.stringify(Object.keys(r).sort()), keys, 'one upsert, one set of keys');
      calls.upsert.push({ table, rows });
      for (const r of rows) tables[table].set(r[conflictCol], { ...tables[table].get(r[conflictCol]), ...r });
    },
    async update(table, query, patch) {
      const ids = /google_lead_id=in\.\(([^)]*)\)/.exec(query)[1].split(',');
      calls.update.push({ table, ids, patch });
      for (const id of ids) tables[table].set(id, { ...tables[table].get(id), ...patch });
    },
    async insert(table, rows) { const out = rows.map((r, i) => ({ id: `${table}-${tables[table].length + i}`, ...r })); tables[table].push(...out); return out; },
  };
}

test('looksLikePpl: the title line or a "Lead details" header; never the detailed report', () => {
  assert.strictEqual(lsa.looksLikePpl(SAMPLE), true);
  assert.strictEqual(lsa.looksLikePpl(`﻿${SAMPLE}`), true);
  assert.strictEqual(lsa.looksLikePpl(`${HEAD}\n`), true);
  assert.strictEqual(lsa.looksLikePpl(`"Pay-per-lead leads report"\r\n"Nov 1, 2026 - Nov 16, 2026"\r\n${HEAD}\r\n`), true);
  assert.strictEqual(lsa.looksLikePpl(oldFile(oldCall())), false);
  assert.strictEqual(lsa.looksLikePpl(''), false);
});

test('parsePplReport: finds the header under the title lines and keeps the range line', () => {
  const { leads, rejected, rowCount, range } = lsa.parsePplReport(SAMPLE);
  assert.strictEqual(rowCount, 3);
  assert.deepStrictEqual(rejected, []);
  assert.strictEqual(range, 'All time');
  assert.deepStrictEqual(leads.map((l) => l.google_lead_id), ['349780140', '345936798', '352004975']);
  const [call, msg, review] = leads;
  assert.strictEqual(call.customer_phone, '+17204542873');
  assert.strictEqual(call.lead_created_local, '2026-11-03 00:00:00');
  assert.strictEqual(call.time_known, false);
  assert.strictEqual(call.lead_type, 'PHONE_CALL');
  assert.strictEqual(call.charged, false);
  assert.strictEqual(call.charge_status, 'Not charged');
  assert.strictEqual(call.customer_name, null);
  assert.strictEqual(call.job_type, 'Water damage cleanup repair');
  assert.strictEqual(call.lead_category, 'Water damage');
  assert.strictEqual(call.campaign_id, '23612778212');
  assert.strictEqual(call.source_format, 'ppl');
  assert.strictEqual(call.raw['Lead status'], 'Active');
  assert.strictEqual(call.raw['Lead details'], ' +1 720-454-2873');
  assert.deepStrictEqual([msg.customer_phone, msg.customer_phone_ext, msg.lead_type, msg.charged], ['+12077058582', '38614', 'MESSAGE', true]);
  assert.deepStrictEqual([review.charged, review.charge_status], [null, 'In review']);
  // A range with a comma, quoted or not, and a BOM
  assert.strictEqual(lsa.parsePplReport(`﻿Pay-per-lead leads report\r\n"Nov 1, 2026 - Nov 16, 2026"\r\n${HEAD}\r\n`).range, 'Nov 1, 2026 - Nov 16, 2026');
  assert.strictEqual(lsa.parsePplReport(`Pay-per-lead leads report\nNov 1, 2026 - Nov 16, 2026\n${HEAD}\n`).range, 'Nov 1, 2026 - Nov 16, 2026');
  assert.strictEqual(lsa.parsePplReport(`${HEAD}\n`).range, null);
});

test('parsePplReport: a renamed or missing column, or no header at all, stops the import', () => {
  assert.throws(() => lsa.parsePplReport(SAMPLE.replace('Charge status', 'Billing status')), /Missing: Charge status\. Not recognised: Billing status\./);
  assert.throws(() => lsa.parsePplReport(SAMPLE.replace(',Campaign ID', '')), /Missing: Campaign ID/);
  assert.throws(() => lsa.parsePplReport('Pay-per-lead leads report\nAll time\n'), /no header row/);
  assert.throws(() => lsa.parsePplReport(''), /empty/);
});

test('pplDate', () => {
  assert.strictEqual(lsa.pplDate('2026Nov3'), '2026-11-03');
  assert.strictEqual(lsa.pplDate(' 2026Oct13'), '2026-10-13');
  assert.strictEqual(lsa.pplDate('2025jan31'), '2025-01-31');
  assert.strictEqual(lsa.pplDate('2024Feb29'), '2024-02-29');
  for (const bad of ['2026Feb30', '2026Nov0', '2026Xyz3', '11/3/26', '2026-11-03', '--', '', null]) assert.strictEqual(lsa.pplDate(bad), null, String(bad));
});

test('pplPhone: with and without an extension, and cells that are not a number', () => {
  assert.deepStrictEqual(lsa.pplPhone(' +1 720-454-2873'), { phone: '+17204542873', ext: null });
  assert.deepStrictEqual(lsa.pplPhone(' +1 207-705-8582 ext. 38614'), { phone: '+12077058582', ext: '38614' });
  for (const none of [' --', '--', '-, View lead details', 'View lead details', '']) assert.deepStrictEqual(lsa.pplPhone(none), { phone: null, ext: null }, none);
});

test('normalizePplRow: each charge status, each lead type, a row with no campaign, rejected rows', () => {
  const of = (o) => lsa.normalizePplRow(rec(o));
  assert.deepStrictEqual(['Charged', 'Not charged', 'Credited', 'In review'].map((s) => of({ 'Charge status': s }).lead.charged), [true, false, false, null]);
  assert.strictEqual(of({ 'Charge status': ' Credited' }).lead.charge_status, 'Credited');
  assert.match(of({ 'Charge status': 'Refunded' }).error, /Charge status is "Refunded"/);
  assert.match(of({ 'Charge status': ' --' }).error, /Charge status/);
  assert.deepStrictEqual(['Phone call', 'Message', 'Booking'].map((t) => of({ 'Lead type': t }).lead.lead_type), ['PHONE_CALL', 'MESSAGE', 'BOOKING']);
  assert.match(of({ 'Lead type': 'Fax' }).error, /Lead type is "Fax"/);
  assert.match(of({ 'First contact date': '11/3/26' }).error, /unreadable date/);
  assert.match(of({ 'Lead ID': ' --' }).error, /no Lead ID/);
  assert.match(of({ 'Lead ID': 'abc' }).error, /no Lead ID/);
  const bare = of({ 'Campaign name': ' --', 'Campaign ID': ' --', 'Lead details': '-, View lead details', 'Customer name': ' Jane Smith' }).lead;
  assert.deepStrictEqual([bare.campaign_id, bare.campaign_name, bare.customer_phone, bare.customer_phone_ext, bare.customer_name], [null, null, null, null, 'Jane Smith']);
  assert.strictEqual(of({}).lead.campaign_name, 'Pay-per-lead-PMax-5 Star Restoration of Philadelphia');
});

test('decidePplAccounts: (a) the recorded account, (b) where its leads already sit, (c) a pseudo-account', () => {
  const lead = (id, campaign, name) => lsa.normalizePplRow(rec({ 'Lead ID': id, 'Campaign ID': campaign || ' --', 'Campaign name': name || ' --' })).lead;
  const leads = [
    lead('1', '100', 'Pay-per-lead-PMax-5 Star Restoration of Philadelphia'),
    lead('2', '200', 'LocalServicesCampaign:SystemGenerated:aaa'), lead('3', '200'), lead('4', '200'), lead('5', '200'),
    lead('6', '300', 'Pay-per-lead-PMax-One Stop Restoration of Dallas'),
    lead('7', '400', 'LocalServicesCampaign:SystemGenerated:bbb'),
    lead('8', '500'),
    lead('9'),
    lead('10', '600', 'LocalServicesCampaign:SystemGenerated:ccc'),
  ];
  const existing = new Map([
    // campaign 200: two leads under 111, one under 222, one under an earlier pseudo-account (no vote)
    ['2', { google_lead_id: '2', account_id: '111', business_name: 'A1 Restoration', geo: 'Mesa,Arizona,United States', row_hash: 'h' }],
    ['3', { google_lead_id: '3', account_id: '111', business_name: 'A1 Restoration', geo: 'Mesa,Arizona,United States', row_hash: 'h' }],
    ['4', { google_lead_id: '4', account_id: '222', business_name: 'Other', geo: null, row_hash: 'h' }],
    ['5', { google_lead_id: '5', account_id: 'C200', business_name: 'x', geo: null, row_hash: 'ppl:h' }],
    // campaign 100 is recorded: its one lead sitting elsewhere does not move it
    ['1', { google_lead_id: '1', account_id: '222', business_name: 'Other', geo: null, row_hash: 'h' }],
    // campaign 600 is recorded under a pseudo-account and a lead now sits under a real one
    ['10', { google_lead_id: '10', account_id: '333', business_name: 'Third', geo: 'Plano,Texas,United States', row_hash: 'h' }],
  ]);
  const campaigns = new Map([
    ['100', { campaign_id: '100', campaign_name: 'old name', account_id: '999' }],
    ['300', { campaign_id: '300', campaign_name: null, account_id: 'C300' }],
    ['600', { campaign_id: '600', campaign_name: null, account_id: 'C600' }],
  ]);
  const out = lsa.decidePplAccounts(leads, existing, campaigns, '5550001111');
  const pick = (k) => { const a = out.get(k); return [a.account_id, a.via, a.tied, a.business_name, a.geo]; };
  assert.deepStrictEqual(pick('100'), ['999', 'campaign', true, null, null]); // name looked up by the importer
  assert.deepStrictEqual(pick('200'), ['111', 'leads', true, 'A1 Restoration', 'Mesa,Arizona,United States']);
  assert.deepStrictEqual(pick('300'), ['C300', 'pseudo', false, 'One Stop Restoration of Dallas', null]);
  assert.deepStrictEqual(pick('400'), ['C400', 'pseudo', false, 'LocalServicesCampaign:SystemGenerated:bbb', null]);
  assert.deepStrictEqual(pick('500'), ['C500', 'pseudo', false, 'Campaign 500', null]);
  assert.deepStrictEqual(pick(''), ['C5550001111', 'pseudo', false, 'Pay-per-lead leads (no campaign)', null]);
  assert.deepStrictEqual(pick('600'), ['333', 'leads', true, 'Third', 'Plano,Texas,United States']);
  assert.strictEqual(out.get('200').campaign_name, 'LocalServicesCampaign:SystemGenerated:aaa');
  assert.strictEqual(lsa.decidePplAccounts([lead('9')], new Map(), new Map(), '').get('').account_id, 'Cunknown');
  // A tie goes to the lower account id
  const tie = new Map([['2', existing.get('4')], ['3', existing.get('2')]]);
  assert.strictEqual(lsa.decidePplAccounts(leads.slice(1, 3), tie, new Map(), '').get('200').account_id, '111');
});

test('importReport: a pay-per-lead file is recognised, stored under campaign pseudo-accounts, then "same"', async () => {
  const db = memoryDb();
  const first = await lsa.importReport(db, { csv: SAMPLE, managerId: '5550001111', filename: 'PPL_leads_5550001111.csv' });
  assert.deepStrictEqual(first, { status: 200, text: '3 rows: 3 new, 0 matched to existing leads, 0 changed, 0 same; 3 campaigns (0 tied to an account)' });
  const row = db.tables.lsa_leads.get('352004975');
  assert.strictEqual(row.account_id, 'C24436769692');
  assert.strictEqual(row.business_name, '5 Star Restoration of Philadelphia');
  assert.strictEqual(row.lead_created_local, '2026-11-16 00:00:00');
  assert.deepStrictEqual([row.time_known, row.source_format, row.charged, row.charge_status], [false, 'ppl', null, 'In review']);
  assert.deepStrictEqual(row.manager_ids, ['5550001111']);
  assert.ok(lsa.isPplHash(row.row_hash));
  assert.ok(!('customer_phone_norm' in row), 'the generated column is never written');
  assert.strictEqual(db.tables.lsa_leads.get('349780140').business_name, 'LocalServicesCampaign:SystemGenerated:00064bfb0d679c9f');
  assert.deepStrictEqual(db.tables.lsa_campaigns.get('24436769692').account_id, 'C24436769692');
  assert.strictEqual(db.tables.lsa_campaigns.get('24436769692').manager_id, '5550001111');
  const imp = db.tables.lsa_imports[0];
  assert.deepStrictEqual([imp.filename, imp.range_from, imp.range_to, imp.row_count, imp.new_count, imp.source], ['PPL_leads_5550001111.csv [All time]', null, null, 3, 3, 'bot']);

  const again = await lsa.importReport(db, { csv: SAMPLE, managerId: '5550001111' });
  assert.strictEqual(again.text, '3 rows: 0 new, 0 matched to existing leads, 0 changed, 3 same; 3 campaigns (0 tied to an account)');
  assert.strictEqual(db.calls.update.length, 0);

  // Google settles the review: the lead changes and the change is logged
  const settled = await lsa.importReport(db, { csv: SAMPLE.replace('In review', 'Charged'), managerId: '5550001111', format: 'ppl' });
  assert.strictEqual(settled.text, '3 rows: 0 new, 0 matched to existing leads, 1 changed, 2 same; 3 campaigns (0 tied to an account)');
  assert.strictEqual(db.tables.lsa_leads.get('352004975').charged, true);
  assert.deepStrictEqual(db.tables.lsa_lead_changes.map((c) => [c.google_lead_id, c.field, c.old_value, c.new_value]), [['352004975', 'charge_status', 'In review', 'Charged']]);
  // … and later credits it
  await lsa.importReport(db, { csv: SAMPLE.replace('In review', 'Credited'), managerId: '5550001111' });
  assert.deepStrictEqual(db.tables.lsa_lead_changes.slice(1).map((c) => [c.field, c.old_value, c.new_value]), [['charge_status', 'Charged', 'Credited'], ['charged', 'true', 'false']]);
});

test('importReport: a lead the detailed report stored is patched, never overwritten, and ties its campaign to the account', async () => {
  const db = memoryDb();
  await lsa.importReport(db, { csv: oldFile(oldCall(), oldCall({ 'Google Ads Lead Id': '349780141', Charged: 'true' })), managerId: '111', from: '2026-11-01', to: '2026-11-30' });
  const before = { ...db.tables.lsa_leads.get('349780140') };
  db.calls.upsert.length = 0;

  const csv = pplFile(
    rec({ 'Charge status': 'Credited' }), // in the detailed report as charged
    rec({ 'Lead ID': '349780141', 'Charge status': 'In review', 'Lead details': ' --' }), // in the detailed report
    rec({ 'Lead ID': '349780999', 'First contact date': '2026Nov10', 'Lead details': ' +1 469-555-0199' }), // new, same campaign
    rec({ 'Lead ID': '349781000', 'Campaign ID': ' --', 'Campaign name': ' --' }), // new, no campaign
    rec({ 'Lead ID': 'x' }),
  );
  const out = await lsa.importReport(db, { csv, managerId: '222' });
  assert.strictEqual(out.text, '5 rows: 2 new, 2 matched to existing leads, 0 changed, 0 same, 1 rejected; 1 campaign (1 tied to an account)');

  const after = db.tables.lsa_leads.get('349780140');
  for (const f of ['account_id', 'business_name', 'geo', 'lead_created_local', 'lead_type', 'customer_phone', 'row_hash', 'raw', 'charged_call_seconds', 'external_lead_id']) {
    assert.deepStrictEqual(after[f], before[f], f);
  }
  assert.deepStrictEqual([after.campaign_id, after.campaign_name, after.charge_status, after.charged], ['24436769692', 'Pay-per-lead-PMax-5 Star Restoration of Philadelphia', 'Credited', false]);
  assert.deepStrictEqual(after.manager_ids, ['111', '222']);
  assert.ok(!('source_format' in after) && !('time_known' in after), 'a detailed lead keeps the column defaults');
  // "In review" leaves charged alone; the missing phone in the new report does not blank the stored one
  const review = db.tables.lsa_leads.get('349780141');
  assert.deepStrictEqual([review.charged, review.charge_status, review.customer_phone], [true, 'In review', '+17204542873']);
  // One PATCH per distinct patch, and only leads writes for the two new leads
  assert.strictEqual(db.calls.update.length, 2);
  assert.ok(db.calls.update.every((u) => u.table === 'lsa_leads' && u.ids.length === 1 && !('account_id' in u.patch) && !('row_hash' in u.patch)));
  assert.deepStrictEqual(db.calls.upsert.filter((u) => u.table === 'lsa_leads').flatMap((u) => u.rows.map((r) => r.google_lead_id)), ['349780999', '349781000']);
  // The credit is logged; first fills of campaign / status are not
  assert.deepStrictEqual(db.tables.lsa_lead_changes.map((c) => [c.google_lead_id, c.field, c.old_value, c.new_value]), [['349780140', 'charged', 'true', 'false']]);

  // The campaign is tied to the detailed account, so its new lead is stored there with that account's name and geo
  assert.strictEqual(db.tables.lsa_campaigns.get('24436769692').account_id, '1086506690');
  const fresh = db.tables.lsa_leads.get('349780999');
  assert.deepStrictEqual([fresh.account_id, fresh.business_name, fresh.geo], ['1086506690', 'A1 Restoration', 'Queen Creek,Arizona,United States']);
  assert.deepStrictEqual([fresh.customer_phone, fresh.lead_created_local, fresh.time_known, fresh.source_format], ['+14695550199', '2026-11-10 00:00:00', false, 'ppl']);
  assert.deepStrictEqual(db.tables.lsa_leads.get('349781000').account_id, 'C222');

  // Same file again: nothing to patch, nothing to write
  db.calls.update.length = 0; db.calls.upsert.length = 0;
  const again = await lsa.importReport(db, { csv, managerId: '222' });
  assert.strictEqual(again.text, '5 rows: 0 new, 2 matched to existing leads, 0 changed, 2 same, 1 rejected; 1 campaign (1 tied to an account)');
  assert.strictEqual(db.calls.update.length, 0);
  assert.deepStrictEqual(db.calls.upsert.filter((u) => u.table === 'lsa_leads'), []);
});

test('importReport: a recorded campaign keeps its real account when no lead in the file is stored yet', async () => {
  const db = memoryDb();
  await lsa.importReport(db, { csv: oldFile(oldCall({ 'Google Ads Lead Id': '1' })), managerId: '111' });
  db.tables.lsa_campaigns.set('24436769692', { campaign_id: '24436769692', campaign_name: 'n', manager_id: '111', account_id: '1086506690' });
  const out = await lsa.importReport(db, { csv: pplFile(rec({ 'Lead ID': '77' })), managerId: '' });
  assert.strictEqual(out.text, '1 rows: 1 new, 0 matched to existing leads, 0 changed, 0 same; 1 campaign (1 tied to an account)');
  const row = db.tables.lsa_leads.get('77');
  assert.deepStrictEqual([row.account_id, row.business_name, row.geo, row.manager_ids], ['1086506690', 'A1 Restoration', 'Queen Creek,Arizona,United States', []]);
  assert.deepStrictEqual([db.tables.lsa_campaigns.get('24436769692').account_id, db.tables.lsa_campaigns.get('24436769692').manager_id], ['1086506690', '111']);
});

test("importReport: a campaign tied to an account marked as another company's is left out, leads and campaign", async () => {
  const db = memoryDb();
  db.tables.lsa_campaigns.set('24436769692', { campaign_id: '24436769692', campaign_name: 'n', manager_id: '111', account_id: '1086506690' });
  db.tables.lsa_account_overrides.push({ account_id: '108-650-6690', is_excluded: true });
  const before = JSON.stringify(db.tables.lsa_campaigns.get('24436769692'));
  const out = await lsa.importReport(db, { csv: pplFile(rec({ 'Lead ID': '77' }), rec({ 'Lead ID': '78' })), managerId: '' });
  assert.strictEqual(out.text, "2 rows: 0 new, 0 matched to existing leads, 0 changed, 0 same, 2 skipped (another company's account); 0 campaigns (0 tied to an account)");
  assert.strictEqual(db.tables.lsa_leads.size, 0);
  assert.strictEqual(JSON.stringify(db.tables.lsa_campaigns.get('24436769692')), before);
  assert.deepStrictEqual(db.calls.upsert, []);
  // A campaign nothing ties to an account yet is stored under its placeholder, as before.
  db.tables.lsa_campaigns.clear();
  const loose = await lsa.importReport(db, { csv: pplFile(rec({ 'Lead ID': '77' })), managerId: '' });
  assert.match(loose.text, /^1 rows: 1 new/);
  assert.strictEqual(db.tables.lsa_leads.get('77').account_id, 'C24436769692');
});

test('importReport: pseudo-account leads move to the real account once the campaign is tied', async () => {
  const db = memoryDb();
  const csv = pplFile(rec({ 'Lead ID': '349780140' }), rec({ 'Lead ID': '500' }));
  await lsa.importReport(db, { csv, managerId: '222' });
  assert.strictEqual(db.tables.lsa_leads.get('500').account_id, 'C24436769692');
  // The detailed report now brings one of them: it takes the lead over
  const detailed = await lsa.importReport(db, { csv: oldFile(oldCall()), managerId: '111' });
  assert.strictEqual(detailed.text, '1 rows: 0 new, 1 changed, 0 same');
  const taken = db.tables.lsa_leads.get('349780140');
  assert.deepStrictEqual([taken.account_id, taken.lead_created_local, taken.time_known, taken.source_format], ['1086506690', '2026-11-03 10:08:57', true, 'detailed']);
  assert.ok(!lsa.isPplHash(taken.row_hash));
  assert.strictEqual(taken.campaign_id, '24436769692');
  // Next pay-per-lead file: that lead is matched (its time is kept), the other follows the campaign to the account
  const out = await lsa.importReport(db, { csv, managerId: '222' });
  assert.strictEqual(out.text, '2 rows: 0 new, 1 matched to existing leads, 1 changed, 0 same; 1 campaign (1 tied to an account)');
  assert.strictEqual(db.tables.lsa_leads.get('349780140').lead_created_local, '2026-11-03 10:08:57');
  assert.deepStrictEqual([db.tables.lsa_leads.get('500').account_id, db.tables.lsa_leads.get('500').business_name], ['1086506690', 'A1 Restoration']);
});

test('importReport: a pay-per-lead file with unknown columns is refused and logged; the old report is untouched by all this', async () => {
  const db = memoryDb();
  const bad = await lsa.importReport(db, { csv: SAMPLE.replace('Lead status', 'Status'), managerId: '222', filename: 'x.csv' });
  assert.strictEqual(bad.status, 422);
  assert.match(bad.text, /Missing: Lead status\. Not recognised: Status\./);
  assert.match(db.tables.lsa_imports[0].error, /Missing: Lead status/);
  assert.strictEqual(db.tables.lsa_leads.size, 0);
  // format=ppl on the old report: refused, not half-read
  const wrong = await lsa.importReport(db, { csv: oldFile(oldCall()), format: 'ppl' });
  assert.strictEqual(wrong.status, 422);
  // The old report, no format: exactly the rows and reply it always produced
  const ok = await lsa.importReport(db, { csv: oldFile(oldCall()), managerId: '111' });
  assert.deepStrictEqual(ok, { status: 200, text: '1 rows: 1 new, 0 changed, 0 same' });
  const [lead] = lsa.parseReport(oldFile(oldCall())).leads;
  assert.deepStrictEqual(db.tables.lsa_leads.get('349780140'), { ...lead, manager_ids: ['111'], changed_at: null });
  assert.deepStrictEqual(Object.keys(lead).sort(), [...lsa.TRACKED, 'google_lead_id', 'raw', 'row_hash'].sort());
});

test('restDb.update: one PATCH with the filter and return=minimal', async () => {
  const seen = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => { seen.push({ url, init }); return { ok: true, status: 204, text: async () => '' }; };
  try {
    await lsa.restDb({ SUPABASE_URL: 'https://db.example', SUPABASE_SERVICE_KEY: 'k' }).update('lsa_leads', 'google_lead_id=in.(1,2)', { charge_status: 'Charged' });
  } finally { global.fetch = realFetch; }
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].url, 'https://db.example/rest/v1/lsa_leads?google_lead_id=in.(1,2)');
  assert.strictEqual(seen[0].init.method, 'PATCH');
  assert.strictEqual(seen[0].init.headers.Prefer, 'return=minimal');
  assert.strictEqual(seen[0].init.body, '{"charge_status":"Charged"}');
});
