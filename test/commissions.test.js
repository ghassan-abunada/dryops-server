const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const mountCommissions = require('../commissions');
const { buildCommissionStatementPdf, jobName } = require('../commissionPdf');

const row = (over = {}) => ({
  job_label: '#64257 Starmye Goforth (OSR - DAL - MIT)', earned_month: '2026-11', earned_label: 'November 2026',
  job_type: 'Insurance', after_hours_at: 'Wed 11/4 10:37 PM', revenue: null,
  amounts: { insurance_landed: 100, after_hours_response: 25, after_hours_landed: 25, packout: 25 },
  notes: [], total: 175, paid_on: null, owed: 175, ...over,
});

const statement = (over = {}) => ({
  rep_name: 'Colt Smith', location_id: 'osr', location_name: 'One Stop Restoration of Dallas',
  pay_location_name: 'A1 Restoration of Dallas', is_pay_location: false,
  payout_month: '2026-12', payout_label: 'Second payroll of December',
  earned_month: '2026-11', earned_label: 'November 2026', rows: [row()], late_rows: [],
  total: 175, paid: 0, owed: 175, generated_on: '2026-12-15', ...over,
});

const isPdf = (buf) => buf.slice(0, 5).toString() === '%PDF-';

test('draws a statement', async () => {
  assert.ok(isPdf(await buildCommissionStatementPdf(statement())));
});

test('survives late rows, paid rows, a long list, an adjustment and a bad logo', async () => {
  const rows = Array.from({ length: 60 }, (_, i) => row({ job_label: `#${i} ${'Very Long Customer Name '.repeat(4)}`, paid_on: i % 2 ? '2026-12-18' : null }));
  const late = [row({ earned_label: 'October 2026', amounts: { large_job: 50 }, notes: ['Large job: 2 x $25 on $31,000'], total: 50 }),
    row({ job_label: 'Deduction: job', job_type: 'Adjustment', after_hours_at: null, amounts: { manual: -25 }, total: -25 })];
  const pdf = await buildCommissionStatementPdf(statement({ rows, late_rows: late, is_pay_location: true, paid: 100 }), Buffer.from('not an image'));
  assert.ok(isPdf(pdf));
});

test('logoPng gives up quietly on anything it cannot read', async () => {
  assert.strictEqual(await mountCommissions.logoPng(null), null);
  assert.strictEqual(await mountCommissions.logoPng('http://insecure.example/logo.png'), null);
  const notImage = async () => new Response('hello');
  assert.strictEqual(await mountCommissions.logoPng('https://x.example/a.png', notImage), null);
  const down = async () => { throw new Error('down'); };
  assert.strictEqual(await mountCommissions.logoPng('https://x.example/a.png', down), null);
});

test('draws credits and a location that is owed money back', async () => {
  const credit = row({ job_label: '#64511 Marla Vandoorn (A1 - DAL - MIT)', amounts: { insurance_landed: -100, oop_landed: 25 }, notes: ['Credit: Insurance job landed, paid $100, now worth $0'], total: -75, owed: -75 });
  const pdf = await buildCommissionStatementPdf(statement({ rows: [], late_rows: [credit], total: -75, owed: -75, paid: 0 }));
  assert.ok(isPdf(pdf));
});

test('job names lose the location suffix and nothing else', () => {
  assert.strictEqual(jobName('#64257 Starmye Goforth (OSR - DAL - MIT)'), '#64257 Starmye Goforth');
  assert.strictEqual(jobName('Deduction: job'), 'Deduction: job');
  assert.strictEqual(jobName('Smith (Jim) House (A1 - DAL - MIT)'), 'Smith (Jim) House');
  assert.strictEqual(jobName(null), '');
});

test('brand matches the app rule', () => {
  assert.strictEqual(mountCommissions.brandOf('One Stop Restoration of Dallas'), 'One Stop Restoration');
  assert.strictEqual(mountCommissions.brandOf('A1 Restoration - Seattle'), 'A1 Restoration');
  assert.strictEqual(mountCommissions.brandOf('24 Hour Flood Pros, LLC'), '24 Hour Flood Pros');
});

test('the logo is the location\'s own, else the brand pack, never light first', async () => {
  const pack = (rows) => async (q) => { assert.ok(q.includes('brand=eq.One%20Stop%20Restoration')); return rows; };
  const none = async () => { throw new Error('should not look up the brand'); };
  assert.strictEqual(await mountCommissions.logoUrlFor({ name: 'X of Y', logo_url: 'https://own' }, none), 'https://own');
  const named = { name: 'One Stop Restoration of Dallas', logo_url: null };
  assert.strictEqual(await mountCommissions.logoUrlFor(named, pack([{ variant: 'light', url: 'L' }, { variant: 'full', url: 'F' }])), 'F');
  assert.strictEqual(await mountCommissions.logoUrlFor(named, pack([{ variant: 'light', url: 'L' }, { variant: 'icon', url: 'I' }])), 'I');
  assert.strictEqual(await mountCommissions.logoUrlFor(named, pack([])), null);
  assert.strictEqual(await mountCommissions.logoUrlFor(named, async () => { throw new Error('db down'); }), null);
  assert.strictEqual(await mountCommissions.logoUrlFor(null, none), null);
});

test('the file name holds only safe characters', () => {
  assert.strictEqual(mountCommissions.pdfFileName({ location_name: 'A1 "Dallas"/\r\nX', payout_month: '2026-12' }), 'Commission-A1-DallasX-2026-12.pdf');
});

async function withServer(sbGet, fn) {
  const app = express();
  mountCommissions(app, { sbGet });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); }
}

const TOKEN = '3f2b8c1e-1111-4222-8333-abcdefabcdef';

test('the route serves the PDF for a real token and looks up nothing for a bad one', async () => {
  const calls = [];
  const sbGet = async (q) => {
    calls.push(q);
    if (q.startsWith('commission_statements')) return q.includes(TOKEN) ? [{ statement: statement(), location_id: null }] : [];
    return [];
  };
  await withServer(sbGet, async (base) => {
    const ok = await fetch(`${base}/commissions/statements/${TOKEN}.pdf`);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.headers.get('content-type'), 'application/pdf');
    assert.strictEqual(ok.headers.get('cache-control'), 'private, no-store');
    assert.ok(isPdf(Buffer.from(await ok.arrayBuffer())));

    const missing = await fetch(`${base}/commissions/statements/${TOKEN.replace('3f', '4f')}.pdf`);
    assert.strictEqual(missing.status, 404);

    const before = calls.length;
    const bad = await fetch(`${base}/commissions/statements/x'%20or%201=1.pdf`);
    assert.strictEqual(bad.status, 404);
    assert.strictEqual(calls.length, before);
  });
});

test('the route reports a database failure as a retry, not a crash', async () => {
  await withServer(async () => { throw new Error('db down'); }, async (base) => {
    const res = await fetch(`${base}/commissions/statements/${TOKEN}.pdf`);
    assert.strictEqual(res.status, 502);
  });
});
