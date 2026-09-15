import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMediaAssetStore, MediaAssetStore, MediaAssetStoreOptions } from '../src/services/MediaAssetStore';

const MESSAGE = '12345678901234567';
const SECOND_MESSAGE = '22345678901234567';
const TTL = 15 * 60_000;

test('typed image assets survive restart and legacy MP4 metadata remains readable', async t => {
  const f = await fixture(t), store = await f.open();
  for (const mimeType of ['image/jpeg', 'image/png', 'video/mp4'] as const) {
    const asset = await store.publish(Buffer.from(mimeType), { mimeType }); assert.ok(asset);
    assert.equal(await store.bind(asset.id, MESSAGE), true);
    if (mimeType === 'video/mp4') {
      const metadataPath = join(f.directory, `${asset.id}.json`), record = JSON.parse(await readFile(metadataPath, 'utf8'));
      record.version = 1; delete record.mimeType; await writeFile(metadataPath, JSON.stringify(record));
    }
  }
  assert.equal(await store.publish(Buffer.alloc(8 * 1024 * 1024 + 1), { mimeType: 'image/png' }), null);
  await store.close(); const reopened = await f.open();
  const metadata = (await readdir(f.directory)).filter(file => file.endsWith('.json'));
  for (const name of metadata) {
    const asset = await reopened.get(name.slice(0, -5)); assert.ok(asset);
    const suffix = asset.mimeType === 'image/jpeg' ? '.jpg' : asset.mimeType === 'image/png' ? '.png' : '.mp4';
    assert.ok(asset.path.endsWith(suffix));
  }
  await reopened.release(MESSAGE); assert.deepEqual(await readdir(f.directory), []);
});

test('reservations commit once, enforce the64-reference cap and expire without pinning assets', async t => {
  const f = await fixture(t), store = await f.open(), asset = await store.publish(Buffer.from('media')); assert.ok(asset);
  const tokens = await Promise.all(Array.from({ length: 65 }, () => store.reserve(asset.id)));
  assert.equal(tokens.filter(Boolean).length, 64); assert.equal(await store.bind(asset.id, MESSAGE), false);
  const token = tokens[0]!; assert.equal(await store.bind(asset.id, MESSAGE, token), true);
  assert.equal(await store.bind(asset.id, MESSAGE, token), true, 'uncertain commit can be retried');
  assert.equal(await store.bind(asset.id, SECOND_MESSAGE, token), false, 'token cannot bind a second message');
  for (const pending of tokens.slice(1)) if (pending) store.cancelReservation(pending);
  const expiring = await store.reserve(asset.id); assert.ok(expiring); f.advance(60_000);
  assert.equal(await store.bind(asset.id, SECOND_MESSAGE, expiring), false);
  const revoked = await store.reserve(asset.id); assert.ok(revoked); await store.release(MESSAGE);
  assert.equal(await store.bind(asset.id, SECOND_MESSAGE, revoked), false);
  assert.equal(await store.get(asset.id), null, 'last owner Remove revokes pending reservations');
});

test('rollback unbind only removes the failed appended asset, preserving earlier gallery items', async t => {
  const f = await fixture(t), store = await f.open();
  const first = await store.publish(Buffer.from('first')), second = await store.publish(Buffer.from('second'));
  assert.ok(first && second); await store.bind(first.id, MESSAGE); await store.bind(second.id, MESSAGE);
  await store.unbind(second.id, MESSAGE); assert.ok(await store.get(first.id)); assert.equal(await store.get(second.id), null);
  await store.release(MESSAGE); assert.equal(await store.get(first.id), null);
});

async function fixture(t: TestContext, overrides: Partial<MediaAssetStoreOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'linky-media-store-'));
  const directory = join(root, 'assets');
  const stores: MediaAssetStore[] = [];
  let now = 1_000_000;
  t.after(async () => { for (const store of stores) await store.close(); await rm(root, { recursive: true, force: true }); });
  const openStore = async () => {
    const store = await createMediaAssetStore({ directory, clock: () => now, ...overrides });
    stores.push(store);
    return store;
  };
  return { root, directory, open: openStore, advance: (ms: number) => { now += ms; } };
}

test('publishes complete bytes atomically with private permissions and survives restart', async t => {
  const f = await fixture(t);
  const store = await f.open(), original = Buffer.from('caller-validated complete MP4');
  const pending = store.publish(original);
  original.fill(0);
  const asset = await pending;
  assert.ok(asset);
  assert.match(asset.id, /^[a-f0-9]{32}$/);
  assert.equal(asset.size, 29);
  assert.equal(asset.sha256, createHash('sha256').update('caller-validated complete MP4').digest('hex'));
  const found = await store.get(asset.id);
  assert.ok(found);
  assert.deepEqual(found, { ...asset, path: join(f.directory, `${asset.id}.mp4`) });
  assert.equal(await readFile(found.path, 'utf8'), 'caller-validated complete MP4');
  assert.deepEqual((await readdir(f.directory)).sort(), [`${asset.id}.json`, `${asset.id}.mp4`].sort());
  if (process.platform !== 'win32') {
    assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(found.path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(f.directory, `${asset.id}.json`))).mode & 0o777, 0o600);
  }
  assert.equal(await store.bind(asset.id, MESSAGE), true);
  await store.close();
  f.advance(2 * TTL);
  const restarted = await f.open();
  assert.deepEqual(await restarted.get(asset.id), found);
  await restarted.release(MESSAGE);
  assert.equal(await restarted.get(asset.id), null);
  assert.deepEqual(await readdir(f.directory), []);
});

test('serial admission respects byte and entry quotas without evicting bound assets', async t => {
  const f = await fixture(t, { maxBytes: 8, maxEntries: 2 }), store = await f.open();
  const results = await Promise.all(Array.from({ length: 6 }, () => store.publish(Buffer.alloc(4))));
  const assets = results.filter(asset => asset !== null);
  assert.equal(assets.length, 2);
  assert.equal(results.filter(asset => asset === null).length, 4);
  await Promise.all(assets.map(asset => store.bind(asset.id, MESSAGE)));
  f.advance(2 * TTL);
  assert.equal(await store.publish(Buffer.alloc(1)), null);
  for (const asset of assets) assert.ok(await store.get(asset.id));
  await store.release(MESSAGE);
  assert.ok(await store.publish(Buffer.alloc(8)));
  assert.equal(await store.publish(Buffer.alloc(1)), null);
});

test('entry quota applies even with free bytes and binds retain all references', async t => {
  const f = await fixture(t, { maxBytes: 100, maxEntries: 1 }), store = await f.open();
  const asset = await store.publish(Buffer.from('one'));
  assert.ok(asset);
  assert.equal(await store.bind(asset.id, MESSAGE), true);
  assert.equal(await store.bind(asset.id, MESSAGE), true);
  assert.equal(await store.bind(asset.id, SECOND_MESSAGE), true);
  assert.equal(await store.publish(Buffer.from('two')), null);
  await store.release(MESSAGE);
  assert.ok(await store.get(asset.id));
  await store.close();
  const restarted = await f.open();
  await restarted.release(MESSAGE);
  assert.ok(await restarted.get(asset.id));
  await restarted.release(SECOND_MESSAGE);
  assert.equal(await restarted.get(asset.id), null);
  assert.ok(await restarted.publish(Buffer.from('two')));
});

test('bounds message references and rejects malformed identifiers without changing files', async t => {
  const f = await fixture(t), store = await f.open();
  const asset = await store.publish(Buffer.from('complete'));
  assert.ok(asset);
  for (let index = 0; index < 64; index++)
    assert.equal(await store.bind(asset.id, String(10_000_000_000_000_000n + BigInt(index))), true);
  assert.equal(await store.bind(asset.id, '99999999999999999'), false);
  assert.equal(await store.bind(asset.id, '10000000000000000'), true);
  for (const id of ['../outside', '../../outside', 'a'.repeat(31), 'A'.repeat(32), `${asset.id}.mp4`, '']) {
    assert.equal(await store.get(id), null);
    assert.equal(await store.bind(id, MESSAGE), false);
  }
  for (const message of ['', '1', '01234567890123456', '1'.repeat(21), '../outside']) {
    assert.equal(await store.bind(asset.id, message), false);
    await store.release(message);
  }
  assert.ok(await store.get(asset.id));
  assert.equal((await readdir(f.directory)).length, 2);
});

test('unbound expiry survives restart and expires at fifteen minutes exactly', async t => {
  const f = await fixture(t), store = await f.open();
  const asset = await store.publish(Buffer.from('unbound'));
  assert.ok(asset);
  f.advance(TTL - 1);
  await store.close();
  const restarted = await f.open();
  assert.ok(await restarted.get(asset.id));
  f.advance(1);
  assert.equal(await restarted.bind(asset.id, MESSAGE), false);
  assert.equal(await restarted.get(asset.id), null);
  assert.deepEqual(await readdir(f.directory), []);
});

test('startup reclaims expired publishes and resumes deletion tombstones', async t => {
  const f = await fixture(t), store = await f.open();
  const expired = await store.publish(Buffer.from('expired'));
  const deleted = await store.publish(Buffer.from('deleted'));
  assert.ok(expired && deleted);
  assert.equal(await store.bind(deleted.id, MESSAGE), true);
  await store.close();
  const path = join(f.directory, `${deleted.id}.json`);
  const metadata = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...metadata, messages: [], deleting: true }));
  await unlink(join(f.directory, `${deleted.id}.mp4`));
  f.advance(TTL);
  const restarted = await f.open();
  assert.equal(await restarted.get(expired.id), null);
  assert.equal(await restarted.get(deleted.id), null);
  assert.deepEqual(await readdir(f.directory), []);
});

test('unindexed MP4s count against quotas and only owned temporary names are cleaned', async t => {
  const f = await fixture(t, { maxBytes: 8, maxEntries: 2 });
  await mkdir(f.directory);
  const orphan = join(f.directory, `${'a'.repeat(32)}.mp4`);
  const temporary = join(f.directory, `${'b'.repeat(32)}.tmp`);
  await writeFile(orphan, Buffer.alloc(6));
  await writeFile(temporary, 'crashed write');
  const store = await f.open();
  assert.equal(await store.get('a'.repeat(32)), null);
  assert.equal(await store.publish(Buffer.alloc(3)), null);
  assert.ok(await store.publish(Buffer.alloc(2)));
  assert.equal((await readFile(orphan)).length, 6);
  await assert.rejects(lstat(temporary), { code: 'ENOENT' });
});

test('unknown files and corrupt or excessive metadata fail closed while safe reads remain available', async t => {
  for (const name of ['notes.txt', 'unowned.tmp', `${'b'.repeat(32)}.json`, `${'c'.repeat(32)}.json`]) {
    const f = await fixture(t), store = await f.open();
    const asset = await store.publish(Buffer.from('safe'));
    assert.ok(asset);
    assert.equal(await store.bind(asset.id, MESSAGE), true);
    await store.close();
    const content = name.startsWith('c') ? 'x'.repeat(8193) : '{broken';
    const unknown = join(f.directory, name);
    await writeFile(unknown, content);
    const restarted = await f.open();
    assert.ok(await restarted.get(asset.id));
    assert.equal(await restarted.publish(Buffer.from('new')), null);
    assert.equal(await readFile(unknown, 'utf8'), content);
  }
});

test('rejects truncated media, metadata traversal and linked files without deleting their targets', async t => {
  const f = await fixture(t), store = await f.open();
  const asset = await store.publish(Buffer.from('complete'));
  assert.ok(asset);
  const path = join(f.directory, `${asset.id}.mp4`);
  await writeFile(path, 'short');
  assert.equal(await store.get(asset.id), null);
  assert.equal(await store.bind(asset.id, MESSAGE), false);
  await store.close();
  const metadataPath = join(f.directory, `${asset.id}.json`);
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  await writeFile(metadataPath, JSON.stringify({ ...metadata, id: '../outside' }));
  const restarted = await f.open();
  assert.equal(await restarted.get(asset.id), null);
  assert.equal(await restarted.publish(Buffer.from('new')), null);
  assert.equal(await readFile(path, 'utf8'), 'short');

  const linkedFixture = await fixture(t), linkedStore = await linkedFixture.open();
  const linkedAsset = await linkedStore.publish(Buffer.from('original'));
  assert.ok(linkedAsset);
  const linkedPath = join(linkedFixture.directory, `${linkedAsset.id}.mp4`);
  const outside = join(linkedFixture.root, 'outside.mp4');
  await writeFile(outside, 'original');
  await unlink(linkedPath);
  await link(outside, linkedPath);
  assert.equal(await linkedStore.get(linkedAsset.id), null);
  assert.equal(await linkedStore.bind(linkedAsset.id, MESSAGE), false);
  assert.equal(await linkedStore.publish(Buffer.from('new')), null);
  assert.equal(await readFile(outside, 'utf8'), 'original');
});

test('rejects a symlinked store directory and symlinked media', async t => {
  const f = await fixture(t);
  const outside = join(f.root, 'outside');
  await mkdir(outside);
  await symlink(outside, f.directory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.open(), /Unsafe media store directory/);
  await unlink(f.directory);
  const store = await f.open(), asset = await store.publish(Buffer.from('original'));
  assert.ok(asset);
  const target = join(outside, 'video.mp4'), path = join(f.directory, `${asset.id}.mp4`);
  await writeFile(target, 'original');
  await unlink(path);
  try { await symlink(target, path, 'file'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.diagnostic('File symlinks need Windows permission; directory junction guard passed.'); return; }
    throw error;
  }
  assert.equal(await store.get(asset.id), null);
  assert.equal(await store.bind(asset.id, MESSAGE), false);
  assert.equal(await store.publish(Buffer.from('new')), null);
  assert.equal(await readFile(target, 'utf8'), 'original');
  assert.equal((await lstat(path)).isSymbolicLink(), true);
});

test('release preserves tampered metadata and halts mutation until recovery', async t => {
  const f = await fixture(t), store = await f.open();
  const asset = await store.publish(Buffer.from('complete'));
  assert.ok(asset);
  assert.equal(await store.bind(asset.id, MESSAGE), true);
  assert.equal(await store.bind(asset.id, SECOND_MESSAGE), true);
  const metadata = join(f.directory, `${asset.id}.json`), outside = join(f.root, 'outside.json');
  const original = await readFile(metadata, 'utf8');
  await writeFile(outside, original);
  await unlink(metadata);
  await link(outside, metadata);
  await assert.rejects(store.release(MESSAGE), /Unsafe media asset/);
  assert.equal(await readFile(outside, 'utf8'), original);
  assert.equal((await lstat(metadata)).nlink, 2);
  assert.equal(await store.publish(Buffer.from('new')), null);
  assert.equal(await store.bind(asset.id, MESSAGE), false);
  assert.equal((await readFile(join(f.directory, `${asset.id}.mp4`))).toString(), 'complete');
});

test('rejects empty and oversized assets and makes close idempotent', async t => {
  const f = await fixture(t), store = await f.open();
  assert.equal(await store.publish(Buffer.alloc(0)), null);
  assert.equal(await store.publish(Buffer.alloc(24 * 1024 * 1024 + 1)), null);
  await store.close();
  await store.close();
  assert.equal(await store.publish(Buffer.from('complete')), null);
  assert.equal(await store.bind('a'.repeat(32), MESSAGE), false);
  assert.equal(await store.get('a'.repeat(32)), null);
  await store.release(MESSAGE);
  assert.deepEqual(await readdir(f.directory), []);
});
