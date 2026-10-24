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
  require('../wip')(app, { SUPABASE_URL: SB, SUPABASE_SERVICE_KEY: 'svc', jnGet: async () => ({}), anthropic: null });
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
