// Supplemental-billing admin dashboard, modeled on wip.js: a self-contained
// module behind a secret master link (supp_config.master_token in Supabase —
// the URL is the credential, no login). Two tabs:
//   Insights   — drafts created per month/location with $ totals, upcoming
//                billing, placeholders, skipped/errors, notification delivery,
//                run history (all from supplemental_billing_runs + live JN).
//   Locations  — per-location recipient override for the supplemental emails
//                (supp_email_overrides; a row REPLACES the auto-detected reps).
// Everything reads through the deps injected from server.js so the dashboard
// computes recipients with the IDENTICAL code path the send paths use.
const crypto = require('crypto');

module.exports = function mountSuppAdmin(app, {
  SUPABASE_URL, SUPABASE_SERVICE_KEY,
  suppFetchEligible, jnFetchAccountUsers, suppRepTally,
  suppResolveRecipients, suppLocationNames, loadSuppEmailOverrides,
  denverNextFirst, config, getLastSuppRun, getSuppRunActive,
}) {
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

  // ── Master-token gate (wip.js pattern) ──────────────────────────────────────
  let masterCache = { token: null, at: 0 };
  async function masterToken() {
    if (Date.now() - masterCache.at < 60000 && masterCache.token) return masterCache.token;
    const rows = await sbGet('supp_config?id=eq.1&select=master_token');
    masterCache = { token: rows[0] && rows[0].master_token, at: Date.now() };
    return masterCache.token;
  }
  function tokenOk(given, expected) {
    if (!given || !expected || given.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  }
  async function requireMaster(req, res, next) {
    try {
      if (!tokenOk(String(req.params.master || ''), await masterToken())) {
        return res.status(404).send(page('Not found', '<p>This link is not valid.</p>'));
      }
      next();
    } catch (err) { res.status(502).send(page('Error', `<p>${esc(err.message)}</p>`)); }
  }

  // ── Live JN pool cache (suppFetchEligible ≈ 6 paginated calls + full user
  // list — seconds of work; the dashboard shares one pull for 5 minutes) ──────
  let liveCache = { at: 0, data: null };
  async function getLive(refresh) {
    if (!refresh && liveCache.data && Date.now() - liveCache.at < 5 * 60 * 1000) return liveCache.data;
    const [{ eligible, noPrice }, users] = await Promise.all([suppFetchEligible(), jnFetchAccountUsers()]);
    const pool = eligible.concat(noPrice);
    const locIds = [...new Set(pool.map(j => j.location && j.location.id).filter(id => id != null))];
    const locNames = await suppLocationNames(locIds);
    liveCache = { at: Date.now(), data: { eligible, noPrice, pool, users, locNames } };
    return liveCache.data;
  }
  const locOf = (j) => (j.location && j.location.id != null) ? j.location.id : null;
  const money = (n) => Math.round(Number(n) || 0);

  // ── HTML helpers ────────────────────────────────────────────────────────────
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function json(o) { return JSON.stringify(o).replace(/</g, '\\u003c'); }
  const CSS = `
  :root{--bg:#f3f5f5;--card:#fff;--ink:#1b2427;--mut:#5c6b70;--line:#d8dedd;--acc:#12617d;--good:#1a7a44;--warn:#9a6210;--danger:#a83232}
  *{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
  body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  .top{position:sticky;top:0;z-index:5;background:rgba(243,245,245,.94);backdrop-filter:blur(10px);border-bottom:1px solid var(--line);padding:calc(10px + env(safe-area-inset-top)) 16px 0}
  .top h1{font-size:18px;margin:0 0 8px}
  .tabs{display:flex;gap:4px}.tabs button{font:inherit;font-weight:600;font-size:14px;border:0;background:none;color:var(--mut);padding:10px 14px;border-bottom:2px solid transparent;cursor:pointer}
  .tabs button.on{color:var(--acc);border-bottom-color:var(--acc)}
  .wrap{max-width:860px;margin:0 auto;padding:14px 16px 60px}
  h2{font-size:12.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);margin:22px 0 8px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
  .tot{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
  .tot .card{margin:0}.tot b{font-size:21px;display:block;font-variant-numeric:tabular-nums}.tot span{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
  .badge{display:inline-block;font-size:11px;font-weight:700;border-radius:999px;padding:2px 8px;vertical-align:2px}
  .badge.live{background:#e3f2e8;color:var(--good)}.badge.dry{background:#f8edd8;color:var(--warn)}.badge.env{background:#e8eceb;color:var(--mut)}.badge.db{background:#e1eef3;color:var(--acc)}
  .tw{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:12px}
  table{border-collapse:collapse;width:100%;font-size:13.5px}
  th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--mut);text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
  td{padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
  tr:last-child td{border-bottom:0}
  td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}th.n{text-align:right}
  .mut{color:var(--mut)}.ok{color:var(--good);font-weight:600}.err{color:var(--danger);font-weight:600}.warn{color:var(--warn);font-weight:600}
  details.sec{margin:14px 0 0}details.sec>summary{cursor:pointer;padding:8px 2px;font-weight:600;user-select:none}
  input[type=email]{font:inherit;font-size:14px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;width:100%;min-width:180px}
  .btn{font:inherit;font-size:13px;font-weight:600;padding:8px 12px;border-radius:8px;border:1px solid var(--acc);background:var(--acc);color:#fff;cursor:pointer;white-space:nowrap}
  .btn.ghost{background:#fff;color:var(--acc)}.btn.danger{border-color:var(--danger);color:var(--danger);background:#fff}
  .btn:disabled{opacity:.55}
  .rowctl{display:flex;gap:6px;align-items:center;margin-top:6px}
  .status{font-size:12.5px;margin-top:4px}
  .note{color:var(--mut);font-size:13px;margin:6px 0 0}
  .spin{color:var(--mut);padding:24px;text-align:center}
  @media(max-width:640px){.tot b{font-size:18px}}
  `;
  const ICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#12617d"/><text x="32" y="41" font-family="-apple-system,Helvetica,Arial" font-weight="700" font-size="20" text-anchor="middle" fill="#fff">SUP</text></svg>');
  function page(title, body, script) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#f3f5f5"><link rel="icon" href="${ICON}">
<title>${esc(title)}</title><style>${CSS}</style></head><body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;
  }

  // ── Insights data ───────────────────────────────────────────────────────────
  app.get('/supp/admin/:master/insights.json', requireMaster, async (req, res) => {
    try {
      const live = await getLive(req.query.refresh === '1');
      const [runsAll, billingRuns, reminderRuns] = await Promise.all([
        sbGet('supplemental_billing_runs?select=month,mode,trigger,started_at,finished_at,eligible_count,created_count,skipped_count,error_count&order=started_at.desc&limit=24'),
        sbGet('supplemental_billing_runs?mode=in.(live,dryrun)&select=month,mode,started_at,report&order=started_at.desc&limit=12'),
        sbGet('supplemental_billing_runs?mode=like.reminder-*&select=month,mode,started_at,report&order=started_at.desc&limit=6'),
      ]);

      // drafts by month × location, deduped by job within (month, mode) so a
      // manual + scheduled run of the same month can't double-count
      const months = new Map(); // `${month}|${mode}` → { month, mode, seen:Set, total, count, placeholders, loc: Map }
      const allLocIds = new Set();
      for (const run of billingRuns) {
        const key = `${run.month}|${run.mode}`;
        if (!months.has(key)) months.set(key, { month: run.month, mode: run.mode, seen: new Set(), total: 0, count: 0, placeholders: 0, loc: new Map() });
        const m = months.get(key);
        for (const c of (run.report && run.report.created) || []) {
          if (!c || !c.jnid || m.seen.has(c.jnid)) continue;
          m.seen.add(c.jnid);
          const amt = Number(c.total) || 0;
          m.count++; m.total += amt; if (c.placeholder) m.placeholders++;
          const lid = c.location_id != null ? c.location_id : 'none';
          if (lid !== 'none') allLocIds.add(lid);
          if (!m.loc.has(lid)) m.loc.set(lid, { count: 0, total: 0, placeholders: 0 });
          const L = m.loc.get(lid); L.count++; L.total += amt; if (c.placeholder) L.placeholders++;
        }
      }
      const histNames = await suppLocationNames([...allLocIds]);
      const monthsOut = [...months.values()]
        .sort((a, b) => b.month.localeCompare(a.month) || a.mode.localeCompare(b.mode))
        .map(m => ({
          month: m.month, mode: m.mode, count: m.count, total: money(m.total), placeholders: m.placeholders,
          locations: [...m.loc.entries()]
            .map(([lid, v]) => ({ name: lid === 'none' ? '(no location)' : (histNames.get(lid) || live.locNames.get(lid) || `location ${lid}`), count: v.count, total: money(v.total), placeholders: v.placeholders }))
            .sort((a, b) => b.total - a.total),
        }));

      // last billing run detail: skipped by reason + errors
      const lastBilling = billingRuns[0] || null;
      const skippedByReason = {};
      for (const s of (lastBilling && lastBilling.report && lastBilling.report.skipped) || []) {
        const r = s.reason || 'unknown'; skippedByReason[r] = (skippedByReason[r] || 0) + 1;
      }
      const lastErrors = ((lastBilling && lastBilling.report && lastBilling.report.errors) || []).slice(0, 20);

      // notification delivery: last billing run + recent reminder stages
      const delivery = [];
      const pushNotifs = (run, kind) => {
        for (const n of (run.report && run.report.notifications) || []) {
          delivery.push({ when: run.started_at, kind, month: run.month, location: n.location || '', recipients: n.recipients || (n.email ? [n.email] : []), jobs: n.jobs != null ? n.jobs : (n.billable != null ? n.billable : null), ok: !!n.ok, error: n.error || null });
        }
      };
      if (lastBilling) pushNotifs(lastBilling, lastBilling.mode === 'live' ? 'billing' : 'billing (dryrun)');
      for (const r of reminderRuns.slice(0, 2)) pushNotifs(r, r.mode);

      // upcoming: eligible pool → next run
      const upcomingLoc = new Map();
      let upTotal = 0;
      for (const j of live.eligible) {
        const amt = Number(j.cf_double_1) || 0; upTotal += amt;
        const lid = locOf(j); if (lid == null) continue;
        if (!upcomingLoc.has(lid)) upcomingLoc.set(lid, { count: 0, total: 0, placeholders: 0 });
        const L = upcomingLoc.get(lid); L.count++; L.total += amt;
      }
      for (const j of live.noPrice) {
        const lid = locOf(j); if (lid == null) continue;
        if (!upcomingLoc.has(lid)) upcomingLoc.set(lid, { count: 0, total: 0, placeholders: 0 });
        upcomingLoc.get(lid).placeholders++;
      }
      const nf = denverNextFirst();
      const upcoming = {
        next_billing: `${nf.monthKey}-01`, days_until: nf.daysUntil,
        reminder_days: config.SUPP_REMINDER_DAYS, live: !!config.SUPP_BILLING_LIVE,
        eligible: live.eligible.length, expected_total: money(upTotal), placeholders: live.noPrice.length,
        locations: [...upcomingLoc.entries()]
          .map(([lid, v]) => ({ name: live.locNames.get(lid) || `location ${lid}`, count: v.count, total: money(v.total), placeholders: v.placeholders }))
          .sort((a, b) => b.total - a.total),
      };
      const unpriced = live.noPrice.map(j => ({
        name: j.name, number: j.number, jnid: j.jnid, status: j.status_name,
        location: live.locNames.get(locOf(j)) || '', url: `https://app.jobnimbus.com/job/${j.jnid}/payments-and-invoices`,
      })).sort((a, b) => a.location.localeCompare(b.location) || String(a.name).localeCompare(String(b.name)));

      res.json({
        as_of: new Date().toISOString(), live_data_age_min: Math.round((Date.now() - liveCache.at) / 60000),
        running: getSuppRunActive(), last_run: getLastSuppRun(),
        upcoming, months: monthsOut, skipped_by_reason: skippedByReason, last_errors: lastErrors,
        last_billing_month: lastBilling && lastBilling.month, delivery,
        unpriced, runs: runsAll,
      });
    } catch (err) {
      console.error('[supp-admin] insights failed:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ── Locations data ──────────────────────────────────────────────────────────
  app.get('/supp/admin/:master/locations.json', requireMaster, async (req, res) => {
    try {
      const live = await getLive(req.query.refresh === '1');
      const dbOverrides = await loadSuppEmailOverrides();
      const tally = suppRepTally(live.pool);
      const byLoc = new Map();
      for (const j of live.pool) {
        const lid = locOf(j); if (lid == null) continue;
        if (!byLoc.has(lid)) byLoc.set(lid, []);
        byLoc.get(lid).push(j);
      }
      const rows = [...byLoc.entries()].map(([lid, jobs]) => {
        const billable = jobs.filter(j => Number(j.cf_double_1) > 0);
        const auto = suppResolveRecipients(lid, jobs, tally, live.users); // env append included, no DB map
        const effective = suppResolveRecipients(lid, jobs, tally, live.users, dbOverrides);
        const db = dbOverrides.get(String(lid)) || null;
        const env = config.envOverrides.get(String(lid)) || null;
        return {
          jn_location_id: lid, name: live.locNames.get(lid) || `location ${lid}`,
          jobs: jobs.length, monthly_total: money(billable.reduce((s, j) => s + (Number(j.cf_double_1) || 0), 0)),
          placeholders: jobs.length - billable.length,
          auto_recipients: auto.map(r => `${r.name} <${r.email}>`),
          effective_recipients: effective.map(r => `${r.name} <${r.email}>`),
          override: db ? { email: db, source: 'db' } : (env ? { email: env, source: 'env' } : null),
        };
      }).sort((a, b) => b.monthly_total - a.monthly_total);
      res.json({ as_of: new Date().toISOString(), locations: rows });
    } catch (err) {
      console.error('[supp-admin] locations failed:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ── Override editing ────────────────────────────────────────────────────────
  app.post('/supp/admin/:master/override', requireMaster, async (req, res) => {
    try {
      const lid = parseInt(req.body && req.body.jn_location_id, 10);
      const email = String(req.body && req.body.email || '').trim();
      if (!Number.isFinite(lid) || lid < 1) return res.status(400).json({ error: 'jn_location_id must be a positive integer' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'enter a valid email address' });
      await sbWrite('POST', 'supp_email_overrides?on_conflict=jn_location_id',
        { jn_location_id: lid, email, updated_at: new Date().toISOString() },
        'resolution=merge-duplicates,return=minimal');
      console.log(`[supp-admin] override set — location ${lid} → ${email}`);
      res.json({ ok: true, jn_location_id: lid, email });
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  app.delete('/supp/admin/:master/override/:locId', requireMaster, async (req, res) => {
    try {
      const lid = parseInt(req.params.locId, 10);
      if (!Number.isFinite(lid) || lid < 1) return res.status(400).json({ error: 'bad location id' });
      await sbWrite('DELETE', `supp_email_overrides?jn_location_id=eq.${lid}`, undefined, 'return=minimal');
      console.log(`[supp-admin] override cleared — location ${lid}`);
      res.json({ ok: true, jn_location_id: lid });
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  // ── Shell page ──────────────────────────────────────────────────────────────
  app.get('/supp/admin/:master', requireMaster, async (req, res) => {
    const body = `
<div class="top"><h1>Supplemental Billing</h1>
  <div class="tabs"><button id="tb-i" class="on">Insights</button><button id="tb-l">Location emails</button></div></div>
<div class="wrap">
  <div id="tab-i"><div class="spin">Loading…</div></div>
  <div id="tab-l" hidden><div class="spin">Loading…</div></div>
</div>`;
    const script = `
const MASTER=${json(req.params.master)};
const $=(id)=>document.getElementById(id);
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;};
const usd=(n)=>'$'+Number(n||0).toLocaleString('en-US');
const fdate=(s)=>s?new Date(s).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'';
const MODE_BADGE=(m)=>{const b=el('span','badge '+(m==='live'?'live':'dry'),m==='live'?'LIVE':m.toUpperCase());return b;};
function table(headers,rows){const w=el('div','tw');const t=el('table');const tr=el('tr');
  headers.forEach(h=>{const th=el('th',h.n?'n':'',h.t);tr.appendChild(th);});
  const th=el('thead');th.appendChild(tr);t.appendChild(th);
  const tb=el('tbody');rows.forEach(cells=>{const r=el('tr');cells.forEach(c=>{
    const td=el('td',c&&c.n?'n':'');if(c&&c.node)td.appendChild(c.node);else td.textContent=c&&c.t!=null?c.t:(c==null?'':c);
    if(c&&c.cls)td.className+=(td.className?' ':'')+c.cls;r.appendChild(td);});tb.appendChild(r);});
  t.appendChild(tb);w.appendChild(t);return w;}
function h2(t){return el('h2',null,t);}

async function loadInsights(){
  const root=$('tab-i');root.textContent='';root.appendChild(el('div','spin','Loading…'));
  try{
    const d=await (await fetch('/supp/admin/'+MASTER+'/insights.json')).json();
    if(d.error)throw new Error(d.error);
    root.textContent='';
    // tiles
    const tiles=el('div','tot');
    const tile=(label,value,extraNode)=>{const c=el('div','card');const b=el('b',null,value);c.appendChild(b);const s=el('span',null,label);c.appendChild(s);if(extraNode)c.appendChild(extraNode);tiles.appendChild(c);};
    tile('Next billing run',d.upcoming.next_billing+' ('+d.upcoming.days_until+'d)',MODE_BADGE(d.upcoming.live?'live':'dryrun'));
    tile('Jobs set to bill',String(d.upcoming.eligible));
    tile('Expected next run',usd(d.upcoming.expected_total)+'/mo');
    tile('Unpriced ($0 drafts)',String(d.upcoming.placeholders));
    if(d.last_run)tile('Last run ('+d.last_run.month+')',d.last_run.created+' drafts',el('span','note',d.last_run.skipped+' skipped, '+d.last_run.errors+' errors'));
    root.appendChild(tiles);
    root.appendChild(el('p','note','Live JobNimbus data as of '+d.live_data_age_min+' min ago.'+(d.running?' A billing run is in progress right now.':'')));

    root.appendChild(h2('Upcoming billing by location'));
    root.appendChild(table([{t:'Location'},{t:'Jobs',n:1},{t:'$/month',n:1},{t:'Unpriced',n:1}],
      d.upcoming.locations.map(l=>[l.name,{t:String(l.count),n:1},{t:usd(l.total),n:1},{t:l.placeholders?String(l.placeholders):'—',n:1,cls:l.placeholders?'warn':'mut'}])));

    root.appendChild(h2('Drafts created by month'));
    d.months.forEach(m=>{
      const det=el('details','sec');if(m===d.months[0])det.open=true;
      const sum=el('summary');sum.appendChild(document.createTextNode(m.month+' — '+m.count+' drafts, '+usd(m.total)+' '));sum.appendChild(MODE_BADGE(m.mode));
      if(m.placeholders)sum.appendChild(document.createTextNode(' · '+m.placeholders+' placeholders'));
      det.appendChild(sum);
      det.appendChild(table([{t:'Location'},{t:'Drafts',n:1},{t:'$',n:1},{t:'Placeholders',n:1}],
        m.locations.map(l=>[l.name,{t:String(l.count),n:1},{t:usd(l.total),n:1},{t:l.placeholders?String(l.placeholders):'—',n:1,cls:l.placeholders?'warn':'mut'}])));
      root.appendChild(det);});

    if(d.unpriced.length){root.appendChild(h2('Jobs missing a price ('+d.unpriced.length+')'));
      root.appendChild(table([{t:'Location'},{t:'Job'},{t:'Status'}],
        d.unpriced.map(u=>{const a=el('a',null,u.name+' #'+u.number);a.href=u.url;a.target='_blank';a.rel='noopener';a.style.color='var(--acc)';a.style.fontWeight='600';
          return [u.location,{node:a},{t:u.status,cls:'mut'}];})));}

    const skKeys=Object.keys(d.skipped_by_reason);
    if(skKeys.length||d.last_errors.length){root.appendChild(h2('Last billing run ('+(d.last_billing_month||'—')+') — skipped & errors'));
      root.appendChild(table([{t:'Reason'},{t:'Jobs',n:1}],
        skKeys.map(k=>[k,{t:String(d.skipped_by_reason[k]),n:1}])
        .concat(d.last_errors.map(e=>[{t:'ERROR: '+e.name+' — '+e.error,cls:'err'},{t:'',n:1}]))));}

    if(d.delivery.length){root.appendChild(h2('Email delivery (latest run + reminders)'));
      root.appendChild(table([{t:'When'},{t:'Kind'},{t:'Location'},{t:'Recipients'},{t:'Status'}],
        d.delivery.map(n=>[{t:fdate(n.when),cls:'mut'},n.kind,n.location,(n.recipients||[]).join(', '),
          n.ok?{t:'sent',cls:'ok'}:{t:n.error||'failed',cls:'err'}])));}

    root.appendChild(h2('Run history'));
    root.appendChild(table([{t:'When'},{t:'Month'},{t:'Mode'},{t:'Trigger'},{t:'Eligible',n:1},{t:'Created/Sent',n:1},{t:'Skipped',n:1},{t:'Errors',n:1}],
      d.runs.map(r=>[{t:fdate(r.started_at),cls:'mut'},r.month,{node:MODE_BADGE(r.mode)},r.trigger,
        {t:r.eligible_count!=null?String(r.eligible_count):'—',n:1},{t:String(r.created_count??'—'),n:1},
        {t:String(r.skipped_count??'—'),n:1},{t:r.error_count?String(r.error_count):'—',n:1,cls:r.error_count?'err':'mut'}])));
  }catch(e){root.textContent='';root.appendChild(el('p','err','Failed to load: '+e.message));}
}

async function loadLocations(){
  const root=$('tab-l');root.textContent='';root.appendChild(el('div','spin','Loading…'));
  try{
    const d=await (await fetch('/supp/admin/'+MASTER+'/locations.json')).json();
    if(d.error)throw new Error(d.error);
    root.textContent='';
    root.appendChild(el('p','note','Set an email to make it THE recipient for that location\\u2019s supplemental emails (monthly drafts + prep reminders). Clear it to go back to the automatically-detected sales reps. Changes take effect on the next send.'));
    const rows=d.locations.map(l=>{
      const nameCell=el('div');nameCell.appendChild(el('div',null,l.name));
      nameCell.appendChild(el('div','note',l.jobs+' jobs · '+usd(l.monthly_total)+'/mo'+(l.placeholders?' · '+l.placeholders+' unpriced':'')));
      const recCell=el('div');
      const eff=el('div',null,l.effective_recipients.join(', ')||'(nobody)');recCell.appendChild(eff);
      if(l.override){const b=el('span','badge '+(l.override.source==='db'?'db':'env'),l.override.source==='db'?'OVERRIDE':'ENV DEFAULT');recCell.appendChild(b);
        if(l.override.source==='db'){const auto=el('div','note','auto would be: '+(l.auto_recipients.join(', ')||'(nobody)'));recCell.appendChild(auto);}}
      const editCell=el('div');
      const input=el('input');input.type='email';input.placeholder='name@company.com';input.value=l.override&&l.override.source==='db'?l.override.email:'';
      const ctl=el('div','rowctl');
      const save=el('button','btn','Save');const clear=el('button','btn danger','Clear');
      const status=el('div','status');
      save.onclick=async()=>{save.disabled=clear.disabled=true;status.textContent='Saving…';status.className='status';
        try{const r=await fetch('/supp/admin/'+MASTER+'/override',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jn_location_id:l.jn_location_id,email:input.value.trim()})});
          const j=await r.json();if(!r.ok)throw new Error(j.error||'failed');
          status.textContent='Saved — '+input.value.trim()+' now receives this location\\u2019s emails.';status.className='status ok';setTimeout(loadLocations,900);}
        catch(e){status.textContent=e.message;status.className='status err';save.disabled=clear.disabled=false;}};
      clear.onclick=async()=>{save.disabled=clear.disabled=true;status.textContent='Clearing…';status.className='status';
        try{const r=await fetch('/supp/admin/'+MASTER+'/override/'+l.jn_location_id,{method:'DELETE'});
          const j=await r.json();if(!r.ok)throw new Error(j.error||'failed');
          status.textContent='Cleared — back to automatic recipients.';status.className='status ok';setTimeout(loadLocations,900);}
        catch(e){status.textContent=e.message;status.className='status err';save.disabled=clear.disabled=false;}};
      ctl.appendChild(save);ctl.appendChild(clear);
      editCell.appendChild(input);editCell.appendChild(ctl);editCell.appendChild(status);
      return [{node:nameCell},{node:recCell},{node:editCell}];});
    root.appendChild(table([{t:'Location'},{t:'Current recipients'},{t:'Override email'}],rows));
  }catch(e){root.textContent='';root.appendChild(el('p','err','Failed to load: '+e.message));}
}

let loaded={i:false,l:false};
function show(which){
  $('tb-i').className=which==='i'?'on':'';$('tb-l').className=which==='l'?'on':'';
  $('tab-i').hidden=which!=='i';$('tab-l').hidden=which!=='l';
  if(which==='i'&&!loaded.i){loaded.i=true;loadInsights();}
  if(which==='l'&&!loaded.l){loaded.l=true;loadLocations();}
}
$('tb-i').onclick=()=>show('i');$('tb-l').onclick=()=>show('l');
show('i');`;
    res.send(page('Supplemental Billing', body, script));
  });
};
