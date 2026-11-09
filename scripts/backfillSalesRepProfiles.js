'use strict';
// One-time pull of every JobNimbus job's sales rep → DryOps jobs (owner ask
// 2026-11-09). Sets BOTH columns to what JobNimbus holds today:
//   jobs.sales_rep            = JN sales_rep_name (alias-normalised)
//   jobs.sales_rep_profile_id = the DryOps profile whose jn_user_id is JN's sales_rep
// Rows already matching are left alone; jobs JobNimbus no longer returns are
// untouched (the deletion sweep owns those). Never inserts.
//
//   railway run node scripts/backfillSalesRepProfiles.js            # dry run: counts only
//   railway run node scripts/backfillSalesRepProfiles.js --apply    # write
//
// Needs JN_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY (Railway injects them).

const { profileIdFor } = require('../salesRep');

const APPLY = process.argv.includes('--apply');
const JN_BASE = 'https://app.jobnimbus.com/api1';
const JN_TOKEN = (process.env.JN_TOKEN || '').trim();
const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://aurbjoqmuzbisoirotdm.supabase.co').trim();
const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || '').trim();
if (!JN_TOKEN || !SUPABASE_SERVICE_KEY) { console.error('JN_TOKEN and SUPABASE_SERVICE_KEY are required'); process.exit(2); }

// Same alias table as server.js normalizeRepName (JN renames leave old stamps).
const REP_NAME_ALIASES = { 'Dylan Haycock PPO': 'Dylan Haycock', 'Dylan Haycock APO': 'Dylan Haycock' };
const normalizeRepName = (n) => { const t = typeof n === 'string' ? n.trim() : n; return (t && REP_NAME_ALIASES[t]) || t || null; };

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

// Every JN job in fixed month windows over date_created (the backfill's proven
// pattern: no ordering assumption, no window near the ES 10k from+size cap).
async function jnAllJobs() {
  const jobs = [];
  const fields = 'jnid,sales_rep,sales_rep_name,record_type_name,date_created';
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
    process.stdout.write(`  ${new Date(gte * 1000).toISOString().slice(0, 7)}: ${got}\n`);
  }
  return jobs;
}

(async () => {
  console.log(APPLY ? 'APPLY mode' : 'DRY RUN (pass --apply to write)');
  const profiles = await sbAll('profiles', 'select=id,full_name,jn_user_id&jn_user_id=not.is.null');
  const byJnUser = new Map(profiles.map((p) => [String(p.jn_user_id).trim(), String(p.id)]));
  const profileName = new Map(profiles.map((p) => [String(p.id), p.full_name]));
  console.log(`${profiles.length} DryOps profiles linked to a JobNimbus user`);

  const local = await sbAll('jobs', 'select=id,jn_id,sales_rep,sales_rep_profile_id&jn_id=not.is.null&order=jn_id');
  const localByJn = new Map(local.map((j) => [String(j.jn_id), j]));
  console.log(`${local.length} DryOps jobs mirrored from JobNimbus`);

  console.log('Pulling JobNimbus jobs by month…');
  const jnJobs = await jnAllJobs();
  console.log(`${jnJobs.length} JobNimbus jobs`);

  // desired state per mirrored job
  const changes = new Map(); // key "name|profile" -> { name, profile, ids: [] }
  const stats = { seen: 0, jnWithRep: 0, matchedProfile: 0, unmatchedRep: new Map(), noRep: 0, alreadyRight: 0, toChange: 0 };
  for (const j of jnJobs) {
    const jnid = String(j.jnid || j.id || j.recid || '');
    const row = localByJn.get(jnid);
    if (!row) continue;
    stats.seen++;
    const name = normalizeRepName(j.sales_rep_name);
    const pid = profileIdFor(j, byJnUser); // undefined = JN sent no key
    const profile = pid === undefined ? null : pid;
    if (j.sales_rep) {
      stats.jnWithRep++;
      if (profile) stats.matchedProfile++;
      else {
        const k = `${j.sales_rep} (${name || '?'})`;
        stats.unmatchedRep.set(k, (stats.unmatchedRep.get(k) || 0) + 1);
      }
    } else stats.noRep++;
    const same = (row.sales_rep || null) === (name || null) && (row.sales_rep_profile_id || null) === (profile || null);
    if (same) { stats.alreadyRight++; continue; }
    stats.toChange++;
    if (row.sales_rep_profile_id && (profile || null) !== String(row.sales_rep_profile_id)) {
      stats.profileLost = (stats.profileLost || 0) + 1;
      if ((stats.profileLostRows = stats.profileLostRows || []).length < 15) stats.profileLostRows.push(`${jnid} local ${row.sales_rep || '—'}/${profileName.get(String(row.sales_rep_profile_id)) || row.sales_rep_profile_id} → JN ${name || '—'}/${profile ? profileName.get(profile) : '—'}`);
    }
    const key = `${name || ''}|${profile || ''}`;
    if (!changes.has(key)) changes.set(key, { name: name || null, profile: profile || null, ids: [] });
    changes.get(key).ids.push(jnid);
  }

  console.log('\nSummary');
  console.log(`  mirrored jobs found in JobNimbus : ${stats.seen}`);
  console.log(`  with a JN sales rep              : ${stats.jnWithRep}`);
  console.log(`    → resolved to a DryOps profile : ${stats.matchedProfile}`);
  console.log(`    → no DryOps profile for the rep: ${stats.jnWithRep - stats.matchedProfile}`);
  console.log(`  no rep in JobNimbus              : ${stats.noRep}`);
  console.log(`  already correct locally          : ${stats.alreadyRight}`);
  console.log(`  rows to update                   : ${stats.toChange}`);
  console.log(`  of which a local profile id is replaced or cleared: ${stats.profileLost || 0}`);
  for (const l of stats.profileLostRows || []) console.log(`    ${l}`);
  if (stats.unmatchedRep.size) {
    console.log('\nJN reps with no linked DryOps profile (JN user id (name): jobs) — link them in Settings → Team to resolve:');
    for (const [k, n] of [...stats.unmatchedRep].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);
  }
  console.log('\nUpdates by (name → profile):');
  for (const c of [...changes.values()].sort((a, b) => b.ids.length - a.ids.length)) {
    console.log(`  ${c.name || '—'} → ${c.profile ? profileName.get(c.profile) || c.profile : 'no profile'}: ${c.ids.length}`);
  }

  if (!APPLY) { console.log('\nDry run only — nothing written.'); return; }
  let updated = 0;
  for (const c of changes.values()) {
    for (let i = 0; i < c.ids.length; i += 80) {
      const chunk = c.ids.slice(i, i + 80).map((id) => `"${id}"`).join(',');
      const r = await fetch(`${SUPABASE_URL}/rest/v1/jobs?jn_id=in.(${encodeURIComponent(chunk)})`, {
        method: 'PATCH', headers: { ...sbHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ sales_rep: c.name, sales_rep_profile_id: c.profile }),
      });
      if (!r.ok) throw new Error(`jobs patch ${r.status} ${(await r.text()).slice(0, 200)}`);
      updated += Math.min(80, c.ids.length - i);
    }
  }
  console.log(`\nDone — updated ${updated} jobs.`);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
