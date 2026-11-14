// CallRail request budget. CallRail allows 1,000 requests an hour and 10,000
// a day PER ACCOUNT, and a spent day locks out everything that reads from it
// (playback, the New Job call strip, the reconciles) until the window rolls.
// On 2026-11-14 the main account hit 10,000 / 10,000: the text reconcile was
// re-reading every recent thread on every 15-minute pass.
//
// This keeps a rolling per-account count so that
//  - background work (reconciles, sweeps, AI runs) stops at a share of the
//    limit and leaves the rest for people using the app,
//  - a 429 pauses reads on that account instead of hammering it,
//  - the usage is visible (GET /admin/callrail/accounts, and a log line).
// In-memory: a restart forgets the count, a 429 re-teaches it in one request.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const BUCKET_MS = 60 * 1000;

function createCallrailBudget({
  now = Date.now,
  hourlyLimit = 1000,
  dailyLimit = 10000,
  backgroundShare = 0.6,      // background work may spend this much of each limit
  blockMs = 10 * 60 * 1000,   // pause after a 429 when CallRail sends no Retry-After
} = {}) {
  const buckets = new Map();  // account → Map<minute index, count>
  const blocked = new Map();  // account → ms until reads resume
  const last429 = new Map();  // account → ms of the last 429

  function note(account) {
    const acct = String(account);
    let m = buckets.get(acct);
    if (!m) { m = new Map(); buckets.set(acct, m); }
    const t = now();
    const k = Math.floor(t / BUCKET_MS);
    m.set(k, (m.get(k) || 0) + 1);
    if (m.size > DAY_MS / BUCKET_MS + 5) {
      const floor = Math.floor((t - DAY_MS) / BUCKET_MS);
      for (const key of m.keys()) if (key < floor) m.delete(key);
    }
  }
  function usage(account) {
    const m = buckets.get(String(account));
    const out = { hour: 0, day: 0 };
    if (!m) return out;
    const t = now();
    const hourFloor = Math.floor((t - HOUR_MS) / BUCKET_MS);
    const dayFloor = Math.floor((t - DAY_MS) / BUCKET_MS);
    for (const [k, n] of m) {
      if (k > dayFloor) out.day += n;
      if (k > hourFloor) out.hour += n;
    }
    return out;
  }
  /** A 429 came back: no reads on this account until the pause ends. */
  function block(account, retryAfterSeconds) {
    const acct = String(account);
    const secs = Number(retryAfterSeconds);
    const ms = Number.isFinite(secs) && secs > 0 ? Math.min(secs * 1000, HOUR_MS) : blockMs;
    blocked.set(acct, now() + ms);
    last429.set(acct, now());
  }
  function blockedMs(account) {
    const until = blocked.get(String(account)) || 0;
    return Math.max(0, until - now());
  }
  /** May a reconcile / sweep / AI run spend a request on this account right now? */
  function allowBackground(account) {
    if (blockedMs(account) > 0) return false;
    const u = usage(account);
    return u.hour < hourlyLimit * backgroundShare && u.day < dailyLimit * backgroundShare;
  }
  function snapshot() {
    const accounts = new Set([...buckets.keys(), ...blocked.keys()]);
    return [...accounts].map((account) => {
      const u = usage(account);
      const at = last429.get(account);
      return {
        account, hour: u.hour, day: u.day, hourly_limit: hourlyLimit, daily_limit: dailyLimit,
        background_allowed: allowBackground(account),
        paused_seconds: Math.ceil(blockedMs(account) / 1000),
        last_429_at: at ? new Date(at).toISOString() : null,
      };
    });
  }
  return { note, usage, block, blockedMs, allowBackground, snapshot };
}

/** `accounts` with `preferred` first (when it is one of them); order otherwise kept. */
function orderAccounts(accounts, preferred) {
  const list = (accounts || []).map(String);
  const first = (Array.isArray(preferred) ? preferred : [preferred]).filter(Boolean).map(String).filter((p) => list.includes(p));
  return Array.from(new Set([...first, ...list]));
}

module.exports = { createCallrailBudget, orderAccounts };
