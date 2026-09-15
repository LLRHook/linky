import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createMediaAssetStore } from '../src/services/MediaAssetStore';
import { createMediaReuseIndex } from '../src/services/MediaReuseIndex';
import { createEromeMediaPreparer } from '../src/services/EromeMediaRuntime';
import { createEromeWorkScheduler } from '../src/services/EromeWorkScheduler';
import { resolveEromeAlbum } from '../src/services/Erome';

const album = 'https://www.erome.com/a/ControlledFixture', source = 'https://v63.erome.com/ControlledFixture/video.mp4';
const bytes = Buffer.from('validated complete source'), metadata = { width: 1280, height: 720, duration: 2, fps: 30 };
const message = (index: number) => String(123456789012345670n + BigInt(index));

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'linky-reuse-runtime-')), controller = new AbortController();
  const store = await createMediaAssetStore({ directory: join(directory, 'assets') });
  const scheduler = createEromeWorkScheduler(), indexes = [await createMediaReuseIndex({ directory: join(directory, 'reuse') })];
  let etag = '"current"', available = true, downloaded = 0, inspected = 0, resolved = 0, headed = 0;
  const create = (reuse = indexes.at(-1)!) => createEromeMediaPreparer({ store, reuse, scheduler,
    signal: controller.signal, baseUrl: 'https://media.example.org',
    resolve: async () => { resolved++; return available ? { album, source, videoCount: 1 } : null; },
    inspectSource: async () => { headed++; return { bytes: bytes.length, etag }; },
    downloadValidated: async () => { downloaded++; return { bytes, etag }; },
    download: async () => assert.fail('unvalidated download'), inspect: async () => { inspected++; return metadata; },
  });
  t.after(async () => {
    controller.abort(); await scheduler.close(); for (const index of indexes) await index.close();
    await store.close(); await rm(directory, { recursive: true, force: true });
  });
  return { store, create, etag(value: string) { etag = value; }, available(value: boolean) { available = value; },
    counters: () => ({ downloaded, inspected, resolved, headed }), async restart() {
      await indexes.at(-1)!.close(); indexes.push(await createMediaReuseIndex({ directory: join(directory, 'reuse') })); return create();
    } };
}

test('persistent reuse avoids download after restart but revalidates current public album and source each time', async t => {
  const f = await fixture(t), first = await f.create()(album); assert.ok(first);
  assert.equal(await f.store.bind(first.id, message(1), first.reservation), true);
  const prepare = await f.restart(), second = await prepare(album); assert.ok(second);
  assert.equal(second.id, first.id); assert.equal(await f.store.bind(second.id, message(2), second.reservation), true);
  assert.deepEqual(f.counters(), { resolved: 2, headed: 2, downloaded: 1, inspected: 1 });
  f.available(false); assert.equal(await prepare(album), null);
  assert.deepEqual(f.counters(), { resolved: 3, headed: 2, downloaded: 1, inspected: 1 });
  f.available(true); f.etag('"changed"'); const changed = await prepare(album); assert.ok(changed);
  assert.notEqual(changed.id, first.id); assert.equal(f.counters().downloaded, 2);
});

test('same-size local corruption and released assets cannot satisfy reuse', async t => {
  const f = await fixture(t), prepare = f.create(), first = await prepare(album); assert.ok(first);
  await f.store.bind(first.id, message(1), first.reservation);
  const stored = await f.store.get(first.id); assert.ok(stored); await writeFile(stored.path, Buffer.alloc(bytes.length));
  const repaired = await prepare(album); assert.ok(repaired); assert.notEqual(repaired.id, first.id);
  assert.equal(f.counters().downloaded, 2); await f.store.bind(repaired.id, message(2), repaired.reservation);
  await f.store.release(message(2)); const rebuilt = await prepare(album); assert.ok(rebuilt);
  assert.notEqual(rebuilt.id, repaired.id); assert.equal(f.counters().downloaded, 3);
});

test('full64-reference assets roll over repeatedly using validated local bytes without another download', async t => {
  const f = await fixture(t), prepare = f.create(); let firstId = '';
  for (let index = 1; index <= 129; index++) {
    const media = await prepare(album); assert.ok(media, `reference ${index}`);
    if (index === 1) firstId = media.id;
    assert.equal(media.id === firstId, index <= 64);
    assert.equal(await f.store.bind(media.id, message(index), media.reservation), true);
    assert.deepEqual(await readFile((await f.store.get(media.id))!.path), bytes);
  }
  assert.equal(f.counters().downloaded, 1); assert.equal(f.counters().inspected, 1);
});

test('slow rollover copies retain scheduler capacity, reject overload and remain tracked through shutdown drain', async () => {
  const stopped = new AbortController();
  let copiedReads = 0, downloads = 0, maxPending = 0, maxActive = 0, release!: () => void;
  const scheduler = createEromeWorkScheduler({ observe(event) {
    maxPending = Math.max(maxPending, event.pending); maxActive = Math.max(maxActive, event.active);
  } });
  const prepare = createEromeMediaPreparer({ scheduler, baseUrl: 'https://media.example.org', signal: stopped.signal,
    resolve: async url => ({ album: url, source, videoCount: 1 }), download: async () => { downloads++; return bytes; },
    inspect: async () => metadata,
    store: { publish: async value => ({ id: 'a'.repeat(32), size: value.length, sha256: 'b'.repeat(64) }),
      reserve: async () => null,
      get: async () => {
        copiedReads++;
        return new Promise<null>(resolve => { release = () => resolve(null); });
      } },
  });
  const first = prepare(album, { context: { fairnessKey: 'first-guild' } });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const waiting = Array.from({ length: 32 }, (_, index) => prepare(album + index,
    { context: { fairnessKey: `guild-${index}` } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(copiedReads, 1, 'rollover holds the only original profile slot');
  assert.equal(downloads, 1, 'new preparation must wait behind the admitted rollover');
  assert.ok(maxPending <= 8); assert.equal(maxActive, 1);
  stopped.abort();
  assert.ok((await Promise.all([first, ...waiting])).every(value => value === null));
  let drained = false;
  const draining = prepare.drain().then(() => { drained = true; });
  const closing = scheduler.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drained, false, 'cancelled callers do not discard an actual pending copy');
  release(); await draining; await closing;
  assert.equal(copiedReads, 1, 'rejected and cancelled queued work never begins later');
});

test('image-only albums prepare one selected item with unchanged bytes and reject a removed selection', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'linky-image-album-')), store = await createMediaAssetStore({ directory });
  const scheduler = createEromeWorkScheduler(), calls: string[] = [], image = Buffer.from('already verified image bytes');
  let sources = ['https://s63.erome.com/ControlledFixture/first.png', 'https://s63.erome.com/ControlledFixture/second.jpg'];
  t.after(async () => { await scheduler.close(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const prepare = createEromeMediaPreparer({ store, scheduler, baseUrl: 'https://media.example.org', signal: new AbortController().signal,
    resolve: async (url, _request, selected) => resolveEromeAlbum(url, async () => new Response(sources.map(source =>
      `<div class="media-group"><img class="img-front" src="${source}"></div>`).join(''), { headers: { 'content-type': 'text/html' } }), selected),
    download: async () => assert.fail('image called video downloader'), inspect: async () => assert.fail('image called video probe'),
    imageDownloader: { inspect: async source => ({ bytes: image.length, etag: '"image"', mimeType: source.endsWith('.png') ? 'image/png' : 'image/jpeg' }),
      download: async source => { calls.push(source); return image; } },
    inspectImage: async value => { assert.equal(value, image); return { width: 640, height: 480 }; },
  });
  const first = await prepare(album); assert.ok(first); assert.equal(first.kind, 'image'); assert.equal(first.itemCount, 2);
  assert.equal(first.videoCount, 0); assert.ok(first.url.endsWith('.png')); assert.equal(calls.length, 1);
  const fingerprint = first.itemFingerprints![1];
  const second = await prepare(album, { selection: { fingerprint } }); assert.ok(second);
  assert.equal(second.itemIndex, 1); assert.ok(second.url.endsWith('.jpg')); assert.equal(calls.length, 2);
  assert.deepEqual(await readFile((await store.get(second.id))!.path), image);
  sources = sources.slice(0, 1); assert.equal(await prepare(album, { selection: { fingerprint } }), null);
  assert.equal(calls.length, 2, 'deleted selection cannot reuse its cached bytes');
});
