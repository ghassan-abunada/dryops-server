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
- `ANTHROPIC_API_KEY` — enables the WIP "Review notes" AI review (wip.js); unset = the buttons and the Saturday run are skipped with a warning
- `WIP_AUTO_REVIEW` / `WIP_AUTO_REVIEW_HOUR` — the WIP AI review runs by itself every Saturday from 6:00 AM Central for every pooled location (`off` disables; hour 0–23). Deduped per location per Saturday via `wip_reviews.result->>trigger = 'weekly'`; failures retry on later 10-minute ticks that day, max 3

## WIP pages (wip.js, wipDash.js, wipPdf.js)
- Links are the credential: owner form `/wip/<pool token>`, manager dashboard
  `/wip/master/<wip_managers.token>` (only that manager's locations), super
  master `/wip/master/<wip_config.master_token>` (every pooled location, can
  add/remove pool rows), admin portal `/wip/admin/<wip_config.admin_token>`
  (add managers, assign locations, regenerate/deactivate links). Schema:
  `supabase_wip_pages.sql` + `supabase_wip_dashboard.sql` (managers,
  `wip_manager_locations`, `wip_job_estimates`, `wip_snapshots.manager_id`,
  `admin_token`). Pages degrade with a clear message until the second file runs.
- Dashboard numbers: **Collected last week** = `payments.jn_created` in the
  previous Mon–Sun (Central), `method_id` ≠ −1; **Invoiced last week** =
  `invoices.jn_created` in that week — both exactly the DryOps Stats
  definitions. **AR** = `open_ar_total` RPC. **Forecast vs actual** = the last
  `wip_snapshots.collecting_total` saved in the 7 days before that Monday
  (the Saturday auto-review saves one per location) vs collected. **Estimate
  accuracy** = latest `wip_job_estimates` row per job (appended whenever an
  owner's In Progress value changes) vs `jobs.approved_invoice_total` /
  collected-so-far, for jobs that have since been invoiced. A saved
  `wip_entries` row only counts if it fits the job's current section (an
  estimate on a now-invoiced job is not In Progress any more).
- Manual AI review is start-and-poll: `POST /wip/master/:t/review` → `{run_id}`,
  `GET …/review/:run_id` → progress (phases loading → notes → deciding →
  saving, per-location ticks); one run per master link at a time.
- PDFs (pdfkit, `wipPdf.js`): `/wip/<token>/pdf`, `…/master/:t/pdf?pool_id=`
  (one location) and `…/master/:t/pdf` (one-row-per-location summary). Single
  page by design: type steps 10→9→8→7.5 pt until it fits; continues to a
  second page only when it still overflows (~40+ rows).
- Location logo (`locations.logo_url`, else brand pack full → light → icon via
  `locationLogoUrl`) shows in the owner form header, card chips and PDFs.

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
  `Paid & Closed,PB complete,Lost,Non-Opportunity,Attorney,PB In Progress,PB Scheduled`)
- CAUTION: ~1,185 jobs carried a stale In-Storage flag as of 2026-08 while only
  ~150/month were actually billed — clean flags via the dryrun report before
  arming live mode
- After a live run, each LOCATION gets one email addressed to ALL its assigned active sales reps (every active rep with an email on the location's in-storage jobs, plus any override) (via `sendEmail` /
  Resend, requires RESEND_API_KEY + EMAIL_FROM) listing their newly drafted
  jobs with links to the JN payments-and-invoices screen; disable with
  `SUPP_NOTIFY_REPS=false`. Test the layout with
  `POST /admin/supplemental-billing/test-notification {email}`.
- `SUPP_NOTIFY_OVERRIDES` ("jnLocationId:email,…") routes specific locations to
  a fixed recipient; defaults cover the 4 locations whose jobs only carry
  deactivated reps (Seattle APO → antonio@primepackouts.com, Portland AHWF /
  OKC 24HFP / TWF-RGV → ethan@americanpackout.com). Env value replaces the
  defaults.
- Prep reminders: `SUPP_REMINDER_DAYS` (default `7,2`) days before each
  month's 1st, every location's rep gets a prep email (what makes a job bill +
  the location's unpriced in-storage jobs). Live mode only; one send per
  (month, stage) tracked as mode `reminder-Nd` in supplemental_billing_runs.
  `POST /admin/supplemental-billing/send-reminders` fires the upcoming month's
  stage immediately.
- In-Storage flag webhook: `POST /webhooks/jobnimbus/storage-flag?token=<JN_WEBHOOK_TOKEN>&set=on|off`
  — the JN On/Off automations point here (instead of Zapier) and the server
  flips cf_boolean_1; idempotent, skips already-in-state jobs.
- One-click catch-up links: `GET /supp/catchup?job=&months=&sig=` renders a
  confirm page; its button POSTs the same signed params and creates one Draft
  with a line per month at the job's Supplemental Price. sig =
  HMAC-SHA256(JN_WEBHOOK_TOKEN, "jnid|months") hex[0..32); idempotent via the
  catch-up external_id. Used by owner verify-and-catch-up emails.
- Admin dashboard: `GET /supp/admin/<master_token>` (supp-admin.js, wip.js
  pattern; token in supp_config). Insights tab (drafts by month/location, $,
  upcoming run, placeholders, skipped/errors, email delivery, run history) +
  Location emails tab editing supp_email_overrides — a DB row REPLACES the
  auto-detected reps for that location (loadSuppEmailOverrides, threaded into
  suppResolveRecipients as 5th arg; env SUPP_NOTIFY_OVERRIDES is fallback only).
  Live JN pool cached 5 min (?refresh=1). Schema: supabase_supp_admin.sql.

## Testing job from a testing work order (testingJobs.js)

A JobNimbus automation on **work order created** (record types Asbestos /
Soot / Mold Testing — the ones sent to Abatement Testing Services) POSTs the
work order to `POST /webhooks/jobnimbus/testing-workorder?token=<JN_WEBHOOK_TOKEN>`.
The server creates the Testing job the ATS office used to make by hand:

- record type `Testing`, status `Lead`, primary/related = the source job's
  primary contact, `external_id` = `testing-wo:<wo jnid>`
- JN location: **Abatement Testing Services (198)** — except source jobs in
  **Arizona or Hawaii**, which go to **White Tail Environmental (30)** like
  the 1,400 AZ + 360 HI Testing jobs already there. State = the source job's
  `state_text` (code or full name), else its JN location's state. Env
  `TESTING_JOB_LOCATION_ID`, `TESTING_JOB_WHITE_TAIL_LOCATION_ID`,
  `TESTING_JOB_WHITE_TAIL_STATES` (default `AZ,HI`).
- name = source job name minus its `(…)` suffix + ` (CTY - TST)`; CTY is the
  city code inside the source job's suffix (`(AFF - DAL - MIT)` → DAL,
  `(POR-MIT)` → POR, `(SAN MIT)` → SAN). A job with no suffix borrows the
  most common code among its JN location's 20 newest jobs (`Johnathan
  Bolton` at Right-Now Restoration of Hawaii → OAH), else
  `locations.city_abbr`, else the JN location city, else the job's city.
  Taken names get ` 2`, ` 3`…
- owners (`DEFAULT_OWNER_RULES`, matched on the source job's city code, its
  state, or words in its JN location name): Saleah Crawford + Jalisa Hill
  (ATS) always; Dallas (DAL/TWM) + Dominick Garcia; San Antonio
  (SA/SAN/SAT/AWD, "American Water Damage") + Will LeBrun; Colorado (DEN/COS,
  CO) + Robert Martinez & Hershal Johnson; Arizona (AZ) + Derek Lewis WTE;
  Detroit (DET, MI) + Jack Repokis; Oregon (POR/SLE/PDX, OR) + Ian Nelson;
  Hawaii (HI) + Marwinjay Villegas. **Never Joe Brooks** (owner rule; he was
  on ~85% of hand-made jobs until Oct 2026). Ids in `USERS`; env
  `TESTING_JOB_OWNERS` / `TESTING_JOB_OWNERS_<RULE KEY>` (comma-separated JN
  user ids, empty = nobody) replace one rule's owners.
- lead source = JN source named like the source job's location company
  (`American Fire and Flood of Dallas` → `American Fire and Flood`; active
  sources preferred); Lead Type `cf_string_6` = `Internal Referral`;
  `cf_string_7` (insurance) from the WO, address/geo/claim/insurer/adjuster/
  date of loss/CAT copied from the source job
- notes: on the new job (tags the owners at the bottom, one per line) and on
  the source job ("Testing job created: … (link)", with the location's
  `jn_note_tag`)
- idempotent: a redelivery finds the job by `external_id`; a contact with an
  active Testing job from the last `TESTING_JOB_DEDUPE_DAYS` (90) days gets no
  second one (asbestos + mold WOs on one loss = one job); concurrent
  deliveries share one in-flight run. Non-testing WOs are skipped (`?any=1`
  overrides). The jobs webhook mirrors the new job into Supabase on its own.
- test without writing: `?dryrun=1` (or `TESTING_JOB_DRYRUN=1`), and a body of
  just `{"jnid":"<work order jnid>"}` is loaded from JobNimbus — so
  `curl -X POST '…/webhooks/jobnimbus/testing-workorder?token=…&dryrun=1' -H 'Content-Type: application/json' -d '{"jnid":"<wo>"}'`
  returns the full payload it would send. `test/testingJobs.test.js` covers
  the parser, owner rules, source match and a full fake-deps run.

## Collections classifier (owner Collections tab)

`collections.js` reads each **Open AR** job's JobNimbus notes with a cheap LLM
and writes a per-job classification the DryOps app shows on its Collections
tab. Open AR = `AR_STATUSES` (same list as the hourly AR reconcile and
`public.is_ar_status()`) AND `approved_invoice_due > 0` (~4.9k jobs). It never
writes to JobNimbus.

- Tables (schema in the DryOps repo, `supabase/add_collections.sql`):
  `collections_reviews` (one row per job: category, needs_owner +
  owner_request, comparative_sent + comparative_amount, summary, last human
  note, notes_hash) and `collections_runs` (audit + token usage + est. cost).
  The app reads the `collections_open_ar` view.
- Model: `COLLECTIONS_MODEL=gemini:gemini-3.1-flash-lite` (default, needs
  `GEMINI_API_KEY`) or `anthropic:claude-haiku-4-5` (reuses
  `ANTHROPIC_API_KEY`). One LLM call per job whose notes changed; unchanged
  jobs (same `notes_hash`) and jobs with no human notes in the lookback window
  (`no_activity`, model `rule`) cost nothing. Bump `PROMPT_VERSION` in
  collections.js to re-classify everything on the next full run.
- Schedules: full pass once per Denver day at `COLLECTIONS_FULL_HOUR` (3am;
  deduped via `collections_runs.report->>denver_day`) + incremental pass every
  `COLLECTIONS_INCREMENTAL_HOURS` (jobs with new JN activity, plus AR jobs
  without a row — the first incremental on an empty table is the seed).
  `COLLECTIONS_ENABLED=false` turns the schedulers off.
- Spend guards: `COLLECTIONS_MAX_LLM_JOBS` (6000) and
  `COLLECTIONS_MAX_COST_USD` (10) per run; error-rate circuit breaker. Expected
  cost on Flash-Lite: ~$3–4 for the seed, cents per day after.
- Endpoints (admin or owner JWT): `POST /admin/collections/run`
  `{full?, location_id?, limit?, force?, dry?}` (`dry:true` returns the prompt
  payloads without calling the LLM or writing), `GET /admin/collections/status`,
  `POST /admin/collections/jobs/:jobId/refresh` (single job, forced; the app's
  "Re-check" button).
