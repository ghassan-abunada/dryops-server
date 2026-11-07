'use strict';
// Commission payroll reminder (owner 2026-11-07). Payroll is every other Friday from
// 2026-10-23, processed the Wednesday before; commission goes on the SECOND payroll
// of each month and the payroll manager needs the amount on that week's Tuesday.
// So on that Tuesday, from 8 AM Central, everyone who manages commissions (admins
// and the people an admin approved in the app's Access sheet, never the rep
// himself) gets an email and a push with the amount to add.
//
// The amount is the app's own calculation: vendor/commissions is compiled from the
// app's lib/commissions (`npm run vendor:commissions` there), pinned by
// test/fixtures/commissionPayout.json in both repos.
//
//   POST /commissions/reminder/run              admin: what it would send (dry run)
//   POST /commissions/reminder/run {"send":true} admin: send it now (logged)
const { computePayout } = require('./vendor/commissions/commissions/compute');
const { commissionPayday, commissionReminderDay, shortDate } = require('./vendor/commissions/commissions/payroll');
const { LINE_LABEL, isUnlandedAfterHours, latestApproved, includedJobs } = require('./vendor/commissions/commissions/rules');
const { monthLabel } = require('./vendor/commissions/commissions/payout');

const TZ = 'America/Chicago';
const SEND_FROM_HOUR = 8;
const CHECK_EVERY_MS = 30 * 60 * 1000;

function money(n) {
  const v = Number(n || 0), abs = Math.abs(v);
  const text = Number.isInteger(abs) ? abs.toLocaleString('en-US') : abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v < 0 ? '-' : ''}$${text}`;
}

/** Central wall clock: { date: 'YYYY-MM-DD', hour }. */
function centralNow(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(now).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
}

/** Is it reminder time, and for which payout month? */
function reminderDue(now = new Date()) {
  const { date, hour } = centralNow(now);
  const month = date.slice(0, 7);
  return { due: date === commissionReminderDay(month) && hour >= SEND_FROM_HOUR, month, date };
}

/** The message for one rep's payout. Pure. */
function buildMessage({ repName, payoutMonth, comp, appUrl }) {
  const { next, split } = comp;
  const payday = commissionPayday(payoutMonth);
  const workMonth = monthLabel(addMonth(payoutMonth, -1));
  const amount = next.total;
  const title = `Commission for the ${shortDate(payday)} payroll: ${money(amount)}`;
  const body = amount > 0
    ? `Add ${money(amount)} for ${repName} to the payroll processed Wednesday (${workMonth} jobs${next.applied.length ? `, after ${next.applied.length} credit${next.applied.length === 1 ? '' : 's'}` : ''}).`
    : `Nothing to add for ${repName} on this payroll.${next.carried.length ? ` ${next.carried.length} credit${next.carried.length === 1 ? '' : 's'} wait for the next one.` : ''}`;

  const kinds = new Map();
  for (const l of next.lines) {
    if (l.status === 'credit') continue;
    const k = kinds.get(l.kind) || { label: LINE_LABEL[l.kind] || l.label, amount: 0, count: 0 };
    k.amount += l.owed; k.count += 1; kinds.set(l.kind, k);
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const row = (left, right, muted) => `<tr><td style="padding:4px 0;font-size:14px;color:${muted ? '#475569' : '#0F172A'}">${left}</td><td style="padding:4px 0;font-size:14px;text-align:right;font-weight:700;color:#0F172A">${right}</td></tr>`;
  const section = (heading, rows) => rows.length ? `<p style="margin:18px 0 4px;font-size:12px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:#334155">${heading}</p><table style="width:100%;border-collapse:collapse">${rows.join('')}</table>` : '';
  const creditRow = (l) => row(`${esc(l.jobLabel || l.label)}<br><span style="font-size:12px;color:#475569">${esc(LINE_LABEL[l.kind] || l.label)}: paid ${money(l.paid)}, now worth ${money(l.amount)}</span>`, money(l.owed));

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;color:#0F172A">
<p style="margin:0 0 4px;font-size:13px;color:#475569">Commission for ${esc(repName)} · payroll processed Wednesday, paid ${esc(shortDate(payday))}</p>
<p style="margin:0;font-size:34px;font-weight:800">${money(amount)}</p>
<p style="margin:4px 0 0;font-size:14px;color:#334155">${amount > 0 ? `Add this to the ${esc(shortDate(payday))} payroll.` : 'Nothing to add to this payroll.'} For ${esc(workMonth)} jobs${next.applied.length ? `: ${money(next.gross)} in bonuses less ${money(-next.applied.reduce((s, l) => s + l.owed, 0))} in credits` : ''}.</p>
${section('Bonuses', [...kinds.values()].map(k => row(`${esc(k.label)}${k.count > 1 ? ` x ${k.count}` : ''}`, money(k.amount))))}
${section(`Credits taken (${next.applied.length})`, next.applied.map(creditRow))}
${section(`Waiting for the next payout (${next.carried.length})`, next.carried.map(creditRow))}
${section('By location', split.map(s => row(esc(s.locationName), money(s.total), false)))}
<p style="margin:22px 0 0"><a href="${esc(appUrl)}/commissions" style="display:inline-block;background:#0369A1;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 18px;border-radius:10px">Open Commissions</a></p>
<p style="margin:14px 0 0;font-size:12px;color:#475569">Mark it paid in Commissions once payroll goes out, so the next payout starts from there.</p>
</div>`;
  return { title, body, html, amount };
}

function addMonth(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function createReminder(deps) {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, sbGet, sendEmail, push, jnGetJson, appUrl, log = console } = deps;
  const headers = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' };

  async function rpc(fn, body) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${fn} ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }

  async function emailOf(profileId) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(profileId)}`, { headers });
    if (!r.ok) return null;
    const u = await r.json().catch(() => null);
    return (u && u.email) || null;
  }

  /** Did the rep upload a photo to this JobNimbus job? null when JobNimbus can't answer. */
  async function photoByRep(jnId, repName) {
    const want = String(repName || '').trim().toLowerCase();
    try {
      for (let from = 0; from < 2000; from += 200) {
        const j = await jnGetJson(`files?size=200&from=${from}&related=${encodeURIComponent(jnId)}`);
        const files = (j && j.files) || [];
        if (files.some(f => (f.subtype === 'image' || String(f.content_type || '').startsWith('image/')) && String(f.created_by_name || '').trim().toLowerCase() === want)) return true;
        if (files.length < 200) return false;
      }
      return false;
    } catch (e) { return null; }
  }

  async function recipientsFor(repId) {
    const admins = (await sbGet('profiles?role=eq.admin&select=id')) || [];
    const managers = (await sbGet('commission_managers?select=profile_id')) || [];
    return [...new Set([...admins.map(a => a.id), ...managers.map(m => m.profile_id)])].filter(id => id !== repId);
  }

  /** What one rep's reminder says for the current payout. */
  async function prepare(rep) {
    const feed = await rpc('commission_feed', { p_rep: rep.profile_id });
    if (!feed) throw new Error(`no feed for ${rep.rep_name}`);
    const latest = latestApproved(feed.corrections || []);
    const photo = {};
    for (const job of includedJobs(feed.jobs || [], latest)) {
      if (!job.jn_id || job.photo_by_rep || !isUnlandedAfterHours(job, latest)) continue;
      const answer = await photoByRep(job.jn_id, rep.rep_name);
      if (answer !== null) photo[job.id] = answer;
    }
    const comp = computePayout(feed, photo);
    return { feed, comp, message: buildMessage({ repName: rep.rep_name, payoutMonth: feed.now_month, comp, appUrl }) };
  }

  async function alreadySent(repId, payoutMonth) {
    const rows = await sbGet(`commission_reminders?rep_id=eq.${repId}&payout_month=eq.${payoutMonth}&select=id&limit=1`);
    return Array.isArray(rows) && rows.length > 0;
  }

  async function logSent(row) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/commission_reminders`, { method: 'POST', headers: { ...headers, Prefer: 'return=minimal' }, body: JSON.stringify(row) });
    if (!r.ok) log.warn('[commission-reminder] log failed', r.status, (await r.text()).slice(0, 200));
  }

  /** Send (or with dryrun, only describe) every rep's reminder. */
  async function run({ dryrun = true, force = false } = {}) {
    const reps = (await sbGet('commission_reps?select=profile_id,rep_name')) || [];
    const out = [];
    for (const rep of reps) {
      try {
        const { feed, message } = await prepare(rep);
        const payoutMonth = feed.now_month;
        const ids = await recipientsFor(rep.profile_id);
        const emails = (await Promise.all(ids.map(emailOf))).filter(Boolean);
        const entry = { rep: rep.rep_name, payout_month: payoutMonth, payday: commissionPayday(payoutMonth), amount: message.amount, title: message.title, body: message.body, recipients: emails };
        if (dryrun) { out.push({ ...entry, sent: false, html: message.html }); continue; }
        if (!force && await alreadySent(rep.profile_id, payoutMonth)) { out.push({ ...entry, sent: false, reason: 'already sent' }); continue; }
        const mail = await Promise.all(emails.map(to => sendEmail(to, message.title, message.html)));
        const pushed = await push.toProfiles(ids, { title: message.title, body: message.body, data: { url: '/commissions', kind: 'commission_reminder' } }, 'commission_reminder');
        await logSent({ rep_id: rep.profile_id, payout_month: payoutMonth, amount: message.amount, recipients: emails, emails_sent: mail.filter(m => m && m.ok).length, pushes_sent: pushed });
        out.push({ ...entry, sent: true, emails_sent: mail.filter(m => m && m.ok).length, email_errors: mail.filter(m => !m || !m.ok).map(m => m && m.error), pushes_sent: pushed });
      } catch (e) {
        log.error('[commission-reminder]', rep.rep_name, e.message);
        out.push({ rep: rep.rep_name, error: e.message });
      }
    }
    return out;
  }

  async function tick() {
    try {
      if (!reminderDue().due) return;
      const result = await run({ dryrun: false });
      if (result.some(r => r.sent)) log.log('[commission-reminder] sent', result.map(r => ({ rep: r.rep, amount: r.amount, emails: r.emails_sent, pushes: r.pushes_sent })));
    } catch (e) {
      log.error('[commission-reminder] tick failed', e.message);
    }
  }

  return { run, tick, prepare };
}

module.exports = function mountCommissionReminder(app, deps) {
  const reminder = createReminder(deps);
  app.post('/commissions/reminder/run', deps.requireAuth, deps.requireAdmin, async (req, res) => {
    try {
      const send = !!(req.body && req.body.send === true);
      res.json({ dryrun: !send, results: await reminder.run({ dryrun: !send, force: send }) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  if (deps.schedule !== false && deps.SUPABASE_SERVICE_KEY) {
    setTimeout(reminder.tick, 5 * 60 * 1000);
    setInterval(reminder.tick, CHECK_EVERY_MS);
  }
  return reminder;
};

module.exports.buildMessage = buildMessage;
module.exports.reminderDue = reminderDue;
module.exports.centralNow = centralNow;
module.exports.createReminder = createReminder;
