// WIP dashboard, managers/admin portal, estimates, PDFs and the review
// progress run — end to end over express with the in-memory Supabase in
// test/wipFixtures.js. Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { makeStore, LOC, POOL, MGR, TOKENS, J } = require('./wipFixtures');

const SB = 'https://sb.test';

function boot({ anthropic = null, jnGet = async () => ({ activity: [] }), logo = true } = {}) {
  // The dashboard's "last week" is relative to the real clock, so seed around it.
  const probe = require('../wip')(express(), { SUPABASE_URL: SB, SUPABASE_SERVICE_KEY: 'k', jnGet, anthropic: null }, { noSchedule: true });
  const lw = probe.lastWeek();
  const fx = makeStore(lw);
  const restore = fx.install(SB);
  const app = express(); app.use(express.json());
  const wip = require('../wip')(app, {
    SUPABASE_URL: SB, SUPABASE_SERVICE_KEY: 'svc', jnGet, anthropic,
    locationLogoUrl: logo ? async (loc) => loc.logo_url || (loc.name === 'AFF Dallas' ? 'https://cdn.test/aff-brand.png' : null) : undefined,
    logoPngFromUrl: async () => null,
  }, { noSchedule: true });
  return new Promise(resolve => {
    const srv = app.listen(0, () => resolve({
      base: `http://127.0.0.1:${srv.address().port}`, wip, fx, lw,
      close: () => { srv.close(); restore(); },
    }));
  });
}
const get = async (url) => { const r = await fetch(url); const ct = r.headers.get('content-type') || ''; return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : ct.includes('pdf') ? Buffer.from(await r.arrayBuffer()) : await r.text() }; };
const send = async (url, method, body) => { const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) { /* text */ } return { status: r.status, body: j != null ? j : t }; };
const pdfPages = buf => (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;

test('lastWeek: previous Mon–Sun in Central, from any weekday', async () => {
  const h = await boot();
  try {
    const w = h.wip.lastWeek;
    assert.deepStrictEqual(w(new Date('2026-10-24T11:30:00Z')), { start: '2026-10-12', end: '2026-10-18', endExclusive: '2026-10-19' }); // Saturday
    assert.deepStrictEqual(w(new Date('2026-10-26T15:00:00Z')), { start: '2026-10-19', end: '2026-10-25', endExclusive: '2026-10-26' }); // Monday
    assert.deepStrictEqual(w(new Date('2026-10-26T03:30:00Z')), { start: '2026-10-12', end: '2026-10-18', endExclusive: '2026-10-19' }); // Sun 10:30 PM Central
    assert.strictEqual(h.wip.chicagoMidnightIso('2026-10-12'), '2026-10-12T05:00:00.000Z'); // CDT
    assert.strictEqual(h.wip.chicagoMidnightIso('2026-12-07'), '2026-12-07T06:00:00.000Z'); // CST
  } finally { h.close(); }
});

test('stale in_progress entry on an invoiced job no longer counts as In Progress', async () => {
  const h = await boot();
  try {
    const text = (await get(`${h.base}/wip/${TOKENS.a1}/text?preview=1`)).body;
    assert.match(text, /^A1 DALLAS · WEEK OF [A-Z]{3} \d+\nIn Progress · 2 jobs · \$8,000\n/, text); // j6 ($6k, now Invoice Created) is gone; Dan (Work Complete) counts, no value yet
    assert.match(text, /IN PROGRESS\nCara Lee — \$8k · drying\nDan Smith — no number yet · OOP\n/, text);
    assert.ok(!/Finn Moore/.test(text), 'invoiced job must not keep its In Progress value');
    assert.match(text, /Collecting this week · 1 · \$1,235\n/);
    assert.match(text, /COLLECTING THIS WEEK\nAlice Johnson — \$1,234\.57 · Carrier mailed the check Oct 9/);
    assert.strictEqual(h.fx.store.wip_snapshots.length, 2, 'preview must not save a snapshot');
  } finally { h.close(); }
});

test('owner save records estimate history only when the amount changes; survives a missing table', async () => {
  const h = await boot();
  try {
    const r1 = await send(`${h.base}/wip/${TOKENS.a1}/entries`, 'POST', { updated_by: 'Sam', entries: [
      { key: J.j3, category: 'in_progress', amount: 8000, note: 'drying' },     // unchanged → no row
      { key: J.j4, category: 'in_progress', amount: 15000 },                     // new → row
      { key: 'custom:abc', category: 'in_progress', amount: 500, custom_name: 'Side job' }, // custom → ignored
    ] });
    assert.deepStrictEqual(r1.body, { ok: true, saved: 3, estimates: 1 });
    const rows = h.fx.store.wip_job_estimates.filter(e => e.job_id === J.j4);
    assert.deepStrictEqual(rows.map(e => [e.amount, e.entered_by]), [[15000, 'Sam']]);
    const r2 = await send(`${h.base}/wip/${TOKENS.a1}/entries`, 'POST', { updated_by: 'Sam', entries: [{ key: J.j4, category: 'in_progress', amount: 15000 }] });
    assert.strictEqual(r2.body.estimates, 0);
    delete h.fx.store.wip_job_estimates; // table not migrated yet
    const r3 = await send(`${h.base}/wip/${TOKENS.a1}/entries`, 'POST', { updated_by: 'Sam', entries: [{ key: J.j4, category: 'in_progress', amount: 16000 }] });
    assert.deepStrictEqual(r3.body, { ok: true, saved: 1, estimates: 0 });
  } finally { h.close(); }
});

test('owner form: location logo in the header when one resolves, apple-touch-icon follows', async () => {
  const h = await boot();
  try {
    const a1 = (await get(`${h.base}/wip/${TOKENS.a1}`)).body;
    assert.match(a1, /<div class="top"><img class="logo" src="https:\/\/cdn\.test\/a1\.png" alt=""><div class="ttl"><h1>A1 Dallas<\/h1>/);
    assert.match(a1, /apple-touch-icon" href="https:\/\/cdn\.test\/a1\.png"/);
    const aff = (await get(`${h.base}/wip/${TOKENS.aff}`)).body; // brand pack via locationLogoUrl
    assert.match(aff, /<img class="logo" src="https:\/\/cdn\.test\/aff-brand\.png"/);
    const hr = (await get(`${h.base}/wip/${TOKENS.hr}`)).body;   // nothing → plain header
    assert.match(hr, /<div class="top"><div class="ttl"><h1>24 HR<\/h1>/);
    // Dan Smith is out of pocket: the card carries the OOP flag and the review's reason rides on Alice's row.
    assert.match(a1, /"oop":true/);
    assert.match(a1, /"ai_reason":"Carrier mailed the check Oct 9; expected by Oct 29\."/);
  } finally { h.close(); }
});

test('dashboard numbers: last week collected/invoiced, forecast vs actual, needs-a-number, estimate accuracy', async () => {
  const h = await boot();
  try {
    const pools = await h.fx.store.wip_pool.map(p => ({ ...p, locations: h.fx.store.locations.find(l => l.id === p.location_id) }));
    const d = await h.wip.loadDashboard(pools);
    const a1 = d.locations.find(l => l.id === POOL.a1), aff = d.locations.find(l => l.id === POOL.aff), hr = d.locations.find(l => l.id === POOL.hr);
    assert.deepStrictEqual([a1.collected, a1.invoiced], [4300.5, 7200]);   // credit memo + old payment excluded; old invoice excluded
    assert.deepStrictEqual([aff.collected, aff.invoiced], [999, 0]);
    assert.deepStrictEqual([hr.collected, hr.invoiced], [0, 1500]);
    assert.deepStrictEqual([d.totals.collected, d.totals.invoiced], [5299.5, 8700]);
    assert.deepStrictEqual([a1.forecast, aff.forecast, hr.forecast], [4000, null, 0]);
    assert.deepStrictEqual([d.totals.forecast, d.totals.forecastMissing], [4000, 1]);
    // In Progress: A1 has Cara (valued) + Dan (Work Complete, no value); AFF Hank valued; 24 HR Jo (WC, no value)
    assert.deepStrictEqual([a1.ipCount, a1.wcCount, a1.ipMissing, a1.wcMissing], [2, 1, 0, 1]);
    assert.deepStrictEqual([hr.ipCount, hr.wcCount, hr.ipMissing, hr.wcMissing], [1, 1, 0, 1]);
    assert.deepStrictEqual([d.totals.ipCount, d.totals.wcCount, d.totals.missing], [4, 2, 2]);
    assert.deepStrictEqual([d.totals.ip, d.totals.collecting, d.totals.bank, d.totals.bankMissing], [20000, 3834.57, 22250, 1]);
    // Accuracy: j6 (est 6000 → inv 7200, col 0), j7 (4000 → 3100, 3100), j9 (2000 → 2600, 0); j3 still in progress
    const A = d.accuracy;
    assert.deepStrictEqual([A.available, A.n, A.pending, A.est, A.inv, A.col], [true, 3, 1, 12000, 12900, 3100]);
    assert.strictEqual(A.medianInv, 1.2);
    assert.deepStrictEqual(A.recent.map(r => r.name), ['Finn Moore', 'Ivy Brooks', 'Gia Torres']); // by last_invoice_date desc
    assert.deepStrictEqual(A.byLoc.map(b => [b.label, b.n]), [['A1 Dallas', 2], ['AFF Dallas', 1]]);
    assert.strictEqual(aff.lastReview.trigger, 'weekly');
    delete h.fx.store.wip_job_estimates;
    assert.deepStrictEqual((await h.wip.loadDashboard(pools)).accuracy, { available: false });
  } finally { h.close(); }
});

test('master page: super master sees every location + pool admin; manager sees only theirs', async () => {
  const h = await boot();
  try {
    const all = await get(`${h.base}/wip/master/${TOKENS.master}`);
    assert.strictEqual(all.status, 200);
    for (const s of ['<th class="r">In Progress', '<th class="r">Collecting next week', '<th class="r">Bank balance', '<th class="r">AR', 'Last week and accuracy', 'Estimate accuracy', 'id="add-loc"', 'data-remove=', 'A1 Dallas', 'AFF Dallas', '24 HR']) assert.ok(all.body.includes(s), 'missing ' + s);
    assert.ok(!/<span class="k">/.test(all.body), 'no KPI tile strip on the main view');
    assert.ok(!/Total<\/td>/.test(all.body), 'no totals row across locations');
    assert.match(all.body, /data-bank="aaaa1111-0000-0000-0000-000000000001" value="18250"/);
    assert.match(all.body, /1 need a number/);
    assert.match(all.body, /sent Oct \d+, \d+:\d\d [AP]M by Sam/);
    assert.match(all.body, /<img class="logo sm" src="https:\/\/cdn\.test\/a1\.png"/);
    assert.ok(all.body.includes('<option value="' + LOC.tulsa + '">A1 Tulsa</option>'), 'unpooled location offered');

    const sam = await get(`${h.base}/wip/master/${TOKENS.sam}`);
    assert.strictEqual(sam.status, 200);
    assert.match(sam.body, /<h1>WIP · Sam Rivera<\/h1>/);
    assert.ok(sam.body.includes('A1 Dallas') && sam.body.includes('AFF Dallas') && !sam.body.includes('24 HR'), 'scoped to Sam');
    assert.ok(!sam.body.includes('id="add-loc"') && !sam.body.includes('data-remove='), 'no pool admin for managers');
    assert.ok(h.fx.store.wip_managers.find(m => m.id === MGR.sam).last_opened_at, 'last_opened_at stamped');

    assert.strictEqual((await get(`${h.base}/wip/master/not-a-real-token-0000000`)).status, 404);
    h.fx.store.wip_managers.find(m => m.id === MGR.lee).active = false;
    assert.strictEqual((await get(`${h.base}/wip/master/${TOKENS.lee}`)).status, 404);
    delete h.fx.store.wip_managers; // migration not run: legacy link still works, manager link 404s
    assert.strictEqual((await get(`${h.base}/wip/master/${TOKENS.master}`)).status, 200);
    assert.strictEqual((await get(`${h.base}/wip/master/${TOKENS.sam}`)).status, 404);
  } finally { h.close(); }
});

test('master edits: bank balance per location (any master, scoped), pool add/remove only for super master', async () => {
  const h = await boot();
  try {
    const r = await send(`${h.base}/wip/master/${TOKENS.sam}/locations/${POOL.aff}`, 'PATCH', { bank_balance: 7777.5 });
    assert.deepStrictEqual(r.body, { ok: true });
    const aff = h.fx.store.wip_pool.find(p => p.id === POOL.aff);
    assert.deepStrictEqual([aff.bank_balance, aff.bank_balance_by, !!aff.bank_balance_at], [7777.5, 'Sam Rivera', true]);
    assert.strictEqual((await send(`${h.base}/wip/master/${TOKENS.sam}/locations/${POOL.hr}`, 'PATCH', { bank_balance: 1 })).status, 404); // not Sam's
    assert.strictEqual((await send(`${h.base}/wip/master/${TOKENS.master}/locations/${POOL.hr}`, 'PATCH', { bank_balance: null })).status, 200);
    assert.strictEqual(h.fx.store.wip_pool.find(p => p.id === POOL.hr).bank_balance_by, null);
    const m = await send(`${h.base}/wip/master/${TOKENS.master}/locations/${POOL.a1}`, 'PATCH', { bank_balance: 100 });
    assert.strictEqual(h.fx.store.wip_pool.find(p => p.id === POOL.a1).bank_balance_by, 'master');
    assert.strictEqual(m.status, 200);
    assert.strictEqual((await send(`${h.base}/wip/master/${TOKENS.sam}/locations`, 'POST', { location_id: LOC.tulsa })).status, 403);
    assert.strictEqual((await send(`${h.base}/wip/master/${TOKENS.sam}/locations/${POOL.a1}`, 'DELETE')).status, 403);
    assert.strictEqual((await send(`${h.base}/wip/master/${TOKENS.master}/locations`, 'POST', { location_id: LOC.tulsa })).status, 200);
    assert.ok(h.fx.store.wip_pool.some(p => p.location_id === LOC.tulsa));
  } finally { h.close(); }
});

test('admin portal: token gate, add manager, assign/unassign (creates the pool row), regenerate, deactivate', async () => {
  const h = await boot();
  try {
    assert.strictEqual((await get(`${h.base}/wip/admin/wrong-token-0000000000000`)).status, 404);
    const page = await get(`${h.base}/wip/admin/${TOKENS.admin}?m=${MGR.sam}`);
    assert.strictEqual(page.status, 200);
    for (const s of ['Sam Rivera', 'Lee Chen', 'Locations for Sam Rivera', `data-assign="${LOC.tulsa}"`, 'Unassigned locations', 'A1 Tulsa']) assert.ok(page.body.includes(s), 'missing ' + s);
    assert.match(page.body, new RegExp(`data-assign="${LOC.a1}" checked`));
    assert.match(page.body, new RegExp(`data-assign="${LOC.hr}" >`)); // Lee's, not Sam's

    const add = await send(`${h.base}/wip/admin/${TOKENS.admin}/managers`, 'POST', { name: '  Max Patel ', email: 'max@example.test' });
    assert.strictEqual(add.status, 200);
    const max = h.fx.store.wip_managers.find(m => m.id === add.body.id);
    assert.deepStrictEqual([max.name, max.email, max.active, max.token.length >= 20], ['Max Patel', 'max@example.test', true, true]);

    // Assign A1 Tulsa (no pool row yet) → pool row minted with an owner token, then linked
    const asg = await send(`${h.base}/wip/admin/${TOKENS.admin}/managers/${max.id}/locations/${LOC.tulsa}`, 'POST');
    assert.strictEqual(asg.status, 200);
    const pool = h.fx.store.wip_pool.find(p => p.location_id === LOC.tulsa);
    assert.ok(pool && pool.token, 'pool row created');
    assert.ok(h.fx.store.wip_manager_locations.some(l => l.manager_id === max.id && l.pool_id === pool.id));
    const maxPage = await get(`${h.base}/wip/master/${max.token}`);
    assert.ok(maxPage.body.includes('A1 Tulsa') && !maxPage.body.includes('A1 Dallas'));
    await send(`${h.base}/wip/admin/${TOKENS.admin}/managers/${max.id}/locations/${LOC.tulsa}`, 'DELETE');
    assert.ok(!h.fx.store.wip_manager_locations.some(l => l.manager_id === max.id));

    const old = max.token;
    const re = await send(`${h.base}/wip/admin/${TOKENS.admin}/managers/${max.id}/token`, 'POST');
    assert.ok(re.body.token && re.body.token !== old);
    assert.strictEqual((await get(`${h.base}/wip/master/${old}`)).status, 404);
    assert.strictEqual((await get(`${h.base}/wip/master/${re.body.token}`)).status, 200);
    await send(`${h.base}/wip/admin/${TOKENS.admin}/managers/${max.id}`, 'PATCH', { active: false, name: 'Max P' });
    assert.deepStrictEqual([max.active, max.name], [false, 'Max P']);
    assert.strictEqual((await get(`${h.base}/wip/master/${re.body.token}`)).status, 404);
    delete h.fx.store.wip_managers;
    const gone = await get(`${h.base}/wip/admin/${TOKENS.admin}`);
    assert.strictEqual(gone.status, 404);
    assert.match(gone.body, /supabase_wip_dashboard\.sql/);
  } finally { h.close(); }
});

test('PDFs: one page per location and per manager; file names; long lists continue', async () => {
  const h = await boot();
  try {
    const loc = await get(`${h.base}/wip/master/${TOKENS.sam}/pdf?pool_id=${POOL.a1}`);
    assert.strictEqual(loc.status, 200);
    assert.match(loc.headers.get('content-type'), /application\/pdf/);
    assert.match(loc.headers.get('content-disposition'), /filename="WIP A1 Dallas \d{4}-\d{2}-\d{2}\.pdf"/);
    assert.strictEqual(loc.body.subarray(0, 5).toString(), '%PDF-');
    assert.strictEqual(pdfPages(loc.body), 1);
    const own = await get(`${h.base}/wip/${TOKENS.a1}/pdf`);
    assert.strictEqual(pdfPages(own.body), 1);
    const mgr = await get(`${h.base}/wip/master/${TOKENS.master}/pdf`);
    assert.match(mgr.headers.get('content-disposition'), /filename="WIP all locations /);
    assert.strictEqual(pdfPages(mgr.body), 1);
    assert.strictEqual((await get(`${h.base}/wip/master/${TOKENS.lee}/pdf?pool_id=${POOL.a1}`)).status, 404); // not Lee's

    // 40 In Progress jobs still fit one page (type steps down); 120 must continue onto more pages.
    const push = (from, to) => { for (let i = from; i < to; i++) h.fx.store.jobs.push({ id: 'big' + i, location_id: LOC.hr, jn_id: 'jnbig' + i, number: String(9000 + i), name: 'Stress Job ' + i, status: 'In Progress', stage: 'In Production', record_type: 'Mitigation', jn_created: '2026-10-01T00:00:00Z' }); };
    push(0, 40);
    assert.strictEqual(pdfPages((await get(`${h.base}/wip/master/${TOKENS.lee}/pdf?pool_id=${POOL.hr}`)).body), 1);
    push(40, 120);
    assert.ok(pdfPages((await get(`${h.base}/wip/master/${TOKENS.lee}/pdf?pool_id=${POOL.hr}`)).body) > 1);
    const { pickStep, STEPS } = require('../wipPdf');
    assert.strictEqual(pickStep([{ rows: 10, titled: true }, { rows: 5, titled: true }]).step, STEPS[0]);
    assert.strictEqual(pickStep([{ rows: 30, titled: true }, { rows: 10, titled: true }]).fits, true);
    assert.strictEqual(pickStep([{ rows: 120, titled: true }]).fits, false);
  } finally { h.close(); }
});

test('review run: starts at once, progresses per location with phases, finishes with results; 409 while running', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const anthropic = { messages: { parse: async () => { await gate; return { stop_reason: 'end_turn', usage: {}, parsed_output: { jobs: [{ job_number: '1001', decision: 'collecting', amount: 1000, reason: 'check issued 10/20' }] } }; } } };
  const h = await boot({ anthropic });
  try {
    const start = await send(`${h.base}/wip/master/${TOKENS.sam}/review`, 'POST', { all: true });
    assert.strictEqual(start.status, 200);
    assert.ok(start.body.run_id && start.body.total === 2);
    const busy = await send(`${h.base}/wip/master/${TOKENS.sam}/review`, 'POST', { pool_id: POOL.a1 });
    assert.strictEqual(busy.status, 409);
    await new Promise(r => setTimeout(r, 50));
    const mid = (await get(`${h.base}/wip/master/${TOKENS.sam}/review/${start.body.run_id}`)).body;
    assert.deepStrictEqual([mid.total, mid.done, mid.finished, mid.current, mid.phase], [2, 0, false, 'A1 Dallas', 'deciding']);
    assert.deepStrictEqual(mid.items.map(i => i.state), ['cur', 'wait']);
    assert.strictEqual((await get(`${h.base}/wip/master/${TOKENS.lee}/review/${start.body.run_id}`)).status, 404); // other master can't peek
    release();
    let fin;
    for (let i = 0; i < 50 && !(fin && fin.finished); i++) { await new Promise(r => setTimeout(r, 20)); fin = (await get(`${h.base}/wip/master/${TOKENS.sam}/review/${start.body.run_id}`)).body; }
    assert.deepStrictEqual([fin.finished, fin.done, fin.failed, fin.items.map(i => i.state)], [true, 2, 0, ['done', 'done']]);
    assert.strictEqual(fin.results[0].label, 'A1 Dallas');
    assert.strictEqual(fin.results[0].jobs[0].decision, 'collecting');
    assert.strictEqual((await send(`${h.base}/wip/master/${TOKENS.sam}/review`, 'POST', { pool_id: POOL.a1 })).status, 200, 'free again after finishing');
  } finally { h.close(); }
});

test('Saturday tick saves a snapshot per reviewed location (the next week\'s forecast)', async () => {
  const anthropic = { messages: { parse: async () => ({ stop_reason: 'end_turn', usage: {}, parsed_output: { jobs: [] } }) } };
  const h = await boot({ anthropic });
  try {
    const before = h.fx.store.wip_snapshots.length;
    const r = await h.wip.weeklyReviewTick(new Date('2026-10-24T11:30:00Z'));
    assert.strictEqual(r.ran.length, 2); // AFF already ran this Saturday (fixture review row)
    const added = h.fx.store.wip_snapshots.slice(before);
    assert.deepStrictEqual(added.map(s => [s.location_id, s.in_progress_total]).sort(), [[LOC.a1, 8000], [LOC.hr, 0]].sort());
    assert.match(added[0].body, /^A1 DALLAS · WEEK OF /);
    assert.strictEqual(added[0].generated_by, 'Saturday review');
  } finally { h.close(); }
});
