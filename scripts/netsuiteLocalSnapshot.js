// Read-only: writes a local snapshot of real NetSuite numbers in the shape the
// DryOps Financials tab reads (lib/financials/sample.ts FinDataset), for local
// design work before the production sync exists. The file holds real balances,
// names and merchants: it goes only to the path given and is never committed.
//   railway run node scripts/netsuiteLocalSnapshot.js <discovery.json> <statements.csv> <output.json>
const fs = require('fs');
const { supabaseStore, parseKey, decryptSecrets } = require('../netsuiteIntake');
const { suiteql } = require('../netsuiteClient');
const { mitigationPackoutScope, normalizeName } = require('../netsuiteMatch');

// Owner-accepted matches from 2026-11-04.
const CONFIRMED = {
  'Prime Packouts of Salt Lake': { name: 'Prime Packouts of Salt Lake City' },
  '24 Hour Flood Pros of Salem': { name: '24 Hour Flood Pros of Salem OR' },
  'A1 Restoration - Seattle': { name: 'A1 Restoration of Seattle' },
  'Any Hour Water and Fire of Vegas': { name: 'Any Hour Water and Fire of Las Vegas' },
  'Texas Water and Fire - RGV': { name: 'Texas Water and Fire of Rio Grande Valley' },
  '24 Hour Flood Pros of Flagstaff': { name: '24 Hour Flood Pros of Northern Arizona' },
  'American Packout of Utah': { name: 'American Packout of Salt Lake City' },
  'American Fire and Flood of Long Island': { id: 290 },
};
const PNL = ['Income', 'OthIncome', 'COGS', 'Expense', 'OthExpense'];
const MEMO = /^PEX \| (.*?) \| (.*?) \| (\w+) #(\w+) \| (\S+) \| (.*) \| (-?[\d,.]+) (\w+)$/;

function monthStarts(now, n) {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (n - 1 - i), 1));
    return d.toISOString().slice(0, 10);
  });
}
const nextMonth = (ymd) => { const [y, m] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10); };
const lastDayBefore = (ymd) => new Date(Date.parse(`${ymd}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

function parseStatements(csv) {
  return csv.trim().split(/\r?\n/).slice(1).map((line) => {
    const cells = line.match(/("([^"]*)"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, ''));
    const [m, d, y] = cells[2].split('/').map(Number);
    return { company: cells[0], last4: cells[1].padStart(4, '0'), date: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, balance: Number(cells[3].replace(/[$,]/g, '')) };
  });
}

async function main() {
  const [discoveryPath, statementsPath, outPath] = process.argv.slice(2);
  if (!discoveryPath || !statementsPath || !outPath) throw new Error('Usage: netsuiteLocalSnapshot.js <discovery.json> <statements.csv> <output.json>');
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, NETSUITE_ENC_KEY } = process.env;
  const key = parseKey(NETSUITE_ENC_KEY);
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !key) throw new Error('Missing env: run this through `railway run`');
  const row = await supabaseStore({ url: SUPABASE_URL, serviceKey: SUPABASE_SERVICE_KEY }).get();
  if (!row) throw new Error('No credentials have been submitted');
  const secrets = decryptSecrets(row.secrets, key);
  const all = async (q) => {
    const items = [];
    for (let page = 0; page < 100; page += 1) {
      const res = await suiteql({ accountId: row.account_id, secrets, q, limit: 1000, offset: page * 1000 });
      items.push(...(res.items || []));
      if (!res.hasMore) break;
    }
    return items;
  };

  // Subsidiaries in scope, and the DryOps location ids behind each (same name can mean several rows).
  const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'));
  const subsidiaryList = await all('SELECT id, name FROM subsidiary');
  const scope = mitigationPackoutScope(discovery.matches, subsidiaryList, CONFIRMED);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/locations?select=id,name`, { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } });
  if (!res.ok) throw new Error(`locations read failed (${res.status})`);
  const idsByName = new Map();
  for (const l of await res.json()) idsByName.set(l.name, [...(idsByName.get(l.name) || []), l.id]);
  const subsidiaries = scope.map((s) => ({
    subsidiary_id: Number(s.id), subsidiary_name: s.name,
    vertical: s.locations.some((l) => l.type === 'Mitigation') ? 'Mitigation' : 'Contents',
    location_ids: [...new Set(s.locations.flatMap((l) => idsByName.get(l.name) || []))],
  }));
  const ids = subsidiaries.map((s) => s.subsidiary_id).join(',');
  // Owner 2026-11-07: start at January 2026; earlier months are incomplete.
  const months = monthStarts(new Date(), 13).filter((m) => m >= '2026-01-01');
  const base = `FROM transactionaccountingline tal JOIN transaction t ON t.id = tal.transaction JOIN account a ON a.id = tal.account JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline WHERE tal.posting = 'T' AND tl.subsidiary IN (${ids})`;

  // Monthly P&L by subsidiary and account, signed the way the app reads it.
  const rows = [];
  for (const m of months) {
    const items = await all(`SELECT tl.subsidiary AS sub_id, a.acctnumber, a.accountsearchdisplayname AS account, a.accttype, SUM(tal.amount) AS amount ${base} AND t.trandate >= TO_DATE('${m}', 'YYYY-MM-DD') AND t.trandate < TO_DATE('${nextMonth(m)}', 'YYYY-MM-DD') AND t.trandate <= SYSDATE AND a.accttype IN (${PNL.map((x) => `'${x}'`).join(',')}) GROUP BY tl.subsidiary, a.acctnumber, a.accountsearchdisplayname, a.accttype`);
    for (const i of items) {
      const raw = Number(i.amount) || 0;
      const amount = Math.round((i.accttype === 'Income' || i.accttype === 'OthIncome' ? -raw : raw) * 100) / 100;
      if (amount) rows.push({ month: m, subsidiary_id: Number(i.sub_id), account_number: i.acctnumber == null ? null : String(i.acctnumber), account_name: i.account, account_type: i.accttype, amount });
    }
    console.log(`P&L ${m}: ${items.length} rows`);
  }

  // Bank accounts. A balance shows only when the bank statement anchors it AND the
  // gap between NetSuite and the bank is the same at both statement dates, which
  // proves NetSuite tracks that account (2026-11-05 test). The same last 4 can sit
  // on two companies' accounts, so the statement's company name must match too.
  const statements = parseStatements(fs.readFileSync(statementsPath, 'utf8'));
  const dates = [...new Set(statements.map((x) => x.date))].sort();
  const [prev, last] = [dates[0], dates[dates.length - 1]];
  const banks = await all(`SELECT tl.subsidiary AS sub_id, a.id AS account_id, a.accountsearchdisplayname AS account, a.isinactive, SUM(CASE WHEN t.trandate <= TO_DATE('${prev}', 'YYYY-MM-DD') THEN tal.amount ELSE 0 END) AS thru_prev, SUM(CASE WHEN t.trandate <= TO_DATE('${last}', 'YYYY-MM-DD') THEN tal.amount ELSE 0 END) AS thru_last, SUM(CASE WHEN t.trandate > TO_DATE('${last}', 'YYYY-MM-DD') AND t.trandate <= SYSDATE THEN tal.amount ELSE 0 END) AS since ${base} AND a.accttype = 'Bank' GROUP BY tl.subsidiary, a.id, a.accountsearchdisplayname, a.isinactive`);
  const subName = new Map(subsidiaries.map((x) => [x.subsidiary_id, normalizeName(x.subsidiary_name)]));
  const bank_accounts = [];
  const tally = { verified: 0, mismatch: 0, noStatement: 0 };
  for (const b of banks) {
    if (/airbase|clearing/i.test(b.account) || b.isinactive === 'T') continue;
    const last4 = (/BOA-(\d{4})/.exec(b.account) || [])[1];
    const mine = statements.filter((x) => x.last4 === last4);
    const companies = new Set(mine.map((x) => x.company));
    const own = companies.size > 1 ? mine.filter((x) => normalizeName(x.company) === subName.get(Number(b.sub_id))) : mine;
    const at = (date) => own.find((x) => x.date === date);
    const entry = { subsidiary_id: Number(b.sub_id), account_id: Number(b.account_id), name: b.account, reconciled_balance: null, reconciled_through: null, since: 0, issue: null };
    if (at(last)) {
      const gapLast = Math.round((at(last).balance - Number(b.thru_last)) * 100) / 100;
      const gapPrev = at(prev) ? Math.round((at(prev).balance - Number(b.thru_prev)) * 100) / 100 : null;
      if (gapPrev != null && Math.abs(gapPrev - gapLast) > 1) {
        entry.issue = `NetSuite and the bank moved differently in October, by ${Math.abs(gapPrev - gapLast).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}`;
        tally.mismatch += 1;
      } else {
        entry.reconciled_balance = at(last).balance; entry.reconciled_through = last;
        entry.since = Math.round((Number(b.since) || 0) * 100) / 100;
        tally.verified += 1;
      }
    } else tally.noStatement += 1;
    bank_accounts.push(entry);
  }
  console.log(`Bank accounts: ${bank_accounts.length}; verified ${tally.verified}, statement disagrees ${tally.mismatch}, no statement ${tally.noStatement}`);

  // PEX purchases, refunds and fees, one row per purchase, from the expense side of each journal.
  const card_transactions = [];
  let skipped = 0;
  for (const m of months) {
    const items = await all(`SELECT t.id, t.memo, tl.subsidiary AS sub_id, BUILTIN.DF(tl.entity) AS vendor, a.acctnumber, a.accountsearchdisplayname AS account, tal.amount FROM transaction t JOIN transactionline tl ON tl.transaction = t.id JOIN transactionaccountingline tal ON tal.transaction = t.id AND tal.transactionline = tl.id JOIN account a ON a.id = tal.account WHERE tal.posting = 'T' AND t.type = 'Journal' AND UPPER(t.memo) LIKE 'PEX |%' AND a.accttype NOT IN ('CredCard', 'Bank') AND tl.subsidiary IN (${ids}) AND t.trandate >= TO_DATE('${m}', 'YYYY-MM-DD') AND t.trandate < TO_DATE('${nextMonth(m)}', 'YYYY-MM-DD') AND t.trandate <= SYSDATE`);
    for (const i of items) {
      const hit = MEMO.exec(String(i.memo || ''));
      if (!hit) { skipped += 1; continue; }
      const [, , holder, kind, , at, merchant] = hit;
      if (kind !== 'Purchase' && kind !== 'Fee') { skipped += 1; continue; }
      card_transactions.push({
        id: `${i.id}-${i.acctnumber}`, subsidiary_id: Number(i.sub_id), cardholder: holder.trim(), vendor_card: /^vendor\b/i.test(holder.trim()),
        merchant: (i.vendor || merchant || '').trim(), account_number: i.acctnumber == null ? null : String(i.acctnumber), account_name: i.account,
        at: /^\d{4}-/.test(at) ? `${at.slice(0, 19)}Z` : new Date(`${m}T12:00:00Z`).toISOString(), amount: Math.round((Number(i.amount) || 0) * 100) / 100,
      });
    }
    console.log(`PEX ${m}: ${items.length} lines`);
  }
  console.log(`Card transactions: ${card_transactions.length}, skipped ${skipped} (bill payments, rebates, unparsed)`);

  const out = { generatedAt: new Date().toISOString(), subsidiaries, rows, bank_accounts, card_transactions };
  fs.writeFileSync(outPath, JSON.stringify(out), { mode: 0o600 });
  console.log(`Saved ${subsidiaries.length} locations to ${outPath} (${Math.round(fs.statSync(outPath).size / 1024)} KB)`);
}

main().catch((err) => { console.error(`Could not run: ${err.message}`); process.exitCode = 1; });
