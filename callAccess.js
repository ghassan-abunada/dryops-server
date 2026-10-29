// Call-tracking visibility for expansion managers (owner decision 2026-10-29).
// A manager sees tracking numbers assigned to THEIR locations plus unassigned
// ones; numbers assigned to other locations stay hidden. Admin / owner /
// executive see everything. Pure helpers so server.js (GET /admin/callrail/numbers)
// and wyh.js (recording-link) share one rule; covered by test/callAccess.test.js.

const MANAGER_ROLE = 'expansion_manager';

// Last-10-digit matching form, same as server.js / sms.js normPhone.
function phoneNorm(v) {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : (d || null);
}

// Active location_tracking_numbers rows → Map<phone_norm, Set<location_id>>.
// Rows without a location_id count as unassigned and are skipped.
function assignmentsByNorm(rows) {
  const map = new Map();
  for (const r of rows || []) {
    if (!r || !r.phone_norm || !r.location_id) continue;
    const k = String(r.phone_norm);
    if (!map.has(k)) map.set(k, new Set());
    map.get(k).add(String(r.location_id));
  }
  return map;
}

// Unassigned → visible; assigned → visible only when every assignment is one
// of the manager's locations.
function numberVisibleTo(trackingNumber, assignments, locs) {
  const n = phoneNorm(trackingNumber);
  const assigned = n ? assignments.get(n) : null;
  if (!assigned || !assigned.size) return true;
  const mine = new Set((locs || []).map(String));
  for (const loc of assigned) if (!mine.has(loc)) return false;
  return true;
}

module.exports = { MANAGER_ROLE, phoneNorm, assignmentsByNorm, numberVisibleTo };
