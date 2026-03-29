const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JN_TOKEN = process.env.JN_TOKEN || 'mg16mu4lyx064qcj';
const JN_BASE = 'https://app.jobnimbus.com/api1';

// ── Serve static files ────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

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

app.listen(PORT, () => {
  console.log(`\n✓ A1 Drying Log running at http://localhost:${PORT}\n`);
});
