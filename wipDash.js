// WIP master dashboard + admin portal — pure HTML renderers. Data is loaded in
// wip.js (loadDashboard / loadAdmin); these only turn a model into markup and
// the page script. ctx = { esc, json, q, help, whole, money } from wip.js.

const CSS = `
  .wrap.wide{max-width:1280px}
  .kpis{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:0 0 14px}
  .kpis .card{margin:0;padding:12px 14px}.kpis b{font-size:22px;display:block;font-variant-numeric:tabular-nums}.kpis span.k{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
  .panels{display:grid;grid-template-columns:1fr;gap:12px;margin:0 0 14px}
  .panel{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin:0;min-width:0}
  .panel h3{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);margin:0 0 10px;display:flex;align-items:center}
  .big{display:flex;gap:18px;flex-wrap:wrap;margin-bottom:10px}.big>div>span{display:block;color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.05em}.big>div>b{font-size:20px;font-variant-numeric:tabular-nums}
  table.t{width:100%;border-collapse:collapse;font-size:13.5px;font-variant-numeric:tabular-nums}
  table.t th{font-weight:600;color:var(--mut);font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;text-align:left;padding:6px 6px;border-bottom:1px solid var(--line)}
  table.t td{padding:7px 6px;border-bottom:1px solid var(--line);vertical-align:top}table.t tr:last-child td{border-bottom:0}
  table.t .r,table.t th.r{text-align:right;white-space:nowrap}table.t tr.need td{background:#fffbf0}table.t tr.tot td{font-weight:700;border-top:2px solid var(--line)}
  .up{color:var(--acc);font-weight:600}.down{color:var(--danger);font-weight:600}.flat{color:var(--mut)}
  .cards{display:grid;grid-template-columns:1fr;gap:12px}.cards .card{margin:0}
  .stat{display:flex;gap:14px;flex-wrap:wrap;margin-top:10px}.stat span{font-size:13px;color:var(--mut)}.stat b{color:var(--ink);font-variant-numeric:tabular-nums}
  .bankrow{display:flex;align-items:center;gap:8px;margin-top:10px}.bankrow label{font-size:13px;color:var(--mut);white-space:nowrap}.bankrow input{max-width:160px}
  .logo{height:28px;max-width:120px;object-fit:contain;flex:none}.logo.sm{height:20px;max-width:80px;vertical-align:middle;margin-right:8px}
  .rbar{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin:0 0 14px}.rbar[hidden]{display:none}
  .rbar progress{width:100%;height:10px;border:0;border-radius:999px;overflow:hidden;background:#e6ebe6;margin-top:8px;-webkit-appearance:none;appearance:none}
  .rbar progress::-webkit-progress-bar{background:#e6ebe6;border-radius:999px}.rbar progress::-webkit-progress-value{background:var(--acc);border-radius:999px;transition:width .3s}.rbar progress::-moz-progress-bar{background:var(--acc)}
  .rbar.err progress::-webkit-progress-value{background:var(--danger)}.rbar .lbl2{font-size:13.5px}.rbar .pct{color:var(--mut);font-size:13px;margin-left:auto;font-variant-numeric:tabular-nums}
  .ticks{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.ticks span{font-size:12px;border:1px solid var(--line);border-radius:999px;padding:2px 9px;color:var(--mut)}.ticks span.done{border-color:var(--acc);color:var(--acc)}.ticks span.cur{border-color:var(--ink);color:var(--ink)}.ticks span.fail{border-color:var(--danger);color:var(--danger)}
  .admin{display:grid;grid-template-columns:1fr;gap:14px}.mgr{cursor:pointer}.mgr.sel{border-color:var(--acc);box-shadow:0 0 0 2px rgba(27,110,90,.15)}.mgr.off{opacity:.6}
  .chk{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)}.chk:last-child{border-bottom:0}.chk input[type=checkbox]{width:20px;height:20px;flex:none}.chk .nm{flex:1;font-weight:500}
  .pill{display:inline-block;font-size:11px;border:1px solid var(--line);border-radius:999px;padding:1px 8px;color:var(--mut);margin-left:6px;vertical-align:middle}
  @media(min-width:900px){.kpis{grid-template-columns:repeat(6,1fr)}.panels{grid-template-columns:1fr 1fr 1fr}.cards{grid-template-columns:1fr 1fr}.admin{grid-template-columns:380px 1fr}.logo{height:36px}}
`;

function delta(v, { invert = false } = {}) {
  const n = Number(v || 0);
  if (!n) return '<span class="flat">—</span>';
  const good = invert ? n < 0 : n > 0;
  return `<span class="${good ? 'up' : 'down'}">${n > 0 ? '+' : '−'}$${Math.round(Math.abs(n)).toLocaleString('en-US')}</span>`;
}
function pct(num, den) { return den ? Math.round((num / den) * 100) + '%' : '—'; }
function ratio(num, den) { return den ? (num / den).toFixed(2) + '×' : '—'; }
function shortDate(iso) {
  if (!iso) return '';
  return new Date(iso.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function weekLabel(w) { return `${shortDate(w.start)} – ${shortDate(w.end)}`; }

// ── Master dashboard ──────────────────────────────────────────────────────────
function renderMaster(ctx, m) {
  const { esc, json, q, help, whole } = ctx;
  const T = m.totals, lw = weekLabel(m.lastWeek), nw = weekLabel(m.week);
  const base = `/wip/master/${esc(m.token)}`;
  const topbar = `<div class="top"><h1>WIP · ${esc(m.title)}</h1><a class="btn ghost small" href="${base}/pdf" target="_blank">PDF</a><button class="btn small" data-share="${base}/text" data-share-title="WIP — ${esc(m.title)}">Share all</button></div>`;

  const kpis = `<div class="kpis">
<div class="card"><span class="k">In Progress</span>${q('ip')}<b>${whole(T.ip)}</b><div class="meta">${T.ipCount} job${T.ipCount === 1 ? '' : 's'}${T.ipMissing + T.wcMissing ? ` · <span class="need-txt">${T.ipMissing + T.wcMissing} need a number</span>` : ''}</div>${help('ip', 'Owner-entered value of every job being worked on, all locations on this page.')}</div>
<div class="card"><span class="k">Collecting</span>${q('col')}<b>${whole(T.collecting)}</b><div class="meta">week of ${esc(nw)}</div>${help('col', 'Invoiced money expected to arrive during the upcoming week — owner-entered or set by Review notes.')}</div>
<div class="card"><span class="k">AR</span>${q('ar')}<b>${whole(T.ar)}</b>${help('ar', 'DryOps Open AR: approved-invoice balance on Invoice Created / Invoiced / Pending Payment jobs, every record type. Same number as the Dashboard.')}</div>
<div class="card"><span class="k">Bank Balance</span>${q('bank')}<b id="k-bank">${whole(T.bank)}</b>${T.bankMissing ? `<div class="meta">${T.bankMissing} location${T.bankMissing === 1 ? '' : 's'} not entered</div>` : ''}${help('bank', 'Sum of the balances entered on the owner forms or edited below.')}</div>
<div class="card"><span class="k">Collected last week</span>${q('clw')}<b>${whole(T.collected)}</b><div class="meta">${esc(lw)}</div>${help('clw', 'Payments posted in JobNimbus Mon–Sun last week, credit memos excluded — the same definition as Collected on the DryOps Stats screen.')}</div>
<div class="card"><span class="k">Invoiced last week</span>${q('ilw')}<b>${whole(T.invoiced)}</b><div class="meta">${esc(lw)}</div>${help('ilw', 'Invoices created in JobNimbus Mon–Sun last week — the same definition as Invoiced on the DryOps Stats screen.')}</div>
</div>`;

  // Panel 1 — forecast vs actual
  const fcRows = m.locations.map(l => `<tr><td>${esc(l.label)}</td><td class="r">${l.forecast != null ? whole(l.forecast) : '<span class="flat">no forecast</span>'}</td><td class="r">${whole(l.collected)}</td><td class="r">${l.forecast != null ? delta(l.collected - l.forecast) : '<span class="flat">—</span>'}</td></tr>`).join('');
  const panel1 = `<div class="panel"><h3>Forecast vs actual · last week${q('fc')}</h3>${help('fc', 'What the Collecting lists said would come in last week (the last report saved before that Monday) versus the payments that actually posted. Hit rate = came in ÷ we said.')}
<div class="big"><div><span>We said</span><b>${T.forecast != null ? whole(T.forecast) : '—'}</b></div><div><span>Came in</span><b>${whole(T.collected)}</b></div><div><span>Difference</span><b>${T.forecast != null ? delta(T.collected - T.forecast) : '—'}</b></div><div><span>Hit rate</span><b>${T.forecast != null ? pct(T.collected, T.forecast) : '—'}</b></div></div>
${T.forecastMissing ? `<div class="meta" style="margin-bottom:8px">${T.forecastMissing} location${T.forecastMissing === 1 ? '' : 's'} had no report saved before last Monday — the Saturday review saves one from now on.</div>` : ''}
<table class="t"><thead><tr><th>Location</th><th class="r">We said</th><th class="r">Came in</th><th class="r">Δ</th></tr></thead><tbody>${fcRows || '<tr><td colspan="4" class="flat">No locations yet.</td></tr>'}</tbody></table></div>`;

  // Panel 2 — estimate accuracy
  const A = m.accuracy;
  let panel2Body;
  if (!A.available) panel2Body = `<div class="meta">Not tracking yet — run <b>supabase_wip_dashboard.sql</b> in Supabase to start recording owner estimates.</div>`;
  else if (!A.n) panel2Body = `<div class="meta">Fills in as valued jobs get invoiced. ${A.pending} job${A.pending === 1 ? '' : 's'} with an estimate still in progress.</div>`;
  else panel2Body = `<div class="big"><div><span>Jobs</span><b>${A.n}</b></div><div><span>Invoiced ÷ estimate</span><b>${ratio(A.inv, A.est)}</b></div><div><span>Collected ÷ estimate</span><b>${ratio(A.col, A.est)}</b></div><div><span>Median job</span><b>${A.medianInv != null ? A.medianInv.toFixed(2) + '×' : '—'}</b></div></div>
<table class="t"><thead><tr><th>Job</th><th class="r">Estimate</th><th class="r">Invoiced</th><th class="r">Collected</th><th class="r">Δ</th></tr></thead><tbody>${A.recent.map(r => `<tr><td>${esc(r.name)}<div class="meta">${esc(r.label)}${r.number ? ' · #' + esc(r.number) : ''}</div></td><td class="r">${whole(r.est)}</td><td class="r">${whole(r.inv)}</td><td class="r">${whole(r.col)}</td><td class="r">${delta(r.inv - r.est)}</td></tr>`).join('')}</tbody></table>
${A.byLoc.length > 1 ? `<div class="meta" style="margin-top:8px">${A.byLoc.map(b => `${esc(b.label)} ${ratio(b.inv, b.est)} (${b.n})`).join(' · ')}</div>` : ''}`;
  const panel2 = `<div class="panel"><h3>Estimate accuracy${q('acc')}</h3>${help('acc', 'For jobs that owners valued while In Progress and that have since been invoiced: what was invoiced and collected compared with the estimate. Above 1× means owners under-estimate.')}${panel2Body}</div>`;

  // Panel 3 — jobs needing a number
  const needRows = [...m.locations].sort((a, b) => (b.ipMissing + b.wcMissing) - (a.ipMissing + a.wcMissing)).map(l => {
    const miss = l.ipMissing + l.wcMissing;
    return `<tr${miss ? ' class="need"' : ''}><td>${esc(l.label)}</td><td class="r">${l.ipCount - l.wcCount}${l.ipMissing ? ` <span class="need-txt">· ${l.ipMissing} need #</span>` : ''}</td><td class="r">${l.wcCount}${l.wcMissing ? ` <span class="need-txt">· ${l.wcMissing} need #</span>` : ''}</td><td class="r"><a href="/wip/${esc(l.token)}" target="_blank">Open form</a></td></tr>`;
  }).join('');
  const panel3 = `<div class="panel"><h3>Jobs needing a number${q('need')}</h3>${help('need', 'Jobs counted as In Progress on each owner form (Work Complete jobs are still In Progress until invoiced) and how many have no value typed in yet.')}
<div class="big"><div><span>In Progress</span><b>${T.ipCount - T.wcCount}</b></div><div><span>Work Complete</span><b>${T.wcCount}</b></div><div><span>Need a number</span><b class="${T.ipMissing + T.wcMissing ? 'need-txt' : ''}">${T.ipMissing + T.wcMissing}</b></div></div>
<table class="t"><thead><tr><th>Location</th><th class="r">In Progress</th><th class="r">Work Complete</th><th class="r"></th></tr></thead><tbody>${needRows || '<tr><td colspan="4" class="flat">No locations yet.</td></tr>'}</tbody></table></div>`;

  const reviewBar = `<div class="rbar" id="review-bar" hidden><div class="row"><span class="lbl2" id="review-label">Starting…</span><span class="pct" id="review-pct"></span></div><progress id="review-prog" max="100" value="0"></progress><div class="ticks" id="review-ticks"></div></div><div id="review-out"></div>`;

  const cards = m.locations.map(l => {
    const bankMeta = l.bank && l.bank.at ? `entered ${esc(new Date(l.bank.at).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: 'America/Chicago' }))}${l.bank.by ? ' by ' + esc(l.bank.by) : ''}` : '<span class="need-txt">not entered</span>';
    return `<div class="card" data-pool="${esc(l.id)}">
<div class="row" style="align-items:center">${l.logo ? `<img class="logo sm" src="${esc(l.logo)}" alt="">` : ''}<input type="text" value="${esc(l.label)}" data-label="${esc(l.id)}" class="nm" style="flex:1" title="Report heading" aria-label="Report heading"></div>
<div class="meta" style="margin-top:4px">${esc(l.name)}</div>
<div class="stat"><span>In Progress <b>${whole(l.ipTotal)}</b></span><span>Collecting <b>${whole(l.cTotal)}</b></span><span>AR <b>${whole(l.arTotal)}</b></span><span>Collected lw <b>${whole(l.collected)}</b></span><span>Invoiced lw <b>${whole(l.invoiced)}</b></span>${l.ipMissing + l.wcMissing ? `<span class="need-txt">${l.ipMissing + l.wcMissing} need a number</span>` : ''}</div>
<div class="bankrow"><label for="bank-${esc(l.id)}">Bank balance</label><span class="pre">$</span><input type="number" inputmode="decimal" step="0.01" class="amt" id="bank-${esc(l.id)}" data-bank="${esc(l.id)}" value="${l.bank ? esc(l.bank.balance) : ''}" placeholder="type it"><span class="meta" id="bank-meta-${esc(l.id)}">${bankMeta}</span></div>
<div class="meta" style="margin-top:8px">${l.lastUpdate ? `Owner updated ${esc(l.lastUpdate.slice(0, 16).replace('T', ' '))}${l.lastBy ? ' by ' + esc(l.lastBy) : ''}` : 'No owner input yet'}
 · ${l.lastReview ? `AI review ${esc(l.lastReview.reviewed_at.slice(0, 16).replace('T', ' '))}${l.lastReview.trigger === 'weekly' ? ' (auto)' : ''} (${l.lastReview.jobs_reviewed} jobs, ${l.lastReview.applied} updated)` : 'no AI review yet'}</div>
<div class="actions">
  <button class="btn" data-share="/wip/${esc(l.token)}/text" data-share-title="${esc(l.label)} WIP">Share</button>
  <button class="btn ghost" data-review="${esc(l.id)}">Review notes</button>
  <a class="btn ghost" href="${base}/pdf?pool_id=${esc(l.id)}" target="_blank">PDF</a>
  <a class="btn ghost" href="/wip/${esc(l.token)}" target="_blank">Open form</a>
</div>
<details><summary class="sub" style="padding:10px 0 0;cursor:pointer">Report text · owner link${m.scope === 'all' ? ' · remove' : ''}</summary><pre>${esc(l.text)}</pre>
<div class="actions"><button class="btn ghost small" data-copy="${esc(m.origin)}/wip/${esc(l.token)}">Copy owner link</button>${m.scope === 'all' ? `<button class="btn danger small" data-remove="${esc(l.id)}">Remove from pool</button>` : ''}</div></details></div>`;
  }).join('');

  const addCard = m.scope === 'all' ? `<div class="card" style="margin-top:12px"><b>Add a location</b><div class="row" style="margin-top:10px"><select id="add-loc" style="flex:1"><option value="">Choose a location…</option>${m.options.map(l => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('')}</select><button class="btn ghost" id="add-btn">Add</button></div></div>` : '';

  const body = `
<div class="sub" style="margin-bottom:10px">${m.locations.length} location${m.locations.length === 1 ? '' : 's'} · ${esc(m.today)} · upcoming week ${esc(nw)} · last week ${esc(lw)}</div>
${kpis}
<div class="panels">${panel1}${panel2}${panel3}</div>
<div class="actions" style="margin:0 0 14px"><button class="btn ghost" id="review-all">Review all AR notes</button><a class="btn ghost" href="${base}/text" target="_blank">Combined text</a><a class="btn ghost" href="${base}/pdf" target="_blank">PDF — all locations</a></div>
<div class="sub" style="margin-bottom:14px">“Review notes” reads each invoiced job's JobNimbus notes from the last 5 weeks and marks as Collecting what should actually arrive during the upcoming week — a mailed carrier check counts 10–14 business days after its issue date, not when it was promised. ${m.weeklyReview.enabled ? `It runs by itself every <b>Saturday at ${esc(m.weeklyReview.hourLabel)} Central</b> for every location here` : 'The automatic Saturday run is switched off (WIP_AUTO_REVIEW=off)'}${m.anthropic ? '' : ' — <b>ANTHROPIC_API_KEY is not set on the server, so it will fail until it is</b>'}.</div>
${reviewBar}
<div class="cards">${cards || '<div class="card">No locations yet.</div>'}</div>
${addCard}`;

  const script = `
const M=${json(m.token)};const LABELS=${json(Object.fromEntries(m.locations.map(l => [l.id, l.label])))};
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function fmt(n){return '$'+Math.round(n||0).toLocaleString('en-US')}
${m.scope === 'all' ? `document.getElementById('add-btn').onclick=async()=>{const id=document.getElementById('add-loc').value;if(!id)return;const r=await fetch('/wip/master/'+M+'/locations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location_id:id})});if(r.ok)location.reload();else alert(await r.text())};` : ''}
document.addEventListener('click',async e=>{const c=e.target.closest('[data-copy]');if(c){try{await navigator.clipboard.writeText(c.dataset.copy);const t=c.textContent;c.textContent='Copied ✓';setTimeout(()=>c.textContent=t,1500)}catch(x){prompt('Copy this link',c.dataset.copy)}return}
const r=e.target.closest('[data-remove]');if(r){if(!confirm('Remove this location from the pool? Owner values are kept.'))return;const x=await fetch('/wip/master/'+M+'/locations/'+r.dataset.remove,{method:'DELETE'});if(x.ok)location.reload();else alert(await x.text())}});
document.addEventListener('change',async e=>{const i=e.target.closest('input[data-label]');if(!i)return;await fetch('/wip/master/'+M+'/locations/'+i.dataset.label,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({label:i.value})})});
// Bank balance per location, editable here; the KPI tile follows.
const bankTimers={};
document.addEventListener('input',e=>{const i=e.target.closest('input[data-bank]');if(!i)return;const id=i.dataset.bank;const meta=document.getElementById('bank-meta-'+id);meta.textContent='saving…';clearTimeout(bankTimers[id]);
bankTimers[id]=setTimeout(async()=>{try{const r=await fetch('/wip/master/'+M+'/locations/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({bank_balance:i.value===''?null:Number(i.value)})});if(!r.ok)throw new Error(await r.text());meta.innerHTML=i.value===''?'<span class="need-txt">not entered</span>':'saved just now';
let sum=0;document.querySelectorAll('input[data-bank]').forEach(x=>{if(x.value!=='')sum+=Number(x.value)});document.getElementById('k-bank').textContent=fmt(sum)}catch(x){meta.textContent='save failed — '+x.message}},700)});
// AI review: start, then poll the progress bar.
const bar=document.getElementById('review-bar'),lbl=document.getElementById('review-label'),pctEl=document.getElementById('review-pct'),prog=document.getElementById('review-prog'),ticks=document.getElementById('review-ticks'),out=document.getElementById('review-out');
const PH={loading:'loading jobs',notes:'reading JobNimbus notes',deciding:'deciding what will arrive this week',saving:'saving'};
function paint(s){const total=s.total||1;const frac=(s.done+(s.phase_frac||0))/total;prog.value=Math.round(frac*100);pctEl.textContent=s.done+' of '+s.total+' location'+(s.total===1?'':'s');
lbl.textContent=s.finished?(s.error?'Review failed — '+s.error:'Done — '+(s.done-(s.failed||0))+' location'+(s.done-(s.failed||0)===1?'':'s')+' reviewed'+(s.failed?', '+s.failed+' failed':'')):'Reviewing '+(s.current||'')+(s.phase?' · '+(PH[s.phase]||s.phase)+(s.phase==='notes'&&s.jobs!=null?' for '+s.jobs+' job'+(s.jobs===1?'':'s'):''):'');
ticks.innerHTML=(s.items||[]).map(t=>'<span class="'+t.state+'">'+esc(t.label)+(t.state==='done'?' ✓':t.state==='fail'?' ✕':'')+'</span>').join('');bar.classList.toggle('err',!!s.error||(s.finished&&!!s.failed))}
function renderResults(results){const lab={collecting:'Collecting',received:'Received — post payment',not_yet:'Not yet'};
out.innerHTML=results.map(x=>'<div class="card" style="margin-top:12px"><b>'+esc(x.label)+'</b><div class="meta">'+(x.error?'<span class="need-txt">failed — '+esc(x.error)+'</span>':x.jobs_reviewed+' AR jobs reviewed, '+x.applied+' updated'+(x.skipped_owner&&x.skipped_owner.length?', '+x.skipped_owner.length+' left as the owner set them':''))+'</div>'+(x.jobs&&x.jobs.length?'<div class="list" style="margin-top:8px">'
+x.jobs.map(d=>'<div><div class="row" style="justify-content:space-between"><span class="nm" style="font-size:15px">'+esc(d.name)+'</span><b>'+(d.amount!=null?'$'+Number(d.amount).toLocaleString('en-US',{minimumFractionDigits:2}):'')+'</b></div><div class="meta"><b>'+esc(lab[d.decision]||d.decision)+'</b>'+(d.owner_set?' · owner-set, not changed':'')+' — '+esc(d.reason)+'</div></div>').join('')+'</div>':'')+'</div>').join('')+'<div class="actions" style="margin-top:12px"><button class="btn" onclick="location.reload()">Reload totals</button></div'}
let polling=null;
async function runReview(body,btn){const btns=document.querySelectorAll('[data-review],#review-all');btns.forEach(b=>b.disabled=true);bar.hidden=false;bar.classList.remove('err');out.innerHTML='';paint({total:1,done:0,current:'',phase:'loading',items:[]});bar.scrollIntoView({behavior:'smooth',block:'nearest'});
try{const r=await fetch('/wip/master/'+M+'/review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw new Error(j.error||r.statusText);
const tick=async()=>{const p=await fetch('/wip/master/'+M+'/review/'+j.run_id,{cache:'no-store'});const s=await p.json();if(!p.ok)throw new Error(s.error||p.statusText);paint(s);if(s.finished){clearInterval(polling);polling=null;btns.forEach(b=>b.disabled=false);renderResults(s.results||[])}};
polling=setInterval(()=>tick().catch(e=>{clearInterval(polling);polling=null;btns.forEach(b=>b.disabled=false);paint({total:1,done:0,finished:true,error:e.message,items:[]})}),1500);await tick()}
catch(e){btns.forEach(b=>b.disabled=false);paint({total:1,done:0,finished:true,error:e.message,items:[]})}}
document.getElementById('review-all').onclick=e=>runReview({all:true},e.target);
document.addEventListener('click',e=>{const b=e.target.closest('button[data-review]');if(b)runReview({pool_id:b.dataset.review},b)});`;
  return { body, script, topbar };
}

// ── Admin portal ──────────────────────────────────────────────────────────────
function renderAdmin(ctx, m) {
  const { esc, json } = ctx;
  const base = `/wip/admin/${esc(m.token)}`;
  const sel = m.managers.find(x => x.id === m.selected) || null;
  const topbar = `<div class="top"><h1>WIP · managers</h1><a class="btn ghost small" href="/wip/master/${esc(m.masterToken)}" target="_blank">All-locations page</a></div>`;
  const mgrCards = m.managers.map(x => `<div class="card mgr${x.id === m.selected ? ' sel' : ''}${x.active ? '' : ' off'}" data-select="${esc(x.id)}">
<div class="row" style="justify-content:space-between"><b>${esc(x.name)}</b>${x.active ? '' : '<span class="pill">inactive</span>'}</div>
<div class="meta" style="margin-top:4px">${x.pools.length} location${x.pools.length === 1 ? '' : 's'}${x.email ? ' · ' + esc(x.email) : ''}${x.last_opened_at ? ' · opened ' + esc(x.last_opened_at.slice(0, 10)) : ' · never opened'}</div>
<div class="meta" style="margin-top:4px">${x.pools.map(p => esc(p.label || p.name)).join(', ') || '<span class="need-txt">no locations yet</span>'}</div>
<div class="actions"><button class="btn ghost small" data-copy="${esc(m.origin)}/wip/master/${esc(x.token)}" data-stop>Copy link</button><a class="btn ghost small" href="/wip/master/${esc(x.token)}" target="_blank" data-stop>Open</a><a class="btn ghost small" href="/wip/master/${esc(x.token)}/pdf" target="_blank" data-stop>PDF</a></div></div>`).join('');

  let right;
  if (!sel) {
    right = `<div class="card"><b>Pick a manager</b><div class="sub" style="margin-top:6px">Select a manager on the left to assign locations and manage their link.</div></div>`;
  } else {
    const assigned = new Set(sel.pools.map(p => p.pool_id));
    const list = m.locations.map(l => `<label class="chk" data-name="${esc(l.name.toLowerCase())}"><input type="checkbox" data-assign="${esc(l.id)}" ${l.pool_id && assigned.has(l.pool_id) ? 'checked' : ''}><span class="nm">${esc(l.name)}</span>${l.managers.filter(n => n !== sel.name).map(n => `<span class="pill">${esc(n)}</span>`).join('')}${l.owner_token ? `<button class="btn ghost small" data-copy="${esc(m.origin)}/wip/${esc(l.owner_token)}">Owner link</button>` : ''}</label>`).join('');
    right = `<div class="card"><div class="row"><input type="text" class="nm" value="${esc(sel.name)}" data-mgr-field="name" style="flex:1" aria-label="Manager name"><input type="text" value="${esc(sel.email || '')}" data-mgr-field="email" placeholder="email (optional)" style="flex:1"></div>
<div class="meta" style="margin-top:8px">Master link: <code>${esc(m.origin)}/wip/master/${esc(sel.token)}</code></div>
<div class="actions"><button class="btn ghost small" data-copy="${esc(m.origin)}/wip/master/${esc(sel.token)}">Copy link</button><a class="btn ghost small" href="/wip/master/${esc(sel.token)}" target="_blank">Open as manager</a><button class="btn ghost small" id="regen">New link</button><button class="btn ${sel.active ? 'danger' : 'ghost'} small" id="toggle-active">${sel.active ? 'Deactivate' : 'Activate'}</button></div></div>
<div class="card"><div class="row" style="justify-content:space-between"><b>Locations for ${esc(sel.name)}</b><span class="meta" id="assign-count">${sel.pools.length} assigned</span></div>
<input type="text" id="loc-search" placeholder="Search locations" style="margin:10px 0">
<div id="loc-list">${list}</div></div>`;
  }
  const unassigned = m.locations.filter(l => !l.managers.length);
  const body = `<div class="admin">
<div><div class="card"><b>Add a manager</b><div class="row" style="margin-top:10px"><input type="text" id="new-name" placeholder="Name" style="flex:1"><input type="text" id="new-email" placeholder="Email (optional)" style="flex:1"><button class="btn" id="new-btn">Add</button></div><div class="sub" style="margin-top:6px">A private master link is created for them — copy it from their card and send it.</div></div>
${mgrCards || '<div class="card">No managers yet.</div>'}</div>
<div>${right}
<div class="card"><b>Unassigned locations</b><span class="pill">${unassigned.length}</span><div class="meta" style="margin-top:6px">${unassigned.length ? unassigned.map(l => esc(l.name)).join(', ') : 'Every location has a manager.'}</div></div></div></div>`;

  const script = `
const A=${json(m.token)},SEL=${json(m.selected || null)};
document.addEventListener('click',async e=>{const c=e.target.closest('[data-copy]');if(c){e.preventDefault();e.stopPropagation();try{await navigator.clipboard.writeText(c.dataset.copy);const t=c.textContent;c.textContent='Copied ✓';setTimeout(()=>c.textContent=t,1500)}catch(x){prompt('Copy this link',c.dataset.copy)}return}
if(e.target.closest('[data-stop]'))return;const card=e.target.closest('[data-select]');if(card){location.search='?m='+card.dataset.select}});
document.getElementById('new-btn').onclick=async()=>{const name=document.getElementById('new-name').value.trim();if(!name)return;const r=await fetch('/wip/admin/'+A+'/managers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,email:document.getElementById('new-email').value.trim()||null})});const j=await r.json();if(!r.ok){alert(j.error||r.statusText);return}location.search='?m='+j.id};
if(SEL){
document.addEventListener('change',async e=>{const f=e.target.closest('[data-mgr-field]');if(f){await fetch('/wip/admin/'+A+'/managers/'+SEL,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({[f.dataset.mgrField]:f.value})});return}
const cb=e.target.closest('input[data-assign]');if(cb){cb.disabled=true;const r=await fetch('/wip/admin/'+A+'/managers/'+SEL+'/locations/'+cb.dataset.assign,{method:cb.checked?'POST':'DELETE'});cb.disabled=false;if(!r.ok){cb.checked=!cb.checked;alert(await r.text());return}
const n=document.querySelectorAll('input[data-assign]:checked').length;document.getElementById('assign-count').textContent=n+' assigned'}});
document.getElementById('loc-search').addEventListener('input',e=>{const v=e.target.value.toLowerCase();document.querySelectorAll('#loc-list .chk').forEach(x=>{x.style.display=!v||x.dataset.name.includes(v)?'':'none'})});
document.getElementById('regen').onclick=async()=>{if(!confirm('Make a new link? The old link stops working immediately.'))return;const r=await fetch('/wip/admin/'+A+'/managers/'+SEL+'/token',{method:'POST'});if(r.ok)location.reload();else alert(await r.text())};
document.getElementById('toggle-active').onclick=async()=>{const on=document.getElementById('toggle-active').textContent==='Activate';const r=await fetch('/wip/admin/'+A+'/managers/'+SEL,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({active:on})});if(r.ok)location.reload();else alert(await r.text())};}`;
  return { body, script, topbar };
}

module.exports = { CSS, renderMaster, renderAdmin, weekLabel };
