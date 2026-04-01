const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JN_TOKEN = process.env.JN_TOKEN || 'mg16mu4lyx064qcj';
const JN_BASE = 'https://app.jobnimbus.com/api1';

// ── Serve static files ────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── JobNimbus API proxy (avoids CORS) ─────────────────────────────────────────
app.use('/jnapi', async (req, res) => {
  const url = `${JN_BASE}${req.path}${req.url.includes('?') ? '?' + req.url.split('?')[1] : ''}`;
  console.log('[JN]', req.method, url);
  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers: {
        'Authorization': `bearer ${JN_TOKEN}`,
        'Accept': 'application/json',
      },
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
app.use('/jnfiles', async (req, res) => {
  const url = `https://api.jobnimbus.com/files/v1${req.path}`;
  console.log('[JN files]', req.method, url);
  try {
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
// Requires env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY, INVITE_SECRET
app.post('/invite-user', async (req, res) => {
  const { email, role, location_id, location_name, full_name } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });

  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/invite`, {
      method: 'POST',
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        data: { role, location_id, location_name, full_name },
      }),
    });
    const body = await r.json();
    res.status(r.status).json(body);
  } catch (err) {
    console.error('[invite-user error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n✓ A1 Drying Log running at http://localhost:${PORT}\n`);
});
