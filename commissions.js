// Commission statements: GET /commissions/statements/<token>.pdf draws the frozen
// statement a manager saved in the app (commission_statements, written under RLS,
// supabase/add_commissions.sql in the app repo). No login, like a scope sheet link,
// so a location's owners can open it: the random token is the key. The rules and the
// numbers live in the app; this only prints what was saved.
const sharp = require('sharp');
const { buildCommissionStatementPdf } = require('./commissionPdf');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOGO_TIMEOUT_MS = 5000;
const LOGO_MAX_BYTES = 8 * 1024 * 1024;

// pdfkit takes PNG and JPEG only; logos are often WebP or SVG. A logo that can't be
// read just leaves the location's name on its own.
async function logoPng(url, fetchImpl = fetch) {
  if (!url || !/^https:\/\//i.test(url)) return null;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(LOGO_TIMEOUT_MS) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > LOGO_MAX_BYTES) return null;
    return await sharp(buf).resize({ width: 480, height: 176, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  } catch (e) {
    return null;
  }
}

function pdfFileName(statement) {
  const safe = String(statement.location_name || 'Location').replace(/[^A-Za-z0-9 ]/g, '').trim().replace(/\s+/g, '-');
  return `Commission-${safe}-${statement.payout_month}.pdf`;
}

module.exports = function mountCommissions(app, { sbGet }) {
  app.get('/commissions/statements/:token.pdf', async (req, res) => {
    const token = req.params.token;
    if (!UUID_RE.test(token)) return res.status(404).send('Not found');
    try {
      const rows = await sbGet(`commission_statements?token=eq.${token}&select=statement,location_id`);
      const row = rows && rows[0];
      if (!row) return res.status(404).send('This statement was not found.');
      let logo = null;
      if (row.location_id) {
        const locs = await sbGet(`locations?id=eq.${row.location_id}&select=logo_url`);
        logo = await logoPng(locs && locs[0] && locs[0].logo_url);
      }
      const pdf = await buildCommissionStatementPdf(row.statement, logo);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${pdfFileName(row.statement)}"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Robots-Tag', 'noindex');
      res.send(pdf);
    } catch (err) {
      console.error('[commissions] statement failed', err.message);
      res.status(502).send('Could not create this statement. Try again in a minute.');
    }
  });
};

module.exports.logoPng = logoPng;
module.exports.pdfFileName = pdfFileName;
