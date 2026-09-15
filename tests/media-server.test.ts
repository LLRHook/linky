import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, open, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { test } from 'node:test';
import { createMediaServer, mediaRange } from '../src/services/MediaServer';
import { REGIONAL_CLAIM_PATH } from '../src/services/RegionalProtocol';

test('media ranges support seeks without accepting multiple, empty or overflowing ranges', () => {
  assert.deepEqual(mediaRange('bytes=2-4', 10), { start: 2, end: 4 });
  assert.deepEqual(mediaRange('bytes=7-', 10), { start: 7, end: 9 });
  assert.deepEqual(mediaRange('bytes=-4', 10), { start: 6, end: 9 });
  assert.deepEqual(mediaRange('bytes=0-99', 10), { start: 0, end: 9 });
  for (const value of ['bytes=-', 'bytes=-0', 'bytes=4-2', 'bytes=10-', 'bytes=0-1,3-4',
    'bytes=9007199254740992-', 'bytes=0-9007199254740992']) assert.equal(mediaRange(value, 10), null);
});

test('HTTP serves complete registered bytes, HEAD and seeks, and never fetches unknown media', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linky-media-http-'));
  const id = 'a'.repeat(32), bytes = Buffer.from('a complete original video fixture');
  const path = join(directory, 'video.mp4'), sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path, bytes);
  let claims = 0;
  const server = createMediaServer({ store: { get: async requested => requested === id
    ? { id, path, size: bytes.length, sha256 } : null }, claim: () => { claims++; return false; } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`, url = `${base}/media/${id}.mp4`;
  try {
    const head = await fetch(url, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(bytes.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal(head.headers.get('x-robots-tag'), 'noindex, nofollow');
    const full = await fetch(url);
    assert.equal(full.status, 200); assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
    const part = await fetch(url, { headers: { Range: 'bytes=2-7', 'If-Range': `"${sha256}"` } });
    assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), `bytes 2-7/${bytes.length}`);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(2, 8));
    const stale = await fetch(url, { headers: { Range: 'bytes=2-7', 'If-Range': '"old"' } });
    assert.equal(stale.status, 200); assert.deepEqual(Buffer.from(await stale.arrayBuffer()), bytes);
    assert.equal((await fetch(url, { headers: { Range: 'bytes=999-' } })).status, 416);
    for (const suffix of ['/media/' + 'b'.repeat(32) + '.mp4', '/media/' + id + '.mp4?source=https://example.org',
      '/media/%2e%2e/secret', '/anything']) assert.equal((await fetch(base + suffix)).status, 404);
    assert.equal((await fetch(url, { method: 'POST' })).status, 405);
    assert.equal((await fetch(base + '/healthz', { headers: { 'x-forwarded-for': '127.0.0.1' } })).status, 404);
    assert.equal(claims, 0);
    await writeFile(path, 'changed size');
    assert.equal((await fetch(url)).status, 404);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(dirname(directory), tmpdir()); await rm(directory, { recursive: true });
  }
});

test('claim endpoint passes only bounded signed bodies to the coordinator and has no media side effects', async () => {
  const observed: string[] = [];
  const server = createMediaServer({ store: { get: async () => { assert.fail('claim must not read media'); } },
    claim: body => { observed.push(body); return body === '{"registered":true}'; } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}${REGIONAL_CLAIM_PATH}`;
  const headers = { 'x-linky-signature': 'a'.repeat(64), 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(url)).status, 405);
    assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await fetch(url, { method: 'POST', body: 'x'.repeat(4097), headers })).status, 503);
    assert.equal((await fetch(url, { method: 'POST', body: '{}', headers })).status, 403);
    assert.equal((await fetch(url, { method: 'POST', body: '{"registered":true}', headers })).status, 204);
    assert.deepEqual(observed, ['{}', '{"registered":true}']);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('stalled store lookups expire and release every active request slot', async () => {
  const server = createMediaServer({ store: { get: () => new Promise(() => {}) }, claim: () => false, timeoutMs: 30 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const statuses = await Promise.all(Array.from({ length: 8 }, async () =>
      (await fetch(`${base}/media/${'a'.repeat(32)}.mp4`, { signal: AbortSignal.timeout(2000) })).status));
    assert.deepEqual(statuses, Array(8).fill(503));
    assert.equal((await fetch(base + '/anything')).status, 404);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('a file handle returned after the request deadline is closed without serving bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linky-media-late-file-'));
  const path = join(directory, 'video.mp4'), id = 'a'.repeat(32), bytes = Buffer.from('complete video');
  await writeFile(path, bytes);
  const handle = await open(path, 'r');
  let release!: (file: FileHandle) => void, began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const server = createMediaServer({ timeoutMs: 30,
    store: { get: async () => ({ id, path, size: bytes.length, sha256: 'b'.repeat(64) }) }, claim: () => false,
    openFile: () => { began(); return new Promise<FileHandle>(resolve => { release = resolve; }); },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  try {
    const pending = fetch(`http://127.0.0.1:${address.port}/media/${id}.mp4`, { signal: AbortSignal.timeout(2000) });
    await started;
    const response = await pending;
    assert.equal(response.status, 503);
    assert.equal((await response.arrayBuffer()).byteLength, 0);
    const close = handle.close.bind(handle);
    const closed = new Promise<void>(resolve => {
      handle.close = async () => { await close(); resolve(); };
    });
    release(handle);
    await closed;
    assert.equal(handle.fd, -1);
  } finally {
    await handle.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(dirname(directory), tmpdir()); await rm(directory, { recursive: true });
  }
});
