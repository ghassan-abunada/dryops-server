'use strict';
// ── Testing job from a testing work order ────────────────────────────────────
// A JobNimbus automation ("work order created", record type Asbestos / Soot /
// Mold Testing) POSTs the work order here. The server then creates the matching
// Testing job — the same thing the ATS office did by hand (reference: Saleah's
// "Jeremy Eihausen (DAL-TST)" built from Asbestos Testing WO #21161 on
// "Jeremy Eihausen (AFF - DAL - MIT)", 2026-10-20):
//
//   * record type Testing, status Lead, JobNimbus location "Abatement Testing
//     Services" (198) like every existing Testing job — except Arizona and
//     Hawaii losses, which go to "White Tail Environmental" (30) the way the
//     office files them (state from the source job's address, else its
//     JN location)
//   * primary + related contact = the source job's primary contact
//   * name = source job's name minus its "(…)" suffix + " (CTY - TST)", where
//     CTY is the city code in the source job's own suffix: "(AFF - DAL - MIT)"
//     → DAL, "(POR-MIT)" → POR, "(24 - DAL - MIT)" → DAL, "(SAN MIT)" → SAN.
//     A job with no suffix borrows the code its location's other jobs use
//     ("Johnathan Bolton" at Right-Now Restoration of Hawaii → OAH), then
//     the DryOps location's city_abbr, the JN location's city, the job's city.
//   * owners: Saleah Crawford + Jalisa Hill (ATS) on every job, plus Dominick
//     Garcia for Dallas and Will LeBrun for San Antonio (by city code or the
//     source location's name). Override with TESTING_JOB_OWNERS* env vars.
//   * lead source = the JN source named after the referring company (the
//     source job's location name, "American Fire and Flood of Dallas" →
//     "American Fire and Flood"); Lead Type "Internal Referral"; insurance
//     flag, address, geo, claim/adjuster/date-of-loss copied from the source
//   * a note on the Testing job (tagging the owners) and one on the source job
//
// Idempotent: the new job carries external_id "testing-wo:<wo jnid>" and a
// redelivery finds it; a contact that already has an active Testing job from
// the last TESTING_JOB_DEDUPE_DAYS (90) days gets none (asbestos + mold WOs on
// one loss = one Testing job). Concurrent deliveries share one in-flight run.
//
// Endpoint: POST /webhooks/jobnimbus/testing-workorder?token=<JN_WEBHOOK_TOKEN>
//   body = the work order record (direct, {data:…} or [record]); a body of
//   just {"jnid": "<work order id>"} is fetched from JobNimbus, so a manual
//   test is one curl. ?dryrun=1 computes everything and writes nothing;
//   ?any=1 skips the "is this a testing work order" gate.
// Env: TESTING_JOB_DRYRUN=1 (log instead of writing; JN_INTAKE_DRYRUN=1 also
//   counts), TESTING_JOB_LOCATION_ID (198), TESTING_JOB_WHITE_TAIL_LOCATION_ID
//   (30), TESTING_JOB_WHITE_TAIL_STATES ("AZ,HI"), TESTING_JOB_OWNERS,
//   TESTING_JOB_OWNERS_DALLAS, TESTING_JOB_OWNERS_SAN_ANTONIO (comma-separated
//   JN user ids), TESTING_JOB_DEDUPE_DAYS (90).

// JobNimbus user ids (account/users, verified 2026-10-20).
const USERS = {
  saleahCrawford: 'lw56hok1xagmfidjgbula5w', // saleah@abatetest.com
  jalisaHillATS: 'lpy3x55zdptwpx82v8nsyxh',  // jalisa@abatetest.com ("Jalisa Hill ATS")
  dominickGarcia: 'lpz7pf67igy8wybljouzpxl', // dominick@abatetest.com
  willLeBrun: 'mf40yph2ezmrleajp1pqeyu',     // william@abatetest.com
};
const DEFAULT_OWNER_RULES = {
  always: [USERS.saleahCrawford, USERS.jalisaHillATS],
  dallas: [USERS.dominickGarcia],
  sanAntonio: [USERS.willLeBrun],
};
// JobNimbus locations the Testing jobs are filed under (account/settings →
// locations, verified 2026-10-20: 6,844 Testing jobs on 198; 1,405 AZ + 361 HI
// on 30, none of those on 198).
const LOCATIONS = {
  abatementTestingServices: 198,
  whiteTailEnvironmental: 30,
};
const DEFAULT_LOCATION_RULES = {
  default: LOCATIONS.abatementTestingServices,
  whiteTail: LOCATIONS.whiteTailEnvironmental,
  whiteTailStates: ['AZ', 'HI'],
};
const STATE_CODES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY',
  louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO',
  montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC',
};
const DALLAS_CODES = new Set(['DAL']);
const SAN_ANTONIO_CODES = new Set(['SA', 'SAN', 'SAT']);
const TESTING_RECORD_TYPE = 'Testing';
const TYPE_CODE_RE = /^(MIT|CON|REB|STR|TST|ABT|RCN|PO)$/i;
const TRAILING_PAREN_RE = /\(([^()]*)\)\s*$/;
const DUP_NAME_RE = /duplicate|already exists|already in use/i;
const CITY_ABBR_OVERRIDES = {
  'san antonio': 'SAN', 'fort worth': 'FTW', 'oklahoma city': 'OKC', 'kansas city': 'KC', 'salt lake city': 'SLC',
  'little rock': 'LR', 'los angeles': 'LA', 'las vegas': 'LV', 'new york': 'NYC', 'st. louis': 'STL', 'saint louis': 'STL', 'el paso': 'ELP',
};

const clean = (v, max = 300) => (v === undefined || v === null ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, max);
const uniq = (list) => Array.from(new Set(list.filter(Boolean).map(String)));
const envList = (name) => uniq(String(process.env[name] || '').split(',').map((s) => s.trim()));

// "(AFF - DAL - MIT)" → DAL; "(POR-MIT)" → POR; "(24 - DAL - MIT)" → DAL;
// "(FTW - CON)" → FTW; "(AFF - DAL)" (a contact-style suffix) → DAL; no
// suffix / no 2–4 letter code → null.
function cityAbbrFromJobName(name) {
  const m = TRAILING_PAREN_RE.exec(String(name || ''));
  if (!m) return null;
  // Split on dashes, or on spaces for the odd "(SAN MIT)" — but a space-only
  // suffix without a type code ("(24 Hour)") is not a city code.
  const tokens = m[1].split(/\s*[-–—]\s*|\s+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
  if (!tokens.length) return null;
  const hadType = tokens.length > 1 && TYPE_CODE_RE.test(tokens[tokens.length - 1]);
  if (hadType) tokens.pop();
  else if (tokens.length > 1 && !/[-–—]/.test(m[1])) return null;
  const code = tokens[tokens.length - 1];
  return /^[A-Z]{2,4}$/.test(code) && !TYPE_CODE_RE.test(code) ? code : null;
}
function cityAbbrForCity(city) {
  const c = clean(city).toLowerCase();
  if (!c) return null;
  if (CITY_ABBR_OVERRIDES[c]) return CITY_ABBR_OVERRIDES[c];
  const letters = c.replace(/[^a-z]/g, '');
  return letters ? letters.slice(0, 3).toUpperCase() : null;
}
// "Jeremy Eihausen (AFF - DAL - MIT)" → "Jeremy Eihausen"
function baseNameOf(jobName) {
  return clean(String(jobName || '').replace(TRAILING_PAREN_RE, ''));
}
// Most common non-null city code in a list (sibling jobs at the same JN
// location: "Joe Walker (OAH-MIT) | Dane Hina (OAH-MIT) | Curtis Martin" → OAH).
function mostCommonAbbr(codes) {
  const counts = new Map();
  for (const c of codes || []) if (c) counts.set(c, (counts.get(c) || 0) + 1);
  let best = null, n = 0;
  for (const [k, v] of counts) if (v > n) { best = k; n = v; }
  return best;
}
function testingJobName(base, abbr, n = 1) {
  return `${base} (${abbr} - TST)${n > 1 ? ` ${n}` : ''}`;
}
function isDallas(abbr, locationName) {
  return DALLAS_CODES.has(String(abbr || '').toUpperCase()) || /\bdallas\b/i.test(String(locationName || ''));
}
function isSanAntonio(abbr, locationName) {
  return SAN_ANTONIO_CODES.has(String(abbr || '').toUpperCase()) || /\bsan\s+antonio\b/i.test(String(locationName || ''));
}
function testingOwnersFor({ abbr, locationName }, rules = DEFAULT_OWNER_RULES) {
  const out = [...(rules.always || [])];
  if (isDallas(abbr, locationName)) out.push(...(rules.dallas || []));
  if (isSanAntonio(abbr, locationName)) out.push(...(rules.sanAntonio || []));
  return uniq(out);
}
// "TX" / "Texas" / " tx " → "TX"; anything else → null.
function stateCode(stateText) {
  const s = clean(stateText).toLowerCase().replace(/\./g, '');
  if (!s) return null;
  if (/^[a-z]{2}$/.test(s)) return s.toUpperCase();
  return STATE_CODES[s] || null;
}
// Arizona and Hawaii testing is filed under White Tail Environmental; the rest
// under Abatement Testing Services.
function testingLocationFor({ state }, rules = DEFAULT_LOCATION_RULES) {
  const code = stateCode(state);
  const wt = (rules.whiteTailStates || []).map((x) => String(x).toUpperCase());
  return code && wt.includes(code) ? Number(rules.whiteTail) : Number(rules.default);
}
// Work orders that go to Abatement Testing Services: record type "Asbestos
// Testing" / "Soot Testing" / "Mold Testing" (or the ATS subcontractor).
function isTestingWorkOrder(wo) {
  if (!wo || typeof wo !== 'object') return false;
  if (/\btesting\b/i.test(String(wo.record_type_name || ''))) return true;
  const subs = Array.isArray(wo.subcontractors) ? wo.subcontractors : [];
  return subs.some((s) => /abatement\s+testing/i.test(String((s && s.name) || '')));
}
// Lead source = the referring company. JN sources are named after the company
// without the city ("American Fire and Flood of Dallas" → "American Fire and
// Flood"), sometimes with it. Exact (normalized) match on the location name,
// then with " of <city>" / " - <x>" / "(…)" stripped; active sources first.
function normSourceName(s) {
  return clean(s).toLowerCase().replace(/[.,]/g, '').replace(/\b(llc|inc|l\.?l\.?c\.?)\b/g, '').replace(/\s+/g, ' ').trim();
}
function pickLeadSource(sources, locationName) {
  const name = clean(locationName);
  if (!name || !Array.isArray(sources)) return null;
  const cands = uniq([
    name,
    name.replace(/\s*\([^()]*\)\s*$/, ''),
    name.replace(/\s+-\s+.*$/, ''),
    name.replace(/\s+of\s+.*$/i, ''),
    name.replace(/\s*\([^()]*\)\s*$/, '').replace(/\s+-\s+.*$/, '').replace(/\s+of\s+.*$/i, ''),
  ].map(normSourceName).filter(Boolean));
  // active sources win across every candidate ("American Fire and Flood of
  // San Antonio" is retired; the office files those under "American Fire and
  // Flood"), then inactive ones as a last resort.
  for (const activeOnly of [true, false]) {
    for (const c of cands) {
      const hit = sources.find((s) => normSourceName(s.name) === c && (!activeOnly || s.active !== false));
      if (hit) return { id: Number(hit.id), name: hit.name };
    }
  }
  return null;
}
function ownerRulesFromEnv() {
  const always = envList('TESTING_JOB_OWNERS');
  const dallas = envList('TESTING_JOB_OWNERS_DALLAS');
  const sanAntonio = envList('TESTING_JOB_OWNERS_SAN_ANTONIO');
  return {
    always: always.length ? always : DEFAULT_OWNER_RULES.always,
    dallas: process.env.TESTING_JOB_OWNERS_DALLAS !== undefined ? dallas : DEFAULT_OWNER_RULES.dallas,
    sanAntonio: process.env.TESTING_JOB_OWNERS_SAN_ANTONIO !== undefined ? sanAntonio : DEFAULT_OWNER_RULES.sanAntonio,
  };
}
function locationRulesFromEnv() {
  const states = envList('TESTING_JOB_WHITE_TAIL_STATES');
  return {
    default: Number(process.env.TESTING_JOB_LOCATION_ID || DEFAULT_LOCATION_RULES.default),
    whiteTail: Number(process.env.TESTING_JOB_WHITE_TAIL_LOCATION_ID || DEFAULT_LOCATION_RULES.whiteTail),
    whiteTailStates: states.length ? states : DEFAULT_LOCATION_RULES.whiteTailStates,
  };
}

function mountTestingJobs(app, deps) {
  const {
    webhookTokenOk, unwrapRecord, sbGet, jnSendJson, jnGetJson, jnAddNote, jnFetchAccountUsers,
    log = (...a) => console.log('[testing-job]', ...a),
    warn = (...a) => console.warn('[testing-job]', ...a),
    now = () => Date.now(),
  } = deps;
  const DRYRUN_ENV = process.env.TESTING_JOB_DRYRUN === '1' || process.env.JN_INTAKE_DRYRUN === '1';
  const DEDUPE_DAYS = Number(process.env.TESTING_JOB_DEDUPE_DAYS || 90);
  const OWNER_RULES = deps.ownerRules || ownerRulesFromEnv();
  const LOCATION_RULES = deps.locationRules || locationRulesFromEnv();
  const enc = encodeURIComponent;
  const jnUrl = (id) => `https://app.jobnimbus.com/job/${id}`;
  const jnErr = (r) => (r && r.body && (r.body.message || r.body.error || r.body.Message)) || (r && r.text) || `HTTP ${r && r.status}`;

  let settingsCache = { at: 0, data: null };
  async function accountSettings() {
    if (settingsCache.data && now() - settingsCache.at < 10 * 60 * 1000) return settingsCache.data;
    const j = await jnGetJson('account/settings');
    const data = {
      sources: (Array.isArray(j && j.sources) ? j.sources : []).map((s) => ({ id: Number(s.JobSourceId), name: String(s.SourceName || '').trim(), active: s.IsActive !== false })).filter((s) => s.id && s.name),
      locations: (Array.isArray(j && j.locations) ? j.locations : []).map((l) => ({ id: Number(l.id), name: String(l.name || '').trim(), city: String(l.city || '').trim(), state: String(l.state_text || '').trim() })),
      testingWorkflowId: (() => { const w = (Array.isArray(j && j.workflows) ? j.workflows : []).find((x) => x.object_type === 'job' && String(x.name || '').trim().toLowerCase() === 'testing' && x.is_active !== false); return w ? Number(w.id) : null; })(),
    };
    settingsCache = { at: now(), data };
    return data;
  }
  let usersCache = { at: 0, map: null };
  async function usersById() {
    if (usersCache.map && now() - usersCache.at < 10 * 60 * 1000) return usersCache.map;
    const users = await jnFetchAccountUsers();
    const map = new Map();
    for (const [id, u] of users) { const name = String(u.name || '').trim(); map.set(String(id), { name, mention: name ? '@' + name.replace(/\s+/g, '') : null, active: u.active }); }
    usersCache = { at: now(), map };
    return map;
  }
  async function jnSearch(kind, must, fields, size = 10) {
    const filter = enc(JSON.stringify({ must }));
    const r = await jnSendJson('GET', `${kind}?size=${size}&sort_field=date_created&sort_direction=desc&fields=${fields}&filter=${filter}`);
    if (!r.ok) throw new Error(`JobNimbus ${kind} search ${r.status}: ${jnErr(r)}`);
    return (r.body && (r.body.results || r.body.data)) || [];
  }
  async function nameTaken(name) {
    const rows = await jnSearch('jobs', [{ term: { name } }], 'jnid,name', 5);
    const want = name.trim().toLowerCase();
    return rows.some((x) => String(x.name || '').trim().toLowerCase() === want);
  }

  // The whole sequence for one work order. Throws on hard failures (bad
  // payload, JN errors); returns {ok, skipped} for soft ones.
  async function createTestingJob(input, opts = {}) {
    const dryrun = !!(opts.dryrun || DRYRUN_ENV);
    const warnings = [];
    let wo = input;
    const woId = String((wo && (wo.jnid || wo.id)) || '');
    if (!woId) throw Object.assign(new Error('no work order jnid in payload'), { status: 400 });
    if (!Array.isArray(wo.related)) {
      // bare {jnid} (manual test) or a slim payload — load the record
      const r = await jnSendJson('GET', `workorders/${enc(woId)}`);
      if (!r.ok || !r.body) throw Object.assign(new Error(`work order ${woId} not found in JobNimbus (${r.status})`), { status: 404 });
      wo = r.body;
    }
    if (!opts.any && !isTestingWorkOrder(wo)) return { ok: true, skipped: `not a testing work order (${wo.record_type_name || 'unknown type'})`, work_order: woId };

    // 1. source job + its primary contact
    const related = Array.isArray(wo.related) ? wo.related : [];
    const jobRef = related.find((x) => x && x.type === 'job' && x.id);
    if (!jobRef) return { ok: true, skipped: 'work order has no related job', work_order: woId };
    const sj = await jnSendJson('GET', `jobs/${enc(jobRef.id)}`);
    if (!sj.ok || !sj.body) throw new Error(`source job ${jobRef.id} fetch failed (${sj.status})`);
    const src = sj.body;
    const contactId = String((src.primary && src.primary.type === 'contact' && src.primary.id)
      || (related.find((x) => x && x.type === 'contact' && x.id) || {}).id
      || ((Array.isArray(src.related) ? src.related : []).find((x) => x && x.type === 'contact' && x.id) || {}).id || '');
    if (!contactId) return { ok: true, skipped: 'source job has no primary contact', work_order: woId, source_job: src.jnid };

    // 2. city code, owners, lead source
    const settings = await accountSettings();
    const srcLoc = settings.locations.find((l) => l.id === Number(src.location && src.location.id)) || null;
    let abbr = cityAbbrFromJobName(src.name);
    let abbrFrom = 'job name';
    if (!abbr && srcLoc) {
      // no suffix on this job → the code its location's other jobs use
      const sibs = await jnSearch('jobs', [{ term: { 'location.id': srcLoc.id } }], 'name', 20).catch(() => []);
      abbr = mostCommonAbbr(sibs.map((j) => cityAbbrFromJobName(j.name)));
      abbrFrom = 'sibling jobs';
      if (!abbr) {
        const rows = await sbGet(`locations?jn_location_id=eq.${srcLoc.id}&select=city_abbr&limit=1`).catch(() => null);
        abbr = rows && rows[0] && clean(rows[0].city_abbr).toUpperCase() || null;
        abbrFrom = 'dryops location';
      }
      if (!abbr) { abbr = cityAbbrForCity(srcLoc.city); abbrFrom = 'jn location city'; }
    }
    if (!abbr) { abbr = cityAbbrForCity(src.city); abbrFrom = 'job city'; }
    if (!abbr) throw Object.assign(new Error(`cannot work out a city code for "${src.name}" (no "(CTY - MIT)" suffix, no sibling jobs with one, no location or job city)`), { status: 422 });
    if (abbrFrom !== 'job name') warnings.push(`CITY_FROM_${abbrFrom.replace(/\s+/g, '_').toUpperCase()}`);
    const owners = testingOwnersFor({ abbr, locationName: srcLoc && srcLoc.name }, OWNER_RULES);
    const state = stateCode(src.state_text) || (srcLoc && stateCode(srcLoc.state)) || null;
    if (!stateCode(src.state_text) && state) warnings.push('STATE_FROM_JN_LOCATION');
    if (!state) warnings.push('NO_STATE');
    const locationId = testingLocationFor({ state }, LOCATION_RULES);
    const users = await usersById().catch((e) => { warn('user lookup failed', e.message); return new Map(); });
    for (const id of owners) { const u = users.get(id); if (users.size && (!u || u.active === false)) warnings.push(`OWNER_${!u ? 'UNKNOWN' : 'INACTIVE'}:${id}`); }
    const source = pickLeadSource(settings.sources, srcLoc && srcLoc.name);
    if (!source) warnings.push('NO_LEAD_SOURCE');
    const base = baseNameOf(src.name) || baseNameOf(src.primary && src.primary.name);
    if (!base) throw Object.assign(new Error('source job has no usable name'), { status: 422 });

    // 3. already done? (redelivery → same external_id; same contact recently)
    const externalId = `testing-wo:${woId}`;
    const prior = await jnSearch('jobs', [{ term: { external_id: externalId } }], 'jnid,name', 1);
    if (prior[0]) return { ok: true, replay: true, job: { jn_id: prior[0].jnid, name: prior[0].name, jn_url: jnUrl(prior[0].jnid) }, work_order: woId };
    const must = [{ term: { 'primary.id': contactId } }];
    if (settings.testingWorkflowId) must.push({ term: { record_type: settings.testingWorkflowId } });
    const recent = (await jnSearch('jobs', must, 'jnid,name,record_type_name,is_active,date_created', 10))
      .filter((j) => j.record_type_name === TESTING_RECORD_TYPE && j.is_active !== false && Number(j.date_created || 0) * 1000 > now() - DEDUPE_DAYS * 86400000);
    if (recent[0]) {
      log(woId, 'contact already has a Testing job', recent[0].name);
      return { ok: true, skipped: `contact already has an active Testing job from the last ${DEDUPE_DAYS} days`, job: { jn_id: recent[0].jnid, name: recent[0].name, jn_url: jnUrl(recent[0].jnid) }, work_order: woId };
    }

    // 4. free name + payload
    let n = 1, jobName = testingJobName(base, abbr, n);
    while (n < 10 && await nameTaken(jobName)) jobName = testingJobName(base, abbr, ++n);
    if (n > 1) warnings.push('NAME_FALLBACK_USED');
    const woType = clean(wo.record_type_name) || 'Testing';
    const copy = (k) => (src[k] === undefined || src[k] === null || src[k] === '' || src[k] === 0 ? undefined : src[k]);
    const payload = {
      record_type_name: TESTING_RECORD_TYPE, status_name: 'Lead',
      name: jobName, external_id: externalId,
      primary: { id: contactId, type: 'contact' },
      related: [{ id: contactId, type: 'contact' }],
      location: { id: locationId },
      owners: owners.map((id) => ({ id })),
      source: source ? source.id : undefined,
      description: `${woType} — work order #${clean(wo.number) || woId} on ${clean(src.name)}`,
      address_line1: copy('address_line1'), address_line2: copy('address_line2'), city: copy('city'), state_text: copy('state_text'), zip: copy('zip'), country_name: copy('country_name'),
      geo: src.geo && Number.isFinite(Number(src.geo.lat)) && Number.isFinite(Number(src.geo.lon)) ? { lat: Number(src.geo.lat), lon: Number(src.geo.lon) } : undefined,
      cf_string_6: 'Internal Referral',                       // Lead Type
      cf_string_7: clean(wo.cf_string_7) || copy('cf_string_7'), // Insurance or Not Insurance
      cf_string_18: copy('cf_string_18'),                     // Type of Loss (CAT)
      cf_date_1: copy('cf_date_1'),                           // Date of Loss
      cf_string_2: copy('cf_string_2'),                       // Claim #
      cf_string_9: copy('cf_string_9'),                       // Insurer
      cf_string_3: copy('cf_string_3'), cf_string_4: copy('cf_string_4'), cf_string_5: copy('cf_string_5'), // adjuster
    };
    for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];

    // 5. create
    let jobJnId = null;
    if (dryrun) { log('dryrun POST jobs', JSON.stringify(payload)); jobJnId = `dryrun-${woId.slice(0, 8)}`; }
    else {
      for (let attempt = 0; attempt < 5 && !jobJnId; attempt++) {
        const r = await jnSendJson('POST', 'jobs', payload);
        if (r.ok && r.body && (r.body.jnid || r.body.id)) { jobJnId = String(r.body.jnid || r.body.id); break; }
        const msg = jnErr(r);
        if (r.status < 500 && DUP_NAME_RE.test(msg) && n < 10) { payload.name = jobName = testingJobName(base, abbr, ++n); warnings.push('NAME_FALLBACK_USED'); continue; }
        throw Object.assign(new Error(`JobNimbus rejected the Testing job: ${msg}`), { status: 502, jn_status: r.status });
      }
      if (!jobJnId) throw Object.assign(new Error('JobNimbus did not return a job id'), { status: 502 });
    }
    log(woId, dryrun ? 'dryrun' : 'created', jobJnId, jobName, `location=${locationId}`, `state=${state || '-'}`, `owners=${owners.join(',')}`, `source=${source ? source.name : '-'}`);

    // 6. notes (owners tagged at the bottom, one per line — JN note rule)
    const extra = [];
    if (clean(wo.internal_note)) extra.push(`Internal note: ${clean(wo.internal_note, 1000)}`);
    if (clean(wo.customer_note) && clean(wo.customer_note) !== clean(wo.internal_note)) extra.push(`Customer note: ${clean(wo.customer_note, 1000)}`);
    const newNote = [`Created automatically from ${woType} work order #${clean(wo.number) || woId} on ${clean(src.name)} (${jnUrl(src.jnid || jobRef.id)}).`, ...extra].join('\n');
    const mentions = owners.map((id) => (users.get(id) || {}).mention).filter(Boolean);
    const note = { ok: true, dryrun };
    const srcNote = { ok: true, dryrun };
    if (dryrun) log('dryrun notes', JSON.stringify({ newNote, mentions }));
    else {
      const n1 = await jnAddNote(jobJnId, newNote, { jnLocationId: locationId, mentions });
      Object.assign(note, n1); if (!n1.ok) warnings.push('NOTE_FAILED');
      let tag;
      if (srcLoc) { const rows = await sbGet(`locations?jn_location_id=eq.${srcLoc.id}&select=jn_note_tag&limit=1`).catch(() => null); tag = rows && rows[0] && rows[0].jn_note_tag || undefined; }
      const n2 = await jnAddNote(src.jnid || jobRef.id, `Testing job created: ${jobName} (${jnUrl(jobJnId)}) — ${woType} work order #${clean(wo.number) || woId}.`, { jnLocationId: src.location && src.location.id, tag });
      Object.assign(srcNote, n2); if (!n2.ok) warnings.push('SOURCE_NOTE_FAILED');
    }
    return {
      ok: true, dryrun, work_order: woId, work_order_type: woType,
      source_job: { jn_id: src.jnid || jobRef.id, name: src.name, location: srcLoc },
      job: { jn_id: jobJnId, name: jobName, jn_url: dryrun ? null : jnUrl(jobJnId), location_id: locationId },
      contact: { jn_id: contactId, name: src.primary && src.primary.name },
      city_abbr: abbr, state, owners, source, payload, note, source_note: srcNote, warnings,
    };
  }

  const inflight = new Map();
  app.post('/webhooks/jobnimbus/testing-workorder', async (req, res) => {
    if (!webhookTokenOk(req)) return res.status(401).json({ error: 'unauthorized' });
    const wo = unwrapRecord(req.body);
    if (!wo) return res.status(200).json({ ok: true, skipped: 'empty body' });
    const woId = String(wo.jnid || wo.id || '');
    const opts = { dryrun: req.query.dryrun === '1', any: req.query.any === '1' };
    log('webhook', woId || '(no jnid)', 'type=', wo.record_type_name, 'status=', wo.status_name, opts.dryrun ? 'dryrun' : '');
    try {
      let p = woId && !opts.dryrun ? inflight.get(woId) : null;
      if (!p) {
        p = createTestingJob(wo, opts);
        if (woId && !opts.dryrun) { inflight.set(woId, p); p.finally(() => setTimeout(() => inflight.delete(woId), 60000)); }
      }
      const out = await p;
      if (out.skipped) log(woId, 'skipped:', out.skipped);
      res.json(out);
    } catch (err) {
      warn(woId, 'error', err.message);
      res.status(err.status && err.status >= 400 ? err.status : 500).json({ ok: false, error: err.message, work_order: woId });
    }
  });

  return { createTestingJob };
}

module.exports = mountTestingJobs;
module.exports.USERS = USERS;
module.exports.DEFAULT_OWNER_RULES = DEFAULT_OWNER_RULES;
module.exports.LOCATIONS = LOCATIONS;
module.exports.DEFAULT_LOCATION_RULES = DEFAULT_LOCATION_RULES;
module.exports.stateCode = stateCode;
module.exports.testingLocationFor = testingLocationFor;
module.exports.cityAbbrFromJobName = cityAbbrFromJobName;
module.exports.cityAbbrForCity = cityAbbrForCity;
module.exports.baseNameOf = baseNameOf;
module.exports.mostCommonAbbr = mostCommonAbbr;
module.exports.testingJobName = testingJobName;
module.exports.testingOwnersFor = testingOwnersFor;
module.exports.isTestingWorkOrder = isTestingWorkOrder;
module.exports.pickLeadSource = pickLeadSource;
