'use strict';
// One-time pull of every JobNimbus job's description → jobs.description (the
// job page shows it; the webhook + reconcile keep it current from now on via
// jobSync.descriptionCol). Sets the column to what JobNimbus holds today:
// trimmed text, or null when JobNimbus has none. Rows already matching are
// left alone; jobs JobNimbus no longer returns are untouched. Never inserts.
//
//   railway run node scripts/backfillJobDescriptions.js            # dry run: counts only
//   railway run node scripts/backfillJobDescriptions.js --apply    # write
//
// Needs JN_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY (Railway injects them),
// and the column from the app repo's supabase/add_job_description.sql.

const { descriptionCol } = require('../jobSync');

const APPLY = process.argv.includes('--apply');
const JN_BASE = 'https://app.jobnimbus.com/api1';
const JN_TOKEN = (process.env.JN_TOKEN || '').trim();
const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://aurbjoqmuzbisoirotdm.supabase.co').trim();
const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || '').trim();
if (!JN_TOKEN || !SUPABASE_SERVICE_KEY) { console.error('JN_TOKEN and SUPABASE_SERVICE_KEY are required'); process.exit(2); }

const sbHeaders = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' };
async function sbAll(table, query) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}&limit=1000&offset=${offset}`, { headers: sbHeaders });
    if (!r.ok) throw new Error(`${table} ${r.status} ${(await r.text()).slice(0, 200)}`);
    const page = await r.json();
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}

// Every JN job in fixed month windows over date_created (the sales-rep
// backfill's proven pattern: no ordering assumption, no window near the ES
// 10k from+size cap). Slim payload: fields=jnid,description,date_updated.
async function jnAllJobs() {
  const jobs = [];
  const fields = 'jnid,description,date_updated';
  const cur = new Date(Date.UTC(2024, 0, 1));
  const end = new Date(Date.now() + 24 * 3600 * 1000);
  while (cur < end) {
    const gte = Math.floor(cur.getTime() / 1000);
    cur.setUTCMonth(cur.getUTCMonth() + 1);
    const lt = Math.floor(cur.getTime() / 1000);
    const filter = encodeURIComponent(JSON.stringify({ must: [{ range: { date_created: { gte, lt } } }] }));
    let count = Infinity; let got = 0;
    for (let from = 0; from < 10000 && from < count; from += 500) {
      const r = await fetch(`${JN_BASE}/jobs?size=500&from=${from}&fields=${fields}&filter=${filter}`, {
        headers: { Authorization: `bearer ${JN_TOKEN}`, Accept: 'application/json' },
      });
      if (!r.ok) throw new Error(`JN /jobs ${r.status}`);
      const data = await r.json();
      const page = (data && (data.results || data.data)) || [];
      count = (data && (data.count ?? data.total)) ?? page.length;
      jobs.push(...page); got += page.length;
      if (page.length < 500) break;
    }
    if (got < count) throw new Error(`window ${new Date(gte * 1000).toISOString().slice(0, 7)} incomplete: ${got}/${count}`);
    process.stdout.write(`  ${new Date(gte * 1000).toISOString().slice(0, 7)}: ${got}\n`);
  }
  return jobs;
}

(async () => {
  console.log(APPLY ? 'APPLY mode' : 'DRY RUN (pass --apply to write)');
  const local = await sbAll('jobs', 'select=id,jn_id,description&jn_id=not.is.null&order=jn_id');
  const localByJn = new Map(local.map((j) => [String(j.jn_id), j]));
  console.log(`${local.length} DryOps jobs mirrored from JobNimbus`);

  console.log('Pulling JobNimbus jobs by month…');
  const jnJobs = await jnAllJobs();
  console.log(`${jnJobs.length} JobNimbus jobs`);

  const stats = { seen: 0, withText: 0, empty: 0, alreadyRight: 0, toSet: 0, toClear: 0 };
  const changes = []; // { jnid, description }
  const seen = new Set();
  for (const j of jnJobs) {
    const jnid = String(j.jnid || j.id || j.recid || '');
    if (!jnid || seen.has(jnid)) continue; // cursor re-fetch dupes
    seen.add(jnid);
    const row = localByJn.get(jnid);
    if (!row) continue;
    stats.seen++;
    const want = descriptionCol(j).description ?? null;
    if (want) stats.withText++; else stats.empty++;
    if ((row.description || null) === want) { stats.alreadyRight++; continue; }
    if (want) stats.toSet++; else stats.toClear++;
    changes.push({ jnid, description: want });
  }

  console.log('\nSummary');
  console.log(`  mirrored jobs found in JobNimbus : ${stats.seen}`);
  console.log(`  with a description in JobNimbus  : ${stats.withText}`);
  console.log(`  no description in JobNimbus      : ${stats.empty}`);
  console.log(`  already correct locally          : ${stats.alreadyRight}`);
  console.log(`  rows to set                      : ${stats.toSet}`);
  console.log(`  rows to clear                    : ${stats.toClear}`);
  for (const c of changes.slice(0, 10)) console.log(`    ${c.jnid}: ${c.description ? JSON.stringify(c.description.slice(0, 80)) : '(clear)'}`);
  if (changes.length > 10) console.log(`    … ${changes.length - 10} more`);

  if (!APPLY) { console.log('\nDry run only — nothing written.'); return; }
  // One PATCH per distinct value (descriptions are mostly unique → one per job).
  let updated = 0; let failed = 0;
  const clears = changes.filter((c) => !c.description).map((c) => c.jnid);
  for (let i = 0; i < clears.length; i += 80) {
    const chunk = clears.slice(i, i + 80).map((id) => `"${id}"`).join(',');
    const r = await fetch(`${SUPABASE_URL}/rest/v1/jobs?jn_id=in.(${encodeURIComponent(chunk)})`, {
      method: 'PATCH', headers: { ...sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify({ description: null }),
    });
    if (!r.ok) throw new Error(`jobs patch ${r.status} ${(await r.text()).slice(0, 200)}`);
    updated += Math.min(80, clears.length - i);
  }
  for (const c of changes) {
    if (!c.description) continue;
    const r = await fetch(`${SUPABASE_URL}/rest/v1/jobs?jn_id=eq.${encodeURIComponent(c.jnid)}`, {
      method: 'PATCH', headers: { ...sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify({ description: c.description }),
    });
    if (!r.ok) { failed++; if (failed <= 5) console.warn(`  ${c.jnid}: ${r.status} ${(await r.text()).slice(0, 120)}`); continue; }
    updated++;
    if (updated % 500 === 0) process.stdout.write(`  ${updated} written\n`);
  }
  console.log(`\nDone — updated ${updated} jobs${failed ? `, ${failed} failed` : ''}.`);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
