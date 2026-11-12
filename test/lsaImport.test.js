// Google LSA lead import (lsaImport.js): CSV reading, row normalisation, the
// new / changed / same diff, and the import run against an in-memory store.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const lsa = require('../lsaImport');

const HEADER = lsa.COLUMNS.map((c) => `"${c}"`).join(',');
const line = (o) => lsa.COLUMNS.map((c) => `"${String(o[c] ?? '').replace(/"/g, '""')}"`).join(',');
const call = {
  'Account ID': '1086506690', 'Business Name': 'A1 Restoration', 'Lead Creation Timestamp': '10/31/26 10:08:57',
  'External Lead Id': '8810910048', 'Google Ads Lead Id': '349229152', 'Customer Phone Number': '+14695550101',
  Geo: 'Queen Creek,Arizona,United States', 'Lead Category': 'water_damage', 'Charged Call Timestamp': '10/31/26 10:08:57',
  'Charged Connected Call Duration Seconds': '155', 'Lead Type': 'PHONE_CALL', Charged: 'true', 'Dispute Status': 'NULL',
};
const message = {
  ...call, 'Google Ads Lead Id': '348771652', 'External Lead Id': '3884992548', 'Lead Creation Timestamp': '10/28/26 12:43:43',
  'Customer Name': 'Jane "JJ" Smith, Jr.', 'Customer Phone Number': '+14695550102 ext. 94523', 'Job Type': 'water_damage_remodeling',
  'Charged Call Timestamp': '', 'Charged Connected Call Duration Seconds': '', 'Lead Type': 'MESSAGE',
};
const file = (...rows) => `${[HEADER, ...rows.map(line)].join('\n')}\n`;

function memoryDb() {
  const tables = { lsa_leads: new Map(), lsa_imports: [], lsa_lead_changes: [] };
  return {
    tables,
    async select(table, query) {
      const ids = /google_lead_id=in\.\(([^)]*)\)/.exec(query)[1].split(',');
      return ids.map((id) => tables[table].get(id)).filter(Boolean).map((r) => ({
        ...r,
        // PostgREST returns timestamps with a T
        lead_created_local: r.lead_created_local && r.lead_created_local.replace(' ', 'T'),
        charged_call_local: r.charged_call_local && r.charged_call_local.replace(' ', 'T'),
      }));
    },
    async upsert(table, rows) { for (const r of rows) tables[table].set(r.google_lead_id, { ...tables[table].get(r.google_lead_id), ...r }); },
    async insert(table, rows) { const out = rows.map((r, i) => ({ id: `${table}-${tables[table].length + i}`, ...r })); tables[table].push(...out); return out; },
  };
}

test('parseCsv: quotes, doubled quotes, commas and line breaks inside cells, BOM, CRLF', () => {
  assert.deepStrictEqual(lsa.parseCsv('﻿"a","b"\r\n"1,5","say ""hi""\nthere"\r\n'), [['a', 'b'], ['1,5', 'say "hi"\nthere']]);
  assert.deepStrictEqual(lsa.parseCsv('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
  assert.throws(() => lsa.parseCsv('"a","b\n1'), /quoted cell/);
});

test('localTimestamp and splitPhone', () => {
  assert.strictEqual(lsa.localTimestamp('10/31/26 10:08:57'), '2026-10-31 10:08:57');
  assert.strictEqual(lsa.localTimestamp('1/5/26 9:03:07'), '2026-01-05 09:03:07');
  assert.strictEqual(lsa.localTimestamp(''), null);
  assert.strictEqual(lsa.localTimestamp('NULL'), null);
  assert.strictEqual(lsa.localTimestamp('Oct 31'), undefined);
  assert.deepStrictEqual(lsa.splitPhone('+14026750000 ext. 94523'), { phone: '+14026750000', ext: '94523' });
  assert.deepStrictEqual(lsa.splitPhone('+14026750000'), { phone: '+14026750000', ext: null });
  assert.deepStrictEqual(lsa.splitPhone(''), { phone: null, ext: null });
});

test('parseReport: a call and a message become leads', () => {
  const { leads, rejected, rowCount } = lsa.parseReport(file(call, message));
  assert.strictEqual(rowCount, 2);
  assert.deepStrictEqual(rejected, []);
  const [c, m] = leads;
  assert.strictEqual(c.google_lead_id, '349229152');
  assert.strictEqual(c.charged, true);
  assert.strictEqual(c.charged_call_seconds, 155);
  assert.strictEqual(c.dispute_status, null, 'Google prints NULL for no dispute');
  assert.strictEqual(c.lead_created_local, '2026-10-31 10:08:57');
  assert.strictEqual(m.customer_name, 'Jane "JJ" Smith, Jr.');
  assert.strictEqual(m.customer_phone, '+14695550102');
  assert.strictEqual(m.customer_phone_ext, '94523');
  assert.strictEqual(m.charged_call_local, null);
  assert.strictEqual(m.raw['Customer Phone Number'], '+14695550102 ext. 94523', 'the original row is kept');
});

test('parseReport: long calls come with a thousands separator', () => {
  const { leads, rejected } = lsa.parseReport(file({ ...call, 'Charged Connected Call Duration Seconds': '1,234' }));
  assert.deepStrictEqual(rejected, []);
  assert.strictEqual(leads[0].charged_call_seconds, 1234);
  assert.deepStrictEqual(lsa.parseReport(file({ ...call, 'Charged Connected Call Duration Seconds': '2m' })).rejected,
    ['row 2: lead 349229152: call duration is "2m"']);
});

test('parseReport: a renamed or missing column stops the import', () => {
  assert.throws(() => lsa.parseReport(file(call).replace('"Charged"', '"Was Charged"')), (e) => e instanceof lsa.ImportError
    && /Missing: Charged\./.test(e.message) && /Not recognised: Was Charged\./.test(e.message));
  assert.throws(() => lsa.parseReport('Customer,Job type,Lead type\n'), /Missing: Account ID/, 'the per-location inbox export is refused');
  assert.throws(() => lsa.parseReport(''), /empty/);
});

test('parseReport: bad rows are rejected one by one, a header-only file is fine', () => {
  const { leads, rejected } = lsa.parseReport(file(call, { ...message, 'Google Ads Lead Id': '' }, { ...message, Charged: 'maybe' },
    { ...message, 'Lead Creation Timestamp': 'yesterday' }));
  assert.strictEqual(leads.length, 1);
  assert.deepStrictEqual(rejected, ['row 3: no Google Ads Lead Id', 'row 4: lead 348771652: Charged is "maybe"', 'row 5: lead 348771652: unreadable timestamp']);
  assert.deepStrictEqual(lsa.parseReport(`${HEADER}\n`), { leads: [], rejected: [], rowCount: 0 });
});

test('importReport: new, then same, then Google credits a lead', async () => {
  const db = memoryDb();
  const first = await lsa.importReport(db, { csv: file(call, message), managerId: '3095326903', from: '2026-10-01', to: '2026-10-31' });
  assert.deepStrictEqual(first, { status: 200, text: '2 rows: 2 new, 0 changed, 0 same' });
  assert.deepStrictEqual(db.tables.lsa_leads.get('349229152').manager_ids, ['3095326903']);

  const again = await lsa.importReport(db, { csv: file(call, message), managerId: '3095326903' });
  assert.strictEqual(again.text, '2 rows: 0 new, 0 changed, 2 same');
  assert.strictEqual(db.tables.lsa_lead_changes.length, 0, 'stored T-format timestamps are not a change');

  const credited = await lsa.importReport(db, { csv: file({ ...call, Charged: 'false', 'Dispute Status': 'APPROVED' }, message), managerId: '3095326903' },
    () => new Date('2026-11-12T20:00:00Z'));
  assert.strictEqual(credited.text, '2 rows: 0 new, 1 changed, 1 same');
  assert.deepStrictEqual(db.tables.lsa_lead_changes.map((c) => [c.google_lead_id, c.field, c.old_value, c.new_value]),
    [['349229152', 'charged', 'true', 'false'], ['349229152', 'dispute_status', null, 'APPROVED']]);
  assert.strictEqual(db.tables.lsa_leads.get('349229152').charged, false);
  assert.strictEqual(db.tables.lsa_leads.get('349229152').changed_at, '2026-11-12T20:00:00.000Z');
  assert.ok(db.tables.lsa_lead_changes[0].import_id, 'changes point at the import that brought them');
  assert.strictEqual(db.tables.lsa_imports.length, 3);
});

test('importReport: the same lead under a second manager is "same" but records the manager', async () => {
  const db = memoryDb();
  await lsa.importReport(db, { csv: file(call), managerId: '3095326903' });
  const other = await lsa.importReport(db, { csv: file(call), managerId: '4612399237' });
  assert.strictEqual(other.text, '1 rows: 0 new, 0 changed, 1 same');
  assert.deepStrictEqual(db.tables.lsa_leads.get('349229152').manager_ids, ['3095326903', '4612399237']);
});

test('importReport: a refused file is logged with its reason and writes no leads', async () => {
  const db = memoryDb();
  const out = await lsa.importReport(db, { csv: 'Customer,Job type\nx,y\n', managerId: '3095326903' });
  assert.strictEqual(out.status, 422);
  assert.match(out.text, /Unexpected columns/);
  assert.strictEqual(db.tables.lsa_leads.size, 0);
  assert.match(db.tables.lsa_imports[0].error, /Unexpected columns/);
});

test('importReport: rejected rows are counted in the reply', async () => {
  const db = memoryDb();
  const out = await lsa.importReport(db, { csv: file(call, { ...message, 'Google Ads Lead Id': 'abc' }), managerId: '1' });
  assert.strictEqual(out.text, '2 rows: 1 new, 0 changed, 0 same, 1 rejected');
  assert.strictEqual(db.tables.lsa_imports[0].rejected_count, 1);
});

test('keyOk: exact match only, never when the key is unset', () => {
  assert.strictEqual(lsa.keyOk('secret', 'secret'), true);
  assert.strictEqual(lsa.keyOk('secreT', 'secret'), false);
  assert.strictEqual(lsa.keyOk('', ''), false);
  assert.strictEqual(lsa.keyOk(undefined, 'secret'), false);
});
