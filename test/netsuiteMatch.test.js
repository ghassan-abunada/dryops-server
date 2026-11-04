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

test('gurrScope keeps matched and confirmed Gurr subsidiaries only', () => {
  const { gurrScope } = require('../netsuiteMatch');
  const subs = [
    { id: '1', name: 'Gurr Brothers Construction of Texas' },
    { id: '2', name: 'Gurr Brothers Construction of Hawaii' },
    { id: '3', name: 'Gurr Brothers Construction of Alaska' },
    { id: '4', name: 'Gurr Brothers Construction Elimxx' },
    { id: '5', name: 'A1 Restoration of Dallas' },
  ];
  const ids = gurrScope(subs, [1, '4', '5'], ['Gurr Brothers Construction of Hawaii']).map((s) => s.id);
  assert.deepEqual(ids, ['1', '2']);
});

test('mitigationPackoutScope keeps Mitigation and Contents, applies picks, leaves out Gurr', () => {
  const { mitigationPackoutScope } = require('../netsuiteMatch');
  const subs = [
    { id: '1', name: 'A1 Restoration of Seattle' },
    { id: '289', name: 'American Fire and Flood of Long Island' },
    { id: '290', name: 'American Fire and Flood of Long Island' },
    { id: '9', name: 'Dup' }, { id: '10', name: 'Dup' },
  ];
  const row = (location, location_type, extra = {}) => ({ location, location_type, location_status: 'active', jobs: 1, status: 'review', ...extra });
  const matches = [
    row('A1 Restoration - Seattle', 'Mitigation'),
    row('American Fire and Flood of Long Island', 'Mitigation', { status: 'ambiguous' }),
    row('American Packout of Dallas', 'Contents', { status: 'exact', subsidiary: { id: '20', name: 'American Packout of Dallas' } }),
    row('A1 Rebuild', 'Rebuild', { status: 'exact', subsidiary: { id: '30', name: 'A1 Rebuild' } }),
    row('Gurr Brothers Construction of Colorado - AJ', 'Mitigation', { status: 'exact', subsidiary: { id: '40', name: 'Gurr Brothers Construction of Colorado' } }),
    row('Unmapped', 'Mitigation'),
  ];
  const picks = { 'A1 Restoration - Seattle': { name: 'A1 Restoration of Seattle' }, 'American Fire and Flood of Long Island': { id: 290 } };
  assert.deepEqual(mitigationPackoutScope(matches, subs, picks).map((s) => String(s.id)).sort(), ['1', '20', '290']);
  assert.throws(() => mitigationPackoutScope([row('X', 'Mitigation')], subs, { X: { name: 'Dup' } }), /matched 2 rows/);
});
