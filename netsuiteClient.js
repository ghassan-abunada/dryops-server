// Read-only NetSuite SuiteQL client using token-based auth (OAuth 1.0a, HMAC-SHA256).
const crypto = require('crypto');

// RFC 3986 encoding, which encodeURIComponent falls just short of.
const pct = (s) => encodeURIComponent(String(s)).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// 1234567_SB1 is the realm form; 1234567-sb1 is the hostname form.
const realmFor = (accountId) => String(accountId).trim().toUpperCase().replace(/-/g, '_');
const hostFor = (accountId) => `${String(accountId).trim().toLowerCase().replace(/_/g, '-')}.suitetalk.api.netsuite.com`;

function signatureBaseString(method, baseUrl, params) {
  const pairs = Object.entries(params).map(([k, v]) => [pct(k), pct(v)]).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : (a[0] < b[0] ? -1 : 1)));
  return [method.toUpperCase(), pct(baseUrl), pct(pairs.map(([k, v]) => `${k}=${v}`).join('&'))].join('&');
}

function authHeader({ method, baseUrl, query = {}, accountId, secrets, nonce = crypto.randomBytes(16).toString('hex'), timestamp = Math.floor(Date.now() / 1000) }) {
  const oauth = {
    oauth_consumer_key: secrets.consumer_key,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: String(timestamp),
    oauth_token: secrets.token_id,
    oauth_version: '1.0',
  };
  const base = signatureBaseString(method, baseUrl, { ...query, ...oauth });
  const signingKey = `${pct(secrets.consumer_secret)}&${pct(secrets.token_secret)}`;
  const signature = crypto.createHmac('sha256', signingKey).update(base).digest('base64');
  const fields = { realm: realmFor(accountId), ...oauth, oauth_signature: signature };
  return `OAuth ${Object.entries(fields).map(([k, v]) => `${k}="${pct(v)}"`).join(', ')}`;
}

// Only NetSuite's own message reaches the caller; request headers never do.
async function suiteql({ accountId, secrets, q, limit = 1000, offset = 0 }) {
  const baseUrl = `https://${hostFor(accountId)}/services/rest/query/v1/suiteql`;
  const query = { limit: String(limit), offset: String(offset) };
  const r = await fetch(`${baseUrl}?${new URLSearchParams(query)}`, {
    method: 'POST',
    headers: {
      Authorization: authHeader({ method: 'POST', baseUrl, query, accountId, secrets }),
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Prefer: 'transient',
    },
    body: JSON.stringify({ q }),
  });
  const body = await r.json().catch(() => null);
  if (!r.ok) {
    const detail = body && Array.isArray(body['o:errorDetails']) && body['o:errorDetails'][0] && body['o:errorDetails'][0].detail;
    throw new Error(`NetSuite ${r.status}${detail ? `: ${detail}` : ''}`);
  }
  return body;
}

module.exports = { pct, realmFor, hostFor, signatureBaseString, authHeader, suiteql };
