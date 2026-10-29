// Expansion-manager call-tracking visibility (callAccess.js). Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const { phoneNorm, assignmentsByNorm, numberVisibleTo } = require('../callAccess');

const rows = [
  { phone_norm: '5551110000', location_id: 'loc-a' },
  { phone_norm: '5552220000', location_id: 'loc-b' },
  { phone_norm: '5553330000', location_id: null }, // active but not assigned
  { phone_norm: '5554440000', location_id: 'loc-a' },
  { phone_norm: '5554440000', location_id: 'loc-b' }, // shared with a foreign location
];
const map = assignmentsByNorm(rows);

test('phoneNorm keeps the last 10 digits', () => {
  assert.strictEqual(phoneNorm('+1 (555) 111-0000'), '5551110000');
  assert.strictEqual(phoneNorm('555-1234'), '5551234');
  assert.strictEqual(phoneNorm(null), null);
});

test('a manager sees their own and unassigned numbers, never another location\'s', () => {
  const locs = ['loc-a'];
  assert.strictEqual(numberVisibleTo('+15551110000', map, locs), true);
  assert.strictEqual(numberVisibleTo('+15552220000', map, locs), false);
  assert.strictEqual(numberVisibleTo('+15553330000', map, locs), true);
  assert.strictEqual(numberVisibleTo('+15559990000', map, locs), true);
});

test('a number also assigned to a foreign location stays hidden', () => {
  assert.strictEqual(numberVisibleTo('5554440000', map, ['loc-a']), false);
  assert.strictEqual(numberVisibleTo('5554440000', map, ['loc-a', 'loc-b']), true);
});

test('a manager with no locations sees only unassigned numbers', () => {
  assert.strictEqual(numberVisibleTo('5551110000', map, []), false);
  assert.strictEqual(numberVisibleTo('5553330000', map, []), true);
});
