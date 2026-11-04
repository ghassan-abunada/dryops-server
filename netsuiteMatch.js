// Matches DryOps locations to NetSuite subsidiaries by name. A match is "exact"
// only when one subsidiary has the same normalized name; everything else goes to
// review with suggestions, because a wrong mapping would silently misstate spending.
const STATES = {
  al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california', co: 'colorado', ct: 'connecticut',
  fl: 'florida', ga: 'georgia', hi: 'hawaii', id: 'idaho', il: 'illinois', in: 'indiana', ks: 'kansas', ky: 'kentucky',
  la: 'louisiana', ma: 'massachusetts', mi: 'michigan', mn: 'minnesota', mo: 'missouri', mt: 'montana', nc: 'north carolina',
  nv: 'nevada', nj: 'new jersey', nm: 'new mexico', ny: 'new york', oh: 'ohio', ok: 'oklahoma', or: 'oregon', pa: 'pennsylvania',
  ri: 'rhode island', sc: 'south carolina', tn: 'tennessee', tx: 'texas', ut: 'utah', va: 'virginia', wa: 'washington',
};
const STATE_NAMES = new Set(Object.values(STATES));

function normalizeName(name) {
  let s = String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/\(.*?\)/g, ' ');
  s = s.replace(/,?\s*\b(llc|inc|l\.l\.c)\b\.?/g, ' ').replace(/[.,]/g, ' , ').replace(/-/g, ' ');
  // A trailing state only qualifies a city ("Dallas, Texas"), so drop it after a comma.
  s = s.replace(/,\s*([a-z ]+?)\s*(,\s*)*$/, (m, tail) => (STATES[tail.trim()] || STATE_NAMES.has(tail.trim()) ? ' ' : ` ${tail} `));
  s = s.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^24 flood pros\b/, '24 hour flood pros').replace(/\bpackouts\b/g, 'packout').replace(/\babatements\b/g, 'abatement');
  s = s.replace(/\bof ([a-z]{2})$/, (m, st) => (STATES[st] ? `of ${STATES[st]}` : m));
  return s;
}

function similarity(a, b) {
  const grams = (s) => { const out = new Map(); for (let i = 0; i < s.length - 1; i += 1) { const g = s.slice(i, i + 2); out.set(g, (out.get(g) || 0) + 1); } return out; };
  const ga = grams(a); const gb = grams(b);
  let hit = 0; for (const [g, n] of ga) hit += Math.min(n, gb.get(g) || 0);
  const total = Math.max(a.length - 1, 0) + Math.max(b.length - 1, 0);
  return total ? (2 * hit) / total : 0;
}

function matchLocations(locations, subsidiaries) {
  const usable = subsidiaries.filter((s) => !/elimxx/i.test(s.name) && String(s.iselimination).toUpperCase() !== 'T');
  const byName = new Map();
  for (const s of usable) { const k = normalizeName(s.name); byName.set(k, [...(byName.get(k) || []), s]); }
  return locations.map((location) => {
    const key = normalizeName(location.name);
    const same = byName.get(key) || [];
    if (same.length === 1) return { location, status: 'exact', subsidiary: same[0] };
    const suggestions = same.length > 1 ? same : usable
      .map((s) => ({ s, score: similarity(key, normalizeName(s.name)) }))
      .filter((x) => x.score >= 0.6).sort((a, b) => b.score - a.score).slice(0, 3).map((x) => x.s);
    return { location, status: same.length > 1 ? 'ambiguous' : 'review', suggestions };
  });
}

// Gurr rolls locations into state subsidiaries, so scope = Gurr subsidiaries that
// matched a location exactly, plus the state rollups the owner confirmed by name.
function gurrScope(subsidiaries, matchedIds, rollupNames) {
  const matched = new Set(matchedIds.map(String));
  const rollups = new Set(rollupNames);
  return subsidiaries.filter((s) => /^Gurr Brothers/.test(s.name) && !/elimxx/i.test(s.name)
    && (matched.has(String(s.id)) || rollups.has(s.name)));
}

// Mitigation and Contents only. Gurr is the Rebuild side even where a Gurr location
// is typed Mitigation. `confirmed` maps a DryOps location name to the owner's chosen
// subsidiary; a chosen name that isn't unique in NetSuite throws rather than guesses.
function mitigationPackoutScope(matches, subsidiaries, confirmed) {
  const TYPES = new Set(['Mitigation', 'Contents']);
  const scope = new Map();
  for (const m of matches) {
    if (!TYPES.has(m.location_type) || /^Gurr/i.test(m.location)) continue;
    let sub = m.status === 'exact' ? m.subsidiary : null;
    const pick = confirmed[m.location];
    if (pick) {
      const found = subsidiaries.filter((s) => (pick.id ? String(s.id) === String(pick.id) : s.name === pick.name));
      if (found.length !== 1) throw new Error(`Confirmed subsidiary for ${m.location} matched ${found.length} rows`);
      [sub] = found;
    }
    if (!sub || /^Gurr/i.test(sub.name)) continue;
    const key = String(sub.id);
    if (!scope.has(key)) scope.set(key, { id: sub.id, name: sub.name, locations: [] });
    scope.get(key).locations.push({ name: m.location, type: m.location_type, status: m.location_status, jobs: m.jobs });
  }
  return [...scope.values()];
}

module.exports = { normalizeName, similarity, matchLocations, gurrScope, mitigationPackoutScope };
