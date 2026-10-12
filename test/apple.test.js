// Apple Maps Server API helpers (apple.js): JWT/ES256 signing, key
// normalisation, snapshot signatures, coordinate parsing, ETA chunking and the
// provider wiring that must not touch the network. Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const apple = require('../apple');
const { makeAuthJwt, normalizePrivateKey, signSnapshotQuery, parseLatLng, chunk, placeFromResult, ETA_CHUNK, createApple } = apple;

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

const b64urlJson = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

test('makeAuthJwt: ES256 header/payload fields and a verifiable ieee-p1363 signature', () => {
  const now = 1_760_000_000_000; // ms
  const jwt = makeAuthJwt({ teamId: 'TEAM123456', keyId: 'KEY1234567', mapsId: 'maps.app.dryops.server', privateKey: pem, now });
  const parts = jwt.split('.');
  assert.strictEqual(parts.length, 3);
  const header = b64urlJson(parts[0]);
  const payload = b64urlJson(parts[1]);
  assert.deepStrictEqual(header, { alg: 'ES256', kid: 'KEY1234567', typ: 'JWT' });
  assert.strictEqual(payload.iss, 'TEAM123456');
  assert.strictEqual(payload.sub, 'maps.app.dryops.server');
  assert.strictEqual(payload.iat, 1_760_000_000);
  assert.strictEqual(payload.exp, 1_760_000_000 + 1800);
  const sig = Buffer.from(parts[2], 'base64url');
  assert.strictEqual(sig.length, 64, 'raw r||s is 64 bytes');
  const ok = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, sig);
  assert.strictEqual(ok, true);
  // tampering breaks it
  const bad = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}x`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, sig);
  assert.strictEqual(bad, false);
});

test('makeAuthJwt: accepts seconds, a Date, and a KeyObject', () => {
  const a = b64urlJson(makeAuthJwt({ teamId: 'T', keyId: 'K', mapsId: 'M', privateKey: privateKey, now: 1_700_000_000 }).split('.')[1]);
  assert.strictEqual(a.iat, 1_700_000_000);
  const b = b64urlJson(makeAuthJwt({ teamId: 'T', keyId: 'K', mapsId: 'M', privateKey: pem, now: new Date(1_700_000_000_000) }).split('.')[1]);
  assert.strictEqual(b.iat, 1_700_000_000);
});

test('normalizePrivateKey: raw PEM, single line with literal \\n, base64 of the file — all load', () => {
  const forms = {
    raw: pem,
    rawWithQuotes: `"${pem.trim()}"`,
    oneLine: pem.trim().replace(/\n/g, '\\n'),
    base64: Buffer.from(pem).toString('base64'),
  };
  for (const [name, input] of Object.entries(forms)) {
    const norm = normalizePrivateKey(input);
    assert.match(norm, /^-----BEGIN PRIVATE KEY-----\n/, name);
    assert.match(norm, /\n-----END PRIVATE KEY-----\n$/, name);
    for (const line of norm.split('\n').slice(1, -2)) assert.ok(line.length <= 64, `${name}: wrapped at 64`);
    const k = crypto.createPrivateKey(norm);
    assert.strictEqual(k.asymmetricKeyType, 'ec', name);
    // same key: a signature made with it verifies against the original public key
    const sig = crypto.sign('sha256', Buffer.from('x'), { key: k, dsaEncoding: 'ieee-p1363' });
    assert.ok(crypto.verify('sha256', Buffer.from('x'), { key: publicKey, dsaEncoding: 'ieee-p1363' }, sig), name);
  }
  assert.strictEqual(normalizePrivateKey(''), '');
  assert.strictEqual(normalizePrivateKey(null), '');
  assert.strictEqual(normalizePrivateKey('not a key'), 'not a key');
});

test('signSnapshotQuery: ES256 over path+query, verifiable; DER variant too', () => {
  const pathAndQuery = '/api/v1/snapshot?center=32.78,-96.8&z=16&size=600x300&teamId=T&keyId=K';
  const sig = signSnapshotQuery(pathAndQuery, pem);
  const raw = Buffer.from(sig, 'base64url');
  assert.strictEqual(raw.length, 64);
  assert.ok(crypto.verify('sha256', Buffer.from(pathAndQuery), { key: publicKey, dsaEncoding: 'ieee-p1363' }, raw));
  const der = Buffer.from(signSnapshotQuery(pathAndQuery, pem, 'der'), 'base64url');
  assert.ok(crypto.verify('sha256', Buffer.from(pathAndQuery), { key: publicKey, dsaEncoding: 'der' }, der));
  assert.ok(!crypto.verify('sha256', Buffer.from(pathAndQuery + '&signature='), { key: publicKey, dsaEncoding: 'ieee-p1363' }, raw));
});

test('parseLatLng: strings, objects, aliases, bounds', () => {
  assert.deepStrictEqual(parseLatLng('32.78,-96.8'), { lat: 32.78, lng: -96.8 });
  assert.deepStrictEqual(parseLatLng(' 32.78 , -96.8 '), { lat: 32.78, lng: -96.8 });
  assert.deepStrictEqual(parseLatLng({ lat: '32.78', lng: '-96.8' }), { lat: 32.78, lng: -96.8 });
  assert.deepStrictEqual(parseLatLng({ latitude: 32.78, longitude: -96.8 }), { lat: 32.78, lng: -96.8 });
  assert.deepStrictEqual(parseLatLng({ lat: 32.78, lon: -96.8 }), { lat: 32.78, lng: -96.8 });
  assert.strictEqual(parseLatLng('91,0'), null);
  assert.strictEqual(parseLatLng('0,181'), null);
  assert.strictEqual(parseLatLng('32.78'), null);
  assert.strictEqual(parseLatLng(''), null);
  assert.strictEqual(parseLatLng(undefined), null);
  assert.strictEqual(parseLatLng({ lat: 'x', lng: 1 }), null);
});

test('chunk: ETA destinations split into groups of 10, order kept', () => {
  assert.strictEqual(ETA_CHUNK, 10);
  const items = Array.from({ length: 23 }, (_, i) => i);
  const groups = chunk(items, ETA_CHUNK);
  assert.deepStrictEqual(groups.map(g => g.length), [10, 10, 3]);
  assert.deepStrictEqual(groups.flat(), items);
  assert.deepStrictEqual(chunk([], 10), []);
});

test('placeFromResult: Apple geocode/search result → { lat, lng, formatted, street, city, state, zip }', () => {
  const r = {
    coordinate: { latitude: 32.7767, longitude: -96.797 },
    formattedAddressLines: ['1500 Marilla St', 'Dallas, TX  75201', 'United States'],
    structuredAddress: { subThoroughfare: '1500', thoroughfare: 'Marilla St', locality: 'Dallas', administrativeArea: 'Texas', administrativeAreaCode: 'TX', postCode: '75201' },
  };
  assert.deepStrictEqual(placeFromResult(r), {
    lat: 32.7767, lng: -96.797, formatted: '1500 Marilla St, Dallas, TX  75201',
    street: '1500 Marilla St', city: 'Dallas', state: 'TX', zip: '75201',
  });
  // autocomplete rows carry `location` instead of `coordinate`
  const ac = { location: { latitude: 1, longitude: 2 }, displayLines: ['x'], structuredAddress: { thoroughfare: 'Main St', locality: 'Plano', administrativeArea: 'TX' } };
  assert.deepStrictEqual(placeFromResult(ac), { lat: 1, lng: 2, formatted: 'Main St, Plano, TX', street: 'Main St', city: 'Plano', state: 'TX', zip: '' });
  assert.strictEqual(placeFromResult({ displayLines: ['no coords'] }), null);
  assert.strictEqual(placeFromResult(null), null);
});

test('createApple: configured() needs all four vars and a parseable key; unconfigured calls are inert', async () => {
  const quiet = { error() {}, warn() {}, log() {} };
  const base = { APPLE_MAPS_TEAM_ID: 'T', APPLE_MAPS_KEY_ID: 'K', APPLE_MAPS_ID: 'M', APPLE_MAPS_PRIVATE_KEY: pem };
  assert.strictEqual(createApple(base, { log: quiet }).configured(), true);
  assert.strictEqual(createApple({ ...base, APPLE_MAPS_PRIVATE_KEY: Buffer.from(pem).toString('base64') }, { log: quiet }).configured(), true);
  for (const k of Object.keys(base)) {
    const env = { ...base }; delete env[k];
    assert.strictEqual(createApple(env, { log: quiet }).configured(), false, `missing ${k}`);
  }
  assert.strictEqual(createApple({ ...base, APPLE_MAPS_PRIVATE_KEY: 'garbage' }, { log: quiet }).configured(), false);

  const off = createApple({}, { log: quiet });
  assert.deepStrictEqual(await off.geocode('1500 Marilla St, Dallas'), []);
  assert.deepStrictEqual(await off.autocomplete('1500 Mar'), []);
  assert.strictEqual(await off.resolveCompletion('apple:abc'), null);
  assert.deepStrictEqual(await off.etas({ origin: '1,1', destinations: ['2,2'] }), []);
  assert.strictEqual(off.snapshotUrl({ lat: 1, lng: 2 }), null);
});

test('snapshotUrl: signed Web Snapshot URL whose signature covers path+query minus the signature', () => {
  const quiet = { error() {}, warn() {}, log() {} };
  const a = createApple({ APPLE_MAPS_TEAM_ID: 'TEAM1', APPLE_MAPS_KEY_ID: 'KEY1', APPLE_MAPS_ID: 'M', APPLE_MAPS_PRIVATE_KEY: pem }, { log: quiet });
  const url = a.snapshotUrl({ lat: 32.7767, lng: -96.797, w: 600, h: 300, zoom: 16, now: 1_760_000_000_000 });
  const u = new URL(url);
  assert.strictEqual(u.origin, 'https://snapshot.apple-mapkit.com');
  assert.strictEqual(u.pathname, '/api/v1/snapshot');
  assert.strictEqual(u.searchParams.get('center'), '32.7767,-96.797');
  assert.strictEqual(u.searchParams.get('z'), '16');
  assert.strictEqual(u.searchParams.get('size'), '600x300');
  assert.strictEqual(u.searchParams.get('scale'), '2');
  assert.strictEqual(u.searchParams.get('colorScheme'), 'light');
  assert.strictEqual(u.searchParams.get('teamId'), 'TEAM1');
  assert.strictEqual(u.searchParams.get('keyId'), 'KEY1');
  assert.strictEqual(u.searchParams.get('expires'), String(1_760_000_000 + 3600));
  assert.deepStrictEqual(JSON.parse(u.searchParams.get('annotations')), [{ point: '32.7767,-96.797', color: 'e11d48', markerStyle: 'balloon' }]);
  const [unsigned, sig] = url.replace('https://snapshot.apple-mapkit.com', '').split('&signature=');
  assert.ok(sig && !sig.includes('&'), 'signature is the last param');
  assert.ok(crypto.verify('sha256', Buffer.from(unsigned), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
  // size clamps to Apple's 640 max
  assert.strictEqual(new URL(a.snapshotUrl({ lat: 1, lng: 2, w: 5000, h: 10 })).searchParams.get('size'), '640x50');
});

test('autocomplete + resolveCompletion: mapping with a stubbed fetch (no network)', async (t) => {
  const quiet = { error() {}, warn() {}, log() {} };
  const seeded = {};
  const a = createApple({ APPLE_MAPS_TEAM_ID: 'T', APPLE_MAPS_KEY_ID: 'K', APPLE_MAPS_ID: 'M', APPLE_MAPS_PRIVATE_KEY: pem },
    { log: quiet, geoCacheSet: (k, v) => { seeded[k] = v; return v; } });
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), auth: opts && opts.headers && opts.headers.Authorization });
    const u = new URL(String(url));
    const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
    if (u.pathname === '/v1/token') return json({ accessToken: 'ACCESS', expiresInSeconds: 1800 });
    if (u.pathname === '/v1/searchAutocomplete') {
      assert.strictEqual(u.searchParams.get('resultTypeFilter'), 'Address');
      assert.strictEqual(u.searchParams.get('limitToCountries'), 'US');
      assert.strictEqual(u.searchParams.get('searchLocation'), '32.8,-96.8');
      return json({ results: [
        { completionUrl: '/v1/search?q=a', displayLines: ['1500 Marilla St', 'Dallas, TX'], location: { latitude: 32.7767, longitude: -96.797 },
          structuredAddress: { subThoroughfare: '1500', thoroughfare: 'Marilla St', locality: 'Dallas', administrativeAreaCode: 'TX', postCode: '75201' } },
        { completionUrl: '/v1/search?q=b&x=1', displayLines: ['1500 Marilla Ct', 'Plano, TX'] },
        { displayLines: ['no id, dropped'] },
      ] });
    }
    if (u.pathname === '/v1/search') {
      assert.strictEqual(u.search, '?q=b&x=1');
      return json({ results: [{ coordinate: { latitude: 33.01, longitude: -96.7 }, formattedAddressLines: ['1500 Marilla Ct', 'Plano, TX 75075', 'United States'],
        structuredAddress: { subThoroughfare: '1500', thoroughfare: 'Marilla Ct', locality: 'Plano', administrativeAreaCode: 'TX', postCode: '75075' } }] });
    }
    if (u.pathname === '/v1/geocode') return json({ results: [{ coordinate: { latitude: 1, longitude: 2 }, formattedAddressLines: ['A', 'B'], structuredAddress: {} }] });
    if (u.pathname === '/v1/etas') {
      assert.strictEqual(u.searchParams.get('transportType'), 'Automobile');
      const dests = u.searchParams.get('destinations').split('|');
      return json({ etas: dests.slice().reverse().map((d, i) => { // reversed on purpose: matched back by coords
        const [la, lo] = d.split(',').map(Number);
        return { destination: { latitude: la, longitude: lo }, distanceMeters: 1000 * (dests.length - i), expectedTravelTimeSeconds: 100 * (dests.length - i), staticTravelTimeSeconds: 90 * (dests.length - i) };
      }) });
    }
    return json({ message: 'nope' }, 404);
  };
  t.after(() => { global.fetch = realFetch; });

  const preds = await a.autocomplete('1500 Mar', { bias: { lat: 32.8, lon: -96.8 } });
  assert.deepStrictEqual(preds, [
    { description: '1500 Marilla St, Dallas, TX', place_id: 'geo:32.7767,-96.797' },
    { description: '1500 Marilla Ct, Plano, TX', place_id: `apple:${Buffer.from('/v1/search?q=b&x=1').toString('base64url')}` },
  ]);
  assert.deepStrictEqual(seeded['details:geo:32.7767,-96.797'], {
    lat: 32.7767, lng: -96.797, formatted: '1500 Marilla St, Dallas, TX 75201', street: '1500 Marilla St', city: 'Dallas', state: 'TX', zip: '75201',
  });
  // token exchanged once, then bearer on the API call
  assert.strictEqual(calls.filter(c => c.url.endsWith('/v1/token')).length, 1);
  assert.ok(calls[0].auth.startsWith('Bearer eyJ'), 'token exchange carries the JWT');
  assert.strictEqual(calls[1].auth, 'Bearer ACCESS');

  const place = await a.resolveCompletion(preds[1].place_id);
  assert.deepStrictEqual(place, { lat: 33.01, lng: -96.7, formatted: '1500 Marilla Ct, Plano, TX 75075', street: '1500 Marilla Ct', city: 'Plano', state: 'TX', zip: '75075' });
  assert.strictEqual(await a.resolveCompletion('apple:' + Buffer.from('https://evil/x').toString('base64url')), null, 'only /v1/* completion paths are followed');

  // cached: same query does not hit the network again
  const n = calls.length;
  await a.autocomplete('1500 Mar', { bias: { lat: 32.8, lon: -96.8 } });
  assert.strictEqual(calls.length, n);

  const geo = await a.geocode('somewhere');
  assert.deepStrictEqual(geo, [{ lat: 1, lng: 2, formatted: 'A, B', street: '', city: '', state: '', zip: '' }]);

  // 12 destinations → two /v1/etas calls (10 + 2), results back in input order
  const dests = Array.from({ length: 12 }, (_, i) => ({ lat: 33 + i * 0.01, lng: -96.5 - i * 0.01 }));
  const before = calls.filter(c => c.url.includes('/v1/etas')).length;
  const legs = await a.etas({ origin: { lat: 32.8, lng: -96.8 }, destinations: dests, departureDate: new Date(Date.now() + 3600e3).toISOString() });
  assert.strictEqual(calls.filter(c => c.url.includes('/v1/etas')).length - before, 2);
  assert.strictEqual(legs.length, 12);
  legs.forEach((l, i) => {
    assert.strictEqual(l.lat, dests[i].lat); assert.strictEqual(l.lng, dests[i].lng);
    assert.strictEqual(l.meters / 1000, l.seconds / 100);
    assert.ok(Number.isFinite(l.staticSeconds));
  });
  const etaCall = calls.find(c => c.url.includes('/v1/etas'));
  assert.match(new URL(etaCall.url).searchParams.get('departureDate'), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test('401 from the API refreshes the token once and retries', async (t) => {
  const quiet = { error() {}, warn() {}, log() {} };
  const a = createApple({ APPLE_MAPS_TEAM_ID: 'T', APPLE_MAPS_KEY_ID: 'K', APPLE_MAPS_ID: 'M', APPLE_MAPS_PRIVATE_KEY: pem }, { log: quiet });
  let tokens = 0, geocodes = 0;
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const u = new URL(String(url));
    const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => '' });
    if (u.pathname === '/v1/token') return json({ accessToken: `ACCESS${++tokens}`, expiresInSeconds: 1800 });
    if (u.pathname === '/v1/geocode') {
      geocodes++;
      if (opts.headers.Authorization === 'Bearer ACCESS1') return json({}, 401);
      return json({ results: [{ coordinate: { latitude: 5, longitude: 6 }, formattedAddressLines: ['ok'] }] });
    }
    return json({}, 404);
  };
  t.after(() => { global.fetch = realFetch; });
  const out = await a.geocode('retry me');
  assert.strictEqual(out[0].lat, 5);
  assert.strictEqual(tokens, 2);
  assert.strictEqual(geocodes, 2);
});

// ── directions / road geometry ───────────────────────────────────────────────

// Three steps whose stepIndexes are deliberately out of array order (2, 0, 1):
// the route is A→B→C→D only when walked in stepIndexes order.
const DIRECTIONS_STUB = {
  origin: { latitude: 32.7, longitude: -96.8 },
  destination: { latitude: 32.73, longitude: -96.77 },
  routes: [{
    distanceMeters: 4321, durationSeconds: 540, hasTolls: true, name: 'I-35E N', transportType: 'Automobile',
    stepIndexes: [2, 0, 1],
  }, {
    distanceMeters: 9999, durationSeconds: 999, hasTolls: false, name: 'slow way', transportType: 'Automobile', stepIndexes: [0],
  }],
  steps: [
    { distanceMeters: 1000, durationSeconds: 100, instructions: 'middle', stepPathIndex: 1, transportType: 'Automobile' },
    { distanceMeters: 1000, durationSeconds: 100, instructions: 'last', stepPathIndex: 2, transportType: 'Automobile' },
    { distanceMeters: 2321, durationSeconds: 340, instructions: 'first', stepPathIndex: 0, transportType: 'Automobile' },
  ],
  stepPaths: [
    [{ latitude: 32.7, longitude: -96.8 }, { latitude: 32.71, longitude: -96.8 }],                                   // A → B
    [{ latitude: 32.71, longitude: -96.8 }, { latitude: 32.71, longitude: -96.8 }, { latitude: 32.71, longitude: -96.78 }], // B (dup) → C
    [{ latitude: 32.71, longitude: -96.78 }, { latitude: 32.73, longitude: -96.77 }],                                   // C → D
  ],
};

test('joinStepPaths: follows routes[0].stepIndexes order and drops repeated vertices', () => {
  const { joinStepPaths } = apple;
  assert.deepStrictEqual(joinStepPaths(DIRECTIONS_STUB), [
    [32.7, -96.8], [32.71, -96.8], [32.71, -96.78], [32.73, -96.77],
  ]);
  // a different route index walks its own steps
  assert.deepStrictEqual(joinStepPaths(DIRECTIONS_STUB, 1), [[32.71, -96.8], [32.71, -96.78]]);
  // garbage in → [] (never throws)
  assert.deepStrictEqual(joinStepPaths(null), []);
  assert.deepStrictEqual(joinStepPaths({ routes: [] }), []);
  assert.deepStrictEqual(joinStepPaths({ routes: [{ stepIndexes: [5, 'x'] }], steps: [{ stepPathIndex: 9 }], stepPaths: [] }), []);
  // a point missing coordinates is skipped, not emitted as NaN
  assert.deepStrictEqual(joinStepPaths({ routes: [{ stepIndexes: [0] }], steps: [{ stepPathIndex: 0 }],
    stepPaths: [[{ latitude: 1, longitude: 2 }, { latitude: 'nope' }, null, { latitude: 1, longitude: 3 }]] }), [[1, 2], [1, 3]]);
});

test('simplifyPath: keeps the endpoints, collapses sub-tolerance jitter, caps a 2,000-point zigzag at ≤ 400', () => {
  const { simplifyPath, PATH_MAX_POINTS } = apple;
  // (1) a 2,000-point zigzag with ±5 m wobble around a straight line → Douglas–Peucker (8 m) collapses it to the two ends
  const jitter = Array.from({ length: 2000 }, (_, i) => [32.7 + i * 0.00001, -96.8 + (i % 2 ? 0.00005 : 0)]);
  const a = simplifyPath(jitter);
  assert.deepStrictEqual(a[0], jitter[0]);
  assert.deepStrictEqual(a[a.length - 1], jitter[jitter.length - 1]);
  assert.ok(a.length <= 4, `jitter collapses (got ${a.length})`);
  // (2) a 2,000-point zigzag with ±100 m swings: every vertex survives DP, so the even thinning caps it at PATH_MAX_POINTS
  const big = Array.from({ length: 2000 }, (_, i) => [32.7 + i * 0.0001, -96.8 + (i % 2 ? 0.001 : 0)]);
  const b = simplifyPath(big);
  assert.strictEqual(b.length, PATH_MAX_POINTS);
  assert.ok(b.length < 2000 && b.length <= 400);
  assert.deepStrictEqual(b[0], big[0]);
  assert.deepStrictEqual(b[b.length - 1], big[big.length - 1]);
  // output is strictly a subsequence (monotonic latitude here)
  for (let i = 1; i < b.length; i++) assert.ok(b[i][0] > b[i - 1][0]);
  // (3) tolerance 0 = even thinning only; maxPoints honoured
  const c = simplifyPath(big, { tolerance: 0, maxPoints: 50 });
  assert.strictEqual(c.length, 50);
  assert.deepStrictEqual(c[0], big[0]);
  assert.deepStrictEqual(c[49], big[1999]);
  // (4) a real corner is preserved: L-shape stays 3 points
  const L = [[32.7, -96.8], [32.7, -96.79], [32.71, -96.79]];
  assert.deepStrictEqual(simplifyPath(L), L);
  // (5) short / malformed input
  assert.deepStrictEqual(simplifyPath([[1, 2]]), [[1, 2]]);
  assert.deepStrictEqual(simplifyPath([[1, 2], ['x', 3], [1, 3]]), [[1, 2], [1, 3]]);
  assert.deepStrictEqual(simplifyPath(null), []);
  // input not mutated
  assert.strictEqual(big.length, 2000);
});

test('directions(): request shape, routes[0] mapping, rounding, cache, null on no route (stubbed fetch)', async (t) => {
  const quiet = { error() {}, warn() {}, log() {} };
  const a = createApple({ APPLE_MAPS_TEAM_ID: 'T', APPLE_MAPS_KEY_ID: 'K', APPLE_MAPS_ID: 'M', APPLE_MAPS_PRIVATE_KEY: pem }, { log: quiet });
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), auth: opts && opts.headers && opts.headers.Authorization });
    const u = new URL(String(url));
    const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
    if (u.pathname === '/v1/token') return json({ accessToken: 'ACCESS', expiresInSeconds: 1800 });
    if (u.pathname === '/v1/directions') {
      if (u.searchParams.get('origin') === '0.000000,0.000000') return json({ routes: [], steps: [], stepPaths: [] });
      if (u.searchParams.get('origin') === '1.000000,1.000000') return json({ message: 'no route' }, 404);
      // precise coordinates in the stub exercise the 5 dp rounding
      const d = JSON.parse(JSON.stringify(DIRECTIONS_STUB));
      d.stepPaths[0][0] = { latitude: 32.700004999, longitude: -96.800005001 };
      return json(d);
    }
    return json({ message: 'nope' }, 404);
  };
  t.after(() => { global.fetch = realFetch; });

  const depart = new Date(Date.now() + 3600e3).toISOString();
  const leg = await a.directions({ origin: { lat: 32.7, lng: -96.8 }, destination: '32.73,-96.77', departureDate: depart });
  const call = calls.find(c => c.url.includes('/v1/directions'));
  assert.ok(call, 'hit /v1/directions');
  assert.strictEqual(call.auth, 'Bearer ACCESS');
  const q = new URL(call.url).searchParams;
  assert.strictEqual(q.get('origin'), '32.700000,-96.800000');
  assert.strictEqual(q.get('destination'), '32.730000,-96.770000');
  assert.strictEqual(q.get('transportType'), 'Automobile');
  assert.strictEqual(q.get('lang'), 'en-US');
  assert.match(q.get('departureDate'), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.deepStrictEqual(leg, {
    seconds: 540, meters: 4321, hasTolls: true,
    path: [[32.7, -96.80001], [32.71, -96.8], [32.71, -96.78], [32.73, -96.77]],
  });
  assert.ok(leg.path.length <= apple.PATH_MAX_POINTS);

  // cached: same leg + same departure hour → no second network call
  const n = calls.length;
  const again = await a.directions({ origin: '32.7,-96.8', destination: { lat: 32.73, lng: -96.77 }, departureDate: depart });
  assert.strictEqual(again, leg);
  assert.strictEqual(calls.length, n);

  // a departure in the past is ignored (sent without departureDate, separate cache slot)
  await a.directions({ origin: '32.7,-96.8', destination: '32.73,-96.77', departureDate: '2001-01-01T00:00:00Z' });
  const last = new URL(calls[calls.length - 1].url).searchParams;
  assert.strictEqual(last.has('departureDate'), false);

  // no route / API error / bad input → null, never throws
  assert.strictEqual(await a.directions({ origin: '0,0', destination: '0.1,0.1' }), null);
  assert.strictEqual(await a.directions({ origin: '1,1', destination: '1.1,1.1' }), null);
  assert.strictEqual(await a.directions({ origin: 'nope', destination: '1.1,1.1' }), null);
  assert.strictEqual(await a.directions({}), null);

  // unconfigured provider is inert (no network)
  const off = createApple({}, { log: quiet });
  const before = calls.length;
  assert.strictEqual(await off.directions({ origin: '32.7,-96.8', destination: '32.73,-96.77' }), null);
  assert.strictEqual(calls.length, before);
});
