"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computePayout = computePayout;
// From one commission_feed document to the jobs, ledger and next payout. The app
// screen (components/commissions/useCommissions.ts) and dryops-server's payroll
// reminder (a compiled copy in vendor/commissions) both run this, so the amount in
// the reminder is the amount on the screen. Pinned by
// lib/__tests__/fixtures/commissionPayout.json in both repos.
const rules_1 = require("./rules");
const payroll_1 = require("./payroll");
const payout_1 = require("./payout");
/**
 * @param photo JobNimbus "a photo by the rep" answers for unlanded after-hours jobs,
 *   by job id. A job missing from it is treated as not checked (no credit taken).
 */
function computePayout(feed, photo = {}) {
    const latest = (0, rules_1.latestApproved)(feed.corrections);
    const jobs = (0, rules_1.includedJobs)(feed.jobs, latest).map(j => (0, rules_1.computeJob)(j, latest, photo[j.id]));
    const lines = [...jobs.flatMap(j => j.lines), ...(0, rules_1.manualLines)(feed.corrections)];
    // A response line we can't verify right now must not turn into a credit.
    const unverified = new Set(jobs.filter(j => j.flags.includes('photo_unchecked')).map(j => `job:${j.job.id}:after_hours_response`));
    // The next payout: this month's until a week after its payday, then next month's.
    const payoutMonth = feed.today ? (0, payroll_1.payoutMonthOn)(feed.today) : feed.now_month;
    const ledger = (0, payout_1.buildLedger)(lines, feed.payments, feed.corrections, payoutMonth, unverified);
    return {
        jobs,
        ledger,
        next: (0, payout_1.nextPayout)(ledger.lines, payoutMonth),
        split: (0, payout_1.splitByLocation)(ledger.lines, payoutMonth),
    };
}
