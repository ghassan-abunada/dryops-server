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

// Absolute link base for the owner / master links the WIP pages show for
// copying. The dryops.app web front proxies /wip and /wip/* here and sends
// `x-dryops-public-base: https://dryops.app`, so copied links point at the
// public domain rather than the Railway hostname. The header is trusted only
// when it is a bare https origin (no path beyond '/', no query, hash or
// credentials) so a client cannot inject an arbitrary link base; anything else
// falls back to the request's own protocol + host.
function publicBase(req) {
  const raw = String((req.get && req.get('x-dryops-public-base')) || '').trim();
  if (raw && !/[?#@\s]/.test(raw)) {
    try {
      const u = new URL(raw);
      if (u.protocol === 'https:' && u.hostname && u.pathname === '/' && !u.search && !u.hash && !u.username && !u.password) {
        return u.origin;
      }
    } catch { /* malformed header: ignore */ }
  }
  return `${req.protocol}://${req.get('host')}`;
}

const DASH = require('./wipDash');
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

  async function loadLocation(pool) {
    const locId = pool.location_id;
    // Per-job balances come from the JobNimbus job rollup (approved invoices
    // only), the same columns DryOps' Stats / Collections read.
    const [jobs, entries, arRpc, logo] = await Promise.all([
      sbGet(`jobs?location_id=eq.${locId}&or=(stage.is.null,stage.not.in.(Completed,Lost))&name=not.ilike.*test%20dummy*`
        + `&select=id,jn_id,number,name,status,stage,record_type,jn_created,approved_invoice_total,approved_invoice_due&order=jn_created.asc`),
      sbGet(`wip_entries?location_id=eq.${locId}&select=key,custom_name,category,amount,note,updated_by,updated_at`),
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
      if (group === 'ar') { category = e && e.category === 'collecting' ? 'collecting' : null; if (category !== 'collecting') amount = null; }
      else if (group === 'in_progress') category = e ? (e.category === 'in_progress' ? 'in_progress' : null) : 'in_progress';
      else if (e && e.category === 'in_progress' && !invoiced) category = 'in_progress';
      else amount = null;
      return {
        key: j.id, name: cleanName(j.name) + typeTag(j.record_type), number: j.number, status: j.status, stage: j.stage,
        record_type: j.record_type, created: j.jn_created ? j.jn_created.slice(0, 10) : null,
        due: j.approved_invoice_due != null ? money2(j.approved_invoice_due) : null,
        inv_total: j.approved_invoice_total != null ? money2(j.approved_invoice_total) : null,
        group, category, amount,
        note: (e && e.note) || '', custom: false, jn_id: j.jn_id,
        updated_by: (e && e.updated_by) || null,
      };
    });
    for (const e of entries) {
      if (!e.key.startsWith('custom:')) continue;
      rows.push({ key: e.key, name: e.custom_name || '(unnamed)', number: null, status: 'Added by owner', stage: null,
        record_type: null, created: e.updated_at ? e.updated_at.slice(0, 10) : null, due: null, inv_total: null,
        group: 'custom', category: e.category, amount: e.amount != null ? Number(e.amount) : null, note: e.note || '', custom: true });
    }
    const lastUpdate = entries.reduce((m, e) => (e.updated_at > m ? e.updated_at : m), '');
    const lastBy = entries.filter(e => e.updated_at === lastUpdate).map(e => e.updated_by).find(Boolean) || '';
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

  function reportLists(data) {
    const inProg = data.rows.filter(r => r.category === 'in_progress');
    const coll = data.rows.filter(r => r.category === 'collecting')
      .map(r => ({ ...r, amount: r.amount != null ? r.amount : r.due }))
      .sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0));
    const ipTotal = inProg.reduce((s, r) => s + Number(r.amount || 0), 0);
    const cTotal = coll.reduce((s, r) => s + Number(r.amount || 0), 0);
    return { inProg, coll, ipTotal, cTotal };
  }
  function sectionText(data) {
    const { inProg, coll, ipTotal, cTotal } = reportLists(data);
    const lines = [data.label.toUpperCase(), '', `In Progress — ${whole(ipTotal)}`];
    inProg.forEach((r, i) => lines.push(`${i + 1}. ${r.name} —${r.amount != null ? ' ' + money(r.amount, true) : ''}${r.note ? ' (' + r.note + ')' : ''}`));
    if (!inProg.length) lines.push('(none)');
    lines.push('', `Collecting — ${whole(cTotal)}`);
    coll.forEach((r, i) => lines.push(`${i + 1}. ${r.name} — ${money(r.amount)}${r.note ? ' (' + r.note + ')' : ''}`));
    if (!coll.length) lines.push('(none)');
    lines.push('', `Total AR — ${whole(data.arTotal)}`, bankLine(data.bank));
    return { text: lines.join('\n'), ipTotal, cTotal, arTotal: data.arTotal, bank: data.bank };
  }
  function today() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); }
  function reportHeader(title) { return [`WIP REPORT — ${title} — ${today()}`, '='.repeat(40), ''].join('\n'); }

  async function saveSnapshot(locationId, body, ip, c, managerId) {
    const row = { location_id: locationId, body, in_progress_total: ip, collecting_total: c };
    if (managerId) {
      try { return await sbWrite('POST', 'wip_snapshots', { ...row, manager_id: managerId }, 'return=minimal'); }
      catch (err) { if (!/manager_id/.test(err.message)) throw err; } // column not migrated yet
    }
    await sbWrite('POST', 'wip_snapshots', row, 'return=minimal');
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
  :root{--bg:#f3f5f2;--card:#fff;--ink:#1c2321;--mut:#5f6b66;--line:#dde3dd;--acc:#1b6e5a;--acc2:#0f4c3a;--danger:#b3261e;--ip:#2457a3;--col:#1b6e5a;--top:56px}
  *{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
  body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.4 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-tap-highlight-color:transparent;overscroll-behavior-y:none}
  .top{position:sticky;top:0;z-index:5;background:rgba(243,245,242,.92);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-bottom:1px solid var(--line);padding:calc(10px + env(safe-area-inset-top)) 16px 10px;display:flex;align-items:center;gap:10px;min-height:var(--top)}
  .top h1{font-size:18px;margin:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .wrap{max-width:720px;margin:0 auto;padding:14px 16px calc(92px + env(safe-area-inset-bottom))}
  h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);margin:0}
  .sub{color:var(--mut);font-size:13px}.meta{color:var(--mut);font-size:12.5px}.nm{font-weight:600;font-size:16px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:10px}
  .tot{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:0 0 14px}
  .tot .card{margin:0;padding:12px 14px}.tot b{font-size:22px;display:block;font-variant-numeric:tabular-nums}.tot span{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
  details.sec{margin:16px 0 0}details.sec>summary{list-style:none;display:flex;align-items:center;gap:8px;padding:10px 2px;cursor:pointer;user-select:none}
  details.sec>summary::-webkit-details-marker{display:none}details.sec>summary::after{content:"›";margin-left:auto;color:var(--mut);font-size:20px;transform:rotate(90deg);transition:transform .15s}
  details.sec[open]>summary::after{transform:rotate(-90deg)}.count{background:#e6ebe6;color:var(--mut);border-radius:999px;padding:1px 8px;font-size:12px}
  .job{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin-bottom:10px}
  .job.is-ip{border-left:4px solid var(--ip)}.job.is-col{border-left:4px solid var(--col)}
  .job-head{margin-bottom:10px}.job-head .meta{margin-top:2px}
  input[type=text],input[type=number],select,textarea{font:inherit;font-size:16px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:#fff;min-width:0;width:100%}
  input.nm{font-weight:600}
  .seg{display:flex;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:#fff}
  .seg button{flex:1;font:inherit;font-size:14px;font-weight:600;min-height:44px;padding:0 6px;border:0;background:#fff;color:var(--mut);cursor:pointer;white-space:nowrap}
  .seg button+button{border-left:1px solid var(--line)}.seg button.on-ip{background:var(--ip);color:#fff}.seg button.on-col{background:var(--col);color:#fff}.seg button.on-off{background:#e9ecea;color:var(--ink)}
  .amt-row{display:flex;align-items:center;gap:8px;margin-top:10px}.amt-row .pre{color:var(--mut);font-weight:600}
  input.amt{text-align:right;font-variant-numeric:tabular-nums;font-weight:600}input.nt{margin-top:8px;font-size:14px;padding:8px 12px}
  .btn{font:inherit;font-size:15px;font-weight:600;min-height:44px;padding:0 16px;border-radius:12px;border:1px solid var(--acc);background:var(--acc);color:#fff;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap}
  .btn.ghost{background:#fff;color:var(--acc)}.btn.small{min-height:38px;padding:0 12px;font-size:14px}.btn.danger{border-color:var(--danger);color:var(--danger);background:#fff}.btn.icon{padding:0 12px}
  .btn:disabled{opacity:.6}
  .actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
  .bar{position:fixed;left:0;right:0;bottom:0;z-index:6;background:rgba(255,255,255,.96);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-top:1px solid var(--line);padding:10px 16px calc(10px + env(safe-area-inset-bottom));display:flex;gap:8px;align-items:center}
  .bar .status{flex:1;font-size:13px;color:var(--mut);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.status.ok{color:var(--acc)}.status.err{color:var(--danger)}
  pre{background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px;white-space:pre-wrap;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;margin:8px 0 0}
  .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .sheet{position:fixed;inset:0;z-index:20;background:rgba(0,0,0,.35);display:none;align-items:flex-end;justify-content:center}.sheet.open{display:flex}
  .sheet>div{background:#fff;border-radius:18px 18px 0 0;padding:16px 16px calc(16px + env(safe-area-inset-bottom));width:100%;max-width:720px;max-height:85vh;overflow:auto}
  .sheet textarea{height:180px;font:13px/1.45 ui-monospace,Menlo,Consolas,monospace;margin:10px 0}
  .list{border-top:1px solid var(--line)}.list>div{padding:10px 0;border-bottom:1px solid var(--line)}
  .steps ol{margin:8px 0 10px;padding-left:22px}.steps li{margin:6px 0;line-height:1.4}
  .lbl{display:block;font-size:13px;font-weight:600;color:var(--mut);margin:14px 0 6px;text-transform:uppercase;letter-spacing:.05em}
  .q{font:inherit;font-size:12px;font-weight:700;line-height:1;width:20px;height:20px;padding:0;border-radius:50%;border:1px solid var(--line);background:#fff;color:var(--mut);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;margin-left:6px;flex:none;text-transform:none;letter-spacing:0}
  .q.on{background:var(--acc);border-color:var(--acc);color:#fff}
  .help{display:none;color:var(--mut);font-size:13px;line-height:1.4;margin:6px 0 0}.help.on{display:block}
  details.sec .help{margin:-2px 2px 10px}
  .job.need{border-color:#e0b04a;background:#fffbf0}.need-txt{color:#9a6210;font-weight:600}
  @media(min-width:600px){.actions{grid-template-columns:repeat(4,1fr)}}
  ` + DASH.CSS;
  const ICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1b6e5a"/><text x="32" y="41" font-family="-apple-system,Helvetica,Arial" font-weight="700" font-size="22" text-anchor="middle" fill="#fff">WIP</text></svg>');
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
document.getElementById('sheet-copy').onclick=async()=>{try{await navigator.clipboard.writeText(text);document.getElementById('sheet-copy').textContent='Copied ✓'}catch(e){document.getElementById('sheet-text').select()}};
s.classList.add('open')}
document.addEventListener('click',e=>{const b=e.target.closest('[data-share]');if(b){e.preventDefault();shareText(b.dataset.share,b.dataset.shareTitle||'WIP')}if(e.target.id==='sheet')closeSheet()});
document.addEventListener('click',e=>{const q=e.target.closest('.q[data-help]');if(!q)return;e.preventDefault();e.stopPropagation();const h=document.getElementById('help-'+q.dataset.help);const on=!(h&&h.classList.contains('on'));if(h)h.classList.toggle('on',on);q.classList.toggle('on',on);q.setAttribute('aria-expanded',on)});
</script>${script ? `<script>${script}</script>` : ''}</body></html>`;
  }

  // ── Owner page ──────────────────────────────────────────────────────────────
  app.get('/wip/:token', async (req, res, next) => {
    if (req.params.token === 'master') return next();
    try {
      const pool = await poolByToken(req.params.token);
      if (!pool) return res.status(404).send(page('Not found', '<p>This WIP link is not valid. Ask for a fresh link.</p>'));
      const data = await loadLocation(pool);
      const textUrl = `/wip/${esc(pool.token)}/text`;
      const topbar = `<div class="top">${data.logo ? `<img class="logo" src="${esc(data.logo)}" alt="">` : ''}<h1>${esc(data.label)}${data.logo ? '' : ' · WIP'}</h1><button class="btn small" data-share="${textUrl}" data-share-title="${esc(data.label)} WIP">Share</button></div>`;
      const body = `
<div class="card steps"><b>About 5 minutes${q('steps')}</b>
${help('steps', 'Everything saves by itself as you type. Tap the ? next to any heading if you are not sure what it means. When you are finished, tap "Done — send it" at the bottom.')}
<ol>
<li>Type your <b>name</b>.</li>
<li><b>In Progress:</b> what each job is worth.</li>
<li><b>Collecting:</b> what you expect to get paid this week.</li>
<li><b>Bank Balance:</b> today's balance.</li>
</ol></div>
<label class="lbl" for="who">Your name</label>
<input type="text" id="who" placeholder="Type your name" autocomplete="name">
<div class="tot" style="margin-top:14px"><div class="card"><span>In Progress</span>${q('ip')}<b id="t-ip">$0</b><div class="meta" id="n-ip"></div>${help('ip', 'Jobs we are working on right now. Type what each one is worth — a rough guess is fine.')}</div>
<div class="card"><span>Collecting</span>${q('col')}<b id="t-col">$0</b><div class="meta" id="n-col"></div>${help('col', 'Invoices that are sent and unpaid. Type how much you expect to actually get paid this week.')}</div>
<div class="card"><span>AR</span>${q('ar')}<b>${whole(data.arTotal)}</b>${help('ar', 'Everything customers and carriers still owe us on invoiced jobs. Comes from JobNimbus — the same number as the DryOps dashboard.')}</div>
<div class="card"><span>Bank Balance</span>${q('bank')}<div class="amt-row" style="margin-top:4px"><span class="pre">$</span><input type="number" inputmode="decimal" step="0.01" class="amt" id="bank" value="${data.bank ? esc(data.bank.balance) : ''}" placeholder="type it here"></div>
<div class="meta" id="bank-meta">${data.bank && data.bank.at ? `entered ${esc(new Date(data.bank.at).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: 'America/Chicago' }))}${data.bank.by ? ' by ' + esc(data.bank.by) : ''}` : '<span class="need-txt">please type today\'s balance</span>'}</div>${help('bank', "Today's balance in the bank account. Type it in — it is not pulled from anywhere.")}</div></div>
<div id="sections"></div>
<div class="bar"><div class="status" id="status">Loaded</div><a class="btn ghost small" href="/wip/${esc(pool.token)}/pdf" target="_blank">PDF</a><button class="btn ghost small" id="add-btn">+ Add a job</button><button class="btn" data-share="${textUrl}" data-share-title="${esc(data.label)} WIP">Done — send it</button></div>
<div class="sheet" id="add-sheet"><div><b>Add a job that isn't on the list</b><div class="sub" style="margin-top:6px">Only for jobs that aren't in JobNimbus yet.</div><div class="actions" style="margin-top:12px"><button class="btn" onclick="addCustom('in_progress')">In Progress</button><button class="btn ghost" onclick="addCustom('collecting')">Collecting</button></div></div></div>`;
      const script = `
const TOKEN=${json(pool.token)};let ROWS=${json(data.rows)};
const GROUPS=[
['in_progress','In Progress',true,'Jobs we are working on. Type what each one is worth — a rough guess is fine. Not working on it? Tap "hide it".'],
['ar','Collecting',true,'Invoices that are sent and unpaid. Type how much you expect to actually get paid THIS WEEK. Leave blank if nothing yet.'],
['billing','Not invoiced yet',false,'Finished jobs that have not been sent to insurance. You can usually skip these — type a value only if you want one counted as In Progress.'],
['other','On hold',false,'Leads and jobs on hold. You can usually skip these.'],
['custom','Added by you',true,'Jobs that are not in JobNimbus yet. Type the name and what it is worth.'],
['hidden','Hidden',false,'Not counted. Tap "count it" to put a job back.']];
// Where a card is shown: in-progress jobs the owner hid go to "Hidden".
function viewGroup(r){return r.group==='in_progress'&&!r.category?'hidden':r.group}
// Bucket follows the section: invoiced jobs count as Collecting only when an
// amount is entered; other non-production jobs count as In Progress when valued.
function deriveCategory(r){if(r.group==='ar')return r.amount!=null?'collecting':null;if(r.group==='billing'||r.group==='other')return r.amount!=null?'in_progress':null;return r.category}
for(const r of ROWS){if(r.group==='ar'&&r.category==='collecting'&&r.amount==null&&r.due!=null)r.amount=r.due}
const who=document.getElementById('who');try{who.value=localStorage.getItem('wip_who')||''}catch(e){}
who.addEventListener('change',()=>{try{localStorage.setItem('wip_who',who.value)}catch(e){}});
const OPEN={};try{Object.assign(OPEN,JSON.parse(localStorage.getItem('wip_open')||'{}'))}catch(e){}
function fmt(n){return '$'+Math.round(n||0).toLocaleString('en-US')}
function amtOf(r){if(r.category==='collecting')return r.amount!=null?r.amount:(r.due||0);return r.amount||0}
function totals(){let ip=0,c=0,ni=0,nc=0,need=0;for(const r of ROWS){if(r.category==='in_progress'){ip+=Number(r.amount||0);ni++;if(r.amount==null)need++}if(r.category==='collecting'){c+=Number(amtOf(r));nc++}}
document.getElementById('t-ip').textContent=fmt(ip);document.getElementById('t-col').textContent=fmt(c);
document.getElementById('n-ip').innerHTML=ni+' job'+(ni===1?'':'s')+(need?' · <span class="need-txt">'+need+' still need a number</span>':ni?' · all have numbers ✓':'');
document.getElementById('n-col').textContent=nc?nc+' invoice'+(nc===1?'':'s'):'nothing entered yet'}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function cardClass(r){return 'job '+(r.category==='in_progress'?'is-ip':r.category==='collecting'?'is-col':'')}
function cardNeeds(r){return viewGroup(r)==='in_progress'&&r.category==='in_progress'&&r.amount==null}
function jobCard(r){const vg=viewGroup(r);const ph=vg==='ar'?'How much this week?':vg==='billing'||vg==='other'?'Leave blank, or type a value':vg==='custom'&&r.category==='collecting'?'How much this week?':'What is this job worth?';
const link=vg==='in_progress'&&!r.custom?' · <a href="#" data-hide="'+esc(r.key)+'">not working on this? hide it</a>':vg==='hidden'?' · <a href="#" data-restore="'+esc(r.key)+'">count it</a>':r.custom?' · <a href="#" data-del="'+esc(r.key)+'">remove</a>':'';
return '<div class="'+cardClass(r)+(cardNeeds(r)?' need':'')+'" data-card="'+esc(r.key)+'"><div class="job-head">'+(r.custom?'<input type="text" class="nm" value="'+esc(r.name)+'" data-k="'+esc(r.key)+'" data-f="custom_name" placeholder="Customer name">':'<div class="nm">'+esc(r.name)+'</div>')
+'<div class="meta">'+(r.number?'#'+esc(r.number)+' · ':'')+esc(r.status)+(r.record_type&&r.record_type!=='Mitigation'?' · '+esc(r.record_type):'')+(r.created?' · started '+esc(r.created):'')+(r.due!=null?' · <b>they owe '+fmt(r.due)+'</b>':'')+link+'</div></div>'
+(vg==='hidden'?'':'<div class="amt-row"><span class="pre">$</span><input type="number" inputmode="decimal" step="0.01" class="amt" data-k="'+esc(r.key)+'" data-f="amount" value="'+(r.amount!=null?r.amount:'')+'" placeholder="'+esc(ph)+'"></div>'
+(r.note?'<input type="text" class="nt" data-k="'+esc(r.key)+'" data-f="note" value="'+esc(r.note)+'" placeholder="Note">':'<a href="#" class="meta" data-note="'+esc(r.key)+'" style="display:inline-block;margin-top:8px">+ add a note</a>'))+'</div>'}
function render(){const host=document.getElementById('sections');host.innerHTML='';
for(const [g,title,dflt,hint] of GROUPS){const rows=ROWS.filter(r=>viewGroup(r)===g);if(!rows.length)continue;
const open=OPEN[g]!==undefined?OPEN[g]:dflt;
const sec=document.createElement('details');sec.className='sec';sec.open=open;sec.dataset.g=g;
sec.innerHTML='<summary><h2>'+esc(title)+'</h2><button type="button" class="q" data-help="sec-'+g+'" aria-label="What is this?" aria-expanded="false">?</button><span class="count">'+rows.length+'</span></summary><div class="help" id="help-sec-'+g+'">'+esc(hint)+'</div>'+rows.map(jobCard).join('');
sec.addEventListener('toggle',()=>{OPEN[g]=sec.open;try{localStorage.setItem('wip_open',JSON.stringify(OPEN))}catch(e){}});
host.appendChild(sec)}totals()}
const bankEl=document.getElementById('bank');let bankTimer=null;
bankEl.addEventListener('input',()=>{clearTimeout(bankTimer);st.textContent='Saving…';st.className='status';bankTimer=setTimeout(async()=>{try{const r=await fetch('/wip/'+TOKEN+'/bank',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({balance:bankEl.value===''?null:Number(bankEl.value),updated_by:who.value||null})});if(!r.ok)throw new Error(await r.text());
document.getElementById('bank-meta').textContent=bankEl.value===''?'not entered yet':'as of today'+(who.value?' · '+who.value:'');st.textContent='Saved ✓ '+new Date().toLocaleTimeString();st.className='status ok'}catch(e){st.textContent='Save failed — '+e.message;st.className='status err'}},700)});
document.getElementById('add-btn').onclick=()=>document.getElementById('add-sheet').classList.add('open');
document.getElementById('add-sheet').addEventListener('click',e=>{if(e.target.id==='add-sheet')e.target.classList.remove('open')});
const dirty=new Map();let timer=null;const st=document.getElementById('status');
function queue(key){const r=ROWS.find(x=>x.key===key);dirty.set(key,{key,category:r.category,amount:r.amount,note:r.note,custom_name:r.custom?r.name:undefined});st.textContent='Saving…';st.className='status';clearTimeout(timer);timer=setTimeout(flush,700)}
async function flush(){const entries=[...dirty.values()];dirty.clear();if(!entries.length)return;
try{const r=await fetch('/wip/'+TOKEN+'/entries',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({entries,updated_by:who.value||null})});if(!r.ok)throw new Error(await r.text());st.textContent='Saved ✓ '+new Date().toLocaleTimeString();st.className='status ok'}catch(e){st.textContent='Save failed — '+e.message;st.className='status err';entries.forEach(x=>dirty.set(x.key,x))}}
document.addEventListener('click',e=>{const n=e.target.closest('a[data-note]');if(n){e.preventDefault();const inp=document.createElement('input');inp.type='text';inp.className='nt';inp.dataset.k=n.dataset.note;inp.dataset.f='note';inp.placeholder='Note';n.replaceWith(inp);inp.focus();return}
const h=e.target.closest('a[data-hide],a[data-restore]');if(h){e.preventDefault();const key=h.dataset.hide||h.dataset.restore;const r=ROWS.find(x=>x.key===key);r.category=h.dataset.hide?null:'in_progress';if(h.dataset.hide)OPEN.hidden=true;render();queue(r.key);return}
const d=e.target.closest('a[data-del]');if(d){e.preventDefault();if(!confirm('Remove this line?'))return;fetch('/wip/'+TOKEN+'/entries/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:d.dataset.del})}).then(()=>{ROWS=ROWS.filter(x=>x.key!==d.dataset.del);render()})}});
document.addEventListener('input',e=>{const i=e.target;if(!i.dataset||!i.dataset.f)return;const r=ROWS.find(x=>x.key===i.dataset.k);if(!r)return;
if(i.dataset.f==='amount'){r.amount=i.value===''?null:Number(i.value);r.category=deriveCategory(r);const card=i.closest('[data-card]');if(card)card.className=cardClass(r)+(cardNeeds(r)?' need':'');totals()}else if(i.dataset.f==='note'){r.note=i.value}else if(i.dataset.f==='custom_name'){r.name=i.value}queue(r.key)});
function addCustom(cat){document.getElementById('add-sheet').classList.remove('open');const key='custom:'+crypto.randomUUID();ROWS.push({key,name:'',number:null,status:'Added by you',created:null,due:null,group:'custom',category:cat,amount:null,note:'',custom:true});OPEN.custom=true;render();queue(key);
const el=document.querySelector('input[data-k="'+key+'"][data-f="custom_name"]');if(el){el.scrollIntoView({block:'center'});el.focus()}}
window.addEventListener('beforeunload',()=>{if(dirty.size)flush()});render();`;
      res.send(page(`${data.label} WIP`, body, script, topbar, { icon: data.logo || null }));
    } catch (err) { console.error('[wip owner]', err.message); res.status(502).send(page('Error', `<p>${esc(err.message)}</p>`)); }
  });

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
        note: e.note ? String(e.note).slice(0, 300) : null,
        custom_name: e.custom_name !== undefined ? String(e.custom_name || '').slice(0, 120) : undefined,
        updated_by: b.updated_by ? String(b.updated_by).slice(0, 80) : null,
        updated_at: new Date().toISOString(),
      })).filter(r => r.key && (r.key.startsWith('custom:') || /^[0-9a-f-]{36}$/.test(r.key)));
      for (const r of rows) if (r.custom_name === undefined) delete r.custom_name;
      if (rows.length) await sbWrite('POST', 'wip_entries?on_conflict=location_id,key', rows, 'resolution=merge-duplicates,return=minimal');
      const recorded = await recordEstimates(pool.location_id, rows);
      res.json({ ok: true, saved: rows.length, estimates: recorded });
    } catch (err) { console.error('[wip save]', err.message); res.status(502).json({ error: err.message }); }
  });
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
      const text = reportHeader(data.label.toUpperCase()) + s.text + '\n';
      await saveSnapshot(pool.location_id, text, s.ipTotal, s.cTotal);
      res.type('text/plain; charset=utf-8').send(text);
    } catch (err) { res.status(502).type('text/plain').send(err.message); }
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
  async function loadDashboard(pools, now = new Date()) {
    const week = upcomingWeek(now), lw = lastWeek(now);
    const ids = pools.map(p => p.location_id), idList = ids.join(',');
    const startIso = chicagoMidnightIso(lw.start), endIso = chicagoMidnightIso(lw.endExclusive);
    // Forecast = the last report saved in the 7 days before last Monday (Monday itself allowed).
    const fcFrom = new Date(new Date(startIso).getTime() - 7 * 86400000).toISOString(), fcTo = new Date(new Date(startIso).getTime() + 86400000).toISOString();
    const poolsById = Object.fromEntries(pools.map(p => [p.location_id, { ...p, label: p.label || (p.locations && p.locations.name) || 'Location' }]));
    const [datas, pays, invs, snaps, reviews, accuracy] = await Promise.all([
      Promise.all(pools.map(p => loadLocation(p))),
      ids.length ? sbGetAll(`payments?location_id=in.(${idList})&jn_created=gte.${startIso}&jn_created=lt.${endIso}&or=(method_id.is.null,method_id.neq.-1)&select=location_id,amount`) : [],
      ids.length ? sbGetAll(`invoices?location_id=in.(${idList})&jn_created=gte.${startIso}&jn_created=lt.${endIso}&select=location_id,total`) : [],
      ids.length ? sbGet(`wip_snapshots?location_id=in.(${idList})&generated_at=gte.${fcFrom}&generated_at=lt.${fcTo}&select=location_id,collecting_total,generated_at&order=generated_at.desc`) : [],
      ids.length ? sbGet(`wip_reviews?location_id=in.(${idList})&select=location_id,reviewed_at,jobs_reviewed,applied,result->>trigger&order=reviewed_at.desc&limit=500`) : [],
      loadAccuracy(ids, poolsById),
    ]);
    const collected = sumBy(pays, 'location_id', 'amount'), invoiced = sumBy(invs, 'location_id', 'total');
    const forecast = {}; for (const sn of snaps) if (!(sn.location_id in forecast)) forecast[sn.location_id] = sn.collecting_total != null ? Number(sn.collecting_total) : null;
    const lastReview = {}; for (const r of reviews) if (!(r.location_id in lastReview)) lastReview[r.location_id] = r;
    const locations = datas.map(data => {
      const p = data.pool, s = sectionText(data), lists = reportLists(data);
      const counted = data.rows.filter(r => r.group === 'in_progress' && !r.custom && r.category === 'in_progress');
      const wc = counted.filter(r => r.status === 'Work Complete');
      return {
        id: p.id, token: p.token, location_id: p.location_id, label: data.label, name: data.name, logo: data.logo, data, lists,
        ipTotal: money2(lists.ipTotal), cTotal: money2(lists.cTotal), arTotal: data.arTotal, bank: data.bank,
        collected: money2(collected[p.location_id] || 0), invoiced: money2(invoiced[p.location_id] || 0),
        forecast: p.location_id in forecast ? forecast[p.location_id] : null,
        ipCount: counted.length, wcCount: wc.length,
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
  const ctx = { esc, json, q, help, whole, money };
  const originOf = publicBase;
  function titleFor(req) { return req.wip.manager ? req.wip.manager.name : 'all locations'; }

  app.get('/wip/master/:master', resolveMaster, async (req, res) => {
    try {
      const pools = await poolsFor(req);
      const dash = await loadDashboard(pools);
      const options = req.wip.scope === 'all'
        ? (await sbGetAll('locations?select=id,name&order=name.asc')).filter(l => !pools.some(p => p.location_id === l.id)) : [];
      if (req.wip.manager) sbWrite('PATCH', `wip_managers?id=eq.${req.wip.manager.id}`, { last_opened_at: new Date().toISOString() }, 'return=minimal').catch(() => {});
      const { body, script, topbar } = DASH.renderMaster(ctx, {
        token: req.params.master, scope: req.wip.scope, manager: req.wip.manager, title: titleFor(req), origin: originOf(req), today: today(),
        week: dash.week, lastWeek: dash.lastWeek, locations: dash.locations, totals: dash.totals, accuracy: dash.accuracy,
        options, weeklyReview, anthropic: !!anthropic,
      });
      res.send(page(`WIP · ${titleFor(req)}`, body, script, topbar, { wide: true }));
    } catch (err) { console.error('[wip master]', err.message); res.status(502).send(page('Error', `<p>${esc(err.message)}</p>`)); }
  });

  app.get('/wip/master/:master/text', resolveMaster, async (req, res) => {
    try {
      const pool = await poolsFor(req);
      const parts = []; let ip = 0, c = 0, ar = 0, bank = 0, bankMissing = 0;
      for (const p of pool) {
        const data = await loadLocation(p);
        const s = sectionText(data);
        ip += s.ipTotal; c += s.cTotal; ar += data.arTotal; parts.push(s.text);
        if (data.bank) bank += data.bank.balance; else bankMissing++;
      }
      const text = reportHeader(titleFor(req).toUpperCase()) + parts.join('\n\n\n') + '\n\n\n' + '='.repeat(40)
        + `\nIN PROGRESS — TOTAL: ${whole(ip)}\nCOLLECTING — TOTAL: ${whole(c)}\nTOTAL AR: ${whole(ar)}\nBANK BALANCES: ${whole(bank)}${bankMissing ? ` (${bankMissing} not entered)` : ''}\n`;
      await saveSnapshot(null, text, ip, c, req.wip.manager ? req.wip.manager.id : null);
      res.type('text/plain; charset=utf-8').send(text);
    } catch (err) { res.status(502).type('text/plain').send(err.message); }
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
      console.error('[wip admin]', err.message);
      res.status(isMissingTable(err) ? 404 : 502).send(page('Error', isMissingTable(err) ? '<p>Run <b>supabase_wip_dashboard.sql</b> in Supabase first — the manager tables are missing.</p>' : `<p>${esc(err.message)}</p>`));
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
    const writes = []; const results = []; const skippedOwner = [];
    for (const r of ar) {
      const d = decided[r.number] || { decision: 'not_yet', amount: null, reason: 'no decision returned' };
      const ownerSet = !!(r.updated_by && !/^(ai-review|seed)/.test(r.updated_by));
      let amount = d.decision === 'collecting' ? (d.amount != null ? Math.round(d.amount * 100) / 100 : r.due) : null;
      if (amount != null && r.due != null && amount > r.due) amount = r.due;
      results.push({ job_number: r.number, name: r.name, decision: d.decision, amount: d.decision === 'collecting' ? amount : d.amount, reason: d.reason.slice(0, 160), owner_set: ownerSet });
      if (ownerSet) { skippedOwner.push(r.number); continue; }
      writes.push({
        location_id: pool.location_id, key: r.key,
        category: d.decision === 'collecting' ? 'collecting' : null,
        amount,
        note: d.decision === 'received' ? `received per notes — post the payment in JobNimbus (${d.reason.slice(0, 90)})` : d.reason.slice(0, 140),
        updated_by: 'ai-review', updated_at: new Date().toISOString(),
      });
    }
    if (writes.length) await sbWrite('POST', 'wip_entries?on_conflict=location_id,key', writes, 'resolution=merge-duplicates,return=minimal');
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
            await saveSnapshot(p.location_id, reportHeader(d.label.toUpperCase()) + s.text + '\n', s.ipTotal, s.cTotal);
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
  return { weeklyReviewTick, chicagoNow, weeklyReview, upcomingWeek, lastWeek, chicagoMidnightIso, loadDashboard, reviewRuns };
};
module.exports.publicBase = publicBase;
