// In-memory stand-in for the Supabase REST API used by the WIP pages: enough
// PostgREST (filters, in.(), order, limit/offset, embeds, upserts) for wip.js
// to run end to end in tests and in a local preview. Not a general emulator.
const AR = new Set(['Invoice Created', 'Invoiced', 'Pending Payment', 'Pending Payments']);

const LOC = { a1: '11111111-1111-1111-1111-111111111111', aff: '22222222-2222-2222-2222-222222222222', hr: '33333333-3333-3333-3333-333333333333', tulsa: '44444444-4444-4444-4444-444444444444' };
const POOL = { a1: 'aaaa1111-0000-0000-0000-000000000001', aff: 'aaaa1111-0000-0000-0000-000000000002', hr: 'aaaa1111-0000-0000-0000-000000000003' };
const MGR = { sam: 'bbbb1111-0000-0000-0000-000000000001', lee: 'bbbb1111-0000-0000-0000-000000000002' };
const TOKENS = { master: 'mastertoken-0123456789abcdef', admin: 'admintoken-00123456789abcdef', sam: 'samtoken-000123456789abcdef', lee: 'leetoken-000123456789abcdef', a1: 'ownertoken-a1-23456789abcdef', aff: 'ownertoken-aff-3456789abcdef', hr: 'ownertoken-hr-23456789abcdef' };

// Job ids must look like uuids: the owner save endpoint only accepts those as keys.
const jid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const J = Object.fromEntries(Array.from({ length: 12 }, (_, i) => ['j' + (i + 1), jid(i + 1)]));
function job(id, loc, number, name, status, stage, extra = {}) {
  return { id, location_id: loc, jn_id: 'jn' + id, number, name, status, stage, record_type: 'Mitigation', insurance_type: 'Insurance', jn_created: '2026-09-01T00:00:00Z', approved_invoice_total: null, approved_invoice_due: null, last_invoice_date: null, ...extra };
}

// lastWeek = { start, end } ISO dates; payments/invoices are seeded inside it.
function seed(lastWeek) {
  const inWeek = (t) => `${lastWeek.start}T${t}`;
  return {
    wip_config: [{ id: 1, master_token: TOKENS.master, admin_token: TOKENS.admin }],
    locations: [
      { id: LOC.a1, name: 'A1 Restoration of Dallas', logo_url: 'https://cdn.test/a1.png' },
      { id: LOC.aff, name: 'AFF Dallas', logo_url: null },
      { id: LOC.hr, name: '24 HR Dallas', logo_url: null },
      { id: LOC.tulsa, name: 'A1 Tulsa', logo_url: null },
    ],
    wip_pool: [
      { id: POOL.a1, location_id: LOC.a1, token: TOKENS.a1, label: 'A1 Dallas', sort_order: 1, added_at: '2026-09-01T00:00:00Z', bank_balance: 18250, bank_balance_at: '2026-10-23T12:00:00Z', bank_balance_by: 'Sam' },
      { id: POOL.aff, location_id: LOC.aff, token: TOKENS.aff, label: null, sort_order: 2, added_at: '2026-09-02T00:00:00Z', bank_balance: null, bank_balance_at: null, bank_balance_by: null },
      { id: POOL.hr, location_id: LOC.hr, token: TOKENS.hr, label: '24 HR', sort_order: 3, added_at: '2026-09-03T00:00:00Z', bank_balance: 4000, bank_balance_at: '2026-10-22T12:00:00Z', bank_balance_by: 'Pat' },
    ],
    wip_managers: [
      { id: MGR.sam, name: 'Sam Rivera', email: 'sam@example.test', token: TOKENS.sam, active: true, created_at: '2026-10-01T00:00:00Z', last_opened_at: null },
      { id: MGR.lee, name: 'Lee Chen', email: null, token: TOKENS.lee, active: true, created_at: '2026-10-02T00:00:00Z', last_opened_at: '2026-10-20T00:00:00Z' },
    ],
    wip_manager_locations: [
      { manager_id: MGR.sam, pool_id: POOL.a1, sort_order: 1 },
      { manager_id: MGR.sam, pool_id: POOL.aff, sort_order: 2 },
      { manager_id: MGR.lee, pool_id: POOL.hr, sort_order: 1 },
    ],
    jobs: [
      job(J.j1, LOC.a1, '1001', 'Alice Johnson (A1 - DAL - MIT)', 'Invoiced', 'Account Receivable', { approved_invoice_total: 5000, approved_invoice_due: 1234.57, last_invoice_date: '2026-10-10' }),
      job(J.j2, LOC.a1, '1002', 'Bob Reyes', 'Attorney', 'Account Receivable', { record_type: 'Contents', approved_invoice_total: 9000, approved_invoice_due: 9000 }),
      job(J.j3, LOC.a1, '1003', 'Cara Lee', 'In Progress', 'In Production'),
      job(J.j4, LOC.a1, '1004', 'Dan Smith', 'Work Complete', 'In Production', { insurance_type: 'Out of Pocket' }),
      job(J.j5, LOC.a1, '1005', 'Eve Park', 'Lead', null),
      job(J.j6, LOC.a1, '1006', 'Finn Moore', 'Invoice Created', 'In Production', { approved_invoice_total: 7200, approved_invoice_due: 7200, last_invoice_date: '2026-10-15' }),
      job(J.j7, LOC.a1, '1007', 'Gia Torres', 'Paid & Closed', 'Completed', { approved_invoice_total: 3100, approved_invoice_due: 0, last_invoice_date: '2026-09-20' }),
      job(J.j8, LOC.aff, '2001', 'Hank Ali', 'In Progress', 'In Production'),
      job(J.j9, LOC.aff, '2002', 'Ivy Brooks', 'Pending Payment', 'Account Receivable', { approved_invoice_total: 2600, approved_invoice_due: 2600, last_invoice_date: '2026-10-12' }),
      job(J.j10, LOC.hr, '3001', 'Jo Kim', 'Work Complete', 'In Production'),
      job(J.j11, LOC.hr, '3002', 'Kai Olsen', 'Invoiced', 'Account Receivable', { approved_invoice_total: 1500, approved_invoice_due: 1500 }),
    ],
    wip_entries: [
      { id: 'e1', location_id: LOC.a1, key: J.j1, custom_name: null, category: 'collecting', amount: null, note: '', updated_by: 'Sam', updated_at: '2026-10-23T12:00:00Z', ai_decision: 'collecting', ai_amount: 1234.57, ai_reason: 'Carrier mailed the check Oct 9; expected by Oct 29.', ai_at: '2026-10-24T11:05:00Z' },
      { id: 'e2', location_id: LOC.a1, key: J.j3, custom_name: null, category: 'in_progress', amount: 8000, note: 'drying', updated_by: 'Sam', updated_at: '2026-10-23T12:00:00Z' },
      // j6 was valued while In Progress, now invoiced: must NOT count as In Progress any more.
      { id: 'e3', location_id: LOC.a1, key: J.j6, custom_name: null, category: 'in_progress', amount: 6000, note: '', updated_by: 'Sam', updated_at: '2026-10-09T12:00:00Z' },
      { id: 'e4', location_id: LOC.aff, key: J.j8, custom_name: null, category: 'in_progress', amount: 12000, note: '', updated_by: 'Ana', updated_at: '2026-10-23T12:00:00Z' },
      { id: 'e5', location_id: LOC.aff, key: J.j9, custom_name: null, category: 'collecting', amount: 2600, note: '', updated_by: 'ai-review', updated_at: '2026-10-24T11:00:00Z', ai_decision: 'collecting', ai_amount: 2600, ai_reason: 'Check mailed Oct 5, due by Oct 24.', ai_at: '2026-10-24T11:00:00Z' },
    ],
    wip_job_estimates: [
      { id: 's1', location_id: LOC.a1, job_id: J.j6, amount: 6000, entered_by: 'Sam', entered_at: '2026-10-09T12:00:00Z' },
      { id: 's2', location_id: LOC.a1, job_id: J.j7, amount: 4000, entered_by: 'Sam', entered_at: '2026-09-01T12:00:00Z' },
      { id: 's3', location_id: LOC.a1, job_id: J.j3, amount: 8000, entered_by: 'Sam', entered_at: '2026-10-23T12:00:00Z' },
      { id: 's4', location_id: LOC.aff, job_id: J.j9, amount: 2000, entered_by: 'Ana', entered_at: '2026-10-01T12:00:00Z' },
    ],
    payments: [
      { id: 'p1', location_id: LOC.a1, job_id: J.j7, amount: 3100, method_id: 3, jn_created: inWeek('18:00:00Z') },
      { id: 'p2', location_id: LOC.a1, job_id: J.j1, amount: 1200.5, method_id: null, jn_created: inWeek('20:00:00Z') },
      { id: 'p3', location_id: LOC.a1, job_id: J.j1, amount: 300, method_id: -1, jn_created: inWeek('20:30:00Z') }, // credit memo: excluded
      { id: 'p4', location_id: LOC.aff, job_id: J.j9, amount: 999, method_id: 2, jn_created: inWeek('15:00:00Z') },
      { id: 'p5', location_id: LOC.a1, job_id: J.j1, amount: 50, method_id: 2, jn_created: '2026-01-05T15:00:00Z' }, // old: excluded
    ],
    invoices: [
      { id: 'i1', location_id: LOC.a1, job_id: J.j6, total: 7200, jn_created: inWeek('16:00:00Z') },
      { id: 'i2', location_id: LOC.hr, job_id: J.j11, total: 1500, jn_created: inWeek('16:30:00Z') },
      { id: 'i3', location_id: LOC.a1, job_id: J.j1, total: 5000, jn_created: '2026-01-05T15:00:00Z' },
    ],
    wip_snapshots: [
      // Forecast saved the Saturday before last week: A1 said $4,000 would come in.
      { id: 'n1', location_id: LOC.a1, generated_at: new Date(new Date(lastWeek.start + 'T12:00:00Z').getTime() - 2 * 86400000).toISOString(), in_progress_total: 20000, collecting_total: 4000, body: '…', generated_by: 'Sam' },
      { id: 'n2', location_id: LOC.hr, generated_at: new Date(new Date(lastWeek.start + 'T12:00:00Z').getTime() - 1 * 86400000).toISOString(), in_progress_total: 5000, collecting_total: 0, body: '…' },
    ],
    wip_reviews: [
      { id: 'r1', location_id: LOC.aff, reviewed_at: '2026-10-24T11:05:00Z', model: 'm', jobs_reviewed: 1, applied: 1, result: { trigger: 'weekly', results: [] } },
    ],
  };
}

function parseFilters(query) {
  const f = { filters: [], select: '*', order: null, limit: null, offset: 0, onConflict: null };
  for (const part of (query || '').split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const key = decodeURIComponent(part.slice(0, i)), val = decodeURIComponent(part.slice(i + 1));
    if (key === 'select') f.select = val;
    else if (key === 'order') f.order = val;
    else if (key === 'limit') f.limit = Number(val);
    else if (key === 'offset') f.offset = Number(val);
    else if (key === 'on_conflict') f.onConflict = val.split(',');
    else if (key === 'or') f.filters.push({ or: val });
    else f.filters.push({ key, val });
  }
  return f;
}
function getField(row, key) {
  if (key.includes('->>')) { const [a, b] = key.split('->>'); return row[a] ? row[a][b] : undefined; }
  return row[key];
}
function matchOne(row, key, spec) {
  let neg = false, s = spec;
  if (s.startsWith('not.')) { neg = true; s = s.slice(4); }
  const dot = s.indexOf('.'); const op = s.slice(0, dot), v = s.slice(dot + 1);
  const x = getField(row, key);
  let r;
  if (op === 'eq') r = String(x) === v;
  else if (op === 'neq') r = x != null && String(x) !== v;
  else if (op === 'in') r = v.slice(1, -1).split(',').includes(String(x));
  else if (op === 'gte') r = x != null && String(x) >= v;
  else if (op === 'gt') r = x != null && String(x) > v;
  else if (op === 'lt') r = x != null && String(x) < v;
  else if (op === 'lte') r = x != null && String(x) <= v;
  else if (op === 'is') r = v === 'null' ? x == null : v === 'true' ? x === true : x === false;
  else if (op === 'ilike') r = new RegExp('^' + v.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i').test(String(x || ''));
  else throw new Error('fixture: unsupported operator ' + op);
  return neg ? !r : r;
}
function matchOr(row, expr) {
  // or=(a.op.v,b.op.v) — split on commas not inside parentheses
  const inner = expr.slice(1, -1); const parts = []; let depth = 0, cur = '';
  for (const ch of inner) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && !depth) { parts.push(cur); cur = ''; } else cur += ch; }
  parts.push(cur);
  return parts.some(p => { const dot = p.indexOf('.'); return matchOne(row, p.slice(0, dot), p.slice(dot + 1)); });
}
function applyFilters(rows, f) {
  let out = rows.filter(r => f.filters.every(x => x.or ? matchOr(r, x.or) : matchOne(r, x.key, x.val)));
  if (f.order) {
    const keys = f.order.split(',').map(k => { const [col, dir] = k.split('.'); return { col, desc: dir === 'desc' }; });
    out = [...out].sort((a, b) => { for (const k of keys) { const x = String(a[k.col] ?? ''), y = String(b[k.col] ?? ''); if (x !== y) return (x < y ? -1 : 1) * (k.desc ? -1 : 1); } return 0; });
  }
  if (f.offset) out = out.slice(f.offset);
  if (f.limit != null) out = out.slice(0, f.limit);
  return out;
}
function project(store, table, rows, select) {
  return rows.map(r => {
    const out = { ...r };
    if (/locations\(/.test(select)) out.locations = store.locations.find(l => l.id === r.location_id) ? (({ name, logo_url }) => ({ name, logo_url }))(store.locations.find(l => l.id === r.location_id)) : null;
    if (/wip_pool\(/.test(select)) { const p = store.wip_pool.find(p => p.id === r.pool_id); out.wip_pool = p ? project(store, 'wip_pool', [p], 'locations(name,logo_url)')[0] : null; }
    if (/result->>trigger/.test(select)) out.trigger = r.result ? r.result.trigger : null;
    return out;
  });
}

let seq = 0;
function makeStore(lastWeek) {
  const store = seed(lastWeek);
  const calls = [];
  const realFetch = global.fetch;
  const ok = (body, status = 200) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  async function handle(url, init) {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/rest\/v1\//, '');
    const method = (init && init.method) || 'GET';
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ path: path + (u.search || ''), method, body, prefer: init && init.headers && init.headers.Prefer });
    if (path === 'rpc/open_ar_total') {
      const ids = body.p_location_ids;
      return ok(store.jobs.filter(j => (!ids || ids.includes(j.location_id)) && AR.has(j.status) && Number(j.approved_invoice_due) > 0).reduce((s, j) => s + Number(j.approved_invoice_due), 0));
    }
    if (!(path in store)) return ok({ message: `relation "public.${path}" does not exist`, code: '42P01' }, 404);
    const f = parseFilters(u.search.slice(1));
    const rows = store[path];
    if (method === 'GET') return ok(project(store, path, applyFilters(rows, f), f.select));
    if (method === 'POST') {
      const items = (Array.isArray(body) ? body : [body]).map(b => ({ id: b.id || `${path}-${++seq}`, ...b }));
      const prefer = (init.headers && init.headers.Prefer) || '';
      const out = [];
      for (const it of items) {
        const dup = f.onConflict ? rows.find(r => f.onConflict.every(k => String(r[k]) === String(it[k]))) : null;
        if (dup && /ignore-duplicates/.test(prefer)) { out.push(dup); continue; }
        if (dup) { Object.assign(dup, it, { id: dup.id }); out.push(dup); continue; }
        if (path === 'wip_pool' && !it.token) it.token = 'minted-' + it.id + '-0123456789';
        if (path === 'wip_managers' && it.active === undefined) it.active = true;
        if (path === 'wip_reviews' && !it.reviewed_at) it.reviewed_at = new Date().toISOString();
        if (path === 'wip_snapshots' && !it.generated_at) it.generated_at = new Date().toISOString();
        if (path === 'wip_job_estimates' && !it.entered_at) it.entered_at = new Date().toISOString();
        rows.push(it); out.push(it);
      }
      return /return=minimal/.test(prefer) ? ok(undefined, 201) : ok(out, 201);
    }
    if (method === 'PATCH') { for (const r of applyFilters(rows, f)) Object.assign(r, body); return ok(undefined, 204); }
    if (method === 'DELETE') { const del = new Set(applyFilters(rows, f)); store[path] = rows.filter(r => !del.has(r)); return ok(undefined, 204); }
    throw new Error('fixture: unsupported ' + method);
  }
  function install(SB) {
    global.fetch = async (url, init) => (String(url).startsWith(SB) ? handle(String(url), init) : realFetch(url, init));
    return () => { global.fetch = realFetch; };
  }
  return { store, calls, install };
}

module.exports = { makeStore, LOC, POOL, MGR, TOKENS, J, jid };
