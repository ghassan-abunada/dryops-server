'use strict';
// Reads a CallRail call webhook body (pre-call, post-call, outbound, modified)
// into the call object mapCallRow expects, whatever envelope CallRail used:
//   { ...call }                       plain JSON
//   { data: {...call} } / [ {...} ]   wrapped
//   { call: {...call} }
//   form-encoded with a JSON string   payload=<json> / data=<json> / call=<json>
// and the call's id as `id`, `call_id` or `resource_id` (CallRail's webhooks
// carry the CAL… id as resource_id). Returns null when there is no call in it.
// 2026-11-03: every delivery was being skipped as "no id" in 1–9 ms, so no
// live call reached the database (owner alerts never fired).

function parseMaybeJson(v) {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (!s || (s[0] !== '{' && s[0] !== '[')) return v;
  try { return JSON.parse(s); } catch { return v; }
}

function unwrap(body) {
  let b = parseMaybeJson(body);
  for (let i = 0; i < 3 && b && typeof b === 'object'; i++) {
    if (Array.isArray(b)) { b = b[0]; continue; }
    const inner = ['data', 'call', 'payload'].map((k) => parseMaybeJson(b[k])).find((x) => x && typeof x === 'object');
    // Only descend when this level is an envelope (no call fields of its own).
    if (inner && !callId(b)) { b = inner; continue; }
    break;
  }
  return b && typeof b === 'object' && !Array.isArray(b) ? b : null;
}

/**
 * The CAL… id: resource_id first (webhooks), then an `id` that is a CAL… id
 * (API rows), then call_id. A bare numeric `id` (legacy webhook field) is not a
 * call id we can store, so it alone yields ''.
 */
function callId(c) {
  if (!c || typeof c !== 'object') return '';
  const str = (v) => (v == null ? '' : String(v).trim());
  if (str(c.resource_id)) return str(c.resource_id);
  if (/^CAL/i.test(str(c.id))) return str(c.id);
  if (str(c.call_id)) return str(c.call_id);
  return '';
}

/** The call object with a usable `id`, or null. */
function readCallrailCall(body) {
  const c = unwrap(body);
  if (!c) return null;
  const id = callId(c);
  if (!id) return null;
  return { ...c, id };
}

/** What a skipped delivery looked like, for the log (keys only, never values). */
function describeBody(body, contentType) {
  const b = parseMaybeJson(body);
  const keys = b && typeof b === 'object' ? Object.keys(Array.isArray(b) ? (b[0] || {}) : b).slice(0, 25) : [];
  return { contentType: String(contentType || '').slice(0, 80), type: Array.isArray(b) ? 'array' : typeof b, keys };
}

module.exports = { readCallrailCall, describeBody, callId };
