import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { createMediaReuseIndex, type MediaReuseIndex } from '../src/services/MediaReuseIndex';

const source = { album: 'https://www.erome.com/a/PrivateAlbum', source: 'https://v63.erome.com/PrivateAlbum/video.mp4',
  etag: '"current"', bytes: 10, mimeType: 'video/mp4' as const };
const value = { id: 'a'.repeat(32), size: 10, sha256: 'b'.repeat(64), mimeType: 'video/mp4' as const,
  metadata: { width: 1280, height: 720, duration: 2, fps: 30 } };
const TTL = 7 * 24 * 60 * 60_000;
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'linky-reuse-test-')), stores: MediaReuseIndex[] = [];
  let now = 1_000_000;
  t.after(async () => { for (const store of stores) await store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, path: join(root, 'index.json'), advance(ms: number) { now += ms; }, async open() {
    const store = await createMediaReuseIndex({ directory: root, clock: () => now }); stores.push(store); return store;
  } };
}

test('private descriptors survive restart and are bound to current source validators without storing URLs', async t => {
  const f = await fixture(t), index = await f.open(); await index.remember(source, value);
  const disk = await readFile(f.path, 'utf8');
  for (const secret of [source.album, source.source, source.etag, 'PrivateAlbum']) assert.equal(disk.includes(secret), false);
  if (process.platform !== 'win32') assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  await index.close(); const reopened = await f.open();
  assert.deepEqual(await reopened.get(source), value);
  for (const changed of [{ ...source, etag: '"changed"' }, { ...source, bytes: 11 }, { ...source, album: source.album + 'x' },
    { ...source, source: source.source.replace('video', 'another') }]) assert.equal(await reopened.get(changed), null);
  await reopened.invalidateAsset(value.id); assert.equal(await reopened.get(source), null);
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')).entries, []);
});

test('seven-day expiry is persisted on restart and misses, with recent hits refreshing idle retention', async t => {
  const f = await fixture(t), index = await f.open(); await index.remember(source, value);
  f.advance(TTL - 1); assert.ok(await index.get(source)); f.advance(TTL - 1); await index.close();
  const reopened = await f.open(); assert.ok(await reopened.get(source)); await reopened.close();
  f.advance(TTL); const expired = await f.open();
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')).entries, []); assert.equal(await expired.get(source), null);
  await expired.remember(source, value); f.advance(TTL);
  assert.equal(await expired.get({ ...source, etag: '"miss"' }), null);
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')).entries, []);
});

test('idle expiry is written by the periodic sweep without a preparation request', async t => {
  let sweep: (() => void) | undefined;
  t.mock.method(globalThis, 'setInterval', (work: () => void) => { sweep = work; return { unref() {} }; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const f = await fixture(t), index = await f.open(); await index.remember(source, value); f.advance(TTL);
  sweep!(); await index.close();
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')).entries, []);
});

test('the index admits at most1024 descriptors and a corrupt index disables reuse safely', async t => {
  const f = await fixture(t), index = await f.open();
  for (let i = 0; i < 1025; i++) await index.remember({ ...source, etag: `"${i}"` }, value);
  assert.equal(await index.get({ ...source, etag: '"0"' }), null);
  assert.ok(await index.get({ ...source, etag: '"1024"' }));
  const disk = await readFile(f.path); assert.ok(disk.length < 2 * 1024 * 1024);
  assert.equal(JSON.parse(disk.toString()).entries.length, 1024);
  await index.close(); await writeFile(f.path, '{broken'); const broken = await f.open();
  assert.equal(await broken.get(source), null); await broken.remember(source, value);
  assert.equal(await readFile(f.path, 'utf8'), '{broken');
});
