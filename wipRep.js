// WIP sales-rep page — pure HTML renderer. One person's in-progress jobs
// (JobNimbus sales rep) across the locations on their link, grouped by
// location, job values only. Uses the owner form's styles (wip.js CSS).
// ctx = { esc, json, q, help } from wip.js; m = { token, name, groups, weekLabel }.

function renderRep(ctx, m) {
  const { esc, json, q, help } = ctx;
  const total = m.groups.reduce((n, g) => n + g.rows.length, 0);
  const topbar = `<div class="top"><div class="ttl"><h1>${esc(m.name)}</h1><div class="sub">Job values · week of ${esc(m.weekLabel)}</div></div></div>`;
  const sections = m.groups.filter(g => g.rows.length).map(g =>
    `<h3 style="display:flex;gap:8px;align-items:center;margin:18px 2px 8px">${esc(g.label)} <span class="count">${g.rows.length}</span></h3><div data-loc="${esc(g.pool.location_id)}"></div>`).join('');
  const body = `
<section class="step">
  <h2>What is each job worth?${q('rep')}</h2>
  <div class="lead">Your jobs where you're the sales rep. A rough number is fine. Jobs with no number are amber. It saves as you type.</div>
  ${help('rep', 'Every job you sold that we are still working on, including Work Complete until it is invoiced. Type what you think the job will invoice for. The owner sees your number on their WIP form.')}
  ${total ? sections : '<div class="card meta">No jobs in progress with you as the sales rep right now.</div>'}
</section>
<div class="bar">
  <div class="status"><b>Your jobs</b><span id="bar-v">$0</span></div>
  <button class="btn" id="done">Done</button>
</div>`;

  const groups = m.groups.map(g => ({ loc: String(g.pool.location_id), rows: g.rows.map(r => ({
    key: r.key, name: r.name, status: r.status, createdLabel: r.createdLabel, oop: r.oop, amount: r.amount, note: r.note || '',
  })) }));
  const script = `
const TOKEN=${json(m.token)};const GROUPS=${json(groups)};const ROWS=GROUPS.flatMap(g=>g.rows);
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function fmt(n){return '$'+Math.round(n||0).toLocaleString('en-US')}
function num(v){if(v==null||v==='')return null;const n=Number(String(v).replace(/[^0-9.]/g,''));return isNaN(n)?null:n}
function money2(n){return n==null?'':Number(n).toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:2})}
function tag(r){return (r.oop?'<span class="tag oop">OOP</span>':'')+(r.status==='Work Complete'?'<span class="tag">Complete</span>':'')}
function card(r){return '<div class="job is-ip'+(r.amount==null?' need':'')+'" data-card="'+esc(r.key)+'"><div class="job-head"><div class="nm">'+esc(r.name)+tag(r)+'</div><div class="meta">'+esc(r.status)+(r.createdLabel?' · started '+esc(r.createdLabel):'')+'</div></div>'
+'<div class="amt-row"><span class="pre">$</span><input type="text" inputmode="decimal" pattern="[0-9.,]*" class="amt" data-k="'+esc(r.key)+'" data-f="amount" value="'+esc(money2(r.amount))+'" placeholder="What is this job worth?"></div>'
+'<input type="text" class="nt" data-k="'+esc(r.key)+'" data-f="note" value="'+esc(r.note)+'" placeholder="Note (optional)"></div>'}
for(const g of GROUPS){const el=document.querySelector('[data-loc="'+g.loc+'"]');if(el)el.innerHTML=g.rows.map(card).join('')}
function bar(){let t=0,need=0;for(const r of ROWS){t+=Number(r.amount||0);if(r.amount==null)need++}
document.getElementById('bar-v').innerHTML=fmt(t)+(need?' · <span class="need-txt">'+need+' need a number</span>':'')}
let saveNote=null;
function setStatus(msg,err){if(!saveNote){saveNote=document.createElement('div');saveNote.className='savenote';document.body.appendChild(saveNote)}saveNote.textContent=msg;saveNote.className='savenote'+(err?' err':' ok');clearTimeout(saveNote._t);if(!err)saveNote._t=setTimeout(()=>saveNote.className='savenote',1800)}
const dirty=new Map();let timer=null;
function queue(r){dirty.set(r.key,{key:r.key,amount:r.amount,note:r.note});clearTimeout(timer);timer=setTimeout(flush,700)}
async function flush(sync){const entries=[...dirty.values()];dirty.clear();if(!entries.length)return true;
try{const r=await fetch('/wip/rep/'+TOKEN+'/entries',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({entries}),keepalive:!!sync});if(!r.ok)throw new Error('save');setStatus('Saved');return true}
catch(e){entries.forEach(x=>dirty.set(x.key,x));setStatus("Couldn't save — tap to retry",true);saveNote.onclick=()=>{saveNote.onclick=null;flush()};return false}}
document.addEventListener('input',e=>{const i=e.target;if(!i.dataset||!i.dataset.f)return;const r=ROWS.find(x=>x.key===i.dataset.k);if(!r)return;
if(i.dataset.f==='amount'){r.amount=num(i.value);const c=i.closest('[data-card]');if(c)c.classList.toggle('need',r.amount==null)}else r.note=i.value;
bar();queue(r)});
document.getElementById('done').onclick=async()=>{clearTimeout(timer);if(await flush(true)){const b=document.getElementById('done');b.className='btn ghost';b.textContent='Saved · thanks'}};
window.addEventListener('beforeunload',()=>{if(dirty.size)flush(true)});
bar();`;
  return { body, script, topbar };
}

module.exports = { renderRep };
