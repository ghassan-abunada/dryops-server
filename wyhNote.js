// "WYH - First Last" JobNimbus note text. Byte-for-byte twin of buildWyhNote
// in the DryOps app (lib/wyh.ts); test/fixtures/wyhNote.json pins both. Keep
// the two in sync — change one, change the other; the fixture is hand-written
// and both tests assert against it.
//
// Layout (owner 2026-10-26): header + call line → general notes → "Action
// Required:" (everything unchecked; a "Follow up needed" line first when the
// manager flagged the review) → "Checklist:". Insurance may be "Pending".

function fmtPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  const n = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  if (n.length !== 10) return String(raw || '').trim();
  return `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}`;
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** '2026-11-03' → 'Tue 11/3' (calendar date, no timezone). */
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
const OPERATOR_RESPONDED_LABEL = { yes: 'responded well', no: 'did not respond well', pending: 'no response yet (follow up)' };
const FOLLOW_UP_LABEL = { waiting: 'Waiting on someone', not_landed: 'Not landed', major_concerns: 'Major concerns', file_incomplete: 'File incomplete', other: 'Other' };
// "Outside of home" dropped 2026-10-26 (owner); the column stays, ignored.
const PHOTO_LABELS = [
  { key: 'photo_moisture', label: 'moisture readings' },
  { key: 'photo_damage', label: 'visible damage' },
  { key: 'photo_wide', label: 'wide room shots' },
];

const other = (note) => (note && String(note).trim() ? `: ${String(note).trim()}` : '');
const followUpReasonLabel = (r) => (r && FOLLOW_UP_LABEL[r]) || '';

/** "replied in 4 min by Ali" / "replied in 2 h 10 min" / "no reply" for the Text: line (twin of lib/wyh.ts). */
function replyPhrase(minutes, by) {
  if (minutes == null) return 'no reply';
  const span = minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
  const who = String(by || '').trim();
  return `replied in ${span}${who ? ` by ${who}` : ''}`;
}

function buildWyhNote(i) {
  const r = i.review;
  // Owner rule: a checkmark, never an x.
  const box = (ok) => (ok ? '[✓]' : '[ ]');
  const head = [];
  const actions = [];
  const check = [];

  head.push(`WYH - ${String(i.managerName || '').trim()}`);
  const takenBy = String(r.call_taken_by_name || '').trim();
  if (i.kind === 'message') {
    // A Google LSA text lead: when it came in, who answered and how fast.
    head.push(`Text: ${[i.callWhen, fmtPhone(i.callPhone) || null, i.source, replyPhrase(i.replyMinutes, i.repliedBy || takenBy || null)].filter(Boolean).join(' · ')}`);
  } else {
    head.push(`Call: ${[i.callWhen, fmtPhone(i.callPhone) || null, i.source, takenBy ? `taken by ${takenBy}` : null].filter(Boolean).join(' · ')}`);
    if (r.call_recording_reviewed) head.push('Call recording reviewed');
  }

  if (r.call_handled != null) {
    const why = String(r.call_missed_reason || '').trim();
    check.push(r.call_handled ? `${box(true)} Call handled properly` : `${box(false)} Call handled properly${why ? ` — ${why}` : ''}`);
    if (!r.call_handled) actions.push(`Call handling${why ? `: ${why}` : ''}`);
  }
  if (r.walked) {
    if (r.walked === 'yes') check.push(`${box(true)} Walked: Yes`);
    else {
      const why = r.walk_reason ? WALK_REASON_LABEL[r.walk_reason] : '';
      let when = '';
      if (r.walk_reason === 'scheduled_later' && r.walk_scheduled_for) {
        const win = fmtWindow(r.walk_slot_start_min, r.walk_slot_end_min);
        when = ` (${fmtMonD(r.walk_scheduled_for)}${win ? `, ${win}` : ''})`;
      }
      const note = r.walk_reason === 'other' ? other(r.walk_reason_note) : '';
      const detail = why ? ` — ${why}${note}${when}` : '';
      check.push(`${box(false)} Walked: ${r.walked === 'no' ? 'No' : 'Not yet'}${detail}`);
      actions.push(`${r.walked === 'no' ? 'Not walked' : 'Walk the job'}${detail}`);
    }
  }
  if (r.walked === 'yes' && r.landed != null) {
    if (r.landed) check.push(`${box(true)} Landed: Yes`);
    else {
      const why = r.not_landed_reason ? NOT_LANDED_LABEL[r.not_landed_reason] : '';
      const note = r.not_landed_reason === 'other' ? other(r.not_landed_note) : '';
      const detail = why ? ` — ${why}${note}` : '';
      check.push(`${box(false)} Landed: No${detail}`);
      actions.push(`Not landed${detail}`);
    }
  }
  const have = PHOTO_LABELS.filter((p) => r[p.key]).map((p) => p.label);
  const missing = PHOTO_LABELS.filter((p) => !r[p.key]).map((p) => p.label);
  if (r.walked === 'yes' && (have.length || r.landed != null)) {
    if (!missing.length) check.push(`${box(true)} Photos: ${have.join(', ')}`);
    else {
      check.push(have.length ? `${box(false)} Photos: ${have.join(', ')} · missing: ${missing.join(', ')}` : `${box(false)} Photos: none`);
      actions.push(`Add photos: ${missing.join(', ')}`);
    }
  }
  if (r.walked === 'yes' && r.landed === true && r.insurance == null && r.insurance_pending) {
    const note = other(r.insurance_note).replace(/^: /, ' — ');
    check.push(`${box(false)} Insurance: Pending${note}`);
    actions.push(`Insurance pending${note}`);
  }
  if (r.walked === 'yes' && r.landed === true && r.insurance != null) {
    if (!r.insurance) check.push(`${box(true)} Not insurance`);
    else {
      const carrier = r.has_carrier ? String(i.job.insurer || '').trim() || 'yes' : 'missing';
      const claim = r.has_claim ? String(i.job.claim_number || '').trim() || 'yes' : 'missing';
      check.push(`${box(!!r.has_carrier && !!r.has_claim)} Insurance: Yes — carrier: ${carrier} · claim #: ${claim}`);
      if (!r.has_carrier) actions.push('Add carrier to the file');
      if (!r.has_claim) actions.push('Add claim number to the file');
      if (r.tested != null) {
        if (r.tested) check.push(`${box(true)} Tested: Yes`);
        else {
          const why = r.not_tested_reason ? NOT_TESTED_LABEL[r.not_tested_reason] : '';
          const note = r.not_tested_reason === 'other' ? other(r.not_tested_note) : '';
          const yb = r.year_built ? ` · year built ${r.year_built}` : '';
          const detail = `${why ? ` — ${why}${note}` : ''}${yb}`;
          check.push(`${box(false)} Tested: No${detail}`);
          actions.push(`Not tested${detail}`);
        }
      }
      if (r.packout_sold != null) {
        if (r.packout_sold) check.push(`${box(true)} Packout: Sold`);
        else {
          const parts = [];
          if (r.no_packout_reason) parts.push(NO_PO_LABEL[r.no_packout_reason] + (r.no_packout_reason === 'other' ? other(r.no_packout_note) : ''));
          if (r.no_packout_reason === 'content_manipulation') {
            if (r.rooms_affected != null) parts.push(`${r.rooms_affected} room${r.rooms_affected === 1 ? '' : 's'} affected`);
            if (r.po_feedback_given != null) parts.push(r.po_feedback_given ? 'feedback given to sell a packout' : 'no feedback given');
            if (r.po_real_opportunity != null) parts.push(r.po_real_opportunity ? 'real packout opportunity' : 'not a real opportunity');
          }
          const detail = parts.length ? ` — ${parts.join(' · ')}` : '';
          check.push(`${box(false)} Packout: Not sold${detail}`);
          actions.push(`Packout not sold${detail}`);
        }
      }
    }
  }
  if (r.info_sufficient != null) {
    if (r.info_sufficient) check.push(`${box(true)} File info: date of loss, category and cause present`);
    else {
      check.push(`${box(false)} File info: incomplete (date of loss, category, cause)`);
      actions.push('Add date of loss, category and cause to the file');
    }
  }
  if (r.called_back != null || r.missed_reason) {
    const parts = [];
    if (r.called_back != null) parts.push(r.called_back ? 'called back' : 'not called back');
    if (r.missed_reason) parts.push(`reason: ${String(r.missed_reason).trim()}`);
    check.push(`Missed call: ${parts.join(' · ')}`);
  }
  // Coaching (every review type): did the operator get feedback, what, and how they took it.
  const coaching = [];
  if (r.operator_feedback_given != null) {
    coaching.push(r.operator_feedback_given ? 'Coaching: feedback given' : 'Coaching: no feedback given');
    if (r.operator_feedback_given && String(r.operator_feedback || '').trim()) coaching.push(`- Feedback: ${String(r.operator_feedback || '').trim()}`);
    if (r.operator_feedback_given && r.operator_responded && OPERATOR_RESPONDED_LABEL[r.operator_responded]) coaching.push(`- Response: ${OPERATOR_RESPONDED_LABEL[r.operator_responded]}`);
    else if (r.operator_feedback_given && String(r.operator_response || '').trim()) coaching.push(`- Response: ${String(r.operator_response || '').trim()}`);
    if (!r.operator_feedback_given) actions.push('Give the operator feedback');
  }

  // "Needs a follow up" leads Action Required: the file comes back at the end of the week.
  if (r.needs_follow_up && !r.follow_up_resolved_at) {
    const why = followUpReasonLabel(r.follow_up_reason);
    const note = other(r.follow_up_note);
    actions.unshift(`Follow up needed${why ? ` — ${why}${note}` : note.replace(/^: /, ' — ')}`);
  }

  // Layout (owner 2026-10-26): header → general notes → Action Required → checklist.
  const out = [...head];
  const notes = String(r.notes || '').trim();
  if (notes) { out.push(''); out.push(notes); }
  out.push('');
  if (actions.length) { out.push('Action Required:'); for (const a of actions) out.push(`- ${a}`); }
  else out.push('Action Required: none');
  if (check.length) { out.push(''); out.push('Checklist:'); out.push(...check); }
  if (coaching.length) { out.push(''); out.push(...coaching); }
  return out.join('\n');
}

module.exports = { replyPhrase, buildWyhNote, fmtPhone, fmtMonD, fmtWindow };
