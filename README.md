# A1 Restoration – Drying Log Generator

IICRC S500 drying log generator with JobNimbus integration.

## Quick Start

```bash
npm install
npm start
```

Open **http://localhost:3000** in your browser.

## Features

- Generate IICRC S500-compliant drying logs as PDF
- Load jobs directly from JobNimbus (auto-fills client, address, insurance, dates)
- Google Maps address autocomplete
- Smooth-step moisture projection curves
- Per-day editable review before PDF export
- Room duplication with autocomplete room names

## Project Structure

```
a1-drying-log/
├── server.js          # Express server + JobNimbus CORS proxy
├── package.json
├── public/
│   ├── index.html     # App shell
│   ├── styles.css     # All styles
│   └── app.js         # All application logic
```

## Environment Variables

Copy `.env.example` to `.env` and fill in:

| Variable   | Description              |
|------------|--------------------------|
| `PORT`     | Server port (default 3000) |
| `JN_TOKEN` | JobNimbus bearer token   |

## JobNimbus Integration

The server proxies requests to `https://app.jobnimbus.com/api1` via `/jnapi/*`
to avoid browser CORS restrictions. The token is kept server-side only.
