'use strict';
// Owner call backs through CallRail (owner 2026-11-03): a missed new caller's
// push (callAlerts.js, "Call back") or the app's call screen asks
//
//   POST /calls/:callrailId/callback   { phone?: "<your phone>" }
//
// CallRail's outbound call API rings the owner's own phone first, then dials
// the customer and joins them (POST /v3/a/{account}/calls.json). The customer
// sees the tracking number they called (caller_id), the call is recorded and
// logged in CallRail like any other, so WYH's callback detection sees it.
// The owner's phone lives in push_prefs.callback_phone (Settings → Phone
// Alerts); a `phone` in the body is saved there first. US/Canada only;
// CallRail allows 100 outbound calls an hour per account.

const CALLBACK_ROLES = ['owner', 'admin', 'expansion_manager'];

/** "+1 (469) 555-0101" / "4695550101" → "+14695550101"; null when not a 10-digit US/CA number. */
function toE164(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  const n = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(n) ? `+1${n}` : null;
}

/** The CallRail outbound call body for calling `call`'s customer back from `ownerPhone`. */
function callbackRequest(call, ownerPhone) {
  const caller_id = toE164(call && call.tracking_phone_number);
  const customer = toE164(call && call.customer_phone_number);
  const business = toE164(ownerPhone);
  if (!caller_id) return { error: 'NO_TRACKING_NUMBER' };
  if (!customer) return { error: 'NO_CUSTOMER_NUMBER' };
  if (!business) return { error: 'NO_PHONE' };
  if (business === customer) return { error: 'SAME_NUMBER' };
  return { body: { caller_id, business_phone_number: business, customer_phone_number: customer, recording_enabled: true } };
}

function assignedLocations(p) {
  if (Array.isArray(p.location_ids) && p.location_ids.length) return p.location_ids.map(String);
  return p.location_id ? [String(p.location_id)] : [];
}

/** Admins anywhere; owners / managers only for calls at their own locations. */
function mayCallBack(profile, call) {
  if (!profile || !call) return false;
  if (profile.role === 'admin') return true;
  if (!CALLBACK_ROLES.includes(profile.role)) return false;
  return !!call.location_id && assignedLocations(profile).includes(String(call.location_id));
}

function errorText(code, status) {
  return ({
    NO_PHONE: 'Add your phone number first: CallRail rings you, then connects the caller.',
    NO_TRACKING_NUMBER: 'This call has no tracking number to call back from.',
    NO_CUSTOMER_NUMBER: "This caller's number can't be dialed back (blocked or not a US / Canada number).",
    SAME_NUMBER: "That's the caller's own number. Enter your phone instead.",
    NOT_ALLOWED: "You can only call back calls at your locations.",
    NOT_FOUND: 'Call not found.',
    RATE_LIMIT: 'CallRail’s outbound call limit was reached (100 an hour). Try again shortly.',
  })[code] || `CallRail couldn't place the call${status ? ` (${status})` : ''}. Try again.`;
}

module.exports = function mountCallbacks(app, { requireAuth, sbGet, sbUpsert, callrailApi, callrailApiWrite, callrailAccountsFor, CALLRAIL_ACCOUNT_IDS = [] }) {
  const enc = encodeURIComponent;
  const fail = (res, http, code, status) => res.status(http).json({ ok: false, code, error: errorText(code, status) });

  async function accountFor(callrailId) {
    const accounts = callrailAccountsFor ? await callrailAccountsFor(callrailId) : CALLRAIL_ACCOUNT_IDS;
    for (const acct of accounts) {
      const r = await callrailApi(acct, `calls/${enc(callrailId)}.json?fields=id`).catch(() => null);
      if (r && r.ok) return acct;
    }
    return null;
  }

  app.post('/calls/:callrailId/callback', requireAuth, async (req, res) => {
    const id = String(req.params.callrailId || '');
    if (!/^CAL[0-9a-f]+$/i.test(id)) return fail(res, 400, 'NOT_FOUND');
    try {
      const profile = ((await sbGet(`profiles?id=eq.${enc(req.userId)}&select=id,role,location_id,location_ids`)) || [])[0];
      const call = ((await sbGet(`calls?callrail_id=eq.${enc(id)}&select=callrail_id,location_id,tracking_phone_number,customer_phone_number`)) || [])[0];
      if (!call) return fail(res, 404, 'NOT_FOUND');
      if (!mayCallBack(profile, call)) return fail(res, 403, 'NOT_ALLOWED');

      // The owner's phone: from the request (saved for next time) or Settings.
      let phone = toE164(req.body && req.body.phone);
      if (req.body && req.body.phone && !phone) return fail(res, 400, 'NO_PHONE');
      if (phone) await sbUpsert('push_prefs', { profile_id: profile.id, callback_phone: phone, updated_at: new Date().toISOString() }, 'profile_id');
      else phone = toE164((((await sbGet(`push_prefs?profile_id=eq.${enc(profile.id)}&select=callback_phone`)) || [])[0] || {}).callback_phone);

      const built = callbackRequest(call, phone);
      if (built.error) return fail(res, 400, built.error);
      const acct = await accountFor(id);
      if (!acct) return fail(res, 404, 'NOT_FOUND');
      const r = await callrailApiWrite(acct, 'POST', 'calls.json', built.body);
      if (!r.ok) {
        console.warn('[callback] CallRail', r.status, r.text);
        return fail(res, r.status === 429 ? 429 : 502, r.status === 429 ? 'RATE_LIMIT' : 'CALLRAIL', r.status);
      }
      console.log(`[callback] ${id} → ${profile.role} ${profile.id} (call ${r.json && r.json.id})`);
      return res.json({ ok: true, call_id: (r.json && r.json.id) || null, your_phone: phone });
    } catch (e) {
      console.warn('[callback] failed', e.message);
      return fail(res, 502, 'CALLRAIL');
    }
  });
};

module.exports.toE164 = toE164;
module.exports.callbackRequest = callbackRequest;
module.exports.mayCallBack = mayCallBack;
module.exports.errorText = errorText;
