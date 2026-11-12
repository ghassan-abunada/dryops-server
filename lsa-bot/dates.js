'use strict';

// Date-only helpers. Everything is a local-calendar {y, m, d}; no Date maths on
// UTC strings, so a run just after midnight does not slip a day.

function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) throw new Error(`Expected YYYY-MM-DD, got "${s}"`);
  const d = { y: +m[1], m: +m[2], d: +m[3] };
  const back = toDate(d);
  if (back.getFullYear() !== d.y || back.getMonth() + 1 !== d.m || back.getDate() !== d.d) {
    throw new Error(`Not a real date: "${s}"`);
  }
  return d;
}

function toDate({ y, m, d }) {
  return new Date(y, m - 1, d);
}

function fromDate(dt) {
  return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() };
}

function addDays(day, n) {
  const dt = toDate(day);
  dt.setDate(dt.getDate() + n);
  return fromDate(dt);
}

const pad = (n) => String(n).padStart(2, '0');
const ymd = ({ y, m, d }) => `${y}-${pad(m)}-${pad(d)}`;
const compact = ({ y, m, d }) => `${y}${pad(m)}${pad(d)}`;
const cmp = (a, b) => toDate(a) - toDate(b);

/** The window a run covers: explicit --from/--to, else the last `days` days ending today. */
function resolveWindow({ from, to, days }, today = fromDate(new Date())) {
  const end = to ? parseYmd(to) : today;
  const start = from ? parseYmd(from) : addDays(end, -(Math.max(1, days || 30) - 1));
  if (cmp(start, end) > 0) throw new Error(`--from ${ymd(start)} is after --to ${ymd(end)}`);
  return { start, end };
}

/** Split a window into calendar-month pieces (Google's report is requested one range at a time). */
function monthChunks({ start, end }) {
  const out = [];
  let cur = start;
  while (cmp(cur, end) <= 0) {
    const lastOfMonth = fromDate(new Date(cur.y, cur.m, 0));
    const stop = cmp(lastOfMonth, end) < 0 ? lastOfMonth : end;
    out.push({ start: cur, end: stop });
    cur = addDays(stop, 1);
  }
  return out;
}

module.exports = { parseYmd, toDate, fromDate, addDays, ymd, compact, cmp, resolveWindow, monthChunks };
