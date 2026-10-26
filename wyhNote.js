// "WYH - First Last" JobNimbus note text. Byte-for-byte twin of buildWyhNote
// in the DryOps app (lib/wyh.ts); test/fixtures/wyhNote.json pins both. Keep
// the two in sync — change one, change the other, regenerate nothing: the
// fixture is hand-written and both tests assert against it.

function fmtPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  const n = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  if (n.length !== 10) return String(raw || '').trim();
  return `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}`;
}

const NOTE_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function noteDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return String(iso || '');
  return `${NOTE_MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

const NOT_LANDED_LABEL = { quote: 'Gave HO a quote', no_damage: 'No damage found', coach_to_convert: 'Coach to convert', other: 'Other' };
const NOT_TESTED_LABEL = { refused: 'HO/adjuster refused', results_provided: 'Results provided' };
const NO_PO_LABEL = { small_area: 'Small area', empty_rooms: 'Empty rooms', content_manipulation: 'Content manipulation requested', other: 'Other' };
const WALK_REASON_LABEL = { customer_cancelled: 'Customer cancelled', scheduled_later: 'Scheduled later' };
const PHOTO_LABELS = [
  { key: 'photo_exterior', label: 'outside of home' },
  { key: 'photo_moisture', label: 'moisture readings' },
  { key: 'photo_damage', label: 'visible damage' },
  { key: 'photo_wide', label: 'wide room shots' },
];

function buildWyhNote(i) {
  const r = i.review || {};
  const job = i.job || {};
  const box = (ok) => (ok ? '[x]' : '[ ]');
  const lines = [];
  lines.push(`WYH - ${String(i.managerName || '').trim()}`);
  lines.push(`Call: ${[i.callWhen, fmtPhone(i.callPhone) || null, i.source].filter(Boolean).join(' · ')}`);
  lines.push('');

  if (r.walked) {
    if (r.walked === 'yes') lines.push(`${box(true)} Walked: Yes`);
    else {
      const why = r.walk_reason ? WALK_REASON_LABEL[r.walk_reason] : '';
      const when = r.walk_reason === 'scheduled_later' && r.walk_scheduled_for ? ` (${noteDate(r.walk_scheduled_for)})` : '';
      lines.push(`${box(false)} Walked: ${r.walked === 'no' ? 'No' : 'Not yet'}${why ? ` — ${why}${when}` : ''}`);
    }
  }
  if (r.landed != null) {
    if (r.landed) lines.push(`${box(true)} Landed: Yes`);
    else {
      const why = r.not_landed_reason ? NOT_LANDED_LABEL[r.not_landed_reason] : '';
      const note = r.not_landed_reason === 'other' && r.not_landed_note ? `: ${String(r.not_landed_note).trim()}` : '';
      lines.push(`${box(false)} Landed: No${why ? ` — ${why}${note}` : ''}`);
    }
  }
  const have = PHOTO_LABELS.filter((p) => r[p.key]).map((p) => p.label);
  const missing = PHOTO_LABELS.filter((p) => !r[p.key]).map((p) => p.label);
  if (have.length || r.walked === 'yes') {
    if (!missing.length) lines.push(`${box(true)} Photos: ${have.join(', ')}`);
    else if (!have.length) lines.push(`${box(false)} Photos: none`);
    else lines.push(`${box(false)} Photos: ${have.join(', ')} · missing: ${missing.join(', ')}`);
  }
  if (r.insurance != null) {
    if (!r.insurance) lines.push(`${box(true)} Not insurance`);
    else {
      const carrier = r.has_carrier ? String(job.insurer || '').trim() || 'yes' : 'missing';
      const claim = r.has_claim ? String(job.claim_number || '').trim() || 'yes' : 'missing';
      lines.push(`${box(!!r.has_carrier && !!r.has_claim)} Insurance: Yes — carrier: ${carrier} · claim #: ${claim}`);
      if (r.tested != null) {
        if (r.tested) lines.push(`${box(true)} Tested: Yes`);
        else {
          const why = r.not_tested_reason ? NOT_TESTED_LABEL[r.not_tested_reason] : '';
          const yb = r.year_built ? ` · year built ${r.year_built}` : '';
          lines.push(`${box(false)} Tested: No${why ? ` — ${why}` : ''}${yb}`);
        }
      }
      if (r.packout_sold != null) {
        if (r.packout_sold) lines.push(`${box(true)} Packout: Sold`);
        else {
          const parts = [];
          if (r.no_packout_reason) parts.push(NO_PO_LABEL[r.no_packout_reason] + (r.no_packout_reason === 'other' && r.no_packout_note ? `: ${String(r.no_packout_note).trim()}` : ''));
          if (r.no_packout_reason === 'content_manipulation') {
            if (r.rooms_affected != null) parts.push(`${r.rooms_affected} room${r.rooms_affected === 1 ? '' : 's'} affected`);
            if (r.po_feedback_given != null) parts.push(r.po_feedback_given ? 'feedback given to sell a packout' : 'no feedback given');
            if (r.po_real_opportunity != null) parts.push(r.po_real_opportunity ? 'real packout opportunity' : 'not a real opportunity');
          }
          lines.push(`${box(false)} Packout: Not sold${parts.length ? ` — ${parts.join(' · ')}` : ''}`);
        }
      }
    }
  }
  if (r.info_sufficient != null) {
    lines.push(r.info_sufficient
      ? `${box(true)} File info: date of loss, category and cause present`
      : `${box(false)} File info: incomplete (date of loss, category, cause)`);
  }
  if (r.called_back != null || r.missed_reason || r.operator_feedback_given != null || r.operator_response) {
    const parts = [];
    if (r.called_back != null) parts.push(r.called_back ? 'called back' : 'not called back');
    if (r.missed_reason) parts.push(`reason: ${String(r.missed_reason).trim()}`);
    if (r.operator_feedback_given != null) parts.push(r.operator_feedback_given ? 'feedback given to operator' : 'no feedback given');
    if (r.operator_response) parts.push(`response: ${String(r.operator_response).trim()}`);
    lines.push(`Missed call: ${parts.join(' · ')}`);
  }
  const notes = String(r.notes || '').trim();
  if (notes) {
    lines.push('');
    lines.push('Notes:');
    lines.push(notes);
  }
  return lines.join('\n');
}

module.exports = { buildWyhNote, fmtPhone };
