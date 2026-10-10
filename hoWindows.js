'use strict';
// ── Homeowner arrival-window offers ──────────────────────────────────────────
// A dispatcher (or the assigned tech) offers one or two 2-hour windows for a
// visit; the homeowner picks on the portal page (homeowner.js) or replies
// "1" / "2" by SMS to the Twilio number. Either path runs chooseWindow(),
// which writes the slot columns (guarded by the inspections_guard trigger —
// SQLSTATE VS001 = double booking → the visit is left 'tentative' for the
// dispatcher) and nudges the JobNimbus task sync. One reminder goes out after
// schedule_settings.ho_reminder_minutes of silence, inside 8–20 local.
//
//   POST /visits/:id/offer-windows      requireAuth; admin/owner or assigned tech
//   POST /webhooks/twilio/sms           Twilio inbound (form-encoded, signed)
//
// Env: TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER (sendSms),
// TWILIO_INBOUND_ENABLED=1, TWILIO_WEBHOOK_URL (exact public URL Twilio posts
// to — signature validation), HO_SMS_DRYRUN=1 (log instead of send),
// HO_REMINDERS_DISABLED=1, PORTAL_BASE_URL (via homeowner.js).

const crypto = require('crypto');
const express = require('express');
const {
  hoOfferMessage, hoFollowUpMessage, hoTentativeMessage, hoConfirmMessage, hoReminderMessage, fmtWindow,
} = require('./hoOffer');

// ── Pure pieces (tested in test/homeowner.test.js) ───────────────────────────

// Twilio request signature: base64(HMAC-SHA1(authToken, url + Σ sorted(key+value))).
function twilioSignature(authToken, url, params) {
  const keys = Object.keys(params || {}).sort();
  const data = url + keys.map((k) => k + String(params[k] ?? '')).join('');
  return crypto.createHmac('sha1', authToken).update(data).digest('base64');
}
function twilioSignatureOk(authToken, url, params, header) {
  if (!authToken || !url || !header) return false;
  const a = Buffer.from(twilioSignature(authToken, url, params));
  const b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// "1", " 2 ", "Option 1", "1 please" → 1|2; anything else → null.
function parseChoice(text) {
  const m = /^\s*(?:option\s*)?([12])\b/i.exec(String(text || ''));
  return m ? Number(m[1]) : null;
}

const xmlEscape = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const twiml = (message) => (message ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xmlEscape(message)}</Message></Response>` : '<?xml version="1.0" encoding="UTF-8"?><Response/>');

function validOptions(options) {
  if (!Array.isArray(options) || options.length < 1 || options.length > 2) return null;
  const out = [];
  for (const o of options) {
    if (!o || typeof o !== 'object') return null;
    const s = o.startMin, e = o.endMin;
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e > 1440 || s >= e) return null;
    out.push({ startMin: s, endMin: e });
  }
  return out;
}

// The one place a homeowner's choice becomes the visit's arrival window.
// → { ok:true, status:'confirmed', window, chosen } | { ok:true, status:'tentative', window, code:'VS001' }
//   | { ok:false, code:'NO_OPTION' }. Throws on other DB errors.
async function chooseWindow({ visit, n, replyText, sbPatch, syncVisitJnTask, now }) {
  const options = Array.isArray(visit.ho_window_options) ? visit.ho_window_options : [];
  const w = options[n - 1];
  if (!w || !Number.isInteger(w.startMin) || !Number.isInteger(w.endMin)) return { ok: false, code: 'NO_OPTION' };
  const window = { startMin: w.startMin, endMin: w.endMin };
  const ts = now || new Date().toISOString();
  const replyCols = { ho_reply_text: replyText == null ? null : String(replyText).slice(0, 200), ho_replied_at: ts };
  const where = `id=eq.${encodeURIComponent(String(visit.id))}`;
  try {
    await sbPatch('inspections', where, {
      slot_start_min: window.startMin, slot_end_min: window.endMin, scheduled_time: fmtWindow(window),
      ho_window_status: 'confirmed', ho_chosen: n, ...replyCols,
    });
  } catch (err) {
    if (/VS00\d/.test(String(err && err.message))) {
      await sbPatch('inspections', where, { ho_window_status: 'tentative', ...replyCols }).catch(() => {});
      return { ok: true, status: 'tentative', window, code: 'VS001' };
    }
    throw err;
  }
  if (syncVisitJnTask) Promise.resolve().then(() => syncVisitJnTask(String(visit.id))).catch(() => {});
  return { ok: true, status: 'confirmed', window, chosen: n };
}

// ── Mount ────────────────────────────────────────────────────────────────────
module.exports = function mountHoWindows(app, deps) {
  const {
    requireAuth, appActor, loadVisit, isAssigned,
    sbGet, sbPatch, sbUpsert, sendSms, normPhone, toE164,
    syncVisitJnTask, loadScheduleSettings,
    ensureHomeownerLink, portalEnabledFor, tzFor, todayIn, hourIn,
  } = deps;

  const TWILIO_ACCOUNT_SID = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  const TWILIO_AUTH_TOKEN = (process.env.TWILIO_AUTH_TOKEN || '').trim();
  const TWILIO_FROM_NUMBER = (process.env.TWILIO_FROM_NUMBER || '').trim();
  const TWILIO_WEBHOOK_URL = (process.env.TWILIO_WEBHOOK_URL || '').trim();
  const inboundEnv = (process.env.TWILIO_INBOUND_ENABLED || '').trim();
  const INBOUND_ENABLED = !!inboundEnv && inboundEnv !== '0' && inboundEnv.toLowerCase() !== 'false';
  const SMS_CONFIGURED = !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER);
  const DRYRUN = process.env.HO_SMS_DRYRUN === '1';
  const REMINDERS_DISABLED = process.env.HO_REMINDERS_DISABLED === '1';
  const IS_PROD = process.env.NODE_ENV === 'production';

  const log = (...a) => console.log('[ho-windows]', ...a);
  const warn = (...a) => console.warn('[ho-windows]', ...a);
  const enc = encodeURIComponent;
  const nowISO = () => new Date().toISOString();

  if (INBOUND_ENABLED && !TWILIO_WEBHOOK_URL) warn('TWILIO_INBOUND_ENABLED is on but TWILIO_WEBHOOK_URL is unset — inbound SMS will be rejected in production');

  const VISIT_SELECT = 'id,job_id,jn_id,task_type,status,scheduled_date,slot_start_min,slot_end_min,assigned_to_ids,location_id,ho_window_status,ho_window_options,ho_offered_at';
  const JOB_SELECT = 'id,jn_id,name,client_name,client_phone,client_phone_norm,location_id,jn_location_id,is_active';

  async function portalUrlFor(job, visitId) {
    if (!(await portalEnabledFor(job.location_id))) return null;
    const link = await ensureHomeownerLink(job.id, job);
    return link.url ? `${link.url}?v=${enc(String(visitId))}` : null;
  }
  async function techFirstName(visit) {
    const id = (visit.assigned_to_ids || [])[0];
    if (!id) return null;
    const rows = await sbGet(`profiles?id=eq.${enc(String(id))}&select=full_name`);
    return (rows && rows[0] && rows[0].full_name) || null;
  }
  async function recordNotification(row) {
    await sbUpsert('homeowner_notifications', row, 'job_id,dedupe_key').catch((e) => warn('notification row', e.message));
  }

  // ── Offer ─────────────────────────────────────────────────────────────────
  app.post('/visits/:id/offer-windows', requireAuth, async (req, res) => {
    try {
      const actor = await appActor(req);
      if (!actor) return res.status(403).json({ error: 'Profile not found' });
      const visit = await loadVisit(String(req.params.id), VISIT_SELECT);
      if (!visit) return res.status(404).json({ error: 'Visit not found' });
      if (!['admin', 'owner'].includes(actor.role) && !isAssigned(visit, actor.id)) return res.status(403).json({ error: 'Not allowed to offer windows for this visit' });
      if (visit.status === 'cancelled' || visit.status === 'completed') return res.status(409).json({ error: 'This visit is no longer open', code: 'VISIT_CLOSED' });
      if (!visit.scheduled_date) return res.status(400).json({ error: 'Visit has no date' });
      const options = validOptions(req.body && req.body.options);
      if (!options) return res.status(400).json({ error: 'options must be 1–2 windows of { startMin, endMin } (minutes 0–1440, start < end)' });

      const jobs = await sbGet(`jobs?id=eq.${enc(String(visit.job_id))}&select=${JOB_SELECT}`);
      const job = jobs && jobs[0];
      if (!job) return res.status(404).json({ error: 'Job not found' });
      const phone = toE164(job.client_phone || job.client_phone_norm);
      if (!phone) return res.json({ ok: false, code: 'NO_PHONE' });

      const url = await portalUrlFor(job, visit.id);
      const today = todayIn(await tzFor(visit.location_id || job.location_id));
      const body = hoOfferMessage({
        clientName: job.client_name, techName: await techFirstName(visit), taskType: visit.task_type,
        date: visit.scheduled_date, today, options, url,
      });

      if (!SMS_CONFIGURED && !DRYRUN) return res.json({ ok: false, code: 'SMS_DISABLED', url, body, to: phone });
      let sid = null;
      if (DRYRUN) {
        log('offer dryrun →', phone.slice(-4), JSON.stringify(body));
        sid = 'dryrun';
      } else {
        const r = await sendSms(phone, body);
        if (!r.ok) return res.json({ ok: false, code: 'SMS_FAILED', error: r.error, url });
        sid = r.sid || null;
      }
      const offeredAt = nowISO();
      await sbPatch('inspections', `id=eq.${enc(visit.id)}`, {
        ho_window_options: options, ho_window_status: 'offered', ho_offered_at: offeredAt, ho_sms_sid: sid,
        ho_reply_text: null, ho_replied_at: null, ho_reminder_at: null, ho_chosen: null,
      });
      await recordNotification({ job_id: job.id, kind: 'window_offer', dedupe_key: `offer:${visit.id}:${offeredAt}`, to_phone: phone, body, sms_sid: sid, sent_at: offeredAt });
      res.json({ ok: true, status: 'offered', url, ...(DRYRUN ? { dryrun: true, body } : {}) });
    } catch (err) {
      warn('offer', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ── Inbound SMS (Twilio) ──────────────────────────────────────────────────
  const REPLY_WINDOW_MS = 48 * 60 * 60 * 1000;
  function xml(res, message) { res.set('Content-Type', 'text/xml').send(twiml(message)); }
  app.post('/webhooks/twilio/sms', express.urlencoded({ extended: false }), async (req, res) => {
    try {
      const params = req.body || {};
      if (TWILIO_WEBHOOK_URL) {
        if (!twilioSignatureOk(TWILIO_AUTH_TOKEN, TWILIO_WEBHOOK_URL, params, req.headers['x-twilio-signature'])) {
          warn('inbound: bad signature');
          return res.status(403).send('bad signature');
        }
      } else if (IS_PROD) {
        warn('inbound: TWILIO_WEBHOOK_URL unset — refusing unsigned webhook in production');
        return res.status(403).send('signature validation not configured');
      }
      if (!INBOUND_ENABLED) return xml(res, null);

      const from = normPhone(params.From);
      const text = String(params.Body || '').trim();
      if (!from || /^(stop|unsubscribe|help)$/i.test(text)) return xml(res, null);

      const since = new Date(Date.now() - REPLY_WINDOW_MS).toISOString();
      const rows = await sbGet(`inspections?select=${VISIT_SELECT},jobs!inner(${JOB_SELECT})` +
        `&jobs.client_phone_norm=eq.${enc(from)}&ho_window_status=in.(offered,tentative)&ho_offered_at=gte.${enc(since)}` +
        `&status=in.(scheduled,in_progress)&order=ho_offered_at.desc&limit=1`);
      const visit = rows && rows[0];
      if (!visit) return xml(res, null); // never reply to unknown numbers
      const job = visit.jobs;
      const where = `id=eq.${enc(visit.id)}`;
      const repliedAt = nowISO();
      const replyCols = { ho_reply_text: text.slice(0, 200), ho_replied_at: repliedAt };

      const n = parseChoice(text);
      let reply;
      if (!n) {
        await sbPatch('inspections', where, { ho_window_status: 'tentative', ...replyCols }).catch((e) => warn('tentative patch', e.message));
        reply = hoFollowUpMessage();
      } else {
        const r = await chooseWindow({ visit, n, replyText: text, sbPatch, syncVisitJnTask, now: repliedAt });
        if (!r.ok) {
          await sbPatch('inspections', where, { ho_window_status: 'tentative', ...replyCols }).catch((e) => warn('tentative patch', e.message));
          reply = hoFollowUpMessage();
        } else if (r.status === 'tentative') {
          reply = hoTentativeMessage();
        } else {
          const today = todayIn(await tzFor(visit.location_id || job.location_id));
          reply = hoConfirmMessage(r.window, visit.scheduled_date, today);
        }
      }
      recordNotification({ job_id: job.id, kind: 'window_reply', dedupe_key: `reply:${visit.id}:${repliedAt}`, to_phone: toE164(params.From) || from, body: reply, sent_at: repliedAt });
      xml(res, reply);
    } catch (err) {
      warn('inbound', err.message);
      // Twilio retries on non-2xx; an empty TwiML keeps it quiet.
      xml(res, null);
    }
  });

  // ── Reminder sweep ────────────────────────────────────────────────────────
  let reminderRunning = false;
  async function sweepReminders() {
    if (reminderRunning) return;
    reminderRunning = true;
    try {
      const settings = await loadScheduleSettings().catch(() => null);
      const minutes = Number(settings && settings.ho_reminder_minutes) || 120;
      const cutoff = new Date(Date.now() - minutes * 60000).toISOString();
      const today = todayIn('America/Denver');
      const rows = (await sbGet(`inspections?select=${VISIT_SELECT},jobs(${JOB_SELECT})` +
        `&ho_window_status=eq.offered&ho_reminder_at=is.null&ho_offered_at=lt.${enc(cutoff)}&scheduled_date=gte.${today}` +
        `&status=in.(scheduled,in_progress)&order=ho_offered_at.asc&limit=100`)) || [];
      for (const v of rows) {
        const job = v.jobs;
        if (!job || job.is_active === false) continue;
        const tz = await tzFor(v.location_id || job.location_id);
        const h = hourIn(tz);
        if (h < 8 || h >= 20) continue;
        if (v.scheduled_date < todayIn(tz)) continue;
        const phone = toE164(job.client_phone || job.client_phone_norm);
        if (!phone) { await sbPatch('inspections', `id=eq.${enc(v.id)}`, { ho_reminder_at: nowISO() }).catch(() => {}); continue; }
        const options = Array.isArray(v.ho_window_options) ? v.ho_window_options : [];
        if (!options.length) continue;
        const url = await portalUrlFor(job, v.id);
        const body = hoReminderMessage(v.task_type, v.scheduled_date, todayIn(tz), options, url);
        let r;
        if (DRYRUN) { log('reminder dryrun →', phone.slice(-4), JSON.stringify(body)); r = { ok: true, sid: 'dryrun' }; }
        else r = await sendSms(phone, body);
        const at = nowISO();
        // Mark it even on failure — one reminder, never a loop.
        await sbPatch('inspections', `id=eq.${enc(v.id)}`, { ho_reminder_at: at }).catch((e) => warn('reminder patch', e.message));
        await recordNotification({ job_id: job.id, kind: 'window_reminder', dedupe_key: `reminder:${v.id}`, to_phone: phone, body, sms_sid: r.ok ? r.sid || null : null, sent_at: r.ok ? at : null, error: r.ok ? null : String(r.error || 'send failed').slice(0, 300) });
        if (!r.ok) warn('reminder failed', v.id, r.error);
      }
    } catch (e) { warn('reminder sweep', e.message); } finally { reminderRunning = false; }
  }
  if (!REMINDERS_DISABLED && (SMS_CONFIGURED || DRYRUN)) {
    setTimeout(sweepReminders, 2 * 60 * 1000).unref();
    setInterval(sweepReminders, 15 * 60 * 1000).unref();
  } else {
    log('reminder sweep off', REMINDERS_DISABLED ? '(HO_REMINDERS_DISABLED)' : '(Twilio not configured)');
  }

  return { sweepReminders };
};

module.exports.chooseWindow = chooseWindow;
module.exports.twilioSignature = twilioSignature;
module.exports.twilioSignatureOk = twilioSignatureOk;
module.exports.parseChoice = parseChoice;
module.exports.validOptions = validOptions;
module.exports.twiml = twiml;
module.exports.xmlEscape = xmlEscape;
