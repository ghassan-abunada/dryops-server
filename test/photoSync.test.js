// DryOps photos → JobNimbus (photoSync.js). Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const { createPhotoSync, photoFilename, photoDescription, stamp, MAX_ATTEMPTS, HOLD_MS, SNOOZE_MS } = require('../photoSync');

const NOW = Date.parse('2026-11-19T18:00:00Z');
const quiet = { log() {}, warn() {}, error() {} };

/** A tiny Supabase: photos in memory, the filters photoSync uses, and a record of every upload. */
function world(photos, { jobs = [{ id: 'j1', jn_id: 'JN1' }], rooms = [{ id: 'r1', name: 'Kitchen' }], people = [{ id: 'u1', full_name: 'Chance Dixon' }], upload } = {}) {
  const uploads = [];
  let clock = NOW;
  const free = (p) => !p.jn_sync_claimed_at || Date.parse(p.jn_sync_claimed_at) < clock - HOLD_MS;
  const sbGet = async (q) => {
    if (q.startsWith('photos?')) {
      const job = (q.match(/job_id=eq\.([^&]+)/) || [])[1];
      const limit = Number((q.match(/limit=(\d+)/) || [])[1] || 1000);
      const own = q.includes('storage_url=like.http*');
      return photos.filter((p) => !p.jn_file_id && (!own || /^http/.test(p.storage_url || '')) && (p.jn_sync_attempts || 0) < MAX_ATTEMPTS && free(p) && (!job || p.job_id === job))
        .sort((a, b) => a.taken_at.localeCompare(b.taken_at)).slice(0, limit).map((p) => ({ ...p }));
    }
    if (q.startsWith('jobs?jn_id=')) return jobs.filter((j) => j.jn_id === decodeURIComponent(q.match(/jn_id=eq\.([^&]+)/)[1]));
    if (q.startsWith('jobs?')) return jobs;
    if (q.startsWith('rooms?')) return rooms;
    if (q.startsWith('profiles?')) return people;
    return [];
  };
  const sbPatch = async (_t, filter, patch) => {
    const id = filter.match(/id=eq\.([^&]+)/)[1];
    const p = photos.find((x) => x.id === id);
    if (!p) return [];
    if (filter.includes('jn_file_id=is.null') && p.jn_file_id) return [];
    if (filter.includes('or=(jn_sync_claimed_at') && !free(p)) return [];
    Object.assign(p, patch);
    return [{ ...p }];
  };
  const jnUploadFile = upload || (async (jn, filename, buf, description) => { uploads.push({ jn, filename, description, bytes: buf.length }); return `F${uploads.length}`; });
  const fetchFn = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
  const make = (extra = {}) => createPhotoSync({ sbGet, sbPatch, jnUploadFile, fetchFn, log: quiet, now: () => clock, ...extra });
  return { photos, uploads, make, advance: (ms) => { clock += ms; } };
}
const photo = (over = {}) => ({ id: 'p-0001', job_id: 'j1', room_id: 'r1', storage_url: 'https://x/p.jpg', caption: null, taken_at: '2026-11-12T16:35:00Z', taken_by: 'u1', jn_file_id: null, jn_sync_attempts: 0, jn_sync_claimed_at: null, ...over });

test('names and describes the photo so JobNimbus says where it came from', () => {
  assert.strictEqual(stamp('2026-11-12T16:35:00Z'), '2026-11-12 1035'); // Central
  assert.strictEqual(photoFilename(photo(), 'Kitchen'), '2026-11-12 1035 DryOps Kitchen 0001.jpg');
  assert.strictEqual(photoFilename(photo({ room_id: null }), null), '2026-11-12 1035 DryOps General 0001.jpg');
  assert.strictEqual(photoFilename(photo(), 'Bath/Hall: "2"'), '2026-11-12 1035 DryOps Bath Hall 2 0001.jpg');
  assert.strictEqual(photoDescription(photo(), 'Kitchen', 'Chance Dixon'), 'Taken in DryOps by Chance Dixon · Kitchen · Nov 12, 2026 10:35 AM');
  assert.strictEqual(photoDescription(photo({ caption: 'From homeowner (portal)' }), null, null), 'From the homeowner (DryOps portal) · Nov 12, 2026 10:35 AM');
});

test('uploads a pending photo once and records the JobNimbus file', async () => {
  const w = world([photo()]);
  const r = await w.make().syncPendingPhotos();
  assert.deepStrictEqual([r.scanned, r.uploaded, r.failed], [1, 1, 0]);
  assert.deepStrictEqual(w.uploads[0], { jn: 'JN1', filename: '2026-11-12 1035 DryOps Kitchen 0001.jpg', description: 'Taken in DryOps by Chance Dixon · Kitchen · Nov 12, 2026 10:35 AM', bytes: 3 });
  assert.strictEqual(w.photos[0].jn_file_id, 'F1');
  assert.ok(w.photos[0].jn_synced_at);
  assert.strictEqual(w.photos[0].jn_sync_claimed_at, null);
  const again = await w.make().syncPendingPhotos();
  assert.strictEqual(again.scanned, 0);
  assert.strictEqual(w.uploads.length, 1);
});

test('a photo another run holds is left alone', async () => {
  const w = world([photo({ jn_sync_claimed_at: new Date(NOW - 60 * 1000).toISOString() })]);
  const r = await w.make().syncPendingPhotos();
  assert.strictEqual(r.scanned, 0);
  assert.strictEqual(w.uploads.length, 0);
  w.advance(HOLD_MS); // the other run died: its claim lapses
  assert.strictEqual((await w.make().syncPendingPhotos()).uploaded, 1);
});

test('a failed upload is retried, and given up on after the cap', async () => {
  const w = world([photo()], { upload: async () => { throw new Error('JN files upload 500'); } });
  const sync = w.make();
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const r = await sync.syncPendingPhotos();
    assert.deepStrictEqual([r.uploaded, r.failed], [0, 1]);
  }
  assert.strictEqual(w.photos[0].jn_sync_attempts, MAX_ATTEMPTS);
  assert.match(w.photos[0].jn_sync_error, /500/);
  assert.strictEqual((await sync.syncPendingPhotos()).scanned, 0);
});

test('a job that is not in JobNimbus yet is snoozed, not failed, and does not block the queue', async () => {
  const w = world([photo({ id: 'p-aaaa', job_id: 'j2', taken_at: '2026-11-01T00:00:00Z' }), photo({ id: 'p-bbbb' })], { jobs: [{ id: 'j1', jn_id: 'JN1' }, { id: 'j2', jn_id: null }] });
  const r = await w.make().syncPendingPhotos();
  assert.deepStrictEqual([r.uploaded, r.snoozed, r.failed], [1, 1, 0]);
  assert.strictEqual(w.photos[0].jn_sync_attempts, 0);
  assert.strictEqual((await w.make().syncPendingPhotos()).scanned, 0); // snoozed
  w.advance(SNOOZE_MS + 1000);
  assert.strictEqual((await w.make().syncPendingPhotos()).scanned, 1); // looked at again later
});

test('a row that points at a photo already in JobNimbus is never uploaded', async () => {
  const w = world([photo({ id: 'p-aaaa', storage_url: 'jn:mskqa534utwqkmn8', taken_at: '2026-08-16T19:33:56Z' }), photo({ id: 'p-bbbb' })]);
  const r = await w.make().syncPendingPhotos();
  assert.deepStrictEqual([r.scanned, r.uploaded, r.failed, r.snoozed], [1, 1, 0, 0]);
  assert.strictEqual(w.uploads.length, 1);
  assert.strictEqual(w.photos[0].jn_file_id, null);
  assert.strictEqual(w.photos[0].jn_sync_attempts, 0);
});

test('a dry run uploads nothing and changes nothing', async () => {
  const w = world([photo()]);
  const r = await w.make({ dryrun: true }).syncPendingPhotos();
  assert.strictEqual(r.dryrun, true);
  assert.strictEqual(r.items[0].filename, '2026-11-12 1035 DryOps Kitchen 0001.jpg');
  assert.strictEqual(w.uploads.length, 0);
  assert.strictEqual(w.photos[0].jn_file_id, null);
  assert.strictEqual(w.photos[0].jn_sync_claimed_at, null);
});

test('the flush before a report sends only that job\'s photos', async () => {
  const w = world([photo({ id: 'p-aaaa' }), photo({ id: 'p-bbbb', job_id: 'j2' })], { jobs: [{ id: 'j1', jn_id: 'JN1' }, { id: 'j2', jn_id: 'JN2' }] });
  const r = await w.make().flushJobByJnId('JN1');
  assert.strictEqual(r.uploaded, 1);
  assert.strictEqual(w.photos[1].jn_file_id, null);
  assert.strictEqual(await w.make().flushJobByJnId('NOPE'), null);
});

test('the tick never overlaps itself and survives a broken queue', async () => {
  const w = world([photo()]);
  const sync = w.make();
  const [a, b] = await Promise.all([sync.tick(), sync.tick()]);
  assert.ok(a && b === null);
  const broken = createPhotoSync({ sbGet: async () => null, sbPatch: async () => [], jnUploadFile: async () => 'x', log: quiet });
  assert.strictEqual(await broken.tick(), null);
  assert.match(broken.lastRun().error, /add_photo_jn_sync/);
});
