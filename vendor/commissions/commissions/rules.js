"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.photoByRepOf = exports.ARRIVAL_WINDOW_HOURS = exports.isSoldStage = exports.LINE_LABEL = exports.NON_OPPORTUNITY = exports.CLOSED_STATUSES = exports.WORK_END_MIN = exports.WORK_START_MIN = exports.AMOUNTS = void 0;
exports.latestApproved = latestApproved;
exports.hasClaimNumber = hasClaimNumber;
exports.jobTypeOf = jobTypeOf;
exports.isAfterHours = isAfterHours;
exports.localParts = localParts;
exports.responseClock = responseClock;
exports.afterHoursOf = afterHoursOf;
exports.largeJobBonus = largeJobBonus;
exports.jobLabel = jobLabel;
exports.computeJob = computeJob;
exports.manualLines = manualLines;
exports.includedJobs = includedJobs;
exports.isUnlandedAfterHours = isUnlandedAfterHours;
exports.needsPhotoLookup = needsPhotoLookup;
// Commission rules: the Project Manager Compensation agreement (effective
// 2026-11-01) as a pure function from a job's facts to its bonus lines. Facts come
// from commission_feed; an approved correction overrides a fact, never a dollar
// amount, so every total can still be explained. All bonuses stack.
const format_1 = require("../format");
exports.AMOUNTS = {
    insuranceLanded: 100,
    oopLanded: 25,
    afterHoursResponse: 25,
    afterHoursLanded: 25,
    packoutSold: 25,
    largeJobUnit: 25,
    largeJobStep: 5000,
    largeThresholdInsurance: 20000,
    largeThresholdOop: 10000,
};
exports.WORK_START_MIN = 8 * 60;
exports.WORK_END_MIN = 17 * 60;
exports.CLOSED_STATUSES = ['Paid & Closed', 'Paid to Lead Source'];
exports.NON_OPPORTUNITY = 'Non-Opportunity';
exports.LINE_LABEL = {
    insurance_landed: 'Insurance job landed',
    oop_landed: 'Out-of-pocket job landed',
    after_hours_response: 'After-hours response',
    after_hours_landed: 'After-hours job landed',
    packout: 'Pack-out sold',
    large_job: 'Large job',
    manual: 'Adjustment',
};
/** Newest approved correction per job + field. A null value clears the correction. */
function latestApproved(corrections) {
    const latest = new Map();
    const stamp = (c) => c.decided_at || c.proposed_at;
    for (const c of corrections) {
        if (c.status !== 'approved' || !c.job_id)
            continue;
        const key = `${c.job_id}:${c.field}`;
        const prev = latest.get(key);
        if (!prev || stamp(c) > stamp(prev))
            latest.set(key, c);
    }
    return latest;
}
// "n/a", "TBD", "pending", "none", "-", "0" are not claim numbers.
const PLACEHOLDER_CLAIM = /^(n\/?a|none|tbd|pending|unknown|-+|0+|\.+)$/i;
function hasClaimNumber(claim) {
    const c = String(claim ?? '').trim();
    return c.length > 0 && !PLACEHOLDER_CLAIM.test(c);
}
/**
 * Insurance only when JobNimbus says Insurance AND the job has a claim number
 * (owner 2026-11-07): a job billed to the customer for a few days of equipment
 * after it fell through is not an insurance job, whatever the field says.
 */
function jobTypeOf(insuranceType, claimNumber) {
    // undefined = a feed from before add_commissions_claim_number.sql, which doesn't
    // send the field at all: keep the old reading rather than demote every job.
    if (insuranceType === 'Insurance')
        return claimNumber === undefined || hasClaimNumber(claimNumber) ? 'insurance' : 'oop';
    if (insuranceType === 'Not Insurance' || insuranceType === 'OOP' || insuranceType === 'Non-Insurance')
        return 'oop';
    return null;
}
/** A pack-out counts only once its Contents job is in a sold stage (PO in progress onward). */
exports.isSoldStage = format_1.isLandedStage;
/** Outside Mon-Fri 8-5 local. dow is ISO: Monday 1 ... Sunday 7. */
function isAfterHours(dow, minutes) {
    if (dow >= 6)
        return true;
    return minutes < exports.WORK_START_MIN || minutes >= exports.WORK_END_MIN;
}
/**
 * An arrival (or a first photo) answers the lead only when it comes within this
 * long of it. The phone is seen at the address whenever the app is open there,
 * so without a limit a monitor visit on Saturday would turn Monday's job into an
 * after-hours one.
 */
exports.ARRIVAL_WINDOW_HOURS = 72;
const photoByRepOf = (p) => p === undefined ? undefined : typeof p === 'boolean' ? p : p.byRep;
exports.photoByRepOf = photoByRepOf;
const photoAtOf = (p) => p && typeof p === 'object' ? p.firstAt : null;
const DOW = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
/** Wall-clock parts of an instant in a timezone, shaped like the feed's lead_* fields. null when either is unusable. */
function localParts(iso, timeZone) {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime()))
        return null;
    try {
        const parts = {};
        for (const p of new Intl.DateTimeFormat('en-US', {
            timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        }).formatToParts(at))
            parts[p.type] = p.value;
        const dow = DOW[parts.weekday];
        const hour = Number(parts.hour) % 24;
        const minute = Number(parts.minute);
        if (!dow || !Number.isFinite(hour) || !Number.isFinite(minute))
            return null;
        return {
            local: `${parts.year}-${parts.month}-${parts.day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
            dow, minutes: hour * 60 + minute,
        };
    }
    catch {
        return null;
    }
}
const withinWindow = (leadAt, at) => {
    const hours = (Date.parse(at) - Date.parse(leadAt)) / 3600000;
    return Number.isFinite(hours) && hours <= exports.ARRIVAL_WINDOW_HOURS;
};
/**
 * When the rep responded (owner 2026-11-25): after hours goes by when he reached
 * the job address, not by when the call came in. In order:
 *   1. his phone at the address (job_arrivals),
 *   2. no location: his first photo on the job, from DryOps (first_photo_at) or
 *      JobNimbus (`photo`), whichever is earlier,
 *   3. neither: the lead time, as before.
 * @param timeZone the rep's timezone, needed to read a photo's time; without it step 2 is skipped.
 */
function responseClock(job, photo, timeZone) {
    const lead = { source: job.lead_source, local: job.lead_local, dow: job.lead_dow, minutes: job.lead_minutes, lateArrival: false };
    const hasArrival = !!job.arrived_at && !!job.arrived_local && job.arrived_dow != null && job.arrived_minutes != null;
    if (hasArrival && withinWindow(job.lead_at, job.arrived_at)) {
        return { source: 'arrival', local: job.arrived_local, dow: job.arrived_dow, minutes: job.arrived_minutes, lateArrival: false };
    }
    const fallback = hasArrival ? { ...lead, lateArrival: true } : lead;
    if (!timeZone)
        return fallback;
    const firstPhoto = [job.first_photo_at, photoAtOf(photo)]
        .filter((t) => !!t && Number.isFinite(Date.parse(t)))
        .sort((x, y) => Date.parse(x) - Date.parse(y))[0];
    if (!firstPhoto || !withinWindow(job.lead_at, firstPhoto))
        return fallback;
    const parts = localParts(firstPhoto, timeZone);
    return parts ? { source: 'photo', ...parts, lateArrival: fallback.lateArrival } : fallback;
}
/** After hours as the job's own facts say, before any correction. */
function afterHoursOf(job, photo, timeZone) {
    const c = responseClock(job, photo, timeZone);
    return isAfterHours(c.dow, c.minutes);
}
/** Each FULL $5,000 above the threshold. */
function largeJobBonus(jobType, revenue) {
    if (!jobType)
        return 0;
    const threshold = jobType === 'insurance' ? exports.AMOUNTS.largeThresholdInsurance : exports.AMOUNTS.largeThresholdOop;
    const over = revenue - threshold;
    if (over <= 0)
        return 0;
    return Math.floor(over / exports.AMOUNTS.largeJobStep) * exports.AMOUNTS.largeJobUnit;
}
function override(latest, jobId, field) {
    const c = latest.get(`${jobId}:${field}`);
    if (!c || c.value == null)
        return { hit: false, value: null };
    return { hit: true, value: c.value };
}
function jobLabel(job) {
    const who = job.name || job.client_name || 'Job';
    return job.number ? `#${job.number} ${who}` : who;
}
/**
 * @param photo what JobNimbus shows of the rep's photos on the job. undefined =
 *   not looked up / the lookup failed.
 * @param timeZone the rep's timezone (reads the first photo's time).
 */
function computeJob(job, latest, photo, timeZone) {
    const jnPhotoByRep = (0, exports.photoByRepOf)(photo);
    const clock = responseClock(job, photo, timeZone);
    const corrected = [];
    function fact(field, derived) {
        const o = override(latest, job.id, field);
        if (!o.hit)
            return derived;
        corrected.push(field);
        return o.value;
    }
    const landed = fact('landed', (0, format_1.isLandedStage)(job.stage));
    const jobType = fact('job_type', jobTypeOf(job.insurance_type, job.claim_number));
    const noClaim = job.insurance_type === 'Insurance' && job.claim_number !== undefined && !hasClaimNumber(job.claim_number) && !corrected.includes('job_type');
    const afterHours = fact('after_hours', isAfterHours(clock.dow, clock.minutes));
    const respondedDerived = job.photo_by_rep ? true : jnPhotoByRep === undefined ? null : jnPhotoByRep;
    const responded = fact('responded', respondedDerived);
    const soldPackout = (job.packouts || []).some(p => (0, exports.isSoldStage)(p.stage));
    const packoutSold = fact('packout_sold', soldPackout);
    const closed = exports.CLOSED_STATUSES.includes(job.status || '');
    const revenue = Number(fact('revenue', job.collected)) || 0;
    const flags = [];
    const lines = [];
    const label = jobLabel(job);
    const add = (kind, amount, text) => {
        if (amount === 0)
            return;
        lines.push({
            key: `job:${job.id}:${kind}`, kind, jobId: job.id,
            locationId: job.location_id, locationName: job.location_name,
            month: job.month, amount, label: text || exports.LINE_LABEL[kind], jobLabel: label,
        });
    };
    if (landed) {
        if (jobType === 'insurance')
            add('insurance_landed', exports.AMOUNTS.insuranceLanded);
        else if (jobType === 'oop')
            add('oop_landed', exports.AMOUNTS.oopLanded);
        else
            flags.push('needs_type');
        if (noClaim)
            flags.push('no_claim');
    }
    if (afterHours) {
        // Landing it proves the response. Unlanded needs a photo he uploaded.
        if (landed) {
            add('after_hours_response', exports.AMOUNTS.afterHoursResponse);
            add('after_hours_landed', exports.AMOUNTS.afterHoursLanded);
        }
        else if (responded === true) {
            add('after_hours_response', exports.AMOUNTS.afterHoursResponse);
        }
        else if (responded === false) {
            flags.push('no_photo');
        }
        else {
            flags.push('photo_unchecked');
        }
    }
    if (landed && packoutSold)
        add('packout', exports.AMOUNTS.packoutSold);
    if (landed && closed) {
        if (revenue <= 0)
            flags.push('no_revenue');
        const bonus = largeJobBonus(jobType, revenue);
        if (bonus > 0) {
            const units = bonus / exports.AMOUNTS.largeJobUnit;
            add('large_job', bonus, `Large job: ${units} x $${exports.AMOUNTS.largeJobUnit} on $${Math.round(revenue).toLocaleString('en-US')}`);
        }
    }
    return {
        job,
        clock,
        facts: { landed, jobType, afterHours, responded, packoutSold, closed, revenue, corrected },
        lines,
        flags,
        total: lines.reduce((sum, l) => sum + l.amount, 0),
    };
}
/** Approved manual lines: an after-hours call with no job, a deduction, etc. */
function manualLines(corrections) {
    const out = [];
    for (const c of corrections) {
        if (c.field !== 'manual_line' || c.status !== 'approved' || !c.value)
            continue;
        const v = c.value;
        const amount = Number(v.amount);
        if (!amount || !/^\d{4}-\d{2}$/.test(v.month || ''))
            continue;
        out.push({
            key: `manual:${c.id}`, kind: 'manual', jobId: c.job_id,
            locationId: v.location_id ?? null, locationName: v.location_name ?? null,
            month: v.month, amount, label: v.label || exports.LINE_LABEL.manual, jobLabel: null,
        });
    }
    return out;
}
/** The rep's job list: name matches and approved additions, minus approved removals. */
function includedJobs(jobs, latest) {
    return jobs.filter(j => {
        const o = latest.get(`${j.id}:include_job`);
        if (o && o.value != null)
            return o.value === true;
        return j.rep_match;
    });
}
function isUnlandedAfterHours(job, latest, photo, timeZone) {
    const landed = latest.get(`${job.id}:landed`)?.value ?? (0, format_1.isLandedStage)(job.stage);
    const after = latest.get(`${job.id}:after_hours`)?.value ?? afterHoursOf(job, photo, timeZone);
    return !landed && !!after;
}
/**
 * Does this job need JobNimbus asked about the rep's photos? Yes when no location
 * arrival settles the response time (the first photo is the backup), and for an
 * unlanded after-hours job, where a photo is the proof he responded.
 */
function needsPhotoLookup(job, latest) {
    if (!job.jn_id)
        return false;
    if (responseClock(job).source !== 'arrival')
        return true;
    return !job.photo_by_rep && isUnlandedAfterHours(job, latest);
}
