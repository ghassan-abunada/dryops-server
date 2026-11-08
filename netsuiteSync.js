// NetSuite → Supabase sync behind the app's Financials tab (supabase/add_financials.sql
// in the DryOps repo). Reads with the credentials the CFO submitted (netsuiteIntake.js)
// and writes with the service key; the app only ever reads through scoped RPCs.
//
// Every run: the subsidiary ↔ location map, monthly P&L by account from `from`,
// every bank account's statement-verified balance, and the PEX card charges from
// `from` with their flags. Hourly runs cover the last three months; the nightly
// run (3 AM Denver) and `POST /admin/financials/sync {full:true}` go back to
// January 2026, where the books start being comparable. Scheduled only when
// NETSUITE_SYNC=on; needs NETSUITE_ENC_KEY to read the stored credentials.
//
// Mitigation and Contents (Packout) subsidiaries only; Gurr / Rebuild is parked.
const { supabaseStore, parseKey, decryptSecrets } = require('./netsuiteIntake');
const { suiteql } = require('./netsuiteClient');
const { matchLocations, mitigationPackoutScope, normalizeName } = require('./netsuiteMatch');
const { flagTransactions } = require('./cardFlags');

const DATA_START = '2026-01-01';
const RECENT_MONTHS = 3;
const PNL = ['Income', 'OthIncome', 'COGS', 'Expense', 'OthExpense'];
// PEX | <card account> | <cardholder> | Purchase #<id> | <ISO time> | <merchant> | -135.40 USD
const MEMO = /^PEX \| (.*?) \| (.*?) \| (\w+) #(\w+) \| (\S+) \| (.*) \| (-?[\d,.]+) (\w+)$/;

// Owner-accepted name matches (2026-11-04) where DryOps and NetSuite spell a location differently.
const CONFIRMED = {
  'Prime Packouts of Salt Lake': { name: 'Prime Packouts of Salt Lake City' },
  '24 Hour Flood Pros of Salem': { name: '24 Hour Flood Pros of Salem OR' },
  'A1 Restoration - Seattle': { name: 'A1 Restoration of Seattle' },
  'Any Hour Water and Fire of Vegas': { name: 'Any Hour Water and Fire of Las Vegas' },
  'Texas Water and Fire - RGV': { name: 'Texas Water and Fire of Rio Grande Valley' },
  '24 Hour Flood Pros of Flagstaff': { name: '24 Hour Flood Pros of Northern Arizona' },
  'American Packout of Utah': { name: 'American Packout of Salt Lake City' },
  'American Fire and Flood of Long Island': { id: 290 },
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const ymd = (d) => d.toISOString().slice(0, 10);
const nextMonth = (m) => { const [y, mo] = m.split('-').map(Number); return ymd(new Date(Date.UTC(y, mo, 1))); };

/** Month starts (YYYY-MM-01) from `from`'s month through `now`'s month. */
function monthStartsFrom(from, now) {
  const out = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const end = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  for (let guard = 0; guard < 120; guard += 1) {
    const cur = `${y}-${String(m).padStart(2, '0')}-01`;
    if (cur > end) break;
    out.push(cur);
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** The window a run covers: three months back for the hourly run, January 2026 for a full one. */
function windowFrom(full, now) {
  if (full) return DATA_START;
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (RECENT_MONTHS - 1), 1));
  return ymd(d) < DATA_START ? DATA_START : ymd(d);
}

/**
 * Subsidiary ↔ location map. `locations` are DryOps rows {id, name, status,
 * location_type, jobs}; `subsidiaries` the NetSuite list. Returns the map rows,
 * the in-scope subsidiaries and the active Mitigation/Contents locations nothing matched.
 */
function buildMap(locations, subsidiaries, confirmed = CONFIRMED) {
  const usable = locations.filter((l) => l.status === 'active' || Number(l.jobs) > 0);
  const matches = matchLocations(usable, subsidiaries).map((m) => ({
    location: m.location.name, location_status: m.location.status, location_type: m.location.location_type, jobs: m.location.jobs,
    status: m.status, subsidiary: m.subsidiary,
  }));
  const scope = mitigationPackoutScope(matches, subsidiaries, confirmed);
  const idsByName = new Map();
  for (const l of locations) idsByName.set(l.name, [...(idsByName.get(l.name) || []), String(l.id)]);
  const map = [];
  const subs = [];
  const mapped = new Set();
  const seen = new Set();
  for (const s of scope) {
    const vertical = s.locations.some((l) => l.type === 'Mitigation') ? 'Mitigation' : 'Contents';
    subs.push({ subsidiary_id: Number(s.id), subsidiary_name: s.name, vertical });
    for (const l of s.locations) {
      mapped.add(l.name);
      // Two DryOps rows with one name (an old and a new location) both match; link each once.
      for (const id of idsByName.get(l.name) || []) {
        if (seen.has(`${s.id}:${id}`)) continue;
        seen.add(`${s.id}:${id}`);
        map.push({ subsidiary_id: Number(s.id), subsidiary_name: s.name, vertical, location_id: id });
      }
    }
  }
  const unmatched = usable
    .filter((l) => l.status === 'active' && ['Mitigation', 'Contents'].includes(l.location_type) && !/^Gurr/i.test(l.name) && !mapped.has(l.name))
    .map((l) => l.name);
  return { map, subsidiaries: subs, unmatched };
}

/** One P&L row from a SuiteQL aggregate, signed the way the app reads it (income positive). */
function pnlRow(item, month) {
  const raw = Number(item.amount) || 0;
  const amount = round2(item.accttype === 'Income' || item.accttype === 'OthIncome' ? -raw : raw);
  if (!amount) return null;
  return {
    month, subsidiary_id: Number(item.sub_id), account_id: Number(item.account_id),
    account_number: item.acctnumber == null ? null : String(item.acctnumber), account_name: item.account, account_type: item.accttype,
    amount, txn_count: Number(item.n) || 0,
  };
}

/**
 * Bank balances. A balance shows only when a statement anchors it AND the gap
 * between NetSuite and the bank is the same at the two newest statement dates,
 * which proves NetSuite tracks that account (2026-11-05 test). `banks` are
 * SuiteQL rows with thru_<i> sums per statement date in `dates` order plus
 * thru_now; `statements` are {company, last4, statement_date, balance}.
 */
function bankEntries(banks, statements, dates, subNames) {
  const out = [];
  const tally = { verified: 0, mismatch: 0, noStatement: 0 };
  const dateIndex = new Map(dates.map((d, i) => [d, i]));
  for (const b of banks) {
    if (/airbase|clearing/i.test(b.account) || String(b.isinactive).toUpperCase() === 'T') continue;
    const last4 = (/BOA-(\d{4})/.exec(b.account) || [])[1] || null;
    const mine = last4 ? statements.filter((x) => x.last4 === last4) : [];
    const companies = new Set(mine.map((x) => x.company));
    const own = companies.size > 1 ? mine.filter((x) => normalizeName(x.company) === subNames.get(Number(b.sub_id))) : mine;
    const newestFirst = [...own].sort((a, c) => c.statement_date.localeCompare(a.statement_date));
    const [last, prev] = newestFirst;
    const entry = {
      subsidiary_id: Number(b.sub_id), account_id: Number(b.account_id), name: b.account, last4,
      reconciled_balance: null, reconciled_through: null, since: 0, issue: null,
    };
    if (last && dateIndex.has(last.statement_date)) {
      const thru = (d) => Number(b[`thru_${dateIndex.get(d)}`]) || 0;
      const gapLast = round2(Number(last.balance) - thru(last.statement_date));
      const gapPrev = prev && dateIndex.has(prev.statement_date) ? round2(Number(prev.balance) - thru(prev.statement_date)) : null;
      if (gapPrev != null && Math.abs(gapPrev - gapLast) > 1) {
        const diff = Math.abs(gapPrev - gapLast).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
        entry.issue = `NetSuite and the bank moved differently between ${prev.statement_date} and ${last.statement_date}, by ${diff}`;
        tally.mismatch += 1;
      } else {
        entry.reconciled_balance = round2(last.balance);
        entry.reconciled_through = last.statement_date;
        entry.since = round2((Number(b.thru_now) || 0) - thru(last.statement_date));
        tally.verified += 1;
      }
    } else tally.noStatement += 1;
    out.push(entry);
  }
  return { entries: out, tally };
}

/** One card row from a PEX journal's expense line, or null for bill payments, rebates and odd memos. */
function cardRow(item, month) {
  const hit = MEMO.exec(String(item.memo || ''));
  if (!hit) return null;
  const [, , holder, kind, , at, merchant] = hit;
  if (kind !== 'Purchase' && kind !== 'Fee') return null;
  const name = holder.trim();
  return {
    id: `${item.id}-${item.acctnumber}`, subsidiary_id: Number(item.sub_id), cardholder: name, vendor_card: /^vendor\b/i.test(name),
    merchant: String(item.vendor || merchant || '').trim(), account_number: item.acctnumber == null ? null : String(item.acctnumber), account_name: item.account,
    at: /^\d{4}-/.test(at) ? `${at.slice(0, 19)}Z` : `${month}T12:00:00Z`, amount: round2(item.amount),
  };
}

function mountNetsuiteSync(app, deps) {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, requireAuth, requireAdmin, denverNow } = deps;
  const headers = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' };
  const rest = async (path, init = {}) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
    if (!r.ok) throw new Error(`${path.split('?')[0]} ${r.status} ${(await r.text()).slice(0, 300)}`);
    return r.status === 204 ? null : r.json();
  };
  const rpc = (fn, body) => rest(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(body || {}) });
  let running = null;
  let lastFullDay = null;

  async function runSync({ full = false, trigger = 'admin' } = {}) {
    const now = new Date();
    const from = windowFrom(full, now);
    const run = (await rest('financial_sync_runs?select=id', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ trigger, status: 'running' }) }))[0];
    const log = (msg) => console.log(`[netsuite sync] ${msg}`);
    try {
      const key = parseKey(process.env.NETSUITE_ENC_KEY);
      if (!key) throw new Error('NETSUITE_ENC_KEY is not set');
      const cred = await supabaseStore({ url: SUPABASE_URL, serviceKey: SUPABASE_SERVICE_KEY }).get();
      if (!cred) throw new Error('No NetSuite credentials have been submitted');
      const secrets = decryptSecrets(cred.secrets, key);
      const all = async (q) => {
        const items = [];
        for (let page = 0; page < 200; page += 1) {
          const res = await suiteql({ accountId: cred.account_id, secrets, q, limit: 1000, offset: page * 1000 });
          items.push(...(res.items || []));
          if (!res.hasMore) break;
        }
        return items;
      };

      // 1. Map subsidiaries to DryOps locations.
      const [locations, subsidiaryList] = await Promise.all([
        rpc('netsuite_location_candidates'),
        all('SELECT id, name, isinactive, iselimination FROM subsidiary'),
      ]);
      const { map, subsidiaries, unmatched } = buildMap(locations, subsidiaryList);
      if (!subsidiaries.length) throw new Error('No subsidiary matched a location');
      const ids = subsidiaries.map((s) => s.subsidiary_id).join(',');
      const base = `FROM transactionaccountingline tal JOIN transaction t ON t.id = tal.transaction JOIN account a ON a.id = tal.account JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline WHERE tal.posting = 'T' AND tl.subsidiary IN (${ids})`;
      log(`${subsidiaries.length} subsidiaries, ${map.length} location links, ${unmatched.length} unmatched; window from ${from}`);

      // 2. Monthly P&L by account (one query per month: SuiteQL stops at 100,000 rows).
      const months = monthStartsFrom(from, now);
      const rows = [];
      let futureDated = 0;
      for (const m of months) {
        const items = await all(`SELECT tl.subsidiary AS sub_id, a.id AS account_id, a.acctnumber, a.accountsearchdisplayname AS account, a.accttype, SUM(tal.amount) AS amount, COUNT(*) AS n ${base} AND t.trandate >= TO_DATE('${m}', 'YYYY-MM-DD') AND t.trandate < TO_DATE('${nextMonth(m)}', 'YYYY-MM-DD') AND t.trandate <= SYSDATE AND a.accttype IN (${PNL.map((x) => `'${x}'`).join(',')}) GROUP BY tl.subsidiary, a.id, a.acctnumber, a.accountsearchdisplayname, a.accttype`);
        for (const i of items) { const r = pnlRow(i, m); if (r) rows.push(r); }
      }
      const future = await all(`SELECT COUNT(DISTINCT t.id) AS n ${base} AND t.trandate > SYSDATE`);
      futureDated = Number(future[0] && future[0].n) || 0;

      // 3. Bank balances against the loaded statements.
      const statements = await rest('bank_statement_balances?select=company,last4,statement_date,balance&order=statement_date.desc&limit=5000');
      const dates = [...new Set(statements.map((s) => s.statement_date))].sort();
      const thruCols = dates.map((d, i) => `SUM(CASE WHEN t.trandate <= TO_DATE('${d}', 'YYYY-MM-DD') THEN tal.amount ELSE 0 END) AS thru_${i}`).join(', ');
      const banks = await all(`SELECT tl.subsidiary AS sub_id, a.id AS account_id, a.accountsearchdisplayname AS account, a.isinactive, ${thruCols ? `${thruCols}, ` : ''}SUM(CASE WHEN t.trandate <= SYSDATE THEN tal.amount ELSE 0 END) AS thru_now ${base} AND a.accttype = 'Bank' GROUP BY tl.subsidiary, a.id, a.accountsearchdisplayname, a.isinactive`);
      const subNames = new Map(subsidiaries.map((s) => [s.subsidiary_id, normalizeName(s.subsidiary_name)]));
      const { entries, tally } = bankEntries(banks, statements, dates, subNames);
      log(`bank accounts ${entries.length}: verified ${tally.verified}, disagree ${tally.mismatch}, no statement ${tally.noStatement}`);

      // 4. Everything above lands in one transaction, so a failed run keeps the last good numbers.
      await rpc('financial_replace', { p_from: from, p_map: map, p_rows: rows, p_banks: entries });
      log(`P&L rows ${rows.length} from ${from}`);

      // 5. PEX card charges, flagged over the whole window, upserted by id; rows that vanished are removed.
      const startedAt = new Date().toISOString();
      const cards = [];
      for (const m of months) {
        const items = await all(`SELECT t.id, t.memo, tl.subsidiary AS sub_id, BUILTIN.DF(tl.entity) AS vendor, a.acctnumber, a.accountsearchdisplayname AS account, tal.amount FROM transaction t JOIN transactionline tl ON tl.transaction = t.id JOIN transactionaccountingline tal ON tal.transaction = t.id AND tal.transactionline = tl.id JOIN account a ON a.id = tal.account WHERE tal.posting = 'T' AND t.type = 'Journal' AND UPPER(t.memo) LIKE 'PEX |%' AND a.accttype NOT IN ('CredCard', 'Bank') AND tl.subsidiary IN (${ids}) AND t.trandate >= TO_DATE('${m}', 'YYYY-MM-DD') AND t.trandate < TO_DATE('${nextMonth(m)}', 'YYYY-MM-DD') AND t.trandate <= SYSDATE`);
        for (const i of items) { const r = cardRow(i, m); if (r) cards.push(r); }
      }
      const flags = flagTransactions(cards);
      const uniq = [...new Map(cards.map((c) => [c.id, { ...c, flags: flags.get(c.id) || [], synced_at: startedAt }])).values()];
      for (let i = 0; i < uniq.length; i += 500) {
        await rest('card_transactions?on_conflict=id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(uniq.slice(i, i + 500)) });
      }
      await rest(`card_transactions?at=gte.${from}&synced_at=lt.${encodeURIComponent(startedAt)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      log(`card charges ${uniq.length}, flagged ${[...flags.values()].filter((f) => f.length).length}`);

      await rest(`financial_sync_runs?id=eq.${run.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
        status: 'done', finished_at: new Date().toISOString(), row_count: rows.length, txn_count: uniq.length, subsidiary_count: subsidiaries.length,
        future_dated: futureDated, unmatched,
      }) });
      return { ok: true, rows: rows.length, cards: uniq.length, subsidiaries: subsidiaries.length, unmatched: unmatched.length, bank: tally };
    } catch (err) {
      console.error('[netsuite sync] failed:', err.message);
      await rest(`financial_sync_runs?id=eq.${run.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'error', finished_at: new Date().toISOString(), error: String(err.message).slice(0, 500) }) }).catch(() => {});
      return { ok: false, error: err.message };
    }
  }

  function start(opts) {
    if (running) return null;
    running = runSync(opts).finally(() => { running = null; });
    return running;
  }

  app.post('/admin/financials/sync', requireAuth, requireAdmin, (req, res) => {
    const full = !!(req.body && req.body.full);
    const started = start({ full, trigger: 'admin' });
    if (!started) return res.status(409).json({ error: 'A sync is already running' });
    res.status(202).json({ started: true, full });
  });
  app.get('/admin/financials/sync', requireAuth, requireAdmin, async (req, res) => {
    try {
      const runs = await rest('financial_sync_runs?select=*&order=started_at.desc&limit=10');
      res.json({ running: !!running, runs });
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  if ((process.env.NETSUITE_SYNC || '').trim() === 'on') {
    const tick = () => {
      const day = denverNow();
      const full = day.getHours() === 3 && lastFullDay !== day.toDateString();
      if (full) lastFullDay = day.toDateString();
      start({ full, trigger: full ? 'nightly' : 'schedule' });
    };
    setTimeout(tick, 90 * 1000);
    setInterval(tick, 60 * 60 * 1000);
    console.log('[netsuite sync] scheduled: hourly, full run at 3 AM Denver');
  }

  return { runSync: start };
}

module.exports = mountNetsuiteSync;
Object.assign(module.exports, { CONFIRMED, DATA_START, monthStartsFrom, windowFrom, buildMap, pnlRow, bankEntries, cardRow });
