// Pure pieces of homeowner.js / hoWindows.js: stage mapping + forward-move
// detection, the per-token rate limiter, free 2-hour presets for "more",
// Twilio signature validation (vector from Twilio's docs), reply parsing,
// chooseWindow's VS001 handling. Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const { stageOf, stageMovedForward, makeRateLimiter, freePresets, STAGE_TEXT, clientIp } = require('../homeowner');
const { twilioSignature, twilioSignatureOk, parseChoice, chooseWindow, validOptions, twiml } = require('../hoWindows');

test('stageOf mirrors public.homeowner_stage()', () => {
  assert.strictEqual(stageOf('Lead'), 'inspection');
  assert.strictEqual(stageOf('Customer Requested Hold'), 'inspection');
  assert.strictEqual(stageOf('Scheduled'), 'demo');
  assert.strictEqual(stageOf('Pending Abatement'), 'demo');
  assert.strictEqual(stageOf('In Progress'), 'drying');
  assert.strictEqual(stageOf('Work Complete'), 'complete');
  assert.strictEqual(stageOf('Invoice Created'), 'complete');
  assert.strictEqual(stageOf('Paid & Closed'), 'complete');
  assert.strictEqual(stageOf('Public Adjuster'), 'complete');
  assert.strictEqual(stageOf('Lost'), null);
  assert.strictEqual(stageOf(null), null);
  assert.strictEqual(stageOf(''), null);
});

test('stageMovedForward: forward only, null/unknown previous counts as before inspection', () => {
  assert.strictEqual(stageMovedForward('inspection', 'demo'), true);
  assert.strictEqual(stageMovedForward('demo', 'drying'), true);
  assert.strictEqual(stageMovedForward('drying', 'pickup'), true);
  assert.strictEqual(stageMovedForward('pickup', 'complete'), true);
  assert.strictEqual(stageMovedForward('demo', 'demo'), false);     // same stage (Scheduled → Pending Results)
  assert.strictEqual(stageMovedForward('drying', 'demo'), false);   // backwards
  assert.strictEqual(stageMovedForward('complete', 'pickup'), false);
  assert.strictEqual(stageMovedForward(null, 'demo'), true);
  assert.strictEqual(stageMovedForward(null, 'inspection'), true);
  assert.strictEqual(stageMovedForward('drying', null), false);     // moved to Lost
  assert.strictEqual(STAGE_TEXT.inspection, undefined);            // no text for the first stage
  for (const s of ['demo', 'drying', 'pickup', 'complete']) {
    const t = STAGE_TEXT[s]('https://dryops.app/h/abc');
    assert.ok(t.includes('https://dryops.app/h/abc'), s);
    assert.ok(!/A1|DryOps|Restoration Co/.test(t), `no company name in ${s}`);
  }
});

test('rate limiter: limit per key per window, slides, resets', () => {
  let t = 0;
  const rl = makeRateLimiter({ limit: 3, windowMs: 1000, now: () => t });
  assert.strictEqual(rl.hit('a'), true);
  assert.strictEqual(rl.hit('a'), true);
  assert.strictEqual(rl.hit('a'), true);
  assert.strictEqual(rl.hit('a'), false);
  assert.strictEqual(rl.hit('b'), true);        // other key unaffected
  assert.strictEqual(rl.count('a'), 3);
  t = 1001;                                     // window passed
  assert.strictEqual(rl.hit('a'), true);
  assert.strictEqual(rl.count('a'), 1);
  rl.reset('a');
  assert.strictEqual(rl.count('a'), 0);
});

test('freePresets: window / half_day / full_day blocks, workday bounds, excludes the visit itself', () => {
  const settings = { work_start_min: 480, work_end_min: 1080, half_day_split: 720 };
  const all = [[480, 600], [600, 720], [720, 840], [840, 960], [960, 1080]].map(([startMin, endMin]) => ({ startMin, endMin }));
  assert.deepStrictEqual(freePresets({ visits: [], settings }), all);
  // a 10–12 window blocks only 10–12
  assert.deepStrictEqual(
    freePresets({ visits: [{ id: 'x', slot_start_min: 600, slot_end_min: 720, block_kind: 'window' }], settings }).map((w) => w.startMin),
    [480, 720, 840, 960]);
  // a half day in the AM blocks 8–12
  assert.deepStrictEqual(
    freePresets({ visits: [{ id: 'x', slot_start_min: 480, slot_end_min: 600, block_kind: 'half_day' }], settings }).map((w) => w.startMin),
    [720, 840, 960]);
  // a half day in the PM blocks 12–6 (hull with its 4–6 slot)
  assert.deepStrictEqual(
    freePresets({ visits: [{ id: 'x', slot_start_min: 960, slot_end_min: 1080, block_kind: 'half_day' }], settings }).map((w) => w.startMin),
    [480, 600]);
  // a full day blocks everything
  assert.deepStrictEqual(freePresets({ visits: [{ id: 'x', slot_start_min: null, slot_end_min: null, block_kind: 'full_day' }], settings }), []);
  // anytime (no slot) windows block nothing; the visit being chosen is ignored
  assert.deepStrictEqual(
    freePresets({ visits: [{ id: 'me', slot_start_min: 480, slot_end_min: 1080, block_kind: 'window' }, { id: 'y', slot_start_min: null, slot_end_min: null, block_kind: 'window' }], settings, excludeId: 'me' }),
    all);
  // a 1–3 custom window overlaps 12–2 and 2–4
  assert.deepStrictEqual(
    freePresets({ visits: [{ id: 'x', slot_start_min: 780, slot_end_min: 900 }], settings }).map((w) => w.startMin),
    [480, 600, 960]);
  // shorter workday drops presets outside it; defaults apply when settings are null
  assert.deepStrictEqual(freePresets({ visits: [], settings: { work_start_min: 600, work_end_min: 960 } }).map((w) => w.startMin), [600, 720, 840]);
  assert.strictEqual(freePresets({ visits: [], settings: null }).length, 5);
});

test('twilio signature: documented vector, mismatch, timing-safe compare', () => {
  // https://www.twilio.com/docs/usage/webhooks/webhooks-security
  const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
  const params = { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' };
  assert.strictEqual(twilioSignature('12345', url, params), '0/KCTR6DLpKmkAf8muzZqo1nDgQ=');
  assert.strictEqual(twilioSignatureOk('12345', url, params, '0/KCTR6DLpKmkAf8muzZqo1nDgQ='), true);
  assert.strictEqual(twilioSignatureOk('12345', url, { ...params, Digits: '9999' }, '0/KCTR6DLpKmkAf8muzZqo1nDgQ='), false);
  assert.strictEqual(twilioSignatureOk('wrong', url, params, '0/KCTR6DLpKmkAf8muzZqo1nDgQ='), false);
  assert.strictEqual(twilioSignatureOk('12345', url, params, 'short'), false);
  assert.strictEqual(twilioSignatureOk('12345', url, params, undefined), false);
  assert.strictEqual(twilioSignatureOk('', url, params, '0/KCTR6DLpKmkAf8muzZqo1nDgQ='), false);
});

test('parseChoice + validOptions + twiml escaping', () => {
  assert.strictEqual(parseChoice('1'), 1);
  assert.strictEqual(parseChoice(' 2 '), 2);
  assert.strictEqual(parseChoice('Option 2'), 2);
  assert.strictEqual(parseChoice('1 please'), 1);
  assert.strictEqual(parseChoice('12'), null);
  assert.strictEqual(parseChoice('neither works'), null);
  assert.strictEqual(parseChoice('3'), null);
  assert.strictEqual(parseChoice(''), null);
  assert.deepStrictEqual(validOptions([{ startMin: 600, endMin: 720 }]), [{ startMin: 600, endMin: 720 }]);
  assert.strictEqual(validOptions([]), null);
  assert.strictEqual(validOptions([{ startMin: 720, endMin: 600 }]), null);
  assert.strictEqual(validOptions([{ startMin: 0, endMin: 1441 }]), null);
  assert.strictEqual(validOptions([{ startMin: 1, endMin: 2 }, { startMin: 3, endMin: 4 }, { startMin: 5, endMin: 6 }]), null);
  assert.strictEqual(twiml(null), '<?xml version="1.0" encoding="UTF-8"?><Response/>');
  assert.strictEqual(twiml("Got it — 2pm–4pm <b>"), '<?xml version="1.0" encoding="UTF-8"?><Response><Message>Got it — 2pm–4pm &lt;b&gt;</Message></Response>');
});

test('clientIp prefers the first X-Forwarded-For hop', () => {
  assert.strictEqual(clientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }, ip: '10.0.0.1' }), '1.2.3.4');
  assert.strictEqual(clientIp({ headers: {}, ip: '10.0.0.1' }), '10.0.0.1');
});

test('chooseWindow: writes the slot, VS001 leaves the visit tentative, missing option', async () => {
  const visit = { id: 'v1', ho_window_options: [{ startMin: 600, endMin: 720 }, { startMin: 840, endMin: 960 }] };
  const patches = [];
  const synced = [];
  const ok = await chooseWindow({
    visit, n: 2, replyText: '2', now: '2026-10-13T15:00:00.000Z',
    sbPatch: async (table, where, patch) => { patches.push({ table, where, patch }); return [{}]; },
    syncVisitJnTask: async (id) => { synced.push(id); },
  });
  assert.deepStrictEqual(ok, { ok: true, status: 'confirmed', window: { startMin: 840, endMin: 960 }, chosen: 2 });
  assert.deepStrictEqual(patches, [{ table: 'inspections', where: 'id=eq.v1', patch: {
    slot_start_min: 840, slot_end_min: 960, scheduled_time: '2pm–4pm', ho_window_status: 'confirmed', ho_chosen: 2,
    ho_reply_text: '2', ho_replied_at: '2026-10-13T15:00:00.000Z',
  } }]);
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(synced, ['v1']);

  const p2 = [];
  const tentative = await chooseWindow({
    visit, n: 1, replyText: 'portal',
    sbPatch: async (table, where, patch) => {
      p2.push(patch);
      if (patch.slot_start_min != null) throw new Error('400 {"code":"VS001","message":"Double booking","details":"[]"}');
      return [{}];
    },
    syncVisitJnTask: async () => { throw new Error('must not sync'); },
  });
  assert.strictEqual(tentative.status, 'tentative');
  assert.strictEqual(tentative.code, 'VS001');
  assert.strictEqual(p2.length, 2);
  assert.strictEqual(p2[1].ho_window_status, 'tentative');
  assert.strictEqual(p2[1].slot_start_min, undefined);

  assert.deepStrictEqual(await chooseWindow({ visit: { id: 'v', ho_window_options: [{ startMin: 1, endMin: 2 }] }, n: 2, sbPatch: async () => { throw new Error('no'); } }), { ok: false, code: 'NO_OPTION' });
  await assert.rejects(chooseWindow({ visit, n: 1, sbPatch: async () => { throw new Error('500 boom'); } }), /boom/);
});
