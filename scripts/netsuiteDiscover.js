// Read-only: matches DryOps locations to NetSuite subsidiaries and profiles spending
// for the exact matches only. Unmatched subsidiaries' transactions are never queried.
//   railway run node scripts/netsuiteDiscover.js <locations.json> <output.json>
const fs = require('fs');
const { supabaseStore, parseKey, decryptSecrets } = require('../netsuiteIntake');
const { suiteql } = require('../netsuiteClient');
const { matchLocations } = require('../netsuiteMatch');

async function main() {
  const [locationsPath, outPath] = process.argv.slice(2);
  if (!locationsPath || !outPath) throw new Error('Usage: netsuiteDiscover.js <locations.json> <output.json>');
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

  const subsidiaries = await all('SELECT id, name, parent, isinactive, iselimination FROM subsidiary');
  // Inactive locations that never had a job carry no spending worth mapping.
  const locations = JSON.parse(fs.readFileSync(locationsPath, 'utf8')).filter((l) => l.status === 'active' || Number(l.jobs) > 0);
  const matches = matchLocations(locations, subsidiaries);
  const ids = [...new Set(matches.filter((m) => m.status === 'exact').map((m) => Number(m.subsidiary.id)))];
  if (!ids.length) throw new Error('No exact matches');
  const scope = ids.join(',');

  const since = 'ADD_MONTHS(SYSDATE, -12)';
  const out = {
    account_id: row.account_id,
    generated_at: new Date().toISOString(),
    counts: { locations: locations.length, subsidiaries: subsidiaries.length, in_scope: ids.length },
    matches: matches.map((m) => ({
      location: m.location.name, location_status: m.location.status, location_type: m.location.location_type, jobs: m.location.jobs,
      status: m.status,
      subsidiary: m.subsidiary ? { id: m.subsidiary.id, name: m.subsidiary.name } : undefined,
      suggestions: m.suggestions && m.suggestions.map((s) => ({ id: s.id, name: s.name })),
    })),
    by_type: await attempt(`SELECT t.type, COUNT(DISTINCT t.id) AS n, MIN(t.trandate) AS first_date, MAX(t.trandate) AS last_date FROM transaction t JOIN transactionline tl ON tl.transaction = t.id WHERE tl.mainline = 'T' AND tl.subsidiary IN (${scope}) AND t.trandate >= ${since} GROUP BY t.type`),
    by_month: await attempt(`SELECT TO_CHAR(t.trandate, 'YYYY-MM') AS ym, t.type, COUNT(DISTINCT t.id) AS n FROM transaction t JOIN transactionline tl ON tl.transaction = t.id WHERE tl.mainline = 'T' AND tl.subsidiary IN (${scope}) AND t.trandate >= ${since} GROUP BY TO_CHAR(t.trandate, 'YYYY-MM'), t.type`),
    expense_by_type: await attempt(`SELECT t.type, a.accttype, COUNT(*) AS n, SUM(tal.amount) AS amount FROM transactionaccountingline tal JOIN transaction t ON t.id = tal.transaction JOIN account a ON a.id = tal.account JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline WHERE tal.posting = 'T' AND tl.subsidiary IN (${scope}) AND t.trandate >= ${since} AND a.accttype IN ('Expense', 'OthExpense', 'COGS') GROUP BY t.type, a.accttype`),
    future_dated: await attempt(`SELECT t.type, COUNT(DISTINCT t.id) AS n, MAX(t.trandate) AS latest FROM transaction t JOIN transactionline tl ON tl.transaction = t.id WHERE tl.mainline = 'T' AND tl.subsidiary IN (${scope}) AND t.trandate > SYSDATE GROUP BY t.type`),
  };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
  const tally = {}; for (const m of matches) tally[m.status] = (tally[m.status] || 0) + 1;
  console.log(`Locations ${locations.length}, in-scope subsidiaries ${ids.length}`, tally);
  for (const k of ['by_type', 'by_month', 'expense_by_type', 'future_dated']) console.log(`${out[k].error ? 'FAIL' : 'OK  '} ${k}: ${out[k].error || `${out[k].rows.length} rows`}`);
  console.log(`Saved to ${outPath}`);
}

main().catch((err) => { console.error(`Could not run: ${err.message}`); process.exitCode = 1; });
