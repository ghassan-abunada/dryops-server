// Read-only: can Gurr spending be split per location? Lists bank accounts in the
// in-scope Gurr subsidiaries, plus expense by bank, NetSuite location and class.
//   railway run node scripts/netsuiteGurrBanks.js <discovery.json> <output.json>
const fs = require('fs');
const { supabaseStore, parseKey, decryptSecrets } = require('../netsuiteIntake');
const { suiteql } = require('../netsuiteClient');
const { gurrScope } = require('../netsuiteMatch');

const ROLLUPS = ['Oregon', 'Texas', 'Oklahoma', 'California', 'Hawaii'].map((s) => `Gurr Brothers Construction of ${s}`)
  .concat('Gurr Brothers Construction of Michigan-Roofing');
const EXPENSE = "a.accttype IN ('Expense', 'OthExpense', 'COGS')";
const SINCE = 'ADD_MONTHS(SYSDATE, -12)';

async function main() {
  const [discoveryPath, outPath] = process.argv.slice(2);
  if (!discoveryPath || !outPath) throw new Error('Usage: netsuiteGurrBanks.js <discovery.json> <output.json>');
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
  const matchedIds = discovery.matches.filter((m) => m.status === 'exact').map((m) => m.subsidiary.id);
  const scope = gurrScope(await all("SELECT id, name FROM subsidiary WHERE name LIKE 'Gurr Brothers%'"), matchedIds, ROLLUPS);
  if (!scope.length) throw new Error('No Gurr subsidiaries in scope');
  const ids = scope.map((s) => Number(s.id)).join(',');

  const base = `FROM transactionaccountingline tal JOIN transaction t ON t.id = tal.transaction JOIN account a ON a.id = tal.account JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline WHERE tal.posting = 'T' AND tl.subsidiary IN (${ids}) AND t.trandate >= ${SINCE}`;
  const out = {
    generated_at: new Date().toISOString(),
    subsidiaries: scope.map((s) => ({ id: s.id, name: s.name })),
    expense_by_type: await attempt(`SELECT tl.subsidiary AS sub_id, t.type, SUM(tal.amount) AS amount, COUNT(DISTINCT t.id) AS n ${base} AND ${EXPENSE} GROUP BY tl.subsidiary, t.type`),
    bank_accounts: await attempt(`SELECT tl.subsidiary AS sub_id, a.id AS account_id, a.acctnumber, a.accountsearchdisplayname AS account, t.type, COUNT(DISTINCT t.id) AS n ${base} AND a.accttype = 'Bank' GROUP BY tl.subsidiary, a.id, a.acctnumber, a.accountsearchdisplayname, t.type`),
    check_expense_by_bank: await attempt(`SELECT tl.subsidiary AS sub_id, bank.id AS bank_id, bank.accountsearchdisplayname AS bank, SUM(tal.amount) AS amount, COUNT(DISTINCT t.id) AS n ${base} AND ${EXPENSE} AND t.type = 'Check' GROUP BY tl.subsidiary, bank.id, bank.accountsearchdisplayname`.replace('JOIN transactionline tl', "JOIN transactionline bl ON bl.transaction = t.id AND bl.mainline = 'T' JOIN account bank ON bank.id = bl.expenseaccount JOIN transactionline tl")),
    expense_by_location: await attempt(`SELECT tl.subsidiary AS sub_id, t.type, BUILTIN.DF(tl.location) AS location, SUM(tal.amount) AS amount, COUNT(DISTINCT t.id) AS n ${base} AND ${EXPENSE} GROUP BY tl.subsidiary, t.type, BUILTIN.DF(tl.location)`),
    check_bank_vs_location: await attempt(`SELECT tl.subsidiary AS sub_id, bank.accountsearchdisplayname AS bank, BUILTIN.DF(tl.location) AS location, SUM(tal.amount) AS amount, COUNT(DISTINCT t.id) AS n ${base} AND ${EXPENSE} AND t.type = 'Check' GROUP BY tl.subsidiary, bank.accountsearchdisplayname, BUILTIN.DF(tl.location)`.replace('JOIN transactionline tl', "JOIN transactionline bl ON bl.transaction = t.id AND bl.mainline = 'T' JOIN account bank ON bank.id = bl.expenseaccount JOIN transactionline tl")),
    expense_by_class: await attempt(`SELECT tl.subsidiary AS sub_id, t.type, BUILTIN.DF(tl.class) AS class, SUM(tal.amount) AS amount, COUNT(DISTINCT t.id) AS n ${base} AND ${EXPENSE} GROUP BY tl.subsidiary, t.type, BUILTIN.DF(tl.class)`),
  };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
  console.log(`Gurr subsidiaries in scope: ${scope.length}`);
  for (const k of ['expense_by_type', 'bank_accounts', 'check_expense_by_bank', 'expense_by_location', 'check_bank_vs_location', 'expense_by_class']) console.log(`${out[k].error ? 'FAIL' : 'OK  '} ${k}: ${out[k].error || `${out[k].rows.length} rows`}`);
  console.log(`Saved to ${outPath}`);
}

main().catch((err) => { console.error(`Could not run: ${err.message}`); process.exitCode = 1; });
