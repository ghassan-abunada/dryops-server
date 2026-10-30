// Location-scoped JobNimbus proxy access (owner decision 2026-10-30).
// /jnapi forwards with the master JN token, so a scoped caller may only make
// the requests the app itself makes, and only on JN jobs whose DryOps row is in
// one of the caller's locations. Today only demo profiles (profiles.is_demo,
// the App Review account) are scoped; widening it to every non-admin is the
// follow-up. Pure helpers so server.js and test/jnScope.test.js share one rule.

// JN job ids a request touches, or null when the request is not on the
// allow-list (scoped callers are refused). Mirrors the app's calls:
//   GET/PUT /jobs/:jnid                      lib/jn.ts (job read, field/status write)
//   GET /files|/activities ?related=<jnid>   job page Files + Activity feeds
//   POST /activities  related/primary = jobs  lib/jn.ts addJNNote
function jnRequestJobIds(method, path, query, body) {
  const m = String(method || '').toUpperCase();
  const p = String(path || '').replace(/\/+$/, '');
  const q = query || {};

  const job = p.match(/^\/jobs\/([A-Za-z0-9_-]+)$/);
  if (job && (m === 'GET' || m === 'PUT')) return [job[1]];

  if (m === 'GET' && (p === '/files' || p === '/activities')) {
    const rel = typeof q.related === 'string' ? q.related.trim() : '';
    return /^[A-Za-z0-9_-]+$/.test(rel) ? [rel] : null;
  }

  if (m === 'POST' && p === '/activities') {
    const b = body || {};
    const refs = [...(Array.isArray(b.related) ? b.related : []), ...(b.primary ? [b.primary] : [])];
    if (!refs.length) return null;
    const ids = [];
    for (const r of refs) {
      if (!r || r.type !== 'job' || typeof r.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(r.id)) return null;
      ids.push(r.id);
    }
    return [...new Set(ids)];
  }

  return null;
}

// A profile's location scope, same order as the app's lib/profile.ts getLocationIds.
function profileLocationIds(p) {
  if (!p) return [];
  if (Array.isArray(p.location_ids) && p.location_ids.length) return p.location_ids.map(String);
  return p.location_id ? [String(p.location_id)] : [];
}

// Every requested JN job must exist in DryOps and sit in one of `locs`.
// `jobRows` = jobs rows ({ jn_id, location_id }) looked up for `jnIds`.
function jobsInScope(jnIds, jobRows, locs) {
  if (!jnIds || !jnIds.length) return false;
  const mine = new Set((locs || []).map(String));
  if (!mine.size) return false;
  const byJn = new Map();
  for (const r of jobRows || []) if (r && r.jn_id) byJn.set(String(r.jn_id), r.location_id == null ? null : String(r.location_id));
  return jnIds.every((id) => byJn.has(id) && mine.has(byJn.get(id)));
}

module.exports = { jnRequestJobIds, profileLocationIds, jobsInScope };
