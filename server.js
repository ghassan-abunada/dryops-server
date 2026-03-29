const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JN_TOKEN = process.env.JN_TOKEN;

// ── Serve static files ────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── JobNimbus API proxy (avoids CORS) ─────────────────────────────────────────
app.use('/jnapi', createProxyMiddleware({
  target: 'https://app.jobnimbus.com',
  changeOrigin: true,
  pathRewrite: { '^/jnapi': '/api1' },
  on: {
    proxyReq: (proxyReq) => {
      proxyReq.setHeader('Authorization', `bearer ${JN_TOKEN}`);
      proxyReq.setHeader('Accept', 'application/json');
    },
  },
}));

app.listen(PORT, () => {
  console.log(`\n✓ A1 Drying Log running at http://localhost:${PORT}\n`);
});
