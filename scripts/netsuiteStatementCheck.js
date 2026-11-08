// Read-only: compares bank statement ending balances to NetSuite on the same dates.
// A constant gap across month-ends means a starting balance can correct the account.
//   railway run node scripts/netsuiteStatementCheck.js <statements.csv> <output.json>
const fs = require('fs');
const { supabaseStore, parseKey, decryptSecrets } = require('../netsuiteIntake');
const { suiteql } = require('../netsuiteClient');

// Handles the quoted "$1,234.56" amounts in the accounting team's export.
function parseStatements(csv) {
  return csv.trim().split(/\r?\n/).slice(1).map((line) => {
    const cells = line.match(/("([^"]*)"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, ''));
    const [m, d, y] = cells[2].split('/').map(Number);
    return {
      name: cells[0],
      last4: cells[1].padStart(4, '0'),
      date: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      balance: Number(cells[3].replace(/[$,]/g, '')),
    };
  });
}

const money = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  const [csvPath, outPath] = process.argv.slice(2);
  if (!csvPath || !outPath) throw new Error('Usage: netsuiteStatementCheck.js <statements.csv> <output.json>');
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, NETSUITE_ENC_KEY } = process.env;
  const key = parseKey(NETSUITE_ENC_KEY);
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !key) throw new Error('Missing env: run this through `railway run`');
  const row = await supabaseStore({ url: SUPABASE_URL, serviceKey: SUPABASE_SERVICE_KEY }).get();
  if (!row) throw new Error('No credentials have been submitted');
  const secrets = decryptSecrets(row.secrets, key);
  const query = async (q) => (await suiteql({ accountId: row.account_id, secrets, q, limit: 1000 })).items || [];

  const statements = parseStatements(fs.readFileSync(csvPath, 'utf8'));
  const results = [];
  for (const last4 of [...new Set(statements.map((s) => s.last4))]) {
    if (!/^\d{4}$/.test(last4)) throw new Error('Bad account digits in the file');
    const rows = statements.filter((s) => s.last4 === last4).sort((a, b) => a.date.localeCompare(b.date));
    // The same last 4 can appear on two companies' accounts, so every candidate is reported.
    const accounts = await query(`SELECT id, accountsearchdisplayname AS name FROM account WHERE accttype = 'Bank' AND accountsearchdisplayname LIKE '%BOA-${last4}%'`);
    for (const account of accounts) {
      const points = [];
      for (const s of rows) {
        const [{ amount } = {}] = await query(`SELECT SUM(tal.amount) AS amount FROM transactionaccountingline tal JOIN transaction t ON t.id = tal.transaction WHERE tal.posting = 'T' AND tal.account = ${Number(account.id)} AND t.trandate <= TO_DATE('${s.date}', 'YYYY-MM-DD')`);
        const netsuite = Number(amount) || 0;
        points.push({ date: s.date, statement: s.balance, netsuite, gap: Math.round((s.balance - netsuite) * 100) / 100 });
      }
      const last = rows[rows.length - 1].date;
      const after = await query(`SELECT t.type, SUM(tal.amount) AS amount, COUNT(DISTINCT t.id) AS n FROM transactionaccountingline tal JOIN transaction t ON t.id = tal.transaction WHERE tal.posting = 'T' AND tal.account = ${Number(account.id)} AND t.trandate > TO_DATE('${last}', 'YYYY-MM-DD') AND t.trandate <= SYSDATE GROUP BY t.type`);
      results.push({ name: rows[0].name, account: account.name, points, after_last_statement: after });
    }
  }
  fs.writeFileSync(outPath, JSON.stringify(results, null, 1), { mode: 0o600 });
  for (const r of results) {
    console.log(`\n${r.name} | ${r.account}`);
    for (const p of r.points) console.log(`  ${p.date}  statement ${money(p.statement)}  NetSuite ${money(p.netsuite)}  gap ${money(p.gap)}`);
    const moved = r.after_last_statement.reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
    console.log(`  after last statement: ${money(moved)} across ${r.after_last_statement.reduce((sum, a) => sum + Number(a.n), 0)} entries`);
  }
}

main().catch((err) => { console.error(`Could not run: ${err.message}`); process.exitCode = 1; });
