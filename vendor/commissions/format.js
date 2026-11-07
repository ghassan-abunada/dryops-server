"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LANDED_STAGES = void 0;
exports.isLandedStage = isLandedStage;
exports.fmtDate = fmtDate;
exports.relTime = relTime;
exports.fmtDateTime = fmtDateTime;
exports.formatPhoneInput = formatPhoneInput;
exports.formatAmountInput = formatAmountInput;
exports.shortLocationName = shortLocationName;
exports.fmtDuration = fmtDuration;
/**
 * A job is "landed" (a lead that converted to a real job) iff its generated
 * `stage` column is one of these. Excludes Lead, Estimating, Lost, and null.
 * Mirrors the exec dashboard RPC definition.
 */
exports.LANDED_STAGES = new Set(['In Production', 'Account Receivable', 'Completed']);
function isLandedStage(stage) {
    return !!stage && exports.LANDED_STAGES.has(stage);
}
/** Format a date as M/D/YY (e.g. 4/18/25) */
function fmtDate(date) {
    if (!date)
        return '';
    // Date-only "YYYY-MM-DD" is a calendar day: read it as local noon, not UTC
    // midnight (which shows the previous day anywhere west of Greenwich).
    const d = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(date + 'T12:00:00') : new Date(date);
    if (Number.isNaN(d.getTime()))
        return '';
    return d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' });
}
/** Relative time for "last seen" labels: Just now / 5m ago / 3h ago / 12d ago, else M/D/YY. */
function relTime(date) {
    if (!date)
        return 'Never';
    const diffMs = Date.now() - new Date(date).getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1)
        return 'Just now';
    if (mins < 60)
        return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24)
        return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30)
        return `${days}d ago`;
    return fmtDate(date);
}
/** Format a date+time as M/D/YY, h:mm A (e.g. 4/18/25, 2:30 PM) */
function fmtDateTime(date) {
    if (!date)
        return '';
    return new Date(date).toLocaleString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit', hour: 'numeric', minute: '2-digit' });
}
/**
 * Format a US phone number as the user types: (555) 555-0100.
 * Non-digits are stripped; a leading 1 (country code) is dropped; anything past
 * 10 digits is ignored so the field can't grow unbounded.
 */
function formatPhoneInput(value) {
    let d = (value || '').replace(/\D/g, '');
    if (d.length > 10 && d.startsWith('1'))
        d = d.slice(1);
    d = d.slice(0, 10);
    if (d.length === 0)
        return '';
    if (d.length < 4)
        return `(${d}`;
    if (d.length < 7)
        return `(${d.slice(0, 3)}) ${d.slice(3)}`;
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}
/** Thousands separators for a raw decimal string while typing: "1250.5" → "1,250.5". */
function formatAmountInput(v) {
    if (!v)
        return '';
    const [int, ...rest] = v.split('.');
    const withCommas = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return rest.length ? `${withCommas}.${rest.join('')}` : withCommas;
}
/** Collapse repeated whitespace, fix space-before-comma, and trim. */
function tidySpaces(s) {
    return s.replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').trim();
}
/**
 * Shorten long franchise location names for space-constrained UI.
 * DISPLAY ONLY — never use the result to match or store data.
 *
 * Examples:
 *   "24 Hour Flood Pros of Kansas City"            → "24 Kansas City"
 *   "24 Hour Flood Pros - Tulsa, OK"               → "24 Tulsa, OK"
 *   "Gurr Brothers Construction of Texas (Dallas)" → "GBC Texas (Dallas)"
 *   "Utah Water and Fire"                          → "Utah WAF"
 *   "A1 Restoration of Dallas"                     → "A1 of Dallas"
 */
function shortLocationName(name) {
    if (!name || typeof name !== 'string')
        return name ?? '';
    const original = name;
    let out = name.trim();
    // 1) "24 Hour Flood Pros of X" / "24 Hour Flood Pros - X" → "24 X".
    //    A bare "24 Hour Flood Pros" (optionally with an ", LLC"-style suffix and
    //    nothing else after it) is left alone — there's no city part to keep.
    const floodPros = out.match(/^24\s+Hour\s+Flood\s+Pros(?:,?\s*LLC\.?)?(?:\s+of\s+|\s*[-–—]\s*)(.+)$/i);
    if (floodPros) {
        out = `24 ${floodPros[1].trim()}`;
    }
    // 2) Gurr Brothers abbreviations (most specific first). A following "of" is
    //    absorbed too: "Gurr Brothers Construction of Idaho" → "GBC Idaho".
    //    A "- X" dash form is also absorbed: "Gurr Brothers Roofing - Flagstaff" → "GBR Flagstaff".
    out = out.replace(/\bGurr\s+Brothers\s+Construction(?:\s+of\b|\s*[-–—])?/gi, 'GBC ');
    out = out.replace(/\bGurr\s+Brothers\s+Roofing(?:\s+of\b|\s*[-–—])?/gi, 'GBR ');
    out = out.replace(/\bGurr\s+Brothers(?:\s+of\b|\s*[-–—])?/gi, 'GB ');
    // 3) "American Fire and Flood" → "AFF"; "Water and Fire"/"Water & Fire" → "W&F".
    out = out.replace(/\bAmerican\s+Fire\s+(?:and|&)\s+Flood(?:\s+of\b)?/gi, 'AFF');
    out = out.replace(/\bWater\s+(?:and|&)\s+Fire\b/gi, 'W&F');
    // 4) Drop the word "Restoration" (e.g. "Salt River Restoration, LLC." → "Salt River, LLC.").
    out = out.replace(/\bRestoration\b/gi, '');
    // 5) Drop connecting "of" (e.g. "24 X of Y" → "24 X Y", "A1 of Dallas" → "A1 Dallas").
    out = out.replace(/\bof\b/gi, ' ');
    // Cleanup: collapse spaces, fix " ," and strip a stray leading/trailing comma.
    out = tidySpaces(out);
    out = out.replace(/^(?:,\s*)+/i, '').replace(/(?:,)+$/i, '');
    out = tidySpaces(out);
    // Never return something empty/unreadable — fall back to the original name.
    if (out.length < 2)
        return original;
    return out;
}
/** Seconds → compact duration: 45 → "45s", 388 → "6m 28s", 3700 → "1h 1m". */
function fmtDuration(seconds) {
    if (seconds == null || !isFinite(seconds) || seconds < 0)
        return '';
    const s = Math.round(seconds);
    if (s < 60)
        return `${s}s`;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0)
        return `${h}h ${m}m`;
    return `${m}m ${s % 60}s`;
}
