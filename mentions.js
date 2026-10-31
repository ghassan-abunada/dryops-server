'use strict';
// ── @Mentions → DryOps notifications (owner 2026-10-30) ──────────────────────
// "add the tagging feature in dryops with notifications, make sure we are
// synced with jobnimbus". JobNimbus stores a mention as plain text "@FirstLast"
// (the user's full name without spaces; intake.js jnUsersById) and notifies its
// own users. This loop reads EVERY new JobNimbus activity once a minute — notes
// typed in JobNimbus and notes posted from DryOps alike, so both sides stay in
// step — finds the @handles, matches them to DryOps profiles through
// profiles.jn_user_id, records one `mentions` row per (activity, person) and
// sends that person an Expo push. Self-mentions are skipped.
//
// GET /admin/mentions/poll?dryrun=1 — run one pass without writing (admins).
// Schema: DryOps supabase/add_mentions.sql.

const POLL_MS = Number(process.env.MENTIONS_POLL_MS) || 60 * 1000;
const OVERLAP_SECS = 120;           // re-read the last 2 min each pass (JN indexes with a small delay)
const FIRST_RUN_LOOKBACK_SECS = 15 * 60;
const MENTION_RE = /(^|[\s(>,;:])@([A-Za-z0-9][A-Za-z0-9_.'-]*)/g;
const SYSTEM_TYPES = new Set(['Job Modified', 'Job Created', 'Status Changed', 'Job Status Changed', 'Task Created', 'Task Completed', 'Attachment deleted', 'Automation']);

function plain(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').trim();
}

/** Lower-cased handles mentioned in a note ("@AliZayyad." → "alizayyad"). */
function handlesIn(note) {
  const out = new Set();
  for (const m of plain(note).matchAll(MENTION_RE)) out.add(m[2].replace(/[.'-]+$/, '').toLowerCase());
  return out;
}

function jobRefOf(a) {
  if (a.primary && a.primary.type === 'job') return { id: a.primary.id, name: a.primary.name || null };
  const r = (a.related || []).find((x) => x && x.type === 'job');
  return r ? { id: r.id, name: r.name || null } : null;
}

module.exports = function mentions(app, { SUPABASE_URL, SUPABASE_SERVICE_KEY, requireAdmin, sbGet, sbInsert, jnGetJson, jnFetchAccountUsers }) {
  const warn = (...a) => console.warn('[mentions]', ...a);
  const enc = encodeURIComponent;
  let cursorSecs = null;
  let running = false;

  let usersCache = { at: 0, byHandle: null };
  async function handleIndex() {
    if (usersCache.byHandle && Date.now() - usersCache.at < 10 * 60 * 1000) return usersCache.byHandle;
    const users = await jnFetchAccountUsers();
    const byHandle = new Map(); // handle → [jn user id]
    for (const [id, u] of users) {
      const h = String(u.name || '').replace(/\s+/g, '').toLowerCase();
      if (!h) continue;
      const list = byHandle.get(h) || [];
      list.push(String(id));
      byHandle.set(h, list);
    }
    usersCache = { at: Date.now(), byHandle };
    return byHandle;
  }

  async function initialCursor() {
    const last = await sbGet('mentions?select=mentioned_at&order=mentioned_at.desc&limit=1').catch(() => null);
    const lastSecs = last && last[0] ? Math.floor(new Date(last[0].mentioned_at).getTime() / 1000) : 0;
    return Math.max(lastSecs, Math.floor(Date.now() / 1000) - FIRST_RUN_LOOKBACK_SECS);
  }

  async function fetchSince(sinceSecs) {
    const filter = JSON.stringify({ must: [{ range: { date_created: { gte: sinceSecs } } }] });
    const fields = 'jnid,note,record_type_name,created_by,created_by_name,date_created,primary,related';
    const out = [];
    for (let from = 0; from < 5000; from += 500) {
      const q = new URLSearchParams({ filter, size: '500', from: String(from), sort_field: 'date_created', sort_direction: 'asc', fields });
      const d = await jnGetJson(`activities?${q}`);
      const rows = d.activity || d.results || [];
      out.push(...rows);
      if (rows.length < 500) break;
    }
    return out;
  }

  /** One pass. Returns what it found (and, unless dryrun, wrote/pushed). */
  async function poll({ dryrun = false } = {}) {
    if (cursorSecs == null) cursorSecs = await initialCursor();
    const since = cursorSecs - OVERLAP_SECS;
    const acts = (await fetchSince(since)).filter((a) => a && a.jnid && a.note && !SYSTEM_TYPES.has(a.record_type_name) && a.is_active !== false);
    const withHandles = acts.map((a) => ({ a, handles: handlesIn(a.note) })).filter((x) => x.handles.size);
    const result = { since, scanned: acts.length, with_mentions: withHandles.length, rows: [], pushed: 0 };
    if (!withHandles.length) { if (!dryrun) advance(acts); return result; }

    const byHandle = await handleIndex();
    const profiles = (await sbGet('profiles?select=id,full_name,jn_user_id&jn_user_id=not.is.null')) || [];
    const profileByJn = new Map(profiles.map((p) => [String(p.jn_user_id), p]));

    const jobJnIds = [...new Set(withHandles.map(({ a }) => jobRefOf(a)?.id).filter(Boolean))];
    const jobs = jobJnIds.length ? (await sbGet(`jobs?select=id,jn_id,name,client_name&jn_id=in.(${jobJnIds.map(enc).join(',')})`)) || [] : [];
    const jobByJn = new Map(jobs.map((j) => [j.jn_id, j]));

    for (const { a, handles } of withHandles) {
      const job = jobRefOf(a);
      const dj = job ? jobByJn.get(job.id) : null;
      for (const h of handles) {
        for (const jnUserId of byHandle.get(h) || []) {
          const p = profileByJn.get(jnUserId);
          if (!p || String(a.created_by || '') === jnUserId) continue;
          result.rows.push({
            profile_id: p.id,
            activity_jnid: a.jnid,
            job_jn_id: job ? job.id : null,
            job_id: dj ? dj.id : null,
            job_name: (dj && (dj.name || dj.client_name)) || (job && job.name) || null,
            author_name: a.created_by_name || null,
            author_jn_id: a.created_by ? String(a.created_by) : null,
            excerpt: plain(a.note).slice(0, 400),
            mentioned_at: new Date((a.date_created || 0) * 1000).toISOString(),
          });
        }
      }
    }
    if (dryrun) return result;

    // Only rows we haven't stored before get stored and pushed.
    const actIds = [...new Set(result.rows.map((r) => r.activity_jnid))];
    const existing = actIds.length ? (await sbGet(`mentions?select=activity_jnid,profile_id&activity_jnid=in.(${actIds.map(enc).join(',')})`)) || [] : [];
    const seen = new Set(existing.map((e) => `${e.activity_jnid}|${e.profile_id}`));
    const fresh = result.rows.filter((r) => !seen.has(`${r.activity_jnid}|${r.profile_id}`));
    for (const r of fresh) {
      try { await sbInsert('mentions', r); } catch (e) { warn('insert', e.message); }
    }
    result.pushed = await pushMentions(fresh);
    result.rows = fresh;
    advance(acts);
    return result;
  }

  function advance(acts) {
    const newest = acts.reduce((m, a) => Math.max(m, a.date_created || 0), 0);
    if (newest) cursorSecs = Math.max(cursorSecs, newest);
    else cursorSecs = Math.max(cursorSecs, Math.floor(Date.now() / 1000) - OVERLAP_SECS);
  }

  async function pushMentions(rows) {
    if (!rows.length) return 0;
    const ids = [...new Set(rows.map((r) => r.profile_id))];
    const tokens = (await sbGet(`push_tokens?select=token,profile_id&profile_id=in.(${ids.map(enc).join(',')})`)) || [];
    if (!tokens.length) return 0;
    const messages = [];
    for (const r of rows) {
      for (const t of tokens.filter((x) => x.profile_id === r.profile_id)) {
        messages.push({
          to: t.token,
          title: `${r.author_name || 'Someone'} mentioned you`,
          body: `${r.job_name ? `${r.job_name.replace(/\s*\(.*?\)\s*$/, '')}: ` : ''}${r.excerpt}`.slice(0, 180),
          sound: 'default',
          data: { kind: 'mention', url: r.job_id ? `/job/${r.job_id}?tab=notes` : '/mentions' },
        });
      }
    }
    for (let i = 0; i < messages.length; i += 100) {
      const res = await fetch('https://exp.host/--/api/v2/push/send', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(messages.slice(i, i + 100)) });
      if (!res.ok) warn('expo push', res.status, (await res.text()).slice(0, 200));
    }
    return messages.length;
  }

  app.get('/admin/mentions/poll', requireAdmin, async (req, res) => {
    try {
      const dry = req.query.dryrun !== '0';
      const r = await poll({ dryrun: dry });
      res.json({ dryrun: dry, ...r, rows: r.rows.slice(0, 50) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  if (SUPABASE_URL && SUPABASE_SERVICE_KEY && process.env.MENTIONS_POLL !== 'off') {
    setInterval(async () => {
      if (running) return;
      running = true;
      try {
        const r = await poll();
        if (r.rows.length) console.log(`[mentions] ${r.rows.length} new (${r.pushed} pushes) from ${r.scanned} activities`);
      } catch (e) {
        warn(e.message);
      } finally {
        running = false;
      }
    }, POLL_MS);
  }

  return { poll, handlesIn };
};

module.exports.handlesIn = handlesIn;
