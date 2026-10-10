'use strict';
// ── Homeowner arrival-window texts ───────────────────────────────────────────
// Byte-for-byte twin of the DryOps app's lib/hoOffer.ts; both repos test the
// same fixture (test/fixtures/hoOfferMessage.json). Pure: dates are ISO
// strings, no clock, no timezone — the caller computes `today` in the
// location's zone. NEVER names the company (the texts go from a shared
// Twilio number or the dispatcher's own phone).

const HO_VISIT_WORD = {
  inspection: 'inspection',
  monitor: 'monitoring visit',
  demo: 'demo',
  closeout: 'equipment pickup',
};

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** First word of a name; "Last, First" → First. Trailing punctuation stripped. */
function firstName(full) {
  const t = String(full ?? '').trim();
  if (!t) return '';
  const afterComma = t.includes(',') ? (t.split(',')[1] || '').trim() : t;
  const word = (afterComma || t).split(/\s+/)[0] || '';
  return word.replace(/[,;.]+$/, '');
}

/** "today" / "tomorrow" / "on Tue Oct 14" — from ISO date strings only (UTC arithmetic). */
function dayWord(date, today) {
  if (date === today) return 'today';
  const [y, m, d] = String(today).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  const tomorrow = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
  if (date === tomorrow) return 'tomorrow';
  const [yy, mm, dd] = String(date).split('-').map(Number);
  const dt = new Date(Date.UTC(yy, mm - 1, dd));
  return `on ${DOW[dt.getUTCDay()]} ${MON[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
}

function fmtMin(min) {
  const h24 = Math.floor(min / 60) % 24;
  const m = min % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h24 < 12 ? 'am' : 'pm'}`;
}

/** "10am–12pm", "12:30pm–2:30pm" (en dash). */
function fmtWindow(w) {
  return `${fmtMin(w.startMin)}–${fmtMin(w.endMin)}`;
}

/**
 * With a portal `url` the homeowner taps to choose; reply 1/2 is always
 * mentioned as the fallback.
 */
function hoOfferMessage({ clientName, techName, taskType, date, today, options, url }) {
  const hi = firstName(clientName);
  const tech = firstName(techName);
  const who = tech ? `this is ${tech}, your restoration technician` : 'this is your restoration technician';
  const what = HO_VISIT_WORD[taskType] || 'visit';
  const when = dayWord(date, today);
  const [w1, w2] = options;
  const replies = w2
    ? `reply 1 for ${fmtWindow(w1)}, 2 for ${fmtWindow(w2)}`
    : `reply 1 for ${fmtWindow(w1)}`;
  if (url) {
    return `Hi${hi ? ` ${hi}` : ''}, ${who}. Pick a time for your ${what} ${when}: ${url} (or ${replies})`;
  }
  const ask = w2
    ? `would ${fmtWindow(w1)} (reply 1) or ${fmtWindow(w2)} (reply 2) work?`
    : `would ${fmtWindow(w1)} work? (reply 1)`;
  return `Hi${hi ? ` ${hi}` : ''}, ${who}. For your ${what} ${when}, ${ask} Reply and we'll lock it in.`;
}

/** Follow-up when a reply arrives but no window could be applied. */
function hoFollowUpMessage() {
  return "Thanks — we'll follow up to confirm a time.";
}

/** Reply when the chosen window collided with another booking (VS001). */
function hoTentativeMessage() {
  return "Thanks — we'll confirm the exact time shortly.";
}

/** Confirmation after a window is locked in. */
function hoConfirmMessage(w, date, today) {
  return `Got it — ${fmtWindow(w)} ${dayWord(date, today)}. Reply here if anything changes.`;
}

/** One reminder, sent once when nothing came back. */
function hoReminderMessage(taskType, date, today, options, url) {
  const what = HO_VISIT_WORD[taskType] || 'visit';
  const [w1, w2] = options;
  const replies = w2 ? `reply 1 for ${fmtWindow(w1)} or 2 for ${fmtWindow(w2)}` : `reply 1 for ${fmtWindow(w1)}`;
  return `Quick reminder from your restoration technician: ${url ? `pick a time at ${url} or ` : ''}${replies} for your ${what} ${dayWord(date, today)}.`;
}

module.exports = {
  HO_VISIT_WORD, firstName, dayWord, fmtMin, fmtWindow,
  hoOfferMessage, hoFollowUpMessage, hoTentativeMessage, hoConfirmMessage, hoReminderMessage,
};
