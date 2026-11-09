const test = require('node:test');
const assert = require('node:assert');
const { monthStartsFrom, windowFrom, buildMap, pnlRow, bankEntries, cardRow, DATA_START, fullRunDue } = require('../netsuiteSync');
const { parseStatements } = require('../scripts/loadStatements');
const { normalizeName } = require('../netsuiteMatch');

const now = new Date('2026-11-08T15:00:00Z');

test('monthStartsFrom lists every month start through the current one', () => {
  assert.deepEqual(monthStartsFrom('2026-09-01', now), ['2026-09-01', '2026-10-01', '2026-11-01']);
  assert.equal(monthStartsFrom(DATA_START, now).length, 11);
});

test('windowFrom: three months for the hourly run, January 2026 for a full one, never earlier', () => {
  assert.equal(windowFrom(false, now), '2026-09-01');
  assert.equal(windowFrom(true, now), '2026-01-01');
  assert.equal(windowFrom(false, new Date('2026-02-10T00:00:00Z')), '2026-01-01');
});

test('buildMap links each subsidiary to every DryOps row with that name and reports what nothing matched', () => {
  const locations = [
    { id: 'a1', name: 'Sample Restoration of Portland', status: 'active', location_type: 'Mitigation', jobs: 40 },
    { id: 'a2', name: 'Sample Restoration of Portland', status: 'inactive', location_type: 'Mitigation', jobs: 3 },
    { id: 'b1', name: 'Sample Packout of Dallas', status: 'active', location_type: 'Contents', jobs: 12 },
    { id: 'c1', name: 'Sample Restoration of Nowhere', status: 'active', location_type: 'Mitigation', jobs: 1 },
    { id: 'd1', name: 'Gurr Brothers of Denver', status: 'active', location_type: 'Mitigation', jobs: 9 },
    { id: 'e1', name: 'Sample Testing of Reno', status: 'active', location_type: 'Testing', jobs: 5 },
    { id: 'f1', name: 'Sample Restoration of Closed', status: 'inactive', location_type: 'Mitigation', jobs: 0 },
  ];
  const subsidiaries = [
    { id: '10', name: 'Sample Restoration of Portland, LLC', isinactive: 'F', iselimination: 'F' },
    { id: '11', name: 'Sample Packout of Dallas', isinactive: 'F', iselimination: 'F' },
    { id: '12', name: 'Gurr Brothers of Denver', isinactive: 'F', iselimination: 'F' },
    { id: '13', name: 'Sample Restoration of Reno', isinactive: 'F', iselimination: 'F' },
  ];
  const { map, subsidiaries: subs, unmatched } = buildMap(locations, subsidiaries, {});
  assert.deepEqual(subs, [
    { subsidiary_id: 10, subsidiary_name: 'Sample Restoration of Portland, LLC', vertical: 'Mitigation' },
    { subsidiary_id: 11, subsidiary_name: 'Sample Packout of Dallas', vertical: 'Contents' },
  ]);
  assert.deepEqual(map.map((m) => `${m.subsidiary_id}:${m.location_id}`), ['10:a1', '10:a2', '11:b1']);
  assert.deepEqual(unmatched, ['Sample Restoration of Nowhere']);
});

test('pnlRow flips income positive, keeps costs positive and drops zero rows', () => {
  assert.deepEqual(pnlRow({ sub_id: '5', account_id: '77', acctnumber: '40000', account: '40000 Sales', accttype: 'Income', amount: '-1200.456', n: '3' }, '2026-10-01'), {
    month: '2026-10-01', subsidiary_id: 5, account_id: 77, account_number: '40000', account_name: '40000 Sales', account_type: 'Income', amount: 1200.46, txn_count: 3,
  });
  assert.equal(pnlRow({ sub_id: '5', account_id: '78', acctnumber: null, account: 'Fees', accttype: 'Expense', amount: '250', n: '1' }, '2026-10-01').amount, 250);
  assert.equal(pnlRow({ sub_id: '5', account_id: '79', acctnumber: null, account: 'Nil', accttype: 'Expense', amount: '0', n: '0' }, '2026-10-01'), null);
});

test('bankEntries verifies an account only when the gap holds at both newest statement dates', () => {
  const dates = ['2026-08-31', '2026-09-30', '2026-10-31'];
  const statements = [
    { company: 'Sample Restoration of Portland', last4: '1111', statement_date: '2026-09-30', balance: 10500 },
    { company: 'Sample Restoration of Portland', last4: '1111', statement_date: '2026-10-31', balance: 12000 },
    { company: 'Sample Packout of Dallas', last4: '2222', statement_date: '2026-09-30', balance: 800 },
    { company: 'Sample Packout of Dallas', last4: '2222', statement_date: '2026-10-31', balance: 900 },
    // Same last 4 at two companies: the company name must pick the right one.
    { company: 'Sample Restoration of Portland', last4: '3333', statement_date: '2026-10-31', balance: 50 },
    { company: 'Sample Packout of Dallas', last4: '3333', statement_date: '2026-10-31', balance: 70 },
  ];
  const banks = [
    // Constant $500 gap → verified at the Oct 31 statement, with November posting as "since".
    { sub_id: '10', account_id: '1', account: 'Operating BOA-1111', isinactive: 'F', thru_0: '9000', thru_1: '10000', thru_2: '11500', thru_now: '11900' },
    // Gap moved by $60 → not verified, with the reason.
    { sub_id: '11', account_id: '2', account: 'Operating BOA-2222', isinactive: 'F', thru_0: '700', thru_1: '800', thru_2: '840', thru_now: '840' },
    // One statement only → verified on that one (nothing to compare), since 0.
    { sub_id: '11', account_id: '3', account: 'Payroll BOA-3333', isinactive: 'F', thru_0: '0', thru_1: '0', thru_2: '70', thru_now: '70' },
    { sub_id: '10', account_id: '4', account: 'Savings BOA-4444', isinactive: 'F', thru_0: '1', thru_1: '1', thru_2: '1', thru_now: '1' },
    { sub_id: '10', account_id: '5', account: 'Airbase Clearing', isinactive: 'F', thru_0: '1', thru_1: '1', thru_2: '1', thru_now: '1' },
    { sub_id: '10', account_id: '6', account: 'Old BOA-1111', isinactive: 'T', thru_0: '1', thru_1: '1', thru_2: '1', thru_now: '1' },
  ];
  const subNames = new Map([[10, normalizeName('Sample Restoration of Portland, LLC')], [11, normalizeName('Sample Packout of Dallas')]]);
  const { entries, tally } = bankEntries(banks, statements, dates, subNames);
  assert.deepEqual(tally, { verified: 2, mismatch: 1, noStatement: 1 });
  const byId = Object.fromEntries(entries.map((e) => [e.account_id, e]));
  assert.equal(entries.length, 4);
  assert.equal(byId[1].reconciled_balance, 12000);
  assert.equal(byId[1].reconciled_through, '2026-10-31');
  assert.equal(byId[1].since, 400);
  assert.equal(byId[1].last4, '1111');
  assert.equal(byId[2].reconciled_balance, null);
  assert.match(byId[2].issue, /moved differently between 2026-09-30 and 2026-10-31, by \$60\.00/);
  assert.equal(byId[3].reconciled_balance, 70);
  assert.equal(byId[3].since, 0);
  assert.equal(byId[4].reconciled_balance, null);
  assert.equal(byId[4].issue, null);
});

test('cardRow reads the PEX memo, keeps purchases and fees, drops bill payments and rebates', () => {
  const base = { id: '9001', sub_id: '10', acctnumber: '74100', account: '74100 Fuel', vendor: 'Fuel Stop', amount: '61.2' };
  const row = cardRow({ ...base, memo: 'PEX | 2200 PEX Card | Pat Example | Purchase #abc123 | 2026-10-21T12:10:00 | FUEL STOP 123 | -61.20 USD' }, '2026-10-01');
  assert.deepEqual(row, {
    id: '9001-74100', subsidiary_id: 10, cardholder: 'Pat Example', vendor_card: false, merchant: 'Fuel Stop', account_number: '74100', account_name: '74100 Fuel',
    at: '2026-10-21T12:10:00Z', amount: 61.2,
  });
  assert.equal(cardRow({ ...base, memo: 'PEX | 2200 PEX Card | Pat Example | Bill Payment #x | 2026-10-21T12:10:00 | PEX | -500 USD' }, '2026-10-01'), null);
  assert.equal(cardRow({ ...base, memo: 'PEX | 2200 PEX Card | Pat Example | Rebate #x | 2026-10-21T12:10:00 | PEX | 5 USD' }, '2026-10-01'), null);
  assert.equal(cardRow({ ...base, memo: 'Something else' }, '2026-10-01'), null);
  const vendor = cardRow({ ...base, vendor: null, memo: 'PEX | 2200 PEX Card | Vendor Ads | Fee #x | n/a | Ad Network | -3 USD' }, '2026-10-01');
  assert.equal(vendor.vendor_card, true);
  assert.equal(vendor.merchant, 'Ad Network');
  assert.equal(vendor.at, '2026-10-01T12:00:00Z');
});

test('parseStatements reads the accounting export, including quoted dollar amounts', () => {
  const rows = parseStatements('Company,Last 4,Date,Balance\nSample Restoration of Portland,1111,10/31/2026,"$12,000.00"\nSample Packout of Dallas,0222,9/30/2026,"($50.25)"\n');
  assert.deepEqual(rows, [
    { company: 'Sample Restoration of Portland', last4: '1111', statement_date: '2026-10-31', balance: 12000 },
    { company: 'Sample Packout of Dallas', last4: '0222', statement_date: '2026-09-30', balance: -50.25 },
  ]);
  assert.throws(() => parseStatements('h\nbad line\n'), /Line 2/);
});

test('fullRunDue takes denverNow()\'s { y, m, d, h } reading: full once at 3 AM Denver, hourly otherwise', () => {
  const at3 = { y: 2026, m: 11, d: 8, h: 3 };
  assert.deepEqual(fullRunDue(at3, null), { full: true, dayKey: '2026-11-8' });
  assert.equal(fullRunDue(at3, '2026-11-8').full, false);            // already ran today
  assert.equal(fullRunDue({ ...at3, h: 4 }, null).full, false);      // not 3 AM
  assert.equal(fullRunDue({ ...at3, d: 9 }, '2026-11-8').full, true); // next day
});
