'use strict';
// ── Estimate approval from the customer's private link (DryOps app /e/<token>) ──
// The app writes estimates (supabase/add_estimates.sql in the DryOps repo);
// the public page reads the frozen version through the anon-safe
// get_estimate_doc RPC. Only this endpoint writes an approval: it checks the
// link, that the estimate is still "sent", that the customer approved the same
// revision they were shown, hashes that frozen version, records who / when /
// from where, marks the estimate approved and tells the location's channels.
//
// POST /e/:token/approve  { name, revision, agree: true }

const crypto = require('crypto');

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

module.exports = function mountEstimates(app, { sbGet, sbInsert, sbPatch, makeRateLimiter, clientIp, WEB_APP_URL }) {
  const limiter = makeRateLimiter({ limit: 10, windowMs: 10 * 60 * 1000 });
  const enc = encodeURIComponent;

  app.post('/e/:token/approve', async (req, res) => {
    try {
      const token = String(req.params.token || '');
      if (!TOKEN_RE.test(token)) return res.status(404).json({ error: 'not_found' });
      if (!limiter.hit(`${token}|${clientIp(req)}`)) return res.status(429).json({ error: 'Too many tries — wait a few minutes.' });
      const body = req.body || {};
      const name = String(body.name || '').trim().replace(/\s+/g, ' ');
      if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Type your full name to approve.' });
      if (body.agree !== true) return res.status(400).json({ error: 'Tick the box to approve.' });

      const links = await sbGet(`estimate_links?token=eq.${enc(token)}&disabled=eq.false&select=doc_id,revision`);
      const link = links && links[0];
      if (!link) return res.status(404).json({ error: 'not_found' });
      const docs = await sbGet(`estimate_docs?id=eq.${enc(link.doc_id)}&select=id,job_id,location_id,kind,number,status,grand_total`);
      const doc = docs && docs[0];
      if (!doc) return res.status(404).json({ error: 'not_found' });
      if (doc.kind !== 'estimate') return res.status(400).json({ error: 'Only estimates are approved.' });
      if (doc.status === 'approved') return res.json({ ok: true, already: true });
      if (doc.status !== 'sent') return res.status(409).json({ error: 'This estimate is being revised. Ask for the new link.' });

      const vq = link.revision != null ? `&revision=eq.${enc(link.revision)}` : '';
      const versions = await sbGet(`estimate_versions?doc_id=eq.${enc(doc.id)}${vq}&select=revision,body,prices,totals&order=revision.desc&limit=1`);
      const version = versions && versions[0];
      if (!version) return res.status(404).json({ error: 'not_found' });
      if (body.revision != null && Number(body.revision) !== Number(version.revision)) {
        return res.status(409).json({ error: 'This estimate changed since you opened it. Reload to see the latest.' });
      }

      const sha = crypto.createHash('sha256').update(JSON.stringify({ body: version.body, prices: version.prices, totals: version.totals })).digest('hex');
      const at = new Date().toISOString();
      await sbInsert('estimate_approvals', {
        doc_id: doc.id, revision: version.revision, signer_name: name, signed_at: at,
        ip: clientIp(req), user_agent: String(req.headers['user-agent'] || '').slice(0, 300), body_sha256: sha,
      });
      await sbPatch('estimate_docs', `id=eq.${enc(doc.id)}&status=eq.sent`, { status: 'approved', approved_at: at });

      // Tell the location (channels subscribed to estimate_approved); never blocks the answer.
      (async () => {
        try {
          const jobs = await sbGet(`jobs?id=eq.${enc(doc.job_id)}&select=id,name,client_name,address`);
          const job = jobs && jobs[0];
          const { notifyChannels } = require('./notify');
          const appUrl = (WEB_APP_URL || process.env.WEB_APP_URL || 'https://dryops.app').replace(/\/$/, '');
          await notifyChannels({
            sbGet, events: ['estimate_approved'], locationId: doc.location_id,
            msg: {
              lines: [{ b: `✅ Estimate approved · ${job ? job.client_name || job.name : ''}` }, `E-${doc.number} · $${Number(doc.grand_total || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })} · approved by ${name}`],
              buttons: [{ text: 'Open in DryOps', url: `${appUrl}/estimate/${doc.id}` }],
            },
            log: (...a) => console.warn('[estimate approved notify]', ...a),
          });
        } catch (e) { console.warn('[estimate approved notify]', e.message); }
      })();

      res.json({ ok: true, signed_at: at });
    } catch (e) {
      console.error('[estimate approve]', e);
      res.status(500).json({ error: 'Could not record the approval. Try again.' });
    }
  });
};
