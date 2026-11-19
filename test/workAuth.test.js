'use strict';
// Work authorizations signed in DryOps (workAuth.js). Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const PDFDocument = require('pdfkit');
const { mergeAgreement, missingForAgreement, cleanSignature, renderWorkAuthPdf, centralDate, customerName } = require('../workAuth');

const template = {
  company_name: 'Texas Water and Fire of Dallas', company_address: '1625 Crescent Circle, Suit 314, Carrollton, TX 75006', company_phone: '(214) 551-8636',
  title: 'WORK AUTHORIZATION AGREEMENT',
  intro: 'This Agreement is entered by and between {{CustomerName}} (the “Customer”) and {{CompanyName}}, (the “Company”), for the property located at {{PropertyAddress}}, (the “Property”), damaged on or about {{Date}}.',
  clauses: [
    { heading: '3. DIRECTION TO PAY:', text: 'The Customer authorizes the Customer’s insurance company {{InsuranceCompany}} to pay directly to {{CompanyName}} the amount shown.' },
    { heading: '14. CANCELLATION:', text: 'Written notice of cancellation to the Company at {{CompanyAddress}} by midnight.' },
  ],
};
const ctx = { customerName: 'Beverly Belk', propertyAddress: '4242 Wilshire Blvd, Dallas, TX, 75241', insuranceCompany: 'State Farm', date: 'Nov 19, 2026' };

test('the agreement is filled in with the job and the company', () => {
  const a = mergeAgreement(template, ctx);
  assert.match(a.intro, /between Beverly Belk \(the “Customer”\) and Texas Water and Fire of Dallas, \(the “Company”\)/);
  assert.match(a.intro, /located at 4242 Wilshire Blvd, Dallas, TX, 75241, \(the “Property”\), damaged on or about Nov 19, 2026\./);
  assert.match(a.clauses[0].text, /insurance company State Farm to pay directly to Texas Water and Fire of Dallas the amount/);
  assert.match(a.clauses[1].text, /at 1625 Crescent Circle, Suit 314, Carrollton, TX 75006 by midnight/);
  assert.deepStrictEqual(a.company, { name: 'Texas Water and Fire of Dallas', address: '1625 Crescent Circle, Suit 314, Carrollton, TX 75006', phone: '(214) 551-8636' });
  assert.ok(!/\{\{/.test(JSON.stringify(a)));
});

test('an empty fill-in leaves no gap and no stray comma', () => {
  const a = mergeAgreement(template, { ...ctx, insuranceCompany: null });
  assert.match(a.clauses[0].text, /insurance company to pay directly/);
  const b = mergeAgreement({ ...template, company_address: null }, ctx);
  assert.match(b.clauses[1].text, /to the Company at by midnight/);
  assert.strictEqual(b.company.address, null);
});

test('a job without the customer or the address cannot be signed yet', () => {
  assert.deepStrictEqual(missingForAgreement(ctx), []);
  assert.deepStrictEqual(missingForAgreement({ ...ctx, customerName: ' ', propertyAddress: null }), ['the customer\'s name', 'the property address']);
  assert.strictEqual(customerName('Testy McWorkflow (THN)'), 'Testy McWorkflow');
  assert.strictEqual(customerName('Beverly Belk'), 'Beverly Belk');
});

const stroke = (n, dx = 3) => Array.from({ length: n }, (_x, i) => ({ x: 10 + i * dx, y: 40 + Math.sin(i) * 10 }));

test('a drawn signature is bounded and cleaned; a dot or junk is refused', () => {
  const ok = cleanSignature({ width: 320, height: 160, strokes: [stroke(20), stroke(10)] });
  assert.strictEqual(ok.error, undefined);
  assert.strictEqual(ok.signature.strokes.length, 2);
  assert.strictEqual(ok.signature.strokes[0].length, 20);
  // clamped into the pad, junk points dropped
  const clamped = cleanSignature({ width: 100, height: 50, strokes: [[...stroke(14), { x: 9999, y: -5 }, { x: 'a', y: 1 }, null]] });
  assert.deepStrictEqual(clamped.signature.strokes[0][14], { x: 100, y: 0 });
  assert.strictEqual(clamped.signature.strokes[0].length, 15);
  assert.match(cleanSignature({ width: 320, height: 160, strokes: [stroke(3)] }).error, /Sign in the box/);
  assert.match(cleanSignature({ width: 320, height: 160, strokes: [] }).error, /Sign in the box/);
  assert.match(cleanSignature({ width: 0, height: 160, strokes: [stroke(20)] }).error, /did not come through/);
  assert.match(cleanSignature(null).error, /did not come through/);
  assert.match(cleanSignature({ width: 320, height: 160, strokes: Array.from({ length: 401 }, () => stroke(2)) }).error, /too long/);
  assert.match(cleanSignature({ width: 320, height: 160, strokes: [stroke(6001, 0.01)] }).error, /too long/);
});

test('Central date and time for the signature line', () => {
  const d = new Date('2026-11-19T21:42:00Z');
  assert.strictEqual(centralDate(d, false), 'Nov 19, 2026');
  assert.strictEqual(centralDate(d, true), 'Nov 19, 2026 3:42 PM CT');
});

test('the signed agreement renders to a PDF', async () => {
  const long = { ...template, clauses: Array.from({ length: 16 }, (_x, i) => ({ heading: `${i + 1}. CLAUSE:`, text: 'The Customer understands and agrees. '.repeat(18) })) };
  const buf = await renderWorkAuthPdf(PDFDocument, mergeAgreement(long, ctx), {
    signerName: 'Beverly Belk', signature: cleanSignature({ width: 320, height: 160, strokes: [stroke(40), [{ x: 5, y: 5 }]] }).signature,
    signedAt: new Date('2026-11-19T21:42:00Z'), via: 'phone', collectedBy: 'Chance Dixon', recordId: '0b1f6f3e-1111-4222-8333-444455556666',
  });
  assert.strictEqual(buf.slice(0, 5).toString(), '%PDF-');
  assert.ok(buf.length > 3000);
  const pages = (buf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
  assert.ok(pages >= 2 && pages <= 5, `a 16-clause agreement is a few pages, not ${pages} (footers must not add pages)`);
});
