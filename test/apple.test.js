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
  assert.deepStrictEqual(JSON.parse(u.searchParams.get('annotations')), [{ point: '32.7767,-96.797', color: 'red', glyphText: '' }]);
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
