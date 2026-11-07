"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inPayout = inPayout;
exports.addMonths = addMonths;
exports.monthLabel = monthLabel;
exports.payoutLabel = payoutLabel;
exports.payoutPhrase = payoutPhrase;
exports.payoutMonthFor = payoutMonthFor;
exports.buildLedger = buildLedger;
exports.splitByLocation = splitByLocation;
exports.nextPayout = nextPayout;
exports.paymentRowsFor = paymentRowsFor;
// What has been paid, what is owed and which payout it belongs to. Paid amounts
// are frozen: owed = expected - paid, per line key, so a late landing, a late
// pack-out or more money collected after close lands on the next payout by itself.
// The other direction works the same way (owner 2026-11-07): a paid line now worth
// less (insurance turned out not to be, a pack-out never sold) becomes a credit
// taken off the next payout. A payout never goes below $0: credits are taken whole,
// oldest first, while they fit, and the rest wait for the next one.
const rules_1 = require("./rules");
const payroll_1 = require("./payroll");
/** What this line contributes to one payout: paid on it, plus still open on it. */
function inPayout(l, payoutMonth) {
    return {
        paid: l.paidIn[payoutMonth] || 0,
        open: l.status !== 'paid' && l.payoutMonth === payoutMonth ? l.owed : 0,
    };
}
function addMonths(month, n) {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function monthLabel(month) {
    const [y, m] = month.split('-').map(Number);
    return `${MONTHS[m - 1]} ${y}`;
}
/** "Second payroll of December, Fri 12/18" */
function payoutLabel(payoutMonth) {
    const [, m] = payoutMonth.split('-').map(Number);
    return `Second payroll of ${MONTHS[m - 1]}, ${(0, payroll_1.shortDate)((0, payroll_1.commissionPayday)(payoutMonth))}`;
}
/** The same payout inside a sentence: "paid on the second payroll of December (Fri 12/18)". */
function payoutPhrase(payoutMonth) {
    const [, m] = payoutMonth.split('-').map(Number);
    return `second payroll of ${MONTHS[m - 1]} (${(0, payroll_1.shortDate)((0, payroll_1.commissionPayday)(payoutMonth))})`;
}
/** A month's earnings go out on the second payroll of the month after it. */
function payoutMonthFor(earnedMonth) {
    return addMonths(earnedMonth, 1);
}
/** "job:<id>:insurance_landed" -> insurance_landed; a manual line is "manual:<id>". */
function kindOfKey(key) {
    if (key.startsWith('manual:'))
        return 'manual';
    const kind = key.split(':')[2];
    return kind in rules_1.LINE_LABEL ? kind : 'manual';
}
/**
 * @param unverified line keys whose expected amount can't be known right now (the
 *   JobNimbus photo lookup failed): a payment on one never turns into a credit.
 */
function buildLedger(lines, payments, corrections, nowMonth, unverified = new Set()) {
    const paidByKey = new Map();
    for (const p of payments) {
        const list = paidByKey.get(p.line_key);
        if (list)
            list.push(p);
        else
            paidByKey.set(p.line_key, [p]);
    }
    const sum = (list) => (list || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const newest = (list) => list.reduce((a, b) => (b.paid_on > a.paid_on ? b : a));
    const byPayout = (list) => {
        const out = {};
        for (const p of list || [])
            out[p.payout_month] = (out[p.payout_month] || 0) + (Number(p.amount) || 0);
        return out;
    };
    // The owner can choose to leave an over-payment alone (Keep as paid).
    const kept = new Set();
    for (const c of corrections) {
        if (c.status !== 'approved' || !c.value)
            continue;
        if (c.field === 'keep_paid' && c.value.key)
            kept.add(c.value.key);
        if (c.field === 'manual_line' && c.value.offsets)
            kept.add(c.value.offsets);
    }
    const ledger = [];
    const credits = [];
    const seen = new Set();
    for (const line of lines) {
        seen.add(line.key);
        const rows = paidByKey.get(line.key);
        const paid = sum(rows);
        const diff = line.amount - paid;
        const paidOn = rows ? newest(rows).paid_on : null;
        const paidIn = byPayout(rows);
        const holdBack = unverified.has(line.key) || kept.has(line.key);
        if (diff < 0 && !holdBack) {
            // Worth less than what has gone out (or a deduction not yet taken).
            credits.push({ ...line, paid, owed: diff, status: 'credit', payoutMonth: nowMonth, paidOn, paidIn });
            continue;
        }
        const owed = Math.max(0, diff);
        const payable = line.month < nowMonth || line.kind === 'large_job';
        const status = owed === 0 ? 'paid' : payable ? 'due' : 'earning';
        const payoutMonth = owed === 0 && rows ? newest(rows).payout_month : payable ? nowMonth : payoutMonthFor(line.month);
        ledger.push({ ...line, paid, owed, status, payoutMonth, paidOn, paidIn });
    }
    // Paid lines that no longer exist at all (the job stopped counting): all of it back.
    for (const [key, rows] of paidByKey) {
        if (seen.has(key))
            continue;
        const paid = sum(rows);
        const r = rows[0];
        const line = {
            key, kind: kindOfKey(key), jobId: r.job_id, locationId: r.location_id, locationName: r.location_name,
            month: r.earned_month, amount: 0, label: r.label, jobLabel: r.job_label,
            paid, owed: -paid, status: 'credit', payoutMonth: nowMonth, paidOn: newest(rows).paid_on, paidIn: byPayout(rows),
        };
        if (paid > 0 && !unverified.has(key) && !kept.has(key))
            credits.push(line);
        else
            ledger.push({ ...line, owed: 0, status: 'paid', payoutMonth: newest(rows).payout_month });
    }
    // Never below $0: whole credits, oldest first, while they fit under this payout.
    credits.sort((a, b) => a.month.localeCompare(b.month) || (a.paidOn || '').localeCompare(b.paidOn || '') || a.key.localeCompare(b.key));
    let room = ledger.filter(l => l.status === 'due').reduce((s, l) => s + l.owed, 0);
    let blocked = false;
    for (const c of credits) {
        if (!blocked && -c.owed <= room) {
            room += c.owed;
        }
        else {
            blocked = true; // strictly in order: a later small credit never jumps an older one
            c.carried = true;
            c.payoutMonth = addMonths(nowMonth, 1);
        }
    }
    return { lines: [...ledger, ...credits], credits };
}
/**
 * One payout, per location: what was paid on it plus what is still open on it. A
 * location's total can be negative when a credit belongs to it: the paying location
 * returns that much to it.
 */
function splitByLocation(lines, payoutMonth) {
    const map = new Map();
    for (const l of lines) {
        const { paid, open } = inPayout(l, payoutMonth);
        if (paid === 0 && open === 0)
            continue;
        const key = l.locationId || 'none';
        let row = map.get(key);
        if (!row) {
            row = { locationId: l.locationId, locationName: l.locationName || 'No location', paid: 0, owed: 0, total: 0 };
            map.set(key, row);
        }
        row.paid += paid;
        row.owed += open;
        row.total = row.paid + row.owed;
    }
    return [...map.values()].sort((a, b) => b.total - a.total || a.locationName.localeCompare(b.locationName));
}
/** The rep's expected payment and what is building for the one after. */
function nextPayout(lines, nowMonth) {
    const due = lines.filter(l => l.status === 'due' && l.owed !== 0);
    const applied = lines.filter(l => l.status === 'credit' && !l.carried);
    const carried = lines.filter(l => l.status === 'credit' && l.carried);
    const earning = lines.filter(l => l.status === 'earning');
    const gross = due.reduce((s, l) => s + l.owed, 0);
    return {
        payoutMonth: nowMonth,
        total: Math.max(0, gross + applied.reduce((s, l) => s + l.owed, 0)),
        lines: [...due, ...applied],
        gross,
        applied,
        carried,
        earningNow: earning.reduce((s, l) => s + l.owed, 0),
        earningPayoutMonth: payoutMonthFor(nowMonth),
    };
}
/** Payment rows to insert for the given lines, at what is owed on each today. */
function paymentRowsFor(lines, repId, paidOn) {
    return lines.filter(l => l.owed !== 0).map(l => ({
        rep_id: repId,
        line_key: l.key,
        job_id: l.jobId,
        location_id: l.locationId,
        location_name: l.locationName,
        earned_month: l.month,
        payout_month: l.payoutMonth,
        amount: l.owed,
        label: l.label,
        job_label: l.jobLabel,
        paid_on: paidOn,
    }));
}
