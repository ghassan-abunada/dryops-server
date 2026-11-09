'use strict';
// ── Job files (the job page's Files tab, every kind) ─────────────────────────
// The app used to list a job's JobNimbus files through /jnapi and show images
// through the open /jnphoto/:jnid. This lists EVERY file on the job (photos,
// the signed work auth PDF, estimates…) with a short-lived signed download
// link, so documents open with their real name and type without exposing the
// master JN token or an unauthenticated proxy for arbitrary files:
//
//   GET /jobs/:id/files?kind=all|images|docs → { files: [{ jnid, filename,
//       content_type, kind: 'image'|'pdf'|'doc', size, date_created, by,
//       description, record_type_name, url }] }
//   GET /jnfile/:jnid?sig=&exp=&name=[&dl=1] → streams the file (inline, or
//       attachment with dl=1); 403 on a bad / expired signature.
//
// sig = HMAC-SHA256(FILE_LINK_SECRET, "<jnid>|<exp>") hex[0..32), exp = unix
// seconds, one hour out — the recording links' pattern (wyh.js). Pure pieces
// (signFileLink / verifyFileLink / fileKind / publicFile) are covered by
// test/jobFiles.test.js. /jnphoto/:jnid is untouched.

const crypto = require('crypto');
const { Readable } = require('stream');
const { uuidRe } = require('./noteReader');
const jnScope = require('./jnScope');

const LINK_TTL_SECS = 60 * 60;
const JNID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function signFileLink(secret, jnid, exp) {
  if (!secret) return null;
  return crypto.createHmac('sha256', String(secret)).update(`${jnid}|${exp}`).digest('hex').slice(0, 32);
}
// true only for a well-formed, unexpired, correctly signed (jnid, exp, sig).
function verifyFileLink(secret, jnid, exp, sig, nowSecs = Math.floor(Date.now() / 1000)) {
  if (!secret || !JNID_RE.test(String(jnid || ''))) return false;
  const e = Number(exp);
  if (!Number.isInteger(e) || e < nowSecs) return false;
  const want = signFileLink(secret, jnid, e);
  const got = String(sig || '');
  if (!want || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got));
}

const isImage = (f) => !!(f && (f.is_image === true || f.subtype === 'image' || (typeof f.content_type === 'string' && f.content_type.startsWith('image/'))));
function fileKind(f) {
  if (isImage(f)) return 'image';
  const ct = String((f && f.content_type) || '').toLowerCase();
  const name = String((f && f.filename) || '').toLowerCase();
  if (ct === 'application/pdf' || ct === 'application/x-pdf' || name.endsWith('.pdf')) return 'pdf';
  return 'doc';
}
// Signed, relative download URL for one JN file (null without a secret).
function fileUrl(secret, jnid, filename, nowSecs = Math.floor(Date.now() / 1000)) {
  const exp = nowSecs + LINK_TTL_SECS;
  const sig = signFileLink(secret, jnid, exp);
  if (!sig) return null;
  return `/jnfile/${encodeURIComponent(jnid)}?sig=${sig}&exp=${exp}&name=${encodeURIComponent(filename || '')}`;
}
// A JN /files record → the shape the app lists.
function publicFile(f, secret, nowSecs) {
  const jnid = String(f.jnid || f.id);
  const filename = (typeof f.filename === 'string' && f.filename.trim()) || `file-${jnid}`;
  const size = Number(f.size);
  return {
    jnid, filename,
    content_type: f.content_type || null,
    kind: fileKind(f),
    size: Number.isFinite(size) ? size : null,
    date_created: typeof f.date_created === 'number' ? f.date_created : null,
    by: f.created_by_name || null,
    description: (typeof f.description === 'string' && f.description.trim()) || null,
    record_type_name: f.record_type_name || null,
    url: fileUrl(secret, jnid, filename, nowSecs),
  };
}
// Content-Disposition with a safe ASCII fallback and the UTF-8 real name.
function contentDisposition(name, attachment) {
  const raw = String(name || 'file').replace(/[\r\n"\\]/g, '_').slice(0, 200);
  const ascii = raw.replace(/[^\x20-\x7e]/g, '_');
  return `${attachment ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(raw)}`;
}

module.exports = function mountJobFiles(app, deps) {
  const { sbGet, jnListJobFiles, requireAuth, loadActor, loadJnScopeProfile, JN_BASE, JN_TOKEN, FILE_LINK_SECRET } = deps;
  const enc = encodeURIComponent;
  const secret = String(FILE_LINK_SECRET || '').trim();
  if (!secret) console.warn('[job-files] FILE_LINK_SECRET / JN_WEBHOOK_TOKEN unset — file links will not be signed');

  app.get('/jobs/:id/files', requireAuth, async (req, res) => {
    try {
      const id = String(req.params.id || '');
      if (!uuidRe.test(id)) return res.status(400).json({ error: 'Bad job id' });
      const actor = await loadActor(req);
      if (!actor) return res.status(403).json({ error: 'Profile not found' });
      const rows = await sbGet(`jobs?id=eq.${enc(id)}&select=id,jn_id,location_id`);
      const job = rows && rows[0];
      if (!job) return res.status(404).json({ error: 'Job not found' });
      const seesAll = ['admin', 'owner', 'executive'].includes(actor.role);
      if (!seesAll && !actor.locs.includes(String(job.location_id))) return res.status(403).json({ error: 'Not your location' });
      // Demo profiles (App Review) only reach JN jobs in their own locations.
      if (loadJnScopeProfile) {
        const p = await loadJnScopeProfile(req.userId);
        if (p && p.is_demo && !jnScope.jobsInScope([String(job.jn_id || '')], [job], jnScope.profileLocationIds(p))) {
          return res.status(403).json({ error: 'Not available on this account' });
        }
      }
      if (!job.jn_id) return res.json({ files: [] });
      const kind = String(req.query.kind || 'all');
      const all = await jnListJobFiles(job.jn_id, { imagesOnly: kind === 'images' });
      const now = Math.floor(Date.now() / 1000);
      let files = all.map((f) => publicFile(f, secret, now));
      if (kind === 'docs') files = files.filter((f) => f.kind !== 'image');
      else if (kind === 'images') files = files.filter((f) => f.kind === 'image');
      res.json({ files });
    } catch (err) { res.status(err.status || 502).json({ error: err.message }); }
  });

  // Signed download — no login (the app opens it in a browser tab / Image source).
  app.get('/jnfile/:jnid', async (req, res) => {
    const jnid = String(req.params.jnid || '');
    if (!verifyFileLink(secret, jnid, req.query.exp, req.query.sig)) return res.status(403).json({ error: 'Link expired or invalid' });
    try {
      const upstream = await fetch(`${JN_BASE}/files/${enc(jnid)}`, { headers: { Authorization: `bearer ${JN_TOKEN}` } });
      if (!upstream.ok) {
        console.warn('[job-files] JN file', jnid, upstream.status);
        return res.status(upstream.status === 404 ? 404 : 502).json({ error: `JobNimbus responded ${upstream.status}` });
      }
      const name = typeof req.query.name === 'string' && req.query.name.trim() ? req.query.name.trim() : `file-${jnid}`;
      res.set('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream')
        .set('Content-Disposition', contentDisposition(name, String(req.query.dl || '') === '1'))
        .set('Cache-Control', 'private, max-age=300');
      const len = upstream.headers.get('content-length');
      if (len) res.set('Content-Length', len);
      if (upstream.body && typeof Readable.fromWeb === 'function') {
        Readable.fromWeb(upstream.body).on('error', (e) => { console.error('[job-files] stream error', e.message); res.end(); }).pipe(res);
      } else {
        res.send(Buffer.from(await upstream.arrayBuffer()));
      }
    } catch (err) {
      console.error('[job-files] error', err.message);
      if (!res.headersSent) res.status(502).json({ error: err.message });
    }
  });

  return { fileUrl: (jnid, filename) => fileUrl(secret, jnid, filename) };
};

module.exports.signFileLink = signFileLink;
module.exports.verifyFileLink = verifyFileLink;
module.exports.fileKind = fileKind;
module.exports.fileUrl = fileUrl;
module.exports.publicFile = publicFile;
module.exports.contentDisposition = contentDisposition;
module.exports.LINK_TTL_SECS = LINK_TTL_SECS;
