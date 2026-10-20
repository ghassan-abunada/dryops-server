// Testing job from a testing work order (testingJobs.js): the pure pieces —
// city code from a job suffix, owner rules, lead-source match — and one full
// run of createTestingJob against fake JobNimbus/Supabase deps. Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const mount = require('../testingJobs');
const { USERS, LOCATIONS, cityAbbrFromJobName, baseNameOf, testingJobName, testingOwnersFor, isTestingWorkOrder, pickLeadSource, stateCode, testingLocationFor, mostCommonAbbr, matchedOwnerRules } = mount;

test('cityAbbrFromJobName reads the city code out of the job suffix', () => {
  assert.strictEqual(cityAbbrFromJobName('Jeremy Eihausen (AFF - DAL - MIT)'), 'DAL');
  assert.strictEqual(cityAbbrFromJobName('Nan Fitz Gerald (POR-MIT)'), 'POR');
  assert.strictEqual(cityAbbrFromJobName('Jane Doe (24 - DAL - MIT)'), 'DAL');
  assert.strictEqual(cityAbbrFromJobName('Jeremy Eihausen (FTW - CON)'), 'FTW');
  assert.strictEqual(cityAbbrFromJobName('Timothy Winters (SAN - MIT)'), 'SAN');
  assert.strictEqual(cityAbbrFromJobName('Jeremy Eihausen (AFF - DAL)'), 'DAL');
  assert.strictEqual(cityAbbrFromJobName('Erika Endicott (BOI-MIT) '), 'BOI');
  assert.strictEqual(cityAbbrFromJobName('Timothy Winters (SAN MIT)'), 'SAN');
  assert.strictEqual(cityAbbrFromJobName('Rhonda Jordan (TEM-MIT)'), 'TEM');
  assert.strictEqual(cityAbbrFromJobName('Someone (24 Hour)'), null);
  assert.strictEqual(cityAbbrFromJobName('No Suffix Here'), null);
  assert.strictEqual(cityAbbrFromJobName('Only Type (MIT)'), null);
  assert.strictEqual(cityAbbrFromJobName('Weird (SunRun)'), null);
  assert.strictEqual(cityAbbrFromJobName(''), null);
  assert.strictEqual(cityAbbrFromJobName(null), null);
});

test('mostCommonAbbr picks the majority code, ignoring nulls', () => {
  assert.strictEqual(mostCommonAbbr(['OAH', null, 'OAH', 'HON', null]), 'OAH');
  assert.strictEqual(mostCommonAbbr([null, null]), null);
  assert.strictEqual(mostCommonAbbr([]), null);
});

test('baseNameOf + testingJobName build "(CTY - TST)" names', () => {
  assert.strictEqual(baseNameOf('Jeremy Eihausen (AFF - DAL - MIT)'), 'Jeremy Eihausen');
  assert.strictEqual(baseNameOf('Josh  Gawlista (POR-MIT)'), 'Josh Gawlista');
  assert.strictEqual(testingJobName('Jeremy Eihausen', 'DAL'), 'Jeremy Eihausen (DAL - TST)');
  assert.strictEqual(testingJobName('Jeremy Eihausen', 'DAL', 2), 'Jeremy Eihausen (DAL - TST) 2');
});

test('owners: Saleah + Jalisa everywhere, plus each market\'s regulars — never Joe Brooks', () => {
  const base = [USERS.saleahCrawford, USERS.jalisaHillATS];
  const JOE_BROOKS = 'lpy3vv8z8mnftpa63t1k0j';
  const cases = [
    [{ abbr: 'HOU', state: 'TX', locationName: 'Texas Water and Fire of Houston' }, base, []],
    [{ abbr: 'DAL', state: 'TX', locationName: 'American Fire and Flood of Dallas' }, [...base, USERS.dominickGarcia], ['dallas']],
    [{ abbr: 'XYZ', state: 'TX', locationName: 'Texas Water and Fire of Dallas' }, [...base, USERS.dominickGarcia], ['dallas']],
    [{ abbr: 'TWM', state: 'TX', locationName: 'TWM Restoration' }, [...base, USERS.dominickGarcia], ['dallas']],
    [{ abbr: 'SAN', state: 'TX' }, [...base, USERS.willLeBrun], ['san_antonio']],
    [{ abbr: 'SAT', state: 'TX' }, [...base, USERS.willLeBrun], ['san_antonio']],
    [{ abbr: 'SA', state: 'TX', locationName: 'American Fire and Flood of San Antonio' }, [...base, USERS.willLeBrun], ['san_antonio']],
    [{ abbr: 'AWD', state: 'TX', locationName: 'American Water Damage' }, [...base, USERS.willLeBrun], ['san_antonio']],
    [{ abbr: 'DEN', state: 'CO', locationName: 'Colorado Water and Fire' }, [...base, USERS.robertMartinez, USERS.hershalJohnson], ['colorado']],
    [{ abbr: 'COS', state: 'CO' }, [...base, USERS.robertMartinez, USERS.hershalJohnson], ['colorado']],
    [{ abbr: null, state: 'Colorado' }, [...base, USERS.robertMartinez, USERS.hershalJohnson], ['colorado']],
    [{ abbr: 'RWD', state: 'AZ', locationName: 'Rhino Water & Damage of Arizona' }, [...base, USERS.derekLewisWTE], ['arizona']],
    [{ abbr: 'PHX', state: 'Arizona' }, [...base, USERS.derekLewisWTE], ['arizona']],
    [{ abbr: 'DET', state: 'MI', locationName: 'Doan Restoration' }, [...base, USERS.jackRepokis], ['detroit']],
    [{ abbr: null, state: 'MI' }, [...base, USERS.jackRepokis], ['detroit']],
    [{ abbr: 'POR', state: 'OR', locationName: '24 Hour Flood Pros of Portland' }, [...base, USERS.ianNelson], ['oregon']],
    [{ abbr: 'SLE', state: 'OR' }, [...base, USERS.ianNelson], ['oregon']],
    [{ abbr: 'POR', state: 'WA', locationName: 'Any Hour Water and Fire' }, [...base, USERS.ianNelson], ['oregon']],
    [{ abbr: 'OAH', state: 'HI', locationName: '24 Hour Flood Pros of Oahu' }, [...base, USERS.marwinjayVillegas], ['hawaii']],
    [{ abbr: 'MAU', state: 'Hawaii' }, [...base, USERS.marwinjayVillegas], ['hawaii']],
    [{ abbr: null, state: null, locationName: 'Right-Now Restoration of Hawaii' }, [...base, USERS.marwinjayVillegas], ['hawaii']],
    [{ abbr: 'UWF', state: 'UT', locationName: 'Utah Water & Fire' }, base, []],
    [{ abbr: 'CA', state: 'CA', locationName: 'A1 Restoration' }, base, []],
    [{ abbr: 'FTW', state: 'TX', locationName: 'Gurr Brothers Construction of Texas (Dallas)' }, [...base, USERS.dominickGarcia], ['dallas']],
  ];
  for (const [ctx, want, rules] of cases) {
    assert.deepStrictEqual(testingOwnersFor(ctx), want, JSON.stringify(ctx));
    assert.deepStrictEqual(matchedOwnerRules(ctx), rules, JSON.stringify(ctx));
    assert.ok(!testingOwnersFor(ctx).includes(JOE_BROOKS), 'Joe Brooks must never be assigned');
  }
  assert.ok(!Object.values(USERS).includes(JOE_BROOKS), 'Joe Brooks is not in the user table at all');
  // env-style override replaces one rule's owners (empty = nobody)
  const rules = [{ key: 'always', owners: ['a'], match: () => true }, { key: 'dallas', owners: [], codes: ['DAL'] }, { key: 'x', owners: ['b'], states: ['NV'] }];
  assert.deepStrictEqual(testingOwnersFor({ abbr: 'DAL', state: 'TX' }, rules), ['a']);
  assert.deepStrictEqual(testingOwnersFor({ abbr: 'LAS', state: 'nv' }, rules), ['a', 'b']);
});

test('isTestingWorkOrder gates on the record type or the ATS subcontractor', () => {
  assert.ok(isTestingWorkOrder({ record_type_name: 'Asbestos Testing' }));
  assert.ok(isTestingWorkOrder({ record_type_name: 'Mold Testing' }));
  assert.ok(isTestingWorkOrder({ record_type_name: 'Repair', subcontractors: [{ name: 'Abatement Testing Services' }] }));
  assert.ok(!isTestingWorkOrder({ record_type_name: 'Contents / Pack Out', subcontractors: [] }));
  assert.ok(!isTestingWorkOrder(null));
});

test('pickLeadSource matches the referring company name', () => {
  const sources = [
    { id: 554, name: 'American Fire and Flood', active: true },
    { id: 507, name: 'American Fire and Flood of San Antonio', active: false },
    { id: 550, name: '24 Hour Flood Pros', active: true },
    { id: 782, name: 'Boise River Restoration', active: true },
    { id: 2, name: 'Rhino Water Damage of Omaha', active: true },
  ];
  assert.deepStrictEqual(pickLeadSource(sources, 'American Fire and Flood of Dallas'), { id: 554, name: 'American Fire and Flood' });
  assert.deepStrictEqual(pickLeadSource(sources, 'American Fire and Flood of San Antonio'), { id: 554, name: 'American Fire and Flood' }, 'active parent beats the retired city source');
  assert.deepStrictEqual(pickLeadSource([sources[1]], 'American Fire and Flood of San Antonio'), { id: 507, name: 'American Fire and Flood of San Antonio' }, 'inactive is the last resort');
  assert.deepStrictEqual(pickLeadSource(sources, '24 Hour Flood Pros of Dallas'), { id: 550, name: '24 Hour Flood Pros' });
  assert.deepStrictEqual(pickLeadSource(sources, '24 Hour Flood Pros, LLC'), { id: 550, name: '24 Hour Flood Pros' });
  assert.deepStrictEqual(pickLeadSource(sources, 'Boise River Restoration'), { id: 782, name: 'Boise River Restoration' });
  assert.deepStrictEqual(pickLeadSource(sources, 'Rhino Water Damage of Omaha'), { id: 2, name: 'Rhino Water Damage of Omaha' });
  assert.strictEqual(pickLeadSource(sources, 'Unknown Co of Nowhere'), null);
  assert.strictEqual(pickLeadSource(sources, ''), null);
});

test('stateCode normalizes codes and full names', () => {
  assert.strictEqual(stateCode('TX'), 'TX');
  assert.strictEqual(stateCode(' tx '), 'TX');
  assert.strictEqual(stateCode('Texas'), 'TX');
  assert.strictEqual(stateCode('Arizona'), 'AZ');
  assert.strictEqual(stateCode('hawaii'), 'HI');
  assert.strictEqual(stateCode('New Mexico'), 'NM');
  assert.strictEqual(stateCode('Nowhere'), null);
  assert.strictEqual(stateCode(''), null);
  assert.strictEqual(stateCode(null), null);
});

test('testingLocationFor: AZ and HI go to White Tail Environmental, the rest to ATS', () => {
  assert.strictEqual(testingLocationFor({ state: 'AZ' }), LOCATIONS.whiteTailEnvironmental);
  assert.strictEqual(testingLocationFor({ state: 'Arizona' }), 30);
  assert.strictEqual(testingLocationFor({ state: 'HI' }), 30);
  assert.strictEqual(testingLocationFor({ state: 'Hawaii' }), 30);
  assert.strictEqual(testingLocationFor({ state: 'TX' }), LOCATIONS.abatementTestingServices);
  assert.strictEqual(testingLocationFor({ state: 'MI' }), 198);
  assert.strictEqual(testingLocationFor({ state: null }), 198);
  // env-style override
  assert.strictEqual(testingLocationFor({ state: 'NV' }, { default: 1, whiteTail: 2, whiteTailStates: ['nv'] }), 2);
});

// ── full run with fake deps ─────────────────────────────────────────────────
const T0 = Date.UTC(2026, 9, 20, 12) / 1000;
const SRC_JOB = {
  jnid: 'mvg0w26yab617lx71y33y02', name: 'Jeremy Eihausen (AFF - DAL - MIT)', record_type_name: 'Mitigation', status_name: 'In Progress',
  location: { id: 322 }, primary: { id: 'mvg0w1j2lioe7den99ab9ha', name: 'Jeremy Eihausen (AFF - DAL)', type: 'contact' },
  related: [{ id: 'mvg0w1j2lioe7den99ab9ha', type: 'contact' }],
  address_line1: '407 Menlo Park Dr', city: 'Garland', state_text: 'Texas', zip: '75043', country_name: 'United States', geo: { lat: 32.85146, lon: -96.6001 },
  cf_string_6: 'Google', cf_string_7: '', cf_string_18: 'CAT 2', cf_date_1: 1791781200, cf_string_2: 'CLM-1', cf_string_3: '', date_created: T0 - 3600,
};
const WO = {
  jnid: 'a47289d39d24493cbadda580122d34ae', number: '21161', record_type_name: 'Asbestos Testing', status_name: 'New', location: { id: 322 },
  related: [{ id: SRC_JOB.jnid, name: SRC_JOB.name, type: 'job' }, { id: 'mvg0w1j2lioe7den99ab9ha', type: 'contact' }],
  subcontractors: [{ id: 'lru3a3f8pbjepoa1g3gybrg', name: 'Abatement Testing Services' }],
  cf_string_7: 'Insurance', internal_note: 'HO is at work. Key under the mat.',
};
const SETTINGS = {
  sources: [{ JobSourceId: 554, SourceName: 'American Fire and Flood', IsActive: true }],
  locations: [{ id: 322, name: 'American Fire and Flood of Dallas', city: 'Carrollton', state_text: 'TX' }, { id: 198, name: 'Abatement Testing Services', city: 'Novi', state_text: 'MI' }, { id: 91, name: 'Rhino Water and Damage of Arizona', city: 'Phoenix', state_text: 'AZ' }],
  workflows: [{ id: 124, name: 'Testing', object_type: 'job', is_active: true }],
};
function fakeDeps(over = {}) {
  const calls = { posts: [], notes: [], searches: [] };
  const existingJobs = over.existingJobs || [];
  const deps = {
    webhookTokenOk: () => true,
    unwrapRecord: (b) => { let r = b; if (r && typeof r === 'object' && r.data && typeof r.data === 'object') r = r.data; if (Array.isArray(r)) r = r[0]; return r && typeof r === 'object' ? r : null; },
    sbGet: async (q) => (/jn_location_id=eq\.322/.test(q) ? [{ city_abbr: 'DAL', jn_note_tag: '@GTA' }] : []),
    jnGetJson: async (p) => { if (p === 'account/settings') return SETTINGS; throw new Error('unexpected ' + p); },
    jnFetchAccountUsers: async () => new Map([
      [USERS.saleahCrawford, { name: 'Saleah Crawford', active: true }], [USERS.jalisaHillATS, { name: 'Jalisa Hill ATS', active: true }],
      [USERS.dominickGarcia, { name: 'Dominick Garcia', active: true }], [USERS.willLeBrun, { name: 'Will LeBrun', active: true }],
      [USERS.derekLewisWTE, { name: 'Derek Lewis WTE', active: true }], [USERS.marwinjayVillegas, { name: 'Marwinjay Villegas', active: true }],
      [USERS.robertMartinez, { name: 'Robert Martinez', active: true }], [USERS.hershalJohnson, { name: 'Hershal Johnson', active: true }],
      [USERS.jackRepokis, { name: 'Jack Repokis', active: true }], [USERS.ianNelson, { name: 'Ian Nelson', active: true }],
    ]),
    jnSendJson: async (method, path, body) => {
      if (method === 'GET' && path.startsWith('jobs/' + SRC_JOB.jnid)) return { ok: true, status: 200, body: over.source || SRC_JOB };
      if (method === 'GET' && path.startsWith('workorders/')) return { ok: true, status: 200, body: WO };
      if (method === 'GET' && path.startsWith('jobs?')) {
        const filter = JSON.parse(decodeURIComponent(path.split('filter=')[1]));
        calls.searches.push(filter);
        const term = Object.assign({}, ...filter.must.map((m) => m.term));
        if (term.external_id) return { ok: true, status: 200, body: { results: existingJobs.filter((j) => j.external_id === term.external_id) } };
        if (term.name) return { ok: true, status: 200, body: { results: existingJobs.filter((j) => j.name === term.name) } };
        if (term['primary.id']) return { ok: true, status: 200, body: { results: existingJobs.filter((j) => j.primary_id === term['primary.id']) } };
        if (term['location.id']) return { ok: true, status: 200, body: { results: (over.siblings || []).map((name) => ({ name })) } };
        return { ok: true, status: 200, body: { results: [] } };
      }
      if (method === 'POST' && path === 'jobs') { calls.posts.push(body); return { ok: true, status: 200, body: { jnid: 'newjob123' } }; }
      throw new Error(`unexpected ${method} ${path}`);
    },
    jnAddNote: async (id, text, opts) => { calls.notes.push({ id, text, opts }); return { ok: true, id: 'note-' + calls.notes.length }; },
    log: () => {}, warn: () => {}, now: () => T0 * 1000,
    ...over.deps,
  };
  const routes = {};
  const app = { post: (p, h) => { routes[p] = h; }, get: (p, h) => { routes[p] = h; } };
  const api = mount(app, deps);
  return { api, calls, routes };
}

test('createTestingJob builds the Testing job the way the office does by hand', async () => {
  const { api, calls } = fakeDeps();
  const out = await api.createTestingJob(WO);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.job.name, 'Jeremy Eihausen (DAL - TST)');
  assert.strictEqual(out.job.jn_id, 'newjob123');
  assert.strictEqual(out.city_abbr, 'DAL');
  assert.deepStrictEqual(out.owners, [USERS.saleahCrawford, USERS.jalisaHillATS, USERS.dominickGarcia]);
  assert.deepStrictEqual(out.owner_rules, ['dallas']);
  assert.deepStrictEqual(out.warnings, []);
  assert.strictEqual(calls.posts.length, 1);
  const p = calls.posts[0];
  assert.strictEqual(p.record_type_name, 'Testing');
  assert.strictEqual(p.status_name, 'Lead');
  assert.strictEqual(p.external_id, 'testing-wo:' + WO.jnid);
  assert.deepStrictEqual(p.primary, { id: 'mvg0w1j2lioe7den99ab9ha', type: 'contact' });
  assert.deepStrictEqual(p.related, [{ id: 'mvg0w1j2lioe7den99ab9ha', type: 'contact' }]);
  assert.deepStrictEqual(p.location, { id: 198 }, 'Texas → Abatement Testing Services');
  assert.strictEqual(out.state, 'TX');
  assert.strictEqual(out.job.location_id, 198);
  assert.deepStrictEqual(p.owners, [{ id: USERS.saleahCrawford }, { id: USERS.jalisaHillATS }, { id: USERS.dominickGarcia }]);
  assert.strictEqual(p.source, 554);
  assert.strictEqual(p.cf_string_6, 'Internal Referral');
  assert.strictEqual(p.cf_string_7, 'Insurance');
  assert.strictEqual(p.cf_string_18, 'CAT 2');
  assert.strictEqual(p.cf_date_1, 1791781200);
  assert.strictEqual(p.cf_string_2, 'CLM-1');
  assert.ok(!('cf_string_3' in p), 'empty source fields are not sent');
  assert.strictEqual(p.address_line1, '407 Menlo Park Dr');
  assert.deepStrictEqual(p.geo, { lat: 32.85146, lon: -96.6001 });
  assert.strictEqual(p.description, 'Asbestos Testing — work order #21161 on Jeremy Eihausen (AFF - DAL - MIT)');
  // notes: one on the new job tagging the owners (ATS location), one on the source job
  assert.strictEqual(calls.notes.length, 2);
  assert.strictEqual(calls.notes[0].id, 'newjob123');
  assert.match(calls.notes[0].text, /Created automatically from Asbestos Testing work order #21161 on Jeremy Eihausen \(AFF - DAL - MIT\)/);
  assert.match(calls.notes[0].text, /Internal note: HO is at work/);
  assert.deepStrictEqual(calls.notes[0].opts.mentions, ['@SaleahCrawford', '@JalisaHillATS', '@DominickGarcia']);
  assert.strictEqual(calls.notes[0].opts.jnLocationId, 198);
  assert.strictEqual(calls.notes[1].id, SRC_JOB.jnid);
  assert.match(calls.notes[1].text, /Testing job created: Jeremy Eihausen \(DAL - TST\)/);
  assert.strictEqual(calls.notes[1].opts.jnLocationId, 322);
  assert.strictEqual(calls.notes[1].opts.tag, '@GTA');
});

test('a bare {jnid} body loads the work order; dryrun writes nothing', async () => {
  const { api, calls } = fakeDeps();
  const out = await api.createTestingJob({ jnid: WO.jnid }, { dryrun: true });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.dryrun, true);
  assert.strictEqual(out.job.name, 'Jeremy Eihausen (DAL - TST)');
  assert.strictEqual(out.payload.name, 'Jeremy Eihausen (DAL - TST)');
  assert.strictEqual(calls.posts.length, 0);
  assert.strictEqual(calls.notes.length, 0);
});

test('non-testing work orders are skipped unless any=1', async () => {
  const { api, calls } = fakeDeps();
  const out = await api.createTestingJob({ ...WO, record_type_name: 'Contents / Pack Out', subcontractors: [] });
  assert.match(out.skipped, /not a testing work order/);
  assert.strictEqual(calls.posts.length, 0);
  const forced = await api.createTestingJob({ ...WO, record_type_name: 'Contents / Pack Out', subcontractors: [] }, { any: true });
  assert.strictEqual(forced.job.name, 'Jeremy Eihausen (DAL - TST)');
});

test('redelivery replays the job already created for that work order', async () => {
  const { api, calls } = fakeDeps({ existingJobs: [{ jnid: 'old1', name: 'Jeremy Eihausen (DAL - TST)', external_id: 'testing-wo:' + WO.jnid }] });
  const out = await api.createTestingJob(WO);
  assert.strictEqual(out.replay, true);
  assert.strictEqual(out.job.jn_id, 'old1');
  assert.strictEqual(calls.posts.length, 0);
});

test('a contact with a recent active Testing job gets no second one', async () => {
  const recent = { jnid: 'old2', name: 'Jeremy Eihausen (DAL-TST)', record_type_name: 'Testing', is_active: true, date_created: T0 - 5 * 86400, primary_id: 'mvg0w1j2lioe7den99ab9ha' };
  const { api, calls } = fakeDeps({ existingJobs: [recent] });
  const out = await api.createTestingJob(WO);
  assert.match(out.skipped, /already has an active Testing job/);
  assert.strictEqual(out.job.jn_id, 'old2');
  assert.strictEqual(calls.posts.length, 0);
  // …but an old one (> 90 days) or an inactive one does not block
  const stale = fakeDeps({ existingJobs: [{ ...recent, date_created: T0 - 120 * 86400 }, { ...recent, jnid: 'old3', is_active: false }] });
  const out2 = await stale.api.createTestingJob(WO);
  assert.strictEqual(out2.job.jn_id, 'newjob123');
});

test('taken names fall back to "(DAL - TST) 2"', async () => {
  const { api, calls } = fakeDeps({ existingJobs: [{ jnid: 'x', name: 'Jeremy Eihausen (DAL - TST)', primary_id: 'someone-else' }] });
  const out = await api.createTestingJob(WO);
  assert.strictEqual(out.job.name, 'Jeremy Eihausen (DAL - TST) 2');
  assert.ok(out.warnings.includes('NAME_FALLBACK_USED'));
  assert.strictEqual(calls.posts[0].name, 'Jeremy Eihausen (DAL - TST) 2');
});

test('San Antonio source job adds Will LeBrun; no suffix falls back to the DryOps city_abbr', async () => {
  const srcSA = { ...SRC_JOB, name: 'Timothy Winters (AFF - SAN - MIT)', location: { id: 260 } };
  const settings = { ...SETTINGS, locations: [...SETTINGS.locations, { id: 260, name: 'American Fire and Flood of San Antonio', city: 'San Antonio' }] };
  const { api } = fakeDeps({ deps: {
    jnGetJson: async () => settings,
    jnSendJson: async (method, path, body) => {
      if (method === 'GET' && path.startsWith('jobs/')) return { ok: true, status: 200, body: srcSA };
      if (method === 'GET') return { ok: true, status: 200, body: { results: [] } };
      return { ok: true, status: 200, body: { jnid: 'sa1' } };
    },
  } });
  const out = await api.createTestingJob({ ...WO, location: { id: 260 } });
  assert.strictEqual(out.job.name, 'Timothy Winters (SAN - TST)');
  assert.deepStrictEqual(out.owners, [USERS.saleahCrawford, USERS.jalisaHillATS, USERS.willLeBrun]);

  const noSuffix = { ...SRC_JOB, name: 'Plain Name' };
  const { api: api2 } = fakeDeps({ deps: {
    jnSendJson: async (method, path, body) => {
      if (method === 'GET' && path.startsWith('jobs/')) return { ok: true, status: 200, body: noSuffix };
      if (method === 'GET') return { ok: true, status: 200, body: { results: [] } };
      return { ok: true, status: 200, body: { jnid: 'ns1' } };
    },
  } });
  const out2 = await api2.createTestingJob(WO);
  assert.strictEqual(out2.job.name, 'Plain Name (DAL - TST)');
  assert.ok(out2.warnings.includes('CITY_FROM_DRYOPS_LOCATION'));
});

test('no suffix: sibling jobs at the same location decide the code, then the job city', async () => {
  const noSuffix = { ...SRC_JOB, name: 'Johnathan Bolton', state_text: 'HI', city: 'Ewa', location: { id: 314 } };
  const hawaii = { id: 314, name: 'Right-Now Restoration of Hawaii', city: '', state_text: '' };
  const mk = (siblings, source) => fakeDeps({ siblings, source, deps: {
    jnGetJson: async () => ({ ...SETTINGS, locations: [hawaii] }),
    sbGet: async () => [],
  } }).api;
  const out = await mk(['Curtis Martin', 'Joe Walker (OAH-MIT)', 'Dane Hina (OAH-MIT)', 'May Andresen (OAH MIT)'], noSuffix).createTestingJob(WO);
  assert.strictEqual(out.job.name, 'Johnathan Bolton (OAH - TST)');
  assert.strictEqual(out.job.location_id, 30, 'state on the job → White Tail');
  assert.ok(out.warnings.includes('CITY_FROM_SIBLING_JOBS'));
  assert.deepStrictEqual(out.owner_rules, ['hawaii']);
  assert.ok(out.warnings.includes('NO_LEAD_SOURCE'), 'Right-Now Restoration has no JN source in the fake settings');

  const out2 = await mk(['Curtis Martin'], noSuffix).createTestingJob(WO);
  assert.strictEqual(out2.job.name, 'Johnathan Bolton (EWA - TST)');
  assert.ok(out2.warnings.includes('CITY_FROM_JOB_CITY'));

  await assert.rejects(() => mk([], { ...noSuffix, city: '' }).createTestingJob(WO), /cannot work out a city code/);
});

test('Arizona and Hawaii source jobs land on White Tail Environmental (30)', async () => {
  const run = async (srcOver, woOver = {}) => {
    const src = { ...SRC_JOB, ...srcOver };
    const { api, calls } = fakeDeps({ deps: {
      jnSendJson: async (method, path) => {
        if (method === 'GET' && path.startsWith('jobs/')) return { ok: true, status: 200, body: src };
        if (method === 'GET') return { ok: true, status: 200, body: { results: [] } };
        calls.posts.push(path); return { ok: true, status: 200, body: { jnid: 'wt1' } };
      },
    } });
    const out = await api.createTestingJob({ ...WO, ...woOver });
    return { out, calls };
  };
  const az = await run({ name: 'Vince LoCascio (RWD-MIT)', state_text: 'AZ', city: 'Queen Creek', location: { id: 91 } });
  assert.strictEqual(az.out.job.name, 'Vince LoCascio (RWD - TST)');
  assert.strictEqual(az.out.state, 'AZ');
  assert.strictEqual(az.out.job.location_id, 30);
  assert.deepStrictEqual(az.out.payload.location, { id: 30 });
  assert.strictEqual(az.calls.notes[0].opts.jnLocationId, 30, 'note on the new job uses the same location');
  assert.deepStrictEqual(az.out.owners, [USERS.saleahCrawford, USERS.jalisaHillATS, USERS.derekLewisWTE], 'Arizona adds Derek Lewis');
  assert.deepStrictEqual(az.calls.notes[0].opts.mentions, ['@SaleahCrawford', '@JalisaHillATS', '@DerekLewisWTE']);

  const hi = await run({ name: 'Koren Ihara (OAH-MIT)', state_text: 'Hawaii', city: 'Honolulu', location: { id: 34 } });
  assert.strictEqual(hi.out.job.location_id, 30);
  assert.deepStrictEqual(hi.out.owners, [USERS.saleahCrawford, USERS.jalisaHillATS, USERS.marwinjayVillegas], 'Hawaii adds Marwinjay Villegas');

  // no state on the job → the JN location's state decides
  const fb = await run({ name: 'Vince LoCascio (RWD-MIT)', state_text: '', location: { id: 91 } });
  assert.strictEqual(fb.out.job.location_id, 30);
  assert.ok(fb.out.warnings.includes('STATE_FROM_JN_LOCATION'));

  // Dallas still goes to ATS with Dominick
  const tx = await run({});
  assert.strictEqual(tx.out.job.location_id, 198);
});

test('webhook route: token gate, skip reasons, and error status', async () => {
  const { routes, calls } = fakeDeps({ deps: { webhookTokenOk: (req) => req.query.token === 'ok' } });
  const h = routes['/webhooks/jobnimbus/testing-workorder'];
  const run = async (query, body) => {
    const res = { status(c) { this.code = c; return this; }, json(j) { this.body = j; return this; } };
    await h({ query, body }, res);
    return { code: res.code || 200, body: res.body };
  };
  assert.strictEqual((await run({ token: 'no' }, WO)).code, 401);
  assert.strictEqual((await run({ token: 'ok' }, null)).body.skipped, 'empty body');
  const ok = await run({ token: 'ok' }, { data: WO });
  assert.strictEqual(ok.code, 200);
  assert.strictEqual(ok.body.job.name, 'Jeremy Eihausen (DAL - TST)');
  assert.strictEqual(calls.posts.length, 1);
  const bad = await run({ token: 'ok' }, { jnid: 'zzz', related: [], record_type_name: 'Mold Testing' });
  assert.strictEqual(bad.body.skipped, 'work order has no related job');
});
