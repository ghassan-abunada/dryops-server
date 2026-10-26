// "Wash Your Hands" — POST /wyh/reviews/:id/submit posts the completed
// checklist as a "WYH - First Last" note on the JobNimbus job, authored as the
// manager (profiles.jn_user_id) and @mentioning the job's owners (owner rule
// 2026-10-26: owners only, no location tag). The review row itself is written
// by the app under RLS (supabase/add_wyh.sql); this endpoint only needs the JN
// token. Note text: wyhNote.js (twin of lib/wyh.ts in the app).
//
// Inline call playback: GET /wyh/calls/:callrailId/recording-link (JWT) mints a
// short-lived signed URL; GET /wyh/recording/:callrailId.mp3?exp&sig streams the
// CallRail recording (API key stays server-side; the app's <audio> can't send a
// bearer header, hence the signature).
const crypto = require('crypto');
const { Readable } = require('stream');
const { buildWyhNote } = require('./wyhNote');

const RECORDING_TTL_MS = 2 * 60 * 60 * 1000;

function recordingSig(secret, callrailId, exp) {
  return crypto.createHmac('sha256', String(secret)).update(`${callrailId}|${exp}`).digest('hex').slice(0, 32);
}

module.exports = function mountWyh(app, deps) {
  const {
    requireAuth, sbGet, sbPatch, sbInsert, jnGetJson, jnAddNote, jnFetchAccountUsers, loadActor, UUID_RE,
    callrailApi, CALLRAIL_ACCOUNT_IDS, CALLRAIL_API_KEY, RECORDING_SECRET,
  } = deps;
  const enc = encodeURIComponent;
  const warn = (...a) => console.warn('[wyh]', ...a);
  const SEES_ALL = ['admin', 'owner', 'executive'];
  const CR_ID_RE = /^[A-Za-z0-9_-]{3,64}$/;

  // "Mon 10/26, 2:15 PM" in the location's timezone (WYH dates are "Mon M/D").
  function callWhen(iso, tz) {
    if (!iso) return '';
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/Chicago', weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }).formatToParts(new Date(iso));
      const g = (t) => (parts.find((p) => p.type === t) || {}).value || '';
      return `${g('weekday')} ${g('month')}/${g('day')}, ${g('hour')}:${g('minute')} ${g('dayPeriod')}`.replace(/\s+/g, ' ').trim();
    } catch { return String(iso).slice(0, 16); }
  }

  // JN job owners → "@FirstLast" mentions (same shape intake.js uses).
  async function ownerMentions(jnJobId) {
    try {
      const job = await jnGetJson(`jobs/${enc(jnJobId)}?fields=jnid,owners,sales_rep`);
      const owners = Array.isArray(job && job.owners) ? job.owners : [];
      if (!owners.length) return [];
      const users = await jnFetchAccountUsers();
      const out = [];
      for (const o of owners) {
        const u = users.get(o && o.id);
        const name = u && String(u.name || '').trim();
        if (name) { const m = '@' + name.replace(/\s+/g, ''); if (!out.includes(m)) out.push(m); }
      }
      return out;
    } catch (e) { warn('owners lookup failed', e.message); return []; }
  }

  app.post('/wyh/reviews/:id/submit', requireAuth, async (req, res) => {
    const id = String(req.params.id || '');
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Bad review id' });
    try {
      const actor = await loadActor(req);
      if (!actor) return res.status(403).json({ error: 'Profile not found' });
      if (!['admin', 'owner', 'expansion_manager'].includes(actor.role)) return res.status(403).json({ error: 'Not allowed' });
      const review = ((await sbGet(`wyh_reviews?id=eq.${enc(id)}&select=*`)) || [])[0];
      if (!review) return res.status(404).json({ error: 'Review not found' });
      if (actor.role === 'expansion_manager' && !actor.locs.includes(String(review.location_id))) return res.status(403).json({ error: 'Not your location' });
      if (!review.job_id) return res.status(400).json({ error: 'Link a JobNimbus job to this call first' });

      const call = ((await sbGet(`calls?id=eq.${enc(review.call_id)}&select=id,start_time,customer_phone_number,source,is_google_ads`)) || [])[0];
      const job = ((await sbGet(`jobs?id=eq.${enc(review.job_id)}&select=id,jn_id,name,lead_type,insurer,claim_number,jn_location_id,location_id`)) || [])[0];
      if (!job || !job.jn_id) return res.status(400).json({ error: 'The linked job has no JobNimbus id' });
      const loc = job.location_id ? ((await sbGet(`locations?id=eq.${enc(job.location_id)}&select=timezone`)) || [])[0] : null;

      const managerName = String(review.reviewer_name || actor.name || '').trim() || 'DryOps';
      const source = job.lead_type || (call && call.is_google_ads ? 'Google' : (call && call.source) || 'CallRail');
      const text = buildWyhNote({
        managerName,
        callWhen: callWhen(call && call.start_time, loc && loc.timezone),
        callPhone: call ? call.customer_phone_number : null,
        source,
        review,
        job: { insurer: job.insurer, claim_number: job.claim_number },
      });
      const mentions = await ownerMentions(job.jn_id);
      const r = await jnAddNote(job.jn_id, text, { mentions, jnLocationId: job.jn_location_id, createdBy: actor.jn_user_id });
      const now = new Date().toISOString();
      const patch = r.ok
        ? { jn_note_id: String(r.id || 'ok'), jn_note_error: null, status: 'complete', completed_at: review.completed_at || now, kind: 'wyh', reviewer_name: managerName }
        : { jn_note_error: String(r.error || 'JobNimbus note failed').slice(0, 300), status: 'complete', completed_at: review.completed_at || now, kind: 'wyh', reviewer_name: managerName };
      await sbPatch('wyh_reviews', `id=eq.${enc(id)}`, patch);
      return res.status(r.ok ? 200 : 502).json({ ok: r.ok, note_id: r.ok ? r.id : null, error: r.ok ? null : r.error, mentions, text });
    } catch (err) {
      warn('submit failed', err.message);
      return res.status(502).json({ error: err.message });
    }
  });

  // ── Inline playback ───────────────────────────────────────────────────────
  app.get('/wyh/calls/:callrailId/recording-link', requireAuth, async (req, res) => {
    const id = String(req.params.callrailId || '');
    if (!CR_ID_RE.test(id)) return res.status(400).json({ error: 'Bad call id' });
    if (!RECORDING_SECRET || !CALLRAIL_API_KEY) return res.status(503).json({ error: 'Recording playback is not configured on the server' });
    try {
      const actor = await loadActor(req);
      if (!actor) return res.status(403).json({ error: 'Profile not found' });
      const call = ((await sbGet(`calls?callrail_id=eq.${enc(id)}&select=id,location_id,duration,recording_url,call_summary`)) || [])[0];
      if (!call) return res.status(404).json({ error: 'Call not found' });
      if (!SEES_ALL.includes(actor.role) && !actor.locs.includes(String(call.location_id))) return res.status(403).json({ error: 'Not your location' });
      // The AI call summary (CallRail Conversation Intelligence) is only mirrored
      // for job-linked calls by the intake sweep; fetch it on demand here and
      // remember it so the next open is instant.
      let summary = call.call_summary || null;
      let hasRecording = true;
      try {
        const found = await findCallDetails(id);
        if (found) {
          hasRecording = !!found.recording;
          if (!summary && found.summary) { summary = found.summary; sbPatch('calls', `id=eq.${enc(call.id)}`, { call_summary: summary }).catch(() => {}); }
        }
      } catch (e) { warn('summary lookup failed', e.message); }
      const exp = Date.now() + RECORDING_TTL_MS;
      const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
      const base = `${proto}://${req.get('host')}`;
      return res.json({
        url: hasRecording ? `${base}/wyh/recording/${enc(id)}.mp3?exp=${exp}&sig=${recordingSig(RECORDING_SECRET, id, exp)}` : null,
        expires_at: new Date(exp).toISOString(), duration: call.duration, summary,
      });
    } catch (err) { return res.status(502).json({ error: err.message }); }
  });

  // Resolve the recording URL (+ AI summary) for a call across the configured CallRail accounts.
  async function findCallDetails(callrailId) {
    for (const acct of CALLRAIL_ACCOUNT_IDS) {
      const r = await callrailApi(acct, `calls/${enc(callrailId)}.json?fields=recording,recording_duration,call_summary`);
      if (r.ok && r.json) return { account: acct, recording: r.json.recording || null, summary: r.json.call_summary || null };
    }
    return null;
  }
  const findRecordingUrl = findCallDetails;

  app.get('/wyh/recording/:callrailId.mp3', async (req, res) => {
    const id = String(req.params.callrailId || '');
    const exp = Number(req.query.exp || 0);
    const sig = String(req.query.sig || '');
    if (!CR_ID_RE.test(id) || !exp || !sig) return res.status(400).send('Bad request');
    if (!RECORDING_SECRET) return res.status(503).send('Not configured');
    const expected = recordingSig(RECORDING_SECRET, id, exp);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return res.status(403).send('Bad signature');
    if (Date.now() > exp) return res.status(410).send('Link expired');
    try {
      const found = await findRecordingUrl(id);
      if (!found || !found.recording) return res.status(404).send('No recording for this call');
      // The recording endpoint needs the API key and redirects to the audio
      // file (a signed URL that must be fetched WITHOUT our Authorization
      // header). Forward Range so the browser can seek.
      const range = req.headers.range;
      // CallRail's `recording` resource answers the API key with a JSON body
      // {"url": ".../recording/redirect?access_key=…"} (verified 2026-10-26);
      // that url 302s to the MP3 and must be fetched WITHOUT our Authorization
      // header. Older accounts may redirect straight away — handle both.
      let upstream = await fetch(found.recording, { redirect: 'manual', headers: { Authorization: `Token token="${CALLRAIL_API_KEY}"`, Accept: 'application/json' } });
      const ct = String(upstream.headers.get('content-type') || '');
      if (upstream.ok && /json/i.test(ct)) {
        const j = await upstream.json().catch(() => null);
        if (!j || !j.url) return res.status(404).send('No recording for this call');
        upstream = await fetch(j.url, { redirect: 'follow', headers: range ? { Range: range } : {} });
      } else if (upstream.status >= 300 && upstream.status < 400 && upstream.headers.get('location')) {
        upstream = await fetch(upstream.headers.get('location'), { redirect: 'follow', headers: range ? { Range: range } : {} });
      }
      if (!upstream.ok && upstream.status !== 206) return res.status(upstream.status === 404 ? 404 : 502).send('Recording unavailable');
      res.status(upstream.status === 206 ? 206 : 200);
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
      for (const h of ['content-length', 'content-range', 'accept-ranges']) { const v = upstream.headers.get(h); if (v) res.setHeader(h, v); }
      if (!upstream.headers.get('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      if (!upstream.body) return res.end();
      Readable.fromWeb(upstream.body).on('error', () => res.end()).pipe(res);
    } catch (err) {
      warn('recording stream failed', err.message);
      if (!res.headersSent) res.status(502).send('Recording unavailable');
      else res.end();
    }
  });
};

module.exports.recordingSig = recordingSig;
