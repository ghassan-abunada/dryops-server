// ── WIP report pages ──────────────────────────────────────────────────────────
// Owner link  : GET /wip/<token>            — per-location form (no login)
// Master link : GET /wip/master/<master>    — every pooled location, add/remove,
//                                             generate the combined report
// Tokens are the credential (see supabase_wip_pages.sql). Everything here talks
// to Supabase with the service key; the tables have RLS with no policies.

const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const { z } = require('zod');

// Locations carry every record type they run (mitigation, contents, abatement,
// rebuild, testing) — nothing is filtered by record type. Grouping is by status:
// production-stage work that isn't finished counts as "in progress" by default.
const AR_STATUSES = new Set(['Invoiced', 'Pending Payment', 'Pending Payments', 'Payment Plan', 'Attorney', 'Public Adjuster']);
// Work Complete stays "in progress" (still WIP until invoiced); these are the
// post-work statuses that are excluded by default.
const BILLING_STATUSES = new Set(['Invoice Created', 'In storage', 'PB complete', 'PO Complete', 'Revision Requested']);
const HOLD_STATUSES = new Set(['Pending Results', 'Pending Abatement', 'Customer Requested Hold']);
const TYPE_TAG = { Contents: 'Contents', Rebuild: 'Rebuild', Abatements: 'Abatement', Testing: 'Testing', Roofing: 'Roofing', Commercial: 'Commercial' };
function typeTag(recordType) {
  if (!recordType || recordType === 'Mitigation') return '';
  return ' (' + (TYPE_TAG[recordType] || recordType) + ')';
}

// deps: jnGet(pathAndQuery) → parsed JobNimbus JSON; anthropic → an SDK client
// (or null when the review feature is unconfigured). Credentials stay in server.js.
module.exports = function mountWip(app, { SUPABASE_URL, SUPABASE_SERVICE_KEY, jnGet, anthropic }) {
  const sbHeaders = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` };

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

  // ── Token lookups ───────────────────────────────────────────────────────────
  let masterCache = { token: null, at: 0 };
  async function masterToken() {
    if (Date.now() - masterCache.at < 60000 && masterCache.token) return masterCache.token;
    const rows = await sbGet('wip_config?id=eq.1&select=master_token');
    masterCache = { token: rows[0] && rows[0].master_token, at: Date.now() };
    return masterCache.token;
  }
  function tokenOk(given, expected) {
    if (!given || !expected || given.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  }
  async function requireMaster(req, res, next) {
    try {
      if (!tokenOk(String(req.params.master || ''), await masterToken())) return res.status(404).send(page('Not found', '<p>This link is not valid.</p>'));
      next();
    } catch (err) { res.status(502).send(page('Error', `<p>${esc(err.message)}</p>`)); }
  }
  async function poolByToken(token) {
    if (!token || token.length < 16) return null;
    const rows = await sbGet(`wip_pool?token=eq.${encodeURIComponent(token)}&select=id,location_id,token,label,sort_order,bank_balance,bank_balance_at,bank_balance_by,locations(name)&limit=1`);
    return rows[0] || null;
  }

  // ── Data ────────────────────────────────────────────────────────────────────
  function cleanName(n) {
    // "Jane Doe (A1 - DAL - MIT)" → "Jane Doe"; the trailing code bracket is
    // the JN naming convention, not part of the customer's name.
    return String(n || '').replace(/\s*\([^()]*\b(MIT|CON|REB|TST|ABT|PO|PB)\b[^()]*\)\s*$/i, '').trim();
  }

  async function loadLocation(pool) {
    const locId = pool.location_id;
    const jobs = await sbGet(`jobs?location_id=eq.${locId}&or=(stage.is.null,stage.not.in.(Completed,Lost))&name=not.ilike.*test%20dummy*`
      + `&select=id,jn_id,number,name,status,stage,record_type,jn_created&order=jn_created.asc`);
    const due = {}; const invTotal = {};
    for (let i = 0; i < jobs.length; i += 80) {
      const ids = jobs.slice(i, i + 80).map(j => j.id).join(',');
      const inv = await sbGet(`invoices?job_id=in.(${ids})&or=(status_name.is.null,status_name.neq.Void)&select=job_id,total,due`);
      for (const r of inv) {
        due[r.job_id] = (due[r.job_id] || 0) + Number(r.due || 0);
        invTotal[r.job_id] = (invTotal[r.job_id] || 0) + Number(r.total || 0);
      }
    }
    const entries = await sbGet(`wip_entries?location_id=eq.${locId}&select=key,custom_name,category,amount,note,updated_by,updated_at`);
    const byKey = Object.fromEntries(entries.map(e => [e.key, e]));

    const rows = jobs.map(j => {
      const e = byKey[j.id];
      const group = AR_STATUSES.has(j.status) ? 'ar'
        : BILLING_STATUSES.has(j.status) ? 'billing'
        : HOLD_STATUSES.has(j.status) ? 'other'
        : (j.status === 'In Progress' || j.stage === 'In Production') ? 'in_progress' : 'other';
      // No saved entry yet: In Progress jobs count by default, nothing else does.
      const category = e ? e.category : (group === 'in_progress' ? 'in_progress' : null);
      return {
        key: j.id, name: cleanName(j.name) + typeTag(j.record_type), number: j.number, status: j.status, stage: j.stage,
        record_type: j.record_type, created: j.jn_created ? j.jn_created.slice(0, 10) : null,
        due: due[j.id] != null ? Math.round(due[j.id] * 100) / 100 : null,
        inv_total: invTotal[j.id] != null ? Math.round(invTotal[j.id] * 100) / 100 : null,
        group, category, amount: e && e.amount != null ? Number(e.amount) : null,
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
    // Total AR = every open job's outstanding invoice balance, whatever its status.
    const arTotal = Math.round(rows.reduce((s, r) => s + (!r.custom && r.due > 0 ? r.due : 0), 0) * 100) / 100;
    const bank = pool.bank_balance != null ? { balance: Number(pool.bank_balance), at: pool.bank_balance_at, by: pool.bank_balance_by } : null;
    return { pool, label: pool.label || (pool.locations && pool.locations.name) || 'Location', rows, lastUpdate, lastBy, arTotal, bank };
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

  async function saveSnapshot(locationId, body, ip, c) {
    await sbWrite('POST', 'wip_snapshots', { location_id: locationId, body, in_progress_total: ip, collecting_total: c }, 'return=minimal');
  }

  // ── HTML shell ──────────────────────────────────────────────────────────────
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function json(o) { return JSON.stringify(o).replace(/</g, '\\u003c'); }
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
  @media(min-width:600px){.actions{grid-template-columns:repeat(4,1fr)}}
  `;
  const ICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1b6e5a"/><text x="32" y="41" font-family="-apple-system,Helvetica,Arial" font-weight="700" font-size="22" text-anchor="middle" fill="#fff">WIP</text></svg>');
  function page(title, body, script, topbar) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default"><meta name="apple-mobile-web-app-title" content="${esc(title)}">
<meta name="theme-color" content="#f3f5f2"><link rel="icon" href="${ICON}"><link rel="apple-touch-icon" href="${ICON}">
<title>${esc(title)}</title><style>${CSS}</style></head><body>${topbar || ''}<div class="wrap">${body}</div>
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
      const topbar = `<div class="top"><h1>${esc(data.label)} · WIP</h1><button class="btn small" data-share="${textUrl}" data-share-title="${esc(data.label)} WIP">Share</button></div>`;
      const body = `
<div class="tot"><div class="card"><span>In Progress</span><b id="t-ip">$0</b><div class="meta" id="n-ip"></div></div>
<div class="card"><span>Collecting</span><b id="t-col">$0</b><div class="meta" id="n-col"></div></div>
<div class="card"><span>Total AR</span><b>${whole(data.arTotal)}</b><div class="meta">all open invoices</div></div>
<div class="card"><span>Bank balance</span><div class="amt-row" style="margin-top:4px"><span class="pre">$</span><input type="number" inputmode="decimal" step="0.01" class="amt" id="bank" value="${data.bank ? esc(data.bank.balance) : ''}" placeholder="enter"></div>
<div class="meta" id="bank-meta">${data.bank && data.bank.at ? `as of ${esc(new Date(data.bank.at).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: 'America/Chicago' }))}${data.bank.by ? ' · ' + esc(data.bank.by) : ''}` : 'not entered yet'}</div></div></div>
<div class="sub" style="margin-bottom:10px">Put a value on each job in progress, enter the amount you expect to collect on each invoice this week (leave blank if nothing yet), and enter today's bank balance. Everything saves as you go.</div>
<input type="text" id="who" placeholder="Your name (so we know who updated)" autocomplete="name">
<div id="sections"></div>
<div class="bar"><div class="status" id="status">Loaded</div><button class="btn ghost small" id="add-btn">+ Add</button><a class="btn ghost small" href="${textUrl}" target="_blank">Text</a></div>
<div class="sheet" id="add-sheet"><div><b>Add a line that isn't in JobNimbus</b><div class="actions" style="margin-top:12px"><button class="btn" onclick="addCustom('in_progress')">In-progress job</button><button class="btn ghost" onclick="addCustom('collecting')">Collecting item</button></div></div></div>`;
      const script = `
const TOKEN=${json(pool.token)};let ROWS=${json(data.rows)};
const GROUPS=[['in_progress','In progress',true],['ar','Invoiced — enter what you expect to collect this week',true],['billing','Invoice created / in storage — enter a value to count as in progress',false],['other','Leads, estimating, holds',false],['custom','Added by you',true],['hidden','Hidden — not counted',false]];
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
function totals(){let ip=0,c=0,ni=0,nc=0;for(const r of ROWS){if(r.category==='in_progress'){ip+=Number(r.amount||0);ni++}if(r.category==='collecting'){c+=Number(amtOf(r));nc++}}
document.getElementById('t-ip').textContent=fmt(ip);document.getElementById('t-col').textContent=fmt(c);document.getElementById('n-ip').textContent=ni+' job'+(ni===1?'':'s');document.getElementById('n-col').textContent=nc+' item'+(nc===1?'':'s')}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function cardClass(r){return 'job '+(r.category==='in_progress'?'is-ip':r.category==='collecting'?'is-col':'')}
function jobCard(r){const vg=viewGroup(r);const ph=vg==='ar'?(r.due!=null?'expected this week (due '+r.due.toFixed(2)+')':'expected this week'):vg==='billing'||vg==='other'?'value, if in progress':'estimated value';
const link=vg==='in_progress'&&!r.custom?' · <a href="#" data-hide="'+esc(r.key)+'">hide</a>':vg==='hidden'?' · <a href="#" data-restore="'+esc(r.key)+'">count as in progress</a>':r.custom?' · <a href="#" data-del="'+esc(r.key)+'">remove</a>':'';
return '<div class="'+cardClass(r)+'" data-card="'+esc(r.key)+'"><div class="job-head">'+(r.custom?'<input type="text" class="nm" value="'+esc(r.name)+'" data-k="'+esc(r.key)+'" data-f="custom_name" placeholder="Job or customer name">':'<div class="nm">'+esc(r.name)+'</div>')
+'<div class="meta">'+(r.number?'#'+esc(r.number)+' · ':'')+esc(r.status)+(r.record_type&&r.record_type!=='Mitigation'?' · '+esc(r.record_type):'')+(r.created?' · '+esc(r.created):'')+(r.due!=null?' · <b>due '+fmt(r.due)+'</b>':'')+link+'</div></div>'
+(vg==='hidden'?'':'<div class="amt-row"><span class="pre">$</span><input type="number" inputmode="decimal" step="0.01" class="amt" data-k="'+esc(r.key)+'" data-f="amount" value="'+(r.amount!=null?r.amount:'')+'" placeholder="'+esc(ph)+'"></div>'
+'<input type="text" class="nt" data-k="'+esc(r.key)+'" data-f="note" value="'+esc(r.note)+'" placeholder="Note (optional)">')+'</div>'}
function render(){const host=document.getElementById('sections');host.innerHTML='';
for(const [g,title,dflt] of GROUPS){const rows=ROWS.filter(r=>viewGroup(r)===g);if(!rows.length)continue;
const open=OPEN[g]!==undefined?OPEN[g]:dflt;
const sec=document.createElement('details');sec.className='sec';sec.open=open;sec.dataset.g=g;
sec.innerHTML='<summary><h2>'+esc(title)+'</h2><span class="count">'+rows.length+'</span></summary>'+rows.map(jobCard).join('');
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
document.addEventListener('click',e=>{const h=e.target.closest('a[data-hide],a[data-restore]');if(h){e.preventDefault();const key=h.dataset.hide||h.dataset.restore;const r=ROWS.find(x=>x.key===key);r.category=h.dataset.hide?null:'in_progress';if(h.dataset.hide)OPEN.hidden=true;render();queue(r.key);return}
const d=e.target.closest('a[data-del]');if(d){e.preventDefault();if(!confirm('Remove this line?'))return;fetch('/wip/'+TOKEN+'/entries/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:d.dataset.del})}).then(()=>{ROWS=ROWS.filter(x=>x.key!==d.dataset.del);render()})}});
document.addEventListener('input',e=>{const i=e.target;if(!i.dataset||!i.dataset.f)return;const r=ROWS.find(x=>x.key===i.dataset.k);if(!r)return;
if(i.dataset.f==='amount'){r.amount=i.value===''?null:Number(i.value);r.category=deriveCategory(r);const card=i.closest('[data-card]');if(card)card.className=cardClass(r);totals()}else if(i.dataset.f==='note'){r.note=i.value}else if(i.dataset.f==='custom_name'){r.name=i.value}queue(r.key)});
function addCustom(cat){document.getElementById('add-sheet').classList.remove('open');const key='custom:'+crypto.randomUUID();ROWS.push({key,name:'',number:null,status:'Added by you',created:null,due:null,group:'custom',category:cat,amount:null,note:'',custom:true});OPEN.custom=true;render();queue(key);
const el=document.querySelector('input[data-k="'+key+'"][data-f="custom_name"]');if(el){el.scrollIntoView({block:'center'});el.focus()}}
window.addEventListener('beforeunload',()=>{if(dirty.size)flush()});render();`;
      res.send(page(`${data.label} WIP`, body, script, topbar));
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
      res.json({ ok: true, saved: rows.length });
    } catch (err) { console.error('[wip save]', err.message); res.status(502).json({ error: err.message }); }
  });

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

  // ── Master page ─────────────────────────────────────────────────────────────
  async function loadPool() {
    return sbGet('wip_pool?select=id,location_id,token,label,sort_order,added_at,bank_balance,bank_balance_at,bank_balance_by,locations(name)&order=sort_order.asc,added_at.asc');
  }

  app.get('/wip/master/:master', requireMaster, async (req, res) => {
    try {
      const pool = await loadPool();
      const locs = await sbGet('locations?status=eq.active&select=id,name&order=name.asc');
      const inPool = new Set(pool.map(p => p.location_id));
      const cards = [];
      let ipAll = 0, cAll = 0, arAll = 0, bankAll = 0, bankMissing = 0;
      for (const p of pool) {
        const data = await loadLocation(p);
        const s = sectionText(data);
        ipAll += s.ipTotal; cAll += s.cTotal; arAll += data.arTotal;
        if (data.bank) bankAll += data.bank.balance; else bankMissing++;
        const ownerUrl = `${req.protocol}://${req.get('host')}/wip/${p.token}`;
        const lastReview = (await sbGet(`wip_reviews?location_id=eq.${p.location_id}&select=reviewed_at,jobs_reviewed,applied&order=reviewed_at.desc&limit=1`))[0];
        cards.push(`<div class="card" data-pool="${esc(p.id)}">
<input type="text" value="${esc(data.label)}" data-label="${esc(p.id)}" class="nm" title="Report heading" aria-label="Report heading">
<div class="meta" style="margin-top:6px">${esc(p.locations ? p.locations.name : '')}</div>
<div class="row" style="margin-top:10px;gap:14px"><span>In Progress <b>${whole(s.ipTotal)}</b></span><span>Collecting <b>${whole(s.cTotal)}</b></span><span>AR <b>${whole(data.arTotal)}</b></span><span>Bank <b>${data.bank ? whole(data.bank.balance) : '—'}</b></span></div>
<div class="meta" style="margin-top:8px">${data.lastUpdate ? `Owner updated ${esc(data.lastUpdate.slice(0, 16).replace('T', ' '))}${data.lastBy ? ' by ' + esc(data.lastBy) : ''}` : 'No owner input yet'}
 · ${lastReview ? `AI review ${esc(lastReview.reviewed_at.slice(0, 16).replace('T', ' '))} (${lastReview.jobs_reviewed} jobs, ${lastReview.applied} updated)` : 'no AI review yet'}</div>
<div class="actions">
  <button class="btn" data-share="/wip/${esc(p.token)}/text" data-share-title="${esc(data.label)} WIP">Share</button>
  <button class="btn ghost" data-review="${esc(p.id)}">Review notes</button>
  <a class="btn ghost" href="${esc(ownerUrl)}" target="_blank">Open form</a>
  <button class="btn ghost" data-copy="${esc(ownerUrl)}">Copy link</button>
</div>
<details><summary class="sub" style="padding:10px 0 0;cursor:pointer">Show report · remove location</summary><pre>${esc(s.text)}</pre>
<button class="btn danger small" style="margin-top:10px" data-remove="${esc(p.id)}">Remove from pool</button></details></div>`);
      }
      const options = locs.filter(l => !inPool.has(l.id)).map(l => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('');
      const topbar = `<div class="top"><h1>WIP · all locations</h1><button class="btn small" data-share="/wip/master/${esc(req.params.master)}/text" data-share-title="WIP — all locations">Share all</button></div>`;
      const body = `
<div class="sub" style="margin-bottom:10px">${pool.length} location${pool.length === 1 ? '' : 's'} · ${today()}</div>
<div class="tot"><div class="card"><span>In Progress</span><b>${whole(ipAll)}</b></div><div class="card"><span>Collecting</span><b>${whole(cAll)}</b></div>
<div class="card"><span>Total AR</span><b>${whole(arAll)}</b></div><div class="card"><span>Bank balances</span><b>${whole(bankAll)}</b>${bankMissing ? `<div class="meta">${bankMissing} location${bankMissing === 1 ? '' : 's'} not entered</div>` : ''}</div></div>
<div class="actions" style="margin:0 0 14px"><button class="btn ghost" id="review-all">Review all AR notes</button><a class="btn ghost" href="/wip/master/${esc(req.params.master)}/text" target="_blank">Combined text</a></div>
<div class="sub" style="margin-bottom:14px">“Review notes” reads each invoiced job's JobNimbus notes from the last 3 weeks and marks what is agreed or issued as Collecting${anthropic ? '' : ' — <b>ANTHROPIC_API_KEY is not set on the server, so this will fail until it is</b>'}.</div>
<div id="review-out"></div>
${cards.join('') || '<div class="card">No locations yet — add one below, then send the owner link.</div>'}
<div class="card"><b>Add a location</b><div class="row" style="margin-top:10px"><select id="add-loc" style="flex:1"><option value="">Choose a location…</option>${options}</select><button class="btn ghost" id="add-btn">Add</button></div></div>`;
      const script = `
const M=${json(req.params.master)};
document.getElementById('add-btn').onclick=async()=>{const id=document.getElementById('add-loc').value;if(!id)return;const r=await fetch('/wip/master/'+M+'/locations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location_id:id})});if(r.ok)location.reload();else alert(await r.text())};
document.addEventListener('click',async e=>{const c=e.target.closest('[data-copy]');if(c){if(navigator.share){try{await navigator.share({title:'WIP form',url:c.dataset.copy});return}catch(x){if(x&&x.name==='AbortError')return}}try{await navigator.clipboard.writeText(c.dataset.copy);c.textContent='Copied ✓';setTimeout(()=>c.textContent='Copy link',1500)}catch(x){prompt('Copy this link',c.dataset.copy)}return}
const r=e.target.closest('[data-remove]');if(r){if(!confirm('Remove this location from the pool? Owner values are kept.'))return;const x=await fetch('/wip/master/'+M+'/locations/'+r.dataset.remove,{method:'DELETE'});if(x.ok)location.reload();else alert(await x.text())}});
async function runReview(body,btn){const out=document.getElementById('review-out');const label=btn.textContent;btn.disabled=true;btn.textContent='Reviewing… (30–90s per location)';
try{const r=await fetch('/wip/master/'+M+'/review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw new Error(j.error||r.statusText);
const lab={collecting:'Collecting',received:'Received — post payment',not_yet:'Not yet'};
out.innerHTML=j.results.map(x=>'<div class="card"><b>'+esc(x.label)+'</b><div class="meta">'+x.jobs_reviewed+' AR jobs reviewed, '+x.applied+' updated'+(x.skipped_owner.length?', '+x.skipped_owner.length+' left as the owner set them':'')+'</div><div class="list" style="margin-top:8px">'
+x.jobs.map(d=>'<div><div class="row" style="justify-content:space-between"><span class="nm" style="font-size:15px">'+esc(d.name)+'</span><b>'+(d.amount!=null?'$'+Number(d.amount).toLocaleString('en-US',{minimumFractionDigits:2}):'')+'</b></div><div class="meta"><b>'+esc(lab[d.decision]||d.decision)+'</b>'+(d.owner_set?' · owner-set, not changed':'')+' — '+esc(d.reason)+'</div></div>').join('')+'</div></div>').join('')+'<div class="actions"><button class="btn" onclick="location.reload()">Reload totals</button></div>';
out.scrollIntoView({behavior:'smooth'})}catch(e){alert('Review failed: '+e.message)}finally{btn.disabled=false;btn.textContent=label}}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
document.getElementById('review-all').onclick=e=>runReview({all:true},e.target);
document.addEventListener('click',e=>{const b=e.target.closest('button[data-review]');if(b)runReview({pool_id:b.dataset.review},b)});
document.addEventListener('change',async e=>{const i=e.target.closest('input[data-label]');if(!i)return;await fetch('/wip/master/'+M+'/locations/'+i.dataset.label,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({label:i.value})})});`;
      res.send(page('WIP', body, script, topbar));
    } catch (err) { console.error('[wip master]', err.message); res.status(502).send(page('Error', `<p>${esc(err.message)}</p>`)); }
  });

  app.get('/wip/master/:master/text', requireMaster, async (req, res) => {
    try {
      const pool = await loadPool();
      const parts = []; let ip = 0, c = 0, ar = 0, bank = 0, bankMissing = 0;
      for (const p of pool) {
        const data = await loadLocation(p);
        const s = sectionText(data);
        ip += s.ipTotal; c += s.cTotal; ar += data.arTotal; parts.push(s.text);
        if (data.bank) bank += data.bank.balance; else bankMissing++;
      }
      const text = reportHeader('ALL LOCATIONS') + parts.join('\n\n\n') + '\n\n\n' + '='.repeat(40)
        + `\nIN PROGRESS — TOTAL: ${whole(ip)}\nCOLLECTING — TOTAL: ${whole(c)}\nTOTAL AR: ${whole(ar)}\nBANK BALANCES: ${whole(bank)}${bankMissing ? ` (${bankMissing} not entered)` : ''}\n`;
      await saveSnapshot(null, text, ip, c);
      res.type('text/plain; charset=utf-8').send(text);
    } catch (err) { res.status(502).type('text/plain').send(err.message); }
  });

  app.post('/wip/master/:master/locations', requireMaster, async (req, res) => {
    try {
      const id = String((req.body || {}).location_id || '');
      if (!/^[0-9a-f-]{36}$/.test(id)) return res.status(400).send('location_id required');
      const loc = await sbGet(`locations?id=eq.${id}&select=id,name`);
      if (!loc[0]) return res.status(404).send('location not found');
      await sbWrite('POST', 'wip_pool?on_conflict=location_id', { location_id: id }, 'resolution=ignore-duplicates,return=minimal');
      res.json({ ok: true });
    } catch (err) { res.status(502).send(err.message); }
  });
  app.patch('/wip/master/:master/locations/:id', requireMaster, async (req, res) => {
    try {
      const b = req.body || {}; const patch = {};
      if (b.label !== undefined) patch.label = String(b.label || '').slice(0, 80) || null;
      if (b.sort_order !== undefined && !isNaN(Number(b.sort_order))) patch.sort_order = Number(b.sort_order);
      await sbWrite('PATCH', `wip_pool?id=eq.${encodeURIComponent(req.params.id)}`, patch, 'return=minimal');
      res.json({ ok: true });
    } catch (err) { res.status(502).send(err.message); }
  });
  app.delete('/wip/master/:master/locations/:id', requireMaster, async (req, res) => {
    try {
      await sbWrite('DELETE', `wip_pool?id=eq.${encodeURIComponent(req.params.id)}`, undefined, 'return=minimal');
      res.json({ ok: true });
    } catch (err) { res.status(502).send(err.message); }
  });

  // ── AI review of AR notes ───────────────────────────────────────────────────
  // Pulls each invoiced job's recent JobNimbus activity and asks Claude which
  // ones are actually collectible this week; writes the answer into wip_entries
  // as 'ai-review' rows. Owner-edited rows are never overwritten.
  const REVIEW_MODEL = 'claude-opus-5';
  const REVIEW_LOOKBACK_DAYS = 21;
  const NOISE_TYPES = new Set(['Assigned Job', 'Unassigned Job', 'Assigned Contact', 'Text Message', 'Attachment deleted', 'Related to task', 'Task Completed', 'Automation']);

  const ReviewSchema = z.object({
    jobs: z.array(z.object({
      job_number: z.string(),
      decision: z.enum(['collecting', 'not_yet', 'received']),
      amount: z.number().nullable(),
      reason: z.string(),
    })),
  });

  const REVIEW_SYSTEM = `You review collections notes for a water-damage restoration company and decide, per invoiced job, whether payment can realistically be collected in the coming week.

Decisions:
- "collecting": within the last ~3 weeks the notes show payment is agreed or issued — a carrier confirmed it issued/mailed a check or agreed to a specific amount, the customer confirmed they have the check or will pay this week, or a check is on its way to the office. amount = the agreed/issued amount if one is stated (minus anything already paid), otherwise the balance due.
- "received": the notes say the check was received, deposited, or payment posted, but the job still shows a balance. amount = what was received. (Nobody has logged the payment yet.)
- "not_yet": anything else — invoice under review, comparative or line items disputed, claim denied, waiting on adjuster/reviewer with no answer, attorney, public adjuster or appraisal, monthly payment plan, bank investigation, customer unresponsive, or a promised check that is now more than 3 weeks old with no follow-up confirming it.

Be conservative: silence is "not_yet". Never invent amounts. reason: one short sentence (max 120 characters) naming the payer and the date of the key note. Return one entry for every job you were given.`;

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
    const data = await loadLocation(pool);
    const ar = data.rows.filter(r => r.group === 'ar' && !r.custom && r.jn_id);
    const since = Date.now() - REVIEW_LOOKBACK_DAYS * 86400000;
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

    const today = new Date().toISOString().slice(0, 10);
    const response = await anthropic.messages.parse({
      model: REVIEW_MODEL,
      max_tokens: 16000,
      system: REVIEW_SYSTEM,
      output_config: { format: zodOutputFormat(ReviewSchema), effort: 'medium' },
      messages: [{ role: 'user', content: `Today is ${today}. Location: ${data.label}.\n\nJobs (with recent JobNimbus notes, newest first):\n${JSON.stringify(jobs, null, 1)}` }],
    });
    if (response.stop_reason === 'refusal' || !response.parsed_output) {
      throw new Error(`model returned no decision (${response.stop_reason})`);
    }
    const decided = Object.fromEntries(response.parsed_output.jobs.map(d => [d.job_number, d]));

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
      result: { results, usage: response.usage },
    }, 'return=minimal');
    return { label: data.label, jobs_reviewed: jobs.length, applied: writes.length, skipped_owner: skippedOwner, jobs: results };
  }

  app.post('/wip/master/:master/review', requireMaster, async (req, res) => {
    try {
      const b = req.body || {};
      const pool = await loadPool();
      const targets = b.all ? pool : pool.filter(p => p.id === String(b.pool_id || ''));
      if (!targets.length) return res.status(400).json({ error: 'pool_id required' });
      const results = [];
      for (const p of targets) results.push(await reviewLocation(p, { dry: !!b.dry }));
      res.json({ results });
    } catch (err) {
      console.error('[wip review]', err.message);
      res.status(err instanceof Anthropic.APIError ? 502 : 500).json({ error: err.message });
    }
  });
};
