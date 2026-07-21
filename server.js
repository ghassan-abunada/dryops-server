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
// Twilio (SMS for referral-program lead source invites). If unset, invite rows
// are still created but SMS sending reports "not configured" so owners can
// resend once the vars are added in Railway.
const TWILIO_ACCOUNT_SID = (process.env.TWILIO_ACCOUNT_SID || '').trim();
const TWILIO_AUTH_TOKEN = (process.env.TWILIO_AUTH_TOKEN || '').trim();
const TWILIO_FROM_NUMBER = (process.env.TWILIO_FROM_NUMBER || '').trim();
// CallRail (call tracking). API key + account id for pulling numbers/calls;
// a separate shared secret gates the post-call webhook (?token=... in the URL).
const CALLRAIL_API_KEY = (process.env.CALLRAIL_API_KEY || '').trim();
// One or more CallRail account ids (comma-separated) — the same API key can
// access multiple accounts. Accepts CALLRAIL_ACCOUNT_IDS or the legacy singular.
const CALLRAIL_ACCOUNT_IDS = (process.env.CALLRAIL_ACCOUNT_IDS || process.env.CALLRAIL_ACCOUNT_ID || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const CALLRAIL_WEBHOOK_TOKEN = (process.env.CALLRAIL_WEBHOOK_TOKEN || '').trim();

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

// Like requireAdmin but also allows the executive role — used ONLY for the
// CallRail endpoints (executives manage call tracking; they get no other writes).
async function requireCallAccess(req, res, next) {
  return requireAuth(req, res, async () => {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${req.userId}&select=role`, {
        headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
      });
      if (!r.ok) return res.status(403).json({ error: 'Access required' });
      const rows = await r.json();
      const role = Array.isArray(rows) && rows[0] ? rows[0].role : null;
      if (!['admin', 'owner', 'executive'].includes(role)) return res.status(403).json({ error: 'Access required' });
      next();
    } catch (err) {
      console.error('[call-access check error]', err.message);
      res.status(502).json({ error: 'Role verification failed' });
    }
  });
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

// ── CallRail integration ──────────────────────────────────────────────────────
function callrailWebhookOk(req) {
  if (!CALLRAIL_WEBHOOK_TOKEN) return false;
  const provided = String(req.query.token || req.headers['x-webhook-token'] || '');
  const a = Buffer.from(provided);
  const b = Buffer.from(CALLRAIL_WEBHOOK_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function normPhone(v) {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : (d || null);
}
// Strict E.164 for outbound SMS (unlike normPhone's last-10 matching form).
// Bare 10-digit numbers are assumed US (+1).
function toE164(v) {
  const raw = String(v ?? '').trim();
  if (/^\+\d{8,15}$/.test(raw)) return raw;
  const d = raw.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null;
}
async function sendSms(to, body) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
    return { ok: false, error: 'SMS not configured (set TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER)' };
  }
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: TWILIO_FROM_NUMBER, Body: body }),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) return { ok: false, error: (j && j.message) || `Twilio error ${r.status}` };
    return { ok: true, sid: j && j.sid };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
function callrailToISO(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const d = new Date(v); return isNaN(d.getTime()) ? undefined : d.toISOString();
}
async function sbGet(pathAndQuery) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
  return r.ok ? r.json() : null;
}
async function sbUpsert(table, rowOrRows, conflictCol) {
  const up = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${conflictCol}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rowOrRows),
  });
  if (!up.ok) { const t = await up.text(); throw new Error(`${up.status} ${t.slice(0, 300)}`); }
}
async function sbRpc(fn) {
  await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
}
async function callrailApi(accountId, pathAndQuery) {
  const r = await fetch(`https://api.callrail.com/v3/a/${accountId}/${pathAndQuery}`, {
    headers: { Authorization: `Token token="${CALLRAIL_API_KEY}"`, Accept: 'application/json' },
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { ok: r.ok, status: r.status, json };
}
async function callrailAccounts() {
  const r = await fetch('https://api.callrail.com/v3/a.json', {
    headers: { Authorization: `Token token="${CALLRAIL_API_KEY}"`, Accept: 'application/json' },
  });
  if (!r.ok) return [];
  const j = await r.json(); return (j && (j.accounts || j.data)) || [];
}
// Fetch one page of calls. If the optional `fields` param 400s (a field name not
// valid for the account's plan poisons the whole request), retry with defaults.
async function fetchCallsPage(acct, page, fields, dateQ) {
  let r = await callrailApi(acct, `calls.json?per_page=250&page=${page}&fields=${fields}${dateQ}`);
  if (!r.ok && fields) r = await callrailApi(acct, `calls.json?per_page=250&page=${page}${dateQ}`);
  return r;
}

// Map a CallRail call object → our `calls` row (raw fields only; location/job
// resolution is done separately: inline for the webhook, set-based for backfill).
function mapCallRow(call) {
  // Use null (not undefined) for every field: JSON.stringify drops undefined
  // keys, and PostgREST bulk insert requires all objects to share identical keys
  // (else PGRST102 "All object keys must match" rejects the whole batch).
  const src = call.source || (call.lead_source && call.lead_source.source) || null;
  return {
    callrail_id: String(call.id ?? call.call_id ?? ''),
    tracking_phone_number: call.tracking_phone_number || null,
    customer_phone_number: call.customer_phone_number || null,
    direction: call.direction || null,
    duration: call.duration != null && call.duration !== '' ? Number(call.duration) : null,
    answered: typeof call.answered === 'boolean' ? call.answered : null,
    voicemail: typeof call.voicemail === 'boolean' ? call.voicemail : null,
    first_call: typeof call.first_call === 'boolean' ? call.first_call : null,
    source: src,
    medium: call.medium || null,
    campaign: call.campaign || null,
    gclid: call.gclid || null,
    customer_name: call.customer_name || null,
    customer_city: call.customer_city || null,
    customer_state: call.customer_state || null,
    value: call.value != null && call.value !== '' ? Number(call.value) : null,
    start_time: callrailToISO(call.start_time) ?? null,
    last_synced: new Date().toISOString(),
  };
}

// Post-call webhook: CallRail POSTs each completed call here in real time.
app.post('/webhooks/callrail/calls', async (req, res) => {
  if (!callrailWebhookOk(req)) return res.status(401).json({ error: 'unauthorized' });
  let call = req.body;
  if (call && typeof call === 'object' && call.data && typeof call.data === 'object') call = call.data;
  if (Array.isArray(call)) call = call[0];
  if (!call || typeof call !== 'object') return res.status(200).json({ ok: true, skipped: 'empty' });

  const row = mapCallRow(call);
  if (!row.callrail_id) return res.status(200).json({ ok: true, skipped: 'no id' });

  try {
    // Resolve location from the tracking-number assignment.
    const trackNorm = normPhone(call.tracking_phone_number);
    if (trackNorm) {
      const t = await sbGet(`location_tracking_numbers?phone_norm=eq.${trackNorm}&select=location_id&limit=1`);
      if (Array.isArray(t) && t[0] && t[0].location_id) row.location_id = t[0].location_id;
    }
    // Resolve job from the caller number (prefer same location).
    const custNorm = normPhone(call.customer_phone_number);
    if (custNorm) {
      let j = row.location_id
        ? await sbGet(`jobs?client_phone_norm=eq.${custNorm}&location_id=eq.${row.location_id}&select=id,date_contacted&order=jn_created.asc&limit=1`)
        : null;
      if (!j || !j.length) j = await sbGet(`jobs?client_phone_norm=eq.${custNorm}&select=id,date_contacted&order=jn_created.asc&limit=1`);
      if (Array.isArray(j) && j[0]) {
        row.job_id = j[0].id;
        // Set date_contacted to the earliest matched call.
        if (row.start_time && (!j[0].date_contacted || new Date(row.start_time) < new Date(j[0].date_contacted))) {
          await fetch(`${SUPABASE_URL}/rest/v1/jobs?id=eq.${row.job_id}`, {
            method: 'PATCH',
            headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({ date_contacted: row.start_time }),
          });
        }
      }
    }
    await sbUpsert('calls', row, 'callrail_id');
    return res.status(200).json({ ok: true, callrail_id: row.callrail_id, location_id: row.location_id || null, job_id: row.job_id || null });
  } catch (err) {
    console.error('[callrail-webhook] error', err.message);
    return res.status(502).json({ ok: false, error: err.message });
  }
});

// TEMPORARY setup helper: returns CallRail accounts (id + name) using the API
// key, ONLY while no account ids are configured yet. Self-disables (410) once
// CALLRAIL_ACCOUNT_IDS is set, so it needs no manual removal.
app.get('/admin/callrail/accounts', async (req, res) => {
  if (!CALLRAIL_API_KEY) return res.status(400).json({ error: 'CALLRAIL_API_KEY is not set' });
  if (CALLRAIL_ACCOUNT_IDS.length) return res.status(410).json({ error: 'Already configured (CALLRAIL_ACCOUNT_IDS set)' });
  try {
    const r = await fetch('https://api.callrail.com/v3/a.json', {
      headers: { Authorization: `Token token="${CALLRAIL_API_KEY}"`, Accept: 'application/json' },
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    if (!r.ok) return res.status(r.status).json({ error: 'CallRail API error', status: r.status, body: text.slice(0, 300) });
    const accounts = (json && (json.accounts || json.data)) || [];
    return res.json({ ok: true, accounts: accounts.map(a => ({ id: a.id, name: a.name })) });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

// TEMPORARY self-disabling diagnostic: reports what CallRail's calls endpoint
// returns per account (HTTP status + total count only — NO call data), while the
// calls table is still empty. Returns 410 once any calls exist. Same safe pattern
// as the accounts setup helper; lets setup verify the pull without app/alerts.
app.get('/admin/callrail/diag', async (req, res) => {
  if (!CALLRAIL_API_KEY || !CALLRAIL_ACCOUNT_IDS.length) return res.status(400).json({ error: 'CallRail is not configured' });
  const existing = await sbGet('calls?select=id&limit=1');
  if (Array.isArray(existing) && existing.length) return res.status(410).json({ error: 'Calls already present; diagnostic disabled' });
  const err = (x) => x.ok ? undefined : ((x.json && (x.json.error || x.json.message)) || `HTTP ${x.status}`);
  const out = [];
  for (const acct of CALLRAIL_ACCOUNT_IDS) {
    const wf = await callrailApi(acct, 'calls.json?per_page=1&fields=source,medium,campaign,first_call,gclid&date_range=last_90_days');
    const nf = await callrailApi(acct, 'calls.json?per_page=1&date_range=last_90_days');
    const nfAll = await callrailApi(acct, 'calls.json?per_page=1&date_range=all_time');
    out.push({
      account: acct,
      with_fields: { status: wf.status, total_90d: wf.json ? (wf.json.total_records ?? null) : null, error: err(wf) },
      no_fields:   { status: nf.status, total_90d: nf.json ? (nf.json.total_records ?? null) : null, error: err(nf) },
      all_time:    { status: nfAll.status, total: nfAll.json ? (nfAll.json.total_records ?? null) : null, error: err(nfAll) },
    });
  }
  return res.json({ ok: true, accounts: out, running: callrailBackfillRunning, last_backfill: lastBackfillResult });
});

// List CallRail tracking numbers (flattened from trackers), for the admin
// assignment UI. The app fetches current assignments + suggestions itself.
app.get('/admin/callrail/numbers', requireCallAccess, async (req, res) => {
  if (!CALLRAIL_API_KEY || !CALLRAIL_ACCOUNT_IDS.length) return res.status(400).json({ error: 'CallRail is not configured on the server' });
  try {
    const nameById = Object.fromEntries((await callrailAccounts()).map(a => [a.id, a.name]));
    const numbers = [];
    for (const acct of CALLRAIL_ACCOUNT_IDS) {
      for (let page = 1; page <= 20; page++) {
        const r = await callrailApi(acct, `trackers.json?per_page=250&page=${page}`);
        if (!r.ok) break;
        const trackers = (r.json && (r.json.trackers || r.json.data)) || [];
        for (const t of trackers) {
          const nums = t.tracking_numbers || (t.tracking_number ? [t.tracking_number] : []);
          for (const n of nums) {
            numbers.push({
              tracking_phone_number: n,
              tracker_id: t.id || null,
              tracker_name: t.name || null,
              company_id: (t.company && t.company.id) || t.company_id || null,
              company_name: (t.company && t.company.name) || null,
              account_id: acct,
              account_name: nameById[acct] || null,
              status: t.status || null,
            });
          }
        }
        const totalPages = r.json && (r.json.total_pages || r.json.pages);
        if (trackers.length < 250 || (totalPages && page >= totalPages)) break;
      }
    }
    return res.json({ ok: true, numbers });
  } catch (err) {
    console.error('[callrail-numbers] error', err.message);
    return res.status(502).json({ error: err.message });
  }
});

// Historical backfill: pull calls (all accounts) in a date range, bulk-upsert,
// then resolve location/job/date_contacted set-based. Runs in the BACKGROUND —
// responds 202 immediately so long pulls can't time out; progress is logged.
let callrailBackfillRunning = false;
let lastBackfillResult = null; // captured for the self-disabling diag endpoint
app.post('/admin/callrail/backfill', requireCallAccess, async (req, res) => {
  if (!CALLRAIL_API_KEY || !CALLRAIL_ACCOUNT_IDS.length) return res.status(400).json({ error: 'CallRail is not configured on the server' });
  if (callrailBackfillRunning) return res.status(409).json({ error: 'A backfill is already running' });
  const { start_date, end_date } = req.body || {};
  // Only OPTIONAL attribution fields (source/medium/campaign/first_call/gclid);
  // phone, answered, duration, direction, start_time, customer_* are defaults.
  const fields = 'source,medium,campaign,first_call,gclid';
  // CallRail date_range must be one of: recent,today,yesterday,last_7_days,
  // last_30_days,this_month,last_month,this_year,last_year,all_time. Default to
  // full history so job-matching / date_contacted / suggestions have everything.
  const dateQ = (start_date && end_date) ? `&start_date=${start_date}&end_date=${end_date}` : '&date_range=all_time';

  // Probe account #1 page 1 synchronously so config/auth/param errors + the
  // available call count surface in the response (the full pull runs in bg).
  const probeAcct = CALLRAIL_ACCOUNT_IDS[0];
  const p = await fetchCallsPage(probeAcct, 1, fields, dateQ);
  const pcalls = (p.json && (p.json.calls || p.json.data)) || [];
  const probe = {
    account: probeAcct,
    status: p.status,
    total_records: p.json ? (p.json.total_records ?? p.json.total ?? null) : null,
    page_count: pcalls.length,
    error: p.ok ? undefined : ((p.json && (p.json.error || p.json.message)) || `CallRail HTTP ${p.status}`),
  };

  callrailBackfillRunning = true;
  lastBackfillResult = { phase: 'started', probe, fetched: 0, upserted: 0, error: null, at: new Date().toISOString() };
  res.status(202).json({ ok: true, started: true, probe }); // respond now; process below

  (async () => {
    let fetched = 0, upserted = 0, firstErr = null;
    try {
      for (const acct of CALLRAIL_ACCOUNT_IDS) {
        for (let page = 1; page <= 200; page++) {
          const r = await fetchCallsPage(acct, page, fields, dateQ);
          if (!r.ok) { firstErr = firstErr || `fetch ${acct} p${page} HTTP ${r.status}`; console.error('[callrail-backfill] api', acct, r.status); break; }
          const calls = (r.json && (r.json.calls || r.json.data)) || [];
          // Dedupe by callrail_id within the batch — a repeated conflict target
          // in one upsert statement makes Postgres reject the whole batch.
          const seen = new Set();
          const rows = [];
          for (const c of calls) {
            const row = mapCallRow(c);
            if (row.callrail_id && !seen.has(row.callrail_id)) { seen.add(row.callrail_id); rows.push(row); }
          }
          if (rows.length) {
            try { await sbUpsert('calls', rows, 'callrail_id'); upserted += rows.length; }
            catch (ue) { firstErr = firstErr || `upsert: ${ue.message}`; throw ue; }
          }
          fetched += calls.length;
          lastBackfillResult = { phase: 'running', fetched, upserted, error: firstErr, at: new Date().toISOString() };
          if (calls.length < 250) break;
        }
      }
      await sbRpc('callrail_resolve_all'); // fill location_id/job_id + date_contacted
      lastBackfillResult = { phase: 'done', fetched, upserted, error: firstErr, at: new Date().toISOString() };
      console.log('[callrail-backfill] done', { fetched, upserted });
    } catch (err) {
      lastBackfillResult = { phase: 'error', fetched, upserted, error: firstErr || err.message, at: new Date().toISOString() };
      console.error('[callrail-backfill] error', err.message);
    } finally {
      callrailBackfillRunning = false;
    }
  })();
});

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

// ── JobNimbus financials reconcile (periodic pull) ────────────────────────────
// The JN automation webhooks are not sufficient for financial data: payment
// events never fire at all (automation is active but JN never calls the URL),
// and invoice webhook payloads are slim — total/total_paid/due/date_invoice
// arrive as undefined, so webhook-synced invoices carry no amounts. This loop
// pulls records modified since the last sync from the JN API (date_updated
// range filter, verified working) and upserts complete rows. The first run
// after deploy automatically catches up from each table's max(last_synced).
const RECONCILE_INTERVAL_MS = 10 * 60 * 1000;
const RECONCILE_OVERLAP_MS = 24 * 60 * 60 * 1000;     // re-pull window overlap
const RECONCILE_MAX_LOOKBACK_MS = 45 * 24 * 60 * 60 * 1000;

const sbHeaders = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` };

async function sbSelect(table, query) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: sbHeaders });
  if (!r.ok) throw new Error(`${table} select ${r.status}`);
  return r.json();
}

async function sbBulkUpsert(table, rows) {
  if (!rows.length) return;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=jn_id`, {
    method: 'POST',
    headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`${table} bulk upsert ${r.status} ${(await r.text()).slice(0, 300)}`);
}

// Pull all records modified since `sinceSecs` (unix). Pages with from/size and,
// if the ES 10k window cap is hit, advances the date cursor and keeps going.
async function jnFetchUpdatedSince(path, sinceSecs) {
  const out = [];
  let cursor = sinceSecs;
  for (let guard = 0; guard < 20; guard++) {
    const filter = encodeURIComponent(JSON.stringify({ must: [{ range: { date_updated: { gte: cursor } } }] }));
    let count = Infinity, fetched = 0, pageMax = cursor;
    for (let from = 0; from + 500 <= 10000 && fetched < count; from += 500) {
      const r = await fetch(`${JN_BASE}${path}?size=500&from=${from}&filter=${filter}`, {
        headers: { Authorization: `bearer ${JN_TOKEN}`, Accept: 'application/json' },
      });
      if (!r.ok) throw new Error(`JN ${path} ${r.status}`);
      const data = await r.json();
      const page = data?.results ?? data?.data ?? [];
      count = data?.count ?? data?.total ?? page.length;
      out.push(...page);
      fetched += page.length;
      for (const it of page) {
        if (typeof it.date_updated === 'number' && it.date_updated > pageMax) pageMax = it.date_updated;
      }
      if (page.length < 500) break;
    }
    if (fetched >= count || pageMax <= cursor) return out;
    cursor = pageMax; // hit the ES from+size cap — advance the window
  }
  return out;
}

// Batch-resolve related job jn_ids → { job_id, location_id } in one pass.
async function resolveJobRefs(records) {
  const jnIds = new Set();
  for (const rec of records) {
    const ref = (Array.isArray(rec.related) ? rec.related : []).find(x => x && x.type === 'job' && x.id);
    if (ref) jnIds.add(String(ref.id));
  }
  const map = new Map();
  const ids = [...jnIds];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100).map(id => `"${id}"`).join(',');
    const rows = await sbSelect('jobs', `jn_id=in.(${encodeURIComponent(chunk)})&select=jn_id,id,location_id`);
    for (const row of rows) map.set(row.jn_id, { job_id: row.id, location_id: row.location_id || null });
  }
  return map;
}

function jobRefFor(rec, jobMap) {
  const ref = (Array.isArray(rec.related) ? rec.related : []).find(x => x && x.type === 'job' && x.id);
  return (ref && jobMap.get(String(ref.id))) || { job_id: null, location_id: null };
}

// Since-cursor per table: catch up from the newest last_synced (minus overlap).
// Gotcha: webhooks also bump last_synced, so that cursor alone can leave older
// webhook-created rows amount-less forever (slim payloads). Guard: also look
// back to the oldest recent row whose amount column is still NULL and widen
// the window to include it — those rows get re-pulled until they heal.
async function reconcileSinceSecs(table, amountCol) {
  const now = Date.now();
  const floor = now - RECONCILE_MAX_LOOKBACK_MS;
  let since = floor;
  try {
    const rows = await sbSelect(table, 'select=last_synced&order=last_synced.desc.nullslast&limit=1');
    const last = rows?.[0]?.last_synced ? new Date(rows[0].last_synced).getTime() : NaN;
    if (!isNaN(last)) since = Math.max(since, last - RECONCILE_OVERLAP_MS);

    const floorISO = new Date(floor).toISOString();
    const nullRows = await sbSelect(table,
      `select=jn_created&${amountCol}=is.null&jn_created=gt.${encodeURIComponent(floorISO)}&order=jn_created.asc&limit=1`);
    const oldestNull = nullRows?.[0]?.jn_created ? new Date(nullRows[0].jn_created).getTime() : NaN;
    if (!isNaN(oldestNull)) since = Math.min(since, Math.max(floor, oldestNull - RECONCILE_OVERLAP_MS));
  } catch (err) {
    console.error(`[jn-reconcile] ${table} cursor lookup failed, using max lookback:`, err.message);
  }
  return Math.floor(since / 1000);
}

let reconcileRunning = false;
async function reconcileFinancials() {
  if (reconcileRunning) return;
  reconcileRunning = true;
  const nowISO = new Date().toISOString();
  try {
    const [invSince, paySince] = await Promise.all([
      reconcileSinceSecs('invoices', 'total'),
      reconcileSinceSecs('payments', 'amount'),
    ]);
    const [invoices, payments] = await Promise.all([
      jnFetchUpdatedSince('/v2/invoices', invSince),
      jnFetchUpdatedSince('/payments', paySince),
    ]);
    const jobMap = await resolveJobRefs([...invoices, ...payments]);

    const invoiceRows = invoices
      .filter(inv => inv.jnid || inv.id)
      .map(inv => {
        const ref = jobRefFor(inv, jobMap);
        return {
          jn_id: String(inv.jnid ?? inv.id),
          job_id: ref.job_id,
          location_id: ref.location_id,
          number: inv.number ?? null,
          status_name: inv.status_name ?? null,
          total: inv.total ?? null,
          total_paid: inv.total_paid ?? null,
          due: inv.due ?? null,
          date_invoice: jnToDate(inv.date_invoice) ?? null,
          date_due: jnToDate(inv.date_due) ?? null,
          date_paid_in_full: jnToDate(inv.date_paid_in_full) ?? null,
          jn_created: jnToISO(inv.date_created) ?? null,
          jn_updated: jnToISO(inv.date_updated ?? inv.date_modified) ?? null,
          last_synced: nowISO,
        };
      });

    const paymentRows = payments
      .filter(pay => pay.jnid || pay.id)
      .map(pay => {
        const ref = jobRefFor(pay, jobMap);
        return {
          jn_id: String(pay.jnid ?? pay.id),
          job_id: ref.job_id,
          location_id: ref.location_id,
          amount: pay.total ?? pay.amount ?? null,
          method_id: pay.method_id ?? null,
          note: pay.note ?? pay.description ?? null,
          jn_created: jnToISO(pay.date_payment ?? pay.date_created) ?? null,
          jn_updated: jnToISO(pay.date_updated ?? pay.date_modified) ?? null,
          last_synced: nowISO,
        };
      });

    await sbBulkUpsert('invoices', invoiceRows);
    await sbBulkUpsert('payments', paymentRows);
    console.log(`[jn-reconcile] upserted ${invoiceRows.length} invoices, ${paymentRows.length} payments`);
  } catch (err) {
    console.error('[jn-reconcile] failed:', err.message);
  } finally {
    reconcileRunning = false;
  }
}

if (SUPABASE_SERVICE_KEY) {
  setTimeout(reconcileFinancials, 15 * 1000); // catch-up shortly after boot
  setInterval(reconcileFinancials, RECONCILE_INTERVAL_MS);
}

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

// ── Referral program: lead source invites (admin/owner only) ─────────────────
// Creates the lead_sources row (service key — token generation and SMS happen
// in one call) and texts the lead source a tokenized signup link. The row is
// kept even when the SMS fails so the owner can fix Twilio config and resend.
function leadSourceStructureError(b) {
  const basisOk = v => v === 'fixed' || v === 'percent';
  const rateOk = v => Number.isFinite(Number(v)) && Number(v) > 0;
  if (b.split_by_payer) {
    if (!basisOk(b.ins_basis) || !rateOk(b.ins_rate)) return 'insurance structure requires a basis (fixed/percent) and a positive rate';
    if (!basisOk(b.oop_basis) || !rateOk(b.oop_rate)) return 'out-of-pocket structure requires a basis (fixed/percent) and a positive rate';
  } else {
    if (!basisOk(b.referral_basis) || !rateOk(b.referral_rate)) return 'referral structure requires a basis (fixed/percent) and a positive rate';
  }
  return null;
}

function inviteSmsBody(name, locName, token) {
  return `Hi ${name}! ${locName} has invited you to join their referral program. Sign up here: ${WEB_APP_URL}/referral?token=${token}`;
}

app.post('/admin/lead-sources/invite', requireAuth, requireAdmin, async (req, res) => {
  const b = req.body || {};
  const { location_id, company_id, source_type, name } = b;
  if (!location_id || !company_id || !source_type || !name || !String(name).trim()) {
    return res.status(400).json({ error: 'location_id, company_id, source_type and name are required' });
  }
  if (!UUID_RE.test(String(company_id))) return res.status(400).json({ error: 'Invalid company id' });
  const phone = toE164(b.phone);
  if (!phone) return res.status(400).json({ error: 'Invalid phone number' });
  const shapeErr = leadSourceStructureError(b);
  if (shapeErr) return res.status(400).json({ error: shapeErr });

  const split = !!b.split_by_payer;
  const inviteToken = crypto.randomBytes(24).toString('hex');
  const now = new Date().toISOString();
  const row = {
    location_id: String(location_id),
    company_id,
    source_type: String(source_type),
    name: String(name).trim(),
    phone,
    split_by_payer: split,
    referral_basis: split ? null : b.referral_basis,
    referral_rate: split ? null : Number(b.referral_rate),
    ins_basis: split ? b.ins_basis : null,
    ins_rate: split ? Number(b.ins_rate) : null,
    oop_basis: split ? b.oop_basis : null,
    oop_rate: split ? Number(b.oop_rate) : null,
    percent_scope: b.percent_scope === 'first_invoice' ? 'first_invoice' : 'revenue',
    invite_token: inviteToken,
    status: 'invited',
    invited_at: now,
    last_invited_at: now,
    invite_count: 1,
    created_by: req.userId || null,
  };

  try {
    const cr = await fetch(`${SUPABASE_URL}/rest/v1/lead_sources`, {
      method: 'POST',
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify(row),
    });
    const body = await cr.json().catch(() => null);
    if (!cr.ok) {
      if (cr.status === 409) return res.status(409).json({ error: 'A lead source with this phone number already exists for this location' });
      const msg = (body && (body.message || body.error)) || 'create lead source failed';
      return res.status(cr.status).json({ error: msg });
    }
    const leadSource = Array.isArray(body) ? body[0] : body;

    const locs = await sbGet(`locations?id=eq.${encodeURIComponent(String(location_id))}&select=name`);
    const locName = (locs && locs[0] && locs[0].name) || 'A restoration company';
    const sms = await sendSms(phone, inviteSmsBody(row.name, locName, inviteToken));
    if (!sms.ok) console.warn('[lead-source invite] SMS failed:', sms.error);
    return res.status(200).json({ ok: true, lead_source: leadSource, sms_sent: sms.ok, ...(sms.ok ? {} : { sms_error: sms.error }) });
  } catch (err) {
    console.error('[lead-source invite error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.post('/admin/lead-sources/resend', requireAuth, requireAdmin, async (req, res) => {
  const id = String((req.body || {}).lead_source_id || '');
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid lead source id' });
  try {
    const rows = await sbGet(`lead_sources?id=eq.${id}&select=id,name,phone,location_id,status,invite_token,invite_count`);
    const ls = rows && rows[0];
    if (!ls) return res.status(404).json({ error: 'Lead source not found' });
    if (ls.status === 'signed_up') return res.status(400).json({ error: 'This lead source has already signed up' });

    let token = ls.invite_token;
    if (!token) token = crypto.randomBytes(24).toString('hex');
    const locs = await sbGet(`locations?id=eq.${encodeURIComponent(String(ls.location_id))}&select=name`);
    const locName = (locs && locs[0] && locs[0].name) || 'A restoration company';
    const sms = await sendSms(ls.phone, inviteSmsBody(ls.name, locName, token));
    if (!sms.ok) return res.status(502).json({ error: sms.error });

    const pr = await fetch(`${SUPABASE_URL}/rest/v1/lead_sources?id=eq.${id}`, {
      method: 'PATCH',
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ invite_token: token, last_invited_at: new Date().toISOString(),
        invite_count: (Number(ls.invite_count) || 0) + 1, updated_at: new Date().toISOString() }),
    });
    if (!pr.ok) console.warn('[lead-source resend] row update failed', pr.status);
    return res.status(200).json({ ok: true, sms_sent: true });
  } catch (err) {
    console.error('[lead-source resend error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n✓ A1 Drying Log running at http://localhost:${PORT}\n`);
});
