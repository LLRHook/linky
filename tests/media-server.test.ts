import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, open, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { test } from 'node:test';
import { request } from 'node:http';
import { PassThrough } from 'node:stream';
import { createMediaServer, mediaRange } from '../src/services/MediaServer';
import { REGIONAL_CLAIM_PATH } from '../src/services/RegionalProtocol';

test('typed image media serves only the matching extension with safe content headers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linky-image-http-')), id = 'c'.repeat(32);
  const bytes = Buffer.from('validated PNG fixture'), path = join(directory, 'image.png'); await writeFile(path, bytes);
  const server = createMediaServer({ store: { get: async requested => requested === id ? {
    id, path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mimeType: 'image/png',
  } : null }, claim: () => false });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/media/${id}`;
  try {
    const response = await fetch(base + '.png'); assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.equal((await fetch(base + '.jpg')).status, 404); assert.equal((await fetch(base + '.mp4')).status, 404);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true }); }
});

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

const admissionId = 'a'.repeat(32);
const claimHeaders = { 'x-linky-signature': 'a'.repeat(64), 'Content-Type': 'application/json' };
async function listen(server: ReturnType<typeof createMediaServer>): Promise<string> {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'HTTP requests did not reach the expected state');
    await new Promise(resolve => setImmediate(resolve));
  }
}
function heldClaim(base: string) {
  let completed!: (status: number) => void;
  const result = new Promise<number>(resolve => { completed = resolve; });
  const outgoing = request(base + REGIONAL_CLAIM_PATH, { method: 'POST', agent: false,
    headers: { ...claimHeaders, 'Content-Length': '2' } }, response => {
    response.resume(); response.once('end', () => completed(response.statusCode!));
  });
  outgoing.once('error', () => completed(0));
  outgoing.write('{');
  return { result, complete() { outgoing.end('}'); }, abort() { outgoing.destroy(); } };
}

test('two held playback streams leave admission available for nine concurrent bounded claims', async () => {
  let requests = 0, claims = 0, closedFiles = 0;
  const streams: PassThrough[] = [];
  const server = createMediaServer({
    store: { get: async () => ({ id: admissionId, path: 'private-fixture', size: 1024, sha256: 'b'.repeat(64) }) },
    claim: body => { claims++; return body === '{}'; },
    openFile: async () => ({ stat: async () => ({ isFile: () => true, size: 1024 }),
      createReadStream: () => { const stream = new PassThrough(); streams.push(stream); stream.write('x'); return stream; },
      close: async () => { closedFiles++; },
    }) as unknown as FileHandle,
  });
  server.on('request', incoming => { if (incoming.url === REGIONAL_CLAIM_PATH) requests++; });
  const base = await listen(server), playback: Response[] = [], pending: ReturnType<typeof heldClaim>[] = [];
  try {
    playback.push(...await Promise.all([fetch(`${base}/media/${admissionId}.mp4`), fetch(`${base}/media/${admissionId}.mp4`)]));
    assert.ok(playback.every(response => response.status === 200)); assert.equal(streams.length, 2);
    pending.push(...Array.from({ length: 9 }, () => heldClaim(base)));
    await waitFor(() => requests === 9);
    assert.equal(claims, 0, 'Every claim is held before its bounded body is complete');
    for (const claim of pending) claim.complete();
    assert.deepEqual(await Promise.all(pending.map(claim => claim.result)), Array(9).fill(204));
    assert.equal(claims, 9); assert.equal(closedFiles, 0, 'Playback remains active while all claims finish');
  } finally {
    for (const claim of pending) claim.abort();
    await Promise.all(playback.map(response => response.body?.cancel()));
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    for (const stream of streams) stream.destroy();
  }
  await waitFor(() => closedFiles === 2);
});

test('media rejects its ninth request and claims their eleventh, then both release independently after abort', async () => {
  let claimRequests = 0, mediaReads = 0, holdMedia = true;
  const server = createMediaServer({ store: { get: async () => {
    mediaReads++;
    return holdMedia ? new Promise(() => {}) : { id: admissionId, path: 'unused-head', size: 4, sha256: 'b'.repeat(64) };
  } }, claim: body => body === '{}' });
  server.on('request', incoming => { if (incoming.url === REGIONAL_CLAIM_PATH) claimRequests++; });
  const base = await listen(server), claims = Array.from({ length: 10 }, () => heldClaim(base));
  const controllers = Array.from({ length: 8 }, () => new AbortController());
  const media = controllers.map(controller => fetch(`${base}/media/${admissionId}.mp4`, { method: 'HEAD', signal: controller.signal })
    .then(response => response.status, () => 0));
  try {
    await waitFor(() => claimRequests === 10 && mediaReads === 8);
    const claimOverflow = await fetch(base + REGIONAL_CLAIM_PATH, { method: 'POST', headers: claimHeaders, body: '{}' });
    const mediaOverflow = await fetch(`${base}/media/${admissionId}.mp4`, { method: 'HEAD' });
    assert.equal(claimOverflow.status, 429); assert.equal(claimOverflow.headers.get('retry-after'), '1');
    assert.equal(mediaOverflow.status, 429); assert.equal(mediaReads, 8);
    assert.equal((await fetch(base + '/healthz')).status, 200);
    assert.equal((await fetch(base + '/anything')).status, 429);

    for (const claim of claims) claim.abort();
    await Promise.all(claims.map(claim => claim.result));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await fetch(base + REGIONAL_CLAIM_PATH, { method: 'POST', headers: claimHeaders, body: '{}' })).status, 204);
    assert.equal((await fetch(`${base}/media/${admissionId}.mp4`, { method: 'HEAD' })).status, 429);
    for (const controller of controllers) controller.abort();
    await Promise.all(media); await new Promise(resolve => setImmediate(resolve));
    holdMedia = false;
    assert.equal((await fetch(`${base}/media/${admissionId}.mp4`, { method: 'HEAD' })).status, 200);
    assert.equal((await fetch(base + '/anything')).status, 404);
  } finally {
    for (const claim of claims) claim.abort();
    for (const controller of controllers) controller.abort();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('timed-out incomplete claim bodies release all ten claim slots without invoking admission', async () => {
  let admitted = 0;
  const server = createMediaServer({ timeoutMs: 200, store: { get: async () => null },
    claim: body => { admitted++; return body === '{}'; } });
  const base = await listen(server), pending = Array.from({ length: 10 }, () => heldClaim(base));
  try {
    assert.deepEqual(await Promise.all(pending.map(claim => claim.result)), Array(10).fill(0));
    assert.equal(admitted, 0);
    const completed = await Promise.all(Array.from({ length: 10 }, async () =>
      (await fetch(base + REGIONAL_CLAIM_PATH, { method: 'POST', headers: claimHeaders, body: '{}' })).status));
    assert.deepEqual(completed, Array(10).fill(204)); assert.equal(admitted, 10);
    assert.equal((await fetch(base + '/anything')).status, 404);
  } finally {
    for (const claim of pending) claim.abort();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
