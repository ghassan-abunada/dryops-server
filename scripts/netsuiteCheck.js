// Proves the stored NetSuite credentials work, read-only. Prints counts and
// subsidiary names, never a secret. Needs production env, so run through Railway:
//   railway run node scripts/netsuiteCheck.js
const { supabaseStore, parseKey, decryptSecrets } = require('../netsuiteIntake');
const { suiteql } = require('../netsuiteClient');

const CHECKS = [
  ['Subsidiaries', 'SELECT id, name FROM subsidiary'],
  ['Classes', 'SELECT COUNT(*) AS n FROM classification'],
  ['Departments', 'SELECT COUNT(*) AS n FROM department'],
  ['Locations', 'SELECT COUNT(*) AS n FROM location'],
  ['Accounts', 'SELECT COUNT(*) AS n FROM account'],
  ['Vendors', 'SELECT COUNT(*) AS n FROM vendor'],
  ['Vendor bills', "SELECT COUNT(*) AS n, MAX(trandate) AS latest FROM transaction WHERE type = 'VendBill'"],
  ['Expense reports', "SELECT COUNT(*) AS n, MAX(trandate) AS latest FROM transaction WHERE type = 'ExpRept'"],
];

async function main() {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, NETSUITE_ENC_KEY } = process.env;
  const key = parseKey(NETSUITE_ENC_KEY);
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !key) throw new Error('Missing env: run this through `railway run`');
  const row = await supabaseStore({ url: SUPABASE_URL, serviceKey: SUPABASE_SERVICE_KEY }).get();
  if (!row) throw new Error('No credentials have been submitted');
  if (row.method !== 'tba') throw new Error(`This check only supports token-based auth, not ${row.method}`);
  const secrets = decryptSecrets(row.secrets, key);
  console.log(`Account ${row.account_id}, credentials decrypted OK\n`);

  let failed = 0;
  for (const [label, q] of CHECKS) {
    try {
      const { items = [] } = await suiteql({ accountId: row.account_id, secrets, q });
      const one = items[0] || {};
      const summary = label === 'Subsidiaries'
        ? `${items.length}: ${items.map((i) => i.name).join(', ')}`
        : `${one.n}${one.latest ? `, latest ${one.latest}` : ''}`;
      console.log(`OK    ${label}: ${summary}`);
    } catch (err) {
      failed += 1;
      console.log(`FAIL  ${label}: ${err.message}`);
    }
  }
  console.log(failed ? `\n${failed} of ${CHECKS.length} checks failed` : '\nAll checks passed');
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => { console.error(`Could not run: ${err.message}`); process.exitCode = 1; });
