// A function declared twice at the top level of a CommonJS file is legal JS:
// the later one silently replaces the earlier one for every caller. That is
// how a second `sbInsert` (return=minimal) broke the ad-hoc visit endpoint.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('server.js declares each top-level function once', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const lines = {};
  src.split('\n').forEach((line, i) => {
    const m = /^(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)\s*\(/.exec(line);
    if (m) (lines[m[1]] = lines[m[1]] || []).push(i + 1);
  });
  const dups = Object.entries(lines).filter(([, at]) => at.length > 1).map(([name, at]) => `${name} (lines ${at.join(', ')})`);
  assert.deepStrictEqual(dups, []);
});
