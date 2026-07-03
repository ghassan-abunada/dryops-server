const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
// DEPRECATED FALLBACK: this token is already exposed in git history and must be
// rotated in JobNimbus. Once rotated, set JN_TOKEN in Railway and delete the
// fallback below — the server will then refuse to start without the env var.
const JN_TOKEN = (process.env.JN_TOKEN || 'mg16mu4lyx064qcj').trim();
const JN_BASE = 'https://app.jobnimbus.com/api1';
const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://aurbjoqmuzbisoirotdm.supabase.co').trim();
const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || '').trim();
// Shared secret for the JobNimbus job webhook. Set in Railway env and include
// as ?token=... in the webhook URL configured in JobNimbus.
const JN_WEBHOOK_TOKEN = (process.env.JN_WEBHOOK_TOKEN || '').trim();
// Google Maps key for server-side geocoding in the job webhook. If unset,
// geocoding is skipped (jobs still upsert; they just won't get map coordinates).
const GOOGLE_MAPS_KEY = (process.env.GOOGLE_MAPS_KEY || '').trim();
// Where invite email links should land — the deployed DryOps WEB app. This URL
// must also be listed in Supabase Auth → URL Configuration → Redirect URLs, or
// Supabase ignores redirect_to and uses the project Site URL instead.
const WEB_APP_URL = (process.env.WEB_APP_URL || 'https://dryops.app').trim();

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
app.use(express.json({ limit: '2mb' }));

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

// ── JobNimbus job webhook ─────────────────────────────────────────────────────
// JobNimbus POSTs here whenever a job is created or updated. Secret-gated by
// JN_WEBHOOK_TOKEN (Railway env), supplied as ?token=... in the webhook URL (or
// an X-Webhook-Token header). Maps the JN job payload to our jobs columns and
// upserts into Supabase with the service key. Uses PostgREST merge-duplicates so
// an update only touches the columns present in the payload (no accidental
// nulling of fields JobNimbus omits). `stage` is a generated column — never sent.
const WEBHOOK_DEPRECATED_TYPES = new Set([
  'Contents (do not use)', 'CONTENTS (old)', 'Abatement (Hidden)', 'Testing (not copied)',
  'MITIGATION (non contact)', 'A1 - SEATTLE', 'A1 RECON - SEATTLE', 'RECON', '24HR ROOFING PROS',
]);

function webhookTokenOk(req) {
  if (!JN_WEBHOOK_TOKEN) return false;
  const provided = String(req.query.token || req.headers['x-webhook-token'] || '');
  const a = Buffer.from(provided);
  const b = Buffer.from(JN_WEBHOOK_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// JobNimbus timestamps are unix seconds; be tolerant of ISO strings too.
function jnToISO(v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'number') return v > 0 ? new Date(v * 1000).toISOString() : undefined;
  if (/^\d+$/.test(String(v))) { const n = Number(v); return n > 0 ? new Date(n * 1000).toISOString() : undefined; }
  const d = new Date(v); return isNaN(d.getTime()) ? undefined : d.toISOString();
}
function jnToDate(v) { const iso = jnToISO(v); return iso ? iso.slice(0, 10) : undefined; }

app.post('/webhooks/jobnimbus/jobs', async (req, res) => {
  if (!webhookTokenOk(req)) return res.status(401).json({ error: 'unauthorized' });

  // Accept the record directly, or wrapped as {data:...} / an array of one.
  let job = req.body;
  if (job && typeof job === 'object' && job.data && typeof job.data === 'object') job = job.data;
  if (Array.isArray(job)) job = job[0];
  if (!job || typeof job !== 'object') return res.status(200).json({ ok: true, skipped: 'empty body' });

  const jnid = job.jnid || job.id || job.recid;
  if (!jnid) {
    console.warn('[jn-webhook] no jnid; keys=', Object.keys(job).slice(0, 40).join(','));
    return res.status(200).json({ ok: true, skipped: 'no jnid' });
  }
  // Log the payload key set (no PII) so we can confirm/adjust field mapping.
  console.log('[jn-webhook]', String(jnid), 'type=', job.record_type_name, 'status=', job.status_name, 'keys=', Object.keys(job).length);

  const recordType = job.record_type_name;
  if (recordType && WEBHOOK_DEPRECATED_TYPES.has(recordType)) {
    return res.status(200).json({ ok: true, skipped: 'deprecated type' });
  }

  // Prefer JobNimbus cf_string_* keys; fall back to display-name keys if present.
  const pick = (...keys) => { for (const k of keys) { const v = job[k]; if (v !== undefined && v !== null && v !== '') return v; } return undefined; };

  const row = { jn_id: String(jnid), last_synced: new Date().toISOString() };
  const set = (col, val) => { if (val !== undefined) row[col] = val; };

  const addrParts = [job.address_line1, job.city, (job.state_text || job.state), job.zip].filter(Boolean);
  set('name', job.name || undefined);
  set('number', job.number != null && job.number !== '' ? String(job.number) : undefined);
  set('address', addrParts.length ? addrParts.join(', ') : undefined);
  set('claim_number', pick('cf_string_2'));
  set('client_phone', pick('parent_mobile_phone'));
  set('adjuster_name', pick('cf_string_3'));
  set('adjuster_phone', pick('cf_string_4'));
  set('adjuster_email', pick('cf_string_5'));
  set('lead_type', pick('cf_string_6', 'Lead Type'));
  set('insurance_type', pick('cf_string_7', 'Insurance or Not Insurance'));
  set('tested', pick('cf_string_8', 'Tested or Not Tested'));
  set('insurer', pick('cf_string_9'));
  set('cat', pick('cf_string_18'));
  set('date_loss', jnToDate(job.cf_date_1));
  set('date_start', jnToDate(job.start_date));
  set('record_type', recordType || undefined);
  set('status', job.status_name || undefined);
  if (job.active !== undefined) set('is_active', !!job.active);
  else if (job.is_active !== undefined) set('is_active', !!job.is_active);
  set('jn_created', jnToISO(job.date_created));
  set('jn_updated', jnToISO(job.date_modified || job.date_updated));

  // Resolve JobNimbus numeric location id -> our locations.id UUID.
  const jnLocRaw = job.location && (job.location.id ?? job.location);
  if (jnLocRaw != null && /^\d+$/.test(String(jnLocRaw))) {
    const jnLocId = Number(jnLocRaw);
    set('jn_location_id', jnLocId);
    try {
      const lr = await fetch(`${SUPABASE_URL}/rest/v1/locations?jn_location_id=eq.${jnLocId}&select=id`, {
        headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
      });
      const locs = await lr.json();
      if (Array.isArray(locs) && locs[0] && locs[0].id) set('location_id', locs[0].id);
    } catch (err) { console.error('[jn-webhook] location lookup error', err.message); }
  }

  // What we already have for this job (drives the enrichment-only-when-needed
  // logic below, so steady-state updates skip the extra contact/geocode calls).
  const existing = await getExistingJob(String(jnid));

  // Client name + contact_created from the related contact. Use the name in the
  // payload if present; fetch the contact from JobNimbus for the creation date
  // (needed by the stats "new contact within 120 days" rule) only when we don't
  // already have it stored.
  const rel = Array.isArray(job.related) ? job.related : [];
  const contactRef = rel.find(r => r && r.type === 'contact' && r.id);
  if (contactRef && contactRef.name) set('client_name', contactRef.name);
  if (contactRef && !(existing && existing.contact_created)) {
    const c = await jnGetContact(contactRef.id);
    if (c) {
      if (!row.client_name && c.name) set('client_name', c.name);
      if (c.contact_created) set('contact_created', c.contact_created);
    }
  }

  // Geocode when we have an address and either the job is new, has no
  // coordinates yet, or the address changed. Skips silently if no key set.
  if (row.address && GOOGLE_MAPS_KEY) {
    const needsGeocode = !existing || existing.lat == null || existing.address !== row.address;
    if (needsGeocode) {
      const coords = await geocode(row.address);
      if (coords) { set('lat', coords.lat); set('lng', coords.lng); }
    }
  }

  try {
    const up = await fetch(`${SUPABASE_URL}/rest/v1/jobs?on_conflict=jn_id`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(row),
    });
    if (!up.ok) {
      const t = await up.text();
      console.error('[jn-webhook] upsert failed', up.status, t.slice(0, 300));
      return res.status(502).json({ ok: false, error: 'upsert failed' }); // JN may retry
    }
    return res.status(200).json({ ok: true, jn_id: String(jnid) });
  } catch (err) {
    console.error('[jn-webhook] error', err.message);
    return res.status(502).json({ ok: false });
  }
});

// Current stored row for a job (null if new) — used to enrich only when needed.
async function getExistingJob(jnId) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/jobs?jn_id=eq.${encodeURIComponent(jnId)}&select=id,address,lat,contact_created`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    });
    const rows = await r.json();
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch (err) { console.error('[jn-webhook] existing job lookup error', err.message); return null; }
}

// Fetch a JobNimbus contact for its name + creation date (contact_created).
async function jnGetContact(contactId) {
  try {
    const r = await fetch(`${JN_BASE}/contacts/${contactId}`, {
      headers: { Authorization: `bearer ${JN_TOKEN}`, Accept: 'application/json' },
    });
    if (!r.ok) return null;
    const c = await r.json();
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ');
    const contact_created = c.date_created ? new Date(c.date_created * 1000).toISOString() : undefined;
    return { name, contact_created };
  } catch (err) { console.error('[jn-webhook] contact fetch error', err.message); return null; }
}

// Server-side geocode via Google Maps (mirrors the app's geocodeAddress).
async function geocode(address) {
  try {
    const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_MAPS_KEY}`);
    if (!r.ok) return null;
    const d = await r.json();
    if (d.status !== 'OK' || !d.results || !d.results.length) {
      console.warn('[jn-webhook] geocode status', d.status, d.error_message || '');
      return null;
    }
    const loc = d.results[0].geometry.location;
    return { lat: loc.lat, lng: loc.lng };
  } catch (err) { console.error('[jn-webhook] geocode error', err.message); return null; }
}

// Unwrap a webhook record that JobNimbus may send directly, as {data:...}, or
// as a one-element array.
function unwrapRecord(body) {
  let r = body;
  if (r && typeof r === 'object' && r.data && typeof r.data === 'object') r = r.data;
  if (Array.isArray(r)) r = r[0];
  return r && typeof r === 'object' ? r : null;
}

// Resolve the related job → our jobs.id (uuid) + location_id, so invoices and
// payments attach to the right job/location. Returns {} if no job match.
async function resolveJobRef(rec) {
  const rel = Array.isArray(rec.related) ? rec.related : [];
  const jobRef = rel.find(r => r && r.type === 'job' && r.id);
  if (!jobRef) return {};
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/jobs?jn_id=eq.${encodeURIComponent(jobRef.id)}&select=id,location_id`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    });
    const rows = await r.json();
    if (Array.isArray(rows) && rows[0]) return { job_id: rows[0].id, location_id: rows[0].location_id || undefined };
  } catch (err) { console.error('[jn-webhook] job ref lookup error', err.message); }
  return {};
}

async function upsertRow(table, row) {
  const up = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=jn_id`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(row),
  });
  if (!up.ok) { const t = await up.text(); throw new Error(`${up.status} ${t.slice(0, 300)}`); }
}

// ── JobNimbus invoice webhook ─────────────────────────────────────────────────
// POST /webhooks/jobnimbus/invoices — same secret gate as the jobs webhook.
app.post('/webhooks/jobnimbus/invoices', async (req, res) => {
  if (!webhookTokenOk(req)) return res.status(401).json({ error: 'unauthorized' });
  const inv = unwrapRecord(req.body);
  if (!inv) return res.status(200).json({ ok: true, skipped: 'empty body' });
  const jnid = inv.jnid || inv.id;
  if (!jnid) return res.status(200).json({ ok: true, skipped: 'no jnid' });
  console.log('[jn-webhook:invoice]', String(jnid), 'status=', inv.status_name, 'total=', inv.total);

  const row = { jn_id: String(jnid), last_synced: new Date().toISOString() };
  const set = (col, val) => { if (val !== undefined) row[col] = val; };
  const ref = await resolveJobRef(inv);
  set('job_id', ref.job_id);
  set('location_id', ref.location_id);
  set('number', inv.number != null && inv.number !== '' ? inv.number : undefined);
  set('status_name', inv.status_name || undefined);
  if (inv.total != null) set('total', inv.total);
  if (inv.total_paid != null) set('total_paid', inv.total_paid);
  if (inv.due != null) set('due', inv.due);
  set('date_invoice', jnToDate(inv.date_invoice));
  set('date_due', jnToDate(inv.date_due));
  set('date_paid_in_full', jnToDate(inv.date_paid_in_full));
  set('jn_created', jnToISO(inv.date_created));
  set('jn_updated', jnToISO(inv.date_modified || inv.date_updated));

  try {
    await upsertRow('invoices', row);
    return res.status(200).json({ ok: true, jn_id: String(jnid) });
  } catch (err) {
    console.error('[jn-webhook:invoice] upsert failed', err.message);
    return res.status(502).json({ ok: false });
  }
});

// ── JobNimbus payment webhook ─────────────────────────────────────────────────
// POST /webhooks/jobnimbus/payments — same secret gate. Payment amount is in the
// JN `total` field; method_id = -1 marks a credit memo (matches the app).
app.post('/webhooks/jobnimbus/payments', async (req, res) => {
  if (!webhookTokenOk(req)) return res.status(401).json({ error: 'unauthorized' });
  const pay = unwrapRecord(req.body);
  if (!pay) return res.status(200).json({ ok: true, skipped: 'empty body' });
  const jnid = pay.jnid || pay.id;
  if (!jnid) return res.status(200).json({ ok: true, skipped: 'no jnid' });
  console.log('[jn-webhook:payment]', String(jnid), 'amount=', pay.total, 'method=', pay.method_id);

  const row = { jn_id: String(jnid), last_synced: new Date().toISOString() };
  const set = (col, val) => { if (val !== undefined) row[col] = val; };
  const ref = await resolveJobRef(pay);
  set('job_id', ref.job_id);
  set('location_id', ref.location_id);
  const amount = pay.total != null ? pay.total : (pay.amount != null ? pay.amount : undefined);
  if (amount != null) set('amount', amount);
  if (pay.method_id != null) set('method_id', pay.method_id);
  set('note', (pay.note || pay.description) || undefined);
  set('jn_created', jnToISO(pay.date_payment || pay.date_created));
  set('jn_updated', jnToISO(pay.date_updated || pay.date_modified));

  try {
    await upsertRow('payments', row);
    return res.status(200).json({ ok: true, jn_id: String(jnid) });
  } catch (err) {
    console.error('[jn-webhook:payment] upsert failed', err.message);
    return res.status(502).json({ ok: false });
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
        data: { role, location_id, location_name, full_name,
                location_ids: req.body.location_ids, location_names: req.body.location_names },
        redirect_to: WEB_APP_URL,
      }),
    });
    const body = await r.json();
    res.status(r.status).json(body);
  } catch (err) {
    console.error('[invite-user error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── Create a user manually (admin/owner only) ────────────────────────────────
// Creates a confirmed Supabase account with an auto-generated temp password and
// sets the profile's role + locations directly (no email round-trip). Returns
// the temp password once so the admin can relay it; the user changes it on first
// login. handle_new_user forces 'technician' for non-invited signups, so we
// upsert the real role/locations here (service role bypasses RLS + the
// profile-privilege trigger).
function genTempPassword() {
  // 16 chars, url-safe, always meets Supabase's min length.
  return crypto.randomBytes(12).toString('base64').replace(/[+/=]/g, '').slice(0, 16) + 'A9';
}

app.post('/admin/create-user', requireAuth, requireAdmin, async (req, res) => {
  const { email, full_name, role, location_id, location_name, location_ids, location_names } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });
  const allowedRoles = ['owner', 'technician', 'technician_2', 'executive', 'admin'];
  const finalRole = allowedRoles.includes(role) ? role : 'technician';
  const tempPassword = genTempPassword();

  try {
    // 1) Create the confirmed auth user.
    const cr = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email, password: tempPassword, email_confirm: true,
        user_metadata: { full_name, role: finalRole, location_id, location_name, location_ids, location_names },
      }),
    });
    const created = await cr.json();
    if (!cr.ok || !created.id) {
      return res.status(cr.status === 200 ? 502 : cr.status).json({ error: created.msg || created.message || created.error_description || 'create user failed' });
    }

    // 2) Set the real profile role + locations (handle_new_user made a
    //    technician row; overwrite it via service role).
    const profile = {
      id: created.id, full_name: full_name || null, role: finalRole,
      location_id: location_id || null, location_name: location_name || null,
      location_ids: location_ids || [], location_names: location_names || [],
      updated_at: new Date().toISOString(),
    };
    const pr = await fetch(`${SUPABASE_URL}/rest/v1/profiles?on_conflict=id`, {
      method: 'POST',
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(profile),
    });
    if (!pr.ok) {
      const t = await pr.text();
      console.error('[create-user] profile upsert failed', pr.status, t.slice(0, 300));
      // The auth user exists; report partial success so the admin knows.
      return res.status(502).json({ error: 'user created but profile setup failed', detail: t.slice(0, 200) });
    }
    return res.status(200).json({ ok: true, user_id: created.id, email, temp_password: tempPassword });
  } catch (err) {
    console.error('[create-user error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── Create a location (admin/owner only) ─────────────────────────────────────
app.post('/admin/locations', requireAuth, requireAdmin, async (req, res) => {
  const { name, location_type, jn_location_id } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
  let jnLoc = null;
  if (jn_location_id !== undefined && jn_location_id !== null && String(jn_location_id).trim() !== '') {
    if (!/^\d+$/.test(String(jn_location_id))) return res.status(400).json({ error: 'jn_location_id must be a number' });
    jnLoc = Number(jn_location_id);
  }
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/locations`, {
      method: 'POST',
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ name: String(name).trim(), location_type: location_type || null, jn_location_id: jnLoc, status: 'active' }),
    });
    const body = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: (body && (body.message || body.error)) || 'create location failed' });
    return res.status(200).json({ ok: true, location: Array.isArray(body) ? body[0] : body });
  } catch (err) {
    console.error('[create-location error]', err.message);
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
