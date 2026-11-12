'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveWindow, monthChunks, ymd, parseYmd } = require('../dates');
const { parseArgs, countRows } = require('../lsaBot');

const today = { y: 2026, m: 11, d: 12 };
const span = (w) => `${ymd(w.start)}..${ymd(w.end)}`;

test('default window is the last N days ending today, inclusive', () => {
  assert.equal(span(resolveWindow({ days: 30 }, today)), '2026-10-14..2026-11-12');
  assert.equal(span(resolveWindow({ days: 1 }, today)), '2026-11-12..2026-11-12');
});

test('explicit window crosses a year boundary', () => {
  assert.equal(span(resolveWindow({ from: '2025-12-30', to: '2026-01-02' }, today)), '2025-12-30..2026-01-02');
});

test('bad dates are refused', () => {
  assert.throws(() => parseYmd('2026-02-30'), /Not a real date/);
  assert.throws(() => parseYmd('11/12/2026'), /YYYY-MM-DD/);
  assert.throws(() => resolveWindow({ from: '2026-11-13', to: '2026-11-12' }, today), /after/);
});

test('month chunks cover the window with no gap or overlap', () => {
  const chunks = monthChunks(resolveWindow({ from: '2026-01-15', to: '2026-03-10' }, today)).map(span);
  assert.deepEqual(chunks, ['2026-01-15..2026-01-31', '2026-02-01..2026-02-28', '2026-03-01..2026-03-10']);
  assert.deepEqual(monthChunks(resolveWindow({ from: '2024-02-28', to: '2024-03-01' }, today)).map(span),
    ['2024-02-28..2024-02-29', '2024-03-01..2024-03-01']);
});

test('parseArgs reads flags and values', () => {
  assert.deepEqual(parseArgs(['run', '--days', '60', '--headless', '--only', 'A1 Restoration']),
    { _: ['run'], days: '60', headless: true, only: 'A1 Restoration' });
});

test('countRows ignores the header and line breaks inside quoted cells', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lsa-')), 'a.csv');
  fs.writeFileSync(file, 'A,B\n1,"two\nlines"\n3,4');
  assert.equal(countRows(file), 2);
  fs.writeFileSync(file, 'A,B\n');
  assert.equal(countRows(file), 0);
});
