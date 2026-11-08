// Runs one Financials sync from the command line, the same code the server
// schedules (netsuiteSync.js), for the first load or a check after a rule change.
//   railway run node scripts/financialsSyncNow.js            # last three months
//   railway run node scripts/financialsSyncNow.js --full     # back to January 2026
const mountNetsuiteSync = require('../netsuiteSync');

async function main() {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, NETSUITE_ENC_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !NETSUITE_ENC_KEY) throw new Error('Missing env: run this through `railway run`');
  const full = process.argv.includes('--full');
  const noop = () => {};
  const { runSync } = mountNetsuiteSync({ post: noop, get: noop }, {
    SUPABASE_URL, SUPABASE_SERVICE_KEY, requireAuth: noop, requireAdmin: noop,
    denverNow: () => new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Denver' })),
  });
  const started = Date.now();
  const result = await runSync({ full, trigger: 'admin' });
  const mins = ((Date.now() - started) / 60000).toFixed(1);
  if (!result.ok) throw new Error(result.error);
  console.log(`Done in ${mins} min: ${result.subsidiaries} subsidiaries, ${result.rows} P&L rows, ${result.cards} card charges, ${result.unmatched} unmatched locations; bank verified ${result.bank.verified}, disagree ${result.bank.mismatch}, no statement ${result.bank.noStatement}`);
}

main().catch((err) => { console.error(`Could not run: ${err.message}`); process.exitCode = 1; });
