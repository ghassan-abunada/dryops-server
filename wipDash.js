// WIP manager dashboard + admin portal — pure HTML renderers in the DryOps
// world. Data is loaded in wip.js (loadDashboard / loadAdmin); these only turn
// a model into markup and the page script. ctx = { esc, json, q, help, whole,
// money, when } from wip.js.
//
// Manager page: one row per location with In Progress (jobs · $), Collecting
// next week (jobs · $), Bank balance (editable in the row) and AR. No totals
// across locations — each location is read on its own. Last week's money,
// forecast accuracy and estimate accuracy live in one collapsed section.

const CSS = `
  .wrap.wide{max-width:1280px}
  .pagerow{display:flex;align-items:center;gap:8px;margin:0 0 14px;min-height:48px;flex-wrap:wrap}
  .pagerow .pt{flex:1;min-width:200px;display:flex;flex-direction:column}.pagerow h2{margin:0;font-size:17px}.pagerow .meta{white-space:nowrap}
  .top .brand{display:none}.top .brand span{color:var(--hdrsub);font-weight:700;margin-left:8px}
  @media(min-width:900px){.top .brand{display:block}.top .ph{display:none}.pagerow{border-bottom:1px solid var(--line);padding-bottom:10px;margin:0 0 16px}}
  @media(max-width:899px){.pagerow .dk{display:none}}
  .tbl{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
  table.t{width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums}
  table.t th{font-weight:800;color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.5px;text-align:left;padding:10px 14px;border-bottom:1px solid var(--line);white-space:nowrap}
  table.t td{padding:12px 14px;border-bottom:1px solid var(--line);vertical-align:middle}table.t tr:last-child td{border-bottom:0}
  table.t .r,table.t th.r{text-align:right;white-space:nowrap}
  table.t tr.changed td{background:rgba(219,234,254,.35)}
  table.t td.amber{background:var(--amberbg)}
  .big{font-size:17px;font-weight:800;color:var(--ink)}.sm{display:block;font-size:12px;color:var(--mut);font-weight:600;margin-top:2px}
  ::placeholder{color:var(--mut);opacity:.85;font-weight:500}
  .loc{display:flex;align-items:center;gap:10px;min-width:0}.loc .nm{font-size:15px}
  .logo{height:28px;max-width:120px;object-fit:contain;flex:none}.logo.sm{height:22px;max-width:80px}
  .bankcell{display:flex;align-items:center;gap:6px}.bankcell .pre{color:var(--mut);font-weight:800}
  .bankcell input{width:128px;min-height:36px;padding:6px 10px;text-align:right;font-weight:700;font-variant-numeric:tabular-nums;font-size:15px;background:#fff}
  .bankcell input.empty{background:var(--amberbg);border-color:var(--amberline)}
  .acts{display:flex;gap:6px;flex-wrap:nowrap;justify-content:flex-end}
  .up{color:#15803D;font-weight:700}.down{color:var(--danger);font-weight:700}.flat{color:var(--mut)}
  .panels{display:grid;grid-template-columns:1fr;gap:12px;margin:10px 0 0}
  .panel{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin:0;min-width:0}
  .panel h3{display:flex;align-items:center;margin:0 0 10px}
  .bigs{display:flex;gap:18px;flex-wrap:wrap;margin-bottom:10px}.bigs>div>span{display:block;color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-weight:800}.bigs>div>b{font-size:20px;font-variant-numeric:tabular-nums}
  .rbar{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:12px 0 0}.rbar[hidden]{display:none}
  .rbar progress{width:100%;height:8px;border:0;border-radius:999px;overflow:hidden;background:#E2E8F0;margin-top:8px;-webkit-appearance:none;appearance:none}
  .rbar progress::-webkit-progress-bar{background:#E2E8F0;border-radius:999px}.rbar progress::-webkit-progress-value{background:var(--acc);border-radius:999px;transition:width .3s}.rbar progress::-moz-progress-bar{background:var(--acc)}
  .rbar.err progress::-webkit-progress-value{background:var(--danger)}.rbar .lbl2{font-size:13.5px}.rbar .pct{color:var(--mut);font-size:13px;margin-left:auto;font-variant-numeric:tabular-nums}
  .ticks{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.ticks span{font-size:12px;border:1px solid var(--line);border-radius:999px;padding:2px 9px;color:var(--mut)}.ticks span.done{border-color:#15803D;color:#15803D}.ticks span.cur{border-color:var(--ink);color:var(--ink)}.ticks span.fail{border-color:var(--danger);color:var(--danger)}
  .mob{display:none}
  .admin{display:grid;grid-template-columns:1fr;gap:14px}.mgr{cursor:pointer}.mgr.sel{border-color:var(--acc)}.mgr.off{opacity:.6}
  .chk{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line);min-height:44px}.chk:last-child{border-bottom:0}.chk input[type=checkbox]{width:22px;height:22px;flex:none;accent-color:var(--acc)}.chk .nm{flex:1;font-weight:600}
  .pill{display:inline-block;font-size:11px;font-weight:700;border:1px solid var(--line);border-radius:999px;padding:1px 8px;color:var(--mut);margin-left:6px;vertical-align:middle}
  @media(max-width:899px){
    .pagerow{flex-wrap:wrap}.pagerow h2{flex-basis:100%}
    table.t,table.t tbody{display:block;width:100%}
    table.t thead{display:none}table.t tr{display:block;padding:10px 0;border-bottom:1px solid var(--line)}table.t tr:last-child{border-bottom:0}
    table.t td{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:5px 14px;border:0;white-space:normal;min-width:0}table.t td::before{content:attr(data-l);font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:var(--mut);flex:none}
    table.t td.r{text-align:right}table.t td>div{min-width:0}table.t td:first-child::before{content:none}table.t td.a::before{content:none}
    .big{font-size:16px}.bankcell input{width:132px}
    .acts{flex-wrap:wrap;justify-content:flex-start}
  }
  @media(min-width:900px){.panels{grid-template-columns:1fr 1fr}.admin{grid-template-columns:380px 1fr}}
`;

function delta(v) {
  const n = Number(v || 0);
  if (!n) return '<span class="flat">—</span>';
  return `<span class="${n > 0 ? 'up' : 'down'}">${n > 0 ? '+' : '−'}$${Math.round(Math.abs(n)).toLocaleString('en-US')}</span>`;
}
function ratio(num, den) { return den ? (num / den).toFixed(2) + '×' : '—'; }
function shortDate(iso) {
  if (!iso) return '';
  return new Date(iso.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function weekLabel(w) { return `${shortDate(w.start)} – ${shortDate(w.end)}`; }

// ── Manager dashboard ─────────────────────────────────────────────────────────
function renderMaster(ctx, m) {
  const { esc, json, q, help, whole, when } = ctx;
  const base = `/wip/master/${esc(m.token)}`;
  const nw = weekLabel(m.week), lw = weekLabel(m.lastWeek);
  const meta = `${m.locations.length} location${m.locations.length === 1 ? '' : 's'} · week of ${esc(nw)}`;
  const topbar = `<div class="top"><div class="ttl"><h1 class="brand">DryOps <span>WIP</span></h1><h1 class="ph">WIP · ${esc(m.title)}</h1><div class="sub ph">${meta}</div></div></div>`;

  const rows = m.locations.map(l => {
    const missing = l.ipMissing + l.wcMissing;
    const changed = m.lastVisit && [l.lastUpdate, l.lastSent && l.lastSent.generated_at, l.lastReview && l.lastReview.reviewed_at].some(t => t && String(t) > String(m.lastVisit));
    return `<tr data-pool="${esc(l.id)}"${changed ? ' class="changed"' : ''}>
<td><div class="loc">${l.logo ? `<img class="logo sm" src="${esc(l.logo)}" alt="">` : ''}<div><span class="nm">${esc(l.label)}</span><span class="sm">${l.lastSent ? `sent ${esc(when(l.lastSent.generated_at))}${l.lastSent.generated_by ? ' by ' + esc(l.lastSent.generated_by) : ''}` : '<span class="need-txt">not sent this week</span>'}</span></div></div></td>
<td class="r${missing ? ' amber' : ''}" data-l="In Progress"><div><span class="big">${whole(l.ipTotal)}</span><span class="sm">${l.ipCount} job${l.ipCount === 1 ? '' : 's'}${missing ? ` · <span class="need-txt">${missing} need a number</span>` : ''}</span></div></td>
<td class="r" data-l="Collecting next week"><div><span class="big">${whole(l.cTotal)}</span><span class="sm">${l.cCount} job${l.cCount === 1 ? '' : 's'}</span></div></td>
<td class="r" data-l="Bank balance"><div class="bankcell"><span class="pre">$</span><input type="text" inputmode="decimal" pattern="[0-9.,]*" class="amt${l.bank ? '' : ' empty'}" id="bank-${esc(l.id)}" data-bank="${esc(l.id)}" value="${l.bank ? esc(l.bank.balance) : ''}" placeholder="type it" aria-label="Bank balance for ${esc(l.label)}"></div><span class="sm" id="bank-meta-${esc(l.id)}">${l.bank && l.bank.at ? `entered ${esc(when(l.bank.at, { time: false }))}${l.bank.by ? ' by ' + esc(l.bank.by) : ''}` : '<span class="need-txt">not entered</span>'}</span></td>
<td class="r" data-l="AR"><span class="big">${whole(l.arTotal)}</span></td>
<td class="r a"><div class="acts"><a class="btn ghost small" href="/wip/${esc(l.token)}" target="_blank">Open form</a><button class="btn ghost small" data-share="/wip/${esc(l.token)}/text" data-share-title="${esc(l.label)} WIP">Share</button><button class="btn ghost small" data-review="${esc(l.id)}">Review notes</button><a class="btn ghost small" href="${base}/pdf?pool_id=${esc(l.id)}" target="_blank">PDF</a>${m.scope === 'all' ? `<button class="btn ghost small" data-copy="${esc(m.origin)}/wip/${esc(l.token)}">Owner link</button><button class="btn danger small" data-remove="${esc(l.id)}">Remove</button>` : ''}</div></td>
</tr>`;
  }).join('');

  const table = `<div class="tbl"><table class="t">
<thead><tr><th>Location</th><th class="r">In Progress${q('ip')}</th><th class="r">Collecting next week${q('col')}</th><th class="r">Bank balance${q('bank')}</th><th class="r">AR${q('ar')}</th><th></th></tr></thead>
<tbody>${rows || `<tr><td colspan="6" class="flat">No locations yet${m.scope === 'all' ? ' — add one below.' : '.'}</td></tr>`}</tbody></table></div>
<div class="row" style="margin-top:8px;gap:0">${help('ip', 'What the owner says the jobs being worked on are worth, and how many of them still have no number.')}${help('col', 'Money the owner confirmed will arrive next week: invoiced jobs the Saturday review proposed plus out-of-pocket jobs marked "paying this week".')}${help('bank', "The balance the owner typed on their form. Type a corrected figure here and it saves as you leave the field.")}${help('ar', 'DryOps Open AR: approved-invoice balance on Invoice Created / Invoiced / Pending Payment jobs, every record type. Same number as the Dashboard.')}</div>`;

  const reviewBar = `<div class="rbar" id="review-bar" hidden><div class="row"><span class="lbl2" id="review-label">Starting…</span><span class="pct" id="review-pct"></span></div><progress id="review-prog" max="100" value="0"></progress><div class="ticks" id="review-ticks"></div></div><div id="review-out"></div>`;

  // Collapsed: last week and accuracy
  const T = m.totals, A = m.accuracy;
  const fcRows = m.locations.map(l => `<tr><td>${esc(l.label)}</td><td class="r">${l.forecast != null ? whole(l.forecast) : '<span class="flat">no forecast</span>'}</td><td class="r">${whole(l.collected)}</td><td class="r">${whole(l.invoiced)}</td><td class="r">${l.forecast != null ? delta(l.collected - l.forecast) : '<span class="flat">—</span>'}</td></tr>`).join('');
  let accBody;
  if (!A.available) accBody = `<div class="meta">Not tracking yet — run <b>supabase_wip_dashboard.sql</b> in Supabase to start recording owner estimates.</div>`;
  else if (!A.n) accBody = `<div class="meta">Fills in as valued jobs get invoiced. ${A.pending} job${A.pending === 1 ? '' : 's'} with an estimate still in progress.</div>`;
  else accBody = `<div class="bigs"><div><span>Jobs</span><b>${A.n}</b></div><div><span>Invoiced ÷ estimate</span><b>${ratio(A.inv, A.est)}</b></div><div><span>Collected ÷ estimate</span><b>${ratio(A.col, A.est)}</b></div><div><span>Median job</span><b>${A.medianInv != null ? A.medianInv.toFixed(2) + '×' : '—'}</b></div></div>
<table class="t"><thead><tr><th>Job</th><th class="r">Estimate</th><th class="r">Invoiced</th><th class="r">Collected</th><th class="r">Δ</th></tr></thead><tbody>${A.recent.map(r => `<tr><td>${esc(r.name)}<span class="sm">${esc(r.label)}${r.number ? ' · #' + esc(r.number) : ''}</span></td><td class="r" data-l="Estimate">${whole(r.est)}</td><td class="r" data-l="Invoiced">${whole(r.inv)}</td><td class="r" data-l="Collected">${whole(r.col)}</td><td class="r" data-l="Δ">${delta(r.inv - r.est)}</td></tr>`).join('')}</tbody></table>`;
  const insights = `<details class="sec" style="margin-top:14px"><summary><h3>Last week and accuracy</h3><span class="count">${esc(lw)}</span></summary>
<div class="panels">
<div class="panel"><h3>Last week · said vs came in${q('fc')}</h3>${help('fc', 'What each Collecting list said would come in last week (the last report saved before that Monday) versus the payments that posted, and the invoices created. Same definitions as the DryOps Stats screen.')}
<table class="t"><thead><tr><th>Location</th><th class="r">Said</th><th class="r">Came in</th><th class="r">Invoiced</th><th class="r">Δ</th></tr></thead><tbody>${fcRows || '<tr><td colspan="5" class="flat">No locations yet.</td></tr>'}</tbody></table>${T.forecastMissing ? `<div class="meta" style="margin-top:8px">${T.forecastMissing} location${T.forecastMissing === 1 ? '' : 's'} had no report saved before last Monday; the Saturday review saves one from now on.</div>` : ''}</div>
<div class="panel"><h3>Estimate accuracy${q('acc')}</h3>${help('acc', 'For jobs that owners valued while In Progress and that have since been invoiced: what was invoiced and collected compared with the estimate. Above 1× means owners under-estimate.')}${accBody}</div>
</div></details>`;

  const addCard = m.scope === 'all' ? `<div class="card" style="margin-top:14px"><b>Add a location</b><div class="row" style="margin-top:10px"><select id="add-loc" style="flex:1;min-width:220px"><option value="">Choose a location…</option>${m.options.map(l => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('')}</select><button class="btn ghost" id="add-btn">Add</button></div></div>` : '';

  const body = `
<div class="pagerow"><div class="pt"><h2 class="dk">WIP · ${esc(m.title)}</h2><span class="meta">${meta} · ${esc(m.today)}</span></div><button class="btn ghost small" id="review-all">Review all AR notes</button><a class="btn ghost small" href="${base}/text" target="_blank">Combined text</a><a class="btn ghost small" href="${base}/pdf" target="_blank">PDF</a><button class="btn small" data-share="${base}/text" data-share-title="WIP — ${esc(m.title)}">Share all</button></div>
${table}
${reviewBar}
<div class="meta" style="margin:12px 2px 0">“Review notes” reads each invoiced job's JobNimbus notes from the last 5 weeks and proposes what should actually arrive next week; owners confirm on their form. ${m.weeklyReview.enabled ? `It runs by itself every <b>Saturday at ${esc(m.weeklyReview.hourLabel)} Central</b>.` : 'The automatic Saturday run is switched off.'}${m.anthropic ? '' : ' <b>ANTHROPIC_API_KEY is not set on the server, so it will fail until it is.</b>'}</div>
${insights}
${addCard}`;

  const script = `
const M=${json(m.token)};const CHECK='<svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"m5 12.5 4.5 4.5L19 7\"/></svg>',CROSS='<svg width=\"12\" height=\"12\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.6\" stroke-linecap=\"round\" aria-hidden=\"true\"><path d=\"M6 6l12 12M18 6 6 18\"/></svg>';
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function num(v){if(v==null||v==='')return null;const n=Number(String(v).replace(/[^0-9.]/g,''));return isNaN(n)?null:n}
${m.scope === 'all' ? `document.getElementById('add-btn').onclick=async()=>{const id=document.getElementById('add-loc').value;if(!id)return;const r=await fetch('/wip/master/'+M+'/locations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location_id:id})});if(r.ok)location.reload();else alert(await r.text())};` : ''}
document.addEventListener('click',async e=>{const c=e.target.closest('[data-copy]');if(c){try{await navigator.clipboard.writeText(c.dataset.copy);const t=c.textContent;c.innerHTML='Copied '+CHECK;setTimeout(()=>c.textContent=t,1500)}catch(x){prompt('Copy this link',c.dataset.copy)}return}
const r=e.target.closest('[data-remove]');if(r){if(!confirm('Remove this location from the pool? Owner values are kept.'))return;const x=await fetch('/wip/master/'+M+'/locations/'+r.dataset.remove,{method:'DELETE'});if(x.ok)location.reload();else alert(await x.text())}});
// Bank balance per location, saved when the field is left (or after a pause).
const bankTimers={};
function saveBank(i){const id=i.dataset.bank;const meta=document.getElementById('bank-meta-'+id);const v=num(i.value);if(String(v==null?'':v)===String(i.dataset.saved==null?num(i.defaultValue)==null?'':num(i.defaultValue):i.dataset.saved))return;i.dataset.saved=v==null?'':v;meta.textContent='saving…';
return fetch('/wip/master/'+M+'/locations/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({bank_balance:v})}).then(async r=>{if(!r.ok)throw new Error(await r.text());i.classList.toggle('empty',v==null);meta.innerHTML=v==null?'<span class="need-txt">not entered</span>':'saved just now'}).catch(x=>{meta.innerHTML='<span class="need-txt">could not save — try again</span>'})}
document.addEventListener('input',e=>{const i=e.target.closest('input[data-bank]');if(!i)return;clearTimeout(bankTimers[i.dataset.bank]);bankTimers[i.dataset.bank]=setTimeout(()=>saveBank(i),900)});
document.addEventListener('focusout',e=>{const i=e.target.closest&&e.target.closest('input[data-bank]');if(!i)return;clearTimeout(bankTimers[i.dataset.bank]);saveBank(i)});
// AI review: start, then poll the progress bar.
const bar=document.getElementById('review-bar'),lbl=document.getElementById('review-label'),pctEl=document.getElementById('review-pct'),prog=document.getElementById('review-prog'),ticks=document.getElementById('review-ticks'),out=document.getElementById('review-out');
const PH={loading:'loading jobs',notes:'reading JobNimbus notes',deciding:'deciding what will arrive next week',saving:'saving'};
function paint(s){const total=s.total||1;const frac=(s.done+(s.phase_frac||0))/total;prog.value=Math.round(frac*100);pctEl.textContent=s.done+' of '+s.total+' location'+(s.total===1?'':'s');
lbl.textContent=s.finished?(s.error?'The review could not run — '+s.error:'Done — '+(s.done-(s.failed||0))+' location'+(s.done-(s.failed||0)===1?'':'s')+' reviewed'+(s.failed?', '+s.failed+' could not be reviewed':'')):'Reviewing '+(s.current||'')+(s.phase?' · '+(PH[s.phase]||s.phase)+(s.phase==='notes'&&s.jobs!=null?' for '+s.jobs+' job'+(s.jobs===1?'':'s'):''):'');
ticks.innerHTML=(s.items||[]).map(t=>'<span class="'+t.state+'">'+esc(t.label)+(t.state==='done'?' '+CHECK:t.state==='fail'?' '+CROSS:'')+'</span>').join('');bar.classList.toggle('err',!!s.error||(s.finished&&!!s.failed))}
function renderResults(results){const lab={collecting:'Collecting',received:'Received — post the payment',not_yet:'Not this week'};
out.innerHTML=results.map(x=>'<div class="card" style="margin-top:12px"><b>'+esc(x.label)+'</b><div class="meta">'+(x.error?'<span class="need-txt">could not be reviewed — '+esc(x.error)+'</span>':x.jobs_reviewed+' invoiced jobs read, '+x.applied+' proposed'+(x.skipped_owner&&x.skipped_owner.length?', '+x.skipped_owner.length+' already answered by the owner':''))+'</div>'+(x.jobs&&x.jobs.length?'<div class="list" style="margin-top:8px">'
+x.jobs.map(d=>'<div><div class="row" style="justify-content:space-between"><span class="nm" style="font-size:15px">'+esc(d.name)+'</span><b>'+(d.amount!=null?'$'+Number(d.amount).toLocaleString('en-US',{minimumFractionDigits:2}):'')+'</b></div><div class="meta"><b>'+esc(lab[d.decision]||d.decision)+'</b>'+(d.owner_set?' · owner already answered':'')+' — '+esc(d.reason)+'</div></div>').join('')+'</div>':'')+'</div>').join('')+'<div class="actions" style="margin-top:12px"><button class="btn" onclick="location.reload()">Reload the table</button></div>'}
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
  const { esc, json, when } = ctx;
  const sel = m.managers.find(x => x.id === m.selected) || null;
  const topbar = `<div class="top"><div class="ttl"><h1>WIP · managers</h1><div class="sub">${m.managers.length} manager${m.managers.length === 1 ? '' : 's'} · ${m.locations.length} locations</div></div><a class="btn ghost small" href="/wip/master/${esc(m.masterToken)}" target="_blank">All locations</a></div>`;
  const mgrCards = m.managers.map(x => `<div class="card mgr${x.id === m.selected ? ' sel' : ''}${x.active ? '' : ' off'}" data-select="${esc(x.id)}" tabindex="0" role="button">
<div class="row" style="justify-content:space-between"><b>${esc(x.name)}</b>${x.active ? '' : '<span class="pill">inactive</span>'}</div>
<div class="meta" style="margin-top:4px">${x.pools.length} location${x.pools.length === 1 ? '' : 's'}${x.email ? ' · ' + esc(x.email) : ''}${x.last_opened_at ? ' · opened ' + esc(when(x.last_opened_at, { time: false })) : ' · never opened'}</div>
<div class="meta" style="margin-top:4px">${x.pools.map(p => esc(p.label || p.name)).join(', ') || '<span class="need-txt">no locations yet</span>'}</div>
<div class="actions"><button class="btn ghost small" data-copy="${esc(m.origin)}/wip/master/${esc(x.token)}" data-stop>Copy link</button><a class="btn ghost small" href="/wip/master/${esc(x.token)}" target="_blank" data-stop>Open</a><a class="btn ghost small" href="/wip/master/${esc(x.token)}/pdf" target="_blank" data-stop>PDF</a></div></div>`).join('');

  let right;
  if (!sel) {
    right = `<div class="card"><b>Pick a manager</b><div class="sub" style="margin-top:6px">Select a manager on the left to assign locations and manage their link.</div></div>`;
  } else {
    const assigned = new Set(sel.pools.map(p => p.pool_id));
    const list = m.locations.map(l => `<label class="chk" data-name="${esc(l.name.toLowerCase())}"><input type="checkbox" data-assign="${esc(l.id)}" ${l.pool_id && assigned.has(l.pool_id) ? 'checked' : ''}><span class="nm">${esc(l.name)}</span>${l.managers.filter(n => n !== sel.name).map(n => `<span class="pill">${esc(n)}</span>`).join('')}${l.owner_token ? `<button type="button" class="btn ghost small" data-copy="${esc(m.origin)}/wip/${esc(l.owner_token)}">Owner link</button>` : ''}</label>`).join('');
    right = `<div class="card"><div class="row"><input type="text" class="nm" value="${esc(sel.name)}" data-mgr-field="name" style="flex:1" aria-label="Manager name"><input type="text" value="${esc(sel.email || '')}" data-mgr-field="email" placeholder="email (optional)" style="flex:1" aria-label="Manager email"></div>
<div class="meta" style="margin-top:8px">Master link: <code>${esc(m.origin)}/wip/master/${esc(sel.token)}</code></div>
<div class="actions"><button class="btn ghost small" data-copy="${esc(m.origin)}/wip/master/${esc(sel.token)}">Copy link</button><a class="btn ghost small" href="/wip/master/${esc(sel.token)}" target="_blank">Open as manager</a><button class="btn ghost small" id="regen">New link</button><button class="btn ${sel.active ? 'danger' : 'ghost'} small" id="toggle-active">${sel.active ? 'Deactivate' : 'Activate'}</button></div></div>
<div class="card"><div class="row" style="justify-content:space-between"><b>Locations for ${esc(sel.name)}</b><span class="meta" id="assign-count">${sel.pools.length} assigned</span></div>
<input type="text" id="loc-search" placeholder="Search locations" style="margin:10px 0" aria-label="Search locations">
<div id="loc-list">${list}</div></div>`;
  }
  const body = `<div class="admin">
<div><div class="card"><b>Add a manager</b><div class="row" style="margin-top:10px"><input type="text" id="new-name" placeholder="Name" style="flex:1" aria-label="Manager name"><input type="text" id="new-email" placeholder="Email" style="flex:1" aria-label="Manager email (optional)"><button class="btn" id="new-btn">Add</button></div><div class="sub" style="margin-top:6px">A private master link is created for them — copy it from their card and send it.</div></div>
${mgrCards || '<div class="card">No managers yet.</div>'}</div>
<div>${right}</div></div>`;

  const script = `
const A=${json(m.token)},SEL=${json(m.selected || null)};const CHECK='<svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"m5 12.5 4.5 4.5L19 7\"/></svg>';
document.addEventListener('click',async e=>{const c=e.target.closest('[data-copy]');if(c){e.preventDefault();e.stopPropagation();try{await navigator.clipboard.writeText(c.dataset.copy);const t=c.textContent;c.innerHTML='Copied '+CHECK;setTimeout(()=>c.textContent=t,1500)}catch(x){prompt('Copy this link',c.dataset.copy)}return}
if(e.target.closest('[data-stop]'))return;const card=e.target.closest('[data-select]');if(card){location.search='?m='+card.dataset.select}});
document.addEventListener('keydown',e=>{if(e.key!=='Enter')return;const card=e.target.closest&&e.target.closest('[data-select]');if(card&&e.target===card)location.search='?m='+card.dataset.select});
document.getElementById('new-btn').onclick=async()=>{const name=document.getElementById('new-name').value.trim();if(!name)return;const r=await fetch('/wip/admin/'+A+'/managers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,email:document.getElementById('new-email').value.trim()||null})});const j=await r.json();if(!r.ok){alert(j.error||r.statusText);return}location.search='?m='+j.id};
if(SEL){
document.addEventListener('change',async e=>{const f=e.target.closest('[data-mgr-field]');if(f){await fetch('/wip/admin/'+A+'/managers/'+SEL,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({[f.dataset.mgrField]:f.value})});return}
const cb=e.target.closest('input[data-assign]');if(cb){cb.disabled=true;const r=await fetch('/wip/admin/'+A+'/managers/'+SEL+'/locations/'+cb.dataset.assign,{method:cb.checked?'POST':'DELETE'});cb.disabled=false;if(!r.ok){cb.checked=!cb.checked;alert(await r.text());return}
const n=document.querySelectorAll('input[data-assign]:checked').length;document.getElementById('assign-count').textContent=n+' assigned'}});
document.getElementById('loc-search').addEventListener('input',e=>{const v=e.target.value.toLowerCase();document.querySelectorAll('#loc-list .chk').forEach(x=>{x.style.display=!v||x.dataset.name.includes(v)?'':'none'})});
document.getElementById('regen').onclick=async()=>{if(!confirm('Make a new link? The old link stops working immediately.'))return;const r=await fetch('/wip/admin/'+A+'/managers/'+SEL+'/token',{method:'POST'});if(r.ok)location.reload();else alert(await r.text())};
document.getElementById('toggle-active').onclick=async()=>{const on=document.getElementById('toggle-active').textContent==='Activate';if(!on&&!confirm('Deactivate this manager? Their link stops working until you activate them again.'))return;const r=await fetch('/wip/admin/'+A+'/managers/'+SEL,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({active:on})});if(r.ok)location.reload();else alert(await r.text())};}`;
  return { body, script, topbar };
}

module.exports = { CSS, renderMaster, renderAdmin, weekLabel };
