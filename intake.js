'use strict';
// ── New Job intake (DryOps app → JobNimbus) ───────────────────────────────────
// Mounted from server.js. Owns:
//   POST /jobs/create                         contact → job → note → local rows → visit → notifications
//   POST /visits/:id/scheduled-note           "Inspection scheduled" note tagging the assigned people
//   GET  /admin/jn/sources                    JobNimbus lead sources (account/settings → sources)
//   GET  /admin/locations/:id/jn-name-suffixes[?apply=1&force=1]   10-newest-jobs survey
//   POST /admin/locations/backfill-job-setup  survey every location (background) + GET …/status
//   POST /admin/notifications/channels/:id/test
//   GET  /admin/calls/:callrailId/callrail    raw CallRail call (verify call_summary access)
//   POST /admin/calls/post-activities         run the CallRail → JN "Phone Call" sweep now
//
// JobNimbus facts this relies on (verified 2026-10-09):
//   * contacts are the parent record; jobs carry primary:{id,type:'contact'} + related
//   * contact.display_name must be unique account-wide (JN rejects duplicates)
//   * lead sources cannot be created through the API — only read from
//     GET /account/settings (sources[] {JobSourceId, SourceName, IsActive})
//   * owners:[{id:<jn user id>}], sales_rep:<jn user id>, location:{id}, source:<JobSourceId>
//   * activities default to location 1 unless location/primary are set
// Knobs: JN_INTAKE_DRYRUN=1 logs JN writes instead of sending; JN_INTAKE_REDIRECT_LOCATION=<jn id>
// forces every created record into one test JN location.

const crypto = require('crypto');

module.exports = function mountIntake(app, deps) {
  const {
    SUPABASE_URL, SUPABASE_SERVICE_KEY, WEB_APP_URL,
    requireAuth, requireAdmin,
    sbGet, sbInsert, sbPatch, sbUpsert,
    jnSendJson, jnGetJson, jnAddNote, jnFetchAccountUsers,
    geocode, normPhone, toE164, UUID_RE, EMAIL_RE,
    callrailApi, CALLRAIL_ACCOUNT_IDS, CALLRAIL_API_KEY,
    syncVisitJnTask, loadScheduleSettings, fmtMin,
  } = deps;

  const DRYRUN = process.env.JN_INTAKE_DRYRUN === '1';
  const REDIRECT_LOCATION = Number(process.env.JN_INTAKE_REDIRECT_LOCATION || 0) || null;
  const APP_URL = (WEB_APP_URL || 'https://dryops.app').replace(/\/$/, '');
  const RECORD_TYPES = ['Mitigation', 'Contents', 'Rebuild'];
  const TYPE_CODE = { Mitigation: 'MIT', Contents: 'CON', Rebuild: 'REB' };
  const LEAD_TYPES = ['Google', 'Plumber', 'Internal Referral', 'External MIT Company', 'Other'];
  const DUP_NAME_RE = /display.?name|duplicate|already exists|already in use/i;
  const TRAILING_PAREN_RE = /\(([^()]*)\)\s*$/;
  const CITY_ABBR_OVERRIDES = {
    'fort worth': 'FTW', 'oklahoma city': 'OKC', 'kansas city': 'KC', 'salt lake city': 'SLC',
    'little rock': 'LR', 'san antonio': 'SA', 'los angeles': 'LA', 'las vegas': 'LV',
    'new york': 'NYC', 'st. louis': 'STL', 'saint louis': 'STL', 'el paso': 'ELP',
  };

  const log = (...a) => console.log('[intake]', ...a);
  const warn = (...a) => console.warn('[intake]', ...a);
  const enc = encodeURIComponent;

  // ── JobNimbus account caches ──────────────────────────────────────────────
  let settingsCache = { at: 0, data: null };
  async function jnAccountSettings(force = false) {
    if (!force && settingsCache.data && Date.now() - settingsCache.at < 10 * 60 * 1000) return settingsCache.data;
    const j = await jnGetJson('account/settings');
    const data = {
      sources: (Array.isArray(j && j.sources) ? j.sources : []).map((s) => ({
        id: Number(s.JobSourceId), name: String(s.SourceName || '').trim(), active: s.IsActive !== false,
      })).filter((s) => s.id && s.name),
      workflows: (Array.isArray(j && j.workflows) ? j.workflows : []).map((w) => ({
        id: Number(w.id), name: String(w.name || '').trim(), object_type: w.object_type, active: w.is_active !== false,
      })),
      locations: (Array.isArray(j && j.locations) ? j.locations : []).map((l) => ({
        id: Number(l.id), name: String(l.name || '').trim(), city: String(l.city || '').trim(), state: String(l.state_text || '').trim(),
      })),
    };
    settingsCache = { at: Date.now(), data };
    return data;
  }
  function workflowId(settings, objectType, name) {
    const hit = settings.workflows.find((w) => w.object_type === objectType && w.name.toLowerCase() === String(name).toLowerCase());
    return hit ? hit.id : null;
  }

  let usersCache = { at: 0, map: null };
  // id → { name, mention } where mention is JobNimbus' plain-text "@FirstLast".
  async function jnUsersById(force = false) {
    if (!force && usersCache.map && Date.now() - usersCache.at < 10 * 60 * 1000) return usersCache.map;
    const users = await jnFetchAccountUsers();
    const map = new Map();
    for (const [id, u] of users) {
      const name = String(u.name || '').trim();
      map.set(String(id), { name, mention: name ? '@' + name.replace(/\s+/g, '') : null, active: u.active });
    }
    usersCache = { at: Date.now(), map };
    return map;
  }

  // ── Actor / permissions ───────────────────────────────────────────────────
  async function loadActor(req) {
    const rows = await sbGet(`profiles?id=eq.${enc(req.userId)}&select=id,role,full_name,location_id,location_ids,jn_user_id,app_roles(permissions)`);
    const p = rows && rows[0];
    if (!p) return null;
    const locs = Array.isArray(p.location_ids) && p.location_ids.length ? p.location_ids : (p.location_id ? [p.location_id] : []);
    const perms = (p.app_roles && p.app_roles.permissions) || {};
    return { id: String(p.id), role: p.role, name: p.full_name || 'DryOps', jn_user_id: p.jn_user_id || null, locs: locs.map(String), perms };
  }
  function canCreateAt(actor, locationId) {
    if (actor.role === 'admin') return true;
    const member = actor.locs.includes(String(locationId));
    if (!member) return false;
    if (actor.role === 'owner') return true;
    return actor.perms && actor.perms.create_jobs === true;
  }
  function canManageLocation(actor, locationId) {
    return actor.role === 'admin' || (actor.role === 'owner' && actor.locs.includes(String(locationId)));
  }

  // ── Small helpers ─────────────────────────────────────────────────────────
  const clean = (v, max = 200) => (v === undefined || v === null ? '' : String(v)).trim().slice(0, max);
  const titleCase = (s) => clean(s).replace(/\s+/g, ' ');
  function zoned(dateMs, tz, opts) {
    try { return new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/Chicago', ...opts }).format(new Date(dateMs)); }
    catch { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', ...opts }).format(new Date(dateMs)); }
  }
  function zonedStamp(dateMs, tz) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'America/Chicago', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(dateMs)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  }
  function fmtLongDate(iso) {
    const [y, m, d] = String(iso).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  }
  function windowLabel(slot) {
    if (!slot || slot.start_min == null || slot.end_min == null) return 'Anytime';
    return `${fmtMin(slot.start_min)}–${fmtMin(slot.end_min)}`;
  }
  function parsePgError(err) {
    // sbInsert throws Error("400 {json}") — surface the trigger message + details.
    const m = /^\d{3}\s+(\{.*\})/s.exec(String(err && err.message || ''));
    if (m) { try { const j = JSON.parse(m[1]); return { message: j.message || j.error || String(err.message), code: j.code || null, details: j.details || null }; } catch {} }
    return { message: String(err && err.message || err), code: null, details: null };
  }
  function jnErr(r) {
    return (r && r.body && (r.body.message || r.body.error || r.body.Message)) || (r && r.text) || `HTTP ${r && r.status}`;
  }
  async function jnWrite(method, path, body) {
    if (DRYRUN) { log('dryrun', method, path, JSON.stringify(body).slice(0, 600)); return { ok: true, status: 200, body: { jnid: `dryrun-${crypto.randomBytes(4).toString('hex')}` }, text: '' }; }
    return jnSendJson(method, path, body);
  }

  // ── Name uniqueness ───────────────────────────────────────────────────────
  async function nameTaken(kind, field, value) {
    // kind: 'contacts' | 'jobs'. Exact (case-insensitive) compare on top of JN's term filter.
    const filter = enc(JSON.stringify({ must: [{ term: { [field]: value } }] }));
    const r = await jnSendJson('GET', `${kind}?size=5&fields=jnid,${field}&filter=${filter}`);
    if (!r.ok) { warn('name check failed', kind, r.status, r.text); return false; }
    const rows = (r.body && (r.body.results || r.body.data)) || [];
    const want = value.trim().toLowerCase();
    return rows.some((x) => String(x[field] || '').trim().toLowerCase() === want);
  }
  function nameCandidates(base, suffix, abbr) {
    const b = base.trim();
    const out = [];
    if (suffix) out.push(`${b} ${suffix}`);
    if (abbr) {
      const a = `${b} (${abbr})`;
      if (!out.includes(a)) out.push(a);
      for (let n = 2; n <= 9; n++) out.push(`${a} ${n}`);
    } else {
      if (!out.length) out.push(b);
      for (let n = 2; n <= 9; n++) out.push(`${b} ${n}`);
    }
    return out;
  }
  async function pickFreeName(kind, field, candidates, skip = new Set()) {
    for (const c of candidates) {
      if (skip.has(c)) continue;
      if (!(await nameTaken(kind, field, c))) return c;
    }
    return null;
  }

  // ── Survey: suffixes / owners from the 10 newest jobs ─────────────────────
  function mostCommon(list, min = 1) {
    const counts = new Map();
    for (const x of list) if (x) counts.set(x, (counts.get(x) || 0) + 1);
    let best = null, n = 0;
    for (const [k, v] of counts) if (v > n) { best = k; n = v; }
    return n >= min ? { value: best, count: n } : null;
  }
  function cityAbbrFor(city) {
    const c = clean(city).toLowerCase();
    if (!c) return null;
    if (CITY_ABBR_OVERRIDES[c]) return CITY_ABBR_OVERRIDES[c];
    const letters = c.replace(/[^a-z]/g, '');
    return letters ? letters.slice(0, 3).toUpperCase() : null;
  }
  async function surveyLocation(loc) {
    const settings = await jnAccountSettings();
    const jnLocId = Number(loc.jn_location_id);
    const types = Array.from(new Set(['Mitigation', ...((loc.record_types || []).filter((t) => RECORD_TYPES.includes(t)))]));
    const detected = { city_abbr: null, contact_name_suffix: null, job_name_suffixes: {}, jn_default_owner_ids: [] };
    const samples = {}, counts = {};
    const allOwnerSets = [], contactSuffixes = [];
    for (const type of types) {
      const wfId = workflowId(settings, 'job', type);
      const must = [{ term: { 'location.id': jnLocId } }];
      if (wfId) must.push({ term: { record_type: wfId } });
      const filter = enc(JSON.stringify({ must }));
      const r = await jnSendJson('GET', `jobs?size=10&sort_field=date_created&sort_direction=desc&fields=jnid,name,owners,primary,record_type_name&filter=${filter}`);
      const rows = r.ok ? ((r.body && (r.body.results || r.body.data)) || []) : [];
      const named = rows.filter((j) => !wfId || j.record_type_name === type);
      samples[type] = named.map((j) => j.name).filter(Boolean);
      counts[type] = r.ok ? Number(r.body && r.body.count || named.length) : 0;
      const sufs = named.map((j) => { const m = TRAILING_PAREN_RE.exec(String(j.name || '')); return m ? `(${m[1].trim()})` : null; });
      const best = mostCommon(sufs, 3);
      if (best) detected.job_name_suffixes[type] = best.value;
      for (const j of named) {
        const pn = j.primary && j.primary.name;
        const m = pn ? TRAILING_PAREN_RE.exec(String(pn)) : null;
        contactSuffixes.push(m ? `(${m[1].trim()})` : null);
        const ids = (Array.isArray(j.owners) ? j.owners : []).map((o) => o && o.id).filter(Boolean).map(String).sort();
        if (ids.length) allOwnerSets.push(ids.join(','));
      }
    }
    const cs = mostCommon(contactSuffixes, 3);
    if (cs) detected.contact_name_suffix = cs.value;
    const os = mostCommon(allOwnerSets, 2);
    if (os) detected.jn_default_owner_ids = os.value.split(',');
    const mit = detected.job_name_suffixes.Mitigation || Object.values(detected.job_name_suffixes)[0] || '';
    const m = /\(\s*(?:[^()-]+?\s*-\s*)?([A-Za-z]{2,4})\s*-\s*(MIT|CON|REB|STR)\s*\)/i.exec(mit);
    if (m) detected.city_abbr = m[1].toUpperCase();
    else {
      const jl = settings.locations.find((l) => l.id === jnLocId);
      detected.city_abbr = cityAbbrFor(jl && jl.city) || null;
    }
    return { detected, samples, counts, types };
  }
  async function applySurvey(loc, detected, force) {
    const patch = { job_setup_detected_at: new Date().toISOString() };
    if (force || !loc.city_abbr) patch.city_abbr = detected.city_abbr || loc.city_abbr || null;
    if (force || !loc.contact_name_suffix) patch.contact_name_suffix = detected.contact_name_suffix || loc.contact_name_suffix || null;
    const cur = (loc.job_name_suffixes && typeof loc.job_name_suffixes === 'object') ? loc.job_name_suffixes : {};
    patch.job_name_suffixes = force ? { ...cur, ...detected.job_name_suffixes } : { ...detected.job_name_suffixes, ...cur };
    if (force || !(loc.jn_default_owner_ids || []).length) patch.jn_default_owner_ids = detected.jn_default_owner_ids.length ? detected.jn_default_owner_ids : (loc.jn_default_owner_ids || []);
    await sbPatch('locations', `id=eq.${enc(loc.id)}`, patch);
    return patch;
  }
  const LOC_SELECT = 'id,name,status,jn_location_id,location_type,timezone,jn_note_tag,record_types,city_abbr,contact_name_suffix,job_name_suffixes,jn_default_owner_ids,job_setup_detected_at,post_call_activities';
  async function loadLocation(id) {
    if (!UUID_RE.test(String(id))) return null;
    const rows = await sbGet(`locations?id=eq.${enc(id)}&select=${LOC_SELECT}`);
    return rows && rows[0] ? rows[0] : null;
  }

  app.get('/admin/jn/sources', requireAuth, requireAdmin, async (req, res) => {
    try {
      const s = await jnAccountSettings(req.query.refresh === '1');
      res.json({ sources: s.sources, cached_at: new Date(settingsCache.at).toISOString() });
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  app.get('/admin/locations/:id/jn-name-suffixes', requireAuth, requireAdmin, async (req, res) => {
    try {
      const actor = await loadActor(req);
      if (!actor || !canManageLocation(actor, req.params.id)) return res.status(403).json({ error: 'Not allowed' });
      const loc = await loadLocation(req.params.id);
      if (!loc) return res.status(404).json({ error: 'Location not found' });
      if (!loc.jn_location_id) return res.status(400).json({ error: 'Location has no JobNimbus location id' });
      const out = await surveyLocation(loc);
      let applied = null;
      if (req.query.apply === '1') applied = await applySurvey(loc, out.detected, req.query.force === '1');
      res.json({ ...out, applied });
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  let backfill = { running: false, started_at: null, finished_at: null, updated: [], skipped: [], failed: [] };
  app.post('/admin/locations/backfill-job-setup', requireAuth, requireAdmin, async (req, res) => {
    const actor = await loadActor(req);
    if (!actor || actor.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    if (backfill.running) return res.status(409).json({ error: 'Backfill already running', status: backfill });
    const force = !!(req.body && req.body.force);
    backfill = { running: true, started_at: new Date().toISOString(), finished_at: null, updated: [], skipped: [], failed: [] };
    res.json({ ok: true, started: true });
    (async () => {
      try {
        const locs = (await sbGet(`locations?select=${LOC_SELECT}&jn_location_id=not.is.null&order=name.asc`)) || [];
        for (const loc of locs) {
          if (!force && loc.job_setup_detected_at) { backfill.skipped.push(loc.name); continue; }
          try {
            const out = await surveyLocation(loc);
            const hasAny = out.detected.contact_name_suffix || Object.keys(out.detected.job_name_suffixes).length || out.detected.jn_default_owner_ids.length;
            if (!hasAny) { backfill.skipped.push(`${loc.name} (no recent jobs)`); continue; }
            const patch = await applySurvey(loc, out.detected, force);
            backfill.updated.push({ id: loc.id, name: loc.name, detected: out.detected, applied: patch });
          } catch (err) { backfill.failed.push({ name: loc.name, error: err.message }); }
          await new Promise((r) => setTimeout(r, 300));
        }
      } catch (err) { backfill.failed.push({ name: '*', error: err.message }); }
      finally { backfill.running = false; backfill.finished_at = new Date().toISOString(); log('backfill done', JSON.stringify({ updated: backfill.updated.length, skipped: backfill.skipped.length, failed: backfill.failed.length })); }
    })();
  });
  app.get('/admin/locations/backfill-job-setup/status', requireAuth, requireAdmin, (_req, res) => res.json(backfill));

  // ── Intake note text (fields with no JobNimbus mapping) ───────────────────
  function intakeNoteText(body, ctx) {
    const d = body.details || {};
    const lines = [`New ${body.record_type} job — intake from DryOps`];
    if (ctx.leadLabel) lines.push(`Lead source: ${ctx.leadLabel}`);
    if (body.property_type === 'commercial') lines.push(`Commercial · ${clean(body.contact.business_name)} — caller ${clean(body.contact.first_name)} ${clean(body.contact.last_name)}${body.contact.role ? ` (${clean(body.contact.role)})` : ''}`);
    if (body.caller) lines.push(`Caller: ${clean(body.caller.first_name)} ${clean(body.caller.last_name)} (${clean(body.caller.relationship) || 'not the homeowner'}) ${clean(body.caller.phone)}`.trim());
    if (d.cause_of_damage) lines.push(`Cause of Damage: ${clean(d.cause_of_damage, 500)}`);
    if (d.type_of_loss) lines.push(`Type of Loss: ${clean(d.type_of_loss)}`);
    if (d.rooms_affected) lines.push(`Rooms Affected: ${clean(d.rooms_affected)}`);
    if (typeof d.standing_water === 'boolean') lines.push(`Standing Water: ${d.standing_water ? 'Yes' : 'No'}`);
    if (Array.isArray(d.services) && d.services.length) lines.push(`Services: ${d.services.map((s) => clean(s)).join(', ')}`);
    if (d.scope_summary) lines.push(`Scope: ${clean(d.scope_summary, 1000)}`);
    if (d.areas_affected) lines.push(`Areas Affected: ${clean(d.areas_affected, 500)}`);
    if (ctx.referringJob) lines.push(`Referring job: ${ctx.referringJob}`);
    if (d.notes) lines.push(`Notes: ${clean(d.notes, 2000)}`);
    if (ctx.repName) lines.push(`Sales rep: ${ctx.repName}`);
    lines.push(`Entered by ${ctx.actorName}`);
    return lines.join('\n');
  }
  function contactDescription(body, tz) {
    const d = body.details || {};
    const lines = [];
    if (d.type_of_loss) lines.push(`CAT: ${clean(d.type_of_loss)}`);
    if (d.cause_of_damage) lines.push(`Cause of Loss: ${clean(d.cause_of_damage, 500)}`);
    if (d.date_loss) lines.push(`Date of Loss: ${clean(d.date_loss)}`);
    lines.push(`Date Contacted: ${zonedStamp(Date.now(), tz)}`);
    if (d.rooms_affected) lines.push(`Rooms Affected: ${clean(d.rooms_affected)}`);
    if (typeof d.standing_water === 'boolean') lines.push(`Needs Extraction: ${d.standing_water ? 'Yes' : 'No'}`);
    if (body.property_type === 'commercial') lines.push(`Caller: ${clean(body.contact.first_name)} ${clean(body.contact.last_name)}${body.contact.role ? ` (${clean(body.contact.role)})` : ''}`);
    if (body.caller) lines.push(`Caller: ${clean(body.caller.first_name)} ${clean(body.caller.last_name)} (${clean(body.caller.relationship) || 'caller'}) ${clean(body.caller.phone)}`.trim());
    return lines.join('\n');
  }

  // ── Validation ────────────────────────────────────────────────────────────
  function validate(body, loc) {
    const bad = (field, error) => ({ field, error });
    if (!body || typeof body !== 'object') return bad('body', 'Missing body');
    if (!UUID_RE.test(String(body.client_request_id || ''))) return bad('client_request_id', 'client_request_id must be a uuid');
    if (!RECORD_TYPES.includes(body.record_type)) return bad('record_type', 'record_type must be Mitigation, Contents or Rebuild');
    const enabled = (loc.record_types || []).length ? loc.record_types : ['Mitigation'];
    if (!enabled.includes(body.record_type)) return bad('record_type', `${loc.name} does not create ${body.record_type} jobs`);
    if (!['residential', 'commercial'].includes(body.property_type)) return bad('property_type', 'property_type must be residential or commercial');
    const c = body.contact || {};
    if (!body.link_contact_jn_id) {
      if (body.property_type === 'commercial' && !clean(c.business_name)) return bad('contact.business_name', 'Business name is required');
      if (!clean(c.first_name)) return bad('contact.first_name', 'First name is required');
      if (!toE164(c.phone)) return bad('contact.phone', 'A valid 10-digit phone is required');
      if (clean(c.email) && !EMAIL_RE.test(clean(c.email))) return bad('contact.email', 'Email looks invalid');
    }
    if (body.caller) {
      if (!clean(body.caller.first_name)) return bad('caller.first_name', 'Caller first name is required');
      if (!toE164(body.caller.phone)) return bad('caller.phone', 'Caller phone must be a valid 10-digit number');
      if (clean(body.caller.email) && !EMAIL_RE.test(clean(body.caller.email))) return bad('caller.email', 'Caller email looks invalid');
    }
    const a = body.address || {};
    if (!clean(a.street) && !clean(a.formatted)) return bad('address.street', 'Address is required');
    if (!body.lead || !UUID_RE.test(String(body.lead.lead_source_company_id || ''))) return bad('lead.lead_source_company_id', 'Pick a lead source');
    if (body.lead.lead_source_id && !UUID_RE.test(String(body.lead.lead_source_id))) return bad('lead.lead_source_id', 'Invalid referrer');
    if (body.lead.lead_type && !LEAD_TYPES.includes(body.lead.lead_type)) return bad('lead.lead_type', 'Invalid lead type');
    if (body.sales_rep_profile_id && !UUID_RE.test(String(body.sales_rep_profile_id))) return bad('sales_rep_profile_id', 'Invalid sales rep');
    if (body.referring_job_id && !UUID_RE.test(String(body.referring_job_id))) return bad('referring_job_id', 'Invalid referring job');
    const d = body.details || {};
    if (body.record_type === 'Mitigation') {
      if (!clean(d.cause_of_damage)) return bad('details.cause_of_damage', 'Cause of damage is required');
      if (typeof d.standing_water !== 'boolean') return bad('details.standing_water', 'Standing water: pick Yes or No');
    }
    if (body.record_type === 'Rebuild' && !clean(d.scope_summary)) return bad('details.scope_summary', 'Scope summary is required');
    if (d.date_loss && !/^\d{4}-\d{2}-\d{2}$/.test(String(d.date_loss))) return bad('details.date_loss', 'Date of loss must be YYYY-MM-DD');
    if (body.inspection) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.inspection.date || ''))) return bad('inspection.date', 'Inspection date must be YYYY-MM-DD');
      if (!body.sales_rep_profile_id) return bad('sales_rep_profile_id', 'Pick a sales rep to schedule the inspection');
      const s = body.inspection.slot;
      if (s && !(Number.isInteger(s.start_min) && Number.isInteger(s.end_min) && s.end_min > s.start_min)) return bad('inspection.slot', 'Invalid arrival window');
    }
    return null;
  }

  // ── The create sequence ───────────────────────────────────────────────────
  const inflight = new Map(); // client_request_id → promise
  async function createIntakeJob(body, actor) {
    const rid = String(body.client_request_id);
    const step = (s, extra) => log(rid, `step=${s}`, extra ? JSON.stringify(extra).slice(0, 300) : '');
    const warnings = [];
    const httpError = (status, code, error, extra) => Object.assign(new Error(error), { status, code, extra });

    // 1. load + validate
    const loc = await loadLocation(body.location_id);
    if (!loc) throw httpError(400, 'VALIDATION', 'Unknown location', { field: 'location_id' });
    if (!canCreateAt(actor, loc.id)) throw httpError(403, 'FORBIDDEN', 'You cannot create jobs at this location');
    const v = validate(body, loc);
    if (v) throw httpError(400, 'VALIDATION', v.error, { field: v.field });
    if (!loc.jn_location_id) throw httpError(400, 'VALIDATION', `${loc.name} has no JobNimbus location id (Settings → Locations)`, { field: 'location_id' });

    // 2. idempotency
    const prior = await sbGet(`jobs?intake_request_id=eq.${enc(rid)}&select=id,jn_id,name,jn_contact_id,client_name`);
    if (prior && prior[0]) {
      return { ok: true, replay: true, job: { id: prior[0].id, jn_id: prior[0].jn_id, name: prior[0].name }, contact: { jn_id: prior[0].jn_contact_id, display_name: prior[0].client_name }, visit: null, note: { ok: true, text: '' }, warnings: ['REPLAY'] };
    }

    const tz = loc.timezone || 'America/Chicago';
    const jnLocId = REDIRECT_LOCATION || Number(loc.jn_location_id);
    const settings = await jnAccountSettings();

    // lead source → JN source id (+ category fallback)
    const lsRows = await sbGet(`lead_source_companies?id=eq.${enc(body.lead.lead_source_company_id)}&select=id,name,company_type,lead_type,jn_source_id,jn_source_name,is_builtin,is_internal,location_id,status`);
    const lead = lsRows && lsRows[0];
    if (!lead) throw httpError(400, 'VALIDATION', 'Lead source not found', { field: 'lead.lead_source_company_id' });
    let jnSourceId = lead.jn_source_id ? Number(lead.jn_source_id) : null;
    if (!jnSourceId) {
      const fb = await sbGet(`lead_source_companies?is_builtin=eq.true&company_type=eq.${enc(lead.company_type || 'Other')}&jn_source_id=not.is.null&select=jn_source_id&limit=1`);
      jnSourceId = fb && fb[0] ? Number(fb[0].jn_source_id) : null;
      if (!jnSourceId) warnings.push('NO_JN_SOURCE');
    }
    if (jnSourceId && !settings.sources.some((s) => s.id === jnSourceId)) { warn(rid, 'jn source id not in account settings', jnSourceId); }
    const leadType = body.lead.lead_type || lead.lead_type || (lead.company_type === 'Plumber' ? 'Plumber' : lead.company_type === 'Google' ? 'Google' : 'Other');
    let leadLabel = lead.name;
    let leadPerson = null;
    if (body.lead.lead_source_id) {
      const lp = await sbGet(`lead_sources?id=eq.${enc(body.lead.lead_source_id)}&select=id,name`);
      leadPerson = lp && lp[0] ? lp[0] : null;
      if (leadPerson) leadLabel = `${lead.name} — ${leadPerson.name}`;
    }

    // sales rep
    let rep = null;
    if (body.sales_rep_profile_id) {
      const rr = await sbGet(`profiles?id=eq.${enc(body.sales_rep_profile_id)}&select=id,full_name,jn_user_id`);
      rep = rr && rr[0] ? rr[0] : null;
      if (!rep) throw httpError(400, 'VALIDATION', 'Sales rep not found', { field: 'sales_rep_profile_id' });
      if (!rep.jn_user_id) warnings.push('REP_NOT_LINKED');
    }

    // referring job (Contents/Rebuild linked to a mitigation job)
    let referringJob = null;
    if (body.referring_job_id) {
      const rj = await sbGet(`jobs?id=eq.${enc(body.referring_job_id)}&select=id,jn_id,name,jn_contact_id,client_name`);
      referringJob = rj && rj[0] ? rj[0] : null;
    }

    // 3. address + geocode
    const a = body.address || {};
    const street = clean(a.street) || clean(a.formatted);
    const addrParts = [street, clean(a.city), clean(a.state), clean(a.zip)].filter(Boolean);
    const addressText = clean(a.formatted) && !clean(a.city) ? clean(a.formatted) : addrParts.join(', ');
    let lat = Number(a.lat), lng = Number(a.lng);
    if (!(Number.isFinite(lat) && Number.isFinite(lng))) {
      const g = await geocode(addressText).catch(() => null);
      if (g) { lat = g.lat; lng = g.lng; } else { lat = null; lng = null; }
    }
    const geo = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lon: lng } : undefined;
    const jnAddress = { address_line1: street, city: clean(a.city) || undefined, state_text: clean(a.state) || undefined, zip: clean(a.zip) || undefined };

    const owners = (loc.jn_default_owner_ids || []).filter(Boolean).map((id) => ({ id: String(id) }));
    const abbr = clean(loc.city_abbr).toUpperCase() || null;
    const usedNames = new Set();

    // 4. contact
    let contactJnId = body.link_contact_jn_id ? String(body.link_contact_jn_id) : null;
    let contactDisplayName = null;
    let createdContact = false;
    const c = body.contact || {};
    const isCommercial = body.property_type === 'commercial';
    let base = isCommercial ? titleCase(c.business_name) : `${titleCase(c.first_name)} ${titleCase(c.last_name)}`.trim();

    if (contactJnId) {
      const r = await jnSendJson('GET', `contacts/${enc(contactJnId)}?fields=jnid,display_name,first_name,last_name,company,mobile_phone,email`);
      if (!r.ok || !r.body) throw httpError(400, 'VALIDATION', 'Linked contact not found in JobNimbus', { field: 'link_contact_jn_id' });
      contactDisplayName = r.body.display_name || base;
      if (!base) {
        // Job name base = the linked contact's name without its "(…)" suffix.
        base = `${titleCase(r.body.first_name)} ${titleCase(r.body.last_name)}`.trim()
          || titleCase(r.body.company) || String(r.body.display_name || '').replace(TRAILING_PAREN_RE, '').trim();
      }
      if (!c.first_name && r.body.first_name) { c.first_name = r.body.first_name; c.last_name = r.body.last_name || ''; c.phone = c.phone || r.body.mobile_phone || ''; c.email = c.email || r.body.email || ''; }
      step('contact-linked', { contactJnId });
    } else {
      const candidates = nameCandidates(base, clean(loc.contact_name_suffix), abbr);
      let name = await pickFreeName('contacts', 'display_name', candidates, usedNames);
      if (!name) throw httpError(409, 'JN_CONTACT', `Every name variant of "${base}" already exists in JobNimbus`);
      if (name !== candidates[0]) warnings.push('NAME_FALLBACK_USED');
      const contactType = workflowId(settings, 'contact', body.record_type) ? body.record_type : 'Mitigation';
      for (let attempt = 0; attempt < 5 && !contactJnId; attempt++) {
        const payload = {
          record_type_name: contactType, status_name: 'Lead',
          display_name: name,
          first_name: titleCase(c.first_name), last_name: titleCase(c.last_name),
          company: isCommercial ? titleCase(c.business_name) : '',
          mobile_phone: normPhone(c.phone) || undefined,
          email: clean(c.email) || undefined,
          ...jnAddress, geo,
          location: { id: jnLocId },
          source: jnSourceId || undefined,
          owners: owners.length ? owners : undefined,
          sales_rep: rep && rep.jn_user_id ? rep.jn_user_id : undefined,
          description: contactDescription(body, tz),
        };
        step('contact-create', { name, attempt });
        const r = await jnWrite('POST', 'contacts', payload);
        if (r.ok && r.body && (r.body.jnid || r.body.id)) { contactJnId = String(r.body.jnid || r.body.id); contactDisplayName = name; createdContact = true; break; }
        const msg = jnErr(r);
        if (r.status < 500 && DUP_NAME_RE.test(msg)) {
          usedNames.add(name);
          const next = await pickFreeName('contacts', 'display_name', candidates, usedNames);
          if (!next) throw httpError(409, 'JN_CONTACT', `Every name variant of "${base}" already exists in JobNimbus`);
          name = next; warnings.push('NAME_FALLBACK_USED');
          continue;
        }
        throw httpError(502, 'JN_CONTACT', `JobNimbus rejected the contact: ${msg}`, { jn_status: r.status, jn_message: msg });
      }
      if (!contactJnId) throw httpError(502, 'JN_CONTACT', 'JobNimbus did not return a contact id');
    }

    // 5. job
    const rollbackContact = async () => {
      if (!createdContact || !contactJnId) return;
      const del = await jnWrite('DELETE', `contacts/${enc(contactJnId)}`).catch(() => ({ ok: false }));
      if (!del.ok) await jnWrite('PUT', `contacts/${enc(contactJnId)}`, { is_active: false, description: 'DryOps: job creation failed — safe to delete' }).catch(() => {});
      step('contact-rollback', { contactJnId, deleted: !!del.ok });
    };
    const jobSuffix = clean((loc.job_name_suffixes || {})[body.record_type]) || (abbr ? `(${abbr} - ${TYPE_CODE[body.record_type]})` : '');
    const jobCandidates = nameCandidates(base, jobSuffix, abbr ? `${abbr} - ${TYPE_CODE[body.record_type]}` : null);
    let jobName = await pickFreeName('jobs', 'name', jobCandidates);
    if (!jobName) { await rollbackContact(); throw httpError(409, 'JN_JOB', `Every job name variant of "${base}" already exists in JobNimbus`); }
    const d = body.details || {};
    const dateLossUnix = d.date_loss ? Math.floor(Date.UTC(...String(d.date_loss).split('-').map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))), 12) / 1000) : undefined;
    let jobJnId = null;
    for (let attempt = 0; attempt < 5 && !jobJnId; attempt++) {
      const payload = {
        record_type_name: body.record_type, status_name: 'Lead',
        name: jobName,
        primary: { id: contactJnId, type: 'contact' },
        related: [{ id: contactJnId, type: 'contact' }],
        location: { id: jnLocId },
        source: jnSourceId || undefined,
        owners: owners.length ? owners : undefined,
        sales_rep: rep && rep.jn_user_id ? rep.jn_user_id : undefined,
        ...jnAddress, geo,
        cf_string_6: leadType,
        cf_string_7: clean(d.insurance_type) || undefined,
        cf_string_18: clean(d.type_of_loss) || undefined,
        cf_date_1: dateLossUnix,
        cf_string_2: clean(d.claim_number) || undefined,
        cf_string_9: clean(d.insurer) || undefined,
        cf_string_3: clean(d.adjuster_name) || undefined,
        cf_string_4: clean(d.adjuster_phone) || undefined,
        cf_string_5: clean(d.adjuster_email) || undefined,
      };
      step('job-create', { jobName, attempt });
      const r = await jnWrite('POST', 'jobs', payload);
      if (r.ok && r.body && (r.body.jnid || r.body.id)) { jobJnId = String(r.body.jnid || r.body.id); break; }
      const msg = jnErr(r);
      if (r.status < 500 && DUP_NAME_RE.test(msg)) {
        const skip = new Set([jobName]);
        const next = await pickFreeName('jobs', 'name', jobCandidates, skip);
        if (!next) { await rollbackContact(); throw httpError(409, 'JN_JOB', `Every job name variant of "${base}" already exists in JobNimbus`); }
        jobName = next; warnings.push('NAME_FALLBACK_USED');
        continue;
      }
      await rollbackContact();
      throw httpError(502, 'JN_JOB', `JobNimbus rejected the job: ${msg}`, { jn_status: r.status, jn_message: msg, partial: { contact_jn_id: createdContact ? null : contactJnId } });
    }
    if (!jobJnId) { await rollbackContact(); throw httpError(502, 'JN_JOB', 'JobNimbus did not return a job id'); }

    // 6. secondary caller contact (residential, caller ≠ homeowner)
    let callerJnId = null;
    if (body.caller) {
      const cb = `${titleCase(body.caller.first_name)} ${titleCase(body.caller.last_name)}`.trim();
      const cname = await pickFreeName('contacts', 'display_name', nameCandidates(cb, clean(loc.contact_name_suffix), abbr)).catch(() => null);
      if (cname) {
        const r = await jnWrite('POST', 'contacts', {
          record_type_name: workflowId(settings, 'contact', body.record_type) ? body.record_type : 'Mitigation', status_name: 'Lead',
          display_name: cname, first_name: titleCase(body.caller.first_name), last_name: titleCase(body.caller.last_name),
          mobile_phone: normPhone(body.caller.phone) || undefined, email: clean(body.caller.email) || undefined,
          location: { id: jnLocId }, owners: owners.length ? owners : undefined,
          description: `Relationship to homeowner: ${clean(body.caller.relationship) || 'unknown'}\nSecondary contact for ${jobName}`,
          related: [{ id: jobJnId, type: 'job' }, { id: contactJnId, type: 'contact' }],
        });
        if (r.ok && r.body && (r.body.jnid || r.body.id)) callerJnId = String(r.body.jnid || r.body.id);
        else { warnings.push('CALLER_CONTACT_FAILED'); warn(rid, 'caller contact failed', jnErr(r)); }
      } else warnings.push('CALLER_CONTACT_FAILED');
      step('caller-contact', { callerJnId });
    }

    // 7. intake note
    const noteText = intakeNoteText(body, { leadLabel, repName: rep && rep.full_name, actorName: actor.name, referringJob: referringJob && referringJob.name });
    let note = { ok: true, text: noteText };
    if (DRYRUN) log(rid, 'dryrun note', noteText.slice(0, 200));
    else {
      const nr = await jnAddNote(jobJnId, noteText, { jnLocationId: jnLocId, createdBy: actor.jn_user_id || undefined, tag: loc.jn_note_tag || undefined });
      note = { ok: !!nr.ok, text: noteText, id: nr.id || null, error: nr.error || null };
      if (!nr.ok) warnings.push('NOTE_FAILED');
    }
    step('note', { ok: note.ok });

    // 8. local rows
    let jobId = null;
    const row = {
      jn_id: jobJnId, name: jobName, client_name: contactDisplayName, client_phone: normPhone(c.phone) || null,
      address: addressText, lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null,
      record_type: body.record_type, status: 'Lead', is_active: true,
      location_id: loc.id, jn_location_id: Number(loc.jn_location_id), jn_contact_id: contactJnId,
      lead_type: leadType, insurance_type: clean(d.insurance_type) || null, cat: clean(d.type_of_loss) || null,
      date_loss: d.date_loss || null, claim_number: clean(d.claim_number) || null, insurer: clean(d.insurer) || null,
      adjuster_name: clean(d.adjuster_name) || null, adjuster_phone: clean(d.adjuster_phone) || null, adjuster_email: clean(d.adjuster_email) || null,
      sales_rep: rep ? rep.full_name : null, sales_rep_profile_id: rep ? rep.id : null,
      lead_source_company_id: lead.id, lead_source_id: leadPerson ? leadPerson.id : null,
      property_type: body.property_type, referring_job_id: referringJob ? referringJob.id : null,
      intake_request_id: rid, callrail_call_id: clean(body.callrail_call_id) || null,
      jn_created: new Date().toISOString(), jn_updated: new Date().toISOString(), last_synced: new Date().toISOString(),
    };
    try {
      await sbUpsert('jobs', row, 'jn_id');
      const jr = await sbGet(`jobs?jn_id=eq.${enc(jobJnId)}&select=id`);
      jobId = jr && jr[0] ? jr[0].id : null;
      if (jobId) {
        const contacts = [{
          job_id: jobId, jn_contact_id: contactJnId, is_primary: true,
          first_name: titleCase(c.first_name) || null, last_name: titleCase(c.last_name) || null,
          phone: normPhone(c.phone) || null, email: clean(c.email) || null,
          role: isCommercial ? (clean(c.role) || 'Business contact') : 'Home Owner', relationship: null,
        }];
        if (body.caller) contacts.push({
          job_id: jobId, jn_contact_id: callerJnId, is_primary: false,
          first_name: titleCase(body.caller.first_name) || null, last_name: titleCase(body.caller.last_name) || null,
          phone: normPhone(body.caller.phone) || null, email: clean(body.caller.email) || null,
          role: 'Caller', relationship: clean(body.caller.relationship) || null,
        });
        for (const ct of contacts) await sbInsert('job_contacts', ct).catch((e) => warn(rid, 'job_contacts insert', e.message));
        if (row.callrail_call_id) await sbPatch('calls', `callrail_id=eq.${enc(row.callrail_call_id)}`, { job_id: jobId }).catch(() => {});
      } else warnings.push('LOCAL_UPSERT_FAILED');
    } catch (err) { warn(rid, 'local upsert failed', err.message); warnings.push('LOCAL_UPSERT_FAILED'); }
    step('local', { jobId });

    // 9. visit (inspection) + scheduled note
    let visit = null;
    if (body.inspection && rep && jobId) {
      const slot = body.inspection.slot || null;
      const label = windowLabel(slot);
      try {
        const ins = await sbInsert('inspections', {
          job_id: jobId, jn_id: jobJnId, scheduled_date: body.inspection.date,
          slot_start_min: slot ? slot.start_min : null, slot_end_min: slot ? slot.end_min : null,
          scheduled_time: label, task_type: 'inspection', status: 'scheduled',
          assigned_to_ids: [rep.id], notes: null, location_id: loc.id, created_by: actor.id,
          block_kind: 'window', crew_size: null, jn_task_dirty: true,
        });
        if (ins && ins.id) {
          visit = { id: ins.id, date: body.inspection.date, window: label };
          syncVisitJnTask(ins.id).catch((e) => warn(rid, 'task sync', e.message));
          const sn = await postInspectionScheduledNote(ins.id, { loc, rep, jobJnId, jnLocId, date: body.inspection.date, label, actor }).catch((e) => ({ ok: false, error: e.message }));
          if (!sn.ok) warnings.push('SCHED_NOTE_FAILED');
        } else warnings.push('VISIT_FAILED');
      } catch (err) {
        const pe = parsePgError(err);
        warnings.push('VISIT_FAILED');
        visit = { id: null, error: pe.message, code: pe.code, conflicts: pe.details ? safeJson(pe.details) : null };
        warn(rid, 'visit failed', pe.message);
      }
    } else if (body.inspection && !jobId) warnings.push('VISIT_FAILED');
    step('visit', { visit: visit && visit.id });

    const result = {
      ok: true,
      job: { id: jobId, jn_id: jobJnId, name: jobName, jn_url: `https://app.jobnimbus.com/job/${jobJnId}` },
      contact: { jn_id: contactJnId, display_name: contactDisplayName, created: createdContact },
      caller_contact: body.caller ? { jn_id: callerJnId } : undefined,
      visit, note, warnings,
    };

    // 10. notifications + CallRail activity (fire and forget)
    notifyJobCreated({ loc, body, row, result, rep, leadLabel, actor }).catch((e) => warn(rid, 'notify', e.message));
    if (row.callrail_call_id && loc.post_call_activities) setTimeout(() => postCallActivities().catch(() => {}), 2000);
    return result;
  }
  function safeJson(v) { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } }

  app.post('/jobs/create', requireAuth, async (req, res) => {
    const rid = String((req.body && req.body.client_request_id) || '');
    try {
      const actor = await loadActor(req);
      if (!actor) return res.status(403).json({ error: 'Profile not found', code: 'FORBIDDEN' });
      let p = rid && inflight.get(rid);
      if (!p) {
        p = createIntakeJob(req.body || {}, actor);
        if (rid) { inflight.set(rid, p); p.finally(() => setTimeout(() => inflight.delete(rid), 30000)); }
      }
      const out = await p;
      res.json(out);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('[intake] error', rid, err.message);
      res.status(status).json({ error: err.message, code: err.code || 'ERROR', ...(err.extra || {}) });
    }
  });

  // ── "Inspection scheduled" note (tags everyone assigned, one per line) ─────
  async function postInspectionScheduledNote(visitId, ctx) {
    let { loc, rep, jobJnId, jnLocId, date, label, actor } = ctx || {};
    if (!loc) {
      const rows = await sbGet(`inspections?id=eq.${enc(visitId)}&select=id,jn_id,scheduled_date,slot_start_min,slot_end_min,assigned_to_ids,location_id,jobs(jn_id,jn_location_id)`);
      const v = rows && rows[0];
      if (!v) return { ok: false, error: 'Visit not found' };
      loc = await loadLocation(v.location_id || (v.jobs && v.jobs.location_id));
      jobJnId = v.jn_id || (v.jobs && v.jobs.jn_id);
      jnLocId = REDIRECT_LOCATION || (loc && loc.jn_location_id) || (v.jobs && v.jobs.jn_location_id);
      date = v.scheduled_date;
      label = windowLabel(v.slot_start_min == null ? null : { start_min: v.slot_start_min, end_min: v.slot_end_min });
      const reps = (await sbGet(`profiles?id=in.(${(v.assigned_to_ids || []).map(enc).join(',')})&select=id,full_name,jn_user_id`)) || [];
      rep = reps[0] || null;
      ctx = { ...ctx, reps };
    }
    if (!jobJnId) return { ok: false, error: 'No JobNimbus job' };
    const reps = ctx.reps || (rep ? [rep] : []);
    const who = reps.map((r) => r.full_name).filter(Boolean).join(' & ') || 'the sales rep';
    const text = `Inspection scheduled for ${fmtLongDate(date)}, ${label} with ${who}.`;
    const users = await jnUsersById().catch(() => new Map());
    const mentions = [];
    const push = (id) => { const u = id && users.get(String(id)); if (u && u.mention && !mentions.includes(u.mention)) mentions.push(u.mention); };
    for (const r of reps) push(r.jn_user_id);
    for (const id of (loc && loc.jn_default_owner_ids) || []) push(id);
    if (DRYRUN) { log('dryrun sched note', text, mentions.join(' ')); return { ok: true, id: 'dryrun' }; }
    const nr = await jnAddNote(jobJnId, text, { jnLocationId: jnLocId, createdBy: actor && actor.jn_user_id || undefined, tag: loc && loc.jn_note_tag || undefined, mentions });
    await sbPatch('inspections', `id=eq.${enc(visitId)}`, nr.ok ? { jn_sched_note_id: nr.id || 'ok', jn_sched_note_error: null } : { jn_sched_note_error: String(nr.error || 'failed').slice(0, 300) }).catch(() => {});
    return nr;
  }
  app.post('/visits/:id/scheduled-note', requireAuth, async (req, res) => {
    try {
      const actor = await loadActor(req);
      if (!actor || !['admin', 'owner'].includes(actor.role)) return res.status(403).json({ error: 'Not allowed' });
      const out = await postInspectionScheduledNote(String(req.params.id), { actor });
      res.json(out);
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  // ── Notifications (Telegram / Slack) ──────────────────────────────────────
  const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function buildJobMessage({ loc, body, row, result, rep, leadLabel, actor }) {
    const d = body.details || {};
    const lines = [];
    lines.push({ b: `New ${body.record_type} job — ${result.job.name}` });
    lines.push(`📍 ${row.address || 'No address'}`);
    if (row.client_phone) lines.push(`📞 ${row.client_phone.replace(/(\d{3})(\d{3})(\d{4})/, '($1) $2-$3')}`);
    if (leadLabel) lines.push(`Lead: ${leadLabel}`);
    if (d.cause_of_damage) lines.push(`Cause: ${clean(d.cause_of_damage, 140)}`);
    if (d.type_of_loss) lines.push(`Type: ${clean(d.type_of_loss)}`);
    if (rep) lines.push(`Rep: ${rep.full_name}${result.visit && result.visit.id ? ` · Inspection ${fmtLongDate(result.visit.date)} ${result.visit.window}` : ''}`);
    lines.push(`${loc.name} · by ${actor.name}`);
    const buttons = [{ text: 'Open in JobNimbus', url: result.job.jn_url }];
    if (result.job.id) buttons.push({ text: 'Open in DryOps', url: `${APP_URL}/jobs/${result.job.id}` });
    if (row.callrail_call_id) buttons.push({ text: '▶ Listen to call', url: `https://app.callrail.com/calls/${enc(row.callrail_call_id)}` });
    return { lines, buttons };
  }
  async function sendTelegram(cfg, msg) {
    const token = clean(cfg.bot_token, 200), chat = clean(cfg.chat_id, 64);
    if (!token || !chat) return { ok: false, error: 'Telegram bot_token / chat_id missing' };
    const text = msg.lines.map((l) => (typeof l === 'string' ? escHtml(l) : `<b>${escHtml(l.b)}</b>`)).join('\n');
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true,
        reply_markup: { inline_keyboard: msg.buttons.map((b) => [{ text: b.text, url: b.url }]) } }),
    });
    const j = await r.json().catch(() => null);
    return r.ok && j && j.ok ? { ok: true } : { ok: false, error: (j && j.description) || `Telegram ${r.status}` };
  }
  async function sendSlack(cfg, msg) {
    const url = clean(cfg.webhook_url, 300);
    if (!/^https:\/\/hooks\.slack\.com\//.test(url)) return { ok: false, error: 'Slack webhook_url must start with https://hooks.slack.com/' };
    const text = msg.lines.map((l) => (typeof l === 'string' ? l : `*${l.b}*`)).join('\n');
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, blocks: [
        { type: 'section', text: { type: 'mrkdwn', text } },
        { type: 'actions', elements: msg.buttons.map((b) => ({ type: 'button', text: { type: 'plain_text', text: b.text }, url: b.url })) },
      ] }),
    });
    return r.ok ? { ok: true } : { ok: false, error: `Slack ${r.status} ${(await r.text()).slice(0, 120)}` };
  }
  async function deliver(channel, msg) {
    const cfg = channel.config || {};
    return channel.kind === 'telegram' ? sendTelegram(cfg, msg) : channel.kind === 'slack' ? sendSlack(cfg, msg) : { ok: false, error: 'Unknown channel kind' };
  }
  async function notifyJobCreated(ctx) {
    const channels = (await sbGet(`notification_channels?active=eq.true&events=cs.{job_created}&or=(location_id.is.null,location_id.eq.${enc(ctx.loc.id)})&select=id,kind,name,config`)) || [];
    if (!channels.length) return;
    const msg = buildJobMessage(ctx);
    for (const ch of channels) {
      const r = await deliver(ch, msg).catch((e) => ({ ok: false, error: e.message }));
      if (!r.ok) warn('notify', ch.kind, ch.name, r.error);
    }
  }
  app.post('/admin/notifications/channels/:id/test', requireAuth, requireAdmin, async (req, res) => {
    try {
      const actor = await loadActor(req);
      const rows = await sbGet(`notification_channels?id=eq.${enc(req.params.id)}&select=id,kind,name,config,location_id`);
      const ch = rows && rows[0];
      if (!ch) return res.status(404).json({ error: 'Channel not found' });
      if (ch.location_id && !canManageLocation(actor, ch.location_id)) return res.status(403).json({ error: 'Not allowed' });
      if (!ch.location_id && actor.role !== 'admin') return res.status(403).json({ error: 'Not allowed' });
      const msg = {
        lines: [{ b: 'DryOps test — New Mitigation job — Jane Sample (TST - MIT)' }, '📍 123 Main St, Carrollton, TX 75006', '📞 (214) 555-0100', 'Lead: Google', `Rep: ${actor.name} · Inspection today 10am–12pm`, `${ch.name} · test by ${actor.name}`],
        buttons: [{ text: 'Open in JobNimbus', url: 'https://app.jobnimbus.com' }, { text: 'Open in DryOps', url: APP_URL }],
      };
      res.json(await deliver(ch, msg));
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  // ── CallRail call summary → JobNimbus "Phone Call" activity ───────────────
  // CallRail exposes `call_summary` (3–5 AI sentences) and `transcription` on
  // the single-call endpoint for accounts on a Premium Conversation Intelligence
  // plan; other plans get null. Summaries lag the call by minutes, so a call
  // linked to a job is retried for up to 2 hours before posting without one.
  const ACTIVITY_WAIT_MS = 2 * 60 * 60 * 1000;
  const ACTIVITY_MIN_AGE_MS = 10 * 60 * 1000;
  async function callrailCall(callId) {
    if (!CALLRAIL_API_KEY) return { ok: false, error: 'CallRail not configured' };
    for (const acct of CALLRAIL_ACCOUNT_IDS) {
      const r = await callrailApi(acct, `calls/${enc(callId)}.json?fields=call_summary,transcription,recording,recording_player,call_type,formatted_customer_name,customer_name,duration,start_time,answered,voicemail,customer_phone_number`);
      if (r.ok && r.json) return { ok: true, account: acct, call: r.json };
      if (r.status !== 404) return { ok: false, status: r.status, error: `CallRail ${r.status}` };
    }
    return { ok: false, status: 404, error: 'Call not found in any account' };
  }
  function summaryText(call) {
    const s = call.call_summary;
    if (Array.isArray(s)) return s.map((x) => (typeof x === 'string' ? x : x && (x.text || x.summary) || '')).filter(Boolean).join(' ').trim();
    return typeof s === 'string' ? s.trim() : '';
  }
  let activitiesRunning = false;
  async function postCallActivities() {
    if (activitiesRunning || !CALLRAIL_API_KEY) return { skipped: true };
    activitiesRunning = true;
    const out = { posted: 0, waiting: 0, failed: 0, skipped: 0 };
    try {
      const since = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
      const calls = (await sbGet(`calls?job_id=not.is.null&jn_activity_id=is.null&start_time=gte.${enc(since)}&select=id,callrail_id,customer_phone_number,customer_name,start_time,duration,location_id,job_id,jn_activity_error,jobs(jn_id,jn_location_id,name)&order=start_time.asc&limit=40`)) || [];
      if (!calls.length) return out;
      const locIds = Array.from(new Set(calls.map((c) => c.location_id).filter(Boolean)));
      const locs = locIds.length ? (await sbGet(`locations?id=in.(${locIds.map(enc).join(',')})&select=id,post_call_activities,timezone,jn_location_id`)) || [] : [];
      const locById = new Map(locs.map((l) => [l.id, l]));
      for (const c of calls) {
        const loc = locById.get(c.location_id);
        if (!loc || !loc.post_call_activities || !c.jobs || !c.jobs.jn_id) { out.skipped++; continue; }
        const startMs = c.start_time ? new Date(c.start_time).getTime() : 0;
        const ageMs = Date.now() - (startMs + (Number(c.duration) || 0) * 1000);
        if (ageMs < ACTIVITY_MIN_AGE_MS) { out.waiting++; continue; }
        const cr = await callrailCall(c.callrail_id);
        if (!cr.ok) {
          out.failed++;
          await sbPatch('calls', `id=eq.${enc(c.id)}`, { jn_activity_error: String(cr.error).slice(0, 200) }).catch(() => {});
          continue;
        }
        const call = cr.call;
        const summary = summaryText(call);
        const recording = call.recording_player || call.recording || null;
        if (!summary && ageMs < ACTIVITY_WAIT_MS) { out.waiting++; continue; }
        const tz = loc.timezone || 'America/Chicago';
        const when = startMs ? zoned(startMs, tz, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'unknown time';
        const dur = Number(call.duration || c.duration) || 0;
        const phone = (call.customer_phone_number || c.customer_phone_number || '').replace(/^\+1/, '');
        const who = call.formatted_customer_name || call.customer_name || c.customer_name || '';
        const lines = [
          `Phone call — ${when}${dur ? ` (${Math.floor(dur / 60)}m ${dur % 60}s)` : ''}${who ? ` with ${who}` : ''}${phone ? ` ${phone}` : ''}`,
          '',
          summary ? `Summary: ${summary}` : 'Summary: not available from CallRail (requires Conversation Intelligence)',
          `Recording: https://app.callrail.com/calls/${c.callrail_id}`,
        ];
        const payload = {
          record_type_name: 'Phone Call', note: lines.join('\n'),
          related: [{ id: c.jobs.jn_id, type: 'job' }], primary: { id: c.jobs.jn_id, type: 'job' },
          location: { id: Number(REDIRECT_LOCATION || c.jobs.jn_location_id || loc.jn_location_id) },
          date_start: startMs ? Math.floor(startMs / 1000) : undefined,
          date_end: startMs ? Math.floor(startMs / 1000) + dur : undefined,
        };
        let r = await jnWrite('POST', 'activities', payload);
        if (!r.ok && r.status < 500) { const { date_start, date_end, ...noDates } = payload; r = await jnWrite('POST', 'activities', noDates); }
        if (!r.ok && r.status < 500 && /record_type|type/i.test(jnErr(r))) { const { record_type_name, ...rest } = payload; r = await jnWrite('POST', 'activities', { ...rest, record_type_name: 'Note' }); }
        if (r.ok) {
          out.posted++;
          await sbPatch('calls', `id=eq.${enc(c.id)}`, { jn_activity_id: String((r.body && (r.body.jnid || r.body.id)) || 'ok'), jn_activity_error: null, call_summary: summary || null, recording_url: recording }).catch(() => {});
        } else {
          out.failed++;
          await sbPatch('calls', `id=eq.${enc(c.id)}`, { jn_activity_error: jnErr(r).slice(0, 200), call_summary: summary || null, recording_url: recording }).catch(() => {});
        }
      }
      return out;
    } catch (err) { console.error('[call activities] error', err.message); out.error = err.message; return out; }
    finally { activitiesRunning = false; if (out.posted || out.failed) log('call activities', JSON.stringify(out)); }
  }
  if (SUPABASE_SERVICE_KEY && CALLRAIL_API_KEY) {
    setTimeout(() => { postCallActivities(); setInterval(postCallActivities, 10 * 60 * 1000); }, 90 * 1000);
  }
  app.post('/admin/calls/post-activities', requireAuth, requireAdmin, async (_req, res) => {
    try { res.json(await postCallActivities()); } catch (err) { res.status(502).json({ error: err.message }); }
  });
  app.get('/admin/calls/:callrailId/callrail', requireAuth, requireAdmin, async (req, res) => {
    try {
      const r = await callrailCall(String(req.params.callrailId));
      if (!r.ok) return res.status(r.status || 502).json({ error: r.error });
      const call = r.call;
      res.json({ account: r.account, call_summary: call.call_summary ?? null, transcription: call.transcription ?? null, recording_player: call.recording_player ?? null,
        call_type: call.call_type ?? null, start_time: call.start_time, duration: call.duration, customer_name: call.customer_name, keys: Object.keys(call) });
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  return { createIntakeJob, postInspectionScheduledNote, postCallActivities, surveyLocation, jnAccountSettings };
};
