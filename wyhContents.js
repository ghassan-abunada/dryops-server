'use strict';
// ── Wash Your Hands for Contents (packout) jobs (owner 2026-11-13) ───────────
// A Contents lead is a job a mitigation company referred, so the review has no
// call: it checks the file (walked, landed, work authorization, wide photos,
// carrier, claim, what was sold, the pack-out booked in a timely manner) and
// ends with the same `WYH - First Last` note on the job, tagging its owners.
//
//   POST /wyh/contents/:reviewId/submit  { facts }
//     facts = the dated lines the reviewer saw beside the answers (referred
//     on / by, the day counts, walked on); the answers themselves are read
//     from wyh_reviews, never from the request.
//   → { ok, note_id, error, mentions, text }
//
// The note text is the DryOps app's lib/wyhContents.ts, compiled into
// vendor/contents by its scripts/vendor-contents.sh and pinned by
// test/fixtures/wyhContents.json. The mitigation WYH (wyh.js) is untouched.

const { buildContentsWyhNote } = require('./vendor/contents/wyhContents');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVIEW_ROLES = new Set(['admin', 'owner', 'expansion_manager']);
const str = (v, max) => (v === undefined || v === null ? '' : String(v)).replace(/[\r\n]+/g, ' ').trim().slice(0, max);

/** The request's facts as plain one-line strings; the carrier and claim come from the job, not the request. */
function cleanFacts(raw, job) {
  const f = raw && typeof raw === 'object' ? raw : {};
  return {
    referred_on: str(f.referred_on, 40),
    referred_by: str(f.referred_by, 120) || null,
    timing: str(f.timing, 240),
    walked_on: str(f.walked_on, 40) || null,
    insurer: (job && job.insurer) || null,
    claim_number: (job && job.claim_number) || null,
  };
}

module.exports = function mountWyhContents(app, deps) {
  const { requireAuth, loadActor, sbGet, sbPatch, jnGetJson, jnAddNote, jnFetchAccountUsers } = deps;
  const warn = deps.warn || ((...a) => console.warn('[wyh contents]', ...a));
  const enc = encodeURIComponent;

  // "@FirstLast" for each JobNimbus owner of the job (the mitigation WYH tags them the same way).
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

  async function submitContentsReview(id, body, actor) {
    if (!UUID.test(String(id))) return { status: 400, body: { error: 'Bad review id' } };
    if (!actor) return { status: 403, body: { error: 'Profile not found' } };
    if (!REVIEW_ROLES.has(actor.role)) return { status: 403, body: { error: 'Not allowed' } };
    const review = ((await sbGet(`wyh_reviews?id=eq.${enc(id)}&select=*`)) || [])[0];
    if (!review) return { status: 404, body: { error: 'Review not found' } };
    if (review.vertical !== 'contents' || !review.lead_job_id) return { status: 400, body: { error: 'This is not a Contents review' } };
    if (actor.role === 'expansion_manager' && !actor.locs.includes(String(review.location_id))) return { status: 403, body: { error: 'Not your location' } };
    const job = ((await sbGet(`jobs?id=eq.${enc(review.lead_job_id)}&select=id,jn_id,name,insurer,claim_number,jn_location_id,location_id`)) || [])[0];
    if (!job || !job.jn_id) return { status: 400, body: { error: 'The job has no JobNimbus id' } };

    const managerName = String(review.reviewer_name || actor.name || '').trim() || 'DryOps';
    const text = buildContentsWyhNote({ managerName, facts: cleanFacts(body && body.facts, job), review });
    const mentions = await ownerMentions(job.jn_id);
    const r = await jnAddNote(job.jn_id, text, { mentions, jnLocationId: job.jn_location_id, createdBy: actor.jn_user_id });
    const now = new Date().toISOString();
    const done = { status: 'complete', completed_at: review.completed_at || now, completed_by_name: managerName, kind: 'wyh', reviewer_name: managerName, job_id: job.id };
    const patch = r.ok
      ? { ...done, jn_note_id: String(r.id || 'ok'), jn_note_error: null }
      : { ...done, jn_note_error: String(r.error || 'JobNimbus note failed').slice(0, 300) };
    await sbPatch('wyh_reviews', `id=eq.${enc(id)}`, patch);
    return { status: r.ok ? 200 : 502, body: { ok: !!r.ok, note_id: r.ok ? r.id : null, error: r.ok ? null : r.error, mentions, text } };
  }

  app.post('/wyh/contents/:id/submit', requireAuth, async (req, res) => {
    try {
      const out = await submitContentsReview(String(req.params.id || ''), req.body, await loadActor(req));
      res.status(out.status).json(out.body);
    } catch (err) {
      warn('submit failed', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  return { submitContentsReview };
};

module.exports.cleanFacts = cleanFacts;
