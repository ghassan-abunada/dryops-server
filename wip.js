// ── WIP report pages ──────────────────────────────────────────────────────────
// Owner link  : GET /wip/<token>            — per-location form (no login)
// Master link : GET /wip/master/<token>     — dashboard for a MANAGER's locations
//                                             (wip_managers.token) or, with the
//                                             legacy wip_config.master_token, every
//                                             pooled location ("super master")
// Admin link  : GET /wip/admin/<admin>      — add managers, assign locations
// Tokens are the credential (supabase_wip_pages.sql + supabase_wip_dashboard.sql).
// Everything here talks to Supabase with the service key; RLS with no policies.
// HTML for the master/admin pages lives in wipDash.js, PDFs in wipPdf.js.

const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const { z } = require('zod');

// Locations carry every record type they run (mitigation, contents, abatement,
// rebuild, testing) — nothing is filtered by record type. Grouping is by status:
// production-stage work that isn't finished counts as "in progress" by default.
//
// Two different status lists on purpose:
//  • COLLECTING_STATUSES decides which jobs sit in the "Money coming in this
//    week" section — anything invoiced where a payment could still land,
//    including Payment Plan / Attorney / Public Adjuster.
//  • Total AR is NOT derived from that section. It is the DryOps definition
//    (lib/ar.ts + public.is_ar_status(): Invoice Created / Invoiced / Pending
//    Payment(s), every record type) over jobs.approved_invoice_due — the
//    JobNimbus job's approved-invoice balance that server.js keeps fresh — via
//    the same open_ar_total RPC the Dashboard calls. The `invoices` mirror is
//    no longer used here: it misses JN deletions and some paid updates.
const COLLECTING_STATUSES = new Set(['Invoiced', 'Pending Payment', 'Pending Payments', 'Payment Plan', 'Attorney', 'Public Adjuster']);
// Work Complete stays "in progress" (still WIP until invoiced); these are the
// post-work statuses that are excluded by default.
const BILLING_STATUSES = new Set(['Invoice Created', 'In storage', 'PB complete', 'PO Complete', 'Revision Requested']);
const HOLD_STATUSES = new Set(['Pending Results', 'Pending Abatement', 'Customer Requested Hold']);
const TYPE_TAG = { Contents: 'Contents', Rebuild: 'Rebuild', Abatements: 'Abatement', Testing: 'Testing', Roofing: 'Roofing', Commercial: 'Commercial' };
function typeTag(recordType) {
  if (!recordType || recordType === 'Mitigation') return '';
  return ' (' + (TYPE_TAG[recordType] || recordType) + ')';
}

const DASH = require('./wipDash');
const OWNER = require('./wipOwner');
const PDF = require('./wipPdf');

// deps: jnGet(pathAndQuery) → parsed JobNimbus JSON; anthropic → an SDK client
// (or null when the review feature is unconfigured); locationLogoUrl(loc) →
// public logo URL for a {name, logo_url} location (per-location logo, else the
// brand pack) and logoPngFromUrl(url) → PNG bytes for pdfkit — both optional.
// Credentials stay in server.js.
module.exports = function mountWip(app, { SUPABASE_URL, SUPABASE_SERVICE_KEY, jnGet, anthropic, locationLogoUrl, logoPngFromUrl }, opts = {}) {
  const sbHeaders = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` };
  const money2 = v => Math.round(Number(v) * 100) / 100;

  async function sbGet(pathAndQuery) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, { headers: sbHeaders });
    if (!r.ok) throw new Error(`supabase ${r.status} on ${pathAndQuery.split('?')[0]}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }
  async function sbWrite(method, pathAndQuery, body, prefer) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
      method,
      headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: prefer || 'return=representation' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`supabase ${r.status} ${method} ${pathAndQuery.split('?')[0]}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }
  async function sbRpc(name, args) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: 'POST', headers: { ...sbHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(args || {}),
    });
    if (!r.ok) throw new Error(`supabase ${r.status} rpc ${name}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }
  // PostgREST caps every response at 1000 rows: page until a short page.
  async function sbGetAll(pathAndQuery, pageSize = 1000) {
    const out = [];
    for (let offset = 0; ; offset += pageSize) {
      const rows = await sbGet(`${pathAndQuery}&limit=${pageSize}&offset=${offset}`);
      out.push(...rows);
      if (rows.length < pageSize) return out;
    }
  }
  function isMissingTable(err) { return /supabase 404|42P01|PGRST205|does not exist/.test(String(err && err.message)); }
  function newToken() { return crypto.randomBytes(18).toString('base64').replace(/\//g, '_').replace(/\+/g, '-'); }

  // ── Token lookups ───────────────────────────────────────────────────────────
  const POOL_SELECT = 'id,location_id,token,label,sort_order,added_at,bank_balance,bank_balance_at,bank_balance_by,locations(name,logo_url)';
  let configCache = { at: 0, master: null, admin: null };
  async function wipConfig() {
    if (Date.now() - configCache.at < 60000 && configCache.master) return configCache;
    let row;
    try { row = (await sbGet('wip_config?id=eq.1&select=master_token,admin_token'))[0] || {}; }
    catch (err) { // admin_token column not there yet (supabase_wip_dashboard.sql not run)
      if (!/admin_token/.test(err.message)) throw err;
      row = (await sbGet('wip_config?id=eq.1&select=master_token'))[0] || {};
    }
    configCache = { at: Date.now(), master: row.master_token || null, admin: row.admin_token || null };
    return configCache;
  }
  async function masterToken() { return (await wipConfig()).master; }
  function tokenOk(given, expected) {
    if (!given || !expected || given.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  }
  // /wip/master/<token>: the legacy master token = every pooled location;
  // otherwise a manager's token = that manager's locations. Sets req.wip.
  async function resolveMaster(req, res, next) {
    try {
      const t = String(req.params.master || '');
      if (tokenOk(t, await masterToken())) { req.wip = { scope: 'all', manager: null }; return next(); }
      if (t.length >= 16) {
        let m = null;
        try { m = (await sbGet(`wip_managers?token=eq.${encodeURIComponent(t)}&active=is.true&select=id,name,email,token,last_opened_at&limit=1`))[0] || null; }
        catch (err) { if (!isMissingTable(err)) throw err; }
        if (m && tokenOk(t, m.token)) { req.wip = { scope: 'manager', manager: m }; return next(); }
      }
      res.status(404).send(page('Not found', '<p>This link is not valid.</p>'));
    } catch (err) { res.status(502).send(page('Error', `<p>${esc(err.message)}</p>`)); }
  }
  async function requireAdmin(req, res, next) {
    try {
      const cfg = await wipConfig();
      if (!cfg.admin) return res.status(404).send(page('Not set up', '<p>The admin link is not set up yet — run <b>supabase_wip_dashboard.sql</b> in Supabase, then use the link it prints.</p>'));
      if (!tokenOk(String(req.params.admin || ''), cfg.admin)) return res.status(404).send(page('Not found', '<p>This link is not valid.</p>'));
      next();
    } catch (err) { res.status(502).send(page('Error', `<p>${esc(err.message)}</p>`)); }
  }
  async function poolByToken(token) {
    if (!token || token.length < 16) return null;
    const rows = await sbGet(`wip_pool?token=eq.${encodeURIComponent(token)}&select=${POOL_SELECT}&limit=1`);
    return rows[0] || null;
  }
  // Every pooled location, or only the ones linked to a manager.
  async function loadPool(managerId) {
    if (!managerId) return sbGet(`wip_pool?select=${POOL_SELECT}&order=sort_order.asc,added_at.asc`);
    const links = await sbGet(`wip_manager_locations?manager_id=eq.${encodeURIComponent(managerId)}&select=pool_id,sort_order,wip_pool(${POOL_SELECT})`);
    return links.filter(l => l.wip_pool).map(l => ({ ...l.wip_pool, sort_order: l.sort_order }))
      .sort((a, b) => (a.sort_order - b.sort_order) || String(a.added_at).localeCompare(String(b.added_at)));
  }
  const poolsFor = req => loadPool(req.wip && req.wip.manager ? req.wip.manager.id : null);

  // Location logo: per-location logo_url, else the brand pack (server.js
  // locationLogoUrl, same rule as the photo report). Cached 10 min per location.
  const logoCache = new Map();
  async function logoFor(pool) {
    const loc = pool.locations || {};
    const hit = logoCache.get(pool.location_id);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.url;
    let url = loc.logo_url || null;
    if (!url && locationLogoUrl) { try { url = await locationLogoUrl(loc); } catch (err) { url = null; } }
    logoCache.set(pool.location_id, { url, at: Date.now() });
    return url;
  }

  // ── Data ────────────────────────────────────────────────────────────────────
  function cleanName(n) {
    // "Jane Doe (A1 - DAL - MIT)" → "Jane Doe"; the trailing code bracket is
    // the JN naming convention, not part of the customer's name.
    return String(n || '').replace(/\s*\([^()]*\b(MIT|CON|REB|TST|ABT|PO|PB)\b[^()]*\)\s*$/i, '').trim();
  }

  // wip_entries with the dashboard columns (collect_amount, ai_*); falls back
  // to the base columns until supabase_wip_dashboard.sql has run.
  const ENTRY_COLS = 'key,custom_name,category,amount,note,updated_by,updated_at';
  const ENTRY_COLS_V2 = ENTRY_COLS + ',collect_amount,ai_decision,ai_amount,ai_reason,ai_at';
  let entryColsV2 = true;
  async function sbGetEntries(locId) {
    if (entryColsV2) {
      try { return await sbGet(`wip_entries?location_id=eq.${locId}&select=${ENTRY_COLS_V2}`); }
      catch (err) { if (!/collect_amount|ai_decision|ai_amount|ai_reason|ai_at|42703/.test(err.message)) throw err; entryColsV2 = false; }
    }
    return sbGet(`wip_entries?location_id=eq.${locId}&select=${ENTRY_COLS}`);
  }
  async function loadLocation(pool) {
    const locId = pool.location_id;
    // Per-job balances come from the JobNimbus job rollup (approved invoices
    // only), the same columns DryOps' Stats / Collections read.
    const [jobs, entries, arRpc, logo] = await Promise.all([
      sbGet(`jobs?location_id=eq.${locId}&or=(stage.is.null,stage.not.in.(Completed,Lost))&name=not.ilike.*test%20dummy*`
        + `&select=id,jn_id,number,name,status,stage,record_type,insurance_type,jn_created,approved_invoice_total,approved_invoice_due&order=jn_created.asc`),
      sbGetEntries(locId),
      // Total AR — identical to the Dashboard's Open AR card for this location.
      sbRpc('open_ar_total', { p_location_ids: [String(locId)] }),
      logoFor(pool),
    ]);
    const byKey = Object.fromEntries(entries.map(e => [e.key, e]));

    const rows = jobs.map(j => {
      const e = byKey[j.id];
      const group = COLLECTING_STATUSES.has(j.status) ? 'ar'
        : BILLING_STATUSES.has(j.status) ? 'billing'
        : HOLD_STATUSES.has(j.status) ? 'other'
        : (j.status === 'In Progress' || j.stage === 'In Production') ? 'in_progress' : 'other';
      // No saved entry yet: In Progress jobs count by default, nothing else does.
      // A saved entry only counts if it fits the job's current section: a job
      // valued while In Progress that is now invoiced must not stay in the In
      // Progress list (the estimate itself lives on in wip_job_estimates).
      // Billing/hold jobs keep an owner's opt-in value only while nothing has
      // been invoiced on them (Invoice Created already carries an invoice).
      const invoiced = Number(j.approved_invoice_total || 0) > 0;
      let category = null, amount = e && e.amount != null ? Number(e.amount) : null;
      let collectAmount = e && e.collect_amount != null ? Number(e.collect_amount) : null;
      if (group === 'ar') { category = e && e.category === 'collecting' ? 'collecting' : null; if (category !== 'collecting') amount = null; collectAmount = null; }
      else if (group === 'in_progress') category = e ? (e.category === 'in_progress' ? 'in_progress' : null) : 'in_progress';
      else if (e && e.category === 'in_progress' && !invoiced) category = 'in_progress';
      else { amount = null; collectAmount = null; }
      if (category !== 'in_progress') collectAmount = null;
      const ownerTouched = !!(e && e.updated_by && !/^(ai-review|seed)/.test(e.updated_by));
      // "lit": the Saturday review decided this row after the owner last touched it (or the owner never has).
      const lit = !!(e && e.ai_at && (!ownerTouched || String(e.ai_at) > String(e.updated_at || '')));
      return {
        key: j.id, name: cleanName(j.name) + typeTag(j.record_type), number: j.number, status: j.status, stage: j.stage,
        record_type: j.record_type, oop: !!j.insurance_type && j.insurance_type !== 'Insurance',
        created: j.jn_created ? j.jn_created.slice(0, 10) : null, createdLabel: when(j.jn_created, { time: false }),
        due: j.approved_invoice_due != null ? money2(j.approved_invoice_due) : null,
        inv_total: j.approved_invoice_total != null ? money2(j.approved_invoice_total) : null,
        group, category, amount, collect_amount: collectAmount,
        ai_decision: (e && e.ai_decision) || null, ai_amount: e && e.ai_amount != null ? Number(e.ai_amount) : null,
        ai_reason: (e && e.ai_reason) || null, ai_at: (e && e.ai_at) || null, lit, answered: ownerTouched,
        note: (e && e.note) || '', custom: false, jn_id: j.jn_id,
        updated_by: (e && e.updated_by) || null,
      };
    });
    for (const e of entries) {
      if (!e.key.startsWith('custom:')) continue;
      rows.push({ key: e.key, name: e.custom_name || '(unnamed)', number: null, status: 'Added by owner', stage: null,
        record_type: null, oop: false, created: e.updated_at ? String(e.updated_at).slice(0, 10) : null, due: null, inv_total: null,
        group: 'custom', category: e.category, amount: e.amount != null ? Number(e.amount) : null, collect_amount: null,
        ai_decision: null, ai_amount: null, ai_reason: null, ai_at: null, lit: false, answered: true, note: e.note || '', custom: true });
    }
    const owned = entries.filter(e => e.updated_by && !/^(ai-review|seed)/.test(e.updated_by));
    const lastUpdate = owned.reduce((m, e) => (String(e.updated_at || '') > m ? String(e.updated_at) : m), '');
    const lastBy = owned.filter(e => String(e.updated_at) === lastUpdate).map(e => e.updated_by).find(Boolean) || '';
    // Total AR = open_ar_total(location): sum(jobs.approved_invoice_due) over
    // Invoice Created / Invoiced / Pending Payment(s) jobs — the DryOps number.
    const arTotal = money2(arRpc || 0);
    const bank = pool.bank_balance != null ? { balance: Number(pool.bank_balance), at: pool.bank_balance_at, by: pool.bank_balance_by } : null;
    return { pool, label: pool.label || (pool.locations && pool.locations.name) || 'Location', name: (pool.locations && pool.locations.name) || '', logo, rows, lastUpdate, lastBy, arTotal, bank };
  }
  function bankLine(bank) {
    if (!bank) return 'Bank balance — not entered';
    const when = bank.at ? new Date(bank.at).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: 'America/Chicago' }) : '';
    return `Bank balance — ${whole(bank.balance)}${when ? ` (as of ${when}${bank.by ? ', ' + bank.by : ''})` : ''}`;
  }

  // ── Report text ─────────────────────────────────────────────────────────────
  function money(v, k) {
    const n = Number(v || 0);
    if (k && n >= 1000 && n % 500 === 0) return n % 1000 === 0 ? `$${n / 1000}k` : `$${(n / 1000).toFixed(1)}k`;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function whole(v) { return '$' + Math.round(Number(v || 0)).toLocaleString('en-US'); }

  // In Progress = every counted job; Collecting = confirmed invoiced rows plus
  // In Progress jobs the owner marked "paying this week" (out-of-pocket).
  function reportLists(data) {
    const inProg = data.rows.filter(r => r.category === 'in_progress');
    const coll = data.rows.filter(r => r.category === 'collecting')
      .map(r => ({ ...r, amount: r.amount != null ? r.amount : r.due, why: r.ai_reason || '' }))
      .concat(data.rows.filter(r => r.category === 'in_progress' && r.collect_amount != null)
        .map(r => ({ ...r, amount: r.collect_amount, why: r.oop ? 'out of pocket' : '' })))
      .sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0));
    const ipTotal = money2(inProg.reduce((s, r) => s + Number(r.amount || 0), 0));
    const cTotal = money2(coll.reduce((s, r) => s + Number(r.amount || 0), 0));
    return { inProg, coll, ipTotal, cTotal };
  }
  function weekOf(now = new Date()) {
    const w = upcomingWeek(now);
    const d = new Date(w.start + 'T12:00:00Z');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }
  // The text owners send. Four numbers first, then the two lists.
  function sectionText(data) {
    const { inProg, coll, ipTotal, cTotal } = reportLists(data);
    const lines = [
      `${data.label.toUpperCase()} · WEEK OF ${weekOf().toUpperCase()}`,
      `In Progress · ${inProg.length} job${inProg.length === 1 ? '' : 's'} · ${whole(ipTotal)}`,
      `Collecting this week · ${coll.length} · ${whole(cTotal)}`,
      `AR ${whole(data.arTotal)} · Bank ${data.bank ? whole(data.bank.balance) : 'not entered'}`,
      '', 'IN PROGRESS',
    ];
    inProg.forEach(r => lines.push(`${r.name} — ${r.amount != null ? money(r.amount, true) : 'no number yet'}${r.oop ? ' · OOP' : ''}${r.collect_amount != null ? ' · paying this week ' + money(r.collect_amount, true) : ''}${r.note ? ' · ' + r.note : ''}`));
    if (!inProg.length) lines.push('(none)');
    lines.push('', 'COLLECTING THIS WEEK');
    coll.forEach(r => lines.push(`${r.name} — ${money(r.amount)}${r.why ? ' · ' + r.why : ''}${r.note ? ' · ' + r.note : ''}`));
    if (!coll.length) lines.push('(none)');
    return { text: lines.join('\n'), ipTotal, cTotal, arTotal: data.arTotal, bank: data.bank, ipCount: inProg.length, cCount: coll.length };
  }
  function today() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); }
  function reportHeader(title) { return [`WIP — ${title} — ${today()}`, ''].join('\n'); }

  async function saveSnapshot(locationId, body, ip, c, managerId, by) {
    const row = { location_id: locationId, body, in_progress_total: ip, collecting_total: c };
    const extra = {}; if (managerId) extra.manager_id = managerId; if (by) extra.generated_by = String(by).slice(0, 80);
    if (Object.keys(extra).length) {
      try { return await sbWrite('POST', 'wip_snapshots', { ...row, ...extra }, 'return=minimal'); }
      catch (err) { if (!/manager_id|generated_by|42703/.test(err.message)) throw err; } // columns not migrated yet
    }
    await sbWrite('POST', 'wip_snapshots', row, 'return=minimal');
  }
  // Null-safe date formatting for anything that came back from the database.
  function when(iso, opts = {}) {
    if (!iso) return '';
    const d = new Date(iso); if (isNaN(d.getTime())) return '';
    const f = { timeZone: 'America/Chicago', month: 'short', day: 'numeric' };
    if (opts.time !== false) { f.hour = 'numeric'; f.minute = '2-digit'; }
    return d.toLocaleString('en-US', f);
  }
  function errorPage(res, err, tag) {
    console.error(`[wip ${tag}]`, err && err.message);
    res.status(502).send(page('Something went wrong', `<div class="card"><b>We couldn't load this page.</b><div class="sub" style="margin-top:6px">Try again in a minute. If it keeps happening, send this to the office.</div><details style="margin-top:10px"><summary class="meta" style="cursor:pointer">Technical detail</summary><pre>${esc(err && err.message)}</pre></details><div class="actions" style="margin-top:12px"><a class="btn" href="">Try again</a></div></div>`));
  }

  // ── HTML shell ──────────────────────────────────────────────────────────────
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function json(o) { return JSON.stringify(o).replace(/</g, '\\u003c'); }
  // Small "?" that reveals a one-line explanation under the heading it follows.
  function q(id) { return `<button type="button" class="q" data-help="${esc(id)}" aria-label="What is this?" aria-expanded="false">?</button>`; }
  function help(id, text) { return `<div class="help" id="help-${esc(id)}">${esc(text)}</div>`; }
  // Mobile-first: one column, big tap targets, a sticky top bar and a fixed
  // bottom action bar; desktop just gets a wider column.
  const CSS = `
  :root{--bg:#F1F5F9;--card:#fff;--ink:#0F172A;--ink2:#334155;--mut:#475569;--faint:#94A3B8;--line:#E2E8F0;--acc:#0369A1;--acc2:#075985;--wash:#DBEAFE;--navy:#1C2333;--navy2:#232B3E;--hdr:#F1F5F9;--hdrsub:#7B90A8;--danger:#DC2626;--ip:#2563EB;--col:#16A34A;--amber:#D97706;--amberbg:#FFFBEB;--amberline:#F5D08A;--top:56px}
  *{box-sizing:border-box}html{-webkit-text-size-adjust:100%}[hidden]{display:none!important}
  body{margin:0;background:var(--bg);color:var(--ink);font:600 15px/1.4 -apple-system,system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-tap-highlight-color:transparent;overscroll-behavior-y:none}
  ::selection{background:var(--wash);color:var(--ink)}::placeholder{color:var(--mut);opacity:.85;font-weight:500}
  .top{position:sticky;top:0;z-index:5;background:var(--navy);color:var(--hdr);padding:calc(10px + env(safe-area-inset-top)) 16px 10px;display:flex;align-items:center;gap:10px;min-height:var(--top)}
  .top h1{font-size:18px;font-weight:800;letter-spacing:-.2px;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .top .ttl{flex:1;min-width:0}.top .sub{font-size:12px;color:var(--hdrsub);font-weight:600}
  .top .btn.ghost{background:rgba(255,255,255,.15);border-color:transparent;color:var(--hdr)}
  .nxt{display:none}@media(min-width:520px){.nxt{display:inline}}
  .steps{display:flex;gap:4px;width:84px;flex:none}.steps span{flex:1;height:4px;border-radius:2px;background:rgba(255,255,255,.18)}.steps span.on{background:#38BDF8}
  .wrap{max-width:720px;margin:0 auto;padding:14px 16px calc(96px + env(safe-area-inset-bottom))}
  h2{font-size:20px;font-weight:800;letter-spacing:-.2px;color:var(--ink);margin:4px 0 2px;display:flex;align-items:center}
  h3{font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:var(--ink2);margin:0;font-weight:800}
  .lead{color:var(--ink2);font-size:13px;font-weight:600;margin:0 0 12px}
  .sub{color:var(--ink2);font-size:13px;font-weight:600}.meta{color:var(--mut);font-size:12px;font-weight:600}.nm{font-weight:700;font-size:15px;color:var(--ink)}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:10px}
  details.sec{margin:14px 0 0}details.sec>summary{list-style:none;display:flex;align-items:center;gap:8px;padding:10px 2px;cursor:pointer;user-select:none;min-height:44px}
  details.sec>summary::-webkit-details-marker{display:none}details.sec>summary::after{content:"";margin-left:auto;width:18px;height:18px;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23475569' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E") center/18px no-repeat;transition:transform .15s}
  details.sec[open]>summary::after{transform:rotate(180deg)}.count{background:#E2E8F0;color:var(--ink2);border-radius:999px;padding:1px 8px;font-size:12px;font-weight:700}
  .job{position:relative;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px 12px 18px;margin-bottom:10px;transition:background-color .15s,border-color .15s}
  .job::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;border-radius:12px 0 0 12px;background:var(--line)}
  .job.is-ip::before{background:var(--ip)}.job.is-col::before{background:var(--col)}
  .job.need{background:var(--amberbg);border-color:var(--amberline)}.job.need::before{background:var(--amber)}
  .job.lit{background:var(--amberbg);border-color:var(--amberline)}.job.maybe::before{background:var(--amber)}
  .job.off{opacity:.7}
  .job-head{margin-bottom:8px}.job-head .meta{margin-top:2px}
  .says{margin-top:6px;font-size:13px;color:var(--ink2);font-weight:600;background:var(--bg);border-radius:8px;padding:6px 10px}
  .tag{display:inline-block;margin-left:6px;padding:2px 7px;border-radius:5px;background:rgba(148,163,184,.18);color:var(--ink2);font:800 11px/1.3 inherit;letter-spacing:.3px;text-transform:uppercase;vertical-align:middle}
  .tag.oop{background:rgba(234,88,12,.12);color:#EA580C}
  input[type=text],input[type=number],input[type=email],select,textarea{font:inherit;font-size:16px;font-weight:600;color:var(--ink);padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);min-width:0;width:100%;min-height:44px}
  input:focus-visible,select:focus-visible,textarea:focus-visible,button:focus-visible,a.btn:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
  input.nm{font-weight:700}
  .amt-row{display:flex;align-items:center;gap:8px;margin-top:8px}.amt-row .pre{color:var(--mut);font-weight:800}
  input.amt{text-align:right;font-variant-numeric:tabular-nums;font-weight:700;font-size:17px}input.nt{margin-top:8px;font-size:14px;padding:8px 12px;min-height:40px}
  .sw{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px;padding-top:10px;border-top:1px solid var(--line);font-size:13px;color:var(--ink2);cursor:pointer;min-height:44px}
  .sw input{position:absolute;opacity:0;width:0;height:0}.tog{width:44px;height:26px;border-radius:999px;background:var(--line);position:relative;flex:none;transition:background-color .15s}
  .tog::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(2,8,23,.2);transition:transform .15s}
  .sw input:checked+.tog{background:var(--acc)}.sw input:checked+.tog::after{transform:translateX(18px)}
  .rowbtns{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center}
  .btn{font:inherit;font-size:15px;font-weight:700;min-height:44px;padding:0 16px;border-radius:10px;border:1px solid var(--acc);background:var(--acc);color:#fff;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;transition:background-color .15s}
  .btn:hover{background:var(--acc2)}.btn.ghost{background:#fff;color:var(--ink2);border-color:var(--line)}.btn.ghost:hover{background:var(--bg);border-color:var(--acc);color:var(--acc)}
  .btn.small{min-height:36px;padding:0 12px;font-size:13px;border-radius:9px}.btn.danger{border-color:var(--danger);color:var(--danger);background:#fff}
  .btn.on{background:var(--col);border-color:var(--col);color:#fff}.btn.ghost.on{background:var(--bg);color:var(--ink);border-color:var(--ink2)}
  .btn:disabled{opacity:.55}
  .actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
  .bar{position:fixed;left:0;right:0;bottom:0;z-index:6;background:#fff;border-top:1px solid var(--line);padding:10px 16px calc(10px + env(safe-area-inset-bottom));display:flex;gap:8px;align-items:center}
  .bar>*{flex:none}.bar .status{flex:1}@media(min-width:760px){.bar{padding-left:calc(50% - 344px);padding-right:calc(50% - 344px)}}
  .lnk{font:inherit;font-size:13px;font-weight:700;color:var(--ink2);background:none;border:0;padding:0 4px;min-height:44px;cursor:pointer;text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--line)}.lnk:hover{color:var(--acc);text-decoration-color:var(--acc)}
  .bar .status{flex:1;min-width:0;display:flex;flex-direction:column}.bar .status b{font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:var(--mut)}.bar .status span{font-size:15px;font-weight:800;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .savenote{position:fixed;left:50%;bottom:calc(84px + env(safe-area-inset-bottom));transform:translateX(-50%) translateY(10px);z-index:7;background:var(--ink);color:#fff;font-size:13px;font-weight:700;padding:8px 14px;border-radius:999px;opacity:0;pointer-events:none;transition:opacity .15s,transform .15s}
  .savenote.ok,.savenote.err{opacity:1;transform:translateX(-50%) translateY(0)}.savenote.err{background:var(--danger);pointer-events:auto;cursor:pointer}
  pre{background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:12px;white-space:pre-wrap;font:600 13px/1.5 inherit;margin:8px 0 0;color:var(--ink)}
  pre.preview{font:600 14px/1.55 inherit}
  .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .sheet{position:fixed;inset:0;z-index:20;background:rgba(0,0,0,.4);display:none;align-items:flex-end;justify-content:center}.sheet.open{display:flex}
  .sheet>div{background:#fff;border-radius:18px 18px 0 0;padding:16px 16px calc(16px + env(safe-area-inset-bottom));width:100%;max-width:720px;max-height:85vh;overflow:auto}
  .sheet textarea{height:180px;font:600 13px/1.45 inherit;margin:10px 0}
  .list{border-top:1px solid var(--line)}.list>div{padding:10px 0;border-bottom:1px solid var(--line)}
  .lbl{display:block;font-size:11px;font-weight:800;color:var(--mut);margin:0 0 6px;text-transform:uppercase;letter-spacing:.5px}
  .need-txt{color:#9a6210;font-weight:700}
  .q{font:inherit;font-size:12px;font-weight:800;line-height:1;width:28px;height:28px;padding:0;border-radius:50%;border:1px solid var(--line);background:#fff;color:var(--ink2);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;margin-left:8px;flex:none;text-transform:none;letter-spacing:0;position:relative}
  .q::after{content:"";position:absolute;inset:-8px}
  .q.on{background:var(--acc);border-color:var(--acc);color:#fff}
  .help{display:none;color:var(--ink2);font-size:13px;font-weight:600;line-height:1.45;margin:6px 0 10px;background:var(--wash);border-radius:10px;padding:8px 12px}.help.on{display:block}
  details.sec .help{margin:0 2px 10px}
  @media(min-width:600px){.actions{grid-template-columns:repeat(4,1fr)}}
  ` + DASH.CSS;
  const ICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1C2333"/><text x="32" y="41" font-family="-apple-system,Helvetica,Arial" font-weight="800" font-size="22" text-anchor="middle" fill="#F1F5F9">WIP</text></svg>');
  function page(title, body, script, topbar, pageOpts = {}) {
    const icon = pageOpts.icon || ICON;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default"><meta name="apple-mobile-web-app-title" content="${esc(title)}">
<meta name="theme-color" content="#f3f5f2"><link rel="icon" href="${esc(icon)}"><link rel="apple-touch-icon" href="${esc(icon)}">
<title>${esc(title)}</title><style>${CSS}</style></head><body>${topbar || ''}<div class="wrap${pageOpts.wide ? ' wide' : ''}">${body}</div>
<div class="sheet" id="sheet"><div><div class="row" style="justify-content:space-between"><b id="sheet-title">Share</b><button class="btn ghost small" onclick="closeSheet()">Close</button></div>
<div class="actions"><a class="btn" id="sheet-sms" href="#">Text message</a><button class="btn ghost" id="sheet-copy">Copy text</button></div>
<textarea id="sheet-text" readonly></textarea><div class="sub">Long-press the text above to select it if the buttons don't work on your phone.</div></div></div>
<script>
function closeSheet(){document.getElementById('sheet').classList.remove('open')}
async function shareText(url,title){let text='';try{const r=await fetch(url,{cache:'no-store'});text=await r.text()}catch(e){alert('Could not load the report');return}
if(navigator.share){try{await navigator.share({title,text});return}catch(e){if(e&&e.name==='AbortError')return}}
const s=document.getElementById('sheet');document.getElementById('sheet-title').textContent=title;document.getElementById('sheet-text').value=text;
document.getElementById('sheet-sms').href='sms:?&body='+encodeURIComponent(text);
document.getElementById('sheet-copy').onclick=async()=>{try{await navigator.clipboard.writeText(text);document.getElementById('sheet-copy').textContent='Copied'}catch(e){document.getElementById('sheet-text').select()}};
s.classList.add('open')}
document.addEventListener('click',e=>{const b=e.target.closest('[data-share]');if(b){e.preventDefault();shareText(b.dataset.share,b.dataset.shareTitle||'WIP')}if(e.target.id==='sheet')closeSheet()});
document.addEventListener('click',e=>{const q=e.target.closest('.q[data-help]');if(!q)return;e.preventDefault();e.stopPropagation();const h=document.getElementById('help-'+q.dataset.help);const on=!(h&&h.classList.contains('on'));if(h)h.classList.toggle('on',on);q.classList.toggle('on',on);q.setAttribute('aria-expanded',on)});
</script>${script ? `<script>${script}</script>` : ''}</body></html>`;
  }

  // ── Owner page ──────────────────────────────────────────────────────────────
  app.get('/wip/:token', async (req, res, next) => {
    if (req.params.token === 'master' || req.params.token === 'admin') return next();
    try {
      const pool = await poolByToken(req.params.token);
      if (!pool) return res.status(404).send(page('Not found', '<div class="card"><b>This WIP link is not valid.</b><div class="sub" style="margin-top:6px">Ask the office for a fresh link.</div></div>'));
      const [data, lastSent] = await Promise.all([loadLocation(pool), lastSnapshot(pool.location_id)]);
      const { body, script, topbar } = OWNER.renderOwner(ctx, {
        token: pool.token, label: data.label, logo: data.logo, rows: data.rows, bank: data.bank,
        bankWhen: data.bank ? when(data.bank.at, { time: false }) : '', weekLabel: weekOf(),
        lastSent: lastSent ? when(lastSent.generated_at) + (lastSent.generated_by ? ' by ' + lastSent.generated_by : '') : null,
      });
      res.send(page(`${data.label} WIP`, body, script, topbar, { icon: data.logo || null }));
    } catch (err) { errorPage(res, err, 'owner'); }
  });
  async function lastSnapshot(locationId) {
    try { return (await sbGet(`wip_snapshots?location_id=eq.${locationId}&select=generated_at,generated_by&order=generated_at.desc&limit=1`))[0] || null; }
    catch (err) {
      if (!/generated_by|42703/.test(err.message)) throw err;
      return (await sbGet(`wip_snapshots?location_id=eq.${locationId}&select=generated_at&order=generated_at.desc&limit=1`))[0] || null;
    }
  }

  app.post('/wip/:token/entries', async (req, res) => {
    try {
      const pool = await poolByToken(req.params.token);
      if (!pool) return res.status(404).json({ error: 'invalid link' });
      const b = req.body || {};
      const rows = (Array.isArray(b.entries) ? b.entries : []).slice(0, 200).map(e => ({
        location_id: pool.location_id,
        key: String(e.key || '').slice(0, 80),
        category: e.category === 'in_progress' || e.category === 'collecting' ? e.category : null,
        amount: e.amount === null || e.amount === undefined || e.amount === '' || isNaN(Number(e.amount)) ? null : Math.round(Number(e.amount) * 100) / 100,
        collect_amount: e.collect_amount === null || e.collect_amount === undefined || e.collect_amount === '' || isNaN(Number(e.collect_amount)) ? null : Math.round(Number(e.collect_amount) * 100) / 100,
        note: e.note ? String(e.note).slice(0, 300) : null,
        custom_name: e.custom_name !== undefined ? String(e.custom_name || '').slice(0, 120) : undefined,
        updated_by: b.updated_by ? String(b.updated_by).slice(0, 80) : null,
        updated_at: new Date().toISOString(),
      })).filter(r => r.key && (r.key.startsWith('custom:') || /^[0-9a-f-]{36}$/.test(r.key)));
      for (const r of rows) if (r.custom_name === undefined) delete r.custom_name;
      if (rows.length) await upsertEntries(rows);
      const recorded = await recordEstimates(pool.location_id, rows);
      res.json({ ok: true, saved: rows.length, estimates: recorded });
    } catch (err) { console.error('[wip save]', err.message); res.status(502).json({ error: err.message }); }
  });
  // Upsert owner rows; drops collect_amount when the column is not migrated yet.
  async function upsertEntries(rows) {
    try { await sbWrite('POST', 'wip_entries?on_conflict=location_id,key', rows, 'resolution=merge-duplicates,return=minimal'); }
    catch (err) {
      if (!/collect_amount|42703/.test(err.message)) throw err;
      entryColsV2 = false;
      await sbWrite('POST', 'wip_entries?on_conflict=location_id,key', rows.map(({ collect_amount, ...r }) => r), 'resolution=merge-duplicates,return=minimal');
    }
  }
  // Append-only history of "what is this job worth" (wip_job_estimates) so the
  // guess survives the entry being reused once the job is invoiced. Never fails
  // the owner's save.
  async function recordEstimates(locationId, rows) {
    const est = rows.filter(r => r.category === 'in_progress' && r.amount != null && !r.key.startsWith('custom:'));
    if (!est.length) return 0;
    try {
      const latest = {};
      const prev = await sbGet(`wip_job_estimates?location_id=eq.${locationId}&job_id=in.(${est.map(r => r.key).join(',')})&select=job_id,amount,entered_at&order=entered_at.desc`);
      for (const p of prev) if (!(p.job_id in latest)) latest[p.job_id] = Number(p.amount);
      const inserts = est.filter(r => latest[r.key] !== r.amount)
        .map(r => ({ location_id: locationId, job_id: r.key, amount: r.amount, entered_by: r.updated_by, entered_at: r.updated_at }));
      if (inserts.length) await sbWrite('POST', 'wip_job_estimates', inserts, 'return=minimal');
      return inserts.length;
    } catch (err) {
      if (!isMissingTable(err)) console.error('[wip estimates]', err.message);
      return 0;
    }
  }

  app.post('/wip/:token/bank', async (req, res) => {
    try {
      const pool = await poolByToken(req.params.token);
      if (!pool) return res.status(404).json({ error: 'invalid link' });
      const b = req.body || {};
      const bal = b.balance === null || b.balance === undefined || b.balance === '' || isNaN(Number(b.balance)) ? null : Math.round(Number(b.balance) * 100) / 100;
      await sbWrite('PATCH', `wip_pool?id=eq.${pool.id}`, {
        bank_balance: bal, bank_balance_at: bal == null ? null : new Date().toISOString(),
        bank_balance_by: bal == null ? null : (b.updated_by ? String(b.updated_by).slice(0, 80) : null),
      }, 'return=minimal');
      res.json({ ok: true });
    } catch (err) { console.error('[wip bank]', err.message); res.status(502).json({ error: err.message }); }
  });

  app.post('/wip/:token/entries/delete', async (req, res) => {
    try {
      const pool = await poolByToken(req.params.token);
      if (!pool) return res.status(404).json({ error: 'invalid link' });
      const key = String((req.body || {}).key || '');
      if (!key.startsWith('custom:')) return res.status(400).json({ error: 'only owner-added lines can be removed' });
      await sbWrite('DELETE', `wip_entries?location_id=eq.${pool.location_id}&key=eq.${encodeURIComponent(key)}`, undefined, 'return=minimal');
      res.json({ ok: true });
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  app.get('/wip/:token/text', async (req, res, next) => {
    if (req.params.token === 'master') return next();
    try {
      const pool = await poolByToken(req.params.token);
      if (!pool) return res.status(404).type('text/plain').send('Invalid link');
      const data = await loadLocation(pool);
      const s = sectionText(data);
      const text = s.text + '\n';
      if (!req.query.preview) await saveSnapshot(pool.location_id, text, s.ipTotal, s.cTotal, null, req.query.by);
      res.type('text/plain; charset=utf-8').send(text);
    } catch (err) { console.error('[wip text]', err.message); res.status(502).type('text/plain').send('Could not build the report right now. Try again in a minute.'); }
  });
  app.get('/wip/:token/pdf', async (req, res, next) => {
    if (req.params.token === 'master') return next();
    try {
      const pool = await poolByToken(req.params.token);
      if (!pool) return res.status(404).type('text/plain').send('Invalid link');
      await sendLocationPdf(res, pool, null);
    } catch (err) { console.error('[wip pdf]', err.message); res.status(502).type('text/plain').send(err.message); }
  });

  // ── Weeks ───────────────────────────────────────────────────────────────────
  // "Last week" for the dashboard: the Mon–Sun before the current week, Central.
  function lastWeek(now = new Date()) {
    const d = new Date(now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }) + 'T12:00:00Z');
    const thisMonday = new Date(d); thisMonday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const start = new Date(thisMonday); start.setUTCDate(thisMonday.getUTCDate() - 7);
    const end = new Date(start); end.setUTCDate(start.getUTCDate() + 6);
    const iso = x => x.toISOString().slice(0, 10);
    return { start: iso(start), end: iso(end), endExclusive: iso(thisMonday) };
  }
  // ISO instant of 00:00 America/Chicago on a YYYY-MM-DD (DST-safe).
  function chicagoMidnightIso(ymd) {
    const guess = new Date(ymd + 'T06:00:00Z'); // 00:00 CST or 01:00 CDT
    const h = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }).format(guess), 10) % 24;
    return new Date(guess.getTime() - h * 3600000).toISOString();
  }

  // ── Dashboard data ──────────────────────────────────────────────────────────
  const INVOICED_STATUSES = new Set([...COLLECTING_STATUSES, 'Invoice Created', 'Paid & Closed', 'Paid to Lead Source']);
  function sumBy(rows, key, val) {
    const out = {};
    for (const r of rows) out[r[key]] = (out[r[key]] || 0) + Number(r[val] || 0);
    return out;
  }
  // Latest owner estimate per job joined to what the job has invoiced /
  // collected since. { available:false } until supabase_wip_dashboard.sql runs.
  async function loadAccuracy(locationIds, poolsById) {
    if (!locationIds.length) return { available: true, n: 0, pending: 0, est: 0, inv: 0, col: 0, medianInv: null, recent: [], byLoc: [] };
    let rows;
    try { rows = await sbGetAll(`wip_job_estimates?location_id=in.(${locationIds.join(',')})&select=location_id,job_id,amount,entered_at,entered_by&order=entered_at.desc`); }
    catch (err) { if (isMissingTable(err)) return { available: false }; throw err; }
    const latest = new Map();
    for (const r of rows) if (!latest.has(r.job_id)) latest.set(r.job_id, r);
    const ids = [...latest.keys()];
    const jobs = [];
    for (let i = 0; i < ids.length; i += 80) {
      jobs.push(...await sbGet(`jobs?id=in.(${ids.slice(i, i + 80).join(',')})&select=id,number,name,status,stage,location_id,record_type,approved_invoice_total,approved_invoice_due,last_invoice_date`));
    }
    const done = [];
    for (const j of jobs) {
      const e = latest.get(j.id);
      const invoiced = Number(j.approved_invoice_total || 0) > 0 && (INVOICED_STATUSES.has(j.status) || j.stage === 'Account Receivable' || j.stage === 'Completed');
      if (!invoiced || !e) continue;
      const inv = money2(j.approved_invoice_total), col = money2(Number(j.approved_invoice_total) - Number(j.approved_invoice_due || 0));
      done.push({ job_id: j.id, location_id: j.location_id, label: poolsById[j.location_id] ? poolsById[j.location_id].label : '', name: cleanName(j.name) + typeTag(j.record_type), number: j.number, est: Number(e.amount), inv, col: Math.max(0, col), when: j.last_invoice_date || e.entered_at });
    }
    const est = done.reduce((s, r) => s + r.est, 0), inv = done.reduce((s, r) => s + r.inv, 0), col = done.reduce((s, r) => s + r.col, 0);
    const ratios = done.filter(r => r.est > 0).map(r => r.inv / r.est).sort((a, b) => a - b);
    const medianInv = ratios.length ? (ratios.length % 2 ? ratios[(ratios.length - 1) / 2] : (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]) / 2) : null;
    const byLocMap = {};
    for (const r of done) { const b = byLocMap[r.location_id] || (byLocMap[r.location_id] = { label: r.label, n: 0, est: 0, inv: 0, col: 0 }); b.n++; b.est += r.est; b.inv += r.inv; b.col += r.col; }
    return {
      available: true, n: done.length, pending: ids.length - done.length, est: money2(est), inv: money2(inv), col: money2(col), medianInv,
      recent: done.sort((a, b) => String(b.when).localeCompare(String(a.when))).slice(0, 10),
      byLoc: Object.values(byLocMap).sort((a, b) => b.n - a.n),
    };
  }
  // Newest snapshot per location (the last time the owner sent, or the Saturday run saved).
  async function lastSnapshots(ids) {
    const q = `wip_snapshots?location_id=in.(${ids.join(',')})&generated_at=gte.${new Date(Date.now() - 21 * 86400000).toISOString()}&order=generated_at.desc&limit=500`;
    try { return await sbGet(`${q}&select=location_id,generated_at,generated_by`); }
    catch (err) {
      if (!/generated_by|42703/.test(err.message)) throw err;
      return sbGet(`${q}&select=location_id,generated_at`);
    }
  }
  async function loadDashboard(pools, now = new Date()) {
    const week = upcomingWeek(now), lw = lastWeek(now);
    const ids = pools.map(p => p.location_id), idList = ids.join(',');
    const startIso = chicagoMidnightIso(lw.start), endIso = chicagoMidnightIso(lw.endExclusive);
    // Forecast = the last report saved in the 7 days before last Monday (Monday itself allowed).
    const fcFrom = new Date(new Date(startIso).getTime() - 7 * 86400000).toISOString(), fcTo = new Date(new Date(startIso).getTime() + 86400000).toISOString();
    const poolsById = Object.fromEntries(pools.map(p => [p.location_id, { ...p, label: p.label || (p.locations && p.locations.name) || 'Location' }]));
    const [datas, pays, invs, snaps, reviews, accuracy, sent] = await Promise.all([
      Promise.all(pools.map(p => loadLocation(p))),
      ids.length ? sbGetAll(`payments?location_id=in.(${idList})&jn_created=gte.${startIso}&jn_created=lt.${endIso}&or=(method_id.is.null,method_id.neq.-1)&select=location_id,amount`) : [],
      ids.length ? sbGetAll(`invoices?location_id=in.(${idList})&jn_created=gte.${startIso}&jn_created=lt.${endIso}&select=location_id,total`) : [],
      ids.length ? sbGet(`wip_snapshots?location_id=in.(${idList})&generated_at=gte.${fcFrom}&generated_at=lt.${fcTo}&select=location_id,collecting_total,generated_at&order=generated_at.desc`) : [],
      ids.length ? sbGet(`wip_reviews?location_id=in.(${idList})&select=location_id,reviewed_at,jobs_reviewed,applied,result->>trigger&order=reviewed_at.desc&limit=500`) : [],
      loadAccuracy(ids, poolsById),
      ids.length ? lastSnapshots(ids) : [],
    ]);
    const collected = sumBy(pays, 'location_id', 'amount'), invoiced = sumBy(invs, 'location_id', 'total');
    const forecast = {}; for (const sn of snaps) if (!(sn.location_id in forecast)) forecast[sn.location_id] = sn.collecting_total != null ? Number(sn.collecting_total) : null;
    const lastReview = {}; for (const r of reviews) if (!(r.location_id in lastReview)) lastReview[r.location_id] = r;
    const lastSent = {}; for (const sn of sent) if (!(sn.location_id in lastSent)) lastSent[sn.location_id] = sn;
    const locations = datas.map(data => {
      const p = data.pool, s = sectionText(data), lists = reportLists(data);
      const counted = data.rows.filter(r => r.group === 'in_progress' && !r.custom && r.category === 'in_progress');
      const wc = counted.filter(r => r.status === 'Work Complete');
      return {
        id: p.id, token: p.token, location_id: p.location_id, label: data.label, name: data.name, logo: data.logo, data, lists,
        ipTotal: money2(lists.ipTotal), cTotal: money2(lists.cTotal), arTotal: data.arTotal, bank: data.bank,
        collected: money2(collected[p.location_id] || 0), invoiced: money2(invoiced[p.location_id] || 0),
        forecast: p.location_id in forecast ? forecast[p.location_id] : null,
        ipCount: counted.length, wcCount: wc.length, cCount: lists.coll.length,
        lastSent: lastSent[p.location_id] || null,
        ipMissing: counted.filter(r => r.amount == null && r.status !== 'Work Complete').length, wcMissing: wc.filter(r => r.amount == null).length,
        lastUpdate: data.lastUpdate, lastBy: data.lastBy, lastReview: lastReview[p.location_id] || null, text: s.text,
      };
    });
    const totals = { ip: 0, collecting: 0, ar: 0, bank: 0, bankMissing: 0, collected: 0, invoiced: 0, forecast: null, forecastMissing: 0, ipCount: 0, wcCount: 0, ipMissing: 0, wcMissing: 0 };
    for (const l of locations) {
      totals.ip += l.ipTotal; totals.collecting += l.cTotal; totals.ar += l.arTotal; totals.collected += l.collected; totals.invoiced += l.invoiced;
      if (l.bank) totals.bank += l.bank.balance; else totals.bankMissing++;
      if (l.forecast != null) totals.forecast = (totals.forecast || 0) + l.forecast; else totals.forecastMissing++;
      totals.ipCount += l.ipCount; totals.wcCount += l.wcCount; totals.ipMissing += l.ipMissing; totals.wcMissing += l.wcMissing;
    }
    for (const k of ['ip', 'collecting', 'ar', 'bank', 'collected', 'invoiced']) totals[k] = money2(totals[k]);
    if (totals.forecast != null) totals.forecast = money2(totals.forecast);
    totals.missing = totals.ipMissing + totals.wcMissing;
    return { week, lastWeek: lw, locations, totals, accuracy };
  }

  // ── Master page ─────────────────────────────────────────────────────────────
  const ctx = { esc, json, q, help, whole, money, when };
  function originOf(req) { return `${req.protocol}://${req.get('host')}`; }
  function titleFor(req) { return req.wip.manager ? req.wip.manager.name : 'all locations'; }

  app.get('/wip/master/:master', resolveMaster, async (req, res) => {
    try {
      const pools = await poolsFor(req);
      const dash = await loadDashboard(pools);
      const options = req.wip.scope === 'all'
        ? (await sbGetAll('locations?select=id,name&order=name.asc')).filter(l => !pools.some(p => p.location_id === l.id)) : [];
      const lastVisit = req.wip.manager ? req.wip.manager.last_opened_at : null;
      if (req.wip.manager) sbWrite('PATCH', `wip_managers?id=eq.${req.wip.manager.id}`, { last_opened_at: new Date().toISOString() }, 'return=minimal').catch(() => {});
      const { body, script, topbar } = DASH.renderMaster(ctx, {
        token: req.params.master, scope: req.wip.scope, manager: req.wip.manager, title: titleFor(req), origin: originOf(req), today: when(new Date(), { time: false }),
        week: dash.week, lastWeek: dash.lastWeek, locations: dash.locations, totals: dash.totals, accuracy: dash.accuracy, lastVisit,
        options, weeklyReview, anthropic: !!anthropic,
      });
      res.send(page(`WIP · ${titleFor(req)}`, body, script, topbar, { wide: true }));
    } catch (err) { errorPage(res, err, 'master'); }
  });

  app.get('/wip/master/:master/text', resolveMaster, async (req, res) => {
    try {
      const pool = await poolsFor(req);
      const parts = []; let ip = 0, c = 0;
      for (const p of pool) {
        const data = await loadLocation(p);
        const s = sectionText(data);
        ip += s.ipTotal; c += s.cTotal; parts.push(s.text);
      }
      // Each location stands on its own: no grand totals across locations.
      const text = reportHeader(titleFor(req).toUpperCase()) + parts.join('\n\n' + '—'.repeat(24) + '\n\n') + '\n';
      await saveSnapshot(null, text, ip, c, req.wip.manager ? req.wip.manager.id : null, titleFor(req));
      res.type('text/plain; charset=utf-8').send(text);
    } catch (err) { console.error('[wip text]', err.message); res.status(502).type('text/plain').send('Could not build the report right now. Try again in a minute.'); }
  });

  // ── PDFs ────────────────────────────────────────────────────────────────────
  function pdfName(s) { return String(s).replace(/[^\w .&'-]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  async function logoPng(url) {
    if (!url || !logoPngFromUrl) return null;
    try { return await logoPngFromUrl(url); } catch (err) { return null; }
  }
  async function sendLocationPdf(res, pool, generatedBy) {
    const dash = await loadDashboard([pool]);
    const l = dash.locations[0];
    const buf = await PDF.renderLocationPdf({
      data: l.data, lists: l.lists, logoPng: await logoPng(l.logo),
      extra: { collected: l.collected, invoiced: l.invoiced, week: dash.week, lastWeek: dash.lastWeek, generatedBy },
    });
    res.type('application/pdf').set('Content-Disposition', `attachment; filename="${pdfName(`WIP ${l.label} ${dash.week.start}`)}.pdf"`).send(buf);
  }
  app.get('/wip/master/:master/pdf', resolveMaster, async (req, res) => {
    try {
      const pools = await poolsFor(req);
      const by = req.wip.manager ? req.wip.manager.name : null;
      if (req.query.pool_id) {
        const p = pools.find(x => x.id === String(req.query.pool_id));
        if (!p) return res.status(404).type('text/plain').send('location not on this page');
        return sendLocationPdf(res, p, by);
      }
      const dash = await loadDashboard(pools);
      const title = `WIP — ${req.wip.manager ? req.wip.manager.name : 'All locations'}`;
      const buf = await PDF.renderManagerPdf({ title, week: dash.week, lastWeek: dash.lastWeek, generatedBy: by, rows: dash.locations, totals: dash.totals });
      res.type('application/pdf').set('Content-Disposition', `attachment; filename="${pdfName(`WIP ${req.wip.manager ? req.wip.manager.name : 'all locations'} ${dash.week.start}`)}.pdf"`).send(buf);
    } catch (err) { console.error('[wip pdf]', err.message); res.status(502).type('text/plain').send(err.message); }
  });

  // ── Pool admin (super master only) + per-location edits (any master) ───────
  function requireAll(req, res, next) {
    if (req.wip.scope !== 'all') return res.status(403).send('only the all-locations page can change the pool');
    next();
  }
  app.post('/wip/master/:master/locations', resolveMaster, requireAll, async (req, res) => {
    try {
      const id = String((req.body || {}).location_id || '');
      if (!/^[0-9a-f-]{36}$/.test(id)) return res.status(400).send('location_id required');
      const loc = await sbGet(`locations?id=eq.${id}&select=id,name`);
      if (!loc[0]) return res.status(404).send('location not found');
      await sbWrite('POST', 'wip_pool?on_conflict=location_id', { location_id: id }, 'resolution=ignore-duplicates,return=minimal');
      res.json({ ok: true });
    } catch (err) { res.status(502).send(err.message); }
  });
  app.patch('/wip/master/:master/locations/:id', resolveMaster, async (req, res) => {
    try {
      const pools = await poolsFor(req);
      if (!pools.some(p => p.id === req.params.id)) return res.status(404).send('location not on this page');
      const b = req.body || {}; const patch = {};
      if (b.label !== undefined) patch.label = String(b.label || '').slice(0, 80) || null;
      if (b.sort_order !== undefined && !isNaN(Number(b.sort_order))) patch.sort_order = Number(b.sort_order);
      if (b.bank_balance !== undefined) {
        const bal = b.bank_balance === null || b.bank_balance === '' || isNaN(Number(b.bank_balance)) ? null : money2(b.bank_balance);
        patch.bank_balance = bal;
        patch.bank_balance_at = bal == null ? null : new Date().toISOString();
        patch.bank_balance_by = bal == null ? null : (req.wip.manager ? req.wip.manager.name : 'master');
      }
      if (!Object.keys(patch).length) return res.status(400).send('nothing to change');
      await sbWrite('PATCH', `wip_pool?id=eq.${encodeURIComponent(req.params.id)}`, patch, 'return=minimal');
      res.json({ ok: true });
    } catch (err) { res.status(502).send(err.message); }
  });
  app.delete('/wip/master/:master/locations/:id', resolveMaster, requireAll, async (req, res) => {
    try {
      await sbWrite('DELETE', `wip_pool?id=eq.${encodeURIComponent(req.params.id)}`, undefined, 'return=minimal');
      res.json({ ok: true });
    } catch (err) { res.status(502).send(err.message); }
  });

  // ── Admin portal: managers and their locations ──────────────────────────────
  async function loadAdmin() {
    const [managers, links, pools, locations] = await Promise.all([
      sbGet('wip_managers?select=id,name,email,token,active,created_at,last_opened_at&order=created_at.asc'),
      sbGetAll('wip_manager_locations?select=manager_id,pool_id,sort_order'),
      loadPool(),
      sbGetAll('locations?select=id,name&order=name.asc'),
    ]);
    const poolById = Object.fromEntries(pools.map(p => [p.id, p]));
    const ms = managers.map(x => ({
      ...x,
      pools: links.filter(l => l.manager_id === x.id).map(l => poolById[l.pool_id]).filter(Boolean)
        .map(p => ({ pool_id: p.id, location_id: p.location_id, name: p.locations ? p.locations.name : '', label: p.label, owner_token: p.token })),
    }));
    const locs = locations.map(l => {
      const p = pools.find(x => x.location_id === l.id);
      return { id: l.id, name: l.name, pool_id: p ? p.id : null, owner_token: p ? p.token : null, managers: ms.filter(x => x.active && x.pools.some(pp => pp.location_id === l.id)).map(x => x.name) };
    });
    return { managers: ms, locations: locs };
  }
  app.get('/wip/admin/:admin', requireAdmin, async (req, res) => {
    try {
      const a = await loadAdmin();
      const { body, script, topbar } = DASH.renderAdmin(ctx, { token: req.params.admin, masterToken: await masterToken(), origin: originOf(req), selected: String(req.query.m || '') || null, ...a });
      res.send(page('WIP · managers', body, script, topbar, { wide: true }));
    } catch (err) {
      if (isMissingTable(err)) return res.status(404).send(page('Not set up', '<div class="card"><b>Run supabase_wip_dashboard.sql in Supabase first.</b><div class="sub" style="margin-top:6px">The manager tables are missing.</div></div>'));
      errorPage(res, err, 'admin');
    }
  });
  app.post('/wip/admin/:admin/managers', requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const name = String(b.name || '').trim().slice(0, 80);
      if (!name) return res.status(400).json({ error: 'name required' });
      const rows = await sbWrite('POST', 'wip_managers', { name, email: b.email ? String(b.email).trim().slice(0, 120) : null, token: newToken() }, 'return=representation');
      res.json({ ok: true, id: rows[0].id, token: rows[0].token });
    } catch (err) { res.status(502).json({ error: err.message }); }
  });
  app.patch('/wip/admin/:admin/managers/:id', requireAdmin, async (req, res) => {
    try {
      const b = req.body || {}; const patch = {};
      if (b.name !== undefined) { const n = String(b.name || '').trim().slice(0, 80); if (n) patch.name = n; }
      if (b.email !== undefined) patch.email = String(b.email || '').trim().slice(0, 120) || null;
      if (b.active !== undefined) patch.active = !!b.active;
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to change' });
      await sbWrite('PATCH', `wip_managers?id=eq.${encodeURIComponent(req.params.id)}`, patch, 'return=minimal');
      res.json({ ok: true });
    } catch (err) { res.status(502).json({ error: err.message }); }
  });
  app.post('/wip/admin/:admin/managers/:id/token', requireAdmin, async (req, res) => {
    try {
      const token = newToken();
      await sbWrite('PATCH', `wip_managers?id=eq.${encodeURIComponent(req.params.id)}`, { token }, 'return=minimal');
      res.json({ ok: true, token });
    } catch (err) { res.status(502).json({ error: err.message }); }
  });
  app.post('/wip/admin/:admin/managers/:id/locations/:location_id', requireAdmin, async (req, res) => {
    try {
      const locId = String(req.params.location_id);
      if (!/^[0-9a-f-]{36}$/.test(locId)) return res.status(400).send('bad location id');
      let pool = (await sbGet(`wip_pool?location_id=eq.${locId}&select=id`))[0];
      if (!pool) {
        if (!(await sbGet(`locations?id=eq.${locId}&select=id`))[0]) return res.status(404).send('location not found');
        pool = (await sbWrite('POST', 'wip_pool', { location_id: locId }, 'return=representation'))[0];
      }
      await sbWrite('POST', 'wip_manager_locations?on_conflict=manager_id,pool_id', { manager_id: req.params.id, pool_id: pool.id }, 'resolution=ignore-duplicates,return=minimal');
      res.json({ ok: true, pool_id: pool.id });
    } catch (err) { res.status(502).send(err.message); }
  });
  app.delete('/wip/admin/:admin/managers/:id/locations/:location_id', requireAdmin, async (req, res) => {
    try {
      const pool = (await sbGet(`wip_pool?location_id=eq.${encodeURIComponent(req.params.location_id)}&select=id`))[0];
      if (pool) await sbWrite('DELETE', `wip_manager_locations?manager_id=eq.${encodeURIComponent(req.params.id)}&pool_id=eq.${pool.id}`, undefined, 'return=minimal');
      res.json({ ok: true });
    } catch (err) { res.status(502).send(err.message); }
  });

  // ── AI review of AR notes ───────────────────────────────────────────────────
  // Pulls each invoiced job's recent JobNimbus activity and asks Claude which
  // ones are actually collectible this week; writes the answer into wip_entries
  // as 'ai-review' rows. Owner-edited rows are never overwritten.
  const REVIEW_MODEL = 'claude-opus-5';
  // 5 weeks: a mailed carrier check takes 10–14 business days (≈ 2–3 calendar
  // weeks) to arrive, so the "issued" note for a check landing next week can be
  // up to ~3 weeks old, and an overdue one older still.
  const REVIEW_LOOKBACK_DAYS = 35;
  // The week the WIP report covers. Sat/Sun runs (the Saturday auto-review)
  // look at the coming Mon–Sun; a weekday run covers the rest of this week.
  function upcomingWeek(now = new Date()) {
    const d = new Date(now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }) + 'T12:00:00Z');
    const dow = d.getUTCDay(); // 0 Sun … 6 Sat
    const start = new Date(d);
    if (dow === 6) start.setUTCDate(d.getUTCDate() + 2);
    else if (dow === 0) start.setUTCDate(d.getUTCDate() + 1);
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + (7 - start.getUTCDay()) % 7);
    const iso = x => x.toISOString().slice(0, 10);
    return { today: iso(d), start: iso(start), end: iso(end) };
  }
  const NOISE_TYPES = new Set(['Assigned Job', 'Unassigned Job', 'Assigned Contact', 'Text Message', 'Attachment deleted', 'Related to task', 'Task Completed', 'Automation']);

  const ReviewSchema = z.object({
    jobs: z.array(z.object({
      job_number: z.string(),
      decision: z.enum(['collecting', 'not_yet', 'received']),
      amount: z.number().nullable(),
      reason: z.string(),
    })),
  });

  const REVIEW_SYSTEM = `You review collections notes for a water-damage restoration company and decide, per invoiced job, whether payment will realistically ARRIVE during the upcoming week stated in the message. "Collecting" means money we expect to have in hand that week — not money that has merely been promised.

Mail time is the key rule. Insurance carriers pay by mailed check by default, and a mailed check takes 10–14 business days (about 14–20 calendar days) to reach the office from the date it was issued/mailed. So:
- Carrier check issued or mailed on date D: expected arrival is D + 14 to D + 20 calendar days. It is "collecting" only if that arrival window overlaps the upcoming week. A check issued fewer than ~14 days before the week starts will arrive the week after — "not_yet", and say when it is expected.
- A mailed check whose arrival window has already passed (issued more than ~3 weeks ago) with no receipt logged: still "collecting" if the office has since confirmed it is in transit or has been re-issued; "not_yet" if there is no follow-up, since it may be lost and needs a call.
- EFT / ACH / direct deposit, overnight or courier, card payments, or a customer/mortgage company who says they have the check in hand or will pay that week: arrival is days, not weeks — "collecting" when the note is recent.
- "Approved", "agreed to the amount", "sent to payment processing" is NOT issued. Only count it when the notes give an issue/mail date that fits the window above, or the payer committed to paying that week.

Decisions:
- "collecting": per the rules above the money should arrive during the upcoming week. amount = the issued/agreed amount if one is stated (minus anything already paid), otherwise the balance due.
- "received": the notes say the check was received, deposited, or payment posted, but the job still shows a balance. amount = what was received. (Nobody has logged the payment yet.)
- "not_yet": anything else — invoice under review, comparative or line items disputed, claim denied, waiting on adjuster/reviewer with no answer, attorney, public adjuster or appraisal, monthly payment plan, bank investigation, customer unresponsive, or a check that will not arrive until after the upcoming week.

Be conservative: silence is "not_yet". Never invent amounts or dates. reason: one short sentence (max 120 characters) naming the payer, the date of the key note and, for mailed checks, the expected arrival. Return one entry for every job you were given.`;

  async function jnActivities(jnIds, sinceMs) {
    const out = [];
    for (let i = 0; i < jnIds.length; i += 15) {
      const filter = JSON.stringify({ must: [{ terms: { 'related.id': jnIds.slice(i, i + 15) } }] });
      let from = 0;
      for (;;) {
        const q = new URLSearchParams({ filter, size: '500', from: String(from) });
        const d = await jnGet(`activities?${q}`);
        const rows = d.activity || d.results || [];
        for (const a of rows) if ((a.date_created || 0) * 1000 >= sinceMs) out.push(a);
        if (rows.length < 500) break;
        from += 500;
      }
    }
    return out;
  }
  function plainNote(s) {
    return String(s || '').replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x2F;/g, '/')
      .replace(/\s+/g, ' ').trim();
  }

  async function reviewLocation(pool, opts = {}) {
    const progress = opts.onProgress || (() => {});
    progress('loading');
    const data = await loadLocation(pool);
    const ar = data.rows.filter(r => r.group === 'ar' && !r.custom && r.jn_id);
    const now = opts.now || new Date();
    const since = now.getTime() - REVIEW_LOOKBACK_DAYS * 86400000;
    progress('notes', { jobs: ar.length });
    const acts = ar.length ? await jnActivities(ar.map(r => r.jn_id), since) : [];
    const byJn = {};
    for (const a of acts) {
      if (NOISE_TYPES.has(a.record_type_name)) continue;
      const note = plainNote(a.note);
      if (!note) continue;
      const when = new Date((a.date_created || 0) * 1000).toISOString().slice(0, 10);
      for (const rel of a.related || []) {
        if (!byJn[rel.id]) byJn[rel.id] = [];
        byJn[rel.id].push({ when, type: a.record_type_name, note: note.slice(0, 320) });
      }
    }
    const jobs = ar.map(r => ({
      job_number: r.number, name: r.name, status: r.status, created: r.created,
      invoice_total: r.inv_total, balance_due: r.due,
      paid_so_far: r.inv_total != null && r.due != null ? Math.round((r.inv_total - r.due) * 100) / 100 : null,
      notes: (byJn[r.jn_id] || []).sort((a, b) => b.when.localeCompare(a.when)).slice(0, 12),
    }));
    if (opts.dry) return { label: data.label, jobs_reviewed: jobs.length, jobs };
    if (!anthropic) throw new Error('ANTHROPIC_API_KEY is not set on the server');
    if (!jobs.length) return { label: data.label, jobs_reviewed: 0, applied: 0, skipped_owner: [], jobs: [] };

    const week = upcomingWeek(now);
    progress('deciding', { jobs: jobs.length });
    const response = await anthropic.messages.parse({
      model: REVIEW_MODEL,
      max_tokens: 16000,
      system: REVIEW_SYSTEM,
      output_config: { format: zodOutputFormat(ReviewSchema), effort: 'medium' },
      messages: [{ role: 'user', content: `Today is ${week.today}. The upcoming week is ${week.start} (Monday) through ${week.end} (Sunday). Location: ${data.label}.\n\nJobs (with JobNimbus notes from the last ${REVIEW_LOOKBACK_DAYS} days, newest first):\n${JSON.stringify(jobs, null, 1)}` }],
    });
    if (response.stop_reason === 'refusal' || !response.parsed_output) {
      throw new Error(`model returned no decision (${response.stop_reason})`);
    }
    const decided = Object.fromEntries(response.parsed_output.jobs.map(d => [d.job_number, d]));

    progress('saving');
    const writes = []; const aiOnly = []; const results = []; const skippedOwner = [];
    const nowIso = new Date().toISOString();
    for (const r of ar) {
      const d = decided[r.number];
      if (!d) { results.push({ job_number: r.number, name: r.name, decision: 'not_yet', amount: null, reason: 'The notes gave no clear answer.', owner_set: false }); continue; }
      const ownerSet = !!(r.updated_by && !/^(ai-review|seed)/.test(r.updated_by));
      let amount = d.decision === 'collecting' ? (d.amount != null ? Math.round(d.amount * 100) / 100 : r.due) : null;
      if (amount != null && r.due != null && amount > r.due) amount = r.due;
      const reason = d.decision === 'received' ? `Received per the notes — post the payment in JobNimbus. ${d.reason}`.slice(0, 200) : d.reason.slice(0, 200);
      results.push({ job_number: r.number, name: r.name, decision: d.decision, amount: d.decision === 'collecting' ? amount : d.amount, reason, owner_set: ownerSet });
      // What the review found always lands in its own fields; it never touches the owner's note.
      const ai = { ai_decision: d.decision, ai_amount: d.decision === 'collecting' ? amount : (d.amount != null ? Math.round(d.amount * 100) / 100 : null), ai_reason: reason, ai_at: nowIso };
      if (ownerSet) { skippedOwner.push(r.number); aiOnly.push({ location_id: pool.location_id, key: r.key, ...ai }); continue; }
      writes.push({ location_id: pool.location_id, key: r.key, category: d.decision === 'collecting' ? 'collecting' : null, amount, updated_by: 'ai-review', updated_at: nowIso, ...ai });
    }
    await writeReview(writes, aiOnly);
    await sbWrite('POST', 'wip_reviews', {
      location_id: pool.location_id, model: REVIEW_MODEL, jobs_reviewed: jobs.length, applied: writes.length,
      result: { trigger: opts.trigger || 'manual', results, usage: response.usage },
    }, 'return=minimal');
    return { label: data.label, jobs_reviewed: jobs.length, applied: writes.length, skipped_owner: skippedOwner, jobs: results };
  }

  // ── Weekly automatic review ─────────────────────────────────────────────────
  // Every Saturday from WIP_AUTO_REVIEW_HOUR (default 6 = 6:00 AM Central, so
  // the owner forms already carry the Collecting decisions when owners open
  // them) run reviewLocation() once for every pooled location. A 10-minute
  // tick checks the clock; the wip_reviews row tagged trigger=weekly is the
  // memory, so a restart or a long tick never runs a location twice on the
  // same Saturday. A location that fails is retried on later ticks that day,
  // at most WEEKLY_MAX_ATTEMPTS times. WIP_AUTO_REVIEW=off disables it.
  const WEEKLY_DAY = 'Sat';
  const WEEKLY_TICK_MS = 10 * 60 * 1000;
  const WEEKLY_MAX_ATTEMPTS = 3;
  const weeklyHour = Math.min(23, Math.max(0, parseInt(process.env.WIP_AUTO_REVIEW_HOUR || '6', 10) || 0));
  const weeklyReview = {
    enabled: String(process.env.WIP_AUTO_REVIEW || 'on').toLowerCase() !== 'off',
    hour: weeklyHour,
    hourLabel: `${weeklyHour % 12 || 12}:00 ${weeklyHour < 12 ? 'AM' : 'PM'}`,
  };
  function chicagoNow(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(now);
    const get = t => (parts.find(p => p.type === t) || {}).value;
    return { date: now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }), weekday: get('weekday'), hour: parseInt(get('hour'), 10) % 24 };
  }
  let weeklyRunning = false;
  const weeklyAttempts = {}; // `${date}:${location_id}` → failed attempts today
  async function weeklyReviewTick(now = new Date()) {
    if (!weeklyReview.enabled || weeklyRunning) return { ran: [], skipped: 'off-or-running' };
    const t = chicagoNow(now);
    if (t.weekday !== WEEKLY_DAY || t.hour < weeklyReview.hour) return { ran: [], skipped: 'not-time' };
    if (!anthropic) {
      if (!weeklyAttempts[`${t.date}:warned`]) { weeklyAttempts[`${t.date}:warned`] = 1; console.error('[wip weekly] ANTHROPIC_API_KEY is not set — skipping the Saturday review'); }
      return { ran: [], skipped: 'no-key' };
    }
    weeklyRunning = true;
    const ran = [];
    try {
      for (const p of await loadPool()) {
        const key = `${t.date}:${p.location_id}`;
        if ((weeklyAttempts[key] || 0) >= WEEKLY_MAX_ATTEMPTS) continue;
        const last = (await sbGet(`wip_reviews?location_id=eq.${p.location_id}&result->>trigger=eq.weekly&select=reviewed_at&order=reviewed_at.desc&limit=1`))[0];
        if (last && new Date(last.reviewed_at).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }) === t.date) continue;
        try {
          const r = await reviewLocation(p, { trigger: 'weekly', now });
          ran.push({ location_id: p.location_id, label: r.label, jobs_reviewed: r.jobs_reviewed, applied: r.applied });
          console.log(`[wip weekly] ${r.label}: ${r.jobs_reviewed} AR jobs reviewed, ${r.applied} updated`);
          // Save the report as it stands so the dashboard has this week's
          // Collecting forecast on record even if nobody taps Share.
          try {
            const d = await loadLocation(p); const s = sectionText(d);
            await saveSnapshot(p.location_id, s.text + '\n', s.ipTotal, s.cTotal, null, 'Saturday review');
          } catch (err) { console.error(`[wip weekly] snapshot ${p.location_id}: ${err.message}`); }
        } catch (err) {
          weeklyAttempts[key] = (weeklyAttempts[key] || 0) + 1;
          console.error(`[wip weekly] ${p.label || p.location_id} failed (attempt ${weeklyAttempts[key]}): ${err.message}`);
        }
      }
    } catch (err) {
      console.error('[wip weekly]', err.message);
    } finally { weeklyRunning = false; }
    return { ran };
  }
  if (weeklyReview.enabled && !opts.noSchedule) {
    const timer = setInterval(() => weeklyReviewTick().catch(err => console.error('[wip weekly]', err.message)), WEEKLY_TICK_MS);
    if (timer.unref) timer.unref();
    console.log(`[wip weekly] AI review scheduled every Saturday from ${weeklyReview.hourLabel} Central`);
  }

  // Manual review: POST starts a run and returns its id at once; the page polls
  // GET /review/<id> for the progress bar. One run at a time per master link.
  const reviewRuns = new Map();
  const PHASE_FRAC = { loading: 0.1, notes: 0.3, deciding: 0.6, saving: 0.9 };
  function publicRun(run) {
    const { scope, timer, ...rest } = run;
    return rest;
  }
  function startReviewRun(targets, scope) {
    for (const r of reviewRuns.values()) if (!r.finished && r.scope === scope) return { busy: true, run: r };
    const run = {
      id: crypto.randomUUID(), scope, total: targets.length, done: 0, failed: 0, current: null, phase: null, phase_frac: 0, jobs: null,
      items: targets.map(t => ({ id: t.id, label: t.label || (t.locations && t.locations.name) || 'Location', state: 'wait' })),
      results: [], error: null, finished: false, started_at: new Date().toISOString(),
    };
    reviewRuns.set(run.id, run);
    (async () => {
      for (let i = 0; i < targets.length; i++) {
        const item = run.items[i];
        item.state = 'cur'; run.current = item.label; run.phase = 'loading'; run.phase_frac = 0; run.jobs = null;
        try {
          const r = await reviewLocation(targets[i], { onProgress: (phase, info) => { run.phase = phase; run.phase_frac = PHASE_FRAC[phase] || 0; if (info && info.jobs != null) run.jobs = info.jobs; } });
          run.results.push(r); item.state = 'done';
        } catch (err) {
          console.error('[wip review]', item.label, err.message);
          run.results.push({ label: item.label, error: err.message, jobs_reviewed: 0, applied: 0, skipped_owner: [], jobs: [] });
          item.state = 'fail'; run.failed++;
        }
        run.done++; run.phase = null; run.phase_frac = 0; run.jobs = null;
      }
      run.finished = true; run.current = null;
      run.timer = setTimeout(() => reviewRuns.delete(run.id), 10 * 60 * 1000);
      if (run.timer.unref) run.timer.unref();
    })();
    return { busy: false, run };
  }
  // Two upserts (PostgREST wants uniform keys per batch); before the migration
  // the ai_* columns do not exist, so fall back to the legacy shape.
  async function writeReview(writes, aiOnly) {
    try {
      if (writes.length) await sbWrite('POST', 'wip_entries?on_conflict=location_id,key', writes, 'resolution=merge-duplicates,return=minimal');
      if (aiOnly.length) await sbWrite('POST', 'wip_entries?on_conflict=location_id,key', aiOnly, 'resolution=merge-duplicates,return=minimal');
    } catch (err) {
      if (!/ai_decision|ai_amount|ai_reason|ai_at|42703/.test(err.message)) throw err;
      entryColsV2 = false;
      const legacy = writes.map(({ ai_decision, ai_amount, ai_reason, ai_at, ...w }) => w);
      if (legacy.length) await sbWrite('POST', 'wip_entries?on_conflict=location_id,key', legacy, 'resolution=merge-duplicates,return=minimal');
    }
  }
  app.post('/wip/master/:master/review', resolveMaster, async (req, res) => {
    try {
      const b = req.body || {};
      const pool = await poolsFor(req);
      const targets = b.all ? pool : pool.filter(p => p.id === String(b.pool_id || ''));
      if (!targets.length) return res.status(400).json({ error: 'pool_id required' });
      if (b.dry) { // synchronous dry run (no model, no writes) for checks
        const results = [];
        for (const p of targets) results.push(await reviewLocation(p, { dry: true }));
        return res.json({ results });
      }
      if (!anthropic) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set on the server' });
      const { busy, run } = startReviewRun(targets, req.params.master);
      if (busy) return res.status(409).json({ error: 'A review is already running on this page', run_id: run.id });
      res.json({ run_id: run.id, total: run.total });
    } catch (err) {
      console.error('[wip review]', err.message);
      res.status(err instanceof Anthropic.APIError ? 502 : 500).json({ error: err.message });
    }
  });
  app.get('/wip/master/:master/review/:run', resolveMaster, (req, res) => {
    const run = reviewRuns.get(String(req.params.run));
    if (!run || run.scope !== req.params.master) return res.status(404).json({ error: 'unknown run' });
    res.json(publicRun(run));
  });
  return { weeklyReviewTick, chicagoNow, weeklyReview, upcomingWeek, lastWeek, chicagoMidnightIso, loadDashboard, reviewRuns, when, reportLists, sectionText };
};
