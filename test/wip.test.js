// WIP pages: Total AR must be the DryOps Open AR number (open_ar_total RPC over
// jobs.approved_invoice_due on Invoice Created / Invoiced / Pending Payment(s)
// jobs), and per-job balances must come from the JobNimbus job rollup columns —
// never from the `invoices` mirror. Mounts the real routes on express with
// Supabase stubbed through global fetch. Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const SB = 'https://sb.test';
const TOKEN = 'ownertoken-0123456789abcdef';
const LOC = '11111111-1111-1111-1111-111111111111';

function stubSupabase(calls) {
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    const u = String(url);
    if (!u.startsWith(SB)) return realFetch(url, init);
    const path = u.slice(SB.length + '/rest/v1/'.length);
    calls.push({ path, method: (init && init.method) || 'GET', body: init && init.body ? JSON.parse(init.body) : null });
    const ok = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (path.startsWith('wip_pool?token=')) return ok([{ id: 'pool1', location_id: LOC, token: TOKEN, label: 'A1 Dallas', sort_order: 1, bank_balance: 1000, bank_balance_at: '2026-10-24T12:00:00Z', bank_balance_by: 'Sam', locations: { name: 'A1 Dallas' } }]);
    if (path.startsWith('jobs?')) {
      assert.match(path, /approved_invoice_total,approved_invoice_due/, 'jobs query reads the JN rollup columns');
      return ok([
        { id: 'j1', jn_id: 'jn1', number: '1001', name: 'Alice (A1 - DAL - MIT)', status: 'Invoiced', stage: 'Account Receivable', record_type: 'Mitigation', jn_created: '2026-09-01T00:00:00Z', approved_invoice_total: 5000, approved_invoice_due: 1234.567 },
        { id: 'j2', jn_id: 'jn2', number: '1002', name: 'Bob', status: 'Attorney', stage: 'Account Receivable', record_type: 'Contents', jn_created: '2026-08-01T00:00:00Z', approved_invoice_total: 9000, approved_invoice_due: 9000 },
        { id: 'j3', jn_id: 'jn3', number: '1003', name: 'Cara', status: 'In Progress', stage: 'In Production', record_type: 'Mitigation', jn_created: '2026-10-01T00:00:00Z', approved_invoice_total: null, approved_invoice_due: null },
      ]);
    }
    if (path.startsWith('wip_entries?')) return ok([{ key: 'j1', custom_name: null, category: 'collecting', amount: null, note: '', updated_by: 'Sam', updated_at: '2026-10-24T12:00:00Z' }]);
    if (path === 'rpc/open_ar_total') return ok(42000.4);
    if (path.startsWith('wip_snapshots')) return new Response('', { status: 201 });
    if (path.startsWith('invoices')) throw new Error('WIP must not read the invoices mirror');
    throw new Error('unexpected supabase call ' + path);
  };
  return () => { global.fetch = realFetch; };
}

async function withServer(fn) {
  const calls = [];
  const restore = stubSupabase(calls);
  const app = express();
  app.use(express.json());
  require('../wip')(app, { SUPABASE_URL: SB, SUPABASE_SERVICE_KEY: 'svc', jnGet: async () => ({}), anthropic: null }, { noSchedule: true });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try { await fn(`http://127.0.0.1:${srv.address().port}`, calls); }
  finally { srv.close(); restore(); }
}

test('Total AR = open_ar_total RPC for the location; rows carry the JN rollup balances', async () => {
  await withServer(async (base, calls) => {
    const text = await (await fetch(`${base}/wip/${TOKEN}/text`)).text();
    assert.match(text, /Total AR — \$42,000\n/, text);
    // Collecting defaults to the approved balance due, rounded to cents.
    assert.match(text, /Collecting — \$1,235\n1\. Alice — \$1,234\.57/, text);
    // The Attorney job is not in Collecting (no amount typed) and does not inflate AR.
    assert.ok(!/Bob/.test(text), text);
    assert.match(text, /In Progress — \$0\n1\. Cara —/, text);
    const rpc = calls.find(c => c.path === 'rpc/open_ar_total');
    assert.deepStrictEqual(rpc.body, { p_location_ids: [LOC] });
    assert.ok(!calls.some(c => c.path.startsWith('invoices')));
  });
});

test('owner page shows the DryOps AR number and per-job "they owe" from approved_invoice_due', async () => {
  await withServer(async base => {
    const html = await (await fetch(`${base}/wip/${TOKEN}`)).text();
    assert.match(html, /<span>AR<\/span><button[^>]*data-help="ar"[^>]*>\?<\/button><b>\$42,000<\/b>/);
    assert.match(html, /<span>Bank Balance<\/span>/);
    assert.ok(!/Total owed to us|Money in the bank/.test(html));
    assert.match(html, /"due":1234\.57/);
    assert.match(html, /"inv_total":9000/);
  });
});

// ── Weekly automatic review ───────────────────────────────────────────────────
// The tick runs every pooled location once per Saturday (Central) from the
// configured hour, remembers via the wip_reviews row tagged trigger=weekly,
// and never touches a location that already ran today or an owner-set row.
function weeklyHarness({ alreadyRanToday = false } = {}) {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    const u = String(url);
    if (!u.startsWith(SB)) return realFetch(url, init);
    const path = u.slice(SB.length + '/rest/v1/'.length);
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ path, method: (init && init.method) || 'GET', body });
    const ok = b => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const pool = { id: 'pool1', location_id: LOC, token: TOKEN, label: 'A1 Dallas', locations: { name: 'A1 Dallas' } };
    if (path.startsWith('wip_pool?select')) return ok([pool]);
    if (path.startsWith('wip_pool?token=')) return ok([pool]);
    if (path.startsWith('wip_reviews?location_id=')) {
      assert.match(path, /result->>trigger=eq\.weekly/);
      return ok(alreadyRanToday ? [{ reviewed_at: '2026-10-24T11:05:00Z' }] : [{ reviewed_at: '2026-10-17T11:05:00Z' }]);
    }
    if (path.startsWith('jobs?')) return ok([
      { id: 'j1', jn_id: 'jn1', number: '1001', name: 'Alice', status: 'Invoiced', stage: 'Account Receivable', record_type: 'Mitigation', jn_created: '2026-09-01T00:00:00Z', approved_invoice_total: 5000, approved_invoice_due: 1200 },
      { id: 'j2', jn_id: 'jn2', number: '1002', name: 'Bob', status: 'Pending Payment', stage: 'Account Receivable', record_type: 'Mitigation', jn_created: '2026-09-02T00:00:00Z', approved_invoice_total: 800, approved_invoice_due: 800 },
    ]);
    // Bob was set by the owner — the review must leave that row alone.
    if (path.startsWith('wip_entries?location_id=')) return ok([{ key: 'j2', custom_name: null, category: 'collecting', amount: 500, note: 'owner said', updated_by: 'Sam', updated_at: '2026-10-23T12:00:00Z' }]);
    if (path === 'rpc/open_ar_total') return ok(2000);
    if (path.startsWith('wip_entries?on_conflict') || path.startsWith('wip_reviews')) return new Response('', { status: 201 });
    throw new Error('unexpected supabase call ' + path);
  };
  const anthropic = { messages: { parse: async () => ({ stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
    parsed_output: { jobs: [
      { job_number: '1001', decision: 'collecting', amount: 1000, reason: 'carrier issued check 10/20' },
      { job_number: '1002', decision: 'not_yet', amount: null, reason: 'waiting on adjuster' },
    ] } }) } };
  const jnGet = async () => ({ activity: [{ date_created: Math.floor(Date.now() / 1000) - 86400, record_type_name: 'Note', note: 'check issued', related: [{ id: 'jn1' }] }] });
  const app = express(); app.use(express.json());
  const wip = require('../wip')(app, { SUPABASE_URL: SB, SUPABASE_SERVICE_KEY: 'svc', jnGet, anthropic }, { noSchedule: true });
  return { wip, calls, restore: () => { global.fetch = realFetch; } };
}
const SAT_6AM_CT = new Date('2026-10-24T11:30:00Z'); // Saturday 6:30 AM CDT
const SAT_5AM_CT = new Date('2026-10-24T10:30:00Z');
const FRI = new Date('2026-10-23T18:00:00Z');

test('weekly tick: only Saturday from the configured hour, Central time', async () => {
  const h = weeklyHarness();
  try {
    assert.strictEqual((await h.wip.weeklyReviewTick(FRI)).skipped, 'not-time');
    assert.strictEqual((await h.wip.weeklyReviewTick(SAT_5AM_CT)).skipped, 'not-time');
    assert.strictEqual(h.calls.length, 0);
    assert.deepStrictEqual(h.wip.chicagoNow(SAT_6AM_CT), { date: '2026-10-24', weekday: 'Sat', hour: 6 });
  } finally { h.restore(); }
});

test('weekly tick: reviews each pooled location, tags the row weekly, keeps owner-set rows', async () => {
  const h = weeklyHarness();
  try {
    const r = await h.wip.weeklyReviewTick(SAT_6AM_CT);
    assert.deepStrictEqual(r.ran.map(x => [x.label, x.jobs_reviewed, x.applied]), [['A1 Dallas', 2, 1]]);
    const upsert = h.calls.find(c => c.path.startsWith('wip_entries?on_conflict'));
    assert.deepStrictEqual(upsert.body.map(w => [w.key, w.category, w.amount, w.updated_by]), [['j1', 'collecting', 1000, 'ai-review']]);
    const log = h.calls.find(c => c.path === 'wip_reviews' && c.method === 'POST');
    assert.strictEqual(log.body.result.trigger, 'weekly');
    assert.strictEqual(log.body.location_id, LOC);
  } finally { h.restore(); }
});

test('weekly tick: a location that already ran this Saturday is skipped', async () => {
  const h = weeklyHarness({ alreadyRanToday: true });
  try {
    const r = await h.wip.weeklyReviewTick(SAT_6AM_CT);
    assert.deepStrictEqual(r.ran, []);
    assert.ok(!h.calls.some(c => c.path === 'wip_reviews' && c.method === 'POST'));
    assert.ok(!h.calls.some(c => c.path.startsWith('jobs?')), 'no review work when already done today');
  } finally { h.restore(); }
});
