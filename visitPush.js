'use strict';
// Schedule pushes: tell the people on a visit when they are put on it, taken
// off it, or it is cancelled.
//
// Hook: syncVisitJnTask() in server.js, the one function every visit write
// passes through (the app's fast path after a save + the minute sweep over
// jn_task_dirty rows), so it covers the Schedule sheet, the Route Planner,
// New Job intake, a tech joining, drag-and-drop and SQL edits alike.
//
// State: inspections.push_state (jsonb, dryops repo supabase/add_visit_push.sql)
// holds who was last told about the visit and what they were told:
//   { ids: [profile ids], status, date, start, end }
// Each sync diffs the row against it, queues the pushes and writes the new
// snapshot. The migration backfills it for existing visits so the first edit of
// an old visit does not re-announce it. Until the column exists nothing is sent
// (the server looks again every 10 minutes, no restart needed).
//
// A person's pushes are held for HOLD_MS and sent as one: publishing a monitor
// run puts eight visits on a tech in a few seconds, and that is one push
// ("8 visits assigned"), not eight.

const HOLD_MS = 15000;
const RETRY_MS = 10 * 60 * 1000;
const LIVE = ['scheduled', 'in_progress'];

function isoDay(d) { return d.toISOString().slice(0, 10); }
/** Yesterday (UTC): visits dated before it are history and never push. */
function staleBefore(now = new Date()) { return isoDay(new Date(now.getTime() - 24 * 3600 * 1000)); }

/** What the people on a visit know about it. */
function snapshot(v) {
  return {
    ids: [...new Set((v.assigned_to_ids || []).map(String))].sort(),
    status: v.status || 'scheduled',
    date: v.scheduled_date || null,
    start: v.slot_start_min == null ? null : Number(v.slot_start_min),
    end: v.slot_end_min == null ? null : Number(v.slot_end_min),
  };
}

function sameSnapshot(a, b) { return !!a && !!b && JSON.stringify(a) === JSON.stringify(b); }

/**
 * Who to tell what, given the last snapshot (null = nobody was ever told) and
 * the row now. → [{ profileId, kind: 'assigned' | 'removed' | 'cancelled', when }]
 * where `when` is the snapshot the message's date and window come from (the old
 * one for a removal: that is the visit the person knew).
 */
function diffVisitPush(prev, cur, { now = new Date(), skipProfileId = null } = {}) {
  const out = [];
  if (!cur || !cur.date || cur.date < staleBefore(now)) return out;
  const prevLive = !!prev && LIVE.includes(prev.status);
  const prevIds = prevLive ? prev.ids || [] : [];
  if (LIVE.includes(cur.status)) {
    for (const id of cur.ids) if (!prevIds.includes(id)) out.push({ profileId: id, kind: 'assigned', when: cur });
    for (const id of prevIds) if (!cur.ids.includes(id)) out.push({ profileId: id, kind: 'removed', when: prev });
  } else if (cur.status === 'cancelled') {
    for (const id of prevIds) out.push({ profileId: id, kind: 'cancelled', when: prev });
  }
  const skip = skipProfileId ? String(skipProfileId) : null;
  return skip ? out.filter((e) => e.profileId !== skip) : out;
}

// ── Wording ─────────────────────────────────────────────────────────────────
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Tue, Nov 17" from a date-only string (no timezone involved). */
function dayLabel(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${DOW[d.getUTCDay()]}, ${MON[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function clock(min) {
  const h = Math.floor(min / 60) % 24, m = min % 60;
  return { text: `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''}`, ap: h < 12 ? 'AM' : 'PM' };
}
/** "8–10 AM", "11 AM–1 PM", "" when the visit has no window. */
function windowLabel(start, end) {
  if (start == null) return '';
  const a = clock(start);
  if (end == null || end <= start) return `${a.text} ${a.ap}`;
  const b = clock(end);
  return a.ap === b.ap ? `${a.text}–${b.text} ${b.ap}` : `${a.text} ${a.ap}–${b.text} ${b.ap}`;
}

const TYPE_NAMES = { inspection: 'Inspection', monitor: 'Monitor', demo: 'Demo', closeout: 'Closeout', testing: 'Testing' };
function typeName(v) {
  if (v.task_type === 'other') return (v.task_label && String(v.task_label).trim()) || 'Visit';
  return TYPE_NAMES[v.task_type] || 'Visit';
}
function jobName(v) {
  const j = v.jobs || {};
  return String(j.client_name || j.name || '').trim();
}

/** "Monitor · Smith Residence · Tue, Nov 17 · 8–10 AM" */
function visitLine(v, when) {
  return [typeName(v), jobName(v), dayLabel(when.date), windowLabel(when.start, when.end)].filter(Boolean).join(' · ');
}

const TITLES = { assigned: 'New visit assigned', removed: 'Taken off a visit', cancelled: 'Visit cancelled' };
const WORDS = { assigned: 'assigned', removed: 'reassigned to someone else', cancelled: 'cancelled' };

/** One queued item per (person, visit): what the push says and where a tap goes. */
function buildItem(event, v) {
  return {
    profileId: event.profileId,
    visitId: String(v.id),
    kind: event.kind,
    date: event.when.date,
    line: visitLine(v, event.when),
  };
}

/** The one push a person gets for everything held for them. */
function composePush(items) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return null;
  const dates = list.filter((i) => i.kind === 'assigned').map((i) => i.date).filter(Boolean).sort();
  const date = dates[0] || list.map((i) => i.date).filter(Boolean).sort()[0] || null;
  const data = { kind: 'visit', url: date ? `/schedule?date=${date}` : '/schedule' };
  if (list.length === 1) {
    return { title: TITLES[list[0].kind], body: list[0].line, data: { ...data, visit_id: list[0].visitId } };
  }
  const parts = ['assigned', 'removed', 'cancelled']
    .map((k) => { const n = list.filter((i) => i.kind === k).length; return n ? `${n} ${WORDS[k]}` : null; })
    .filter(Boolean);
  const days = [...new Set(list.map((i) => i.date).filter(Boolean))].sort();
  const dayPart = days.length === 1 ? dayLabel(days[0]) : days.length ? `${dayLabel(days[0])} – ${dayLabel(days[days.length - 1])}` : '';
  return { title: 'Schedule updated', body: [`${list.length} visits: ${parts.join(', ')}`, dayPart].filter(Boolean).join(' · '), data };
}

/**
 * createVisitPush({ push, sbGet, sbPatch }) → { onVisitSynced, flush }
 * `push` is the shared Expo sender (push.js).
 */
function createVisitPush({ push, sbGet, sbPatch, holdMs = HOLD_MS, log = console, now = () => new Date() } = {}) {
  const enc = encodeURIComponent;
  const held = new Map();   // profileId → { items: Map<visitId, item>, timer }
  let retryAt = 0;          // push_state column missing: look again after this

  async function sendFor(profileId) {
    const slot = held.get(profileId);
    if (!slot) return 0;
    held.delete(profileId);
    if (slot.timer) clearTimeout(slot.timer);
    const msg = composePush([...slot.items.values()]);
    if (!msg) return 0;
    try { return await push.toProfiles([profileId], msg, 'visit'); }
    catch (e) { log.warn('[visit push] send failed', e.message); return 0; }
  }

  function hold(item) {
    let slot = held.get(item.profileId);
    if (!slot) { slot = { items: new Map(), timer: null }; held.set(item.profileId, slot); }
    const before = slot.items.get(item.visitId);
    // Put on then taken off (or the reverse) inside the hold: nothing to say.
    if (before && ((before.kind === 'assigned' && item.kind !== 'assigned') || (before.kind !== 'assigned' && item.kind === 'assigned'))) {
      slot.items.delete(item.visitId);
    } else {
      slot.items.set(item.visitId, item);
    }
    if (slot.timer) clearTimeout(slot.timer);
    if (holdMs > 0) {
      slot.timer = setTimeout(() => { sendFor(item.profileId); }, holdMs);
      if (slot.timer.unref) slot.timer.unref();
    }
  }

  /** Send everything held now (tests, shutdown). */
  async function flush() {
    let n = 0;
    for (const id of [...held.keys()]) n += await sendFor(id);
    return n;
  }

  /**
   * Called with the visit row syncVisitJnTask just read (id, status, date,
   * window, assigned_to_ids, task_type, task_label, jobs). `actorId` is the
   * signed-in person who made the change, when known: they are not told about
   * their own edit. Never throws.
   */
  async function onVisitSynced(v, { actorId = null } = {}) {
    if (!v || !v.id || now().getTime() < retryAt) return { events: 0 };
    try {
      let rows;
      try { rows = await sbGet(`inspections?id=eq.${enc(String(v.id))}&select=push_state`); }
      catch (e) {
        retryAt = now().getTime() + RETRY_MS;
        log.warn('[visit push] inspections.push_state is missing (run supabase/add_visit_push.sql); schedule pushes are off, checking again in 10 minutes.');
        return { events: 0, disabled: true };
      }
      if (!rows || !rows[0]) return { events: 0 };
      const prev = rows[0].push_state || null;
      const cur = snapshot(v);
      if (sameSnapshot(prev, cur)) return { events: 0 };
      const events = diffVisitPush(prev, cur, { now: now(), skipProfileId: actorId });
      // Snapshot first: a crash between the two loses a push, never doubles one.
      await sbPatch('inspections', `id=eq.${enc(String(v.id))}`, { push_state: cur });
      for (const e of events) hold(buildItem(e, v));
      if (holdMs <= 0) await flush();
      return { events: events.length };
    } catch (e) {
      log.warn('[visit push] failed', v.id, e.message);
      return { events: 0, error: e.message };
    }
  }

  return { onVisitSynced, flush };
}

module.exports = createVisitPush;
module.exports.createVisitPush = createVisitPush;
module.exports.snapshot = snapshot;
module.exports.diffVisitPush = diffVisitPush;
module.exports.composePush = composePush;
module.exports.buildItem = buildItem;
module.exports.visitLine = visitLine;
module.exports.windowLabel = windowLabel;
module.exports.dayLabel = dayLabel;
