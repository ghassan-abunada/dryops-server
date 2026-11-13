"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clock = exports.CONTENTS_STATUS_META = exports.STORAGE_KIND_LABEL = exports.EMPTY_CONTENTS_REVIEW = void 0;
exports.daysBetween = daysBetween;
exports.leadTiming = leadTiming;
exports.contentsAutoChecks = contentsAutoChecks;
exports.seedContentsReview = seedContentsReview;
exports.contentsMissingByStep = contentsMissingByStep;
exports.contentsMissing = contentsMissing;
exports.canSubmitContents = canSubmitContents;
exports.contentsStatus = contentsStatus;
exports.contentsNeedsAction = contentsNeedsAction;
exports.walkCell = walkCell;
exports.packoutCell = packoutCell;
exports.storageCell = storageCell;
exports.contentsNoteFacts = contentsNoteFacts;
exports.buildContentsWyhNote = buildContentsWyhNote;
exports.contentsCounts = contentsCounts;
// Wash Your Hands for Contents (packout) locations (owner 2026-11-13).
//
// A Contents lead is a job a mitigation company referred, not a Google call,
// so there is no recording to listen to. The review checks the file: walked,
// landed, the work authorization signed, a wide photo of each room, carrier
// and claim number listed, what was sold (offsite storage or a manipulation),
// the pack-out scheduled in a timely manner (the reviewer answers from the
// day counts), then coaching, then the `WYH - First Last` note on the job.
//
// Pure. dryops-server vendors this file (scripts/vendor-contents.sh) to write
// the JobNimbus note; lib/__tests__/fixtures/wyhContents.json pins both.
// Feed: supabase/add_wyh_contents.sql (wyh_contents_leads).
const contentsReport_1 = require("./contentsReport");
Object.defineProperty(exports, "clock", { enumerable: true, get: function () { return contentsReport_1.clock; } });
exports.EMPTY_CONTENTS_REVIEW = {
    walked: null, landed: null, not_landed_note: null, work_auth_signed: null, photo_wide: null, has_carrier: null, has_claim: null,
    storage_kind: null, packout_timely: null, info_sufficient: null, notes: null,
    operator_feedback_given: null, operator_feedback: null, operator_response: null,
    needs_follow_up: false, follow_up_reason: null, follow_up_note: null,
};
exports.STORAGE_KIND_LABEL = {
    offsite: 'Offsite storage', manipulation: 'Content manipulation', both: 'Offsite storage + manipulation', none: 'Neither sold',
};
/** Job stages that mean the customer said yes (lib/format LANDED_STAGES, kept here so this file stays self-contained for the server). */
const LANDED = ['In Production', 'Account Receivable', 'Completed'];
const LOST = ['Lost'];
function walkReport(lead) {
    return lead.walk_report && typeof lead.walk_report === 'object' ? (0, contentsReport_1.normalizeContentsReport)('initial_walk', lead.walk_report) : null;
}
/** Whole calendar days from one date to another (YYYY-MM-DD or ISO), never negative; null when either is missing. */
function daysBetween(from, to) {
    if (!from || !to)
        return null;
    const a = Date.parse(String(from).slice(0, 10) + 'T00:00:00Z');
    const b = Date.parse(String(to).slice(0, 10) + 'T00:00:00Z');
    if (!Number.isFinite(a) || !Number.isFinite(b))
        return null;
    return Math.max(0, Math.round((b - a) / 86400000));
}
const dayWord = (n) => (n === 0 ? 'the same day' : n === 1 ? '1 day' : `${n} days`);
/** The day counts the review shows; `today` is YYYY-MM-DD. */
function leadTiming(lead, today) {
    const walked = lead.walk_status === 'completed';
    const walkDays = daysBetween(lead.created_at, lead.walk_date);
    const packoutDays = daysBetween(lead.walk_date, lead.packout_date);
    const what = lead.packout_task_type === 'content_manipulation' ? 'Manipulation' : 'Pack-out';
    const parts = [];
    if (walked && walkDays !== null)
        parts.push(walkDays === 0 ? 'Walked the day it was referred' : `Walked ${dayWord(walkDays)} after referral`);
    else if (lead.walk_date)
        parts.push(`Walk booked for ${(0, contentsReport_1.shortDay)(lead.walk_date)}, not done yet`);
    else {
        const waiting = daysBetween(lead.created_at, today);
        parts.push(`Not walked yet${waiting !== null ? ` · ${dayWord(waiting)} since referral` : ''}`);
    }
    if (lead.packout_date) {
        parts.push(packoutDays !== null && lead.walk_date
            ? (packoutDays === 0 ? `${what} scheduled for the day of the walk` : `${what} scheduled ${dayWord(packoutDays)} after the walk`)
            : `${what} scheduled for ${(0, contentsReport_1.shortDay)(lead.packout_date)}`);
    }
    else
        parts.push(`No ${what.toLowerCase()} on the schedule`);
    return { walkDays, packoutDays, line: parts.join(' · ') };
}
/** What the file already answers; null = the reviewer has to look. Timeliness is always the reviewer's call. */
function contentsAutoChecks(lead) {
    const report = walkReport(lead);
    const out = {};
    if (lead.walk_status === 'completed')
        out.walked = 'yes';
    else if (lead.walk_date)
        out.walked = 'not_yet';
    if (LANDED.includes(lead.stage ?? ''))
        out.landed = true;
    else if (LOST.includes(lead.stage ?? ''))
        out.landed = false;
    if (report && report.work_auth.status)
        out.work_auth_signed = report.work_auth.status === 'signed';
    if (report && report.rooms.length)
        out.photo_wide = report.rooms.every(r => r.wide_photo);
    out.has_carrier = !!(lead.insurer && lead.insurer.trim());
    out.has_claim = !!(lead.claim_number && lead.claim_number.trim());
    const service = lead.contents_service ?? report?.service ?? null;
    if (service === 'offsite' || service === 'manipulation' || service === 'both')
        out.storage_kind = service;
    else if (lead.in_storage || (lead.storage_vaults ?? 0) > 0)
        out.storage_kind = 'offsite';
    return out;
}
/** A new review seeded from the file; an existing one keeps its answers. */
function seedContentsReview(lead) {
    return lead.review ? { ...exports.EMPTY_CONTENTS_REVIEW, ...lead.review } : { ...exports.EMPTY_CONTENTS_REVIEW, ...contentsAutoChecks(lead) };
}
/** What is still unanswered, per step. A job that was not walked, or did not land, stops there. */
function contentsMissingByStep(r) {
    const checklist = [];
    const coaching = [];
    if (!r.walked)
        checklist.push('Was it walked?');
    if (r.walked === 'yes') {
        if (r.landed === null)
            checklist.push('Did it land?');
        if (r.landed === false && !(r.not_landed_note ?? '').trim())
            checklist.push('Why it did not land');
        if (r.landed === true) {
            if (r.work_auth_signed === null)
                checklist.push('Work authorization signed?');
            if (r.photo_wide === null)
                checklist.push('Wide photos of each room?');
            if (r.has_carrier === null)
                checklist.push('Carrier listed?');
            if (r.has_claim === null)
                checklist.push('Claim number listed?');
            if (!r.storage_kind)
                checklist.push('Offsite storage or manipulation?');
            if (r.packout_timely === null)
                checklist.push('Pack-out scheduled in a timely manner?');
            if (r.info_sufficient === null)
                checklist.push('Enough information in the file?');
        }
    }
    if (r.walked === 'yes') {
        if (r.operator_feedback_given === null)
            coaching.push('Was feedback given?');
        else if (r.operator_feedback_given && !(r.operator_feedback ?? '').trim())
            coaching.push('What feedback was given?');
    }
    return { checklist, coaching, submit: [] };
}
function contentsMissing(r) {
    const m = contentsMissingByStep(r);
    return [...m.checklist, ...m.coaching];
}
/** Submit is allowed when everything is answered, or when the reviewer flagged a follow up with a reason. */
function canSubmitContents(r) {
    if (r.walked === 'not_yet')
        return false; // parked until the walk happens
    return contentsMissing(r).length === 0 || (r.needs_follow_up && !!(r.follow_up_reason ?? '').trim());
}
exports.CONTENTS_STATUS_META = {
    complete: { label: 'Complete', tone: 'green' },
    note_failed: { label: 'Note failed', tone: 'red' },
    follow_up: { label: 'Follow up', tone: 'amber' },
    not_walked: { label: 'Not walked yet', tone: 'gray' },
    in_progress: { label: 'In progress', tone: 'blue' },
    ready: { label: 'Ready for WYH', tone: 'blue' },
};
function contentsStatus(lead) {
    const r = lead.review;
    if (r?.status === 'complete')
        return r.jn_note_error ? 'note_failed' : r.needs_follow_up && !r.follow_up_resolved_at ? 'follow_up' : 'complete';
    if (r?.needs_follow_up && !r.follow_up_resolved_at)
        return 'follow_up';
    if (lead.walk_status !== 'completed' && r?.walked !== 'yes')
        return 'not_walked';
    return r ? 'in_progress' : 'ready';
}
/** Does this lead still need someone? (the header's "n need action") */
function contentsNeedsAction(lead) {
    const s = contentsStatus(lead);
    return s === 'ready' || s === 'in_progress' || s === 'follow_up' || s === 'note_failed';
}
/** The table's Walk cell: "Walked Mon 11/10" / "Booked Tue 11/11" / "Not booked". */
function walkCell(lead) {
    if (lead.walk_status === 'completed' && lead.walk_date)
        return { text: `Walked ${(0, contentsReport_1.shortDay)(lead.walk_date)}`, tone: 'green' };
    if (lead.walk_date)
        return { text: `Booked ${(0, contentsReport_1.shortDay)(lead.walk_date)}`, tone: 'gray' };
    return { text: 'Not booked', tone: 'red' };
}
/** The table's Pack-out cell. */
function packoutCell(lead) {
    const what = lead.packout_task_type === 'content_manipulation' ? 'Manip.' : 'PO';
    if (lead.packout_status === 'completed' && lead.packout_date)
        return { text: `${what} done ${(0, contentsReport_1.shortDay)(lead.packout_date)}`, tone: 'green' };
    if (lead.packout_date)
        return { text: `${what} ${(0, contentsReport_1.shortDay)(lead.packout_date)}`, tone: 'gray' };
    return { text: '—', tone: 'gray' };
}
/** The table's Storage cell: what was sold. */
function storageCell(lead) {
    const kind = contentsAutoChecks(lead).storage_kind;
    if (!kind)
        return '—';
    const vaults = (lead.storage_vaults ?? 0) > 0 ? ` · ${lead.storage_vaults}` : '';
    return kind === 'manipulation' ? 'Manipulation' : kind === 'both' ? `Offsite + manip.${vaults}` : `Offsite${vaults}`;
}
function contentsNoteFacts(lead, today) {
    return {
        referred_on: (0, contentsReport_1.shortDay)(String(lead.created_at).slice(0, 10)),
        referred_by: lead.referred_by,
        timing: leadTiming(lead, today).line,
        walked_on: lead.walk_status === 'completed' && lead.walk_date ? (0, contentsReport_1.shortDay)(lead.walk_date) : null,
        insurer: lead.insurer,
        claim_number: lead.claim_number,
    };
}
const box = (v) => (v === true ? '[✓]' : '[ ]');
const txt = (v, max = 600) => (v === undefined || v === null ? '' : String(v)).trim().slice(0, max);
/**
 * The `WYH - First Last` note for a Contents job. Head line, the checklist as
 * ticked boxes, what still needs doing, the coaching, the follow up, the notes.
 * JobNimbus @tags are appended by the server (two blank lines, one per line).
 */
function buildContentsWyhNote(i) {
    const r = { ...exports.EMPTY_CONTENTS_REVIEW, ...i.review };
    const f = i.facts;
    const lines = [`WYH - ${txt(i.managerName, 80) || 'DryOps'}`];
    lines.push(`Packout: referred ${txt(f.referred_on, 40)}${txt(f.referred_by, 120) ? ` by ${txt(f.referred_by, 120)}` : ''}`);
    lines.push('');
    lines.push('Checklist');
    if (r.walked === 'yes')
        lines.push(`[✓] Walked${txt(f.walked_on, 40) ? ` (${txt(f.walked_on, 40)})` : ''}`);
    else
        lines.push(`[ ] Walked${r.walked === 'not_yet' ? ' (not yet)' : ''}`);
    const actions = [];
    if (r.walked === 'no')
        actions.push('Walk the job with the customer');
    if (r.walked === 'yes') {
        lines.push(r.landed === false ? `[ ] Landed${txt(r.not_landed_note) ? ` (${txt(r.not_landed_note)})` : ''}` : `${box(r.landed)} Landed`);
        if (r.landed === true) {
            lines.push(`${box(r.work_auth_signed)} Work authorization signed`);
            lines.push(`${box(r.photo_wide)} Wide photos of each room`);
            lines.push(`${box(r.has_carrier)} Carrier listed${r.has_carrier && txt(f.insurer, 120) ? ` (${txt(f.insurer, 120)})` : ''}`);
            lines.push(`${box(r.has_claim)} Claim number listed${r.has_claim && txt(f.claim_number, 80) ? ` (${txt(f.claim_number, 80)})` : ''}`);
            lines.push(`Sold: ${r.storage_kind ? exports.STORAGE_KIND_LABEL[r.storage_kind] : 'not recorded'}`);
            lines.push(`${box(r.packout_timely)} Pack-out scheduled in a timely manner${txt(f.timing, 240) ? ` (${txt(f.timing, 240)})` : ''}`);
            lines.push(`${box(r.info_sufficient)} Enough information in the file`);
            if (r.work_auth_signed === false)
                actions.push('Get the work authorization signed');
            if (r.photo_wide === false)
                actions.push('Take a wide photo of each room');
            if (r.has_carrier === false)
                actions.push('Add the insurance carrier');
            if (r.has_claim === false)
                actions.push('Add the claim number');
            if (r.packout_timely === false)
                actions.push('Get the pack-out on the schedule sooner');
            if (r.info_sufficient === false)
                actions.push('Complete the file');
        }
    }
    if (r.walked === 'yes' && r.operator_feedback_given === false)
        actions.push('Give the operator feedback');
    if (actions.length) {
        lines.push('');
        lines.push('Action Required');
        for (const a of actions)
            lines.push(`- ${a}`);
    }
    if (r.operator_feedback_given) {
        lines.push('');
        lines.push('Coaching:');
        lines.push(`Feedback: ${txt(r.operator_feedback) || 'given'}`);
        if (txt(r.operator_response))
            lines.push(`Response: ${txt(r.operator_response)}`);
    }
    if (r.needs_follow_up) {
        lines.push('');
        lines.push(`Needs a follow up: ${txt(r.follow_up_reason, 120) || 'reason not given'}${txt(r.follow_up_note) ? ` — ${txt(r.follow_up_note)}` : ''}`);
    }
    if (txt(r.notes, 2000)) {
        lines.push('');
        lines.push(`Notes: ${txt(r.notes, 2000)}`);
    }
    return lines.join('\n');
}
/** The ledger's header numbers. */
function contentsCounts(leads) {
    return {
        total: leads.length,
        needAction: leads.filter(contentsNeedsAction).length,
        walked: leads.filter(l => l.walk_status === 'completed').length,
        landed: leads.filter(l => LANDED.includes(l.stage ?? '')).length,
        reviewed: leads.filter(l => l.review?.status === 'complete').length,
    };
}
