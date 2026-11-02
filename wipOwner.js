// WIP owner form — pure HTML renderer. Three steps on one page (job values →
// verify Collecting → bank + send), phone first, in the DryOps world. Data is
// loaded in wip.js (loadLocation); this only turns a model into markup and the
// page script. ctx = { esc, json, q, help, whole, money, when } from wip.js.

function renderOwner(ctx, m) {
  const { esc, json, q, help, whole } = ctx;
  const textUrl = `/wip/${esc(m.token)}/text`;
  const topbar = `<div class="top">${m.logo ? `<img class="logo" src="${esc(m.logo)}" alt="">` : ''}<div class="ttl"><h1>${esc(m.label)}</h1><div class="sub" id="step-sub">Step 1 of 3 · Job values<span class="nxt"> · then Collecting, then Bank</span></div></div><div class="steps" aria-hidden="true"><span class="on" data-step="1"></span><span data-step="2"></span><span data-step="3"></span></div></div>`;

  const body = `
<section class="step" data-step="1">
  <h2>What is each job worth?${q('s1')}</h2>
  <div class="lead">A rough number is fine. Jobs with no number are amber.</div>
  ${help('s1', 'Every job we are working on (including Work Complete until it is invoiced). Type what you think the job is worth. Flip "paying this week" on an out-of-pocket job that will pay before Sunday — it goes under Collecting too.')}
  <div id="list-ip"></div>
  <details class="sec" id="sec-other"><summary><h3>Other jobs</h3><span class="count" id="n-other">0</span></summary>
    <div class="help on">Finished jobs not invoiced yet, holds, and jobs you hid. Type a value only if you want one counted.</div>
    <div id="list-other"></div></details>
</section>
<section class="step" data-step="2" hidden>
  <h2>What's coming in this week?${q('s2')}</h2>
  <div class="lead">Saturday's review read the JobNimbus notes. Confirm or change each one.</div>
  ${help('s2', 'Collecting means money that will actually arrive this week. A mailed insurance check takes 10–14 business days from the day it was issued. Tap Yes to keep the amount, change it, or say Not this week.')}
  <div id="list-col"></div>
  <details class="sec" id="sec-ar"><summary><h3>Other invoiced jobs</h3><span class="count" id="n-ar">0</span></summary>
    <div class="help on">Not expected this week. Type an amount if you know one is paying.</div>
    <div id="list-ar"></div></details>
</section>
<section class="step" data-step="3" hidden>
  <h2>Bank balance and send${q('s3')}</h2>
  ${help('s3', "Today's balance from your bank app. Then check the text below — it is exactly what gets sent.")}
  <div class="card">
    <label class="lbl" for="bank">Bank Balance today</label>
    <div class="amt-row"><span class="pre">$</span><input type="text" inputmode="decimal" pattern="[0-9.,]*" class="amt" id="bank" value="${m.bank ? esc(m.bank.balance) : ''}" placeholder="type it"></div>
    <div class="meta" id="bank-meta">${m.bank && m.bank.at ? `entered ${esc(m.bankWhen)}${m.bank.by ? ' by ' + esc(m.bank.by) : ''}` : '<span class="need-txt">please type today&#39;s balance</span>'}</div>
    <label class="lbl" for="who" style="margin-top:14px">Your name</label>
    <input type="text" id="who" placeholder="So we know who sent it" autocomplete="name">
  </div>
  <div class="card"><div class="row" style="justify-content:space-between;align-items:baseline"><b>The text you'll send</b><span class="meta" id="sent-meta">${m.lastSent ? `last sent ${esc(m.lastSent)}` : 'not sent yet this week'}</span></div>
    <pre id="preview" class="preview">Loading…</pre></div>
</section>
<div class="bar">
  <div class="status" id="status"><b id="bar-k">In Progress</b><span id="bar-v">$0</span></div>
  <button class="btn ghost" id="back" hidden>Back</button>
  <button class="btn" id="next">Next</button>
</div>
<div class="sheet" id="add-sheet"><div><b>Add a job that isn't on the list</b><div class="sub" style="margin-top:6px">Only for jobs that aren't in JobNimbus yet.</div><div class="actions" style="margin-top:12px"><button class="btn" data-add="in_progress">In Progress</button><button class="btn ghost" data-add="collecting">Collecting</button></div></div></div>`;

  const script = `
const TOKEN=${json(m.token)},TEXT_URL=${json(textUrl)};let ROWS=${json(m.rows)};const ORDER=${json(m.weekLabel)};
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
const CHECK='<svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"m5 12.5 4.5 4.5L19 7\"/></svg>';
function fmt(n){return '$'+Math.round(n||0).toLocaleString('en-US')}
function num(v){if(v==null||v==='')return null;const n=Number(String(v).replace(/[^0-9.]/g,''));return isNaN(n)?null:n}
function money2(n){return n==null?'':Number(n).toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:2})}
let STEP=1;const who=document.getElementById('who');try{who.value=localStorage.getItem('wip_who')||''}catch(e){}
who.addEventListener('change',()=>{try{localStorage.setItem('wip_who',who.value)}catch(e){}});
// ── Row maths ────────────────────────────────────────────────────────────────
function isIp(r){return r.group==='in_progress'&&!r.custom}
function counted(r){return r.category==='in_progress'}
function collecting(r){return r.category==='collecting'?(r.amount!=null?r.amount:(r.due||0)):(r.collect_amount!=null?r.collect_amount:null)}
function totals(){let ip=0,c=0,ni=0,nc=0,need=0;for(const r of ROWS){if(counted(r)){ip+=Number(r.amount||0);ni++;if(r.amount==null)need++}const cv=collecting(r);if(cv!=null){c+=Number(cv);nc++}}return{ip,c,ni,nc,need}}
// ── Cards ───────────────────────────────────────────────────────────────────
function tag(r){return (r.oop?'<span class="tag oop">OOP</span>':'')+(r.status==='Work Complete'?'<span class="tag">Complete</span>':'')}
function ipCard(r){const need=counted(r)&&r.amount==null;
return '<div class="job is-ip'+(need?' need':'')+(counted(r)?'':' off')+'" data-card="'+esc(r.key)+'"><div class="job-head"><div class="nm">'+(r.custom?'<input type="text" class="nm" value="'+esc(r.name)+'" data-k="'+esc(r.key)+'" data-f="custom_name" placeholder="Customer name">':esc(r.name))+tag(r)+'</div><div class="meta">'+esc(r.status)+(r.createdLabel?' · started '+esc(r.createdLabel):'')+'</div></div>'
+(counted(r)?'<div class="amt-row"><span class="pre">$</span><input type="text" inputmode="decimal" pattern="[0-9.,]*" class="amt" data-k="'+esc(r.key)+'" data-f="amount" value="'+esc(money2(r.amount))+'" placeholder="What is this job worth?"></div>'
+(r.oop?'<label class="sw"><span>Paying this week? Put it under Collecting</span><input type="checkbox" data-k="'+esc(r.key)+'" data-f="paying" '+(r.collect_amount!=null?'checked':'')+'><span class="tog"></span></label>'+(r.collect_amount!=null?'<div class="amt-row"><span class="pre">$</span><input type="text" inputmode="decimal" pattern="[0-9.,]*" class="amt" data-k="'+esc(r.key)+'" data-f="collect_amount" value="'+esc(money2(r.collect_amount))+'" placeholder="How much this week?"></div>':''):'')
+(r.note?'<input type="text" class="nt" data-k="'+esc(r.key)+'" data-f="note" value="'+esc(r.note)+'" placeholder="Note">':'')
+'<div class="rowbtns">'+(r.custom?'<button class="lnk" data-del="'+esc(r.key)+'">Remove</button>':'<button class="lnk" data-hide="'+esc(r.key)+'">Not ours now</button>')+'</div>'
:'<div class="rowbtns"><span class="meta">not counted</span><button class="lnk" data-restore="'+esc(r.key)+'">Count it</button></div>')+'</div>'}
function otherCard(r){const on=counted(r);
return '<div class="job'+(on?' is-ip':'')+'" data-card="'+esc(r.key)+'"><div class="job-head"><div class="nm">'+esc(r.name)+tag(r)+'</div><div class="meta">'+esc(r.status)+(r.group==='in_progress'?' · hidden':'')+'</div></div>'
+(r.group==='in_progress'?'<div class="rowbtns"><button class="btn small ghost" data-restore="'+esc(r.key)+'">Count it</button></div>':'<div class="amt-row"><span class="pre">$</span><input type="text" inputmode="decimal" pattern="[0-9.,]*" class="amt" data-k="'+esc(r.key)+'" data-f="amount" value="'+esc(money2(r.amount))+'" placeholder="Leave blank, or type a value"></div>')+'</div>'}
function colCard(r){const yes=r.category==='collecting';const lit=r.lit&&!yes&&r.ai_decision==='collecting';
const amt=r.category==='collecting'?(r.amount!=null?r.amount:r.due):(r.ai_amount!=null?r.ai_amount:r.due);
return '<div class="job is-col'+(lit?' lit':'')+(yes?'':' maybe')+'" data-card="'+esc(r.key)+'"><div class="job-head"><div class="nm">'+esc(r.name)+'</div><div class="meta">'+esc(r.status)+(r.due!=null?' · they owe '+fmt(r.due):'')+'</div>'+(r.ai_reason?'<div class="says">Notes say: '+esc(r.ai_reason)+'</div>':'')+'</div>'
+'<div class="amt-row"><span class="pre">$</span><input type="text" inputmode="decimal" pattern="[0-9.,]*" class="amt" data-k="'+esc(r.key)+'" data-f="amount" value="'+esc(money2(yes?amt:null))+'" placeholder="'+esc(amt!=null?'Yes = '+fmt(amt):'How much this week?')+'"></div>'
+'<div class="rowbtns"><button class="btn small'+(yes?' on':'')+'" data-yes="'+esc(r.key)+'" data-amt="'+esc(amt!=null?amt:'')+'">'+(yes?'Yes '+CHECK:'Yes')+'</button><button class="btn small ghost'+(!yes&&r.answered?' on':'')+'" data-no="'+esc(r.key)+'">Not this week</button></div>'
+(r.note?'<input type="text" class="nt" data-k="'+esc(r.key)+'" data-f="note" value="'+esc(r.note)+'" placeholder="Note">':'')+'</div>'}
function oopColCard(r){return '<div class="job is-col" data-card="'+esc(r.key)+'"><div class="job-head"><div class="nm">'+esc(r.name)+tag(r)+'</div><div class="meta">paying this week · set in step 1</div></div><div class="amt-row"><span class="pre">$</span><input type="text" inputmode="decimal" pattern="[0-9.,]*" class="amt" data-k="'+esc(r.key)+'" data-f="collect_amount" value="'+esc(money2(r.collect_amount))+'" placeholder="How much this week?"></div></div>'}
function render(){
const ip=ROWS.filter(r=>isIp(r)&&counted(r)).concat(ROWS.filter(r=>r.custom&&r.category==='in_progress'));
const other=ROWS.filter(r=>(isIp(r)&&!counted(r))||r.group==='billing'||r.group==='other');
document.getElementById('list-ip').innerHTML=ip.map(ipCard).join('')||'<div class="card meta">No jobs in progress right now.</div>';
document.getElementById('list-other').innerHTML=other.map(otherCard).join('');document.getElementById('n-other').textContent=other.length;
const prop=ROWS.filter(r=>r.group==='ar'&&(r.category==='collecting'||r.ai_decision==='collecting'||r.answered));
const rest=ROWS.filter(r=>r.group==='ar'&&!prop.includes(r));
const oop=ROWS.filter(r=>counted(r)&&r.collect_amount!=null).concat(ROWS.filter(r=>r.custom&&r.category==='collecting'));
document.getElementById('list-col').innerHTML=prop.map(colCard).join('')+oop.map(oopColCard).join('')||'<div class="card meta">Nothing proposed for this week. Open "Other invoiced jobs" if one is paying.</div>';
document.getElementById('list-ar').innerHTML=rest.map(colCard).join('');document.getElementById('n-ar').textContent=rest.length;
bar()}
function bar(){const t=totals();const k=document.getElementById('bar-k'),v=document.getElementById('bar-v');
if(STEP===1){k.textContent='In Progress';v.innerHTML=fmt(t.ip)+(t.need?' · <span class="need-txt">'+t.need+' need a number</span>':'')}
else if(STEP===2){k.textContent='Collecting';v.textContent=fmt(t.c)+' · '+t.nc+(t.nc===1?' job':' jobs')}
else{k.textContent='Ready';v.textContent=document.getElementById('bank').value?'bank balance in':'bank balance missing'}}
function go(n){STEP=n;document.querySelectorAll('.step').forEach(s=>s.hidden=Number(s.dataset.step)!==n);
document.querySelectorAll('.steps span').forEach(s=>s.classList.toggle('on',Number(s.dataset.step)<=n));
document.getElementById('step-sub').innerHTML=['','Step 1 of 3 · Job values<span class="nxt"> · then Collecting, then Bank</span>','Step 2 of 3 · Collecting<span class="nxt"> · then Bank and send</span>','Step 3 of 3 · Bank and send'][n];
document.getElementById('back').hidden=n===1;document.getElementById('next').textContent=n===3?'Send':'Next';window.scrollTo(0,0);bar();if(n===3)preview()}
async function preview(){const p=document.getElementById('preview');try{const r=await fetch(TEXT_URL+'?preview=1',{cache:'no-store'});p.textContent=await r.text()}catch(e){p.textContent='Could not load the preview. Try again in a moment.'}}
document.getElementById('next').onclick=async()=>{if(STEP<3){go(STEP+1);return}
await flush(true);let text='';try{const r=await fetch(TEXT_URL+'?by='+encodeURIComponent(who.value||''),{cache:'no-store'});text=await r.text()}catch(e){setStatus('Could not build the report. Try again.',true);return}
const stamp=new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
function sent(){document.getElementById('sent-meta').textContent='sent '+stamp;document.getElementById('bar-k').textContent='Sent';document.getElementById('bar-v').textContent=stamp;const n=document.getElementById('next');n.className='btn ghost';n.textContent='Sent '+stamp+' · Send again'}
if(navigator.share){try{await navigator.share({title:'WIP — '+${json(m.label)},text});sent();return}catch(e){if(e&&e.name==='AbortError')return}}
shareFallback(text);sent()};
document.getElementById('back').onclick=()=>go(STEP-1);
// ── Saving ──────────────────────────────────────────────────────────────────
const st=document.getElementById('status');let saveNote=null;
function setStatus(msg,err){if(!saveNote){saveNote=document.createElement('div');saveNote.className='savenote';document.body.appendChild(saveNote)}saveNote.textContent=msg;saveNote.className='savenote'+(err?' err':' ok');clearTimeout(saveNote._t);if(!err)saveNote._t=setTimeout(()=>saveNote.className='savenote',1800)}
const dirty=new Map();let timer=null;
function queue(key){const r=ROWS.find(x=>x.key===key);dirty.set(key,{key,category:r.category,amount:r.amount,collect_amount:r.collect_amount,note:r.note,custom_name:r.custom?r.name:undefined});clearTimeout(timer);timer=setTimeout(flush,700)}
async function flush(sync){const entries=[...dirty.values()];dirty.clear();if(!entries.length)return;
try{const r=await fetch('/wip/'+TOKEN+'/entries',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({entries,updated_by:who.value||null}),keepalive:!!sync});if(!r.ok)throw new Error('save');setStatus('Saved')}
catch(e){entries.forEach(x=>dirty.set(x.key,x));setStatus("Couldn't save — tap to retry",true);saveNote.onclick=()=>{saveNote.onclick=null;flush()}}}
document.addEventListener('input',e=>{const i=e.target;if(!i.dataset||!i.dataset.f)return;const r=ROWS.find(x=>x.key===i.dataset.k);if(!r)return;
if(i.dataset.f==='amount'){r.amount=num(i.value);if(r.group==='ar'){r.category=r.amount!=null?'collecting':r.category;r.answered=true}else if(r.group==='billing'||r.group==='other'){r.category=r.amount!=null?'in_progress':null}const c=i.closest('[data-card]');if(c)c.classList.toggle('need',counted(r)&&r.amount==null)}
else if(i.dataset.f==='collect_amount'){r.collect_amount=num(i.value)}else if(i.dataset.f==='note'){r.note=i.value}else if(i.dataset.f==='custom_name'){r.name=i.value}
bar();queue(r.key)});
document.addEventListener('change',e=>{const i=e.target;if(i.dataset&&i.dataset.f==='paying'){const r=ROWS.find(x=>x.key===i.dataset.k);r.collect_amount=i.checked?(r.collect_amount!=null?r.collect_amount:(r.amount!=null?r.amount:0)):null;render();queue(r.key);const el=document.querySelector('input[data-k="'+r.key+'"][data-f="collect_amount"]');if(el)el.focus()}});
document.addEventListener('click',e=>{const t=e.target.closest('button,a');if(!t)return;
const key=t.dataset.hide||t.dataset.restore||t.dataset.yes||t.dataset.no||t.dataset.note||t.dataset.del;const r=key&&ROWS.find(x=>x.key===key);
if(t.dataset.hide){r.category=null;render();queue(key)}
else if(t.dataset.restore){r.category='in_progress';render();queue(key)}
else if(t.dataset.yes){r.category='collecting';r.amount=t.dataset.amt!==''?Number(t.dataset.amt):r.due;r.answered=true;render();queue(key)}
else if(t.dataset.no){r.category=null;r.amount=null;r.answered=true;render();queue(key)}
else if(t.dataset.note){r.note=' ';render();const el=document.querySelector('input[data-k="'+key+'"][data-f="note"]');if(el){el.value='';el.focus()}}
else if(t.dataset.del){fetch('/wip/'+TOKEN+'/entries/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key})}).then(()=>{ROWS=ROWS.filter(x=>x.key!==key);render()})}
else if(t.dataset.add){document.getElementById('add-sheet').classList.remove('open');const k='custom:'+crypto.randomUUID();ROWS.push({key:k,name:'',status:'Added by you',group:'custom',category:t.dataset.add,amount:null,collect_amount:null,note:'',custom:true});render();queue(k);const el=document.querySelector('input[data-k="'+k+'"][data-f="custom_name"]');if(el)el.focus()}});
document.getElementById('add-sheet').addEventListener('click',e=>{if(e.target.id==='add-sheet')e.target.classList.remove('open')});
const bankEl=document.getElementById('bank');let bankTimer=null;
bankEl.addEventListener('input',()=>{clearTimeout(bankTimer);bar();bankTimer=setTimeout(async()=>{try{const v=num(bankEl.value);const r=await fetch('/wip/'+TOKEN+'/bank',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({balance:v,updated_by:who.value||null})});if(!r.ok)throw new Error('save');
document.getElementById('bank-meta').textContent=v==null?'not entered yet':'entered today'+(who.value?' by '+who.value:'');setStatus('Saved')}catch(e){setStatus("Couldn't save the bank balance — tap to retry",true);saveNote.onclick=()=>{saveNote.onclick=null;bankEl.dispatchEvent(new Event('input'))}}},700)});
window.addEventListener('beforeunload',()=>{if(dirty.size)flush(true)});
render();`;
  return { body, script, topbar };
}

module.exports = { renderOwner };
