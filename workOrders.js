'use strict';
// ── Work orders (owner 2026-11-13) ───────────────────────────────────────────
// Order a packout, testing, abatement or rebuild from a job. The order creates
// the job DIRECTLY at the partner location (no JobNimbus work order document):
// the customer's contact is linked, the address / claim / carrier / adjuster
// are copied, the referring location is the lead source, and both jobs get a
// note. Testing work orders made by hand in JobNimbus keep going through
// testingJobs.js (the webhook) as before.
//
//   POST /jobs/:id/work-orders
//     { service: 'contents'|'testing'|'abatement'|'rebuild',
//       kind?: 'packout'|'packback'|'manipulation',   (contents)
//       partner_location_id?,                          (else the resolved default)
//       test_types?: [...],                            (testing)
//       note?, client_request_id }
//   → { ok, created, job: { id, jn_id, name, jn_url }, target: { id, name },
//       work_order_id, warnings }
//
// Who it goes to: DryOps supabase/add_location_partners.sql holds each
// location's partners per service. `resolvePartners` is the byte-for-byte twin
// of the app's lib/partners.ts (shared fixture test/fixtures/partnerResolve.json):
// a job that was itself referred prefers the partner of the location that
// referred it (a rebuild shared by several mitigation and packout companies
// sends the packout back to the right one), then the job's own location's
// partners, default first. With no testing partner set, a testing order falls
// back to the work-order automation's own location rule (testingJobs.js).
//
// A pack-back asked of a job whose Contents job already exists creates no
// job: the request is posted on that Contents job and logged.

const crypto = require('crypto');
const { pickLeadSource, testingLocationFor, stateCode } = require('./testingJobs');
const { normalizeTestTypes } = require('./intakeTesting');
const { notifyChannels } = require('./notify');

const SERVICES = {
  contents:  { recordType: 'Contents',   label: 'Packout',   noun: 'packout' },
  testing:   { recordType: 'Testing',    label: 'Testing',   noun: 'testing' },
  abatement: { recordType: 'Abatements', label: 'Abatement', noun: 'abatement' },
  rebuild:   { recordType: 'Rebuild',    label: 'Rebuild',   noun: 'rebuild' },
};
const KINDS = { packout: 'Packout', packback: 'Pack-back', manipulation: 'Content manipulation' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ORDER_ROLES = new Set(['owner', 'expansion_manager']);

const clean = (v, max = 400) => (v === undefined || v === null ? '' : String(v)).trim().slice(0, max);

// Twin of lib/partners.ts resolvePartners.
function resolvePartners(service, sourceLocationId, referrerLocationIds, partners) {
  const out = [];
  const seen = new Set();
  const listFor = (locationId) => (partners || [])
    .filter((p) => p.location_id === locationId && p.service === service)
    .sort((a, b) => Number(b.is_default) - Number(a.is_default));
  const push = (rows, via, from) => {
    for (const r of rows) {
      if (seen.has(r.partner_location_id)) continue;
      seen.add(r.partner_location_id);
      out.push({ partner_location_id: r.partner_location_id, via, from_location_id: from, is_default: !!r.is_default });
    }
  };
  for (const ref of referrerLocationIds || []) {
    if (!ref || ref === sourceLocationId) continue;
    // Only the referrer's default speaks for it; its alternates are its own choice to make.
    push(listFor(ref).filter((p) => p.is_default), 'referrer', ref);
  }
  push(listFor(sourceLocationId), 'own', sourceLocationId);
  return out;
}

// "123 Main St, Dallas, Texas, 75232" → { street, city, state, zip }. The app
// stores one line; JobNimbus wants four fields. Fewer than four parts: the
// whole line is the street and the geocode carries the rest.
function splitAddress(line) {
  const parts = clean(line, 300).split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 4) {
    const zip = parts[parts.length - 1];
    const state = parts[parts.length - 2];
    const city = parts[parts.length - 3];
    return { street: parts.slice(0, parts.length - 3).join(', '), city, state, zip };
  }
  if (parts.length === 3) {
    // "street, city, ST 75232"
    const m = /^([A-Za-z .]+?)\s+(\d{5}(?:-\d{4})?)$/.exec(parts[2]);
    if (m) return { street: parts[0], city: parts[1], state: m[1].trim(), zip: m[2] };
    return { street: parts[0], city: parts[1], state: parts[2], zip: '' };
  }
  return { street: clean(line, 300), city: '', state: '', zip: '' };
}

/** "Lauren Wyatt (24 - DAL - MIT)" → { first: 'Lauren', last: 'Wyatt' } for a job with no linked JobNimbus contact. */
function nameParts(clientName, jobName) {
  const base = clean(clientName || jobName).replace(/\s*\([^()]*\)\s*$/, '').trim();
  const words = base.split(/\s+/).filter(Boolean);
  return { first: words[0] || 'Customer', last: words.slice(1).join(' ') };
}

/** May this person order from a job at this location? Admins anywhere; owners and expansion managers at their own; a custom role with create_work_orders. */
function canOrder(actor, locationId) {
  if (!actor) return false;
  if (actor.role === 'admin') return true;
  if (!actor.locs || !actor.locs.includes(String(locationId))) return false;
  if (actor.perms && typeof actor.perms.create_work_orders === 'boolean') return actor.perms.create_work_orders;
  return ORDER_ROLES.has(actor.role);
}

/** The lead-source company type a referring location shows up as at the partner (DryOps lib/leadSources LEAD_SOURCE_TYPES). */
function companyTypeFor(sourceLocationType) {
  if (sourceLocationType === 'Mitigation' || sourceLocationType === 'Rebuild') return sourceLocationType;
  return 'Other';
}

/** The POST /jobs/create body for the referred job (intake.js createIntakeJob). */
function intakeBodyFor({ rid, service, kind, src, targetLocationId, leadCompanyId, note, testTypes, sourceLocationName }) {
  const def = SERVICES[service];
  const addr = splitAddress(src.address);
  const body = {
    client_request_id: rid,
    location_id: targetLocationId,
    record_type: def.recordType,
    property_type: src.property_type === 'commercial' ? 'commercial' : 'residential',
    address: {
      street: addr.street, city: addr.city, state: addr.state, zip: addr.zip,
      ...(src.lat != null && src.lng != null ? { lat: src.lat, lng: src.lng } : {}),
    },
    lead: { lead_source_company_id: leadCompanyId, lead_type: 'Internal Referral' },
    referring_job_id: src.id,
    details: {
      insurance_type: /^insurance$/i.test(clean(src.insurance_type)) ? 'Insurance' : (clean(src.insurance_type) ? 'Non-Insurance' : undefined),
      claim_number: src.claim_number || undefined,
      insurer: src.insurer || undefined,
      adjuster_name: src.adjuster_name || undefined,
      adjuster_phone: src.adjuster_phone || undefined,
      adjuster_email: src.adjuster_email || undefined,
      type_of_loss: src.cat || undefined,
      date_loss: /^\d{4}-\d{2}-\d{2}/.test(clean(src.date_loss)) ? clean(src.date_loss).slice(0, 10) : undefined,
      notes: clean(note, 2000) || undefined,
    },
  };
  const business = clean(src.client_name || src.name).replace(/\s*\([^()]*\)\s*$/, '');
  if (src.jn_contact_id) {
    // The customer's own JobNimbus contact: intake reads the name from it.
    body.link_contact_jn_id = src.jn_contact_id;
    body.contact = body.property_type === 'commercial' ? { business_name: business } : {};
  } else {
    const n = nameParts(src.client_name, src.name);
    body.contact = { first_name: n.first, last_name: n.last, phone: src.client_phone || '' };
    if (body.property_type === 'commercial') body.contact.business_name = business;
  }
  if (service === 'contents') body.details.services = [KINDS[kind] || KINDS.packout];
  if (service === 'rebuild') body.details.scope_summary = clean(note, 1000) || `Rebuild requested by ${sourceLocationName || 'the referring location'} from ${clean(src.name)}`;
  if (service === 'testing') body.details.test_types = normalizeTestTypes(testTypes);
  return body;
}

/** The note left on the job the order came from. */
function sourceNoteText({ service, kind, jobName, jobJnId, targetName, actorName, note, created }) {
  const def = SERVICES[service];
  const what = service === 'contents' ? (KINDS[kind] || KINDS.packout) : def.label;
  const link = jobJnId ? ` (https://app.jobnimbus.com/job/${jobJnId})` : '';
  const lines = [created
    ? `${what} ordered from ${targetName}: ${jobName}${link}.`
    : `${what} requested from ${targetName} on ${jobName}${link}.`];
  if (clean(note)) lines.push(`Note: ${clean(note, 2000)}`);
  lines.push(`Ordered by ${actorName} in DryOps.`);
  return lines.join('\n');
}

/** The note left on a Contents job that already exists when its pack-back (or another visit) is asked for. */
function requestNoteText({ kind, sourceJobName, sourceLocationName, actorName, note }) {
  const lines = [`${KINDS[kind] || 'Work'} requested by ${sourceLocationName || 'the referring location'}${sourceJobName ? ` (${sourceJobName})` : ''}.`];
  if (clean(note)) lines.push(`Note: ${clean(note, 2000)}`);
  lines.push(`Ordered by ${actorName} in DryOps.`);
  return lines.join('\n');
}

module.exports = function mountWorkOrders(app, deps) {
  const { requireAuth, loadActor, createIntakeJob, jnAccountSettings, sbGet, sbInsert, jnAddNote } = deps;
  const log = deps.log || ((...a) => console.log('[work-orders]', ...a));
  const warn = deps.warn || ((...a) => console.warn('[work-orders]', ...a));
  const notify = deps.notifyChannels || notifyChannels;
  const enc = encodeURIComponent;
  const safe = async (p) => { try { const r = await p; return Array.isArray(r) ? r : []; } catch { return []; } };
  const httpError = (status, code, error, extra) => Object.assign(new Error(error), { status, code, extra });

  async function locationById(id) {
    const rows = await safe(sbGet(`locations?id=eq.${enc(id)}&select=id,name,location_type,jn_location_id,jn_note_tag,record_types,status`));
    return rows[0] || null;
  }

  /** The referring chain's locations, nearest first (the job that referred this one, then its referrer…). */
  async function referrerLocations(job) {
    const out = [];
    let next = job.referring_job_id;
    for (let hop = 0; next && hop < 4; hop++) {
      const rows = await safe(sbGet(`jobs?id=eq.${enc(next)}&select=id,location_id,referring_job_id`));
      const j = rows[0];
      if (!j) break;
      if (j.location_id) out.push(String(j.location_id));
      next = j.referring_job_id;
    }
    return out;
  }

  /** The partner's lead-source row for the referring location, made on first use. */
  async function leadCompanyFor(target, source, warnings) {
    const found = await safe(sbGet(`lead_source_companies?location_id=eq.${enc(target.id)}&is_internal=eq.true&internal_location_id=eq.${enc(source.id)}&select=id,jn_source_id,status&order=status.asc&limit=1`));
    if (found[0]) {
      if (!found[0].jn_source_id) warnings.push('NO_JN_SOURCE');
      return found[0].id;
    }
    // JobNimbus has no API to create lead sources: match an existing one by the
    // referring location's name (the way the testing automation does).
    let jnSource = null;
    try { jnSource = pickLeadSource((await jnAccountSettings()).sources, source.name); } catch (e) { warn('jn sources', e.message); }
    if (!jnSource) warnings.push('NO_JN_SOURCE');
    const made = await sbInsert('lead_source_companies', {
      location_id: target.id, name: source.name, company_type: companyTypeFor(source.location_type),
      lead_type: 'Internal Referral', is_internal: true, internal_location_id: source.id,
      jn_source_id: jnSource ? Number(jnSource.id) : null, jn_source_name: jnSource ? jnSource.name : null,
    });
    // sbInsert does not always hand the row back: read it.
    const row = made && made.id ? made : (await safe(sbGet(`lead_source_companies?location_id=eq.${enc(target.id)}&is_internal=eq.true&internal_location_id=eq.${enc(source.id)}&select=id&limit=1`)))[0];
    if (!row || !row.id) throw httpError(500, 'LEAD_SOURCE', `Could not add ${source.name} as a lead source at ${target.name}`);
    return row.id;
  }

  /** The Contents job this job already has (ordered from it, or the one that ordered it). */
  async function existingContentsJob(src) {
    const kids = await safe(sbGet(`jobs?referring_job_id=eq.${enc(src.id)}&record_type=eq.Contents&select=id,jn_id,name,status,location_id,jn_location_id&order=jn_created.desc&limit=1`));
    if (kids[0]) return kids[0];
    // A rebuild job ordered from the same mitigation job as the packout: siblings.
    if (src.referring_job_id) {
      const sibs = await safe(sbGet(`jobs?referring_job_id=eq.${enc(src.referring_job_id)}&record_type=eq.Contents&select=id,jn_id,name,status,location_id,jn_location_id&order=jn_created.desc&limit=1`));
      if (sibs[0]) return sibs[0];
    }
    return null;
  }

  async function logOrder(row, warnings) {
    try {
      const r = await sbInsert('work_orders', row);
      if (r && r.id) return r.id;
      const back = await safe(sbGet(`work_orders?source_job_id=eq.${enc(row.source_job_id)}&service=eq.${enc(row.service)}&order=created_at.desc&limit=1&select=id`));
      return back[0] ? back[0].id : null;
    } catch (e) {
      // supabase/add_work_orders.sql not run yet: the job exists, the log does not.
      warn('work_orders insert', e.message);
      warnings.push('WORK_ORDER_LOG_FAILED');
      return null;
    }
  }

  const inflight = new Map(); // client_request_id → promise

  async function createWorkOrder(jobId, body, actor) {
    const service = clean(body && body.service);
    const def = SERVICES[service];
    if (!def) throw httpError(400, 'VALIDATION', 'service must be contents, testing, abatement or rebuild', { field: 'service' });
    const kind = service === 'contents' ? (KINDS[clean(body.kind)] ? clean(body.kind) : 'packout') : null;
    const rid = UUID.test(clean(body.client_request_id)) ? clean(body.client_request_id) : crypto.randomUUID();
    const note = clean(body.note, 2000);
    if (!UUID.test(String(jobId))) throw httpError(400, 'VALIDATION', 'Unknown job', { field: 'job' });
    if (service === 'testing' && !normalizeTestTypes(body.test_types).length) throw httpError(400, 'VALIDATION', 'Pick at least one type of testing', { field: 'test_types' });

    const rows = await safe(sbGet(`jobs?id=eq.${enc(jobId)}&select=id,jn_id,name,client_name,client_phone,jn_contact_id,address,lat,lng,location_id,jn_location_id,record_type,property_type,insurance_type,claim_number,insurer,adjuster_name,adjuster_phone,adjuster_email,cat,date_loss,referring_job_id`));
    const src = rows[0];
    if (!src) throw httpError(404, 'NOT_FOUND', 'Job not found');
    if (!src.location_id) throw httpError(400, 'VALIDATION', 'This job has no location, so it cannot be referred');
    if (!canOrder(actor, src.location_id)) throw httpError(403, 'FORBIDDEN', 'You cannot order work from this job');
    if (!clean(src.address)) throw httpError(400, 'VALIDATION', 'Add the job address before ordering work', { field: 'address' });
    const source = await locationById(src.location_id);
    if (!source) throw httpError(400, 'VALIDATION', 'Unknown location');

    const warnings = [];

    // ── Who it goes to ──
    const refs = await referrerLocations(src);
    const scope = [String(src.location_id), ...refs];
    const partners = await safe(sbGet(`location_partners?location_id=in.(${scope.map(enc).join(',')})&service=eq.${enc(service)}&select=location_id,service,partner_location_id,is_default`));
    const picks = resolvePartners(service, String(src.location_id), refs, partners);
    let targetId = null;
    if (body.partner_location_id) {
      if (!picks.some((p) => p.partner_location_id === String(body.partner_location_id))) throw httpError(400, 'VALIDATION', 'That location is not a partner for this job', { field: 'partner_location_id' });
      targetId = String(body.partner_location_id);
    } else if (picks[0]) targetId = picks[0].partner_location_id;
    if (!targetId && service === 'testing') {
      // No partner set: the testing work-order automation's own rule (state → ATS / White Tail).
      const jnLoc = testingLocationFor({ state: stateCode(splitAddress(src.address).state) });
      const tl = await safe(sbGet(`locations?jn_location_id=eq.${enc(jnLoc)}&select=id&limit=1`));
      if (tl[0]) { targetId = tl[0].id; warnings.push('TESTING_DEFAULT_LOCATION'); }
    }
    if (!targetId) throw httpError(400, 'NO_PARTNER', `${source.name} has no ${def.noun} partner yet. Set one in Settings → Locations → Partner locations.`, { field: 'partner_location_id' });
    const target = await locationById(targetId);
    if (!target) throw httpError(400, 'VALIDATION', 'The partner location no longer exists', { field: 'partner_location_id' });

    // ── A pack-back (or another visit) on a Contents job that already exists ──
    if (service === 'contents' && kind !== 'packout') {
      const existing = await existingContentsJob(src);
      if (existing && existing.jn_id) {
        const exLoc = existing.location_id ? await locationById(existing.location_id) : null;
        const text = requestNoteText({ kind, sourceJobName: src.name, sourceLocationName: source.name, actorName: actor.name, note });
        const nr = await jnAddNote(existing.jn_id, text, { jnLocationId: (exLoc && exLoc.jn_location_id) || existing.jn_location_id || undefined, tag: (exLoc && exLoc.jn_note_tag) || undefined, createdBy: actor.jn_user_id || undefined }).catch((e) => ({ ok: false, error: e.message }));
        if (!nr.ok) warnings.push('NOTE_FAILED');
        if (src.jn_id) {
          const sn = await jnAddNote(src.jn_id, sourceNoteText({ service, kind, jobName: existing.name, jobJnId: existing.jn_id, targetName: (exLoc && exLoc.name) || target.name, actorName: actor.name, note, created: false }), { jnLocationId: source.jn_location_id || src.jn_location_id || undefined, tag: source.jn_note_tag || undefined, createdBy: actor.jn_user_id || undefined }).catch((e) => ({ ok: false, error: e.message }));
          if (!sn.ok) warnings.push('SOURCE_NOTE_FAILED');
        }
        const woId = await logOrder({ source_job_id: src.id, source_location_id: src.location_id, service, kind, target_location_id: existing.location_id || target.id, target_job_id: existing.id, note: note || null, requested_by: actor.id || null, requested_by_name: actor.name, status: 'requested' }, warnings);
        notify({ sbGet, events: ['job_created'], locationId: existing.location_id || target.id, msg: { lines: [`${KINDS[kind]} requested`, existing.name, `From ${source.name} · ${actor.name}`, ...(note ? [note] : [])], buttons: [{ label: 'Open in JobNimbus', url: `https://app.jobnimbus.com/job/${existing.jn_id}` }] }, log: warn }).catch(() => {});
        log(rid, 'requested', kind, 'on', existing.id);
        return { ok: true, created: false, job: { id: existing.id, jn_id: existing.jn_id, name: existing.name, jn_url: `https://app.jobnimbus.com/job/${existing.jn_id}` }, target: { id: (exLoc && exLoc.id) || target.id, name: (exLoc && exLoc.name) || target.name }, work_order_id: woId, warnings };
      }
    }

    // ── A new job at the partner ──
    const enabled = Array.isArray(target.record_types) && target.record_types.length ? target.record_types : ['Mitigation'];
    if (!enabled.includes(def.recordType)) throw httpError(400, 'VALIDATION', `${target.name} is not set up to take ${def.recordType} jobs (Settings → Locations → ${target.name} → Job setup)`, { field: 'partner_location_id' });
    const leadCompanyId = await leadCompanyFor(target, source, warnings);
    const intakeBody = intakeBodyFor({ rid, service, kind, src, targetLocationId: target.id, leadCompanyId, note, testTypes: body.test_types, sourceLocationName: source.name });
    const out = await createIntakeJob(intakeBody, actor, { system: true, source: 'work_order' });
    for (const w of out.warnings || []) if (!warnings.includes(w)) warnings.push(w);

    if (src.jn_id && !out.replay) {
      const sn = await jnAddNote(src.jn_id, sourceNoteText({ service, kind, jobName: out.job.name, jobJnId: out.job.jn_id, targetName: target.name, actorName: actor.name, note, created: true }), { jnLocationId: source.jn_location_id || src.jn_location_id || undefined, tag: source.jn_note_tag || undefined, createdBy: actor.jn_user_id || undefined }).catch((e) => ({ ok: false, error: e.message }));
      if (!sn.ok) warnings.push('SOURCE_NOTE_FAILED');
    }
    const woId = out.replay ? null : await logOrder({ source_job_id: src.id, source_location_id: src.location_id, service, kind, target_location_id: target.id, target_job_id: out.job.id || null, note: note || null, requested_by: actor.id || null, requested_by_name: actor.name, status: 'created' }, warnings);
    log(rid, 'created', service, kind || '', '→', target.name, out.job.jn_id);
    return { ok: true, created: true, job: out.job, target: { id: target.id, name: target.name }, work_order_id: woId, warnings };
  }

  app.post('/jobs/:id/work-orders', requireAuth, async (req, res) => {
    const rid = clean(req.body && req.body.client_request_id);
    try {
      const actor = await loadActor(req);
      if (!actor) return res.status(403).json({ error: 'Profile not found', code: 'FORBIDDEN' });
      let p = rid && inflight.get(rid);
      if (!p) {
        p = createWorkOrder(req.params.id, req.body || {}, actor);
        if (rid) { inflight.set(rid, p); p.finally(() => setTimeout(() => inflight.delete(rid), 30000)).catch(() => {}); }
      }
      res.json(await p);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('[work-orders] error', rid, err.message);
      res.status(status).json({ error: err.message, code: err.code || 'ERROR', ...(err.extra || {}) });
    }
  });

  return { createWorkOrder };
};

module.exports.SERVICES = SERVICES;
module.exports.KINDS = KINDS;
module.exports.resolvePartners = resolvePartners;
module.exports.splitAddress = splitAddress;
module.exports.nameParts = nameParts;
module.exports.canOrder = canOrder;
module.exports.companyTypeFor = companyTypeFor;
module.exports.intakeBodyFor = intakeBodyFor;
module.exports.sourceNoteText = sourceNoteText;
module.exports.requestNoteText = requestNoteText;
