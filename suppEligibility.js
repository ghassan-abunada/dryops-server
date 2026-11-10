'use strict';
// ── Supplemental storage billing: the per-job decision ───────────────────────
// One pure function, `suppEligibility(job)`, says whether the monthly run bills
// a JobNimbus job for storage and why not when it doesn't. The monthly worker
// (server.js suppFetchEligible) and the job page's Storage billing section
// (storage.js, GET /jobs/:id/storage) both call it, so the office sees the
// same answer the run would give.
//
// Eligible = active + not archived, record type in SUPP_RECORD_TYPES (default
// Contents), "In Storage?" (cf_boolean_1) on OR status "In storage", status
// not in SUPP_EXCLUDED_STATUSES, and the status not last changed on an ignored
// date (SUPP_IGNORE_STATUS_DATES: the 2026-01-03 bulk edit). A job with no
// Supplemental Price (cf_double_1) is still billed — as a $0 PLACEHOLDER draft
// the office prices before sending — so it comes back eligible with
// `placeholder: true`. Reasons are plain words for the job page.
//
// The env parsing lives here so server.js and the tests read one definition.

const SUPP_RECORD_TYPES = (process.env.SUPP_RECORD_TYPES || 'Contents')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
// Attorney excluded per owner decision 2026-08-26: jobs in legal dispute keep
// their In-Storage flag but must not receive automatic supplemental invoices.
// PB In Progress / PB Scheduled excluded per owner 2026-08-26: pack-back is
// underway, so the month is settled on the pack-back invoice, not a supp.
const SUPP_EXCLUDED_STATUSES = (process.env.SUPP_EXCLUDED_STATUSES || 'Paid & Closed,PB complete,Lost,Non-Opportunity,Attorney,PB In Progress,PB Scheduled')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const SUPP_IN_STORAGE_STATUS = 'in storage';
// Owner 2026-08-26: a bulk status edit on 2026-01-03 left 16 jobs parked in
// "In storage" — jobs whose status last changed on an ignored Denver date are
// excluded from billing entirely. Comma-separated YYYY-MM-DD env override.
const SUPP_IGNORE_STATUS_DATES = new Set((process.env.SUPP_IGNORE_STATUS_DATES || '2026-01-03')
  .split(',').map(s => s.trim()).filter(Boolean));
const denverDateOf = (secs) => new Date(secs * 1000).toLocaleDateString('en-CA', { timeZone: 'America/Denver' });

const DEFAULT_CONFIG = {
  recordTypes: SUPP_RECORD_TYPES,
  excludedStatuses: SUPP_EXCLUDED_STATUSES,
  inStorageStatus: SUPP_IN_STORAGE_STATUS,
  ignoreStatusDates: SUPP_IGNORE_STATUS_DATES,
};

// The three storage fields off a JobNimbus job payload. JN's webhooks dropped
// the cf_ keys in 2026-07, so the display-name keys count too. `undefined`
// when the payload carries neither key; otherwise null for an empty value.
function storageFields(job) {
  const j = job || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(j, k);
  const first = (...keys) => { for (const k of keys) if (has(k)) return { k, v: j[k] }; return null; };
  const out = {};
  const flag = first('cf_boolean_1', 'In Storage?');
  if (flag) {
    const v = flag.v;
    out.in_storage = v === true || v === 'true' || v === 1 ? true
      : v === false || v === 'false' || v === 0 ? false
        : null;
  }
  const vaults = first('cf_long_1', '# of Vaults');
  if (vaults) {
    const n = vaults.v === null || vaults.v === '' ? NaN : Number(vaults.v);
    out.vaults = Number.isFinite(n) ? Math.round(n) : null;
  }
  const price = first('cf_double_1', 'Supplemental Price');
  if (price) {
    const n = price.v === null || price.v === '' ? NaN : Number(price.v);
    out.monthly_price = Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
  }
  return out;
}

// Title-case the status for a reason line ("Status excluded: Attorney").
function statusLabel(job) {
  const s = job && job.status_name;
  return s === undefined || s === null || String(s).trim() === '' ? '(none)' : String(s).trim();
}

// job: a JobNimbus job (search hit or GET /jobs/:id). opts.today is accepted
// for callers that pin a date; the rules themselves do not depend on it.
// opts.config overrides the env-derived lists (tests).
function suppEligibility(job, opts = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(opts.config || {}) };
  const j = job || {};
  const reasons = [];
  if (j.is_active === false || j.is_archived === true) reasons.push('Inactive or archived');
  const type = String(j.record_type_name || '').trim();
  if (!cfg.recordTypes.includes(type.toLowerCase())) {
    reasons.push(type ? `Not a ${cfg.recordTypes.length === 1 ? cap(cfg.recordTypes[0]) : 'storage-billed'} job` : 'No record type');
  }
  const status = String(j.status_name || '').toLowerCase().trim();
  const fields = storageFields(j);
  const inStorage = fields.in_storage === true || status === cfg.inStorageStatus;
  if (!inStorage) reasons.push('In Storage is off');
  if (cfg.excludedStatuses.includes(status)) reasons.push(`Status excluded: ${statusLabel(j)}`);
  if (j.date_status_change && cfg.ignoreStatusDates.has(denverDateOf(Number(j.date_status_change)))) {
    reasons.push(`Status last changed on ${denverDateOf(Number(j.date_status_change))} (bulk edit, ignored)`);
  }
  const eligible = reasons.length === 0;
  const price = Number(fields.monthly_price);
  const placeholder = eligible && !(price > 0);
  if (placeholder) reasons.push('No price yet — $0 placeholder');
  return { eligible, placeholder, reasons };
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

module.exports = {
  suppEligibility,
  storageFields,
  SUPP_RECORD_TYPES,
  SUPP_EXCLUDED_STATUSES,
  SUPP_IN_STORAGE_STATUS,
  SUPP_IGNORE_STATUS_DATES,
  denverDateOf,
};
