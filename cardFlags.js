// Card charge flags, the server twin of the app's lib/financials/ledger.ts
// (flagTransactions). Both are pinned to test/fixtures/cardFlags.json, so a rule
// change must land in both repos. A flag means "worth a look", never "wrong".
// Tuned on real October 2026 PEX data (owner review 2026-11-07).
const FLAG_RULES = {
  duplicateDays: 1,
  duplicateMin: 25,
  duplicateExemptAccounts: ['53'],
  aboveUsualTimes: 10,
  aboveUsualMin: 1000,
  roundMin: 200,
  merchantWords: ['liquor', 'wine', 'spirits', 'casino', 'lounge', 'nightclub', 'netflix', 'spotify', 'hulu', 'playstation', 'xbox', 'steam games', 'gift card', 'venmo', 'cash app', 'nail salon', 'golf', 'topgolf', 'hookah', 'brewery', 'dispensary', 'smoke shop', 'vape', 'stubhub', 'ticketmaster'],
};

const MERCHANT_WORDS = new RegExp(`\\b(${FLAG_RULES.merchantWords.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Reasons per transaction id (Map). Refunds are never flagged. Vendor cards
 * (ads, storage) only get the merchant check: their repeats and big bills are normal.
 */
function flagTransactions(txns) {
  const flags = new Map();
  const add = (id, r) => { const list = flags.get(id) || []; if (!list.includes(r)) list.push(r); flags.set(id, list); };
  const byHolder = new Map();
  for (const t of txns) { if (!(t.amount > 0)) continue; const l = byHolder.get(t.cardholder) || []; l.push(t); byHolder.set(t.cardholder, l); }
  const dayMs = 86_400_000;
  for (const list of byHolder.values()) {
    const usual = median(list.map((t) => t.amount));
    const sorted = [...list].sort((a, b) => String(a.at).localeCompare(String(b.at)));
    for (let i = 0; i < sorted.length; i += 1) {
      const t = sorted[i];
      const when = new Date(t.at).getTime();
      if (!t.vendor_card && t.amount >= FLAG_RULES.aboveUsualMin && t.amount > usual * FLAG_RULES.aboveUsualTimes) add(t.id, 'above_usual');
      if (!t.vendor_card && t.amount >= FLAG_RULES.roundMin && t.amount % 100 === 0) add(t.id, 'round');
      if (MERCHANT_WORDS.test(t.merchant)) add(t.id, 'merchant');
      if (t.vendor_card || t.amount < FLAG_RULES.duplicateMin) continue;
      if (FLAG_RULES.duplicateExemptAccounts.some((p) => String(t.account_number || '').startsWith(p))) continue;
      for (let j = i + 1; j < sorted.length; j += 1) {
        const u = sorted[j];
        if (new Date(u.at).getTime() - when > FLAG_RULES.duplicateDays * dayMs) break;
        if (u.merchant === t.merchant && u.amount === t.amount) { add(t.id, 'duplicate'); add(u.id, 'duplicate'); }
      }
    }
  }
  return flags;
}

module.exports = { FLAG_RULES, flagTransactions };
