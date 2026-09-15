import { createServer, type IncomingMessage } from 'node:http';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { MediaAssetStore } from './MediaAssetStore';
import { REGIONAL_CLAIM_PATH } from './RegionalProtocol';

const MAX_ACTIVE = 8, TIMEOUT_MS = 20_000, MAX_BODY = 4096;
const baseHeaders = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff' };

function bounded<T>(operation: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      reject(Error('Media request cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
    operation.then(value => {
      if (settled) { late?.(value); return; }
      settled = true;
      signal.removeEventListener('abort', abort);
      resolve(value);
    }, error => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      reject(error);
    });
    if (signal.aborted) abort();
  });
}

export function mediaRange(value: string, size: number): { start: number; end: number } | null {
  const match = value.length <= 100 && /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || !match[1] && !match[2]) return null;
  const start = match[1] ? Number(match[1]) : null, end = match[2] ? Number(match[2]) : null;
  if (start !== null && !Number.isSafeInteger(start) || end !== null && !Number.isSafeInteger(end)) return null;
  if (start === null) return end && end > 0 ? { start: Math.max(0, size - end), end: size - 1 } : null;
  return start >= size || end !== null && end < start ? null : { start, end: Math.min(end ?? size - 1, size - 1) };
}

async function claimBody(request: IncomingMessage, signal: AbortSignal): Promise<string> {
  const length = request.headers['content-length'];
  if (!length || !/^\d+$/.test(length) || Number(length) > MAX_BODY || request.headers['transfer-encoding'])
    throw Error('Invalid claim body');
  const chunks: Buffer[] = [];
  let size = 0;
  const cancel = () => request.destroy();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY || size > Number(length)) throw Error('Invalid claim body');
      chunks.push(chunk);
    }
    if (size !== Number(length)) throw Error('Incomplete claim body');
    return Buffer.concat(chunks, size).toString('utf8');
  } finally { signal.removeEventListener('abort', cancel); }
}

/** Public requests can read registered files only. They never start an origin download. */
export function createMediaServer({ store, claim, timeoutMs = TIMEOUT_MS, openFile = open }: {
  store: Pick<MediaAssetStore, 'get'>;
  claim: (body: string, signature: string) => boolean;
  timeoutMs?: number;
  openFile?: typeof open;
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMEOUT_MS) throw Error('Invalid media deadline');
  let active = 0;
  const server = createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const finish = (status: number, headers = {}) => {
      response.writeHead(status, { ...baseHeaders, 'Content-Length': '0', ...headers }); response.end();
    };
    let counted = false, file: Awaited<ReturnType<typeof open>> | undefined;
    response.once('close', () => { if (!response.writableFinished) controller.abort(); });
    try {
      if (request.url === '/healthz') {
        const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '');
        return finish(local && !request.headers.forwarded && !request.headers['x-forwarded-for'] ? 200 : 404);
      }
      if (active >= MAX_ACTIVE) return finish(429, { 'Retry-After': '1' });
      active++; counted = true;
      if (request.url === REGIONAL_CLAIM_PATH) {
        if (request.method !== 'POST') return finish(405, { Allow: 'POST' });
        const signature = request.headers['x-linky-signature'];
        if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) return finish(403);
        const body = await claimBody(request, AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]));
        return finish(claim(body, signature) ? 204 : 403);
      }
      const id = /^\/media\/([a-f0-9]{32})\.mp4$/.exec(request.url ?? '')?.[1];
      if (!id) return finish(404);
      if (request.method !== 'GET' && request.method !== 'HEAD') return finish(405, { Allow: 'GET, HEAD' });
      if (request.headers['transfer-encoding'] || request.headers['content-length'] && request.headers['content-length'] !== '0')
        return finish(413, { Connection: 'close' });
      const asset = await bounded(store.get(id), controller.signal);
      controller.signal.throwIfAborted();
      if (!asset) return finish(404);
      const etag = `"${asset.sha256}"`;
      const range = request.headers.range && (!request.headers['if-range'] || request.headers['if-range'] === etag)
        ? mediaRange(request.headers.range, asset.size) : undefined;
      if (range === null) return finish(416, { 'Content-Range': `bytes */${asset.size}` });
      const start = range?.start ?? 0, end = range?.end ?? asset.size - 1;
      const headers = { ...baseHeaders, 'Content-Type': 'video/mp4', 'Content-Length': String(end - start + 1),
        'Content-Disposition': 'inline', 'Accept-Ranges': 'bytes', ETag: etag,
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${asset.size}` } : {}) };
      if (request.method === 'HEAD') return finish(range ? 206 : 200, headers);
      file = await bounded(openFile(asset.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)), controller.signal,
        handle => { void handle.close().catch(() => {}); });
      controller.signal.throwIfAborted();
      const info = await bounded(file.stat(), controller.signal);
      if (!info.isFile() || info.size !== asset.size) return finish(404);
      controller.signal.throwIfAborted();
      response.writeHead(range ? 206 : 200, headers);
      await pipeline(file.createReadStream({ start, end, autoClose: false, highWaterMark: 64 * 1024 }), response,
        { signal: controller.signal });
    } catch {
      if (!response.headersSent && !response.destroyed) finish(503);
      else response.destroy();
    } finally {
      if (file) await bounded(file.close(), controller.signal).catch(() => {});
      clearTimeout(timer);
      if (counted) active--;
    }
  });
  server.requestTimeout = timeoutMs;
  server.headersTimeout = Math.min(5000, timeoutMs);
  server.keepAliveTimeout = 1000;
  server.maxHeadersCount = 24;
  server.maxConnections = 64;
  return server;
}
