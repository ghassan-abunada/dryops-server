'use strict';

// Google Local Services Ads lead import.
//
// The LSA export bot (lsa-bot/) posts each manager account's "Detailed Lead Report"
// CSV, untouched, to POST /lsa/import. (The second bot's "Pay-per-lead leads report",
// from Google's new dashboard, comes in through the same route: see the section further down.) This module validates the columns, turns each
// row into a lead keyed on Google's lead id, and reports what was new, what Google
// changed since last time, and what was the same. Schema: supabase_lsa_leads.sql.
//
// Pure parsing / diffing is exported for tests; the route is mounted from server.js.

const crypto = require('crypto');

const COLUMNS = [
  'Account ID', 'Business Name', 'Lead Creation Timestamp', 'External Lead Id', 'Google Ads Lead Id',
  'Customer Name', 'Customer Phone Number', 'Customer Email', 'Booking Appointment Timestamp', 'Job Type',
  'Zipcode', 'Geo', 'Lead Category', 'Charged Call Timestamp', 'Charged Connected Call Duration Seconds',
  'Lead Type', 'Charged', 'Dispute Status',
];

// Fields compared between imports (and written to lsa_lead_changes when they differ).
const TRACKED = [
  'external_lead_id', 'account_id', 'business_name', 'geo', 'lead_created_local', 'lead_type', 'lead_category',
  'job_type', 'customer_name', 'customer_phone', 'customer_phone_ext', 'customer_email', 'booking_local',
  'zipcode', 'charged', 'charged_call_local', 'charged_call_seconds', 'dispute_status',
];

class ImportError extends Error {
  constructor(message, status = 422) { super(message); this.status = status; }
}

/** RFC 4180 reader: quoted cells, doubled quotes, line breaks inside quotes, optional BOM. */
function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else cell += c;
  }
  if (quoted) throw new ImportError('The file ends inside a quoted cell (truncated upload?)');
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

const blank = (v) => {
  const s = String(v ?? '').trim();
  return s === '' || s.toUpperCase() === 'NULL' ? null : s;
};

/** "10/31/26 10:08:57" → "2026-10-31 10:08:57" (no zone: the report does not state one). */
function localTimestamp(v) {
  const s = blank(v);
  if (!s) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) return undefined; // caller rejects the row
  const [, mo, d, y, h, mi, sec] = m;
  const year = y.length === 2 ? 2000 + Number(y) : Number(y);
  const p = (n) => String(n).padStart(2, '0');
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59 || +(sec || 0) > 59) return undefined;
  return `${year}-${p(mo)}-${p(d)} ${p(h)}:${mi}:${p(sec || 0)}`;
}

/** "+14026756551 ext. 94523" → { phone: "+14026756551", ext: "94523" } */
function splitPhone(v) {
  const s = blank(v);
  if (!s) return { phone: null, ext: null };
  const m = /^(.*?)\s*(?:ext\.?|x)\s*(\d+)\s*$/i.exec(s);
  return m ? { phone: m[1].trim() || null, ext: m[2] } : { phone: s, ext: null };
}

function bool(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'true') return true;
  if (s === 'false') return false;
  return s === '' ? null : undefined;
}

function hashOf(lead) {
  return crypto.createHash('sha1').update(JSON.stringify(TRACKED.map((k) => lead[k] ?? null))).digest('hex');
}

/** One CSV record (object keyed by column) → a lead row, or { error } when it cannot be used. */
function normalizeRow(rec) {
  const id = blank(rec['Google Ads Lead Id']);
  if (!id || !/^\d+$/.test(id)) return { error: 'no Google Ads Lead Id' };
  const account = blank(rec['Account ID']);
  if (!account) return { error: `lead ${id}: no Account ID` };
  const created = localTimestamp(rec['Lead Creation Timestamp']);
  const chargedCall = localTimestamp(rec['Charged Call Timestamp']);
  const booking = localTimestamp(rec['Booking Appointment Timestamp']);
  if (created === undefined || chargedCall === undefined || booking === undefined) return { error: `lead ${id}: unreadable timestamp` };
  const charged = bool(rec['Charged']);
  if (charged === undefined) return { error: `lead ${id}: Charged is "${rec['Charged']}"` };
  // Google prints long calls with a thousands separator ("1,234").
  const secsText = blank(rec['Charged Connected Call Duration Seconds']);
  const secs = secsText === null ? null : secsText.replace(/,/g, '');
  if (secs !== null && !/^\d+$/.test(secs)) return { error: `lead ${id}: call duration is "${secsText}"` };
  const { phone, ext } = splitPhone(rec['Customer Phone Number']);
  const lead = {
    google_lead_id: id,
    external_lead_id: blank(rec['External Lead Id']),
    account_id: account,
    business_name: blank(rec['Business Name']),
    geo: blank(rec['Geo']),
    lead_created_local: created,
    lead_type: blank(rec['Lead Type']),
    lead_category: blank(rec['Lead Category']),
    job_type: blank(rec['Job Type']),
    customer_name: blank(rec['Customer Name']),
    customer_phone: phone,
    customer_phone_ext: ext,
    customer_email: blank(rec['Customer Email']),
    booking_local: booking,
    zipcode: blank(rec['Zipcode']),
    charged,
    charged_call_local: chargedCall,
    charged_call_seconds: secs === null ? null : Number(secs),
    dispute_status: blank(rec['Dispute Status']),
  };
  lead.row_hash = hashOf(lead);
  lead.raw = rec;
  return { lead };
}

/**
 * CSV text → { leads, rejected }. Throws ImportError when the columns are not the
 * report we know: a renamed or missing column must stop the import, not half-fill it.
 */
function parseReport(text) {
  const rows = parseCsv(text);
  if (!rows.length) throw new ImportError('The file is empty');
  const header = rows[0].map((h) => h.trim());
  const missing = COLUMNS.filter((c) => !header.includes(c));
  const extra = header.filter((c) => !COLUMNS.includes(c));
  if (missing.length || extra.length) {
    throw new ImportError(`Unexpected columns.${missing.length ? ` Missing: ${missing.join(', ')}.` : ''}${extra.length ? ` Not recognised: ${extra.join(', ')}.` : ''}`);
  }
  const byId = new Map();
  const rejected = [];
  rows.slice(1).forEach((cells, i) => {
    if (cells.length !== header.length) { rejected.push(`row ${i + 2}: ${cells.length} cells, expected ${header.length}`); return; }
    const rec = Object.fromEntries(header.map((h, j) => [h, cells[j]]));
    const { lead, error } = normalizeRow(rec);
    if (error) rejected.push(`row ${i + 2}: ${error}`);
    else byId.set(lead.google_lead_id, lead); // a lead listed twice in one file: last one wins
  });
  return { leads: [...byId.values()], rejected, rowCount: rows.length - 1 };
}

// Stored timestamps come back as "2026-10-31T10:08:57"; ours are "2026-10-31 10:08:57".
const show = (v) => (v === null || v === undefined ? null : String(v).replace(/^(\d{4}-\d{2}-\d{2})T/, '$1 '));

/**
 * Compare incoming leads with what is stored.
 * existing: Map(google_lead_id → stored row with TRACKED fields, row_hash, manager_ids)
 * Returns the rows to write, the change log, and the counts.
 */
function diffLeads(leads, existing, managerId, nowIso) {
  const writes = []; const changes = [];
  let fresh = 0; let changed = 0; let same = 0;
  for (const lead of leads) {
    const old = existing.get(lead.google_lead_id);
    const managers = new Set(old ? old.manager_ids || [] : []);
    const knewManager = !managerId || managers.has(managerId);
    if (managerId) managers.add(managerId);
    const manager_ids = [...managers].sort();
    if (!old) {
      fresh++;
      writes.push({ ...lead, manager_ids, changed_at: null });
    } else if (old.row_hash !== lead.row_hash) {
      changed++;
      for (const f of TRACKED) {
        if (show(old[f]) !== show(lead[f])) changes.push({ google_lead_id: lead.google_lead_id, field: f, old_value: show(old[f]), new_value: show(lead[f]) });
      }
      // First stored by the pay-per-lead import (date only, maybe a campaign pseudo-account):
      // the detailed report now owns it, so say so. Only such rows carry the two extra keys.
      const upgrade = isPplHash(old.row_hash) ? { source_format: 'detailed', time_known: true } : {};
      writes.push({ ...lead, manager_ids, changed_at: nowIso, ...upgrade });
    } else {
      same++;
      // Same lead, reported by a manager we had not seen it under: record that, nothing else.
      if (!knewManager) writes.push({ ...lead, manager_ids, changed_at: old.changed_at ?? null });
    }
  }
  return { writes, changes, counts: { new: fresh, changed, same } };
}

function summaryLine({ rowCount, counts, rejected }) {
  const parts = [`${counts.new} new`, `${counts.changed} changed`, `${counts.same} same`];
  if (rejected) parts.push(`${rejected} rejected`);
  return `${rowCount} rows: ${parts.join(', ')}`;
}

const ymdOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

/**
 * Run one import. `db` = { select(table, query) → rows, upsert(table, rows, conflictCol), insert(table, rows) → rows }.
 * Returns { status, text } for the HTTP reply.
 */
async function importReport(db, { csv, managerId, from, to, filename, source, format }, now = () => new Date()) {
  if (format === 'ppl' || looksLikePpl(csv)) return importPplReport(db, { csv, managerId, filename, source }, now);
  const meta = {
    manager_id: managerId || null,
    range_from: ymdOk(from) ? from : null,
    range_to: ymdOk(to) ? to : null,
    filename: filename ? String(filename).slice(0, 200) : null,
    sha256: crypto.createHash('sha256').update(csv).digest('hex'),
    source: source || 'bot',
  };
  let parsed;
  try {
    parsed = parseReport(csv);
  } catch (err) {
    if (!(err instanceof ImportError)) throw err;
    await db.insert('lsa_imports', [{ ...meta, error: err.message.slice(0, 500) }]);
    return { status: err.status, text: err.message };
  }
  const { leads, rejected, rowCount } = parsed;

  const existing = new Map();
  const fields = ['google_lead_id', 'row_hash', 'manager_ids', 'changed_at', ...TRACKED].join(',');
  for (const ids of chunk(leads.map((l) => l.google_lead_id), 150)) {
    const rows = await db.select('lsa_leads', `select=${fields}&google_lead_id=in.(${ids.join(',')})`);
    for (const r of rows) existing.set(r.google_lead_id, r);
  }

  const { writes, changes, counts } = diffLeads(leads, existing, meta.manager_id, now().toISOString());
  const [imp] = await db.insert('lsa_imports', [{
    ...meta, row_count: rowCount, new_count: counts.new, changed_count: counts.changed, same_count: counts.same,
    rejected_count: rejected.length, error: rejected.length ? rejected.slice(0, 5).join('; ').slice(0, 500) : null,
  }]);
  // One upsert must carry the same keys on every row, so the few upgraded rows go on their own.
  const upgraded = writes.filter((w) => w.source_format);
  const plain = writes.filter((w) => !w.source_format);
  for (const part of chunk(plain, 500)) await db.upsert('lsa_leads', part, 'google_lead_id');
  for (const part of chunk(upgraded, 500)) await db.upsert('lsa_leads', part, 'google_lead_id');
  for (const part of chunk(changes.map((c) => ({ ...c, import_id: imp && imp.id })), 500)) await db.insert('lsa_lead_changes', part);

  return { status: 200, text: summaryLine({ rowCount, counts, rejected: rejected.length }) };
}

// ── Pay-per-lead leads report (Google's new dashboard) ──────────────────────
//
// Google is moving accounts into Google Ads; a migrated account's leads leave the
// Detailed Lead Report and show up in "Pay-per-lead leads", one file per manager
// (lsa-bot/pplBot.js). Two title lines, then 14 columns. No account id, no time of
// day, no business name: the campaign is the unit, and "Lead ID" is the same number
// as "Google Ads Lead Id". Schema: supabase_lsa_ppl_leads.sql.

const PPL_TITLE = 'Pay-per-lead leads report';
const PPL_COLUMNS = [
  'Lead details', 'First contact date', 'Lead status', 'Charge status', 'Lead type', 'Customer name',
  'Additional notes', 'Service type', 'Search intent', 'Last Updated', 'Business category', 'Lead ID',
  'Campaign name', 'Campaign ID',
];
// What a pay-per-lead row's hash covers (its hash is prefixed "ppl:").
const PPL_TRACKED = [
  'account_id', 'business_name', 'geo', 'campaign_id', 'campaign_name', 'charge_status', 'charged',
  'lead_created_local', 'lead_type', 'lead_category', 'job_type', 'customer_name', 'customer_phone', 'customer_phone_ext',
];
// Fields whose changes are written to lsa_lead_changes.
const PPL_LOGGED = ['charge_status', 'charged', 'campaign_id'];
const PPL_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const PPL_CHARGED = { charged: true, 'not charged': false, credited: false, 'in review': null };
const PPL_TYPES = { 'phone call': 'PHONE_CALL', message: 'MESSAGE', booking: 'BOOKING' };
const PPL_NAME_PREFIX = 'Pay-per-lead-PMax-';

/** A stored row whose hash was written by the pay-per-lead import (the detailed import overwrites it). */
function isPplHash(h) { return String(h || '').startsWith('ppl:'); }

/** " --" and "" → null, else the trimmed text. */
const pplBlank = (v) => {
  const s = String(v ?? '').trim();
  return s === '' || s === '--' ? null : s;
};

/** "2026Nov3" → "2026-11-03"; null when it is not a date in that form. */
function pplDate(v) {
  const m = /^(\d{4})([A-Za-z]{3})(\d{1,2})$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const mo = PPL_MONTHS.indexOf(m[2].toLowerCase()) + 1;
  const d = Number(m[3]);
  if (!mo || d < 1 || d > new Date(Date.UTC(Number(m[1]), mo, 0)).getUTCDate()) return null;
  return `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** " +1 207-705-8582 ext. 38614" → { phone: "+12077058582", ext: "38614" }; not a number → nulls. */
function pplPhone(v) {
  const { phone, ext } = splitPhone(pplBlank(v));
  const digits = String(phone || '').replace(/[\s\-().]/g, '');
  return /^\+?\d+$/.test(digits) ? { phone: digits, ext } : { phone: null, ext: null };
}

/** True when the text is the pay-per-lead export: its title line, or a "Lead details" header in the first 5 lines. */
function looksLikePpl(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/, 5);
  const first = (l) => l.split(',')[0].trim().replace(/^"|"$/g, '').trim();
  return first(lines[0] || '') === PPL_TITLE || lines.some((l) => first(l) === 'Lead details');
}

/** One record (object keyed by column) → a lead without its account yet, or { error }. */
function normalizePplRow(rec) {
  const id = pplBlank(rec['Lead ID']);
  if (!id || !/^\d+$/.test(id)) return { error: 'no Lead ID' };
  const statusText = pplBlank(rec['Charge status']);
  const charged = PPL_CHARGED[String(statusText || '').toLowerCase()];
  if (charged === undefined) return { error: `lead ${id}: Charge status is "${String(rec['Charge status'] ?? '').trim()}"` };
  const type = PPL_TYPES[String(pplBlank(rec['Lead type']) || '').toLowerCase()];
  if (!type) return { error: `lead ${id}: Lead type is "${String(rec['Lead type'] ?? '').trim()}"` };
  const day = pplDate(rec['First contact date']);
  if (!day) return { error: `lead ${id}: unreadable date "${String(rec['First contact date'] ?? '').trim()}"` };
  const campaign = pplBlank(rec['Campaign ID']);
  const { phone, ext } = pplPhone(rec['Lead details']);
  return {
    lead: {
      google_lead_id: id,
      campaign_id: campaign && /^\d+$/.test(campaign) ? campaign : null,
      campaign_name: pplBlank(rec['Campaign name']),
      charge_status: statusText,
      charged,
      lead_created_local: `${day} 00:00:00`,
      time_known: false,
      lead_type: type,
      lead_category: pplBlank(rec['Business category']),
      job_type: pplBlank(rec['Service type']),
      customer_name: pplBlank(rec['Customer name']),
      customer_phone: phone,
      customer_phone_ext: ext,
      source_format: 'ppl',
      raw: rec,
    },
  };
}

/** Pay-per-lead CSV text → { leads, rejected, rowCount, range }. Throws ImportError on unknown columns. */
function parsePplReport(text) {
  const rows = parseCsv(text);
  if (!rows.length) throw new ImportError('The file is empty');
  const at = rows.slice(0, 5).findIndex((r) => String(r[0] || '').trim() === 'Lead details');
  if (at < 0) throw new ImportError('Not a pay-per-lead leads report: no header row starting with "Lead details" in the first 5 lines');
  // Title lines: the report name, then the date range ("All time"). A range holding a comma arrives as several cells.
  const titles = rows.slice(0, at).map((r) => r.join(',').trim()).filter((t) => t && t !== PPL_TITLE);
  const range = titles.length ? titles[titles.length - 1] : null;
  const header = rows[at].map((h) => h.trim());
  const missing = PPL_COLUMNS.filter((c) => !header.includes(c));
  const extra = header.filter((c) => !PPL_COLUMNS.includes(c));
  if (missing.length || extra.length) {
    throw new ImportError(`Unexpected columns.${missing.length ? ` Missing: ${missing.join(', ')}.` : ''}${extra.length ? ` Not recognised: ${extra.join(', ')}.` : ''}`);
  }
  const byId = new Map();
  const rejected = [];
  const body = rows.slice(at + 1);
  body.forEach((cells, i) => {
    const n = at + i + 2; // line number in the file, blank lines aside
    if (cells.length !== header.length) { rejected.push(`row ${n}: ${cells.length} cells, expected ${header.length}`); return; }
    const rec = Object.fromEntries(header.map((h, j) => [h, cells[j]]));
    const { lead, error } = normalizePplRow(rec);
    if (error) rejected.push(`row ${n}: ${error}`);
    else byId.set(lead.google_lead_id, lead); // a lead listed twice in one file: last one wins
  });
  return { leads: [...byId.values()], rejected, rowCount: body.length, range };
}

const isPseudoAccount = (id) => !id || String(id).startsWith('C');

/** The name shown for a campaign that has no Google account behind it yet. */
function pplBusinessName(campaignId, campaignName) {
  if (campaignName) return campaignName.startsWith(PPL_NAME_PREFIX) ? campaignName.slice(PPL_NAME_PREFIX.length).trim() || campaignName : campaignName;
  return campaignId ? `Campaign ${campaignId}` : 'Pay-per-lead leads (no campaign)';
}

/**
 * Which account each campaign's leads are stored under. Pure.
 *   leads     normalised pay-per-lead leads
 *   existing  Map(google_lead_id → stored lsa_leads row)
 *   campaigns Map(campaign_id → stored lsa_campaigns row)
 * Per campaign: (a) the real account already recorded for it, else (b) the real account
 * most of its leads are already stored under (the same lead sits in both exports while an
 * account is mid-migration), else (c) the pseudo-account "C<campaign id>". Leads with no
 * campaign go under "C<manager id>".
 * Returns Map(campaign_id or '' → { campaign_id, campaign_name, account_id, tied, via, business_name, geo }).
 */
function decidePplAccounts(leads, existing, campaigns, managerId) {
  const groups = new Map();
  for (const lead of leads) {
    const key = lead.campaign_id || '';
    if (!groups.has(key)) groups.set(key, { campaign_id: lead.campaign_id || null, campaign_name: null, votes: new Map(), sample: new Map() });
    const g = groups.get(key);
    if (lead.campaign_name) g.campaign_name = lead.campaign_name;
    const old = existing.get(lead.google_lead_id);
    if (old && !isPseudoAccount(old.account_id)) {
      g.votes.set(old.account_id, (g.votes.get(old.account_id) || 0) + 1);
      if (!g.sample.has(old.account_id) || (!g.sample.get(old.account_id).business_name && old.business_name)) g.sample.set(old.account_id, old);
    }
  }
  const out = new Map();
  for (const [key, g] of groups) {
    const known = g.campaign_id ? campaigns.get(g.campaign_id) : null;
    const name = g.campaign_name || (known && known.campaign_name) || null;
    let account; let via = 'pseudo';
    if (!g.campaign_id) {
      account = `C${managerId || 'unknown'}`;
    } else if (known && !isPseudoAccount(known.account_id)) {
      account = known.account_id; via = 'campaign';
    } else if (g.votes.size) {
      // Most leads wins; a tie goes to the lower id so a re-run decides the same way.
      [account] = [...g.votes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
      via = 'leads';
    } else {
      account = `C${g.campaign_id}`;
    }
    const tied = via !== 'pseudo';
    const sample = tied ? g.sample.get(account) : null;
    out.set(key, {
      campaign_id: g.campaign_id,
      campaign_name: name,
      account_id: account,
      tied,
      via,
      // A real account's name and geo come from its own rows (the importer looks one up when none is in this file).
      business_name: tied ? (sample && sample.business_name) || null : pplBusinessName(g.campaign_id, name),
      geo: tied ? (sample && sample.geo) || null : null,
    });
  }
  return out;
}

function pplHashOf(lead) {
  const parts = [...PPL_TRACKED.map((k) => lead[k] ?? null), pplBlank(lead.raw && lead.raw['Lead status']), pplBlank(lead.raw && lead.raw['Last Updated'])];
  return `ppl:${crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex')}`;
}

/** A normalised lead + its campaign's account → the full row to store. */
function pplLeadRow(lead, account) {
  const row = {
    google_lead_id: lead.google_lead_id,
    account_id: account.account_id,
    business_name: account.business_name,
    geo: account.geo,
    campaign_id: lead.campaign_id,
    campaign_name: lead.campaign_name,
    charge_status: lead.charge_status,
    charged: lead.charged,
    lead_created_local: lead.lead_created_local,
    time_known: false,
    lead_type: lead.lead_type,
    lead_category: lead.lead_category,
    job_type: lead.job_type,
    customer_name: lead.customer_name,
    customer_phone: lead.customer_phone,
    customer_phone_ext: lead.customer_phone_ext,
    source_format: 'ppl',
  };
  row.row_hash = pplHashOf({ ...row, raw: lead.raw });
  row.raw = lead.raw;
  return row;
}

/**
 * Compare pay-per-lead rows (from pplLeadRow) with what is stored. Pure.
 * A lead the detailed report already stored keeps its account, time, type, phone and hash:
 * it only gains the campaign and the charge status, as a PATCH ({ ids, patch }, one per
 * distinct patch). A lead this report stored before is diffed on its own hash.
 */
function diffPplLeads(rows, existing, managerId, nowIso) {
  const writes = []; const changes = []; const byPatch = new Map();
  const counts = { new: 0, matched: 0, patched: 0, changed: 0, same: 0 };
  const log = (id, old, next, fields) => {
    for (const f of fields) {
      if (!(f in next) || old[f] === null || old[f] === undefined) continue; // a first fill is not a change
      if (show(old[f]) !== show(next[f])) changes.push({ google_lead_id: id, field: f, old_value: show(old[f]), new_value: show(next[f]) });
    }
  };
  for (const row of rows) {
    const old = existing.get(row.google_lead_id);
    const managers = new Set(old ? old.manager_ids || [] : []);
    const knewManager = !managerId || managers.has(managerId);
    if (managerId) managers.add(managerId);
    const manager_ids = [...managers].sort();
    if (!old) {
      counts.new++;
      writes.push({ ...row, manager_ids, changed_at: null });
    } else if (!isPplHash(old.row_hash)) {
      counts.matched++;
      const patch = {};
      for (const f of ['campaign_id', 'campaign_name', 'charge_status']) if ((old[f] ?? null) !== (row[f] ?? null)) patch[f] = row[f] ?? null;
      if (row.charged !== null && (old.charged ?? null) !== row.charged) patch.charged = row.charged; // "In review" says nothing yet
      if (!knewManager) patch.manager_ids = manager_ids;
      if (!Object.keys(patch).length) continue;
      counts.patched++;
      log(row.google_lead_id, old, patch, PPL_LOGGED);
      const key = JSON.stringify(Object.keys(patch).sort().map((k) => [k, patch[k]]));
      if (!byPatch.has(key)) byPatch.set(key, { ids: [], patch });
      byPatch.get(key).ids.push(row.google_lead_id);
    } else if (old.row_hash !== row.row_hash) {
      counts.changed++;
      log(row.google_lead_id, old, row, PPL_LOGGED);
      writes.push({ ...row, manager_ids, changed_at: nowIso });
    } else {
      counts.same++;
      if (!knewManager) writes.push({ ...row, manager_ids, changed_at: old.changed_at ?? null });
    }
  }
  return { writes, patches: [...byPatch.values()], changes, counts };
}

function pplSummaryLine({ rowCount, counts, rejected, campaigns, tied }) {
  const parts = [`${counts.new} new`, `${counts.matched} matched to existing leads`, `${counts.changed} changed`, `${counts.same} same`];
  if (rejected) parts.push(`${rejected} rejected`);
  return `${rowCount} rows: ${parts.join(', ')}; ${campaigns} campaign${campaigns === 1 ? '' : 's'} (${tied} tied to an account)`;
}

/** Run one pay-per-lead import. `db` as importReport, plus update(table, query, patch). */
async function importPplReport(db, { csv, managerId, filename, source }, now = () => new Date()) {
  const meta = {
    manager_id: managerId || null,
    range_from: null,
    range_to: null,
    filename: filename ? String(filename).slice(0, 200) : null,
    sha256: crypto.createHash('sha256').update(csv).digest('hex'),
    source: source || 'bot',
  };
  let parsed;
  try {
    parsed = parsePplReport(csv);
  } catch (err) {
    if (!(err instanceof ImportError)) throw err;
    await db.insert('lsa_imports', [{ ...meta, error: err.message.slice(0, 500) }]);
    return { status: err.status, text: err.message };
  }
  const { leads, rejected, rowCount, range } = parsed;
  // The file states its range in words ("All time"), not as two dates: keep it beside the name.
  if (range) meta.filename = `${meta.filename || 'pay-per-lead leads'} [${range}]`.slice(0, 200);

  const existing = new Map();
  const fields = 'google_lead_id,row_hash,manager_ids,changed_at,account_id,business_name,geo,campaign_id,campaign_name,charge_status,charged,source_format';
  for (const ids of chunk(leads.map((l) => l.google_lead_id), 150)) {
    const rows = await db.select('lsa_leads', `select=${fields}&google_lead_id=in.(${ids.join(',')})`);
    for (const r of rows) existing.set(r.google_lead_id, r);
  }
  const campaigns = new Map();
  const campaignIds = [...new Set(leads.map((l) => l.campaign_id).filter(Boolean))];
  for (const ids of chunk(campaignIds, 150)) {
    const rows = await db.select('lsa_campaigns', `select=campaign_id,campaign_name,manager_id,account_id&campaign_id=in.(${ids.join(',')})`);
    for (const r of rows) campaigns.set(r.campaign_id, r);
  }

  const accounts = decidePplAccounts(leads, existing, campaigns, meta.manager_id);
  // A real account none of this file's leads is stored under yet: read its name and geo from one of its rows.
  const looked = new Map();
  for (const a of accounts.values()) {
    if (!a.tied || a.business_name) continue;
    if (!looked.has(a.account_id)) {
      const rows = await db.select('lsa_leads', `select=account_id,business_name,geo&account_id=eq.${encodeURIComponent(a.account_id)}&business_name=not.is.null&limit=1`);
      looked.set(a.account_id, rows[0] || null);
    }
    const found = looked.get(a.account_id);
    if (found) { a.business_name = found.business_name || null; a.geo = found.geo || null; }
  }

  const nowIso = now().toISOString();
  const rows = leads.map((l) => pplLeadRow(l, accounts.get(l.campaign_id || '')));
  const { writes, patches, changes, counts } = diffPplLeads(rows, existing, meta.manager_id, nowIso);
  const withId = [...accounts.values()].filter((a) => a.campaign_id);
  const tied = withId.filter((a) => a.tied).length;

  const [imp] = await db.insert('lsa_imports', [{
    ...meta, row_count: rowCount, new_count: counts.new, changed_count: counts.changed + counts.patched,
    same_count: counts.same + counts.matched - counts.patched,
    rejected_count: rejected.length, error: rejected.length ? rejected.slice(0, 5).join('; ').slice(0, 500) : null,
  }]);
  // decidePplAccounts never returns a pseudo-account for a campaign recorded under a real one.
  const campaignRows = withId.map((a) => {
    const known = campaigns.get(a.campaign_id);
    return {
      campaign_id: a.campaign_id, campaign_name: a.campaign_name, manager_id: meta.manager_id || (known && known.manager_id) || null,
      account_id: a.account_id, updated_at: nowIso,
    };
  });
  for (const part of chunk(campaignRows, 500)) await db.upsert('lsa_campaigns', part, 'campaign_id');
  for (const part of chunk(writes, 500)) await db.upsert('lsa_leads', part, 'google_lead_id');
  for (const { ids, patch } of patches) {
    for (const part of chunk(ids, 150)) await db.update('lsa_leads', `google_lead_id=in.(${part.join(',')})`, patch);
  }
  for (const part of chunk(changes.map((c) => ({ ...c, import_id: imp && imp.id })), 500)) await db.insert('lsa_lead_changes', part);

  return { status: 200, text: pplSummaryLine({ rowCount, counts, rejected: rejected.length, campaigns: withId.length, tied }) };
}

function keyOk(provided, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function restDb({ SUPABASE_URL, SUPABASE_SERVICE_KEY }) {
  const headers = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` };
  const fail = async (what, r) => { throw new Error(`${what} ${r.status} ${(await r.text()).slice(0, 300)}`); };
  return {
    async select(table, query) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, { headers });
      return r.ok ? r.json() : fail(`${table} select`, r);
    },
    async upsert(table, rows, conflictCol) {
      if (!rows.length) return;
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${conflictCol}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(rows),
      });
      if (!r.ok) await fail(`${table} upsert`, r);
    },
    /** PATCH the rows a PostgREST filter selects (an upsert of a partial row would trip NOT NULL). */
    async update(table, query, patch) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(patch),
      });
      if (!r.ok) await fail(`${table} update`, r);
    },
    async insert(table, rows) {
      if (!rows.length) return [];
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify(rows),
      });
      return r.ok ? r.json() : fail(`${table} insert`, r);
    },
  };
}

/**
 * POST /lsa/import?account=<manager id>&from=YYYY-MM-DD&to=YYYY-MM-DD
 *   Authorization: Bearer <LSA_IMPORT_KEY>     Content-Type: text/csv     body = the file
 * Replies in plain text: "1519 rows: 9 new, 3 changed, 1507 same", or the reason it was refused.
 *
 * The same route takes the pay-per-lead leads report (?format=ppl, or recognised by its
 * title line / "Lead details" header) and replies
 * "4654 rows: 3100 new, 1200 matched to existing leads, 0 changed, 350 same; 27 campaigns (9 tied to an account)".
 */
function mountLsaImport(app, { express, SUPABASE_URL, SUPABASE_SERVICE_KEY, LSA_IMPORT_KEY, db }) {
  const store = db || restDb({ SUPABASE_URL, SUPABASE_SERVICE_KEY });
  // Files arrive several at a time and the same lead can sit in two of them; one at a
  // time keeps the manager_ids merge and the change log honest.
  let queue = Promise.resolve();
  const inTurn = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

  app.post('/lsa/import', express.text({ type: ['text/csv', 'text/plain'], limit: '25mb' }), async (req, res) => {
    res.type('text/plain');
    if (!LSA_IMPORT_KEY) return res.status(503).send('LSA import is not configured (LSA_IMPORT_KEY is not set)');
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (!keyOk(bearer && bearer[1], LSA_IMPORT_KEY)) return res.status(401).send('Unauthorized');
    if (typeof req.body !== 'string' || !req.body.trim()) return res.status(400).send('Send the CSV as the request body with Content-Type: text/csv');
    const managerId = String(req.query.account || '').replace(/\D/g, '');
    let filename = null;
    try { filename = decodeURIComponent(String(req.headers['x-filename'] || '')) || null; } catch { filename = null; }
    try {
      const out = await inTurn(() => importReport(store, {
        csv: req.body, managerId, from: req.query.from, to: req.query.to, filename, source: String(req.query.source || 'bot').slice(0, 20),
        format: String(req.query.format || '').toLowerCase() === 'ppl' ? 'ppl' : null,
      }));
      res.status(out.status).send(out.text);
    } catch (err) {
      console.error('[lsa] import failed:', err.message);
      res.status(500).send(`Import failed: ${err.message.slice(0, 200)}`);
    }
  });
}

module.exports = mountLsaImport;
Object.assign(module.exports, {
  COLUMNS, TRACKED, ImportError, parseCsv, parseReport, normalizeRow, localTimestamp, splitPhone, diffLeads,
  summaryLine, importReport, keyOk, restDb,
  PPL_COLUMNS, PPL_TRACKED, looksLikePpl, pplDate, pplPhone, normalizePplRow, parsePplReport, pplBusinessName,
  decidePplAccounts, pplLeadRow, diffPplLeads, pplSummaryLine, importPplReport, isPplHash,
});
