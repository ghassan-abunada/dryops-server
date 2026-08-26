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
// Resend (email for referral-program invites while Twilio A2P approval is
// pending). EMAIL_FROM e.g. "DryOps <invites@yourdomain.com>" — the domain must
// be verified in Resend. Invites prefer SMS whenever Twilio is configured and
// the lead source has a phone; otherwise they go out by email.
const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim();
const EMAIL_FROM = (process.env.EMAIL_FROM || '').trim();
// Lead-source portal field encryption (full TIN / bank numbers). 32-byte
// base64 key per version; AES-256-GCM with AAD binding ciphertext to
// row+field. Rotation: add LEAD_ENC_KEY_V2, flip LEAD_ENC_CURRENT, keep V1
// for reads until no v1: prefixes remain.
const LEAD_ENC_KEYS = {};
for (const [env, ver] of [['LEAD_ENC_KEY_V1', 'v1'], ['LEAD_ENC_KEY_V2', 'v2']]) {
  const raw = (process.env[env] || '').trim();
  if (!raw) continue;
  const buf = Buffer.from(raw, 'base64');
  if (buf.length === 32) LEAD_ENC_KEYS[ver] = buf;
  else console.warn(`WARNING: ${env} is not 32 bytes of base64 — ignored`);
}
const LEAD_ENC_CURRENT = LEAD_ENC_KEYS.v2 ? 'v2' : 'v1';
if (!LEAD_ENC_KEYS[LEAD_ENC_CURRENT]) {
  console.warn('WARNING: LEAD_ENC_KEY_V1 not set — lead-source portal signup/bank endpoints will 503 until it is.');
}
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

// Must run after requireAuth. Admin ONLY — unlike requireAdmin, owners are NOT
// admitted. Used for the user-lifecycle endpoints (list/ban/delete/password):
// the app exposes those to admins only, and letting owners at them would allow
// modifying other owners outside the UI's rules.
async function requireStrictAdmin(req, res, next) {
  try {
    const rows = await sbGet(`profiles?id=eq.${req.userId}&select=role`);
    const role = Array.isArray(rows) && rows[0] ? rows[0].role : null;
    if (role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    next();
  } catch (err) {
    console.error('[strict-admin check error]', err.message);
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
// JN account renames leave old name stamps behind, and DryOps groups metrics
// by sales_rep NAME — so alias all known variants of one human to a single
// canonical name at every ingestion point (webhook + backfill). One-time DB
// updates applied when an alias is added; this map keeps future syncs from
// re-splitting them.
const REP_NAME_ALIASES = {
  'Dylan Haycock PPO': 'Dylan Haycock', // same JN user (mc3jgr05pje9aho8vpmd1ba),
  'Dylan Haycock APO': 'Dylan Haycock', // renamed APO→PPO; merged 2026-08-21
};
function normalizeRepName(n) {
  const t = typeof n === 'string' ? n.trim() : n;
  return (t && REP_NAME_ALIASES[t]) || t;
}

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
  set('sales_rep', normalizeRepName(pick('sales_rep_name'))); // JN built-in display name, e.g. "Jane Smith"
  set('date_loss', jnToDate(job.cf_date_1));
  set('date_start', jnToDate(job.start_date));
  set('record_type', recordType || undefined);
  set('status', job.status_name || undefined);
  if (job.active !== undefined) set('is_active', !!job.active);
  else if (job.is_active !== undefined) set('is_active', !!job.is_active);
  set('jn_created', jnToISO(job.date_created));
  set('jn_updated', jnToISO(job.date_modified || job.date_updated));

  // Resolve JobNimbus numeric location id -> our locations.id UUID. Unknown
  // ids (a location created in JN after our seed) get a placeholder row
  // auto-created so the job attaches immediately — an admin renames it later
  // in Settings → Locations (JN's API exposes no location names anywhere).
  const jnLocRaw = job.location && (job.location.id ?? job.location);
  if (jnLocRaw != null && /^\d+$/.test(String(jnLocRaw))) {
    const jnLocId = Number(jnLocRaw);
    set('jn_location_id', jnLocId);
    try {
      const locUuid = await ensureLocationForJnId(jnLocId);
      if (locUuid) set('location_id', locUuid);
    } catch (err) { console.error('[jn-webhook] location resolve error', err.message); }
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
  if (!callrailWebhookOk(req)) {
    // Loud on purpose: the Aug 2026 outage was invisible because rejected
    // deliveries logged nothing — CallRail showed the webhook "live" while
    // every POST 401'd. This line makes token drift show up in Railway logs.
    console.warn('[callrail-webhook] rejected delivery:',
      CALLRAIL_WEBHOOK_TOKEN ? 'token mismatch (check ?token= in the CallRail webhook URL)' : 'CALLRAIL_WEBHOOK_TOKEN env var is not set');
    return res.status(401).json({ error: 'unauthorized' });
  }
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

// ── CallRail calls reconcile (periodic pull) ─────────────────────────────────
// Calls were fed ONLY by the post-call webhook, and webhook delivery silently
// died (Aug 2026: three weeks of zero calls until the exec page went blank).
// Same lesson as the JN financials reconcile: webhooks are an optimization,
// pull is the mechanism of record. Every 30 minutes pull the last few days of
// calls from every account, upsert (merge-duplicates preserves the resolved
// location_id/job_id on existing rows), and re-run the set-based resolver for
// anything new. Missed webhooks now self-heal within one cycle.
const CALLS_RECONCILE_INTERVAL_MS = 30 * 60 * 1000;
const CALLS_RECONCILE_LOOKBACK_DAYS = 3;

let callsReconcileRunning = false;
async function reconcileCalls() {
  if (!CALLRAIL_API_KEY || !CALLRAIL_ACCOUNT_IDS.length) return;
  if (callsReconcileRunning || callrailBackfillRunning) return;
  callsReconcileRunning = true;
  try {
    const end = new Date(Date.now() + 86400 * 1000); // tomorrow: timezone slack
    const start = new Date(Date.now() - CALLS_RECONCILE_LOOKBACK_DAYS * 86400 * 1000);
    const dateQ = `&start_date=${start.toISOString().slice(0, 10)}&end_date=${end.toISOString().slice(0, 10)}`;
    const fields = 'source,medium,campaign,first_call,gclid';
    let upserted = 0;
    for (const acct of CALLRAIL_ACCOUNT_IDS) {
      for (let page = 1; page <= 40; page++) {
        const r = await fetchCallsPage(acct, page, fields, dateQ);
        if (!r.ok) { console.error('[calls-reconcile] api', acct, r.status); break; }
        const calls = (r.json && (r.json.calls || r.json.data)) || [];
        const seen = new Set();
        const rows = [];
        for (const c of calls) {
          const row = mapCallRow(c);
          if (row.callrail_id && !seen.has(row.callrail_id)) { seen.add(row.callrail_id); rows.push(row); }
        }
        if (rows.length) { await sbUpsert('calls', rows, 'callrail_id'); upserted += rows.length; }
        if (calls.length < 250) break;
      }
    }
    if (upserted) await sbRpc('callrail_resolve_all'); // location/job/date_contacted for new rows
    console.log(`[calls-reconcile] upserted ${upserted} calls (${CALLS_RECONCILE_LOOKBACK_DAYS}d window)`);
  } catch (err) {
    console.error('[calls-reconcile] failed:', err.message);
  } finally {
    callsReconcileRunning = false;
  }
}
if (SUPABASE_SERVICE_KEY) {
  setTimeout(reconcileCalls, 45 * 1000);
  setInterval(reconcileCalls, CALLS_RECONCILE_INTERVAL_MS);
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
  // JN pulls can return the same record twice (cursor-advance re-fetch), and
  // duplicate jn_ids within one INSERT make ON CONFLICT fail with 21000
  // "cannot affect row a second time" — killing the whole batch. Last one wins.
  const uniq = [...new Map(rows.map(r => [r.jn_id, r])).values()];
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=jn_id`, {
    method: 'POST',
    headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(uniq),
  });
  if (!r.ok) throw new Error(`${table} bulk upsert ${r.status} ${(await r.text()).slice(0, 300)}`);
}

// Pull all records modified since `sinceSecs` (unix). Pages with from/size and,
// if the ES 10k window cap is hit, advances the date cursor and keeps going.
// Response array key varies by endpoint: invoices/payments use results/data,
// /files uses `files`, /activities uses `activity`. `extraQuery` is appended verbatim (e.g. '&fields=…' to
// slim heavy payloads like proposals' template_json) — include date_updated in
// any fields list or the cursor can't advance.
async function jnFetchUpdatedSince(path, sinceSecs, extraQuery = '') {
  const out = [];
  let cursor = sinceSecs;
  for (let guard = 0; guard < 20; guard++) {
    const filter = encodeURIComponent(JSON.stringify({ must: [{ range: { date_updated: { gte: cursor } } }] }));
    let count = Infinity, fetched = 0, pageMax = cursor;
    for (let from = 0; from + 500 <= 10000 && fetched < count; from += 500) {
      const r = await fetch(`${JN_BASE}${path}?size=500&from=${from}&filter=${filter}${extraQuery}`, {
        headers: { Authorization: `bearer ${JN_TOKEN}`, Accept: 'application/json' },
      });
      if (!r.ok) throw new Error(`JN ${path} ${r.status}`);
      const data = await r.json();
      const page = data?.results ?? data?.data ?? data?.activity ?? data?.files ?? [];
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

// ── Sales-rep backfill ────────────────────────────────────────────────────────
// One-time: pull every JN job, extract sales_rep_name, and fill jobs.sales_rep
// for rows that don't have one yet. The webhook keeps new jobs current; this
// covers everything created before the sales_rep mapping existed. Updates are
// batched one PATCH per (rep, ≤80 jn_ids) — never an upsert, so it can't create
// skeleton rows for JN jobs we don't track.
let salesRepBackfillRunning = false;
let lastSalesRepBackfill = null;

async function backfillSalesReps() {
  if (salesRepBackfillRunning) return;
  salesRepBackfillRunning = true;
  lastSalesRepBackfill = { phase: 'started', at: new Date().toISOString() };
  try {
    // All local jobs still missing a rep (paged: PostgREST caps a response at max-rows).
    const missing = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await sbSelect('jobs', `select=jn_id&sales_rep=is.null&order=jn_id&limit=1000&offset=${offset}`);
      missing.push(...page);
      if (page.length < 1000) break;
    }
    const missingIds = new Set(missing.map(r => r.jn_id));
    console.log(`[salesrep-backfill] ${missingIds.size} local jobs missing sales_rep`);
    if (missingIds.size === 0) {
      lastSalesRepBackfill = { phase: 'done', updated: 0, at: new Date().toISOString() };
      return;
    }

    // Everything JN has, pulled in month-sized date_created windows. NOT
    // jnFetchUpdatedSince: its moving-cursor pagination assumes results come
    // back ordered by date_updated, but JN returns them unordered — on the
    // first run the cursor leapt past most of the history and left Jan–May
    // at ~0% coverage. Fixed windows have no ordering assumption, and no
    // month is anywhere near the ES 10k from+size cap.
    const jnJobs = [];
    const cur = new Date(Date.UTC(2024, 0, 1));
    while (cur < new Date()) {
      const gte = Math.floor(cur.getTime() / 1000);
      cur.setUTCMonth(cur.getUTCMonth() + 1);
      const lt = Math.floor(cur.getTime() / 1000);
      const filter = encodeURIComponent(JSON.stringify({ must: [{ range: { date_created: { gte, lt } } }] }));
      let count = Infinity;
      for (let from = 0; from < 10000 && from < count; from += 500) {
        const r = await fetch(`${JN_BASE}/jobs?size=500&from=${from}&filter=${filter}`, {
          headers: { Authorization: `bearer ${JN_TOKEN}`, Accept: 'application/json' },
        });
        if (!r.ok) throw new Error(`JN /jobs ${r.status}`);
        const data = await r.json();
        const page = data?.results ?? data?.data ?? [];
        count = data?.count ?? data?.total ?? page.length;
        jnJobs.push(...page);
        if (page.length < 500) break;
      }
    }
    console.log(`[salesrep-backfill] fetched ${jnJobs.length} JN jobs`);
    const idsByRep = new Map(); // rep name -> [jn_id]
    for (const j of jnJobs) {
      const id = String(j.jnid || j.id || j.recid || '');
      const rep = normalizeRepName(typeof j.sales_rep_name === 'string' ? j.sales_rep_name.trim() : '');
      if (!id || !rep || !missingIds.has(id)) continue;
      if (!idsByRep.has(rep)) idsByRep.set(rep, []);
      idsByRep.get(rep).push(id);
    }

    let updated = 0;
    for (const [rep, ids] of idsByRep) {
      for (let i = 0; i < ids.length; i += 80) {
        const chunk = ids.slice(i, i + 80).map(id => `"${id}"`).join(',');
        const r = await fetch(`${SUPABASE_URL}/rest/v1/jobs?jn_id=in.(${encodeURIComponent(chunk)})`, {
          method: 'PATCH',
          headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ sales_rep: rep }),
        });
        if (!r.ok) throw new Error(`jobs patch ${r.status} ${(await r.text()).slice(0, 200)}`);
        updated += Math.min(80, ids.length - i);
      }
    }
    console.log(`[salesrep-backfill] done — set sales_rep on ${updated} jobs across ${idsByRep.size} reps`);
    lastSalesRepBackfill = { phase: 'done', updated, reps: idsByRep.size, at: new Date().toISOString() };
  } catch (err) {
    console.error('[salesrep-backfill] failed:', err.message);
    lastSalesRepBackfill = { phase: 'error', error: err.message, at: new Date().toISOString() };
  } finally {
    salesRepBackfillRunning = false;
  }
}

// Auto-run once shortly after boot, but only while coverage is clearly
// incomplete. Ratio, NOT an absolute count: live webhook events stamp reps
// within seconds of boot (an is-empty check raced and skipped run #1), and a
// partial run can leave thousands populated (run #2's pagination bug did).
// A completed backfill covers well over 30% of all jobs; below that, run.
if (SUPABASE_SERVICE_KEY) {
  setTimeout(async () => {
    try {
      const countOf = async (q) => {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/jobs?select=id${q}&limit=1`, {
          method: 'HEAD', headers: { ...sbHeaders, Prefer: 'count=exact' },
        });
        return Number((r.headers.get('content-range') || '').split('/')[1] || 0);
      };
      const [withRep, total] = await Promise.all([countOf('&sales_rep=not.is.null'), countOf('')]);
      if (total > 0 && withRep / total < 0.3) backfillSalesReps();
      else console.log(`[salesrep-backfill] boot check: ${withRep}/${total} jobs have sales_rep — skipping`);
    } catch (err) { console.error('[salesrep-backfill] boot check failed:', err.message); }
  }, 30 * 1000);
}

// Manual re-run (e.g. after JN rep reassignments): fills NULLs only.
app.post('/admin/jobs/backfill-sales-rep', requireAuth, requireAdmin, async (req, res) => {
  if (salesRepBackfillRunning) return res.status(409).json({ error: 'Backfill already running', last: lastSalesRepBackfill });
  backfillSalesReps(); // runs in background
  res.status(202).json({ ok: true, started: true });
});
app.get('/admin/jobs/backfill-sales-rep', requireAuth, requireAdmin, (req, res) => {
  res.json({ running: salesRepBackfillRunning, last: lastSalesRepBackfill });
});

// ── JobNimbus deletion sweep ──────────────────────────────────────────────────
// JN deletions are invisible to the API: GET /jobs/:id returns 404, the record
// vanishes from /jobs search entirely (no is_active:false rows are ever
// returned), and no webhook fires. So deleted jobs linger in Supabase forever.
// This daily sweep removes them, in three stages so a flaky bulk pull can
// never mass-delete:
//   1. Pull every JN job jnid (fixed month windows over date_created — the
//      backfill's proven pattern; a window that comes back incomplete aborts
//      the whole sweep) and every local jobs.jn_id.
//   2. candidates = local − JN. These are only *suspects*: each one is
//      confirmed with a direct GET /jobs/:id, and ONLY a 404 counts as
//      deleted (200 → bulk-pull miss, skip; other errors → skip).
//   3. Confirmed rows are archived to public.deleted_jobs (full row as jsonb;
//      see supabase/add_deleted_jobs_archive.sql in the app repo), then
//      deleted from jobs. Children cascade; invoices/payments keep their rows
//      with job_id nulled; Storage files are untouched.
// Hard cap as a last-resort brake: more than DELETION_SWEEP_MAX confirmed
// deletions in one run aborts before deleting anything.
const DELETION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DELETION_SWEEP_MAX = 300;          // confirmed deletions per run
const DELETION_SWEEP_VERIFY_CAP = 800;   // candidate GETs per run

let deletionSweepRunning = false;
let lastDeletionSweep = null;

// Every JN job jnid, via fixed month windows over date_created (no ordering
// assumption — see the sales-rep backfill note). Throws if any window returns
// fewer records than its reported count, so the caller never diffs against a
// partial id set.
async function jnFetchAllJobIds(startMs) {
  const ids = new Set();
  const cur = new Date(startMs);
  cur.setUTCDate(1); cur.setUTCHours(0, 0, 0, 0);
  while (cur < new Date()) {
    const gte = Math.floor(cur.getTime() / 1000);
    cur.setUTCMonth(cur.getUTCMonth() + 1);
    const lt = Math.floor(cur.getTime() / 1000);
    const filter = encodeURIComponent(JSON.stringify({ must: [{ range: { date_created: { gte, lt } } }] }));
    let count = Infinity, fetched = 0;
    for (let from = 0; from < 10000 && fetched < count; from += 500) {
      const r = await fetch(`${JN_BASE}/jobs?size=500&from=${from}&filter=${filter}&fields=jnid`, {
        headers: { Authorization: `bearer ${JN_TOKEN}`, Accept: 'application/json' },
      });
      if (!r.ok) throw new Error(`JN /jobs ${r.status}`);
      const data = await r.json();
      const page = data?.results ?? data?.data ?? [];
      count = data?.count ?? data?.total ?? page.length;
      for (const j of page) { const id = j.jnid || j.id || j.recid; if (id) ids.add(String(id)); }
      fetched += page.length;
      if (page.length < 500) break;
    }
    if (fetched < count) throw new Error(`window ${new Date(gte * 1000).toISOString().slice(0, 7)} incomplete: ${fetched}/${count}`);
  }
  return ids;
}

async function sweepDeletedJobs() {
  if (deletionSweepRunning) return;
  deletionSweepRunning = true;
  lastDeletionSweep = { phase: 'started', at: new Date().toISOString() };
  try {
    // All local jobs (paged: PostgREST caps a response at max-rows). jn_created
    // bounds the JN pull window; rows with a NULL jn_created are still safe —
    // the per-id 404 check is what authorizes deletion, not the bulk diff.
    const local = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await sbSelect('jobs', `select=jn_id,jn_created&order=jn_id&limit=1000&offset=${offset}`);
      local.push(...page);
      if (page.length < 1000) break;
    }
    let startMs = Date.UTC(2015, 0, 1);
    for (const r of local) {
      const t = r.jn_created ? new Date(r.jn_created).getTime() : NaN;
      if (!isNaN(t) && t < startMs) startMs = t;
    }
    startMs -= 45 * 24 * 60 * 60 * 1000; // pad: JN date_created can predate ours

    const jnIds = await jnFetchAllJobIds(startMs);
    if (jnIds.size === 0) throw new Error('JN returned zero job ids — refusing to diff');

    const candidates = local.map(r => r.jn_id).filter(id => id && !jnIds.has(id));
    console.log(`[deletion-sweep] ${local.length} local, ${jnIds.size} in JN, ${candidates.length} candidates`);

    // Confirm each candidate individually — ONLY a 404 counts as deleted.
    const confirmed = [];
    let skipped = 0;
    for (const id of candidates.slice(0, DELETION_SWEEP_VERIFY_CAP)) {
      const r = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(id)}`, {
        headers: { Authorization: `bearer ${JN_TOKEN}`, Accept: 'application/json' },
      });
      if (r.status === 404) confirmed.push(id);
      else { skipped++; if (!r.ok) console.warn(`[deletion-sweep] ${id} verify got ${r.status} — skipped`); }
      await new Promise(t => setTimeout(t, 100)); // gentle on the JN API
    }

    if (confirmed.length > DELETION_SWEEP_MAX) {
      throw new Error(`${confirmed.length} confirmed deletions exceeds cap ${DELETION_SWEEP_MAX} — aborting, investigate before raising the cap`);
    }

    // Archive full rows, then delete. Chunked so URLs stay under length limits.
    let deleted = 0;
    for (let i = 0; i < confirmed.length; i += 50) {
      const chunk = confirmed.slice(i, i + 50);
      const inList = encodeURIComponent(chunk.map(id => `"${id}"`).join(','));
      const rows = await sbSelect('jobs', `select=*&jn_id=in.(${inList})`);
      if (rows.length) {
        const archive = rows.map(r => ({ jn_id: r.jn_id, job: r, deleted_at: new Date().toISOString() }));
        const ar = await fetch(`${SUPABASE_URL}/rest/v1/deleted_jobs?on_conflict=jn_id`, {
          method: 'POST',
          headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(archive),
        });
        if (!ar.ok) throw new Error(`archive upsert ${ar.status} ${(await ar.text()).slice(0, 200)}`);
      }
      const dr = await fetch(`${SUPABASE_URL}/rest/v1/jobs?jn_id=in.(${inList})`, {
        method: 'DELETE', headers: { ...sbHeaders, Prefer: 'return=minimal' },
      });
      if (!dr.ok) throw new Error(`jobs delete ${dr.status} ${(await dr.text()).slice(0, 200)}`);
      deleted += chunk.length;
    }

    console.log(`[deletion-sweep] done — deleted ${deleted}, skipped ${skipped} unconfirmed`);
    lastDeletionSweep = {
      phase: 'done', local: local.length, jn: jnIds.size,
      candidates: candidates.length, deleted, skipped, at: new Date().toISOString(),
    };
  } catch (err) {
    console.error('[deletion-sweep] failed:', err.message);
    lastDeletionSweep = { phase: 'error', error: err.message, at: new Date().toISOString() };
  } finally {
    deletionSweepRunning = false;
  }
}

if (SUPABASE_SERVICE_KEY) {
  setTimeout(sweepDeletedJobs, 90 * 1000); // first pass shortly after boot
  setInterval(sweepDeletedJobs, DELETION_SWEEP_INTERVAL_MS);
}

app.post('/admin/jobs/deletion-sweep', requireAuth, requireAdmin, (req, res) => {
  if (deletionSweepRunning) return res.status(409).json({ error: 'Sweep already running', last: lastDeletionSweep });
  sweepDeletedJobs(); // runs in background
  res.status(202).json({ ok: true, started: true });
});
app.get('/admin/jobs/deletion-sweep', requireAuth, requireAdmin, (req, res) => {
  res.json({ running: deletionSweepRunning, last: lastDeletionSweep });
});

// ── Location self-heal ────────────────────────────────────────────────────────
// The locations table was seeded once (July 2026 CSV); JN's API exposes no
// location names, so a location created in JN afterwards has no local row and
// its jobs sync with location_id NULL — invisible to location-scoped techs
// and missing from every exec ranking. Two-part fix:
//   * the job webhook calls ensureLocationForJnId() so new jobs attach to an
//     auto-created placeholder row the moment they arrive;
//   * this loop backfills placeholder rows for jn_location_ids already present
//     on orphaned jobs and links those jobs, healing anything the webhook
//     missed (downtime, races, pre-existing orphans).
// Admins rename placeholders in Settings → Locations.

// locations.id UUID for a JN numeric location id, creating a placeholder row
// if none exists. ignore-duplicates guards the concurrent-webhook race (the
// unique index on jn_location_id makes one insert win; both then re-read).
async function ensureLocationForJnId(jnLocId) {
  const rows = await sbSelect('locations', `jn_location_id=eq.${jnLocId}&select=id`);
  if (rows[0] && rows[0].id) return rows[0].id;
  const ins = await fetch(`${SUPABASE_URL}/rest/v1/locations?on_conflict=jn_location_id`, {
    method: 'POST',
    headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify({ name: `New Location #${jnLocId} — needs name`, status: 'active', jn_location_id: jnLocId }),
  });
  if (!ins.ok) throw new Error(`locations insert ${ins.status} ${(await ins.text()).slice(0, 200)}`);
  console.log(`[loc-heal] created placeholder location for JN #${jnLocId}`);
  const again = await sbSelect('locations', `jn_location_id=eq.${jnLocId}&select=id`);
  return again[0] ? again[0].id : null;
}

let locationHealRunning = false;
async function healOrphanLocations() {
  if (locationHealRunning) return;
  locationHealRunning = true;
  try {
    const orphans = await sbSelect('jobs',
      'select=jn_location_id&location_id=is.null&jn_location_id=not.is.null&limit=10000');
    const ids = [...new Set(orphans.map(r => r.jn_location_id))];
    if (!ids.length) return;
    let linked = 0;
    for (const jnLocId of ids) {
      const locUuid = await ensureLocationForJnId(jnLocId);
      if (!locUuid) continue;
      const r = await fetch(`${SUPABASE_URL}/rest/v1/jobs?jn_location_id=eq.${jnLocId}&location_id=is.null`, {
        method: 'PATCH',
        headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal,count=exact' },
        body: JSON.stringify({ location_id: locUuid }),
      });
      if (!r.ok) { console.error(`[loc-heal] link failed for JN #${jnLocId}: ${r.status}`); continue; }
      linked += Number((r.headers.get('content-range') || '').split('/')[1] || 0);
    }
    console.log(`[loc-heal] ${ids.length} orphan location ids, linked ${linked} jobs`);
  } catch (err) {
    console.error('[loc-heal] failed:', err.message);
  } finally {
    locationHealRunning = false;
  }
}

if (SUPABASE_SERVICE_KEY) {
  setTimeout(healOrphanLocations, 60 * 1000);
  setInterval(healOrphanLocations, 6 * 60 * 60 * 1000);
}

// ── JobNimbus photo counts (photos-per-job metric) ───────────────────────────
// The exec "Photos" column and rep Docs % (see supabase/add_jn_photo_counts.sql
// in the app repo) count app-uploaded `photos` rows plus JN-native photos.
// JN holds 5.69M files and creates ~85k/week (~78k photos), so mirroring file
// ROWS is off the table (multi-GB, RPC-timeout territory). Instead we cache a
// per-job COUNT in public.jn_photo_counts (~1 row per job):
//   * seeded by one GET /files?related=<job jn_id>&size=200 per job — the
//     exact query files.tsx uses, so counts match the Files tab (including its
//     200-item page cap; irrelevant for Docs %, which asks "≥1 photo");
//   * kept fresh by a 10-min loop that pulls files updated since the cursor
//     and RECOUNTS just the touched jobs. Recounts are absolute, so photo
//     deletions/deactivations self-heal whenever any file on the job changes.
// Each recount stores photo_count (images) AND doc_count (non-image files,
// e.g. the signed work authorization) from the same fetch — Docs % requires
// ≥5 photos and ≥1 document (see add_doc_requirement.sql).
// No JN file webhook exists and automations are unreliable (see financials
// reconcile above) — pull is the only sound mechanism.

// Matches files.tsx: `f.subtype === 'image' || f.content_type?.startsWith('image/')`.
// NOTE: /files listing records have NO subtype field — content_type does the work.
const isJnImage = (f) =>
  (f.jnid || f.id) && (f.subtype === 'image' || (typeof f.content_type === 'string' && f.content_type.startsWith('image/')));

// One JN call per job; splits the job's files into photos (images) and docs
// (everything else with a jnid — e.g. the signed work authorization PDF).
async function jnCountFilesForJob(jobJnId) {
  const r = await fetch(`${JN_BASE}/files?size=200&related=${encodeURIComponent(jobJnId)}`, {
    headers: { Authorization: `bearer ${JN_TOKEN}`, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`JN /files related=${jobJnId} ${r.status}`);
  const files = ((await r.json())?.files ?? []).filter(f => f.jnid || f.id);
  const photos = files.filter(isJnImage).length;
  return { photos, docs: files.length - photos };
}

// rows: [{ job_id, jn_id, photo_count, last_synced }] — sbBulkUpsert conflicts
// on jn_id, which is unique per job here. Dedupe first: duplicate keys within
// one INSERT make ON CONFLICT fail ("cannot affect row a second time").
async function upsertJnPhotoCounts(rows) {
  const uniq = [...new Map(rows.map(r => [r.jn_id, r])).values()];
  for (let i = 0; i < uniq.length; i += 500) await sbBulkUpsert('jn_photo_counts', uniq.slice(i, i + 500));
  return uniq.length;
}

// Recount a batch of jobs [{id, jn_id}] with a small worker pool (JN latency
// dominates; 4 workers keeps well under any rate limit). Per-job errors are
// counted and skipped so one flaky call can't sink a whole batch.
async function recountJobs(jobRows, tag) {
  const nowISO = new Date().toISOString();
  const out = [];
  let failed = 0, idx = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (idx < jobRows.length) {
      const job = jobRows[idx++];
      try {
        const { photos, docs } = await jnCountFilesForJob(job.jn_id);
        out.push({ job_id: job.id, jn_id: job.jn_id, photo_count: photos, doc_count: docs, last_synced: nowISO });
      } catch (err) {
        failed++;
        if (failed <= 3) console.error(`[${tag}] count failed for job ${job.jn_id}:`, err.message);
      }
    }
  }));
  return { rows: out, failed };
}

const JN_PHOTOS_OVERLAP_MS = 2 * 60 * 60 * 1000; // files churn ~85k/week; 24h overlap would be ~12k records/tick

let jnPhotosReconcileRunning = false;
async function reconcileJnPhotoCounts() {
  if (jnPhotosReconcileRunning) return;
  jnPhotosReconcileRunning = true;
  try {
    // Cursor: newest last_synced minus a 2h overlap. An EMPTY table means the
    // backfill hasn't seeded yet — skip rather than pull the 45-day firehose
    // (~500k file records); the backfill counts every job anyway.
    const rows = await sbSelect('jn_photo_counts', 'select=last_synced&order=last_synced.desc.nullslast&limit=1');
    const last = rows?.[0]?.last_synced ? new Date(rows[0].last_synced).getTime() : NaN;
    if (isNaN(last)) { console.log('[jnphotos-reconcile] table empty — waiting for backfill'); return; }
    const since = Math.max(Date.now() - RECONCILE_MAX_LOOKBACK_MS, last - JN_PHOTOS_OVERLAP_MS);

    const files = (await jnFetchUpdatedSince('/files', Math.floor(since / 1000))).filter(isJnImage);
    const touched = new Set();
    for (const f of files) {
      const ref = (Array.isArray(f.related) ? f.related : []).find(x => x && x.type === 'job' && x.id);
      if (ref) touched.add(String(ref.id));
    }
    // Keep only jobs we track.
    const ids = [...touched];
    const jobRows = [];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100).map(id => `"${id}"`).join(',');
      jobRows.push(...await sbSelect('jobs', `jn_id=in.(${encodeURIComponent(chunk)})&select=id,jn_id`));
    }
    const { rows: countRows, failed } = await recountJobs(jobRows, 'jnphotos-reconcile');
    await upsertJnPhotoCounts(countRows);
    console.log(`[jnphotos-reconcile] ${files.length} changed image files → recounted ${countRows.length}/${jobRows.length} jobs${failed ? ` (${failed} failed)` : ''}`);
  } catch (err) {
    console.error('[jnphotos-reconcile] failed:', err.message);
  } finally {
    jnPhotosReconcileRunning = false;
  }
}

// One-time backfill: count JN photos+docs for every job we track (~40k jobs →
// one JN call each, ~30-40 min at 4 workers). Resumable: jobs whose row has a
// non-null doc_count are skipped (doc_count was added after photo_count, so
// null also marks rows seeded before docs existed), and a crash/restart
// continues where it left off. force=true recounts everything WITHOUT
// deleting first — no data gap while it runs.
let jnPhotosBackfillRunning = false;
let lastJnPhotosBackfill = null;

async function backfillJnPhotoCounts(force = false) {
  if (jnPhotosBackfillRunning) return;
  jnPhotosBackfillRunning = true;
  lastJnPhotosBackfill = { phase: 'started', force, at: new Date().toISOString() };
  try {
    const have = new Set();
    if (!force) {
      for (let offset = 0; ; offset += 1000) {
        const page = await sbSelect('jn_photo_counts', `select=jn_id&doc_count=not.is.null&order=jn_id&limit=1000&offset=${offset}`);
        page.forEach(r => have.add(r.jn_id));
        if (page.length < 1000) break;
      }
    }
    const todo = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await sbSelect('jobs', `select=id,jn_id&order=jn_id&limit=1000&offset=${offset}`);
      todo.push(...page.filter(j => j.jn_id && !have.has(j.jn_id)));
      if (page.length < 1000) break;
    }
    console.log(`[jnphotos-backfill] ${todo.length} jobs to count (${have.size} already done)`);
    let done = 0, failedTotal = 0;
    for (let i = 0; i < todo.length; i += 500) {
      const { rows, failed } = await recountJobs(todo.slice(i, i + 500), 'jnphotos-backfill');
      await upsertJnPhotoCounts(rows);
      done += rows.length; failedTotal += failed;
      console.log(`[jnphotos-backfill] progress ${done}/${todo.length}${failedTotal ? ` (${failedTotal} failed)` : ''}`);
      lastJnPhotosBackfill = { phase: 'running', done, total: todo.length, failed: failedTotal, at: new Date().toISOString() };
    }
    console.log(`[jnphotos-backfill] done — counted ${done} jobs${failedTotal ? `, ${failedTotal} failed` : ''}`);
    lastJnPhotosBackfill = { phase: 'done', done, failed: failedTotal, at: new Date().toISOString() };
  } catch (err) {
    console.error('[jnphotos-backfill] failed:', err.message);
    lastJnPhotosBackfill = { phase: 'error', error: err.message, at: new Date().toISOString() };
  } finally {
    jnPhotosBackfillRunning = false;
  }
}

// Boot: backfill auto-runs while coverage is clearly incomplete (count rows vs
// jobs; a completed backfill covers ~all jobs). The reconcile loop no-ops on an
// empty table, so boot order isn't load-bearing here.
if (SUPABASE_SERVICE_KEY) {
  setTimeout(async () => {
    try {
      const countOf = async (table, q = '') => {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=jn_id${q}&limit=1`, {
          method: 'HEAD', headers: { ...sbHeaders, Prefer: 'count=exact' },
        });
        return Number((r.headers.get('content-range') || '').split('/')[1] || 0);
      };
      // doc_count non-null = seeded since docs were added; null rows re-seed.
      const [counted, jobs] = await Promise.all([countOf('jn_photo_counts', '&doc_count=not.is.null'), countOf('jobs')]);
      if (jobs > 0 && counted / jobs < 0.9) backfillJnPhotoCounts();
      else console.log(`[jnphotos-backfill] boot check: ${counted}/${jobs} jobs counted — skipping`);
    } catch (err) { console.error('[jnphotos-backfill] boot check failed:', err.message); }
  }, 20 * 1000);
  setTimeout(reconcileJnPhotoCounts, 60 * 1000);
  setInterval(reconcileJnPhotoCounts, RECONCILE_INTERVAL_MS);
}

// Manual recount (e.g. after bulk JN photo deletions): ?full=1 recounts ALL
// jobs in place (no delete — no data gap), otherwise only unseeded jobs.
app.post('/admin/jn-photos/backfill', requireAuth, requireAdmin, async (req, res) => {
  if (jnPhotosBackfillRunning) return res.status(409).json({ error: 'Backfill already running', last: lastJnPhotosBackfill });
  backfillJnPhotoCounts(req.query.full === '1'); // runs in background
  res.status(202).json({ ok: true, started: true, full: req.query.full === '1' });
});
app.get('/admin/jn-photos/backfill', requireAuth, requireAdmin, (req, res) => {
  res.json({ running: jnPhotosBackfillRunning, last: lastJnPhotosBackfill });
});

// ── JobNimbus work-authorization status ──────────────────────────────────────
// Landed Mitigation/Contents/Rebuild jobs require a signed work authorization.
// JN's "Custom Documents" are `proposal` records: GET /proposals exposes
// signature_status ('Not Requested'|'Requested'|'Partially Signed'|'Fully
// Signed'), date_signed, and template_id — and signing bumps date_updated, so
// the same seed + reconcile machinery as jn_photo_counts applies (~110k
// proposals account-wide, ~500/day; median create→sign is ~2 min).
// `esigned`/`esign` on proposals are dead fields (zero true account-wide) —
// signature_status is the real state.
//
// ANY live custom document counts — no template gating (owner decision
// 2026-08-21). Template-name classification proved unreliable: offices sign
// differently-titled documents for the same purpose ("Work Authorization",
// "Mitigation Services Contract", "Construction/Remediation Contract", …),
// and the public API returns a NULL template_name, so every rule needed
// body-regex sampling and still missed variants. The jn_proposal_templates
// table is retired (kept in the DB, unread).
const WORKAUTH_RANK = { 'Not Requested': 1, 'Requested': 2, 'Partially Signed': 3, 'Fully Signed': 4 };

// One JN call per job: reduce its live proposals to the best signature status.
// "Best" = highest WORKAUTH_RANK — a job can carry several documents
// (re-issues); one fully signed one satisfies the requirement.
async function jnWorkauthForJob(jobJnId) {
  const fields = 'jnid,template_id,signature_status,date_signed,date_sign_requested,is_active,is_archived';
  const r = await fetch(`${JN_BASE}/proposals?size=100&related=${encodeURIComponent(jobJnId)}&fields=${fields}`, {
    headers: { Authorization: `bearer ${JN_TOKEN}`, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`JN /proposals related=${jobJnId} ${r.status}`);
  // Archived docs COUNT: JN bulk-archives documents after signing (verified
  // 2026-08-23 — signed WAs flip is_archived ~a day later, which made whole
  // offices read as 'Missing'). A Fully Signed doc proves the WA regardless.
  const props = ((await r.json())?.results ?? []).filter(p => p.jnid && p.is_active !== false);
  let best = null;
  for (const p of props) {
    if (!best || (WORKAUTH_RANK[p.signature_status] || 0) > (WORKAUTH_RANK[best.signature_status] || 0)) best = p;
  }
  if (!best) return { status: 'Missing', signed_at: null, requested_at: null, proposal_jnid: null };
  return {
    status: WORKAUTH_RANK[best.signature_status] ? best.signature_status : 'Not Requested',
    signed_at: best.date_signed ? new Date(best.date_signed * 1000).toISOString() : null,
    requested_at: best.date_sign_requested ? new Date(best.date_sign_requested * 1000).toISOString() : null,
    proposal_jnid: best.jnid,
  };
}

async function upsertJnWorkauth(rows) {
  const uniq = [...new Map(rows.map(r => [r.jn_id, r])).values()];
  for (let i = 0; i < uniq.length; i += 500) await sbBulkUpsert('jn_workauth', uniq.slice(i, i + 500));
  return uniq.length;
}

// Recheck a batch of jobs [{id, jn_id}] — same worker-pool shape as
// recountJobs; per-job errors are skipped so one flaky call can't sink a batch.
async function recheckWorkauthJobs(jobRows, tag) {
  const nowISO = new Date().toISOString();
  const out = [];
  let failed = 0, idx = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (idx < jobRows.length) {
      const job = jobRows[idx++];
      try {
        const wa = await jnWorkauthForJob(job.jn_id);
        out.push({ job_id: job.id, jn_id: job.jn_id, ...wa, last_synced: nowISO });
      } catch (err) {
        failed++;
        if (failed <= 3) console.error(`[${tag}] recheck failed for job ${job.jn_id}:`, err.message);
      }
    }
  }));
  return { rows: out, failed };
}

const JN_WORKAUTH_OVERLAP_MS = 2 * 60 * 60 * 1000;

let jnWorkauthReconcileRunning = false;
async function reconcileJnWorkauth() {
  if (jnWorkauthReconcileRunning) return;
  jnWorkauthReconcileRunning = true;
  try {
    // Empty table = backfill hasn't seeded yet — skip (the backfill covers all).
    const rows = await sbSelect('jn_workauth', 'select=last_synced&order=last_synced.desc.nullslast&limit=1');
    const last = rows?.[0]?.last_synced ? new Date(rows[0].last_synced).getTime() : NaN;
    if (isNaN(last)) { console.log('[jnworkauth-reconcile] table empty — waiting for backfill'); return; }
    const since = Math.max(Date.now() - RECONCILE_MAX_LOOKBACK_MS, last - JN_WORKAUTH_OVERLAP_MS);

    // fields keeps template_json (5-50KB each) out of the pull; date_updated
    // must stay in the list for jnFetchUpdatedSince's cursor.
    const props = await jnFetchUpdatedSince('/proposals', Math.floor(since / 1000), '&fields=jnid,related,date_updated');
    const touched = new Set();
    for (const p of props) {
      const ref = (Array.isArray(p.related) ? p.related : []).find(x => x && x.type === 'job' && x.id);
      if (ref) touched.add(String(ref.id));
    }
    const ids = [...touched];
    const jobRows = [];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100).map(id => `"${id}"`).join(',');
      jobRows.push(...await sbSelect('jobs', `jn_id=in.(${encodeURIComponent(chunk)})&select=id,jn_id`));
    }
    const { rows: waRows, failed } = await recheckWorkauthJobs(jobRows, 'jnworkauth-reconcile');
    await upsertJnWorkauth(waRows);
    console.log(`[jnworkauth-reconcile] ${props.length} changed proposals → rechecked ${waRows.length}/${jobRows.length} jobs${failed ? ` (${failed} failed)` : ''}`);
  } catch (err) {
    console.error('[jnworkauth-reconcile] failed:', err.message);
  } finally {
    jnWorkauthReconcileRunning = false;
  }
}

const WORKAUTH_RECORD_TYPES = '"Mitigation","Contents","Rebuild"';

// One-time backfill over Mitigation/Contents/Rebuild jobs (the types that
// require a WA). Resumable: jobs that already have a jn_workauth row are
// skipped unless force=true, which rechecks everything in place (no delete —
// no data gap).
let jnWorkauthBackfillRunning = false;
let lastJnWorkauthBackfill = null;

async function backfillJnWorkauth(force = false) {
  if (jnWorkauthBackfillRunning) return;
  jnWorkauthBackfillRunning = true;
  lastJnWorkauthBackfill = { phase: 'started', force, at: new Date().toISOString() };
  try {
    const have = new Set();
    if (!force) {
      for (let offset = 0; ; offset += 1000) {
        const page = await sbSelect('jn_workauth', `select=jn_id&order=jn_id&limit=1000&offset=${offset}`);
        page.forEach(r => have.add(r.jn_id));
        if (page.length < 1000) break;
      }
    }
    const todo = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await sbSelect('jobs', `select=id,jn_id&record_type=in.(${encodeURIComponent(WORKAUTH_RECORD_TYPES)})&order=jn_id&limit=1000&offset=${offset}`);
      todo.push(...page.filter(j => j.jn_id && !have.has(j.jn_id)));
      if (page.length < 1000) break;
    }
    console.log(`[jnworkauth-backfill] ${todo.length} jobs to check (${have.size} already done)`);
    let done = 0, failedTotal = 0;
    for (let i = 0; i < todo.length; i += 500) {
      const { rows, failed } = await recheckWorkauthJobs(todo.slice(i, i + 500), 'jnworkauth-backfill');
      await upsertJnWorkauth(rows);
      done += rows.length; failedTotal += failed;
      console.log(`[jnworkauth-backfill] progress ${done}/${todo.length}${failedTotal ? ` (${failedTotal} failed)` : ''}`);
      lastJnWorkauthBackfill = { phase: 'running', done, total: todo.length, failed: failedTotal, at: new Date().toISOString() };
    }
    console.log(`[jnworkauth-backfill] done — checked ${done} jobs${failedTotal ? `, ${failedTotal} failed` : ''}`);
    lastJnWorkauthBackfill = { phase: 'done', done, failed: failedTotal, at: new Date().toISOString() };
  } catch (err) {
    console.error('[jnworkauth-backfill] failed:', err.message);
    lastJnWorkauthBackfill = { phase: 'error', error: err.message, at: new Date().toISOString() };
  } finally {
    jnWorkauthBackfillRunning = false;
  }
}

// Boot: auto-backfill while coverage is clearly incomplete; reconcile no-ops on
// an empty table, so boot order isn't load-bearing.
if (SUPABASE_SERVICE_KEY) {
  setTimeout(async () => {
    try {
      const countOf = async (table, q = '') => {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=jn_id${q}&limit=1`, {
          method: 'HEAD', headers: { ...sbHeaders, Prefer: 'count=exact' },
        });
        return Number((r.headers.get('content-range') || '').split('/')[1] || 0);
      };
      const [checked, jobs] = await Promise.all([
        countOf('jn_workauth'),
        countOf('jobs', `&record_type=in.(${encodeURIComponent(WORKAUTH_RECORD_TYPES)})`),
      ]);
      if (jobs > 0 && checked / jobs < 0.9) backfillJnWorkauth();
      else console.log(`[jnworkauth-backfill] boot check: ${checked}/${jobs} jobs checked — skipping`);
    } catch (err) { console.error('[jnworkauth-backfill] boot check failed:', err.message); }
  }, 30 * 1000);
  setTimeout(reconcileJnWorkauth, 90 * 1000);
  setInterval(reconcileJnWorkauth, RECONCILE_INTERVAL_MS);
}

// Manual recheck: ?full=1 rechecks ALL M/C/R jobs in place (e.g. after fixing
// a template's is_workauth), otherwise only jobs without a row yet.
app.post('/admin/jn-workauth/backfill', requireAuth, requireAdmin, async (req, res) => {
  if (jnWorkauthBackfillRunning) return res.status(409).json({ error: 'Backfill already running', last: lastJnWorkauthBackfill });
  backfillJnWorkauth(req.query.full === '1'); // runs in background
  res.status(202).json({ ok: true, started: true, full: req.query.full === '1' });
});
app.get('/admin/jn-workauth/backfill', requireAuth, requireAdmin, (req, res) => {
  res.json({ running: jnWorkauthBackfillRunning, last: lastJnWorkauthBackfill });
});

// ── JobNimbus note counts (Pain Points notes metric) ─────────────────────────
// "Avg notes per In-Production job" needs a per-job count of JN notes; nothing
// queryable exists (the app's Activity tab reads JN live, the `notes` table is
// dead). Same seed + reconcile machinery as jn_photo_counts/jn_workauth, but
// SCOPED to active In-Production jobs — the only denominator the metric uses —
// so the backfill is a few hundred jobs, not 40k. Activities are JN's highest-
// volume stream, so the reconcile also restricts rechecks to touched jobs that
// are In Production or already cached, and a per-tick missing-row sweep seeds
// jobs that entered In Production with zero notes (no activity would ever
// touch them). Counting rules MUST mirror the Activity tab's filters in
// app/(app)/jobs/[id]/notes.tsx so numbers match what users see there.

const NOTES_HIDDEN_TYPES = new Set(['Job Modified', 'Attachment deleted', 'Task Created', 'Task Completed']);
const notesHiddenAuthor = (n) => { const s = (n || '').trim(); return !s || s === 'None' || s.startsWith('Automation'); };

// One job's visible activity, paged (busy jobs exceed one page), reduced to
// counts. note_count (record_type_name === 'Note') is the metric's primary;
// activity_count is stored alongside so switching later needs no re-seed.
async function jnNotesForJob(jobJnId) {
  const fields = 'jnid,record_type_name,created_by_name,date_created,is_active,is_archived';
  let noteCount = 0, activityCount = 0, lastNote = 0;
  for (let from = 0; from < 10000; from += 500) {
    const r = await fetch(`${JN_BASE}/activities?size=500&from=${from}&related=${encodeURIComponent(jobJnId)}&fields=${fields}`, {
      headers: { Authorization: `bearer ${JN_TOKEN}`, Accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`JN /activities related=${jobJnId} ${r.status}`);
    const data = await r.json();
    const page = data?.activity ?? data?.results ?? [];
    for (const a of page) {
      if (a.is_active === false || a.is_archived) continue;
      if (NOTES_HIDDEN_TYPES.has(a.record_type_name) || notesHiddenAuthor(a.created_by_name)) continue;
      activityCount++;
      if (a.record_type_name === 'Note') {
        noteCount++;
        if (typeof a.date_created === 'number' && a.date_created > lastNote) lastNote = a.date_created;
      }
    }
    if (page.length < 500) break;
  }
  return {
    note_count: noteCount,
    activity_count: activityCount,
    last_note_at: lastNote ? new Date(lastNote * 1000).toISOString() : null,
  };
}

async function upsertJnNoteCounts(rows) {
  const uniq = [...new Map(rows.map(r => [r.jn_id, r])).values()];
  for (let i = 0; i < uniq.length; i += 500) await sbBulkUpsert('jn_note_counts', uniq.slice(i, i + 500));
  return uniq.length;
}

// Recount a batch of jobs [{id, jn_id}] — the usual 4-worker pool; per-job
// errors are skipped so one flaky call can't sink a batch.
async function recheckNoteJobs(jobRows, tag) {
  const nowISO = new Date().toISOString();
  const out = [];
  let failed = 0, idx = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (idx < jobRows.length) {
      const job = jobRows[idx++];
      try {
        const counts = await jnNotesForJob(job.jn_id);
        out.push({ job_id: job.id, jn_id: job.jn_id, ...counts, last_synced: nowISO });
      } catch (err) {
        failed++;
        if (failed <= 3) console.error(`[${tag}] recheck failed for job ${job.jn_id}:`, err.message);
      }
    }
  }));
  return { rows: out, failed };
}

// All active In-Production jobs, paged.
async function inProductionJobs() {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await sbSelect('jobs', `select=id,jn_id&stage=eq.${encodeURIComponent('In Production')}&is_active=eq.true&order=jn_id&limit=1000&offset=${offset}`);
    out.push(...page.filter(j => j.jn_id));
    if (page.length < 1000) break;
  }
  return out;
}

const JN_NOTES_OVERLAP_MS = 2 * 60 * 60 * 1000;

let jnNotesReconcileRunning = false;
async function reconcileJnNoteCounts() {
  if (jnNotesReconcileRunning) return;
  jnNotesReconcileRunning = true;
  try {
    // Empty table = backfill hasn't seeded yet — skip (the backfill covers all).
    const rows = await sbSelect('jn_note_counts', 'select=last_synced&order=last_synced.desc.nullslast&limit=1');
    const last = rows?.[0]?.last_synced ? new Date(rows[0].last_synced).getTime() : NaN;
    if (isNaN(last)) { console.log('[jnnotes-reconcile] table empty — waiting for backfill'); return; }
    const since = Math.max(Date.now() - RECONCILE_MAX_LOOKBACK_MS, last - JN_NOTES_OVERLAP_MS);

    const acts = await jnFetchUpdatedSince('/activities', Math.floor(since / 1000), '&fields=jnid,related,date_updated');
    const touched = new Set();
    for (const a of acts) {
      const ref = (Array.isArray(a.related) ? a.related : []).find(x => x && x.type === 'job' && x.id);
      if (ref) touched.add(String(ref.id));
    }

    // Cached jn_ids: bound the recheck set AND drive the missing-row sweep.
    const cached = new Set();
    for (let offset = 0; ; offset += 1000) {
      const page = await sbSelect('jn_note_counts', `select=jn_id&order=jn_id&limit=1000&offset=${offset}`);
      page.forEach(r => cached.add(r.jn_id));
      if (page.length < 1000) break;
    }
    const inProd = await inProductionJobs();
    const inProdByJnId = new Map(inProd.map(j => [j.jn_id, j]));

    // Recheck = (touched ∩ (In Production ∪ cached)) ∪ (In Production \ cached).
    // The last term is the missing-row sweep: zero-note jobs never appear in
    // the activities pull, so they'd otherwise never get their 0-count row.
    const jobRows = [];
    const ids = [...touched].filter(id => !inProdByJnId.has(id) && cached.has(id));
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100).map(id => `"${id}"`).join(',');
      jobRows.push(...await sbSelect('jobs', `jn_id=in.(${encodeURIComponent(chunk)})&select=id,jn_id`));
    }
    for (const j of inProd) {
      if (touched.has(j.jn_id) || !cached.has(j.jn_id)) jobRows.push(j);
    }

    const { rows: countRows, failed } = await recheckNoteJobs(jobRows, 'jnnotes-reconcile');
    await upsertJnNoteCounts(countRows);
    console.log(`[jnnotes-reconcile] ${acts.length} changed activities → rechecked ${countRows.length}/${jobRows.length} jobs${failed ? ` (${failed} failed)` : ''}`);
  } catch (err) {
    console.error('[jnnotes-reconcile] failed:', err.message);
  } finally {
    jnNotesReconcileRunning = false;
  }
}

// Backfill: seed every active In-Production job. Resumable (jobs with a row
// are skipped unless force=true, which rechecks in place — no data gap).
let jnNotesBackfillRunning = false;
let lastJnNotesBackfill = null;

async function backfillJnNoteCounts(force = false) {
  if (jnNotesBackfillRunning) return;
  jnNotesBackfillRunning = true;
  lastJnNotesBackfill = { phase: 'started', force, at: new Date().toISOString() };
  try {
    const have = new Set();
    if (!force) {
      for (let offset = 0; ; offset += 1000) {
        const page = await sbSelect('jn_note_counts', `select=jn_id&order=jn_id&limit=1000&offset=${offset}`);
        page.forEach(r => have.add(r.jn_id));
        if (page.length < 1000) break;
      }
    }
    const todo = (await inProductionJobs()).filter(j => !have.has(j.jn_id));
    console.log(`[jnnotes-backfill] ${todo.length} jobs to count (${have.size} already done)`);
    let done = 0, failedTotal = 0;
    for (let i = 0; i < todo.length; i += 500) {
      const { rows, failed } = await recheckNoteJobs(todo.slice(i, i + 500), 'jnnotes-backfill');
      await upsertJnNoteCounts(rows);
      done += rows.length; failedTotal += failed;
      console.log(`[jnnotes-backfill] progress ${done}/${todo.length}${failedTotal ? ` (${failedTotal} failed)` : ''}`);
      lastJnNotesBackfill = { phase: 'running', done, total: todo.length, failed: failedTotal, at: new Date().toISOString() };
    }
    console.log(`[jnnotes-backfill] done — counted ${done} jobs${failedTotal ? `, ${failedTotal} failed` : ''}`);
    lastJnNotesBackfill = { phase: 'done', done, failed: failedTotal, at: new Date().toISOString() };
  } catch (err) {
    console.error('[jnnotes-backfill] failed:', err.message);
    lastJnNotesBackfill = { phase: 'error', error: err.message, at: new Date().toISOString() };
  } finally {
    jnNotesBackfillRunning = false;
  }
}

// Boot: backfill while coverage of the In-Production set is clearly incomplete.
// Reconcile no-ops on an empty table, so boot order isn't load-bearing. First
// tick staggered to 120s so it doesn't collide with the photos/workauth ticks.
if (SUPABASE_SERVICE_KEY) {
  setTimeout(async () => {
    try {
      const countOf = async (table, q = '') => {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=jn_id${q}&limit=1`, {
          method: 'HEAD', headers: { ...sbHeaders, Prefer: 'count=exact' },
        });
        return Number((r.headers.get('content-range') || '').split('/')[1] || 0);
      };
      const [counted, inProd] = await Promise.all([
        countOf('jn_note_counts'),
        countOf('jobs', `&stage=eq.${encodeURIComponent('In Production')}&is_active=eq.true`),
      ]);
      if (inProd > 0 && counted / inProd < 0.9) backfillJnNoteCounts();
      else console.log(`[jnnotes-backfill] boot check: ${counted} counted vs ${inProd} in production — skipping`);
    } catch (err) { console.error('[jnnotes-backfill] boot check failed:', err.message); }
  }, 40 * 1000);
  setTimeout(reconcileJnNoteCounts, 120 * 1000);
  setInterval(reconcileJnNoteCounts, RECONCILE_INTERVAL_MS);
}

// Manual recount: ?full=1 rechecks ALL In-Production jobs in place, otherwise
// only jobs without a row yet.
app.post('/admin/jn-note-counts/backfill', requireAuth, requireAdmin, async (req, res) => {
  if (jnNotesBackfillRunning) return res.status(409).json({ error: 'Backfill already running', last: lastJnNotesBackfill });
  backfillJnNoteCounts(req.query.full === '1'); // runs in background
  res.status(202).json({ ok: true, started: true, full: req.query.full === '1' });
});
app.get('/admin/jn-note-counts/backfill', requireAuth, requireAdmin, (req, res) => {
  res.json({ running: jnNotesBackfillRunning, last: lastJnNotesBackfill });
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
  const { email, role, location_id, location_name, full_name, app_role_id } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });

  try {
    // Custom app role: resolve its base_role (server-authoritative). The
    // invite metadata role is clamped by handle_new_user anyway; the trusted
    // path is the profile PATCH below, after the auth user exists.
    let inviteRole = role;
    let appRoleId = null;
    if (app_role_id) {
      const ar = await sbGet(`app_roles?id=eq.${encodeURIComponent(app_role_id)}&select=base_role`);
      const base = Array.isArray(ar) && ar[0] ? ar[0].base_role : null;
      if (!base) return res.status(400).json({ error: 'app_role_id not found' });
      inviteRole = base;
      appRoleId = app_role_id;
    }
    const r = await fetch(`${SUPABASE_URL}/auth/v1/invite`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        data: { role: inviteRole, location_id, location_name, full_name,
                location_ids: req.body.location_ids, location_names: req.body.location_names },
        redirect_to: WEB_APP_URL,
      }),
    });
    const body = await r.json();
    // handle_new_user clamps metadata roles; set the real role + bundle via
    // service key once the profile row exists (same statement → satisfies the
    // app-role consistency trigger).
    if (r.ok && appRoleId && body && body.id) {
      const pr = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${body.id}`, {
        method: 'PATCH',
        headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ role: inviteRole, app_role_id: appRoleId, updated_at: new Date().toISOString() }),
      });
      if (!pr.ok) {
        const t = await pr.text();
        console.error('[invite-user] app-role patch failed', pr.status, t.slice(0, 200));
        return res.status(502).json({ error: 'invite sent but custom role assignment failed', detail: t.slice(0, 200) });
      }
    }
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
  const { email, full_name, role, location_id, location_name, location_ids, location_names, app_role_id } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });
  const allowedRoles = ['owner', 'technician', 'technician_2', 'executive', 'admin'];
  let finalRole = allowedRoles.includes(role) ? role : 'technician';
  // Custom app role: server-authoritative — profiles.role is forced to the
  // bundle's base_role (the consistency trigger requires the pair to match).
  let appRoleId = null;
  if (app_role_id) {
    const ar = await sbGet(`app_roles?id=eq.${encodeURIComponent(app_role_id)}&select=base_role`);
    const base = Array.isArray(ar) && ar[0] ? ar[0].base_role : null;
    if (!base) return res.status(400).json({ error: 'app_role_id not found' });
    finalRole = base;
    appRoleId = app_role_id;
  }
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
      app_role_id: appRoleId,
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

// ── Admin user management (admin ONLY — requireStrictAdmin) ──────────────────
// GoTrue admin API helper (service key).
async function gotrueAdmin(method, path, body) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/${path}`, {
    method,
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch { /* empty body */ }
  return { ok: r.ok, status: r.status, body: json };
}

// Lifecycle endpoints must never act on the caller themselves or on admins.
// Sends the error response and returns false when the target is off-limits.
async function assertActionableTarget(req, res, targetId) {
  if (!targetId) { res.status(400).json({ error: 'user id required' }); return false; }
  if (targetId === req.userId) {
    res.status(400).json({ error: 'You cannot perform this action on your own account' });
    return false;
  }
  const rows = await sbGet(`profiles?id=eq.${encodeURIComponent(targetId)}&select=role`);
  const role = Array.isArray(rows) && rows[0] ? rows[0].role : null;
  if (role === 'admin') {
    res.status(403).json({ error: 'Admin accounts cannot be modified here' });
    return false;
  }
  return true;
}

// Rich user list: auth users (email, last sign-in, ban state) merged with
// profiles (name, role, custom app role, locations). lead_source portal
// accounts are excluded — they're managed from the Referrals screen.
app.get('/admin/users', requireAuth, requireStrictAdmin, async (req, res) => {
  try {
    const users = [];
    for (let page = 1; page <= 10; page++) {
      const { ok, body } = await gotrueAdmin('GET', `users?page=${page}&per_page=100`);
      if (!ok) return res.status(502).json({ error: 'failed to list auth users' });
      const batch = (body && body.users) || [];
      users.push(...batch);
      if (batch.length < 100) break;
    }
    const profiles = (await sbGet('profiles?select=id,full_name,role,app_role_id,location_id,location_name,location_ids,location_names')) || [];
    const byId = new Map(profiles.map(p => [p.id, p]));
    const now = Date.now();
    const out = [];
    for (const u of users) {
      const p = byId.get(u.id) || {};
      if (p.role === 'lead_source') continue;
      const banned = u.banned_until && new Date(u.banned_until).getTime() > now;
      const status = banned ? 'deactivated' : (u.invited_at && !u.last_sign_in_at ? 'invited' : 'active');
      out.push({
        id: u.id,
        email: u.email,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at || null,
        invited_at: u.invited_at || null,
        banned_until: banned ? u.banned_until : null,
        status,
        full_name: p.full_name || null,
        role: p.role || null,
        app_role_id: p.app_role_id || null,
        location_ids: (p.location_ids && p.location_ids.length)
          ? p.location_ids
          : (p.location_id ? [p.location_id] : []),
        location_names: (p.location_names && p.location_names.length)
          ? p.location_names
          : (p.location_name ? [p.location_name] : []),
      });
    }
    res.json({ users: out });
  } catch (err) {
    console.error('[admin users error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// Ban ≈ deactivate. Bans block new token issuance, not tokens already in the
// wild (≤1h) — the best-effort sessions delete closes live sessions where the
// GoTrue version supports it.
app.post('/admin/users/:id/deactivate', requireAuth, requireStrictAdmin, async (req, res) => {
  try {
    if (!(await assertActionableTarget(req, res, req.params.id))) return;
    const { ok, status, body } = await gotrueAdmin('PUT', `users/${req.params.id}`, { ban_duration: '87600h' });
    if (!ok) return res.status(status).json({ error: (body && (body.msg || body.message)) || 'deactivate failed' });
    try { await gotrueAdmin('DELETE', `users/${req.params.id}/sessions`); } catch { /* best effort */ }
    res.json({ ok: true });
  } catch (err) {
    console.error('[deactivate error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.post('/admin/users/:id/reactivate', requireAuth, requireStrictAdmin, async (req, res) => {
  try {
    if (!(await assertActionableTarget(req, res, req.params.id))) return;
    const { ok, status, body } = await gotrueAdmin('PUT', `users/${req.params.id}`, { ban_duration: 'none' });
    if (!ok) return res.status(status).json({ error: (body && (body.msg || body.message)) || 'reactivate failed' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[reactivate error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.delete('/admin/users/:id', requireAuth, requireStrictAdmin, async (req, res) => {
  try {
    if (!(await assertActionableTarget(req, res, req.params.id))) return;
    const { ok, status, body } = await gotrueAdmin('DELETE', `users/${req.params.id}`);
    if (!ok) return res.status(status).json({ error: (body && (body.msg || body.message)) || 'delete failed' });
    // profiles.id FK cascades from auth.users; defensive cleanup is idempotent.
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(req.params.id)}`, {
        method: 'DELETE',
        headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
      });
    } catch { /* cascade already handled it */ }
    res.json({ ok: true });
  } catch (err) {
    console.error('[delete user error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.post('/admin/users/:id/reset-password', requireAuth, requireStrictAdmin, async (req, res) => {
  try {
    if (!(await assertActionableTarget(req, res, req.params.id))) return;
    const tempPassword = genTempPassword();
    const { ok, status, body } = await gotrueAdmin('PUT', `users/${req.params.id}`, { password: tempPassword });
    if (!ok) return res.status(status).json({ error: (body && (body.msg || body.message)) || 'reset failed' });
    try { await gotrueAdmin('DELETE', `users/${req.params.id}/sessions`); } catch { /* best effort */ }
    res.json({ ok: true, temp_password: tempPassword });
  } catch (err) {
    console.error('[reset-password error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.post('/admin/users/:id/resend-invite', requireAuth, requireStrictAdmin, async (req, res) => {
  try {
    const { ok, body } = await gotrueAdmin('GET', `users/${req.params.id}`);
    if (!ok || !body || !body.email) return res.status(404).json({ error: 'user not found' });
    if (body.last_sign_in_at) return res.status(400).json({ error: 'User is already active — nothing to resend' });
    const r = await fetch(`${SUPABASE_URL}/auth/v1/invite`, {
      method: 'POST',
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: body.email, data: body.user_metadata || {}, redirect_to: WEB_APP_URL }),
    });
    const inv = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: inv.msg || inv.message || 'resend failed' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[resend-invite error]', err.message);
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

async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY || !EMAIL_FROM) {
    return { ok: false, error: 'Email not configured (set RESEND_API_KEY / EMAIL_FROM)' };
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, html }),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) return { ok: false, error: (j && j.message) || `Resend error ${r.status}` };
    return { ok: true, id: j && j.id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function inviteEmailHtml(name, locName, token) {
  const link = `${WEB_APP_URL}/referral?token=${token}`;
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1e293b">
  <h2 style="margin:0 0 16px">You're invited to a referral program</h2>
  <p style="line-height:1.5">Hi ${escapeHtml(name)},</p>
  <p style="line-height:1.5"><strong>${escapeHtml(locName)}</strong> has invited you to join their referral program. Tap below to sign up and start earning for the leads you send their way.</p>
  <p style="margin:28px 0"><a href="${link}" style="background:#2563eb;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;display:inline-block">Join the Referral Program</a></p>
  <p style="font-size:13px;color:#64748b;line-height:1.5">Or copy this link into your browser:<br>${link}</p>
</div>`;
}

// Channel pick: SMS whenever Twilio is configured and a phone exists (falls
// back to email if the send fails); email otherwise. Once Twilio's A2P
// campaign is approved and its env vars are set, invites switch back to SMS
// with no code change.
async function deliverInvite({ name, phone, email }, locName, token) {
  const smsReady = !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER);
  if (phone && smsReady) {
    const sms = await sendSms(phone, inviteSmsBody(name, locName, token));
    if (sms.ok) return { ok: true, channel: 'sms' };
    if (!email) return { ok: false, channel: 'sms', error: sms.error };
    console.warn('[lead-source invite] SMS failed, falling back to email:', sms.error);
  }
  if (email) {
    const em = await sendEmail(email,
      `${locName} invited you to their referral program`,
      inviteEmailHtml(name, locName, token));
    return em.ok ? { ok: true, channel: 'email' } : { ok: false, channel: 'email', error: em.error };
  }
  if (phone) {
    const sms = await sendSms(phone, inviteSmsBody(name, locName, token));
    return sms.ok ? { ok: true, channel: 'sms' } : { ok: false, channel: 'sms', error: sms.error };
  }
  return { ok: false, channel: 'none', error: 'Lead source has no phone or email' };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

app.post('/admin/lead-sources/invite', requireAuth, requireAdmin, async (req, res) => {
  const b = req.body || {};
  const { location_id, company_id, source_type, name } = b;
  if (!location_id || !company_id || !source_type || !name || !String(name).trim()) {
    return res.status(400).json({ error: 'location_id, company_id, source_type and name are required' });
  }
  if (!UUID_RE.test(String(company_id))) return res.status(400).json({ error: 'Invalid company id' });
  const rawPhone = String(b.phone || '').trim();
  const phone = rawPhone ? toE164(rawPhone) : null;
  if (rawPhone && !phone) return res.status(400).json({ error: 'Invalid phone number' });
  const email = String(b.email || '').trim().toLowerCase() || null;
  if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Invalid email address' });
  if (!phone && !email) return res.status(400).json({ error: 'A phone number or email is required' });
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
    email,
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
      if (cr.status === 409) return res.status(409).json({ error: 'A lead source with this phone or email already exists for this location' });
      const msg = (body && (body.message || body.error)) || 'create lead source failed';
      return res.status(cr.status).json({ error: msg });
    }
    const leadSource = Array.isArray(body) ? body[0] : body;

    const locs = await sbGet(`locations?id=eq.${encodeURIComponent(String(location_id))}&select=name`);
    const locName = (locs && locs[0] && locs[0].name) || 'A restoration company';
    const d = await deliverInvite(row, locName, inviteToken);
    if (!d.ok) console.warn('[lead-source invite] send failed:', d.error);
    // sms_sent/sms_error kept for older app builds that predate the email channel.
    return res.status(200).json({
      ok: true, lead_source: leadSource,
      invite_sent: d.ok, channel: d.channel,
      sms_sent: d.ok,
      ...(d.ok ? {} : { send_error: d.error, sms_error: d.error }),
    });
  } catch (err) {
    console.error('[lead-source invite error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.post('/admin/lead-sources/resend', requireAuth, requireAdmin, async (req, res) => {
  const id = String((req.body || {}).lead_source_id || '');
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid lead source id' });
  try {
    const rows = await sbGet(`lead_sources?id=eq.${id}&select=id,name,phone,email,location_id,status,invite_token,invite_count`);
    const ls = rows && rows[0];
    if (!ls) return res.status(404).json({ error: 'Lead source not found' });
    if (ls.status === 'signed_up') return res.status(400).json({ error: 'This lead source has already signed up' });

    let token = ls.invite_token;
    if (!token) token = crypto.randomBytes(24).toString('hex');
    const locs = await sbGet(`locations?id=eq.${encodeURIComponent(String(ls.location_id))}&select=name`);
    const locName = (locs && locs[0] && locs[0].name) || 'A restoration company';
    const d = await deliverInvite(ls, locName, token);
    if (!d.ok) return res.status(502).json({ error: d.error });

    const pr = await fetch(`${SUPABASE_URL}/rest/v1/lead_sources?id=eq.${id}`, {
      method: 'PATCH',
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ invite_token: token, last_invited_at: new Date().toISOString(),
        invite_count: (Number(ls.invite_count) || 0) + 1, updated_at: new Date().toISOString() }),
    });
    if (!pr.ok) console.warn('[lead-source resend] row update failed', pr.status);
    return res.status(200).json({ ok: true, sms_sent: true, invite_sent: true, channel: d.channel });
  } catch (err) {
    console.error('[lead-source resend error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── Lead source signup (PUBLIC — the invite token is the credential) ─────────
// The invite email/SMS links to {WEB_APP_URL}/referral?token=..., a public
// page in the web app. These endpoints back it: no Supabase auth, the
// 48-hex-char single-use-ish token scopes everything to one lead_sources row.

const INVITE_TOKEN_RE = /^[a-f0-9]{48}$/;

async function leadSourceByToken(token) {
  if (!INVITE_TOKEN_RE.test(token)) return null;
  const rows = await sbGet(
    `lead_sources?invite_token=eq.${token}&select=id,user_id,name,phone,email,source_type,status,` +
    `split_by_payer,referral_basis,referral_rate,ins_basis,ins_rate,oop_basis,oop_rate,` +
    `percent_scope,location_id,lead_source_companies(name,address)`);
  return (rows && rows[0]) || null;
}

app.get('/referral/info', async (req, res) => {
  try {
    const ls = await leadSourceByToken(String(req.query.token || '').trim());
    if (!ls) return res.status(404).json({ error: 'This invite link is invalid or has expired.' });
    const locs = await sbGet(`locations?id=eq.${encodeURIComponent(String(ls.location_id))}&select=name`);
    return res.json({
      name: ls.name,
      phone: ls.phone,
      email: ls.email,
      source_type: ls.source_type,
      status: ls.status,
      has_account: !!ls.user_id,
      split_by_payer: ls.split_by_payer,
      referral_basis: ls.referral_basis, referral_rate: ls.referral_rate,
      ins_basis: ls.ins_basis, ins_rate: ls.ins_rate,
      oop_basis: ls.oop_basis, oop_rate: ls.oop_rate,
      percent_scope: ls.percent_scope,
      company_name: (ls.lead_source_companies && ls.lead_source_companies.name) || null,
      company_address: (ls.lead_source_companies && ls.lead_source_companies.address) || null,
      location_name: (locs && locs[0] && locs[0].name) || 'A restoration company',
    });
  } catch (err) {
    console.error('[referral info error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.post('/referral/signup', async (req, res) => {
  const b = req.body || {};
  try {
    const ls = await leadSourceByToken(String(b.token || '').trim());
    if (!ls) return res.status(404).json({ error: 'This invite link is invalid or has expired.' });
    if (ls.status === 'signed_up') return res.status(200).json({ ok: true, already_signed_up: true });

    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const rawPhone = String(b.phone || '').trim();
    const phone = rawPhone ? toE164(rawPhone) : null;
    if (rawPhone && !phone) return res.status(400).json({ error: 'Invalid phone number' });
    const email = String(b.email || '').trim().toLowerCase() || null;
    if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Invalid email address' });
    if (!phone && !email) return res.status(400).json({ error: 'A phone number or email is required' });

    const now = new Date().toISOString();
    const pr = await fetch(`${SUPABASE_URL}/rest/v1/lead_sources?id=eq.${ls.id}`, {
      method: 'PATCH',
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ name, phone, email, status: 'signed_up', signed_up_at: now, updated_at: now }),
    });
    if (!pr.ok) {
      if (pr.status === 409) return res.status(409).json({ error: 'That phone or email is already registered with this company.' });
      const body = await pr.json().catch(() => null);
      return res.status(pr.status).json({ error: (body && (body.message || body.error)) || 'Signup failed' });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[referral signup error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── Lead source PORTAL ───────────────────────────────────────────────────────
// Partners get Supabase auth accounts with profiles.role='lead_source' — a
// role in NO RLS allow-list (plus a blanket restrictive deny policy), so they
// can read nothing via PostgREST. Everything below serves them via the service
// key, strictly scoped to their own lead_sources row.

function encField(plain, aad) {
  const key = LEAD_ENC_KEYS[LEAD_ENC_CURRENT];
  if (!key) throw new Error('encryption key not configured');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [LEAD_ENC_CURRENT, iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}
function decField(stored, aad) {
  const [v, iv, tag, ct] = String(stored).split(':');
  const key = LEAD_ENC_KEYS[v];
  if (!key) throw new Error(`unknown encryption key version ${v}`);
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

// ABA routing checksum: 3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9) ≡ 0 (mod 10).
function isValidRouting(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length !== 9) return false;
  const n = d.split('').map(Number);
  return (3 * (n[0] + n[3] + n[6]) + 7 * (n[1] + n[4] + n[7]) + (n[2] + n[5] + n[8])) % 10 === 0;
}

const W9_TAX_CLASSES = [
  'Individual/sole proprietor', 'C corporation', 'S corporation',
  'Partnership', 'Trust/estate', 'LLC', 'Other',
];

// requireAuth must run first. Positive-only 60s cache keyed by userId.
const LS_CACHE_TTL_MS = 60 * 1000;
const LS_CACHE_MAX = 500;
const leadSourceCache = new Map();
async function requireLeadSource(req, res, next) {
  const cached = leadSourceCache.get(req.userId);
  if (cached && cached.expiresAt > Date.now()) { req.leadSource = cached.row; return next(); }
  leadSourceCache.delete(req.userId);
  try {
    const rows = await sbGet(
      `lead_sources?user_id=eq.${req.userId}&status=eq.signed_up` +
      `&select=id,name,email,phone,location_id,company_id,source_type,split_by_payer,` +
      `referral_basis,referral_rate,ins_basis,ins_rate,oop_basis,oop_rate,percent_scope,` +
      `w9_legal_name,w9_business_name,w9_tax_class,w9_tin_type,w9_tin_last4,w9_certified_at`);
    const ls = rows && rows[0];
    if (!ls) return res.status(403).json({ error: 'Portal access required' });
    // Belt-and-braces: the profile must actually carry the portal role.
    const prof = await sbGet(`profiles?id=eq.${req.userId}&select=role`);
    if (!prof || !prof[0] || prof[0].role !== 'lead_source') {
      return res.status(403).json({ error: 'Portal access required' });
    }
    if (leadSourceCache.size >= LS_CACHE_MAX) {
      leadSourceCache.delete(leadSourceCache.keys().next().value);
    }
    leadSourceCache.set(req.userId, { row: ls, expiresAt: Date.now() + LS_CACHE_TTL_MS });
    req.leadSource = ls;
    next();
  } catch (err) {
    console.error('[lead-source auth error]', err.message);
    res.status(502).json({ error: 'Verification failed' });
  }
}

async function sbAdmin(method, path, body, prefer) {
  const r = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const j = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, body: j };
}

// Full signup: contact + W-9 + bank + password → provisions the account.
// Public, invite-token-gated. Old signed-up rows without an account can also
// complete this (their token was never nulled).
app.post('/portal/signup', async (req, res) => {
  const b = req.body || {};
  if (!LEAD_ENC_KEYS[LEAD_ENC_CURRENT]) {
    return res.status(503).json({ error: 'Portal signup is not configured yet (encryption key missing).' });
  }
  try {
    const ls = await leadSourceByToken(String(b.token || '').trim());
    if (!ls) return res.status(404).json({ error: 'This invite link is invalid or has expired.' });
    const linked = await sbGet(`lead_sources?id=eq.${ls.id}&select=user_id`);
    if (linked && linked[0] && linked[0].user_id) {
      return res.status(409).json({ error: 'This invite already has an account — log in instead.' });
    }

    // Contact
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const email = String(b.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid email is required (it becomes your login).' });
    const rawPhone = String(b.phone || '').trim();
    const phone = rawPhone ? toE164(rawPhone) : null;
    if (rawPhone && !phone) return res.status(400).json({ error: 'Invalid phone number' });

    // W-9
    const w9 = b.w9 || {};
    const legalName = String(w9.legal_name || '').trim();
    const taxClass = String(w9.tax_class || '').trim();
    const w9Address = String(w9.address || '').trim();
    const tinType = w9.tin_type === 'ein' ? 'ein' : 'ssn';
    const tin = String(w9.tin || '').replace(/\D/g, '');
    const signature = String(w9.signature || '').trim();
    if (!legalName) return res.status(400).json({ error: 'W-9: legal name is required' });
    if (!W9_TAX_CLASSES.includes(taxClass)) return res.status(400).json({ error: 'W-9: pick a federal tax classification' });
    if (!w9Address) return res.status(400).json({ error: 'W-9: address is required' });
    if (tin.length !== 9) return res.status(400).json({ error: `W-9: ${tinType === 'ein' ? 'EIN' : 'SSN'} must be 9 digits` });
    if (!signature) return res.status(400).json({ error: 'W-9: type your name to sign' });
    if (!w9.certified) return res.status(400).json({ error: 'W-9: the certification must be accepted' });

    // Bank
    const bank = b.bank || {};
    const routing = String(bank.routing || '').replace(/\D/g, '');
    const account = String(bank.account || '').replace(/\D/g, '');
    const acctType = bank.account_type === 'savings' ? 'savings' : 'checking';
    const bankName = String(bank.bank_name || '').trim() || null;
    if (!isValidRouting(routing)) return res.status(400).json({ error: 'Bank: routing number is not a valid 9-digit ABA number' });
    if (account.length < 4 || account.length > 17) return res.status(400).json({ error: 'Bank: account number must be 4–17 digits' });

    // Password
    const password = String(b.password || '');
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    // 1) Create the auth user (handle_new_user auto-creates a technician profile).
    const created = await sbAdmin('POST', '/auth/v1/admin/users', {
      email, password, email_confirm: true, user_metadata: { full_name: name },
    });
    if (!created.ok) {
      const msg = (created.body && (created.body.msg || created.body.message || created.body.error_description)) || '';
      if (created.status === 422 || /already/i.test(msg)) {
        return res.status(409).json({ error: 'An account with this email already exists — log in instead.' });
      }
      return res.status(502).json({ error: msg || 'Account creation failed' });
    }
    const uid = created.body && created.body.id;
    const rollback = async () => {
      await sbAdmin('DELETE', `/auth/v1/admin/users/${uid}`).catch(() => {});
      await sbAdmin('DELETE', `/rest/v1/lead_source_secure?lead_source_id=eq.${ls.id}`).catch(() => {});
      leadSourceCache.delete(uid);
    };

    // 2) Force the portal role + zero locations, then VERIFY it landed.
    const prof = await sbAdmin('POST', '/rest/v1/profiles?on_conflict=id', {
      id: uid, full_name: name, role: 'lead_source',
      location_id: null, location_name: null, location_ids: [], location_names: [],
    }, 'resolution=merge-duplicates,return=representation');
    const landedRole = prof.ok && Array.isArray(prof.body) && prof.body[0] && prof.body[0].role;
    if (landedRole !== 'lead_source') {
      console.error('[portal signup] role verification failed', prof.status, JSON.stringify(prof.body || {}).slice(0, 200));
      await rollback();
      return res.status(502).json({ error: 'Account provisioning failed — nothing was created, please try again.' });
    }

    // 3) Encrypted secrets.
    const sec = await sbAdmin('POST', '/rest/v1/lead_source_secure?on_conflict=lead_source_id', {
      lead_source_id: ls.id,
      tin_enc: encField(tin, `${ls.id}:tin`),
      bank_routing_enc: encField(routing, `${ls.id}:bank_routing`),
      bank_account_enc: encField(account, `${ls.id}:bank_account`),
      bank_account_last4: account.slice(-4),
      bank_account_type: acctType,
      bank_name: bankName,
      updated_at: new Date().toISOString(),
    }, 'resolution=merge-duplicates,return=minimal');
    if (!sec.ok) {
      console.error('[portal signup] secure upsert failed', sec.status);
      await rollback();
      return res.status(502).json({ error: 'Account provisioning failed — nothing was created, please try again.' });
    }

    // 4) Commit: link the account, store W-9 metadata, spend the token.
    const now = new Date().toISOString();
    const fin = await sbAdmin('PATCH', `/rest/v1/lead_sources?id=eq.${ls.id}`, {
      name, phone, email,
      user_id: uid, invite_token: null,
      status: 'signed_up', signed_up_at: ls.status === 'signed_up' ? undefined : now,
      w9_legal_name: legalName,
      w9_business_name: String(w9.business_name || '').trim() || null,
      w9_tax_class: taxClass,
      w9_address: w9Address,
      w9_tin_type: tinType,
      w9_tin_last4: tin.slice(-4),
      w9_signature: signature,
      w9_certified_at: now,
      updated_at: now,
    }, 'return=minimal');
    if (!fin.ok) {
      console.error('[portal signup] lead_sources link failed', fin.status);
      await rollback();
      return res.status(502).json({ error: 'Account provisioning failed — nothing was created, please try again.' });
    }

    return res.status(200).json({ ok: true, email });
  } catch (err) {
    console.error('[portal signup error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// Simplified job status for partners — no internal stage taxonomy leaks.
function partnerJobStatus(stage) {
  if (stage === 'Lost') return 'Lost';
  if (stage === 'Completed') return 'Complete';
  return 'In progress';
}

app.get('/portal/me', requireAuth, requireLeadSource, async (req, res) => {
  try {
    const ls = req.leadSource;
    const [locs, cos, secs] = await Promise.all([
      sbGet(`locations?id=eq.${encodeURIComponent(String(ls.location_id))}&select=name`),
      ls.company_id ? sbGet(`lead_source_companies?id=eq.${ls.company_id}&select=name`) : Promise.resolve([]),
      sbGet(`lead_source_secure?lead_source_id=eq.${ls.id}&select=bank_name,bank_account_type,bank_account_last4`),
    ]);
    const sec = (secs && secs[0]) || null;
    res.json({
      name: ls.name, email: ls.email, phone: ls.phone,
      source_type: ls.source_type,
      company_name: (cos && cos[0] && cos[0].name) || null,
      location_name: (locs && locs[0] && locs[0].name) || 'A restoration company',
      split_by_payer: ls.split_by_payer,
      referral_basis: ls.referral_basis, referral_rate: ls.referral_rate,
      ins_basis: ls.ins_basis, ins_rate: ls.ins_rate,
      oop_basis: ls.oop_basis, oop_rate: ls.oop_rate,
      percent_scope: ls.percent_scope,
      w9: ls.w9_certified_at ? {
        legal_name: ls.w9_legal_name, tax_class: ls.w9_tax_class,
        tin_type: ls.w9_tin_type, tin_last4: ls.w9_tin_last4,
        certified_at: ls.w9_certified_at,
      } : null,
      bank: sec && sec.bank_account_last4 ? {
        bank_name: sec.bank_name, account_type: sec.bank_account_type,
        account_last4: sec.bank_account_last4,
      } : null,
    });
  } catch (err) {
    console.error('[portal me error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/portal/leads', requireAuth, requireLeadSource, async (req, res) => {
  try {
    const [jobs, payouts] = await Promise.all([
      sbGet(`jobs?lead_source_id=eq.${req.leadSource.id}&select=id,client_name,created_at,date_start,stage&order=created_at.desc&limit=200`),
      sbGet(`lead_source_payouts?lead_source_id=eq.${req.leadSource.id}&select=job_id,amount,status,paid_at`),
    ]);
    const payoutByJob = new Map();
    for (const p of payouts || []) if (p.job_id) payoutByJob.set(p.job_id, p);
    res.json({
      leads: (jobs || []).map(j => {
        const p = payoutByJob.get(j.id);
        return {
          id: j.id,
          client_name: j.client_name,
          date: j.date_start || j.created_at,
          status: partnerJobStatus(j.stage),
          payout: p ? { amount: Number(p.amount), status: p.status, paid_at: p.paid_at } : null,
        };
      }),
    });
  } catch (err) {
    console.error('[portal leads error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/portal/payouts', requireAuth, requireLeadSource, async (req, res) => {
  try {
    const rows = await sbGet(
      `lead_source_payouts?lead_source_id=eq.${req.leadSource.id}` +
      `&select=id,amount,status,paid_at,note,created_at,jobs(client_name)&order=created_at.desc&limit=500`);
    res.json({
      payouts: (rows || []).map(p => ({
        id: p.id, amount: Number(p.amount), status: p.status, paid_at: p.paid_at,
        note: p.note, created_at: p.created_at,
        client_name: (p.jobs && p.jobs.client_name) || null,
      })),
    });
  } catch (err) {
    console.error('[portal payouts error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.post('/portal/bank', requireAuth, requireLeadSource, async (req, res) => {
  if (!LEAD_ENC_KEYS[LEAD_ENC_CURRENT]) return res.status(503).json({ error: 'Not configured' });
  const b = req.body || {};
  const routing = String(b.routing || '').replace(/\D/g, '');
  const account = String(b.account || '').replace(/\D/g, '');
  const acctType = b.account_type === 'savings' ? 'savings' : 'checking';
  const bankName = String(b.bank_name || '').trim() || null;
  if (!isValidRouting(routing)) return res.status(400).json({ error: 'Routing number is not a valid 9-digit ABA number' });
  if (account.length < 4 || account.length > 17) return res.status(400).json({ error: 'Account number must be 4–17 digits' });
  try {
    const lsId = req.leadSource.id;
    const r = await sbAdmin('POST', '/rest/v1/lead_source_secure?on_conflict=lead_source_id', {
      lead_source_id: lsId,
      bank_routing_enc: encField(routing, `${lsId}:bank_routing`),
      bank_account_enc: encField(account, `${lsId}:bank_account`),
      bank_account_last4: account.slice(-4),
      bank_account_type: acctType,
      bank_name: bankName,
      updated_at: new Date().toISOString(),
    }, 'resolution=merge-duplicates,return=minimal');
    if (!r.ok) return res.status(502).json({ error: 'Could not save bank details' });
    res.json({ ok: true, bank: { bank_name: bankName, account_type: acctType, account_last4: account.slice(-4) } });
  } catch (err) {
    console.error('[portal bank error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// Owner-side reveal for manual ACH entry. Admin: any; owner: own locations only.
// Every reveal is audited. Values are returned once and never logged.
app.post('/admin/lead-sources/bank-reveal', requireAuth, requireAdmin, async (req, res) => {
  const id = String((req.body || {}).lead_source_id || '');
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid lead source id' });
  try {
    const lsRows = await sbGet(`lead_sources?id=eq.${id}&select=id,location_id`);
    const ls = lsRows && lsRows[0];
    if (!ls) return res.status(404).json({ error: 'Lead source not found' });
    const prof = await sbGet(`profiles?id=eq.${req.userId}&select=role,location_id,location_ids`);
    const p = prof && prof[0];
    if (p && p.role === 'owner') {
      const mine = (p.location_ids && p.location_ids.length ? p.location_ids : [p.location_id]).filter(Boolean);
      if (!mine.includes(ls.location_id)) return res.status(403).json({ error: 'Not your location' });
    }
    const secs = await sbGet(`lead_source_secure?lead_source_id=eq.${id}&select=bank_routing_enc,bank_account_enc,bank_name,bank_account_type`);
    const sec = secs && secs[0];
    if (!sec || !sec.bank_routing_enc || !sec.bank_account_enc) {
      return res.status(404).json({ error: 'No bank details on file' });
    }
    await sbAdmin('POST', '/rest/v1/bank_reveal_audit', {
      lead_source_id: id, revealed_by: req.userId,
    }, 'return=minimal');
    res.json({
      routing_number: decField(sec.bank_routing_enc, `${id}:bank_routing`),
      account_number: decField(sec.bank_account_enc, `${id}:bank_account`),
      bank_name: sec.bank_name, account_type: sec.bank_account_type,
    });
  } catch (err) {
    console.error('[bank reveal error]', err.message);
    res.status(502).json({ error: 'Reveal failed' });
  }
});

// Google Places address autocomplete, proxied so the Maps key stays server-side.
// Used by the app's address fields (e.g. new lead-source company). Same
// admin/owner gating as the rest of /admin. Requires the "Places API" to be
// enabled on the GOOGLE_MAPS_KEY project (Geocoding alone is not enough).
app.get('/admin/places/autocomplete', requireAuth, requireAdmin, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 3) return res.json({ predictions: [] });
  if (!GOOGLE_MAPS_KEY) return res.json({ predictions: [], error: 'Maps key not configured' });
  try {
    const params = new URLSearchParams({
      input: q.slice(0, 200),
      key: GOOGLE_MAPS_KEY,
      types: 'address',
      components: 'country:us',
    });
    // Session token groups the keystrokes of one lookup for Google's billing.
    const session = String(req.query.session || '').slice(0, 64);
    if (session) params.set('sessiontoken', session);
    const r = await fetch(`https://maps.googleapis.com/maps/api/place/autocomplete/json?${params}`);
    const d = await r.json().catch(() => null);
    if (!d || (d.status !== 'OK' && d.status !== 'ZERO_RESULTS')) {
      console.warn('[places autocomplete] status', d && d.status, (d && d.error_message) || '');
      return res.json({ predictions: [] }); // degrade to manual typing
    }
    return res.json({
      predictions: (d.predictions || []).slice(0, 5).map(p => ({
        description: p.description,
        place_id: p.place_id,
      })),
    });
  } catch (err) {
    console.error('[places autocomplete error]', err.message);
    return res.json({ predictions: [] });
  }
});

// Place Details for a picked autocomplete suggestion — returns the address
// broken into components so the app can fill street/city/state/zip fields.
// Passing the same session token as the autocomplete calls closes the billing
// session (Google charges per session, not per keystroke, when tokens match).
app.get('/admin/places/details', requireAuth, requireAdmin, async (req, res) => {
  const placeId = String(req.query.place_id || '').trim();
  if (!placeId || !GOOGLE_MAPS_KEY) return res.json({});
  try {
    const params = new URLSearchParams({
      place_id: placeId,
      key: GOOGLE_MAPS_KEY,
      fields: 'address_component,formatted_address',
    });
    const session = String(req.query.session || '').slice(0, 64);
    if (session) params.set('sessiontoken', session);
    const r = await fetch(`https://maps.googleapis.com/maps/api/place/details/json?${params}`);
    const d = await r.json().catch(() => null);
    if (!d || d.status !== 'OK') {
      console.warn('[places details] status', d && d.status, (d && d.error_message) || '');
      return res.json({});
    }
    const comps = (d.result && d.result.address_components) || [];
    const comp = (type, short) => {
      const c = comps.find(c => c.types.includes(type));
      return c ? (short ? c.short_name : c.long_name) : '';
    };
    return res.json({
      street: [comp('street_number'), comp('route')].filter(Boolean).join(' '),
      city: comp('locality') || comp('sublocality') || comp('postal_town'),
      state: comp('administrative_area_level_1', true),
      zip: comp('postal_code'),
      formatted: d.result.formatted_address || '',
    });
  } catch (err) {
    console.error('[places details error]', err.message);
    return res.json({});
  }
});

// ── JobNimbus photo report (Work Complete → PDF → job Files) ─────────────────
// A JobNimbus automation fires POST /webhooks/jobnimbus/photo-report?token=…
// whenever a job's status changes to Work Complete. We then:
//   1. pull the job, its primary contact, and every image file on the job;
//   2. render a "<Record Type> Photo Report" PDF — brand logo + claim/contact
//      header (matches the manual report layout), photos oldest-first, two
//      per row (no captions, per owner);
//   3. upload the PDF(s) back onto the job's JN Files (related=[job jnid] —
//      JN's /files POST wants related as an ARRAY OF JNID STRINGS, not
//      {id,type} objects; the object form errors "invalid document").
// Reports must be emailable: photos are recompressed (sharp, ≤1400px JPEG
// q72) and the report splits into "Part N of M" documents so no single PDF
// exceeds ~18MB (owner requirement: stay under the 20MB email cap).
// Re-fires are deliberate: every Work Complete transition uploads a fresh
// report (owner decision 2026-08-25) — date-stamped filenames disambiguate.
const PDFDocument = require('pdfkit');
const sharp = require('sharp');

const PHOTO_REPORT_MAX_PDF_BYTES = 17 * 1024 * 1024; // actual PDFs land ~2% over this estimate — 17MB keeps them safely under the 20MB email cap
const PHOTO_REPORT_MAX_PHOTOS = 200; // JN /files page cap — same as jn_photo_counts

// Franchise name before the territory suffix — port of the app's
// lib/logos.ts brandOf(); keep the two in sync.
function brandOfLocationName(name) {
  let n = String(name || '').trim();
  const cutters = [' of ', ' - ', ' – ', ' ('];
  let idx = -1;
  for (const c of cutters) {
    const i = n.indexOf(c);
    if (i > 0 && (idx === -1 || i < idx)) idx = i;
  }
  if (idx > 0) n = n.slice(0, idx);
  return n.replace(/,?\s+(LLC\.?|Inc\.?)$/i, '').replace(/[,.]+$/, '').trim();
}

// Logo bytes for the job's location: per-location logo_url wins, then the
// brand pack's full → light → icon variants (mirrors lib/logos.ts
// resolveLogo). Normalized to PNG so pdfkit can embed any source format.
async function photoReportLogoForJob(jobJnId) {
  try {
    if (!SUPABASE_SERVICE_KEY) return null;
    const jobs = await sbSelect('jobs', `jn_id=eq.${encodeURIComponent(jobJnId)}&select=location_id&limit=1`);
    const locId = jobs && jobs[0] && jobs[0].location_id;
    if (!locId) return null;
    const locs = await sbSelect('locations', `id=eq.${locId}&select=name,logo_url&limit=1`);
    const loc = locs && locs[0];
    if (!loc) return null;
    let url = loc.logo_url || null;
    if (!url) {
      const rows = await sbSelect('brand_logos', `brand=eq.${encodeURIComponent(brandOfLocationName(loc.name))}&select=variant,url`);
      const by = Object.fromEntries((rows || []).map(r => [r.variant, r.url]));
      url = by.full || by.light || by.icon || null;
    }
    if (!url) return null;
    const r = await fetch(url);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return await sharp(buf).resize({ width: 400, withoutEnlargement: true }).png().toBuffer();
  } catch (err) {
    console.warn('[photo-report] logo unavailable:', err.message);
    return null;
  }
}

async function jnGetJobFull(jnid) {
  const r = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(jnid)}`, {
    headers: { Authorization: `bearer ${JN_TOKEN}`, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`JN /jobs/${jnid} ${r.status}`);
  return r.json();
}

async function jnGetContactFull(contactId) {
  const r = await fetch(`${JN_BASE}/contacts/${encodeURIComponent(contactId)}`, {
    headers: { Authorization: `bearer ${JN_TOKEN}`, Accept: 'application/json' },
  });
  if (!r.ok) return null;
  return r.json();
}

// Every image file on the job, oldest first — the same listing files.tsx and
// jnCountFilesForJob use, so the report matches the app's Files tab.
async function jnListJobImages(jobJnId) {
  const r = await fetch(`${JN_BASE}/files?size=${PHOTO_REPORT_MAX_PHOTOS}&related=${encodeURIComponent(jobJnId)}`, {
    headers: { Authorization: `bearer ${JN_TOKEN}`, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`JN /files related=${jobJnId} ${r.status}`);
  const files = (((await r.json()) || {}).files || []).filter(f => (f.jnid || f.id) && isJnImage(f));
  files.sort((a, b) => (a.date_created || 0) - (b.date_created || 0));
  return files;
}

async function jnDownloadFile(fileJnId) {
  const r = await fetch(`${JN_BASE}/files/${encodeURIComponent(fileJnId)}`, {
    headers: { Authorization: `bearer ${JN_TOKEN}` },
  });
  if (!r.ok) throw new Error(`JN file ${fileJnId} ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function jnUploadFile(jobJnId, filename, buf, description) {
  const r = await fetch(`${JN_BASE}/files`, {
    method: 'POST',
    headers: { Authorization: `bearer ${JN_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ data: buf.toString('base64'), filename, description, related: [jobJnId] }),
  });
  if (!r.ok) throw new Error(`JN files upload ${r.status} ${(await r.text()).slice(0, 200)}`);
  return ((await r.json()) || {}).jnid || null;
}

// "6/12/2026 3:02 PM CST" — Central time like the manual report template.
function fmtCentral(unixSecs) {
  if (!unixSecs) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', month: 'numeric', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
  }).format(new Date(unixSecs * 1000)).replace(',', '');
}

// One report document. Header (logo | claim/date/rep | name+address), centered
// title, then photos two per row: one row on the title page, two per page
// after. No captions under photos (owner request 2026-08-25).
function renderPhotoReportPdf(header, photos) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 36, autoFirstPage: false });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const M = 36, PAGE_W = 612, PAGE_H = 792, W = PAGE_W - 2 * M;
    const COL_W = 258, X_L = M, X_R = PAGE_W - M - COL_W;
    const IMG_H = 300, ROW_H = IMG_H + 6; // no captions (owner request 2026-08-25)

    const INK = '#1a1a1a', MUTED = '#6b7076', RULE = '#d8dadd';

    doc.addPage();
    // Top band: logo left, customer identity right-aligned.
    if (header.logoBuf) { try { doc.image(header.logoBuf, M, 40, { fit: [150, 58] }); } catch (e) { /* bad logo bytes — render without */ } }
    doc.font('Helvetica-Bold').fontSize(12).fillColor(INK)
      .text(header.name || '', 306, 44, { width: 270, align: 'right' });
    doc.font('Helvetica').fontSize(9).fillColor(MUTED);
    let ry = 60;
    if (header.addr1) { doc.text(header.addr1, 306, ry, { width: 270, align: 'right' }); ry += 13; }
    if (header.addr2) doc.text(header.addr2, 306, ry, { width: 270, align: 'right' });

    // Info band: label/value columns between two hairline rules.
    doc.moveTo(M, 114).lineTo(PAGE_W - M, 114).lineWidth(0.7).strokeColor(RULE).stroke();
    const fields = [
      ['CLAIM NUMBER', header.claim],
      ['INSURANCE', header.insurer],
      ['DATE CONTACTED', header.dateContacted],
      ['SALES REP', header.salesRep],
    ].filter(([, v]) => v);
    if (fields.length) {
      const colW = W / fields.length;
      fields.forEach(([label, value], i) => {
        const x = M + i * colW;
        doc.font('Helvetica-Bold').fontSize(6.5).fillColor(MUTED)
          .text(label, x, 124, { width: colW - 10, characterSpacing: 0.8 });
        doc.font('Helvetica').fontSize(9.5).fillColor(INK)
          .text(String(value), x, 135, { width: colW - 10 });
      });
    }
    doc.moveTo(M, 156).lineTo(PAGE_W - M, 156).lineWidth(0.7).strokeColor(RULE).stroke();

    doc.font('Helvetica-Bold').fontSize(14).fillColor(INK)
      .text(header.title, M, 174, { width: W, align: 'center', characterSpacing: 0.3 });

    let y = 206;
    for (let i = 0; i < photos.length; i += 2) {
      if (y + ROW_H > PAGE_H - M) { doc.addPage(); y = 40; }
      photos.slice(i, i + 2).forEach((p, k) => {
        const x = k === 0 ? X_L : X_R;
        try {
          doc.image(p.buf, x, y, { fit: [COL_W, IMG_H] });
        } catch (e) {
          doc.font('Helvetica').fontSize(9).text(`[photo failed to embed: ${p.caption}]`, x, y, { width: COL_W });
        }
      });
      y += ROW_H + 12;
    }
    doc.end();
  });
}

// Full pipeline for one job. dryrun writes PDFs to os.tmpdir() instead of
// uploading (hit the webhook with ?dryrun=1&force=1 to preview a job).
async function generatePhotoReport(jobJnId, { dryrun = false } = {}) {
  const job = await jnGetJobFull(jobJnId);
  const contact = job && job.primary && job.primary.id ? await jnGetContactFull(job.primary.id) : null;
  const name = [contact && contact.first_name, contact && contact.last_name].filter(Boolean).join(' ')
    || (contact && contact.display_name) || (job && job.display_name) || 'Unknown';

  const files = await jnListJobImages(jobJnId);
  if (!files.length) { console.log('[photo-report]', jobJnId, 'has no photos — skipping'); return { photos: 0, uploaded: [] }; }

  const logoBuf = await photoReportLogoForJob(jobJnId);

  // Download + recompress with a small worker pool; slot by index so the
  // oldest-first order survives concurrency.
  const out = new Array(files.length).fill(null);
  let next = 0, failed = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (;;) {
      const i = next++;
      if (i >= files.length) break;
      const f = files[i];
      try {
        const raw = await jnDownloadFile(f.jnid || f.id);
        const buf = await sharp(raw).rotate()
          .resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 72 }).toBuffer();
        out[i] = { buf, caption: f.filename || f.name || `photo-${i + 1}.jpg` };
      } catch (err) {
        failed++;
        if (failed <= 3) console.warn('[photo-report] photo skipped', f.jnid || f.id, err.message);
      }
    }
  }));
  const photos = out.filter(Boolean);
  if (!photos.length) throw new Error(`all ${files.length} photo downloads failed`);

  // Split into parts so each PDF stays under the email-safe cap. The estimate
  // (compressed bytes + per-image overhead + fixed header allowance) tracks
  // real pdfkit output closely because JPEGs embed byte-for-byte.
  const baseBytes = 90 * 1024 + (logoBuf ? logoBuf.length : 0);
  const groups = [];
  let cur = [], bytes = baseBytes;
  for (const p of photos) {
    const add = p.buf.length + 1500;
    if (cur.length && bytes + add > PHOTO_REPORT_MAX_PDF_BYTES) { groups.push(cur); cur = []; bytes = baseBytes; }
    cur.push(p);
    bytes += add;
  }
  if (cur.length) groups.push(cur);

  const rt = (job && job.record_type_name) || 'Job';
  const header = {
    logoBuf,
    claim: (job && job.cf_string_2) || '',
    insurer: ((job && job.cf_string_9) || '').trim(), // insurance provider (JN_FIELD_MAP: insurer → cf_string_9)
    dateContacted: fmtCentral((contact && contact.date_created) || (job && job.date_created)),
    salesRep: (job && job.sales_rep_name) || '',
    name,
    addr1: (job && job.address_line1) || '',
    addr2: [job && job.city, job && job.state_text].filter(Boolean).join(', '),
  };
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
  const safeName = name.replace(/[\\/:*?"<>|]+/g, ' ').trim();

  const uploaded = [];
  for (let g = 0; g < groups.length; g++) {
    const part = groups.length > 1 ? ` - Part ${g + 1} of ${groups.length}` : '';
    const pdf = await renderPhotoReportPdf({ ...header, title: `${rt} Photo Report${part.replace(' - ', ' — ')}` }, groups[g]);
    const filename = `Photo Report - ${safeName} - ${today}${part}.pdf`;
    if (dryrun) {
      const p = path.join(require('os').tmpdir(), filename);
      require('fs').writeFileSync(p, pdf);
      uploaded.push({ file: p, bytes: pdf.length });
    } else {
      const jnid = await jnUploadFile(jobJnId, filename, pdf, `Auto-generated ${rt.toLowerCase()} photo report (${groups[g].length} photos)`);
      uploaded.push({ jnid, filename, bytes: pdf.length });
    }
  }
  return { photos: photos.length, failed, parts: groups.length, uploaded };
}

// The URL for the JobNimbus automation (status = Work Complete → webhook):
//   https://dryops-server-production.up.railway.app/webhooks/jobnimbus/photo-report?token=<JN_WEBHOOK_TOKEN>
// Extras for manual runs: &force=1 skips the status guard, &dryrun=1 writes
// the PDFs to the server's tmp dir (and responds synchronously) instead of
// uploading to JobNimbus.
app.post('/webhooks/jobnimbus/photo-report', async (req, res) => {
  if (!webhookTokenOk(req)) return res.status(401).json({ error: 'unauthorized' });
  const rec = unwrapRecord(req.body) || {};
  const jnid = rec.jnid || rec.id || req.query.jnid;
  if (!jnid) {
    console.warn('[photo-report] webhook without jnid; keys=', Object.keys(rec).slice(0, 30).join(','));
    return res.status(400).json({ error: 'no job jnid in payload' });
  }
  const status = String(rec.status_name || '');
  if (req.query.force !== '1' && !/work\s*complete/i.test(status)) {
    console.log('[photo-report] ignoring status', JSON.stringify(status), 'for', jnid);
    return res.json({ ok: true, skipped: `status ${status || '(none)'}` });
  }
  console.log('[photo-report] queued for', jnid, 'status=', status || '(forced)');
  if (req.query.dryrun === '1') {
    try { return res.json({ ok: true, dryrun: true, ...(await generatePhotoReport(String(jnid), { dryrun: true })) }); }
    catch (err) { console.error('[photo-report] dryrun failed:', err.message); return res.status(500).json({ error: err.message }); }
  }
  res.status(202).json({ ok: true, queued: true });
  generatePhotoReport(String(jnid)).then(
    r => console.log('[photo-report]', jnid, 'done —', r.photos, 'photos →', r.parts, 'part(s)'),
    err => console.error('[photo-report]', jnid, 'failed:', err.message),
  );
});

// ── Supplemental storage billing ─────────────────────────────────────────────
// Replaces the Zapier/JN-automation flow that billed each in-storage Contents
// job on its own rolling anniversary ("1 month after most recent invoice").
// Instead, on the 1st of every month (America/Denver) this creates one DRAFT
// supplemental storage invoice per eligible job, billing that calendar month.
// Office staff review/send the drafts in JobNimbus as before.
//
// Eligible = record type in SUPP_RECORD_TYPES (default Contents), AND
// ("In Storage?" cf_boolean_1 is true OR status is "In storage"), AND status
// not in SUPP_EXCLUDED_STATUSES, AND "Supplemental Price" cf_double_1 > 0.
// Jobs matching the storage criteria but missing a price are reported, not
// billed. NOTE (measured 2026-08): ~1,185 jobs carry a stale In-Storage flag
// while only ~150/month were actually billed under the anniversary system —
// review the dryrun report and clean up flags BEFORE setting SUPP_BILLING_LIVE.
//
// Dedupe (both directions, so reruns/restarts are safe and manual invoices are
// respected): a job is skipped for a month if it already has EITHER an invoice
// with our external_id (supp-<jobJnid>-<YYYY-MM>) OR any single-line invoice
// whose one item is the offsite-storage product with date_invoice inside that
// month. Runs are logged to supplemental_billing_runs in Supabase.
//
// Env: SUPP_BILLING_LIVE=true enables real invoice creation (otherwise the
// monthly run is a dryrun that only logs+records what it WOULD create);
// SUPP_BILLING_DAY (default 1), SUPP_RECORD_TYPES / SUPP_EXCLUDED_STATUSES
// (comma-separated overrides).
const SUPP_BILLING_LIVE = process.env.SUPP_BILLING_LIVE === 'true';
const SUPP_BILLING_DAY = Math.max(1, Math.min(28, parseInt(process.env.SUPP_BILLING_DAY || '1', 10) || 1));
const SUPP_RECORD_TYPES = (process.env.SUPP_RECORD_TYPES || 'Contents')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const SUPP_EXCLUDED_STATUSES = (process.env.SUPP_EXCLUDED_STATUSES || 'Paid & Closed,PB complete,Lost,Non-Opportunity')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
// The JN catalog product used by every existing storage invoice (verified
// 2026-08-25: all supplemental invoices since July use this item + template).
const SUPP_STORAGE_ITEM_JNID = 'mestzfhuma6y3nosvqj9ctt';
const SUPP_STORAGE_ITEM_NAME = 'Contents - Offsite Content Storage';
const SUPP_IN_STORAGE_STATUS = 'in storage';
const SUPP_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function denverNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parseInt(parts.find(p => p.type === t)?.value, 10);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour') };
}

// Paginated JN pull with an ES filter (fields-slimmed). Caps at the ES
// from+size window (10k) — far above the in-storage population (~1.2k).
async function jnFetchFiltered(path, filterObj, fields) {
  const filter = encodeURIComponent(JSON.stringify(filterObj));
  const out = [];
  for (let from = 0; from + 500 <= 10000; from += 500) {
    const r = await fetch(`${JN_BASE}${path}?size=500&from=${from}&filter=${filter}&fields=${fields}`, {
      headers: { Authorization: `bearer ${JN_TOKEN}`, Accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`JN ${path} ${r.status}`);
    const data = await r.json();
    const page = data?.results ?? [];
    out.push(...page);
    if (page.length < 500 || out.length >= (data?.count ?? 0)) break;
  }
  return out;
}

async function suppFetchEligible() {
  const fields = 'jnid,name,number,status_name,record_type_name,cf_boolean_1,cf_double_1,cf_long_1,is_active,is_archived';
  const [flagged, inStatus] = await Promise.all([
    jnFetchFiltered('/jobs', { must: [{ term: { cf_boolean_1: true } }] }, fields),
    jnFetchFiltered('/jobs', { must: [{ term: { status_name: 'In storage' } }] }, fields),
  ]);
  const byId = new Map();
  for (const j of [...flagged, ...inStatus]) if (j && j.jnid) byId.set(j.jnid, j);
  const eligible = [], noPrice = [];
  for (const j of byId.values()) {
    if (j.is_active === false || j.is_archived === true) continue;
    if (!SUPP_RECORD_TYPES.includes(String(j.record_type_name || '').toLowerCase())) continue;
    const status = String(j.status_name || '').toLowerCase();
    const inStorage = j.cf_boolean_1 === true || status === SUPP_IN_STORAGE_STATUS;
    if (!inStorage || SUPP_EXCLUDED_STATUSES.includes(status)) continue;
    const price = Number(j.cf_double_1);
    if (price > 0) eligible.push(j);
    else noPrice.push({ jnid: j.jnid, name: j.name, status: j.status_name });
  }
  return { eligible, noPrice };
}

function suppItemHasStorage(items) {
  return (items || []).some(it => it && (it.jnid === SUPP_STORAGE_ITEM_JNID || /offsite content storage/i.test(it.name || '')));
}

// Build the draft-invoice payload, mirroring the shape of the invoices offices
// create today. quantity×price shows per-vault pricing when it divides cleanly.
function suppInvoicePayload(job, fullJob, monthKey, monthLabel, monthStartSecs) {
  const total = Math.round(Number(job.cf_double_1) * 100) / 100;
  const vaults = Number(job.cf_long_1) || 0;
  let quantity = 1, price = total;
  if (vaults >= 1) {
    const per = Math.round((total / vaults) * 100) / 100;
    if (Math.round(per * vaults * 100) / 100 === total) { quantity = vaults; price = per; }
  }
  const related = [];
  const contact = (Array.isArray(fullJob?.related) ? fullJob.related : []).find(r => r && r.type === 'contact' && r.id);
  if (contact) related.push({ id: contact.id });
  related.push({ id: job.jnid });
  const payload = {
    related,
    status: 1, // Draft — office reviews and sends, as with the old flow
    date_invoice: monthStartSecs,
    date_due: monthStartSecs,
    external_id: `supp-${job.jnid}-${monthKey}`,
    internal_note: `${monthLabel} Storage${vaults ? ` x ${vaults} vault${vaults === 1 ? '' : 's'}` : ''} (auto-created by DryOps)`,
    sections: [{ index: 0, name: 'CONTENTS', description: '', showGroupTotal: true, group: 0 }],
    items: [{
      jnid: SUPP_STORAGE_ITEM_JNID,
      name: SUPP_STORAGE_ITEM_NAME,
      uom: 'Items',
      item_type: 'material',
      description: `Storage of Insured Contents:\n\nRelocate and store contents in climate-controlled, secure facility.\n\nMonth of: ${monthLabel}`,
      quantity,
      price,
      cost: 0,
      amount: total,
    }],
  };
  if (fullJob?.location?.id !== undefined) payload.location = { id: fullJob.location.id };
  return payload;
}

async function sbInsert(table, row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(row),
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`${r.status} ${t.slice(0, 300)}`); }
}

let suppRunActive = false;
let lastSuppRun = null;

// One billing pass for the month containing "now" (Denver). Idempotent: safe
// to rerun any number of times within a month.
async function suppRunBilling({ dryrun = true, trigger = 'schedule' } = {}) {
  if (suppRunActive) throw new Error('supplemental billing run already in progress');
  suppRunActive = true;
  const startedAt = new Date().toISOString();
  const { y, m } = denverNow();
  const monthKey = `${y}-${String(m).padStart(2, '0')}`;
  const monthLabel = `${MONTH_NAMES[m - 1]} ${y}`;
  // 17:00 UTC = 10/11am Denver — unambiguously "the 1st" in every US zone
  const monthStartSecs = Math.floor(Date.UTC(y, m - 1, 1, 17, 0, 0) / 1000);
  const monthEndSecs = Math.floor(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1, 0, 0, 0) / 1000);
  console.log(`[supp-billing] ${dryrun ? 'DRYRUN' : 'LIVE'} run for ${monthLabel} (${trigger})`);
  const report = { month: monthKey, mode: dryrun ? 'dryrun' : 'live', trigger, created: [], skipped: [], errors: [], no_price: [] };
  try {
    const { eligible, noPrice } = await suppFetchEligible();
    report.no_price = noPrice;
    console.log(`[supp-billing] ${eligible.length} eligible, ${noPrice.length} in storage but missing a price`);
    // JN's search index lags writes by ~a minute (verified 2026-08-26), so a
    // freshly created invoice may not show in the per-job lookup of an
    // immediately following run. Also skip anything a prior LIVE run this
    // month already logged as created — closes that double-billing window.
    const priorBilled = new Set();
    try {
      const priorRuns = await sbGet(`supplemental_billing_runs?month=eq.${monthKey}&mode=eq.live&select=report`) || [];
      for (const run of priorRuns) for (const c of run.report?.created || []) if (c.jnid && !c.dryrun) priorBilled.add(c.jnid);
    } catch (err) { console.error('[supp-billing] prior-run lookup failed:', err.message); }
    let idx = 0;
    const daySecs = 24 * 60 * 60;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (idx < eligible.length) {
        const job = eligible[idx++];
        try {
          const r = await fetch(`${JN_BASE}/v2/invoices?size=100&related=${encodeURIComponent(job.jnid)}`, {
            headers: { Authorization: `bearer ${JN_TOKEN}`, Accept: 'application/json' },
          });
          if (!r.ok) throw new Error(`invoices lookup ${r.status}`);
          const invoices = ((await r.json())?.results ?? []).filter(i => i && i.is_active !== false);
          const extId = `supp-${job.jnid}-${monthKey}`;
          const autoDup = invoices.find(i => i.external_id === extId);
          const manualDup = invoices.find(i => (i.items || []).length === 1 && suppItemHasStorage(i.items)
            && i.date_invoice >= monthStartSecs - daySecs && i.date_invoice < monthEndSecs);
          // staleness signal for the report: newest invoice touching storage
          let lastStorage = 0;
          for (const i of invoices) if (suppItemHasStorage(i.items) && (i.date_invoice || 0) > lastStorage) lastStorage = i.date_invoice;
          const base = {
            jnid: job.jnid, name: job.name, number: job.number, status: job.status_name,
            total: Number(job.cf_double_1), vaults: Number(job.cf_long_1) || 0,
            last_storage_invoice: lastStorage ? new Date(lastStorage * 1000).toISOString().slice(0, 10) : null,
          };
          if (autoDup || manualDup || priorBilled.has(job.jnid)) {
            report.skipped.push({ ...base, reason: autoDup ? 'already billed this month (auto)'
              : manualDup ? 'already billed this month (manual)' : 'already billed this month (prior run log)' });
            continue;
          }
          if (dryrun) { report.created.push({ ...base, dryrun: true }); continue; }
          const fullR = await fetch(`${JN_BASE}/jobs/${job.jnid}`, { headers: { Authorization: `bearer ${JN_TOKEN}`, Accept: 'application/json' } });
          const fullJob = fullR.ok ? await fullR.json() : null;
          const payload = suppInvoicePayload(job, fullJob, monthKey, monthLabel, monthStartSecs);
          const create = await fetch(`${JN_BASE}/v2/invoices`, {
            method: 'POST',
            headers: { Authorization: `bearer ${JN_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(payload),
          });
          const body = await create.text();
          if (!create.ok) throw new Error(`invoice create ${create.status} ${body.slice(0, 200)}`);
          let created; try { created = JSON.parse(body); } catch { created = {}; }
          report.created.push({ ...base, invoice_jnid: created.jnid || null, invoice_number: created.number || null });
          console.log(`[supp-billing] created #${created.number || '?'} $${base.total} for ${job.name}`);
        } catch (err) {
          report.errors.push({ jnid: job.jnid, name: job.name, error: err.message });
          console.error(`[supp-billing] ${job.name}: ${err.message}`);
        }
      }
    }));
    console.log(`[supp-billing] done — ${report.created.length} ${dryrun ? 'would be created' : 'created'}, ${report.skipped.length} skipped, ${report.errors.length} errors`);
    lastSuppRun = { month: monthKey, mode: report.mode, trigger, at: startedAt,
      created: report.created.length, skipped: report.skipped.length, errors: report.errors.length };
    try {
      await sbInsert('supplemental_billing_runs', {
        month: monthKey, mode: report.mode, trigger, started_at: startedAt, finished_at: new Date().toISOString(),
        eligible_count: eligible.length, created_count: report.created.length,
        skipped_count: report.skipped.length, error_count: report.errors.length, report,
      });
    } catch (err) { console.error('[supp-billing] run log insert failed:', err.message); }
    return report;
  } finally {
    suppRunActive = false;
  }
}

// Scheduler: every 30 min, if it's the billing day (Denver) at/after 7am and
// this month hasn't run in the current mode yet, run. State lives in Supabase
// so Railway restarts can't double-bill or skip a month that hasn't run.
async function suppCheckDue() {
  try {
    const { d, h, y, m } = denverNow();
    if (d !== SUPP_BILLING_DAY || h < 7) return;
    const monthKey = `${y}-${String(m).padStart(2, '0')}`;
    const mode = SUPP_BILLING_LIVE ? 'live' : 'dryrun';
    const prior = await sbGet(`supplemental_billing_runs?month=eq.${monthKey}&mode=eq.${mode}&select=id&limit=1`);
    if (Array.isArray(prior) && prior.length) return;
    await suppRunBilling({ dryrun: !SUPP_BILLING_LIVE, trigger: 'schedule' });
  } catch (err) {
    console.error('[supp-billing] scheduled check failed:', err.message);
  }
}
setTimeout(suppCheckDue, 3 * 60 * 1000); // catch up shortly after boot
setInterval(suppCheckDue, SUPP_CHECK_INTERVAL_MS);

// Manual/preview runs. Body: { "dryrun": false } to create real invoices now
// (dedupe makes that safe to combine with the schedule). Default is dryrun.
app.post('/admin/supplemental-billing/run', requireAuth, requireAdmin, async (req, res) => {
  const dryrun = req.body && req.body.dryrun === false ? false : true;
  try {
    const report = await suppRunBilling({ dryrun, trigger: 'manual' });
    res.json(report);
  } catch (err) {
    res.status(err.message.includes('in progress') ? 409 : 500).json({ error: err.message });
  }
});

app.get('/admin/supplemental-billing/status', requireAuth, requireAdmin, async (req, res) => {
  const runs = await sbGet('supplemental_billing_runs?select=month,mode,trigger,started_at,finished_at,eligible_count,created_count,skipped_count,error_count&order=started_at.desc&limit=12');
  res.json({
    live: SUPP_BILLING_LIVE,
    billing_day: SUPP_BILLING_DAY,
    record_types: SUPP_RECORD_TYPES,
    excluded_statuses: SUPP_EXCLUDED_STATUSES,
    running: suppRunActive,
    last_run: lastSuppRun,
    recent_runs: runs || [],
  });
});

app.listen(PORT, () => {
  console.log(`\n✓ A1 Drying Log running at http://localhost:${PORT}\n`);
});
