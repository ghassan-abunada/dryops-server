const test = require('node:test');
const assert = require('node:assert');
const { normalizeName, matchLocations } = require('../netsuiteMatch');

test('normalizeName absorbs the real naming differences', () => {
  const same = [
    ['24 Hour Flood Pros of Arizona, LLC.', '24 Hour Flood Pros of Arizona'],
    ['24 Flood Pros of Albuquerque', '24 Hour Flood Pros of Albuquerque'],
    ['24 Hour Flood Pros of Dallas, Texas', '24 Hour Flood Pros of Dallas'],
    ['24 Hour Flood Pros of Hollywood, FL', '24 Hour Flood Pros of Hollywood'],
    ['Right Now Restoration of Austin', 'Right-Now Restoration of Austin'],
    ['Atlas Packout of Austin', 'Atlas Packouts of Austin'],
    ['APEX Abatements of Dallas', 'Apex Abatements of Dallas'],
    ['Lonestar Fire & Flood of Houston', 'Lonestar Fire and Flood of Houston'],
    ['24 Hour Flood Pros of AZ', '24 Hour Flood Pros of Arizona'],
  ];
  for (const [a, b] of same) assert.equal(normalizeName(a), normalizeName(b), a);
});

test('normalizeName keeps apart names that mean different things', () => {
  const different = [
    ['24 Hour Flood Pros of AZ - Repairs', '24 Hour Flood Pros of Arizona'],
    ['24 Hour Flood Pros of Dallas', '24 Hour Flood Pros of Denver'],
    ['A1 Restoration of Portland', '1st Choice Restoration of Portland'],
    ['American Packout of Dallas', 'Prime Packouts of Dallas'],
    ['24 Hour Flood Pros', '24 Hour Flood Pros of Dallas'],
  ];
  for (const [a, b] of different) assert.notEqual(normalizeName(a), normalizeName(b), a);
});

test('matchLocations auto-accepts only one clean match', () => {
  const subs = [
    { id: '1', name: 'A1 Restoration of Dallas' },
    { id: '2', name: 'American Fire and Flood of Long Island' },
    { id: '3', name: 'American Fire and Flood of Long Island' },
    { id: '4', name: 'A1 Restoration Elimxx' },
    { id: '5', name: 'A1 Restoration of Denver', iselimination: 'T' },
    { id: '6', name: '24 Hour Flood Pros of Arizona' },
  ];
  const at = (name) => matchLocations([{ name }], subs)[0];
  assert.equal(at('A1 Restoration of Dallas').subsidiary.id, '1');
  assert.equal(at('A1 Restoration of Dallas').status, 'exact');
  const dup = at('American Fire & Flood of Long Island');
  assert.equal(dup.status, 'ambiguous');
  assert.deepEqual(dup.suggestions.map((s) => s.id), ['2', '3']);
  assert.equal(at('A1 Restoration Elimxx').status, 'review', 'elimination entities never match exactly');
  assert.equal(at('A1 Restoration of Denver').status, 'review', 'flagged elimination entities never match exactly');
  const repairs = at('24 Hour Flood Pros of AZ - Repairs');
  assert.equal(repairs.status, 'review');
  assert.equal(repairs.subsidiary, undefined);
  assert.equal(repairs.suggestions[0].id, '6');
  assert.equal(at('Totally Unrelated Business').suggestions.length, 0);
});
