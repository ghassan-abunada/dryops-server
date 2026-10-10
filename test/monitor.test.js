// Pure pieces of monitor.js: prompt payload builder (city, note order/clip)
// and the no-notes rule row. Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const { cityOf, buildJobInputs, ruleRow, fullRow, userText, PROMPT_VERSION, MonitorReviewSchema } = require('../monitor');
const { notesHash } = require('../noteReader');

const DAY = 86400;
const T0 = Date.UTC(2026, 9, 1) / 1000; // 2026-10-01
const job = { id: '11111111-1111-4111-8111-111111111111', jn_id: 'jn1', number: '1234', name: 'Smith, John', client_name: 'John Smith', status: 'In Progress', location_id: 'loc1', sales_rep: 'Pat', address: '123 Main St, Apt 4, Denver, CO 80202' };
const act = (jnid, daysAgo, note, extra = {}) => ({
  jnid, note, record_type_name: 'Note', created_by_name: 'Tech Tom', date_created: T0 - daysAgo * DAY, date_updated: T0 - daysAgo * DAY,
  is_active: true, is_archived: false, related: [{ type: 'job', id: 'jn1' }], ...extra,
});
const OPTS = { notesPerJob: 2, noteChars: 20, nowISO: '2026-10-01T12:00:00.000Z' };

test('cityOf keeps only the last two address parts', () => {
  assert.strictEqual(cityOf('123 Main St, Apt 4, Denver, CO 80202'), 'Denver, CO 80202');
  assert.strictEqual(cityOf('123 Main St, Denver'), '123 Main St, Denver');
  assert.strictEqual(cityOf('123 Main St'), null);
  assert.strictEqual(cityOf(''), null);
  assert.strictEqual(cityOf(null), null);
});

test('payload: newest first, clipped to notesPerJob/noteChars, system rows and html dropped', () => {
  const acts = [
    act('old', 10, 'oldest note that should be cut by notesPerJob'),
    act('mid', 5, '<p>Readings&nbsp;taken, 4 air movers running fine</p>'),
    act('sys', 1, 'x', { record_type_name: 'Status Changed' }),
    act('auto', 1, 'automation text', { created_by_name: 'Automation (JN)' }),
    act('new', 2, 'Dry at goal, pull equipment tomorrow'),
    act('other', 0, 'belongs to another job', { related: [{ type: 'job', id: 'jn2' }] }),
  ];
  const [inp] = buildJobInputs([job], acts, OPTS);
  assert.deepStrictEqual(inp.payload, {
    job_number: '1234', name: 'Smith, John', status: 'In Progress', sales_rep: 'Pat', city: 'Denver, CO 80202',
    notes: [
      { when: '2026-09-29', by: 'Tech Tom', text: 'Dry at goal, pull eq' },
      { when: '2026-09-26', by: 'Tech Tom', text: 'Readings taken, 4 ai' },
    ],
  });
  assert.ok(!('address' in inp.payload) && !('client_name' in inp.payload), 'no street address or client name sent');
  // deterministic fields
  assert.strictEqual(inp.deterministic.note_count, 3);
  assert.strictEqual(inp.deterministic.last_human_note_by, 'Tech Tom');
  assert.strictEqual(inp.deterministic.last_human_note_at, new Date((T0 - 2 * DAY) * 1000).toISOString());
  assert.strictEqual(inp.deterministic.last_note_jnid, 'sys'); // newest activity of any kind (stable sort: sys before auto)
  assert.strictEqual(inp.deterministic.activity_cursor, T0 - 1 * DAY);
  assert.strictEqual(inp.deterministic.last_synced, OPTS.nowISO);
  // hash covers only the notes that go to the model, with the monitor prompt version
  assert.strictEqual(inp.fp, notesHash(PROMPT_VERSION, [acts[4], acts[1]]));
  assert.strictEqual(PROMPT_VERSION, 'm1');
  assert.match(userText(inp.payload, '2026-10-01'), /^Today is 2026-10-01\.\n\{/);
});

test('rule row when no human notes in the lookback', () => {
  const [inp] = buildJobInputs([job], [act('sys', 1, 'x', { record_type_name: 'Job Modified' })], OPTS);
  assert.strictEqual(inp.notes.length, 0);
  const row = ruleRow(inp.deterministic, inp.fp, OPTS.nowISO, 45);
  assert.strictEqual(row.model, 'rule');
  assert.strictEqual(row.dry_status, 'unknown');
  assert.strictEqual(row.ready_for_closeout, false);
  assert.strictEqual(row.summary, 'No notes in last 45 days');
  assert.strictEqual(row.confidence, 1);
  assert.strictEqual(row.prompt_version, 'm1');
  assert.strictEqual(row.reviewed_at, OPTS.nowISO);
  assert.strictEqual(row.notes_hash, inp.fp);
  assert.strictEqual(row.job_id, job.id);
  for (const k of ['last_monitored_date', 'last_monitored_cite', 'equipment_on_site', 'ho_availability', 'ho_constraints', 'access_instructions', 'special_instructions', 'blockers', 'error', 'error_at']) {
    assert.strictEqual(row[k], null, k);
  }
});

test('fullRow sanitises model output', () => {
  const llm = MonitorReviewSchema.parse({
    last_monitored_date: '2026-09-29', last_monitored_cite: '2026-09-29 by Tech Tom',
    equipment_on_site: [{ type: 'air mover', qty: 4 }, { type: 'dehu', qty: null }, { type: '', qty: 1 }],
    dry_status: 'dry', ready_for_closeout: true,
    ho_availability: 'x'.repeat(200), ho_constraints: null, access_instructions: null, special_instructions: null, blockers: null,
    summary: 'Dry at goal 2026-09-29', confidence: 1.7,
  });
  const det = { job_id: job.id, jn_id: 'jn1' };
  const row = fullRow(det, 'abc', llm, 'gemini:test', OPTS.nowISO);
  assert.deepStrictEqual(row.equipment_on_site, [{ type: 'air mover', qty: 4 }, { type: 'dehu', qty: null }]);
  assert.strictEqual(row.ho_availability.length, 160);
  assert.strictEqual(row.confidence, 1);
  assert.strictEqual(row.last_monitored_date, '2026-09-29');
  // a non-date answer is dropped together with its cite
  const bad = fullRow(det, 'abc', { ...llm, last_monitored_date: 'last week' }, 'gemini:test', OPTS.nowISO);
  assert.strictEqual(bad.last_monitored_date, null);
  assert.strictEqual(bad.last_monitored_cite, null);
});
