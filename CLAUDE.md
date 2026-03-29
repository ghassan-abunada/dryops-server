# A1 Restoration – Drying Log Generator

## What this is
An IICRC S500-compliant water damage drying log generator for A1 Restoration.
Techs fill in job info + room readings, and it generates a branded PDF for insurance.

## Stack
- **server.js** — Node.js/Express server that serves the app and proxies JobNimbus API calls
- **public/index.html** — App shell (minimal HTML, links to styles.css + app.js)
- **public/styles.css** — All styles
- **public/app.js** — All application logic (~46KB of actual code + 253KB base64 logo)

## Running locally
```bash
npm install
npm start
# Open http://localhost:3000
```

## Key things to know

### JobNimbus integration
- Token: `mg16mu4lyx064qcj` (stored in server.js, never exposed to client)
- All API calls go through `/jnapi/*` → proxied to `https://app.jobnimbus.com/api1/*`
- Client-side `JN_BASE = '/jnapi'` — no auth header needed in browser fetch

### Google Maps
- Key: `AIzaSyBR0WXiCAs16A502isiMtmGei5Rj-LvxBE`
- Autocompletes the Job Address field
- Loaded dynamically via `loadMapsAPI()` in app.js

### PDF generation
- Uses jsPDF + jsPDF-AutoTable (loaded from CDN)
- `generateFromData(data)` builds the PDF from the collected/reviewed data
- Logo is embedded as base64 (`LOGO_B64` const in app.js)

### Moisture projection
- `projectReadings(material, initialMC, finalMC, days, demoed, demoDay, startDay)`
- Uses smooth-step S-curve (3f²-2f³) for realistic gradual drying
- Day 1 = exact initial reading, last day = exact final/dry-standard

### Review flow
1. User fills form → clicks "Review & Generate PDF"
2. `openReview()` calls `collectData()` → builds `reviewData`
3. `buildReviewUI(reviewData)` renders editable table
4. User edits any day cell → `updateProjectionCell()` mutates `reviewData`
5. User edits Final MC → `updateFinalMC()` recalculates projection for that row
6. "Export PDF" → `confirmGeneratePDF()` → `generateFromData(reviewData)`

### Room management
- `addRoom()` — async, prompts for name via modal with autocomplete
- `duplicateRoom(id)` — copies all readings, prompts for new name
- Default equipment per new room: 1 Dehumidifier + 1 Air Mover

## Environment variables
- `PORT` — server port (default 3000)
- `JN_TOKEN` — JobNimbus bearer token (default hardcoded in server.js)
