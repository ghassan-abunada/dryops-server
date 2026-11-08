// Loads accounting's bank statement ending balances into bank_statement_balances,
// which the Financials sync uses to verify every bank account. Run by the owner each
// month-end; the balances never enter git.
//   railway run node scripts/loadStatements.js <statements.csv>
// CSV columns: Company, Account last 4, Statement date (M/D/YYYY), Ending balance ("$1,234.56").
const fs = require('fs');

function parseStatements(csv) {
  return csv.trim().split(/\r?\n/).slice(1).filter((line) => line.trim()).map((line, i) => {
    const cells = line.match(/("([^"]*)"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').trim());
    const [m, d, y] = String(cells[2] || '').split('/').map(Number);
    const row = {
      company: cells[0], last4: String(cells[1] || '').replace(/\D/g, '').padStart(4, '0'),
      statement_date: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      balance: Number(String(cells[3] || '').replace(/[$,]/g, '').replace(/^\((.*)\)$/, '-$1')),
    };
    if (!row.company || !/^\d{4}$/.test(row.last4) || !y || !m || !d || Number.isNaN(row.balance)) throw new Error(`Line ${i + 2} is not company, last 4, date, balance`);
    return row;
  });
}

async function main() {
  const [csvPath] = process.argv.slice(2);
  if (!csvPath) throw new Error('Usage: loadStatements.js <statements.csv>');
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error('Missing env: run this through `railway run`');
  const rows = parseStatements(fs.readFileSync(csvPath, 'utf8'));
  // The same account twice on one date keeps the last line.
  const uniq = [...new Map(rows.map((r) => [`${r.company}|${r.last4}|${r.statement_date}`, r])).values()];
  const r = await fetch(`${SUPABASE_URL}/rest/v1/bank_statement_balances?on_conflict=company,last4,statement_date`, {
    method: 'POST',
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(uniq.map((x) => ({ ...x, loaded_at: new Date().toISOString() }))),
  });
  if (!r.ok) throw new Error(`Load failed (${r.status}): ${(await r.text()).slice(0, 300)}`);
  const dates = [...new Set(uniq.map((x) => x.statement_date))].sort();
  console.log(`Loaded ${uniq.length} statement balances for ${new Set(uniq.map((x) => `${x.company}|${x.last4}`)).size} accounts; dates ${dates.join(', ')}`);
  console.log('The next sync picks them up (hourly, or POST /admin/financials/sync).');
}

if (require.main === module) main().catch((err) => { console.error(`Could not run: ${err.message}`); process.exitCode = 1; });
module.exports = { parseStatements };
