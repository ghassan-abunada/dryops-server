'use strict';
// Call pushes (owner 2026-11-03).
//
//   Owners + admins — "New caller" while the phone rings: an inbound call to their
//                  location from a number with no job yet. Tapping opens the
//                  call in the app to make a job or mark it not an opportunity.
//   Exp. managers + admins — "Call to review" once the call ends: answered first-time
//                  callers with a recording, and every missed call. Tapping
//                  opens the Wash Your Hands review for that call.
//
// Recipients are people assigned to the call's location (profiles.location_ids
// / location_id, same rule as text pushes), minus anyone who switched the push
// off (push_prefs). Calls on unassigned tracking numbers push nobody: every
// manager can see those numbers and the push would reach all of them; they
// still list in WYH. Each (call, kind) is claimed once in call_push_log, so
// webhook retries, the reconcile and redeploys never double-push.

// Who gets each push (owner 2026-11-03: "include admins too"), always only at
// locations they are assigned to.
const OWNER_ROLES = ['owner', 'admin'];
const MANAGER_ROLES = ['expansion_manager', 'admin'];

const OWNER = 'owner_alert';
const OWNER_MISSED = 'owner_missed';
const MANAGER = 'manager_review';
const RECORDING_RETRY_MS = [2 * 60 * 1000, 6 * 60 * 1000];
const SWEEP_WINDOW_MS = 3 * 60 * 60 * 1000;

// ── Pure helpers (tested) ────────────────────────────────────────────────────

function assignedLocations(p) {
  if (Array.isArray(p.location_ids) && p.location_ids.length) return p.location_ids.map(String);
  return p.location_id ? [String(p.location_id)] : [];
}

/** Profiles with one of `roles` assigned to the location who have not switched `prefKey` off. */
function recipientsFor(profiles, locationId, roles, prefs, prefKey) {
  const want = new Set(Array.isArray(roles) ? roles : [roles]);
  if (!locationId) return [];
  const off = new Set((prefs || []).filter((p) => p && p[prefKey] === false).map((p) => String(p.profile_id)));
  return (profiles || [])
    .filter((p) => p && want.has(p.role) && assignedLocations(p).includes(String(locationId)))
    .map((p) => String(p.id))
    .filter((id) => !off.has(id));
}

const inbound = (c) => String(c.direction || 'inbound').toLowerCase() !== 'outbound';

/** Owner alert: a ringing inbound call at a known location from a caller with no job. */
function ownerAlertEligible(call, preCall) {
  return !!(call && preCall && inbound(call) && call.location_id && !call.job_id);
}

/**
 * Manager review kind for a finished call: 'missed' (not answered, or went to
 * voicemail), 'answered' (first-time caller, answered, recording available),
 * 'wait' (answered first-timer whose recording is not there yet), or null.
 */
function managerReviewKind(call, { preCall = false, hasRecording = false } = {}) {
  if (!call || preCall || !inbound(call) || !call.location_id) return null;
  if (call.answered == null && call.duration == null) return null; // not finished
  if (call.answered === false || call.voicemail === true) return 'missed';
  if (call.answered === true && call.first_call === true) return hasRecording ? 'answered' : 'wait';
  return null;
}

function fmtPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  const n = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  return n.length === 10 ? `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}` : String(raw || '').trim();
}

function fmtMinutes(sec) {
  const s = Number(sec) || 0;
  if (s < 60) return `${Math.max(1, Math.round(s))} sec`;
  return `${Math.round(s / 60)} min`;
}

/** CallRail's carrier caller-ID often isn't a person ("WIRELESS CALLER", "DALLAS TX"); same rule as the app (lib/callsLive.ts). */
function isPlaceholderName(name) {
  const n = String(name || '').trim().replace(/\s+/g, ' ');
  if (!n) return true;
  if (/^(wireless caller|unknown( caller| name)?|private( caller| number)?|restricted|anonymous|toll free( call)?|cell phone|mobile caller|unavailable|no caller id|out of area|v\d+)$/i.test(n)) return true;
  return n === n.toUpperCase() && /^[A-Z .'-]+ [A-Z]{2}$/.test(n);
}
function personName(call) {
  const n = String(call.customer_name || '').trim();
  return isPlaceholderName(n) ? '' : n;
}

function callerLabel(call) {
  const name = personName(call);
  const phone = fmtPhone(call.customer_phone_number);
  if (name && phone) return `${name} ${phone}`;
  return name || phone || 'Unknown caller';
}

function shortLocation(name) {
  return String(name || '').replace(/\s*\(.*?\)\s*/g, ' ').trim();
}

function ownerMessage(call, locationName) {
  return {
    title: `New caller${locationName ? ` · ${shortLocation(locationName)}` : ''}`,
    body: `${callerLabel(call)} is calling. Make a job or mark it not an opportunity.`,
    data: { kind: 'call_alert', callrail_id: call.callrail_id, url: `/calls/${call.callrail_id}?mode=owner` },
  };
}

/** Owner / admin missed-call push: the notification carries a Call back button (category 'missed_call'). */
function ownerMissedMessage(call, locationName) {
  return {
    title: `Missed call${locationName ? ` · ${shortLocation(locationName)}` : ''}`,
    body: `${callerLabel(call)} ${call.voicemail ? 'left a voicemail' : 'wasn\'t answered'}. Call them back now?`,
    data: { kind: 'call_missed', callrail_id: call.callrail_id, url: `/calls/${call.callrail_id}?mode=owner` },
    categoryId: 'missed_call',
  };
}

/** Owner missed-call push: a finished, missed (or voicemail) inbound call from a new caller (no job yet). */
function ownerMissedEligible(call) {
  if (!call || !inbound(call) || !call.location_id || call.job_id) return false;
  if (call.answered == null && call.duration == null) return false;
  return call.answered === false || call.voicemail === true;
}

function managerMessage(call, locationName, kind) {
  const where = locationName ? ` · ${shortLocation(locationName)}` : '';
  const who = personName(call) || fmtPhone(call.customer_phone_number) || 'Unknown caller';
  return kind === 'missed'
    ? {
        title: `Missed call${where}`,
        body: `${who}${call.voicemail ? ' left a voicemail' : ' wasn\'t answered'}. Review the follow-up.`,
        data: { kind: 'call_review', callrail_id: call.callrail_id, url: `/calls/${call.callrail_id}?mode=review` },
      }
    : {
        title: `Call to review${where}`,
        body: `${who} · new caller · ${fmtMinutes(call.duration)}. Listen and give the operator feedback.`,
        data: { kind: 'call_review', callrail_id: call.callrail_id, url: `/calls/${call.callrail_id}?mode=review` },
      };
}

// ── Runtime ──────────────────────────────────────────────────────────────────

function createCallAlerts({ SUPABASE_URL, SUPABASE_SERVICE_KEY, sbGet, push, callrailApi, CALLRAIL_ACCOUNT_IDS = [], fetchImpl, log = console }) {
  const doFetch = fetchImpl || fetch;
  const enc = encodeURIComponent;
  const pending = new Set(); // callrail ids with a recording re-check scheduled

  /** Claim (call, kind) once. True only for the first caller. */
  async function claim(callrailId, kind, recipients) {
    const r = await doFetch(`${SUPABASE_URL}/rest/v1/call_push_log?on_conflict=callrail_id,kind`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=representation',
      },
      body: JSON.stringify({ callrail_id: callrailId, kind, recipients }),
    });
    if (!r.ok) { log.warn('[call-push] claim failed', r.status, (await r.text()).slice(0, 200)); return false; }
    const rows = await r.json().catch(() => []);
    return Array.isArray(rows) && rows.length > 0;
  }

  async function context(locationId, roles) {
    const [profiles, loc] = await Promise.all([
      sbGet(`profiles?select=id,role,location_id,location_ids&role=in.(${roles.map(enc).join(',')})`),
      sbGet(`locations?id=eq.${enc(locationId)}&select=name&limit=1`),
    ]);
    const prof = Array.isArray(profiles) ? profiles : [];
    const ids = prof.map((p) => p.id);
    const prefs = ids.length ? (await sbGet(`push_prefs?select=profile_id,call_alerts,call_reviews&profile_id=in.(${ids.map(enc).join(',')})`)) || [] : [];
    return { profiles: prof, prefs, locationName: Array.isArray(loc) && loc[0] ? loc[0].name : null };
  }

  async function hasRecording(call) {
    if (call.recording_url) return true;
    if (!callrailApi) return false;
    for (const acct of CALLRAIL_ACCOUNT_IDS) {
      try {
        const r = await callrailApi(acct, `calls/${enc(call.callrail_id)}.json?fields=recording`);
        if (r && r.ok && r.json) return !!r.json.recording;
      } catch { /* next account */ }
    }
    return false;
  }

  async function sendOwner(call) {
    const ctx = await context(call.location_id, OWNER_ROLES);
    const ids = recipientsFor(ctx.profiles, call.location_id, OWNER_ROLES, ctx.prefs, 'call_alerts');
    if (!ids.length) return { sent: 0, reason: 'no owners' };
    if (!(await claim(call.callrail_id, OWNER, ids.length))) return { sent: 0, reason: 'already sent' };
    const sent = await push.toProfiles(ids, ownerMessage(call, ctx.locationName), 'call_alert');
    log.log(`[call-push] owner alert ${call.callrail_id} → ${ids.length} owner(s), ${sent} device(s)`);
    return { sent, recipients: ids.length };
  }

  async function sendOwnerMissed(call) {
    const ctx = await context(call.location_id, OWNER_ROLES);
    const ids = recipientsFor(ctx.profiles, call.location_id, OWNER_ROLES, ctx.prefs, 'call_alerts');
    if (!ids.length) return { sent: 0, reason: 'no owners' };
    if (!(await claim(call.callrail_id, OWNER_MISSED, ids.length))) return { sent: 0, reason: 'already sent' };
    const sent = await push.toProfiles(ids, ownerMissedMessage(call, ctx.locationName), 'call_missed');
    log.log(`[call-push] owner missed ${call.callrail_id} → ${ids.length} owner(s), ${sent} device(s)`);
    return { sent, recipients: ids.length };
  }

  async function sendManager(call, kind) {
    const ctx = await context(call.location_id, MANAGER_ROLES);
    const ids = recipientsFor(ctx.profiles, call.location_id, MANAGER_ROLES, ctx.prefs, 'call_reviews');
    if (!ids.length) return { sent: 0, reason: 'no managers' };
    if (!(await claim(call.callrail_id, MANAGER, ids.length))) return { sent: 0, reason: 'already sent' };
    const sent = await push.toProfiles(ids, managerMessage(call, ctx.locationName, kind), 'call_review');
    log.log(`[call-push] manager review (${kind}) ${call.callrail_id} → ${ids.length} manager(s), ${sent} device(s)`);
    return { sent, recipients: ids.length };
  }

  /** Re-read the stored call (webhook rows are sparse) and decide the manager push. */
  async function reviewCall(callrailId, attempt = 0) {
    const rows = await sbGet(`calls?callrail_id=eq.${enc(callrailId)}&select=callrail_id,direction,answered,voicemail,first_call,duration,location_id,job_id,recording_url,customer_name,customer_phone_number,start_time&limit=1`);
    const call = Array.isArray(rows) ? rows[0] : null;
    if (!call) return null;
    // Owners + admins: a missed new caller, with a Call back button (once per call).
    if (attempt === 0 && ownerMissedEligible(call)) await sendOwnerMissed(call).catch((e) => log.warn('[call-push] owner missed failed', e.message));
    let kind = managerReviewKind(call, { hasRecording: !!call.recording_url });
    if (kind === 'wait') kind = managerReviewKind(call, { hasRecording: await hasRecording(call) });
    if (kind === 'wait') {
      const delay = RECORDING_RETRY_MS[attempt];
      if (delay != null && !pending.has(`${callrailId}:${attempt}`)) {
        pending.add(`${callrailId}:${attempt}`);
        setTimeout(() => { pending.delete(`${callrailId}:${attempt}`); reviewCall(callrailId, attempt + 1).catch((e) => log.warn('[call-push] retry failed', e.message)); }, delay).unref?.();
      }
      return { waiting: true };
    }
    return kind ? sendManager(call, kind) : null;
  }

  /** Webhook hook: `row` is the upserted call row with location/job resolved. */
  async function onCallEvent(row, { preCall }) {
    try {
      if (ownerAlertEligible(row, preCall)) return await sendOwner(row);
      if (!preCall && inbound(row)) return await reviewCall(row.callrail_id);
    } catch (e) {
      log.warn('[call-push] failed', row && row.callrail_id, e.message);
    }
    return null;
  }

  /** Reconcile hook: manager reviews for recent finished calls the webhook missed. */
  async function sweep() {
    const since = new Date(Date.now() - SWEEP_WINDOW_MS).toISOString();
    const rows = await sbGet(`calls?select=callrail_id&start_time=gte.${enc(since)}&direction=neq.outbound&location_id=not.is.null&or=(answered.eq.false,voicemail.eq.true,and(answered.eq.true,first_call.eq.true))&limit=500`);
    if (!Array.isArray(rows) || !rows.length) return 0;
    const done = await sbGet(`call_push_log?select=callrail_id&kind=eq.${MANAGER}&callrail_id=in.(${rows.map((r) => `"${r.callrail_id}"`).map(enc).join(',')})`);
    const skip = new Set((Array.isArray(done) ? done : []).map((d) => d.callrail_id));
    let n = 0;
    for (const r of rows) {
      if (skip.has(r.callrail_id)) continue;
      const out = await reviewCall(r.callrail_id).catch(() => null);
      if (out && out.sent) n++;
    }
    return n;
  }

  return { onCallEvent, reviewCall, sweep, claim };
}

module.exports = createCallAlerts;
module.exports.createCallAlerts = createCallAlerts;
module.exports.recipientsFor = recipientsFor;
module.exports.ownerAlertEligible = ownerAlertEligible;
module.exports.managerReviewKind = managerReviewKind;
module.exports.ownerMessage = ownerMessage;
module.exports.managerMessage = managerMessage;
module.exports.ownerMissedMessage = ownerMissedMessage;
module.exports.ownerMissedEligible = ownerMissedEligible;
module.exports.isPlaceholderName = isPlaceholderName;
module.exports.OWNER_MISSED = OWNER_MISSED;
module.exports.fmtPhone = fmtPhone;
module.exports.OWNER = OWNER;
module.exports.OWNER_ROLES = OWNER_ROLES;
module.exports.MANAGER_ROLES = MANAGER_ROLES;
module.exports.MANAGER = MANAGER;
