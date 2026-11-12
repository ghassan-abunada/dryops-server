'use strict';

// Google Local Services Ads lead import.
//
// The LSA export bot (lsa-bot/) posts each manager account's "Detailed Lead Report"
// CSV, untouched, to POST /lsa/import. This module validates the columns, turns each
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
      writes.push({ ...lead, manager_ids, changed_at: nowIso });
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
async function importReport(db, { csv, managerId, from, to, filename, source }, now = () => new Date()) {
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
  for (const part of chunk(writes, 500)) await db.upsert('lsa_leads', part, 'google_lead_id');
  for (const part of chunk(changes.map((c) => ({ ...c, import_id: imp && imp.id })), 500)) await db.insert('lsa_lead_changes', part);

  return { status: 200, text: summaryLine({ rowCount, counts, rejected: rejected.length }) };
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
  summaryLine, importReport, keyOk,
});
