const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
// DEPRECATED FALLBACK: this token is already exposed in git history and must be
// rotated in JobNimbus. Once rotated, set JN_TOKEN in Railway and delete the
// fallback below — the server will then refuse to start without the env var.
const JN_TOKEN = (process.env.JN_TOKEN || 'mg16mu4lyx064qcj').trim();
const JN_BASE = 'https://app.jobnimbus.com/api1';
const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://aurbjoqmuzbisoirotdm.supabase.co').trim();
const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || '').trim();

// ── Fail fast on missing secrets ──────────────────────────────────────────────
if (!process.env.JN_TOKEN) {
  console.warn('WARNING: JN_TOKEN env var not set — using deprecated embedded token. Rotate the JobNimbus token and set JN_TOKEN in Railway.');
}
if (!SUPABASE_SERVICE_KEY) {
  console.error('FATAL: SUPABASE_SERVICE_KEY environment variable is not set. Refusing to start.');
  process.exit(1);
}

// ── CORS (allow all browser origins) ─────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Serve static files ────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── Auth middleware ───────────────────────────────────────────────────────────
// Clients send `Authorization: Bearer <Supabase user access token>` (a Supabase
// Auth JWT). We verify it against Supabase Auth and cache the result briefly so
// we don't hit Supabase on every proxied request.
const AUTH_CACHE_TTL_MS = 60 * 1000;
const AUTH_CACHE_MAX = 500;
const authCache = new Map(); // token → { userId, expiresAt }

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ error: 'Missing bearer token' });
  const token = match[1];

  const cached = authCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    req.userId = cached.userId;
    return next();
  }
  authCache.delete(token); // drop stale entry, if any

  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${token}`,
      },
    });
    if (r.status !== 200) return res.status(401).json({ error: 'Invalid or expired token' });
    const user = await r.json();
    if (!user || !user.id) return res.status(401).json({ error: 'Invalid or expired token' });

    if (authCache.size >= AUTH_CACHE_MAX) {
      authCache.delete(authCache.keys().next().value); // evict oldest entry
    }
    authCache.set(token, { userId: user.id, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
    req.userId = user.id;
    next();
  } catch (err) {
    console.error('[auth error]', err.message);
    res.status(502).json({ error: 'Auth verification failed' });
  }
}

// Must run after requireAuth. Looks up the caller's role in the profiles table.
async function requireAdmin(req, res, next) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${req.userId}&select=role`, {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    });
    if (!r.ok) return res.status(403).json({ error: 'Admin access required' });
    const rows = await r.json();
    const role = Array.isArray(rows) && rows[0] ? rows[0].role : null;
    if (role !== 'admin' && role !== 'owner') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  } catch (err) {
    console.error('[admin check error]', err.message);
    res.status(502).json({ error: 'Role verification failed' });
  }
}

// ── JobNimbus API proxy (avoids CORS) ─────────────────────────────────────────
// EXCEPTION (deliberate, per owner decision 2026-07-02): the drying-log web
// tool served from public/ does an unauthenticated `GET /jnapi/jobs?q=...`
// job-search from the browser. That exact path+method stays open; everything
// else on /jnapi requires a Supabase JWT. Trade-off: anyone with the URL can
// search jobs by name. Remove this bypass if the drying-log tool is retired.
function jnapiAuth(req, res, next) {
  if (req.method === 'GET' && req.path === '/jobs') return next();
  return requireAuth(req, res, next);
}

app.use('/jnapi', jnapiAuth, async (req, res) => {
  const url = `${JN_BASE}${req.path}${req.url.includes('?') ? '?' + req.url.split('?')[1] : ''}`;
  console.log('[JN]', req.method, url);
  const hasBody = ['PUT', 'POST', 'PATCH'].includes(req.method) && req.body && Object.keys(req.body).length > 0;
  try {
    // NOTE: upstream headers are built fresh here — the client's Supabase JWT
    // (its Authorization header) is intentionally NOT forwarded to JobNimbus.
    const upstream = await fetch(url, {
      method: req.method,
      headers: {
        'Authorization': `bearer ${JN_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: hasBody ? JSON.stringify(req.body) : undefined,
    });
    const body = await upstream.text();
    res.status(upstream.status).set('Content-Type', 'application/json').send(body);
  } catch (err) {
    console.error('[JN proxy error]', err.message);
    res.status(502).json({ error: 'Proxy error', detail: err.message });
  }
});

// ── JobNimbus photo download proxy ───────────────────────────────────────────
// GET /jnphoto/:jnid — follows the JN redirect and streams the image binary
// INTENTIONALLY UNAUTHENTICATED: this URL is used directly as an <img> /
// React Native Image source, where custom Authorization headers can't be set.
// jnids are high-entropy identifiers, so URLs are not guessable.
app.get('/jnphoto/:jnid', async (req, res) => {
  const url = `${JN_BASE}/files/${req.params.jnid}`;
  console.log('[JN photo]', url);
  try {
    const upstream = await fetch(url, {
      headers: { 'Authorization': `bearer ${JN_TOKEN}` },
    });
    const contentType = upstream.headers.get('content-type') || 'image/jpeg';
    const buf = await upstream.arrayBuffer();
    res.set('Content-Type', contentType)
       .set('Cache-Control', 'public, max-age=3600')
       .send(Buffer.from(buf));
  } catch (err) {
    console.error('[JN photo error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── JobNimbus Files API proxy (presigned URL upload) ──────────────────────────
app.use('/jnfiles', requireAuth, async (req, res) => {
  const url = `https://api.jobnimbus.com/files/v1${req.path}`;
  console.log('[JN files]', req.method, url);
  try {
    // Upstream headers built fresh — client's Supabase JWT is not forwarded.
    const upstream = await fetch(url, {
      method: req.method,
      headers: {
        'Authorization': `Bearer ${JN_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: req.body && Object.keys(req.body).length ? JSON.stringify(req.body) : undefined,
    });
    const body = await upstream.text();
    res.status(upstream.status)
      .set('Content-Type', upstream.headers.get('content-type') || 'application/json')
      .send(body);
  } catch (err) {
    console.error('[JN files error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── Invite user (creates Supabase account via Admin API) ─────────────────────
// Admin/owner only.
app.post('/invite-user', requireAuth, requireAdmin, async (req, res) => {
  const { email, role, location_id, location_name, full_name } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });

  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/invite`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        data: { role, location_id, location_name, full_name },
        redirect_to: 'dryops://',
      }),
    });
    const body = await r.json();
    res.status(r.status).json(body);
  } catch (err) {
    console.error('[invite-user error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── Company management API ────────────────────────────────────────────────────
// GET is intentionally open (read-only company list, used by public pages).
app.get('/api/companies', async (req, res) => {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/companies?select=id,name,logo_b64&order=created_at.asc`, {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    });
    const body = await r.json();
    res.status(r.status).json(body);
  } catch(err) {
    console.error('[companies GET error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/companies', requireAuth, requireAdmin, async (req, res) => {
  const { name, logo_b64 } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/companies`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({ name, logo_b64: logo_b64 || null }),
    });
    const body = await r.json();
    res.status(r.status).json(body);
  } catch(err) {
    console.error('[companies POST error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.patch('/api/companies/:id', requireAuth, requireAdmin, async (req, res) => {
  // :id is interpolated into a PostgREST filter — reject anything but a UUID.
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid company id' });
  const { logo_b64 } = req.body;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/companies?id=eq.${req.params.id}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({ logo_b64 }),
    });
    const body = await r.json();
    res.status(r.status).json(body);
  } catch(err) {
    console.error('[companies PATCH error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n✓ A1 Drying Log running at http://localhost:${PORT}\n`);
});
