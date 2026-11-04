// Read-only: profiles expense for subsidiaries tied to Mitigation and Contents
// locations (Gurr and Rebuild are parked). Nothing outside that scope is queried.
//   railway run node scripts/netsuiteMitPackout.js <discovery.json> <output.json>
const fs = require('fs');
const { supabaseStore, parseKey, decryptSecrets } = require('../netsuiteIntake');
const { suiteql } = require('../netsuiteClient');
const { mitigationPackoutScope } = require('../netsuiteMatch');

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

async function main() {
  const [discoveryPath, outPath] = process.argv.slice(2);
  if (!discoveryPath || !outPath) throw new Error('Usage: netsuiteMitPackout.js <discovery.json> <output.json>');
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, NETSUITE_ENC_KEY } = process.env;
  const key = parseKey(NETSUITE_ENC_KEY);
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !key) throw new Error('Missing env: run this through `railway run`');
  const row = await supabaseStore({ url: SUPABASE_URL, serviceKey: SUPABASE_SERVICE_KEY }).get();
  if (!row) throw new Error('No credentials have been submitted');
  const secrets = decryptSecrets(row.secrets, key);

  const all = async (q) => {
    const items = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await suiteql({ accountId: row.account_id, secrets, q, limit: 1000, offset });
      items.push(...(page.items || []));
      if (!page.hasMore) return items;
    }
  };
  const attempt = async (q) => { try { return { rows: await all(q) }; } catch (err) { return { error: err.message }; } };

  const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'));
  const subsidiaries = await all('SELECT id, name FROM subsidiary');
  const scope = mitigationPackoutScope(discovery.matches, subsidiaries, CONFIRMED);
  if (!scope.length) throw new Error('No subsidiaries in scope');
  const ids = scope.map((s) => Number(s.id)).join(',');

  const base = `FROM transactionaccountingline tal JOIN transaction t ON t.id = tal.transaction JOIN account a ON a.id = tal.account JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline WHERE tal.posting = 'T' AND tl.subsidiary IN (${ids}) AND t.trandate >= ADD_MONTHS(SYSDATE, -12) AND a.accttype IN ('Expense', 'OthExpense', 'COGS')`;
  const out = {
    generated_at: new Date().toISOString(),
    scope,
    by_sub_type: await attempt(`SELECT tl.subsidiary AS sub_id, t.type, SUM(tal.amount) AS amount, COUNT(DISTINCT t.id) AS n ${base} GROUP BY tl.subsidiary, t.type`),
    by_sub_location: await attempt(`SELECT tl.subsidiary AS sub_id, BUILTIN.DF(tl.location) AS location, SUM(tal.amount) AS amount, COUNT(DISTINCT t.id) AS n ${base} GROUP BY tl.subsidiary, BUILTIN.DF(tl.location)`),
    by_month_type: await attempt(`SELECT TO_CHAR(t.trandate, 'YYYY-MM') AS ym, t.type, a.accttype, SUM(tal.amount) AS amount, COUNT(DISTINCT t.id) AS n ${base} GROUP BY TO_CHAR(t.trandate, 'YYYY-MM'), t.type, a.accttype`),
    by_account: await attempt(`SELECT a.accttype, a.accountsearchdisplayname AS account, t.type, SUM(tal.amount) AS amount, COUNT(DISTINCT t.id) AS n ${base} GROUP BY a.accttype, a.accountsearchdisplayname, t.type`),
    class_coverage: await attempt(`SELECT t.type, CASE WHEN tl.class IS NULL THEN 'none' ELSE 'set' END AS class_state, SUM(tal.amount) AS amount ${base} GROUP BY t.type, CASE WHEN tl.class IS NULL THEN 'none' ELSE 'set' END`),
  };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
  console.log(`Subsidiaries in scope: ${scope.length}`);
  for (const k of ['by_sub_type', 'by_sub_location', 'by_month_type', 'by_account', 'class_coverage']) console.log(`${out[k].error ? 'FAIL' : 'OK  '} ${k}: ${out[k].error || `${out[k].rows.length} rows`}`);
  console.log(`Saved to ${outPath}`);
}

main().catch((err) => { console.error(`Could not run: ${err.message}`); process.exitCode = 1; });
