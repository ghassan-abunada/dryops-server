'use strict';
// ── Scope writer ─────────────────────────────────────────────────────────────
// Turns a saved visit report into the drying-log rows the Scope tab and the
// scope sheet read: moisture_sessions / moisture_readings, atmospheric_readings,
// equipment_checks, equipment placed / pulled, rooms.dry_on. Idempotent by
// natural keys (one session per job per day; readings on (session, material);
// checks on (session, equipment); atmospherics replaced per session) so a
// re-submitted report never duplicates rows. Schema: DryOps
// supabase/add_visit_reports.sql.

const { gpp } = require('./psychrometrics');
const { isDehu } = require('./visitReports');

module.exports = function createScopeWriter(deps) {
  const { SUPABASE_URL, SB_JSON_HEADERS, sbGet, sbInsert, sbPatch, sbUpsert } = deps;
  const enc = encodeURIComponent;

  async function sbDelete(table, filterQuery) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filterQuery}`, { method: 'DELETE', headers: { ...SB_JSON_HEADERS, Prefer: 'return=minimal' } });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 300)}`);
  }
  async function sbInsertMany(table, rows) {
    if (!rows.length) return;
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, { method: 'POST', headers: { ...SB_JSON_HEADERS, Prefer: 'return=minimal' }, body: JSON.stringify(rows) });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 300)}`);
  }

  /** The job's session for `date`, created when missing. */
  async function sessionFor(jobId, date, actorId) {
    const rows = await sbGet(`moisture_sessions?job_id=eq.${enc(jobId)}&session_date=eq.${enc(date)}&select=id&order=created_at&limit=1`);
    if (rows && rows[0]) return rows[0].id;
    const made = await sbInsert('moisture_sessions', { job_id: jobId, session_date: date, logged_by: actorId || null });
    if (made && made.id) return made.id;
    const again = await sbGet(`moisture_sessions?job_id=eq.${enc(jobId)}&session_date=eq.${enc(date)}&select=id&limit=1`);
    return again && again[0] ? again[0].id : null;
  }

  /** Room id for a report room, creating the room when it is new to the job. */
  async function roomIdFor(jobId, room, cache) {
    if (room.room_id) return room.room_id;
    const key = String(room.name || '').trim().toLowerCase();
    if (!key) return null;
    if (cache.has(key)) return cache.get(key);
    const rows = await sbGet(`rooms?job_id=eq.${enc(jobId)}&select=id,name`);
    const hit = (rows || []).find((r) => String(r.name || '').trim().toLowerCase() === key);
    let id = hit ? hit.id : null;
    if (!id) {
      const made = await sbInsert('rooms', { job_id: jobId, name: String(room.name).trim(), sort_order: (rows || []).length });
      id = made && made.id ? made.id : null;
    }
    cache.set(key, id);
    return id;
  }

  /**
   * Apply a monitor report. `when(hhmm)` → ISO timestamp on the visit date in
   * the job's timezone (null when the time is unknown). Returns a short
   * summary of what was written; throws on a hard failure (caller logs it and
   * still returns the saved report).
   */
  async function applyMonitorReport({ visit, report, actor, when }) {
    const jobId = visit.job_id;
    if (!jobId) return { skipped: 'no job' };
    const date = report.session_date;
    const sessionId = await sessionFor(jobId, date, actor && actor.id);
    if (!sessionId) throw new Error('could not create the moisture session');
    const roomCache = new Map();
    const out = { session_id: sessionId, readings: 0, atmospherics: 0, checks: 0, pulled: 0, placed: 0, rooms_dry: 0 };

    const readings = [];
    const atmos = [];
    const checks = [];
    if (report.outside && report.outside.temp_f != null && report.outside.rh != null) {
      atmos.push({ job_id: jobId, session_id: sessionId, room_id: null, equipment_id: null, kind: 'outside', temp_f: report.outside.temp_f, rh: report.outside.rh, gpp: gpp(report.outside.temp_f, report.outside.rh) });
    }
    for (const room of report.rooms || []) {
      const roomId = await roomIdFor(jobId, room, roomCache);
      if (!roomId) continue;
      if (room.reading && room.reading.temp_f != null && room.reading.rh != null) {
        atmos.push({ job_id: jobId, session_id: sessionId, room_id: roomId, equipment_id: null, kind: 'room', temp_f: room.reading.temp_f, rh: room.reading.rh, gpp: gpp(room.reading.temp_f, room.reading.rh) });
      }
      for (const m of room.materials || []) {
        if (m.material_id && m.mc != null) readings.push({ session_id: sessionId, material_id: m.material_id, mc_value: m.mc });
      }
      // Equipment: confirmations, pulls (whole or split), additions.
      const dehuIds = [];
      for (const e of room.equipment || []) {
        if (e.equipment_id) {
          checks.push({ session_id: sessionId, equipment_id: e.equipment_id, qty_present: e.qty_present });
          if (isDehu(e.type)) for (let i = 0; i < e.qty_present; i++) dehuIds.push(e.equipment_id);
          if (e.qty_present < e.qty_before) {
            const pulled = e.qty_before - e.qty_present;
            out.pulled += pulled;
            if (e.qty_present === 0) {
              await sbPatch('equipment', `id=eq.${enc(e.equipment_id)}`, { removed_on: date, removed_at: when(report.arrival_time) });
            } else {
              const cur = (await sbGet(`equipment?id=eq.${enc(e.equipment_id)}&select=room_id,type,label,placed_on,placed_at`)) || [];
              const row = cur[0] || {};
              await sbPatch('equipment', `id=eq.${enc(e.equipment_id)}`, { qty: e.qty_present });
              await sbInsert('equipment', { room_id: row.room_id || roomId, type: row.type || e.type, label: row.label || null, qty: pulled, placed_on: row.placed_on || null, placed_at: row.placed_at || null, removed_on: date, removed_at: when(report.arrival_time) });
            }
          } else if (e.qty_present > e.qty_before) {
            out.placed += e.qty_present - e.qty_before;
            await sbPatch('equipment', `id=eq.${enc(e.equipment_id)}`, { qty: e.qty_present });
          }
        } else if (e.qty_present > 0) {
          out.placed += e.qty_present;
          const made = await sbInsert('equipment', { room_id: roomId, type: e.type, qty: e.qty_present, placed_on: date, placed_at: when(report.departure_time || report.arrival_time) });
          if (made && made.id) {
            checks.push({ session_id: sessionId, equipment_id: made.id, qty_present: e.qty_present });
            if (isDehu(e.type)) for (let i = 0; i < e.qty_present; i++) dehuIds.push(made.id);
          }
        }
      }
      (room.dehu_outlets || []).forEach((o, i) => {
        if (o && o.temp_f != null && o.rh != null) {
          atmos.push({ job_id: jobId, session_id: sessionId, room_id: roomId, equipment_id: dehuIds[i] || null, kind: 'dehu_outlet', temp_f: o.temp_f, rh: o.rh, gpp: gpp(o.temp_f, o.rh) });
        }
      });
      if (room.dry === true) {
        out.rooms_dry += 1;
        await sbPatch('rooms', `id=eq.${enc(roomId)}&dry_on=is.null`, { dry_on: date }).catch(() => {});
      }
    }
    if (readings.length) { await sbUpsert('moisture_readings', readings, 'session_id,material_id'); out.readings = readings.length; }
    await sbDelete('atmospheric_readings', `session_id=eq.${enc(sessionId)}`);
    await sbInsertMany('atmospheric_readings', atmos); out.atmospherics = atmos.length;
    if (checks.length) { await sbUpsert('equipment_checks', checks, 'session_id,equipment_id'); out.checks = checks.length; }
    return out;
  }

  return { applyMonitorReport, sessionFor, roomIdFor };
};
