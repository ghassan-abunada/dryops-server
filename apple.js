'use strict';
// Apple Maps Server API — primary provider for geocoding, address type-ahead,
// drive-time ETAs and static map snapshots. Google (GOOGLE_MAPS_KEY) and the
// keyless Census / Nominatim / Photon chain in server.js remain the fallbacks:
// every function here swallows network errors (logged with an [apple] prefix)
// and returns [] / null so the caller moves on to the next provider.
//
// Env (all four required for configured() to be true):
//   APPLE_MAPS_TEAM_ID      Apple Developer team id
//   APPLE_MAPS_KEY_ID       key id of the MapKit JS / Maps Server API .p8 key
//   APPLE_MAPS_ID           the Maps ID (e.g. maps.app.dryops.server)
//   APPLE_MAPS_PRIVATE_KEY  the .p8 contents: raw PEM, one line with literal
//                           \n, or base64 of the whole file
//
// Auth: a short-lived ES256 JWT (iss=team, sub=maps id, kid=key id) is traded
// at GET /v1/token for an access token (~30 min) that every API call carries.
// Web Snapshots are signed per URL with the same key (no token exchange).

const crypto = require('crypto');

const MAPS_API = 'https://maps-api.apple.com';
const SNAPSHOT_API = 'https://snapshot.apple-mapkit.com';
const SNAPSHOT_PATH = '/api/v1/snapshot';
const JWT_TTL_S = 1800;
const TOKEN_REFRESH_SKEW_MS = 60 * 1000;
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 2000;
const ETA_CHUNK = 10;
const FETCH_TIMEOUT_MS = 8000;

// ── Pure helpers (exported for tests) ────────────────────────────────────────

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** Accepts the raw .p8 text, a single line with literal "\n", or base64 of the file. */
function normalizePrivateKey(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1).trim();
  if (s.includes('\\n')) s = s.replace(/\\r/g, '').replace(/\\n/g, '\n');
  if (!s.includes('-----BEGIN')) {
    try {
      const dec = Buffer.from(s.replace(/\s+/g, ''), 'base64').toString('utf8');
      if (dec.includes('-----BEGIN')) s = dec.trim();
    } catch { /* leave as-is; createPrivateKey reports the problem */ }
  }
  const m = /-----BEGIN ([A-Z ]*PRIVATE KEY)-----([\s\S]*?)-----END \1-----/.exec(s);
  if (!m) return s;
  const body = m[2].replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g) || [];
  return `-----BEGIN ${m[1]}-----\n${lines.join('\n')}\n-----END ${m[1]}-----\n`;
}

function toKeyObject(privateKey) {
  if (!privateKey) throw new Error('private key missing');
  if (typeof privateKey === 'object' && typeof privateKey.type === 'string') return privateKey; // KeyObject
  return crypto.createPrivateKey({ key: normalizePrivateKey(privateKey), format: 'pem' });
}

/** ES256 (raw r||s, base64url) over `data` — the JWS/JWT signature encoding. */
function es256(data, privateKey, dsaEncoding = 'ieee-p1363') {
  return b64url(crypto.sign('sha256', Buffer.from(data, 'utf8'), { key: toKeyObject(privateKey), dsaEncoding }));
}

/** Maps Server API auth JWT. `now` is ms since epoch (a Date or seconds also work). */
function makeAuthJwt({ teamId, keyId, mapsId, privateKey, now, ttl = JWT_TTL_S }) {
  let t = now instanceof Date ? now.getTime() : (now == null ? Date.now() : Number(now));
  if (t < 1e11) t *= 1000; // seconds were passed
  const iat = Math.floor(t / 1000);
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const payload = { iss: teamId, iat, exp: iat + ttl };
  if (mapsId) payload.sub = mapsId;
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${signingInput}.${es256(signingInput, privateKey)}`;
}

/**
 * Web Snapshots signature: ES256 over the path + query WITHOUT the signature
 * param (e.g. "/api/v1/snapshot?center=…&teamId=…&keyId=…"), base64url.
 * `dsaEncoding` defaults to ieee-p1363; pass 'der' if Apple rejects it.
 */
function signSnapshotQuery(pathAndQuery, privateKey, dsaEncoding = 'ieee-p1363') {
  return es256(String(pathAndQuery), privateKey, dsaEncoding);
}

/** "lat,lng" (or {lat,lng} / {latitude,longitude}) → { lat, lng } or null. */
function parseLatLng(v) {
  let lat, lng;
  if (v && typeof v === 'object') {
    lat = Number(v.lat != null ? v.lat : v.latitude);
    lng = Number(v.lng != null ? v.lng : (v.lon != null ? v.lon : v.longitude));
  } else {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(v == null ? '' : v));
    if (!m) return null;
    lat = Number(m[1]); lng = Number(m[2]);
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const fmtCoord = (p) => `${Number(p.lat).toFixed(6)},${Number(p.lng).toFixed(6)}`;
const round4 = (n) => Number(n).toFixed(4);

/** Apple place/search result → the shape the app's address fields consume. */
function placeFromResult(r) {
  if (!r) return null;
  const c = r.coordinate || r.location || {};
  const lat = Number(c.latitude), lng = Number(c.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const sa = r.structuredAddress || {};
  const lines = Array.isArray(r.formattedAddressLines) ? r.formattedAddressLines.filter(Boolean) : [];
  if (lines.length > 1 && /^united states$/i.test(lines[lines.length - 1])) lines.pop();
  const street = [sa.subThoroughfare, sa.thoroughfare].filter(Boolean).join(' ').trim()
    || String(sa.fullThoroughfare || '').trim();
  const city = String(sa.locality || (Array.isArray(sa.dependentLocalities) && sa.dependentLocalities[0]) || sa.subLocality || '').trim();
  const state = String(sa.administrativeAreaCode || sa.administrativeArea || '').trim();
  const zip = String(sa.postCode || '').trim();
  const formatted = lines.length ? lines.join(', ')
    : [street, city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return { lat, lng, formatted, street, city, state, zip };
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * createApple(env, deps) → { configured, geocode, autocomplete, resolveCompletion, etas, snapshotUrl }
 * deps.geoCacheSet(key, value): server.js's geo cache, so autocomplete can
 * pre-seed `details:geo:<lat>,<lng>` for the existing /places/details path.
 */
function createApple(env = process.env, deps = {}) {
  const TEAM_ID = String(env.APPLE_MAPS_TEAM_ID || '').trim();
  const KEY_ID = String(env.APPLE_MAPS_KEY_ID || '').trim();
  const MAPS_ID = String(env.APPLE_MAPS_ID || '').trim();
  const PRIVATE_KEY_RAW = String(env.APPLE_MAPS_PRIVATE_KEY || '').trim();
  const SNAPSHOT_SIG = /^der$/i.test(String(env.APPLE_MAPS_SNAPSHOT_SIG || '')) ? 'der' : 'ieee-p1363';
  const geoCacheSet = typeof deps.geoCacheSet === 'function' ? deps.geoCacheSet : null;
  const log = deps.log || console;

  let keyObj = null, keyChecked = false;
  function key() {
    if (keyChecked) return keyObj;
    keyChecked = true;
    if (!PRIVATE_KEY_RAW) return null;
    try { keyObj = toKeyObject(PRIVATE_KEY_RAW); }
    catch (err) { log.error('[apple] APPLE_MAPS_PRIVATE_KEY is not a usable EC private key:', err.message); keyObj = null; }
    return keyObj;
  }
  const configured = () => !!(TEAM_ID && KEY_ID && MAPS_ID && PRIVATE_KEY_RAW && key());

  // ── 1 h result cache ──
  const cache = new Map(); // key → { t, v }
  function cacheGet(k) {
    const hit = cache.get(k);
    if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.v;
    cache.delete(k);
    return null;
  }
  function cacheSet(k, v) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(k, { t: Date.now(), v });
    return v;
  }

  // ── access token ──
  let token = null; // { value, expiresAt }
  let tokenInflight = null;
  async function getAccessToken(force = false) {
    if (!force && token && token.expiresAt - TOKEN_REFRESH_SKEW_MS > Date.now()) return token.value;
    if (!tokenInflight) {
      tokenInflight = (async () => {
        try {
          const jwt = makeAuthJwt({ teamId: TEAM_ID, keyId: KEY_ID, mapsId: MAPS_ID, privateKey: key() });
          const r = await fetch(`${MAPS_API}/v1/token`, {
            headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });
          if (!r.ok) {
            log.error('[apple] token exchange failed', r.status, (await r.text().catch(() => '')).slice(0, 200));
            return null;
          }
          const d = await r.json().catch(() => null);
          if (!d || !d.accessToken) { log.error('[apple] token response missing accessToken'); return null; }
          const ttlS = Number(d.expiresInSeconds) > 0 ? Number(d.expiresInSeconds) : JWT_TTL_S;
          token = { value: d.accessToken, expiresAt: Date.now() + ttlS * 1000 };
          return token.value;
        } catch (err) {
          log.error('[apple] token exchange error', err.message);
          return null;
        } finally { tokenInflight = null; }
      })();
    }
    return tokenInflight;
  }

  /** GET <MAPS_API><pathAndQuery> with a bearer token; one refresh+retry on 401. Returns parsed JSON or null. */
  async function api(pathAndQuery, retry = true) {
    if (!configured()) return null;
    try {
      const t = await getAccessToken();
      if (!t) return null;
      const r = await fetch(`${MAPS_API}${pathAndQuery}`, {
        headers: { Authorization: `Bearer ${t}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (r.status === 401 && retry) {
        token = null;
        await getAccessToken(true);
        return api(pathAndQuery, false);
      }
      if (!r.ok) {
        log.error('[apple]', r.status, pathAndQuery.split('?')[0], (await r.text().catch(() => '')).slice(0, 200));
        return null;
      }
      return await r.json().catch(() => null);
    } catch (err) {
      log.error('[apple] request error', pathAndQuery.split('?')[0], err.message);
      return null;
    }
  }

  // ── geocode ──
  async function geocode(address) {
    const q = String(address || '').trim();
    if (q.length < 3 || !configured()) return [];
    const ck = `geocode:${q.toLowerCase()}`;
    const hit = cacheGet(ck);
    if (hit) return hit;
    const params = new URLSearchParams({ q: q.slice(0, 300), limitToCountries: 'US', lang: 'en-US' });
    const d = await api(`/v1/geocode?${params}`);
    if (!d) return [];
    const out = ((d.results || []).map(placeFromResult)).filter(Boolean).slice(0, 5);
    return cacheSet(ck, out);
  }

  // ── autocomplete ──
  async function autocomplete(q, { bias, limit = 5 } = {}) {
    const query = String(q || '').trim();
    if (query.length < 3 || !configured()) return [];
    const b = bias && Number.isFinite(Number(bias.lat)) && Number.isFinite(Number(bias.lon != null ? bias.lon : bias.lng))
      ? { lat: Number(bias.lat), lon: Number(bias.lon != null ? bias.lon : bias.lng) } : null;
    const ck = `ac:${query.toLowerCase()}:${limit}:${b ? `${b.lat.toFixed(1)},${b.lon.toFixed(1)}` : '-'}`;
    const hit = cacheGet(ck);
    if (hit) return hit;
    const params = new URLSearchParams({ q: query.slice(0, 200), resultTypeFilter: 'Address', limitToCountries: 'US', lang: 'en-US' });
    if (b) params.set('searchLocation', `${b.lat},${b.lon}`);
    const d = await api(`/v1/searchAutocomplete?${params}`);
    if (!d) return [];
    const seen = new Set();
    const out = [];
    for (const r of d.results || []) {
      const description = (Array.isArray(r.displayLines) ? r.displayLines : []).filter(Boolean).join(', ');
      if (!description || seen.has(description.toLowerCase())) continue;
      let place_id = null;
      const place = placeFromResult(r);
      if (place) {
        place_id = `geo:${place.lat},${place.lng}`;
        if (!place.formatted) place.formatted = description;
        if (geoCacheSet) geoCacheSet(`details:${place_id}`, place);
        cacheSet(`details:${place_id}`, place);
      } else if (r.completionUrl) {
        place_id = `apple:${b64url(String(r.completionUrl))}`;
      }
      if (!place_id) continue;
      seen.add(description.toLowerCase());
      out.push({ description, place_id });
      if (out.length >= limit) break;
    }
    return cacheSet(ck, out);
  }

  // ── completion → place ──
  async function resolveCompletion(placeId) {
    const id = String(placeId || '');
    if (!id.startsWith('apple:')) return null;
    const hit = cacheGet(`details:${id}`);
    if (hit) return hit;
    let completionUrl = '';
    try { completionUrl = Buffer.from(id.slice(6), 'base64url').toString('utf8'); } catch { return null; }
    if (!/^\/v1\/[A-Za-z]+\?/.test(completionUrl)) { log.error('[apple] bad completionUrl in place id'); return null; }
    const d = await api(completionUrl);
    if (!d) return null;
    const place = placeFromResult((d.results || [])[0]);
    return place ? cacheSet(`details:${id}`, place) : null;
  }

  // ── ETAs ──
  async function etas({ origin, destinations, departureDate } = {}) {
    const o = parseLatLng(origin);
    const dests = (destinations || []).map(parseLatLng);
    if (!o || !dests.length || dests.some(d => !d) || !configured()) return [];
    let depart = null;
    if (departureDate) {
      const dt = new Date(departureDate);
      if (Number.isFinite(dt.getTime()) && dt.getTime() > Date.now() - 5 * 60 * 1000) depart = dt;
    }
    const departHour = depart ? Math.floor(depart.getTime() / 3600000) : 'now';
    const results = new Array(dests.length).fill(null);
    for (const group of chunk(dests.map((d, i) => ({ d, i })), ETA_CHUNK)) {
      const ck = `eta:${round4(o.lat)},${round4(o.lng)}>${group.map(g => `${round4(g.d.lat)},${round4(g.d.lng)}`).join('|')}@${departHour}`;
      let legs = cacheGet(ck);
      if (!legs) {
        const params = new URLSearchParams({
          origin: fmtCoord(o),
          destinations: group.map(g => fmtCoord(g.d)).join('|'),
          transportType: 'Automobile',
        });
        if (depart) params.set('departureDate', depart.toISOString().replace(/\.\d{3}Z$/, 'Z'));
        const d = await api(`/v1/etas?${params}`);
        if (!d || !Array.isArray(d.etas)) continue;
        legs = group.map((g, idx) => {
          const byCoord = d.etas.find(e => e && e.destination
            && Math.abs(Number(e.destination.latitude) - g.d.lat) < 1e-4
            && Math.abs(Number(e.destination.longitude) - g.d.lng) < 1e-4);
          const e = byCoord || d.etas[idx];
          if (!e) return null;
          const seconds = Number(e.expectedTravelTimeSeconds);
          if (!Number.isFinite(seconds)) return null;
          return {
            lat: g.d.lat, lng: g.d.lng, seconds,
            staticSeconds: Number.isFinite(Number(e.staticTravelTimeSeconds)) ? Number(e.staticTravelTimeSeconds) : seconds,
            meters: Number.isFinite(Number(e.distanceMeters)) ? Number(e.distanceMeters) : null,
          };
        });
        cacheSet(ck, legs);
      }
      group.forEach((g, idx) => { results[g.i] = legs[idx] || null; });
    }
    return results;
  }

  // ── Web Snapshot URL ──
  function snapshotUrl({ lat, lng, w = 600, h = 300, zoom = 16, scale = 2, colorScheme = 'light', annotations, expiresIn = 3600, now } = {}) {
    const p = parseLatLng({ lat, lng });
    if (!p || !configured()) return null;
    const W = Math.max(50, Math.min(640, Math.round(Number(w) || 600)));
    const H = Math.max(50, Math.min(640, Math.round(Number(h) || 300)));
    const Z = Math.max(3, Math.min(20, Number(zoom) || 16));
    const ann = Array.isArray(annotations) ? annotations : [{ point: `${p.lat},${p.lng}`, color: 'red', glyphText: '' }];
    const expires = Math.floor(((now == null ? Date.now() : Number(now)) / 1000) + expiresIn);
    const query = [
      `center=${p.lat},${p.lng}`,
      `z=${Z}`,
      `size=${W}x${H}`,
      `scale=${scale === 1 ? 1 : 2}`,
      `colorScheme=${colorScheme === 'dark' ? 'dark' : 'light'}`,
      `annotations=${encodeURIComponent(JSON.stringify(ann))}`,
      `expires=${expires}`,
      `teamId=${encodeURIComponent(TEAM_ID)}`,
      `keyId=${encodeURIComponent(KEY_ID)}`,
    ].join('&');
    const pathAndQuery = `${SNAPSHOT_PATH}?${query}`;
    const signature = signSnapshotQuery(pathAndQuery, key(), SNAPSHOT_SIG);
    return `${SNAPSHOT_API}${pathAndQuery}&signature=${signature}`;
  }

  return { configured, geocode, autocomplete, resolveCompletion, etas, snapshotUrl };
}

module.exports = createApple;
module.exports.createApple = createApple;
module.exports.makeAuthJwt = makeAuthJwt;
module.exports.normalizePrivateKey = normalizePrivateKey;
module.exports.signSnapshotQuery = signSnapshotQuery;
module.exports.parseLatLng = parseLatLng;
module.exports.placeFromResult = placeFromResult;
module.exports.chunk = chunk;
module.exports.ETA_CHUNK = ETA_CHUNK;
module.exports.MAPS_API = MAPS_API;
module.exports.SNAPSHOT_API = SNAPSHOT_API;
