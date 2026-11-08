"use strict";
// The payroll calendar (owner 2026-11-07): payroll is every other Friday, counting
// from Friday 2026-10-23, processed the Wednesday before. Commission goes on the
// FIRST payroll of each month (owner, later 2026-11-07), and the payroll manager
// needs the amount on the Tuesday of that week. When that Tuesday would fall in the
// month before (a payday on the 1st to 3rd, e.g. Fri 1/1/2027), the month being
// paid isn't over yet, so commission moves to the next payroll (owner's choice).
// Pure date math on YYYY-MM-DD strings (no time zones).
// dryops-server runs a compiled copy of this file (vendor/commissions).
Object.defineProperty(exports, "__esModule", { value: true });
exports.PAYOUT_GRACE_DAYS = exports.PAYROLL_ANCHOR = void 0;
exports.addDays = addDays;
exports.paydaysIn = paydaysIn;
exports.commissionPayday = commissionPayday;
exports.payoutMonthOn = payoutMonthOn;
exports.commissionReminderDay = commissionReminderDay;
exports.shortDate = shortDate;
exports.PAYROLL_ANCHOR = '2026-10-23';
const DAY_MS = 86400000;
const PERIOD_DAYS = 14;
function toUtc(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
}
function fromUtc(ms) {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function addDays(iso, n) {
    return fromUtc(toUtc(iso) + n * DAY_MS);
}
/** Every payday in a month (YYYY-MM), in order. */
function paydaysIn(month) {
    const [y, m] = month.split('-').map(Number);
    const first = Date.UTC(y, m - 1, 1);
    const next = Date.UTC(y, m, 1);
    const anchor = toUtc(exports.PAYROLL_ANCHOR);
    // First payday on or after the 1st, stepping from the anchor in either direction.
    const steps = Math.ceil((first - anchor) / (PERIOD_DAYS * DAY_MS));
    const out = [];
    for (let t = anchor + steps * PERIOD_DAYS * DAY_MS; t < next; t += PERIOD_DAYS * DAY_MS)
        out.push(fromUtc(t));
    return out;
}
/** The payroll commission goes on: the month's first payday whose Tuesday reminder is in the month. */
function commissionPayday(month) {
    return paydaysIn(month).find(d => addDays(d, -3).slice(0, 7) === month);
}
/** Days after a commission payday it still counts as the current payout, so lines marked paid a little late land on it. */
exports.PAYOUT_GRACE_DAYS = 7;
/**
 * Which month's payout is next on a given day (YYYY-MM-DD): this month's until a
 * week after its commission payday, then next month's.
 */
function payoutMonthOn(today) {
    const month = today.slice(0, 7);
    if (today <= addDays(commissionPayday(month), exports.PAYOUT_GRACE_DAYS))
        return month;
    const [y, m] = month.split('-').map(Number);
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
/** Payroll is processed on Wednesday; the amount is needed the Tuesday before. */
function commissionReminderDay(month) {
    return addDays(commissionPayday(month), -3);
}
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** "Fri 12/18" */
function shortDate(iso) {
    const d = new Date(toUtc(iso));
    return `${DAYS[d.getUTCDay()]} ${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}
