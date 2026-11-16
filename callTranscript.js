// CallRail call text → what the app shows (GET /wyh/calls/:callrailId/details).
// Pure, no I/O. CallRail's single-call endpoint documents two transcript fields:
//   conversational_transcript  array of { speaker: 'agent' | 'caller', phrase, start }
//   transcription              one plain string
// (both null without Premium Conversation Intelligence). normalizeTranscript
// takes either, plus the looser shapes other code here already guards against,
// and returns [{ speaker, text }] turns or null when there is nothing usable.

const MAX_CHARS = 60000;
const NESTED_KEYS = ['conversation', 'turns', 'phrases', 'conversational_transcript', 'transcript', 'transcription', 'utterances', 'segments', 'items'];
// A speaker label at the start of a line or right after a sentence break.
const PREFIX_RE = /(^|\n|[.!?]["')\]]?\s+)[ \t]*(agent|caller|customer|speaker[ \t]*\d+)[ \t]*:[ \t]*/gi;

function speakerLabel(raw) {
  const s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (/^(agent|caller|customer)$/i.test(s)) return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  return s;
}

function cleanText(raw) {
  return (typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '').replace(/\s+/g, ' ').trim();
}

/** Consecutive turns of one speaker become one; the total text is capped. */
function finish(turns) {
  const out = [];
  let used = 0;
  for (const t of turns) {
    if (used >= MAX_CHARS) break;
    let text = cleanText(t.text);
    if (!text) continue;
    const last = out[out.length - 1];
    const joins = !!last && last.speaker === t.speaker;
    const room = MAX_CHARS - used - (joins ? 1 : 0);
    if (room <= 0) break;
    if (text.length > room) text = text.slice(0, room).trimEnd();
    if (!text) break;
    if (joins) { last.text += ' ' + text; used += text.length + 1; }
    else { out.push({ speaker: t.speaker, text }); used += text.length; }
  }
  return out.length ? out : null;
}

function fromString(str) {
  const turns = [];
  let speaker = '';
  let at = 0;
  let m;
  PREFIX_RE.lastIndex = 0;
  while ((m = PREFIX_RE.exec(str)) !== null) {
    // The sentence break belongs to the turn before the label.
    turns.push({ speaker, text: str.slice(at, m.index + m[1].length) });
    speaker = speakerLabel(m[2]);
    at = m.index + m[0].length;
    if (m[0].length === 0) PREFIX_RE.lastIndex++;
  }
  turns.push({ speaker, text: str.slice(at) });
  return finish(turns);
}

function fromArray(arr) {
  return finish(arr.map((item) => {
    if (typeof item === 'string') return { speaker: '', text: item };
    if (!item || typeof item !== 'object') return { speaker: '', text: '' };
    return {
      speaker: speakerLabel(item.speaker || item.role || item.channel || ''),
      text: item.text || item.content || item.phrase || '',
    };
  }));
}

function normalizeTranscript(raw) {
  if (typeof raw === 'string') return fromString(raw);
  if (Array.isArray(raw)) return fromArray(raw);
  if (raw && typeof raw === 'object') {
    for (const k of NESTED_KEYS) if (Array.isArray(raw[k])) return fromArray(raw[k]);
    for (const k of Object.keys(raw)) if (Array.isArray(raw[k])) return fromArray(raw[k]);
    for (const k of ['text', 'transcription', 'transcript']) if (typeof raw[k] === 'string') return fromString(raw[k]);
  }
  return null;
}

/** CallRail documents call_summary as a string on the list and an array on the single call. */
function summaryText(raw) {
  if (Array.isArray(raw)) return raw.map((x) => (typeof x === 'string' ? x : (x && (x.text || x.summary)) || '')).filter(Boolean).join(' ').trim() || null;
  return typeof raw === 'string' ? raw.trim() || null : null;
}

module.exports = { normalizeTranscript, summaryText, MAX_CHARS };
