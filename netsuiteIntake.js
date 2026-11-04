// One-time, write-only page for the NetSuite admin to hand over API credentials
// (GET/POST /netsuite/connect/:token). Nothing typed here can be read back from
// any page: secrets are encrypted before storage and only the future sync reads
// them, through the load() this module returns.
//
// Env (the page 404s until the first two are set):
//   NETSUITE_INTAKE_TOKEN  <unix-expiry>.<random>: the link's secret and its expiry
//   NETSUITE_ENC_KEY       base64 of 32 random bytes
//   NETSUITE_PUBLIC_CERT   optional PEM; offers OAuth 2.0, which needs our certificate
//   NETSUITE_NOTIFY_EMAIL  optional; told when a submission lands (no secrets in it)
// To reopen after a bad submission: delete the row in netsuite_credentials.
const crypto = require('crypto');
const express = require('express');
const { z } = require('zod');

const AAD = Buffer.from('netsuite_credentials:v1');
const TAGGING = {
  subsidiary: 'Subsidiary',
  department: 'Department',
  class: 'Class',
  location: 'Location',
  not_sure: 'Not sure',
};

function sameSecret(a, b) {
  const hash = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(hash(a), hash(b));
}

// The expiry lives in the token, so a link can never be issued without one.
function tokenValid(given, configured, nowMs = Date.now()) {
  const m = /^(\d{10})\.[A-Za-z0-9_-]{32,}$/.exec(String(configured || ''));
  if (!m || nowMs >= Number(m[1]) * 1000) return false;
  return sameSecret(given, configured);
}

function parseKey(b64) {
  const key = Buffer.from(String(b64 || ''), 'base64');
  return key.length === 32 ? key : null;
}

function encryptSecrets(obj, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(AAD);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

function decryptSecrets(stored, key) {
  const [v, iv, tag, ct] = String(stored).split(':');
  if (v !== 'v1') throw new Error('unknown NetSuite secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAAD(AAD);
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8'));
}

// Pasted values often pick up stray spaces or line breaks.
const secret = (label) => z.string().transform((s) => s.replace(/\s+/g, ''))
  .pipe(z.string().min(8, `${label} looks too short`).max(2000, `${label} looks too long`));
const common = {
  account_id: z.string().trim().regex(/^[A-Za-z0-9_-]{4,30}$/, 'Account ID should look like 1234567 or 1234567_SB1'),
  expense_tagging: z.enum(Object.keys(TAGGING)).catch('not_sure'),
  notes: z.string().trim().max(2000, 'Notes are too long').catch(''),
};
const submissionSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('oauth2_m2m'), ...common, client_id: secret('Client ID'), certificate_id: secret('Certificate ID') }),
  z.object({
    method: z.literal('tba'), ...common,
    consumer_key: secret('Consumer key'), consumer_secret: secret('Consumer secret'),
    token_id: secret('Token ID'), token_secret: secret('Token secret'),
  }),
]);

function validateSubmission(body) {
  const parsed = submissionSchema.safeParse(body || {});
  if (!parsed.success) return { error: parsed.error.issues[0].code === 'invalid_type' ? 'Please fill in every field' : parsed.error.issues[0].message };
  const { method, account_id, expense_tagging, notes, ...secrets } = parsed.data;
  return { value: { method, account_id, expense_tagging, notes: notes || null, secrets } };
}

// Service-key access to the single-row table. insert() is false when a
// submission already exists, so two racing posts cannot overwrite each other.
function supabaseStore({ url, serviceKey }) {
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
  const base = `${url}/rest/v1/netsuite_credentials`;
  return {
    async get() {
      const r = await fetch(`${base}?id=eq.1&select=*`, { headers });
      if (!r.ok) throw new Error(`netsuite_credentials read failed (${r.status})`);
      return (await r.json())[0] || null;
    },
    async insert(row) {
      const r = await fetch(`${base}?on_conflict=id`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify(row),
      });
      if (!r.ok) throw new Error(`netsuite_credentials write failed (${r.status})`);
      return (await r.json()).length > 0;
    },
  };
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `
*{box-sizing:border-box}body{margin:0;background:#F1F5F9;color:#1C2333;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
header{background:#1C2333;color:#F1F5F9;padding:14px 16px;font-weight:800}
main{max-width:640px;margin:0 auto;padding:16px}
h1{font-size:24px;line-height:1.25;margin:12px 0 8px}h2{font-size:16px;margin:0 0 12px}
.card{background:#fff;border:1px solid #E2E8F0;border-radius:10px;padding:16px;margin:16px 0}
label{display:block;font-weight:600;margin:14px 0 4px}label small{font-weight:400;color:#475569}
input[type=text],input[type=password],select,textarea{width:100%;min-height:44px;padding:10px;border:1px solid #94A3B8;border-radius:8px;font:inherit;background:#fff;color:inherit}
input:focus-visible,select:focus-visible,textarea:focus-visible,button:focus-visible,a:focus-visible,.tabs label:focus-visible{outline:3px solid #0369A1;outline-offset:1px}
button{width:100%;min-height:44px;margin-top:18px;border:0;border-radius:8px;background:#0369A1;color:#fff;font:inherit;font-weight:700;cursor:pointer}
button:hover{background:#075985}a{color:#0369A1}ol{margin:0;padding-left:20px}li{margin:6px 0}
.error{background:#FEF2F2;border:1px solid #DC2626;color:#7F1D1D;border-radius:8px;padding:10px 12px;margin:16px 0}
.muted{color:#475569;font-size:14px}.pick{position:absolute;opacity:0}
.tabs{display:flex;gap:8px;margin:0 0 16px}.tabs label{flex:1;margin:0;padding:10px;text-align:center;background:#fff;border:1px solid #94A3B8;border-radius:8px;cursor:pointer}
.panel{display:none}
#pick-oauth2:checked~.tabs label[for=pick-oauth2],#pick-tba:checked~.tabs label[for=pick-tba]{background:#DBEAFE;border-color:#0369A1;color:#075985}
#pick-oauth2:focus-visible~.tabs label[for=pick-oauth2],#pick-tba:focus-visible~.tabs label[for=pick-tba]{outline:3px solid #0369A1;outline-offset:1px}
#pick-oauth2:checked~.panel-oauth2,#pick-tba:checked~.panel-tba{display:block}`;

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body><header>DryOps</header><main>${body}</main></body></html>`;

const NOT_FOUND = page('Not found', '<h1>This link isn\'t valid</h1><p>It may have expired. Please ask for a new one.</p>');
const RECEIVED = page('Received', '<h1>Credentials received</h1><p>Thank you. They were encrypted on arrival, and this link no longer accepts anything. You can close this page.</p><p class="muted">Sent the wrong values? Let your DryOps contact know and they\'ll reopen the link.</p>');
const UNAVAILABLE = page('Try again shortly', '<h1>Something went wrong on our side</h1><p>Nothing was saved. Please try again in a few minutes.</p>');

function sharedFields(prefill) {
  const options = Object.entries(TAGGING).map(([v, l]) => `<option value="${v}"${(prefill.expense_tagging || 'not_sure') === v ? ' selected' : ''}>${l}</option>`).join('');
  return `<label>Account ID <small>e.g. 1234567</small><input type="text" name="account_id" value="${esc(prefill.account_id)}" required autocomplete="off" spellcheck="false"></label>
<label>How are expenses tagged to our locations?<select name="expense_tagging">${options}</select></label>
<label>Notes <small>optional</small><textarea name="notes" rows="2" maxlength="2000">${esc(prefill.notes)}</textarea></label>`;
}

const field = (name, label) => `<label>${label}<input type="password" name="${name}" required autocomplete="off" spellcheck="false"></label>`;

function formPage({ action, hasCert, error, prefill = {} }) {
  const showTba = !hasCert || prefill.method === 'tba';
  const tba = `<div class="panel panel-tba"><form method="post" action="${action}">
<input type="hidden" name="method" value="tba">
<h2>Token-based authentication</h2>
<ol class="muted"><li>Setup &gt; Integration &gt; Manage Integrations &gt; New. Turn on Token-Based Authentication and save. The consumer key and secret appear only once.</li>
<li>Setup &gt; Users/Roles &gt; Access Tokens &gt; New. Use the DryOps integration, the integration user and the read-only role.</li></ol>
${sharedFields(prefill)}${field('consumer_key', 'Consumer key')}${field('consumer_secret', 'Consumer secret')}${field('token_id', 'Token ID')}${field('token_secret', 'Token secret')}
<button type="submit">Submit securely</button></form></div>`;
  const oauth = !hasCert ? '' : `<div class="panel panel-oauth2"><form method="post" action="${action}">
<input type="hidden" name="method" value="oauth2_m2m">
<h2>OAuth 2.0 (machine to machine)</h2>
<ol class="muted"><li>Setup &gt; Integration &gt; Manage Integrations &gt; New. Turn on the Client Credentials grant and save. The client ID appears only once.</li>
<li><a href="${action}/dryops-netsuite.pem" download>Download our public certificate</a>.</li>
<li>Setup &gt; Integration &gt; Manage Authentication &gt; OAuth 2.0 Client Credentials (M2M) Setup &gt; Create New. Choose the integration user, the read-only role and the DryOps integration, then upload the certificate.</li></ol>
${sharedFields(prefill)}${field('client_id', 'Client ID')}${field('certificate_id', 'Certificate ID')}
<button type="submit">Submit securely</button></form></div>`;
  const picker = !hasCert ? '' : `<input class="pick" type="radio" name="pick" id="pick-oauth2"${showTba ? '' : ' checked'}><input class="pick" type="radio" name="pick" id="pick-tba"${showTba ? ' checked' : ''}>
<div class="tabs"><label for="pick-oauth2">OAuth 2.0</label><label for="pick-tba">Token-based</label></div>`;
  const body = `<h1>Connect NetSuite to DryOps</h1>
<p>This gives DryOps read-only access to financial data. Please use a dedicated integration user and a read-only role, not a personal login.</p>
${error ? `<div class="error" role="alert">${esc(error)}. For security, please re-enter the credential fields.</div>` : ''}
<div class="card">${picker}${oauth}${hasCert ? tba : tba.replace('class="panel panel-tba"', 'class="panel-tba"')}</div>
<p class="muted">This link works once. Values are encrypted on arrival and can't be viewed from this page afterwards.</p>`;
  return page('Connect NetSuite', body);
}

function mountNetsuiteIntake(app, { env = process.env, store, onSubmitted = async () => {} }) {
  const key = parseKey(env.NETSUITE_ENC_KEY);
  let cert = null;
  if (env.NETSUITE_PUBLIC_CERT) {
    const pem = env.NETSUITE_PUBLIC_CERT.replace(/\\n/g, '\n').trim();
    try { new crypto.X509Certificate(pem); cert = `${pem}\n`; } catch { console.warn('[netsuite] NETSUITE_PUBLIC_CERT is not a valid certificate; offering token-based auth only'); }
  }
  if (env.NETSUITE_INTAKE_TOKEN && !key) console.warn('[netsuite] NETSUITE_ENC_KEY must be base64 of 32 bytes; the intake page stays off');

  const router = express.Router({ mergeParams: true });
  router.use((req, res, next) => {
    res.removeHeader('Access-Control-Allow-Origin');
    res.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
    if (!key || !tokenValid(req.params.token, env.NETSUITE_INTAKE_TOKEN)) return res.status(404).send(NOT_FOUND);
    next();
  });

  const action = (req) => `/netsuite/connect/${encodeURIComponent(req.params.token)}`;

  router.get('/', async (req, res) => {
    try {
      if (await store.get()) return res.send(RECEIVED);
      res.send(formPage({ action: action(req), hasCert: !!cert }));
    } catch (err) {
      console.error('[netsuite] intake page:', err.message);
      res.status(503).send(UNAVAILABLE);
    }
  });

  router.get('/dryops-netsuite.pem', (req, res) => {
    if (!cert) return res.status(404).send(NOT_FOUND);
    res.type('application/x-pem-file').attachment('dryops-netsuite.pem').send(cert);
  });

  router.post('/', express.urlencoded({ extended: false, limit: '32kb' }), async (req, res) => {
    const { value, error } = validateSubmission(req.body);
    if (error) {
      const { account_id, expense_tagging, notes, method } = req.body || {};
      return res.status(400).send(formPage({ action: action(req), hasCert: !!cert, error, prefill: { account_id, expense_tagging, notes, method } }));
    }
    try {
      const inserted = await store.insert({
        id: 1,
        method: value.method,
        account_id: value.account_id,
        expense_tagging: value.expense_tagging,
        notes: value.notes,
        secrets: encryptSecrets(value.secrets, key),
      });
      if (inserted) {
        console.log(`[netsuite] credentials received (${value.method})`);
        Promise.resolve().then(() => onSubmitted({ method: value.method, account_id: value.account_id, expense_tagging: value.expense_tagging }))
          .catch((err) => console.error('[netsuite] notify:', err.message));
      }
      res.send(RECEIVED);
    } catch (err) {
      console.error('[netsuite] intake save:', err.message);
      res.status(503).send(UNAVAILABLE);
    }
  });

  // Never let the default handler print a stack on a parse or size failure.
  router.use((err, req, res, next) => {
    console.error('[netsuite] intake request:', err.message);
    res.status(400).send(page('Please try again', '<h1>That didn\'t go through</h1><p>Nothing was saved. Please go back and try again.</p>'));
  });

  app.use('/netsuite/connect/:token', router);

  return {
    // For the future sync: the stored row with its secrets decrypted, or null.
    async load() {
      const row = await store.get();
      if (!row) return null;
      if (!key) throw new Error('NETSUITE_ENC_KEY is not configured');
      return { ...row, secrets: decryptSecrets(row.secrets, key) };
    },
  };
}

module.exports = mountNetsuiteIntake;
Object.assign(module.exports, { tokenValid, parseKey, encryptSecrets, decryptSecrets, validateSubmission, supabaseStore });
