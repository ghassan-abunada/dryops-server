'use strict';
// One-time fill of jobs.client_phone for jobs that have none. Until this fix
// the job mirror read only JobNimbus's Mobile phone; offices that type the
// customer's number into Home (or Work) phone got jobs with no phone, so their
// calls, texts and Google leads could not find the job. The webhook and the
// reconcile now take mobile, then home, then work (jobSync.clientPhoneCol);
// this script applies the same rule to the jobs already mirrored.
//
// It ONLY fills an empty phone. A job that has a phone is never read back,
// never overwritten and never cleared (the write itself is filtered on
// client_phone is null, so a phone that arrives mid-run also wins).
//
//   railway run node scripts/backfillClientPhones.js            # dry run: counts + masked examples, writes nothing
//   railway run node scripts/backfillClientPhones.js --apply    # write
//   … --from=2025-06   # start the JobNimbus pull at that month (default 2024-01)
//
// Needs JN_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY (Railway injects them).
//
// Calls: jobs.client_phone_norm is generated from client_phone, and the jobs
// trigger trg_claim_calls_for_mitigation_job hands a Mitigation job its
// caller's calls the moment its phone changes, so each write re-links that
// job's calls on its own. See the PR for what is left after that.

const { clientPhoneCol, CLIENT_PHONE_KEYS } = require('../jobSync');

// "(***) ***-1234": enough to recognise a row, never the whole number in a log.
function maskPhone(v) {
  const d = String(v == null ? '' : v).replace(/\D/g, '');
  return d.length >= 4 ? `(***) ***-${d.slice(-4)}` : '(***)';
}

// Which JobNimbus box the number came from (for the summary).
function phoneSource(job) {
  const col = clientPhoneCol(job);
  if (!col.client_phone) return null;
  return CLIENT_PHONE_KEYS.find((k) => job[k] === col.client_phone) || null;
}

// localRows: DryOps jobs with no phone ({ jn_id, record_type }).
// jnJobs: JobNimbus job records carrying the three parent_*_phone keys.
// Returns the fills to write and the counts for the report. Pure.
function planPhoneBackfill(localRows, jnJobs) {
  const missing = new Map((localRows || []).filter((r) => r && r.jn_id).map((r) => [String(r.jn_id), r]));
  const stats = { missing: missing.size, foundInJn: 0, toFill: 0, noPhoneInJn: 0, notInPull: 0, bySource: {}, byType: {} };
  const fills = [];
  const seen = new Set();
  let sawPhoneKey = false;
  for (const j of jnJobs || []) {
    if (!j) continue;
    if (!sawPhoneKey && CLIENT_PHONE_KEYS.some((k) => j[k] !== undefined)) sawPhoneKey = true;
    const jnid = String(j.jnid || j.id || j.recid || '');
    if (!jnid || seen.has(jnid)) continue; // page re-fetch dupes
    seen.add(jnid);
    const row = missing.get(jnid);
    if (!row) continue; // has a phone already, or not mirrored
    stats.foundInJn++;
    const phone = clientPhoneCol(j).client_phone;
    if (!phone) { stats.noPhoneInJn++; continue; }
    const source = phoneSource(j);
    stats.toFill++;
    stats.bySource[source] = (stats.bySource[source] || 0) + 1;
    const type = row.record_type || '(no type)';
    stats.byType[type] = (stats.byType[type] || 0) + 1;
    fills.push({ jnid, client_phone: phone, source, record_type: row.record_type || null });
  }
  stats.notInPull = stats.missing - stats.foundInJn;
  return { fills, stats, sawPhoneKey };
}

module.exports = { planPhoneBackfill, maskPhone, phoneSource };

if (require.main === module) {
  const APPLY = process.argv.includes('--apply');
  const fromArg = (process.argv.find((a) => /^--from=\d{4}-\d{2}$/.test(a)) || '--from=2024-01').slice(7);
  const JN_BASE = 'https://app.jobnimbus.com/api1';
  const JN_TOKEN = (process.env.JN_TOKEN || '').trim();
  const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://aurbjoqmuzbisoirotdm.supabase.co').trim();
  const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || '').trim();
  if (!JN_TOKEN || !SUPABASE_SERVICE_KEY) { console.error('JN_TOKEN and SUPABASE_SERVICE_KEY are required'); process.exit(2); }

  const sbHeaders = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Stable order (id) so offset paging cannot skip or repeat a row.
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

  // Every JN job in fixed month windows over date_created (the sales-rep and
  // description backfills' proven pattern: 500 a page, one request at a time,
  // no window near the ES 10k from+size cap). Slim payload: only the phones.
  async function jnAllJobs() {
    const jobs = [];
    const fields = ['jnid', ...CLIENT_PHONE_KEYS, 'date_created'].join(',');
    const [fy, fm] = fromArg.split('-').map(Number);
    const cur = new Date(Date.UTC(fy, fm - 1, 1));
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
    const local = await sbAll('jobs', 'select=id,jn_id,record_type&client_phone=is.null&jn_id=not.is.null&order=id');
    console.log(`${local.length} DryOps jobs from JobNimbus have no client phone`);
    if (!local.length) { console.log('Nothing to do.'); return; }

    console.log(`Pulling JobNimbus jobs by month from ${fromArg}…`);
    const jnJobs = await jnAllJobs();
    console.log(`${jnJobs.length} JobNimbus jobs`);

    const { fills, stats, sawPhoneKey } = planPhoneBackfill(local, jnJobs);
    // Not one record carried a phone key: JobNimbus did not return the fields
    // we asked for, so "no phone" below would be a wrong answer. Stop.
    if (jnJobs.length && !sawPhoneKey) {
      console.error('JobNimbus returned no parent_*_phone field on any job — the fields list was not honoured. Nothing written.');
      process.exit(1);
    }

    console.log('\nSummary');
    console.log(`  jobs with no phone in DryOps        : ${stats.missing}`);
    console.log(`  of those, found in the JobNimbus pull: ${stats.foundInJn}`);
    console.log(`  would get a phone                   : ${stats.toFill}`);
    for (const [k, n] of Object.entries(stats.bySource)) console.log(`      from ${k.padEnd(20)}: ${n}`);
    for (const [k, n] of Object.entries(stats.byType)) console.log(`      ${k.padEnd(25)}: ${n}`);
    console.log(`  no phone in JobNimbus either        : ${stats.noPhoneInJn}`);
    console.log(`  not in the pull (older than ${fromArg}, or deleted in JobNimbus): ${stats.notInPull}`);
    for (const f of fills.slice(0, 10)) console.log(`    ${f.jnid}: ${maskPhone(f.client_phone)} ← ${f.source} (${f.record_type || 'no type'})`);
    if (fills.length > 10) console.log(`    … ${fills.length - 10} more`);

    if (!APPLY) { console.log('\nDry run only — nothing written.'); return; }
    // One PATCH per job, one at a time: each write runs the jobs trigger that
    // claims the caller's calls, so keep the database load flat. The
    // client_phone=is.null filter is what guarantees a phone is never replaced.
    let updated = 0; let alreadyHad = 0; let failed = 0;
    for (const f of fills) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/jobs?jn_id=eq.${encodeURIComponent(f.jnid)}&client_phone=is.null&select=id`, {
        method: 'PATCH', headers: { ...sbHeaders, Prefer: 'return=representation' }, body: JSON.stringify({ client_phone: f.client_phone }),
      });
      if (!r.ok) { failed++; if (failed <= 5) console.warn(`  ${f.jnid}: ${r.status} ${(await r.text()).slice(0, 120)}`); continue; }
      const rows = await r.json().catch(() => []);
      if (Array.isArray(rows) && rows.length) updated++; else alreadyHad++;
      if ((updated + alreadyHad) % 500 === 0) process.stdout.write(`  ${updated} written\n`);
      await sleep(25);
    }
    console.log(`\nDone — filled ${updated} jobs${alreadyHad ? `, ${alreadyHad} got a phone meanwhile (left alone)` : ''}${failed ? `, ${failed} failed` : ''}.`);
  })().catch((e) => { console.error('failed:', e.message); process.exit(1); });
}
