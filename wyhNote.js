// "WYH - First Last" JobNimbus note text. Byte-for-byte twin of buildWyhNote
// in the DryOps app (lib/wyh.ts); test/fixtures/wyhNote.json pins both. Keep
// the two in sync — change one, change the other; the fixture is hand-written
// and both tests assert against it.

function fmtPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  const n = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  if (n.length !== 10) return String(raw || '').trim();
  return `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}`;
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** '2026-11-03' → 'Mon 11/3' (calendar date, no timezone). */
function fmtMonD(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return String(iso || '');
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${DOW[d.getUTCDay()]} ${Number(m[2])}/${Number(m[3])}`;
}
function fmtMin(min) {
  const h24 = Math.floor(min / 60), mm = min % 60;
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}${mm ? ':' + String(mm).padStart(2, '0') : ''}${h24 < 12 ? 'am' : 'pm'}`;
}
function fmtWindow(start, end) {
  if (start == null || end == null) return '';
  return `${fmtMin(start)}–${fmtMin(end)}`;
}

const NOT_LANDED_LABEL = { quote: 'Gave HO a quote', no_damage: 'No damage found', coach_to_convert: 'Coach to convert', other: 'Other' };
const NOT_TESTED_LABEL = { refused: 'HO/adjuster refused', results_provided: 'Results provided', other: 'Other' };
const NO_PO_LABEL = { small_area: 'Small area', empty_rooms: 'Empty rooms', content_manipulation: 'Content manipulation requested', other: 'Other' };
const WALK_REASON_LABEL = { customer_cancelled: 'Customer cancelled', scheduled_later: 'Scheduled later', other: 'Other' };
const PHOTO_LABELS = [
  { key: 'photo_exterior', label: 'outside of home' },
  { key: 'photo_moisture', label: 'moisture readings' },
  { key: 'photo_damage', label: 'visible damage' },
  { key: 'photo_wide', label: 'wide room shots' },
];

const other = (note) => (note && String(note).trim() ? `: ${String(note).trim()}` : '');

function buildWyhNote(i) {
  const r = i.review || {};
  const job = i.job || {};
  // Owner rule: a checkmark, never an x.
  const box = (ok) => (ok ? '[✓]' : '[ ]');
  const lines = [];
  lines.push(`WYH - ${String(i.managerName || '').trim()}`);
  const takenBy = String(r.call_taken_by_name || '').trim();
  lines.push(`Call: ${[i.callWhen, fmtPhone(i.callPhone) || null, i.source, takenBy ? `taken by ${takenBy}` : null].filter(Boolean).join(' · ')}`);
  if (r.call_recording_reviewed) lines.push('Call recording reviewed');
  if (r.call_handled != null) {
    lines.push(r.call_handled ? `${box(true)} Call handled properly` : `${box(false)} Call handled properly${other(r.call_missed_reason) ? ` —${other(r.call_missed_reason).slice(1)}` : ''}`);
  }
  lines.push('');

  if (r.walked) {
    if (r.walked === 'yes') lines.push(`${box(true)} Walked: Yes`);
    else {
      const why = r.walk_reason ? WALK_REASON_LABEL[r.walk_reason] : '';
      let when = '';
      if (r.walk_reason === 'scheduled_later' && r.walk_scheduled_for) {
        const win = fmtWindow(r.walk_slot_start_min, r.walk_slot_end_min);
        when = ` (${fmtMonD(r.walk_scheduled_for)}${win ? `, ${win}` : ''})`;
      }
      const note = r.walk_reason === 'other' ? other(r.walk_reason_note) : '';
      lines.push(`${box(false)} Walked: ${r.walked === 'no' ? 'No' : 'Not yet'}${why ? ` — ${why}${note}${when}` : ''}`);
    }
  }
  if (r.walked === 'yes' && r.landed != null) {
    if (r.landed) lines.push(`${box(true)} Landed: Yes`);
    else {
      const why = r.not_landed_reason ? NOT_LANDED_LABEL[r.not_landed_reason] : '';
      const note = r.not_landed_reason === 'other' ? other(r.not_landed_note) : '';
      lines.push(`${box(false)} Landed: No${why ? ` — ${why}${note}` : ''}`);
    }
  }
  const have = PHOTO_LABELS.filter((p) => r[p.key]).map((p) => p.label);
  const missing = PHOTO_LABELS.filter((p) => !r[p.key]).map((p) => p.label);
  if (r.walked === 'yes' && (have.length || r.landed != null)) {
    if (!missing.length) lines.push(`${box(true)} Photos: ${have.join(', ')}`);
    else if (!have.length) lines.push(`${box(false)} Photos: none`);
    else lines.push(`${box(false)} Photos: ${have.join(', ')} · missing: ${missing.join(', ')}`);
  }
  if (r.walked === 'yes' && r.landed === true && r.insurance != null) {
    if (!r.insurance) lines.push(`${box(true)} Not insurance`);
    else {
      const carrier = r.has_carrier ? String(job.insurer || '').trim() || 'yes' : 'missing';
      const claim = r.has_claim ? String(job.claim_number || '').trim() || 'yes' : 'missing';
      lines.push(`${box(!!r.has_carrier && !!r.has_claim)} Insurance: Yes — carrier: ${carrier} · claim #: ${claim}`);
      if (r.tested != null) {
        if (r.tested) lines.push(`${box(true)} Tested: Yes`);
        else {
          const why = r.not_tested_reason ? NOT_TESTED_LABEL[r.not_tested_reason] : '';
          const note = r.not_tested_reason === 'other' ? other(r.not_tested_note) : '';
          const yb = r.year_built ? ` · year built ${r.year_built}` : '';
          lines.push(`${box(false)} Tested: No${why ? ` — ${why}${note}` : ''}${yb}`);
        }
      }
      if (r.packout_sold != null) {
        if (r.packout_sold) lines.push(`${box(true)} Packout: Sold`);
        else {
          const parts = [];
          if (r.no_packout_reason) parts.push(NO_PO_LABEL[r.no_packout_reason] + (r.no_packout_reason === 'other' ? other(r.no_packout_note) : ''));
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

module.exports = { buildWyhNote, fmtPhone, fmtMonD, fmtWindow };
