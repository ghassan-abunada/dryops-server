'use strict';
// DryOps photos → JobNimbus (owner 2026-11-19).
//
// Photos only flowed one way: JobNimbus images were shown in DryOps, but a
// photo taken in DryOps (camera, On Site view, job page, homeowner portal)
// stayed in DryOps storage. JobNimbus never saw it and the Work Complete photo
// report, which is built from the job's JobNimbus images, left it out.
//
// This uploads each DryOps photo to its job's JobNimbus files, once, and
// records the result on the row (dryops repo supabase/add_photo_jn_sync.sql):
//   jn_file_id          the JobNimbus file id once uploaded (null = not sent)
//   jn_synced_at        when
//   jn_sync_attempts    failed tries (we stop at MAX_ATTEMPTS)
//   jn_sync_error       the last failure
//   jn_sync_claimed_at  "leave this row alone until HOLD_MS after this time":
//                       a run in progress, or a photo whose job has no
//                       JobNimbus id yet (snoozed, not counted as a failure)
// The app hides the JobNimbus copy of a photo it holds (lib/photoDedupe.ts),
// so nothing shows twice.
//
// Runs: a tick every few minutes (server.js, only when PHOTO_JN_SYNC=1), a
// flush of one job's photos right before its Work Complete report, and the
// admin endpoints below. PHOTO_JN_SYNC_DRYRUN=1 logs what would be sent and
// uploads nothing. One photo at a time, on purpose: gentle on JobNimbus.

const MAX_ATTEMPTS = 5;
const HOLD_MS = 10 * 60 * 1000;             // a claimed row is left alone this long
const SNOOZE_MS = 6 * 60 * 60 * 1000;       // a photo whose job is not in JobNimbus yet
const RESIZE_OVER_BYTES = 6 * 1024 * 1024;  // larger originals are re-encoded before upload
const RESIZE_LONG_EDGE = 2400;
const PORTAL_CAPTION = 'From homeowner (portal)';

const enc = encodeURIComponent;
const clean = (s) => String(s || '').replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();

/** "2026-11-12 1035" in Central time, like the photo report's timestamps. */
function stamp(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}${p.minute}`;
}

/** "Nov 12, 2026 10:35 AM" in Central time, for the description. */
function takenLabel(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.month} ${p.day}, ${p.year} ${p.hour}:${p.minute} ${p.dayPeriod}`;
}

/**
 * The file name in JobNimbus: "2026-11-12 1035 DryOps Kitchen a1b2.jpg" (the id tail keeps two shots in a minute apart).
 * The taken date comes FIRST (owner 2026-11-19): JobNimbus dates a file by its upload and offers no way to
 * backdate it (date_created / date_file_created are ignored on POST and PUT, EXIF is not read for API uploads),
 * so sorting by name is what puts the photos in the order they were taken.
 */
function photoFilename(photo, roomName) {
  const tail = String(photo.id || '').replace(/[^A-Za-z0-9]/g, '').slice(-4);
  return [stamp(photo.taken_at), `DryOps`, clean(roomName) || 'General', tail].filter(Boolean).join(' ').slice(0, 110) + '.jpg';
}

/** The description in JobNimbus: who took it, where and when, since the uploader and the date shown there are the API user's and the upload's. */
function photoDescription(photo, roomName, takerName) {
  const when = takenLabel(photo.taken_at);
  if (photo.caption === PORTAL_CAPTION) return ['From the homeowner (DryOps portal)', when].filter(Boolean).join(' · ');
  const who = clean(takerName) ? `Taken in DryOps by ${clean(takerName)}` : 'Taken in DryOps';
  return [who, clean(roomName), when, clean(photo.caption)].filter(Boolean).join(' · ').slice(0, 250);
}

function createPhotoSync({ sbGet, sbPatch, jnUploadFile, sharp = null, fetchFn = fetch, dryrun = false, log = console, now = () => Date.now() }) {
  let running = false;
  let last = null;

  const iso = (ms) => new Date(ms).toISOString();

  /** The photo's bytes, re-encoded when the original is very large. */
  async function download(url) {
    const r = await fetchFn(url);
    if (!r.ok) throw new Error(`download ${r.status}`);
    let buf = Buffer.from(await r.arrayBuffer());
    if (sharp && buf.length > RESIZE_OVER_BYTES) {
      buf = await sharp(buf).rotate().resize({ width: RESIZE_LONG_EDGE, height: RESIZE_LONG_EDGE, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
    }
    return buf;
  }

  /**
   * Send photos that are not in JobNimbus yet, oldest first.
   *   jobId      only this DryOps job (the flush before a report)
   *   limit      photos to upload at most
   *   deadlineMs stop starting new uploads after this long
   *   dry        log only (defaults to the module's dryrun flag)
   */
  async function syncPendingPhotos({ jobId = null, limit = 20, deadlineMs = 0, dry = dryrun } = {}) {
    const out = { scanned: 0, uploaded: 0, failed: 0, snoozed: 0, skipped: 0, dryrun: !!dry, items: [] };
    const started = now();
    const free = `or=(jn_sync_claimed_at.is.null,jn_sync_claimed_at.lt.${enc(iso(started - HOLD_MS))})`;
    const rows = await sbGet(
      `photos?jn_file_id=is.null&jn_sync_attempts=lt.${MAX_ATTEMPTS}&${free}${jobId ? `&job_id=eq.${enc(jobId)}` : ''}`
      + `&select=id,job_id,room_id,storage_url,caption,taken_at,taken_by,jn_sync_attempts&order=taken_at.asc&limit=${Math.max(1, limit)}`);
    if (!rows) throw new Error('could not read the photo queue (is supabase/add_photo_jn_sync.sql applied?)');
    out.scanned = rows.length;
    if (!rows.length) return out;

    const ids = (key) => [...new Set(rows.map((r) => r[key]).filter(Boolean))];
    const inList = (list) => `in.(${list.map(enc).join(',')})`;
    const [jobs, rooms, people] = await Promise.all([
      sbGet(`jobs?id=${inList(ids('job_id'))}&select=id,jn_id`),
      ids('room_id').length ? sbGet(`rooms?id=${inList(ids('room_id'))}&select=id,name`) : [],
      ids('taken_by').length ? sbGet(`profiles?id=${inList(ids('taken_by'))}&select=id,full_name`) : [],
    ]);
    const jnOf = new Map((jobs || []).map((j) => [j.id, j.jn_id]));
    const roomOf = new Map((rooms || []).map((r) => [r.id, r.name]));
    const nameOf = new Map((people || []).map((p) => [p.id, p.full_name]));

    for (const photo of rows) {
      if (deadlineMs && now() - started > deadlineMs) { out.skipped += 1; continue; }
      const jn = jnOf.get(photo.job_id);
      const room = photo.room_id ? roomOf.get(photo.room_id) : null;
      const filename = photoFilename(photo, room);
      const description = photoDescription(photo, room, photo.taken_by ? nameOf.get(photo.taken_by) : null);

      if (!jn || !photo.storage_url) {
        // Not a failure: the job has no JobNimbus record yet (or the row has no picture). Look again later.
        out.snoozed += 1;
        if (!dry) await sbPatch('photos', `id=eq.${enc(photo.id)}&jn_file_id=is.null`, { jn_sync_claimed_at: iso(now() + SNOOZE_MS - HOLD_MS) }).catch(() => {});
        continue;
      }
      if (dry) { out.items.push({ id: photo.id, job: jn, filename, description }); continue; }

      // Claim it: only one run may hold a photo, so it is never uploaded twice.
      let mine;
      try { mine = await sbPatch('photos', `id=eq.${enc(photo.id)}&jn_file_id=is.null&${free}`, { jn_sync_claimed_at: iso(now()) }); }
      catch (e) { out.failed += 1; continue; }
      if (!Array.isArray(mine) || !mine.length) { out.skipped += 1; continue; }

      try {
        const buf = await download(photo.storage_url);
        const jnid = await jnUploadFile(jn, filename, buf, description);
        if (!jnid) throw new Error('JobNimbus returned no file id');
        await sbPatch('photos', `id=eq.${enc(photo.id)}`, { jn_file_id: String(jnid), jn_synced_at: iso(now()), jn_sync_error: null, jn_sync_claimed_at: null });
        out.uploaded += 1;
        out.items.push({ id: photo.id, job: jn, filename, jnid: String(jnid) });
      } catch (e) {
        out.failed += 1;
        const msg = String((e && e.message) || e).slice(0, 300);
        log.warn('[photo-sync]', photo.id, msg);
        // Released at once so the next run retries it; attempts cap the retries.
        await sbPatch('photos', `id=eq.${enc(photo.id)}`, { jn_sync_attempts: (photo.jn_sync_attempts || 0) + 1, jn_sync_error: msg, jn_sync_claimed_at: null }).catch(() => {});
      }
    }
    return out;
  }

  /** One background run; never overlaps itself, never throws. */
  async function tick(opts = {}) {
    if (running) return null;
    running = true;
    try {
      const r = await syncPendingPhotos(opts);
      last = { at: iso(now()), ...r, items: undefined };
      if (r.uploaded || r.failed || (r.dryrun && r.items.length)) log.log('[photo-sync]', r.dryrun ? `dryrun: would send ${r.items.length}` : `sent ${r.uploaded}, failed ${r.failed}`, `of ${r.scanned} (snoozed ${r.snoozed})`);
      return r;
    } catch (e) {
      last = { at: iso(now()), error: String((e && e.message) || e).slice(0, 300) };
      log.error('[photo-sync] failed:', last.error);
      return null;
    } finally { running = false; }
  }

  /** Before a Work Complete report: send this job's remaining photos so the report has them. */
  async function flushJobByJnId(jobJnId, { limit = 300, deadlineMs = 4 * 60 * 1000 } = {}) {
    const rows = await sbGet(`jobs?jn_id=eq.${enc(jobJnId)}&select=id&limit=1`);
    const id = rows && rows[0] && rows[0].id;
    if (!id) return null;
    return syncPendingPhotos({ jobId: id, limit, deadlineMs });
  }

  return { syncPendingPhotos, tick, flushJobByJnId, lastRun: () => last, isRunning: () => running };
}

/** Admin endpoints: how the queue stands, and a run by hand (optionally one job, optionally a dry run). */
function registerPhotoSyncRoutes(app, { photoSync, requireAuth, requireAdmin, sbCount, enabled, dryrun }) {
  app.get('/admin/photos/jn-sync/status', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const [pending, synced, failing, gaveUp] = await Promise.all([
        sbCount('photos?jn_file_id=is.null'),
        sbCount('photos?jn_file_id=not.is.null'),
        sbCount(`photos?jn_file_id=is.null&jn_sync_attempts=gt.0&jn_sync_attempts=lt.${MAX_ATTEMPTS}`),
        sbCount(`photos?jn_file_id=is.null&jn_sync_attempts=gte.${MAX_ATTEMPTS}`),
      ]);
      res.json({ enabled: !!enabled, dryrun: !!dryrun, running: photoSync.isRunning(), pending, synced, failing, gave_up: gaveUp, last: photoSync.lastRun() });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  app.post('/admin/photos/jn-sync', requireAuth, requireAdmin, async (req, res) => {
    const jobId = typeof req.query.job === 'string' && /^[0-9a-f-]{36}$/i.test(req.query.job) ? req.query.job : null;
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 20));
    try {
      res.json({ ok: true, ...(await photoSync.syncPendingPhotos({ jobId, limit, dry: req.query.dryrun === '1' || !!dryrun, deadlineMs: 4 * 60 * 1000 })) });
    } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
  });
}

module.exports = { createPhotoSync, registerPhotoSyncRoutes, photoFilename, photoDescription, stamp, takenLabel, MAX_ATTEMPTS, HOLD_MS, SNOOZE_MS };
