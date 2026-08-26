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
- Token: set via `JN_TOKEN` env var (server-side only, never exposed to client; no hardcoded fallback)
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
- `JN_TOKEN` — JobNimbus bearer token (required; server exits at startup if missing)
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_SERVICE_KEY` — Supabase service role key (required; server exits at startup if missing)

## Supplemental storage billing (monthly)

Replaces the Zapier + JN-automation anniversary flow. On the 1st of each month
(America/Denver, 7am+) the server creates one **Draft** supplemental storage
invoice per eligible job for that calendar month; offices review/send drafts in
JobNimbus as before. See the "Supplemental storage billing" section in
server.js for eligibility rules and dedupe logic.

- Field keys: `cf_boolean_1` = "In Storage?", `cf_double_1` = "Supplemental
  Price" (invoice total), `cf_long_1` = "# of Vaults"
- Storage catalog item: `mestzfhuma6y3nosvqj9ctt` ("Contents - Offsite Content
  Storage") — every existing supplemental invoice uses it
- In-storage jobs with no Supplemental Price still get a draft — a $0
  PLACEHOLDER marked in the internal note and line description for the office
  to price before sending
- Dedupe: skips a job/month if an invoice with external_id
  `supp-<jobJnid>-<YYYY-MM>` exists OR a single-line storage invoice is already
  dated in that month (manual invoices are respected)
- Runs log to `supplemental_billing_runs` in Supabase
  (supabase_supplemental_billing.sql)
- Endpoints (admin): `POST /admin/supplemental-billing/run` (body
  `{"dryrun":false}` for a live run; default dryrun preview),
  `GET /admin/supplemental-billing/status`
- Env: `SUPP_BILLING_LIVE=true` to arm live monthly runs (default: monthly
  dryrun only), `SUPP_BILLING_DAY` (default 1), `SUPP_RECORD_TYPES` (default
  `Contents`), `SUPP_EXCLUDED_STATUSES` (default
  `Paid & Closed,PB complete,Lost,Non-Opportunity,Attorney`)
- CAUTION: ~1,185 jobs carried a stale In-Storage flag as of 2026-08 while only
  ~150/month were actually billed — clean flags via the dryrun report before
  arming live mode
- After a live run, each LOCATION gets one email to its dominant sales rep (mode of sales_rep over the eligible in-storage pool) (via `sendEmail` /
  Resend, requires RESEND_API_KEY + EMAIL_FROM) listing their newly drafted
  jobs with links to the JN payments-and-invoices screen; disable with
  `SUPP_NOTIFY_REPS=false`. Test the layout with
  `POST /admin/supplemental-billing/test-notification {email}`.
- `SUPP_NOTIFY_OVERRIDES` ("jnLocationId:email,…") routes specific locations to
  a fixed recipient; defaults cover the 4 locations whose jobs only carry
  deactivated reps (Seattle APO → antonio@primepackouts.com, Portland AHWF /
  OKC 24HFP / TWF-RGV → ethan@americanpackout.com). Env value replaces the
  defaults.
