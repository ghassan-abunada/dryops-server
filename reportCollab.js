'use strict';
// ── Shared report drafts (several technicians on one visit report) ───────────
// The first technician to open a visit's report is the LEAD: they answer the
// general questions and submit. Anyone who opens it after works on rooms only.
// A room belongs to whoever opened it first; another technician can take it
// over. Every piece is its own row in visit_report_parts so two phones never
// overwrite each other:
//   lead            owner = the lead technician
//   top             data.v = the report without its rooms (lead only)
//   room:<key>      data.v = one room, owner = who is working on it, done
//   tech:<id>       presence (who has the report open)
//   crew            written at submit: who did which rooms (for the JN note)
// Schema: DryOps supabase/add_report_collab.sql. Twin of the app's
// components/flow/collab.ts.

const ROOM_KEY_RE = /^[^\u0000-\u001f]{1,80}$/;
const MAX_ROOMS = 40;
const MAX_PART_BYTES = 48 * 1024;
const PRESENCE_MS = 3 * 60 * 1000;

const sameInstant = (a, b) => {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const x = Date.parse(a), y = Date.parse(b);
  return Number.isFinite(x) && Number.isFinite(y) ? x === y : String(a) === String(b);
};

/** Who did which rooms, from the parts of a finished draft. Pure. */
function crewFromParts(parts) {
  const lead = parts.find((p) => p.part_key === 'lead');
  const by = new Map();
  const add = (id, name) => { const k = String(id || name || ''); if (!k) return null; if (!by.has(k)) by.set(k, { name: name || 'Technician', lead: false, rooms: [] }); return by.get(k); };
  if (lead && lead.owner_id) { const l = add(lead.owner_id, lead.owner_name); if (l) l.lead = true; }
  for (const p of parts) {
    if (!p.part_key.startsWith('room:') || p.removed || !p.owner_id) continue;
    const who = add(p.owner_id, p.owner_name);
    const name = p.data && p.data.v && p.data.v.name ? String(p.data.v.name) : p.part_key.slice(5);
    if (who) who.rooms.push(name);
  }
  return [...by.values()];
}

/** "Crew: Jace (lead) — Kitchen, Bath · Kyson — Hallway"; '' for a solo report. Pure. */
function crewLine(crew) {
  if (!Array.isArray(crew) || crew.length < 2) return '';
  return 'Crew: ' + crew.map((c) => `${c.name}${c.lead ? ' (lead)' : ''}${c.rooms && c.rooms.length ? ` — ${c.rooms.join(', ')}` : ''}`).join(' · ');
}

module.exports = function createReportCollab(deps) {
  const { SUPABASE_URL, SB_JSON_HEADERS, sbGet } = deps;
  const enc = encodeURIComponent;
  const base = `${SUPABASE_URL}/rest/v1/visit_report_parts`;

  async function insertIgnore(row) {
    const r = await fetch(`${base}?on_conflict=visit_id,part_key`, { method: 'POST', headers: { ...SB_JSON_HEADERS, Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(row) });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 300)}`);
  }
  async function upsert(row) {
    const r = await fetch(`${base}?on_conflict=visit_id,part_key`, { method: 'POST', headers: { ...SB_JSON_HEADERS, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row) });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 300)}`);
  }
  /** PATCH rows matching `filter`; returns how many changed. */
  async function patchWhere(filter, patch) {
    const r = await fetch(`${base}?${filter}`, { method: 'PATCH', headers: { ...SB_JSON_HEADERS, Prefer: 'return=representation' }, body: JSON.stringify(patch) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${r.status} ${text.slice(0, 300)}`);
    try { const rows = JSON.parse(text); return Array.isArray(rows) ? rows.length : 0; } catch { return 0; }
  }
  async function removeWhere(filter) {
    const r = await fetch(`${base}?${filter}`, { method: 'DELETE', headers: { ...SB_JSON_HEADERS, Prefer: 'return=minimal' } });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 300)}`);
  }
  const partsOf = async (visitId) => (await sbGet(`visit_report_parts?visit_id=eq.${enc(visitId)}&select=part_key,data,owner_id,owner_name,done,removed,updated_at`)) || [];

  const okKey = (k) => typeof k === 'string' && ROOM_KEY_RE.test(k);
  const small = (v) => { try { return JSON.stringify(v).length <= MAX_PART_BYTES; } catch { return false; } };
  const steps = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 400).map((x) => x.slice(0, 160)) : []);

  /**
   * One round trip: apply what this technician changed, return everyone's state.
   * `visit` needs id, task_type, report_submitted_at, demo_report_submitted_at.
   */
  async function sync({ visit, actor, body }) {
    const b = body && typeof body === 'object' ? body : {};
    const visitId = String(visit.id);
    const me = String(actor.id || '');
    if (!me) return { status: 403, body: { error: 'Unknown technician' } };
    const submittedAt = visit.task_type === 'demo' ? visit.demo_report_submitted_at : visit.report_submitted_at;
    // Someone submitted since this phone loaded the visit: the draft is over.
    if (!sameInstant(submittedAt || null, b.base || null) && submittedAt && (!b.base || Date.parse(submittedAt) > Date.parse(b.base))) {
      return { status: 200, body: { ok: true, submitted: { at: submittedAt, by: visit.task_type === 'demo' ? visit.demo_report_by_name : visit.report_by_name } } };
    }
    const now = new Date().toISOString();
    const where = (key) => `visit_id=eq.${enc(visitId)}&part_key=eq.${enc(key)}`;
    const rejected = [];

    await upsert({ visit_id: visitId, part_key: `tech:${me}`, owner_id: me, owner_name: actor.name, data: {}, updated_at: now });

    // Lead: first in wins; anyone can take it over on purpose.
    await insertIgnore({ visit_id: visitId, part_key: 'lead', owner_id: me, owner_name: actor.name, data: {}, updated_at: now });
    if (b.take_lead === true) await patchWhere(where('lead'), { owner_id: me, owner_name: actor.name, updated_at: now });
    let parts = await partsOf(visitId);
    const lead = parts.find((p) => p.part_key === 'lead');
    const isLead = !!lead && String(lead.owner_id) === me;

    if (isLead && b.top && typeof b.top === 'object' && small(b.top.data)) {
      await upsert({ visit_id: visitId, part_key: 'top', owner_id: me, owner_name: actor.name, data: { v: b.top.data, steps: steps(b.top.steps) }, updated_at: now });
    }

    const roomCount = parts.filter((p) => p.part_key.startsWith('room:')).length;
    let added = 0;
    for (const a of Array.isArray(b.add_rooms) ? b.add_rooms.slice(0, MAX_ROOMS) : []) {
      if (!a || !okKey(a.key) || !small(a.data)) continue;
      if (roomCount + added >= MAX_ROOMS) break;
      await insertIgnore({ visit_id: visitId, part_key: `room:${a.key}`, data: { v: a.data, steps: steps(a.steps) }, updated_at: now });
      if (a.readd === true) await patchWhere(`${where(`room:${a.key}`)}&removed=is.true`, { removed: false, done: false, owner_id: null, owner_name: null, data: { v: a.data, steps: steps(a.steps) }, updated_at: now });
      added += 1;
    }

    for (const c of Array.isArray(b.claims) ? b.claims.slice(0, MAX_ROOMS) : []) {
      if (!c || !okKey(c.key)) continue;
      const key = `room:${c.key}`;
      if (small(c.data)) await insertIgnore({ visit_id: visitId, part_key: key, data: { v: c.data, steps: steps(c.steps) }, updated_at: now });
      const free = c.force === true ? '' : `&or=(owner_id.is.null,owner_id.eq.${enc(me)})`;
      const n = await patchWhere(`${where(key)}${free}`, { owner_id: me, owner_name: actor.name, removed: false, done: false, updated_at: now });
      if (!n) {
        const cur = (await sbGet(`visit_report_parts?${where(key)}&select=owner_id,owner_name`)) || [];
        rejected.push({ key: c.key, reason: 'claimed', owner_name: (cur[0] && cur[0].owner_name) || 'another technician' });
      }
    }

    for (const r of Array.isArray(b.rooms) ? b.rooms.slice(0, MAX_ROOMS) : []) {
      if (!r || !okKey(r.key) || !small(r.data)) continue;
      const n = await patchWhere(`${where(`room:${r.key}`)}&owner_id=eq.${enc(me)}&removed=is.false`, { data: { v: r.data, steps: steps(r.steps) }, done: r.done === true, updated_at: now });
      if (!n) {
        const cur = (await sbGet(`visit_report_parts?${where(`room:${r.key}`)}&select=owner_id,owner_name,removed`)) || [];
        rejected.push({ key: r.key, reason: cur[0] && cur[0].removed ? 'removed' : 'taken', owner_name: (cur[0] && cur[0].owner_name) || null });
      }
    }

    for (const k of Array.isArray(b.removes) ? b.removes.slice(0, MAX_ROOMS) : []) {
      if (!okKey(k)) continue;
      const n = await patchWhere(`${where(`room:${k}`)}&or=(owner_id.is.null,owner_id.eq.${enc(me)})`, { removed: true, owner_id: null, owner_name: null, done: false, updated_at: now });
      if (!n) {
        const cur = (await sbGet(`visit_report_parts?${where(`room:${k}`)}&select=owner_name`)) || [];
        if (cur[0]) rejected.push({ key: k, reason: 'claimed', owner_name: cur[0].owner_name || 'another technician' });
      }
    }

    parts = await partsOf(visitId);
    return { status: 200, body: { ok: true, ...stateFromParts(parts, me), rejected } };
  }

  function stateFromParts(parts, me) {
    const lead = parts.find((p) => p.part_key === 'lead') || null;
    const top = parts.find((p) => p.part_key === 'top') || null;
    const cutoff = Date.now() - PRESENCE_MS;
    return {
      me,
      lead: lead ? { id: String(lead.owner_id), name: lead.owner_name } : null,
      top: top ? { data: top.data && top.data.v, steps: (top.data && top.data.steps) || [], updated_at: top.updated_at } : null,
      rooms: parts.filter((p) => p.part_key.startsWith('room:')).map((p) => ({
        key: p.part_key.slice(5), data: p.data && p.data.v, steps: (p.data && p.data.steps) || [],
        owner_id: p.owner_id ? String(p.owner_id) : null, owner_name: p.owner_name || null, done: p.done === true, removed: p.removed === true, updated_at: p.updated_at,
      })),
      techs: parts.filter((p) => p.part_key.startsWith('tech:')).map((p) => ({ id: String(p.owner_id), name: p.owner_name, active: Date.parse(p.updated_at) >= cutoff })),
    };
  }

  /** At submit: remember who did what, then clear the draft so a later edit starts clean. */
  async function finish(visitId) {
    const parts = await partsOf(visitId);
    const crew = crewFromParts(parts);
    await removeWhere(`visit_id=eq.${enc(visitId)}&part_key=neq.crew`);
    await upsert({ visit_id: visitId, part_key: 'crew', data: { v: crew }, updated_at: new Date().toISOString() });
    return crew;
  }
  async function crewFor(visitId) {
    const rows = (await sbGet(`visit_report_parts?visit_id=eq.${enc(visitId)}&part_key=eq.crew&select=data`)) || [];
    return rows[0] && rows[0].data && Array.isArray(rows[0].data.v) ? rows[0].data.v : [];
  }

  return { sync, finish, crewFor, stateFromParts };
};
module.exports.crewFromParts = crewFromParts;
module.exports.crewLine = crewLine;
