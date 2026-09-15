import { randomBytes } from 'node:crypto';
import { cancelRegionalResponse, regionalAbortable, requestErome } from './RegionalHttp';
import {
  isCanonicalEromeAlbum, isEromeMediaUrl, isStrongEtag, MAX_REGIONAL_BYTES, MAX_REGIONAL_JOB_BYTES,
  parseRegionalJob, REGIONAL_DEADLINE_MS, REGIONAL_PROTOCOL_VERSION, REGIONAL_REGIONS, REGIONAL_ROUTES, REGIONAL_SIGNATURE_HEADER,
  regionalRange, serializeRegionalJob, signRegionalJob, validRegionalKey, verifyRegionalClaim,
  type RegionalJob, type RegionalRange,
} from './RegionalProtocol';

const HEAD_TIMEOUT_MS = 2_000, DOWNLOAD_TIMEOUT_MS = 10_000, MAX_HEADER_BYTES = 8192;
export type RegionalDownloaderOptions = {
  key: string; workerBaseUrl: string; requestOrigin?: typeof requestErome; fetch?: typeof fetch;
  clock?: () => number; startupGraceMs?: number;
};
export type RegionalDownloader = {
  download(input: { source: string; album: string }, signal?: AbortSignal): Promise<Buffer | null>;
  claim(raw: string, signature: string): boolean;
  close(): void;
};

function requestDeadline(parent: AbortSignal, milliseconds: number) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent.addEventListener('abort', abort, { once: true });
  if (parent.aborted) abort();
  const timer = setTimeout(abort, milliseconds);
  return { signal: controller.signal, close() {
    clearTimeout(timer); parent.removeEventListener('abort', abort); abort();
  } };
}

function validHeaders(response: Response, mime: string): boolean {
  let bytes = 0;
  for (const [name, value] of response.headers) {
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (bytes > MAX_HEADER_BYTES) return false;
  }
  const encoding = response.headers.get('content-encoding');
  return !response.redirected && !response.headers.has('set-cookie') &&
    (encoding === null || encoding.toLowerCase() === 'identity') &&
    response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === mime;
}

async function readPart(response: Response, range: RegionalRange, output: Buffer, signal: AbortSignal): Promise<void> {
  if (!response.body) throw Error('regional_body');
  const reader = response.body.getReader();
  let received = 0, complete = false;
  try {
    while (true) {
      const next = await regionalAbortable(reader.read(), signal);
      signal.throwIfAborted();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array) || !next.value.length || received + next.value.length > range.length)
        throw Error('regional_body');
      output.set(next.value, range.start + received);
      received += next.value.length;
    }
    if (received !== range.length) throw Error('regional_body');
    complete = true;
  } finally {
    if (!complete) void reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* An aborted injected reader may still have a pending read. */ }
  }
}

/** One admitted source and nine single-use remote claims; no caller can choose a worker destination. */
export function createRegionalDownloader({ key, workerBaseUrl, requestOrigin = requestErome, fetch: fetchWorker = fetch,
  clock = Date.now, startupGraceMs = REGIONAL_DEADLINE_MS }: RegionalDownloaderOptions): RegionalDownloader {
  let base: URL;
  try { base = new URL(workerBaseUrl); } catch { throw Error('regional_configuration'); }
  if (!validRegionalKey(key) || base.protocol !== 'https:' || base.username || base.password || base.port ||
    base.pathname !== '/' || base.search || base.hash ||
    !/^https:\/\/[^/?#:@]+\/?$/.test(workerBaseUrl) ||
    !Number.isSafeInteger(startupGraceMs) || startupGraceMs < 0 || startupGraceMs > REGIONAL_DEADLINE_MS)
    throw Error('regional_configuration');
  let closed = false, busy = false, activeController: AbortController | undefined;
  let admitAfter = clock() + startupGraceMs, workerMayRunUntil = 0;
  const active = new Map<string, { raw: string; claimed: boolean }>();
  const entryKey = (job: RegionalJob) => `${job.id}:${job.part}`;

  return {
    claim(raw, signature) {
      if (closed || activeController?.signal.aborted || typeof raw !== 'string' ||
        Buffer.byteLength(raw) > MAX_REGIONAL_JOB_BYTES || !verifyRegionalClaim(raw, signature, key)) return false;
      const now = clock(), job = parseRegionalJob(raw, now);
      if (!job || job.part >= REGIONAL_ROUTES.length) return false;
      const entry = active.get(entryKey(job));
      if (!entry || entry.claimed || entry.raw !== raw) return false;
      entry.claimed = true;
      workerMayRunUntil = Math.max(workerMayRunUntil, now + REGIONAL_DEADLINE_MS);
      return true;
    },
    close() { closed = true; active.clear(); activeController?.abort(); },
    async download({ source, album }, signal) {
      if (closed || busy || signal?.aborted || clock() < admitAfter ||
        !isEromeMediaUrl(source) || !isCanonicalEromeAlbum(album)) return null;
      busy = true;
      const controller = new AbortController();
      activeController = controller;
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, DOWNLOAD_TIMEOUT_MS);
      let dispatchedAt: number | undefined, succeeded = false;
      try {
        const headDeadline = requestDeadline(controller.signal, HEAD_TIMEOUT_MS);
        let head: Response | undefined, bytes: number, etag: string;
        try {
          head = await regionalAbortable<Response>(Promise.resolve().then(() => requestOrigin(source,
            { method: 'HEAD', album, signal: headDeadline.signal })), headDeadline.signal, cancelRegionalResponse);
          const length = head.headers.get('content-length'), validator = head.headers.get('etag');
          if (head.status !== 200 || !validHeaders(head, 'video/mp4') || head.headers.has('content-range') ||
            !length || !/^[1-9]\d{0,8}$/.test(length) || Number(length) > MAX_REGIONAL_BYTES || !isStrongEtag(validator))
            throw Error('regional_metadata');
          bytes = Number(length); etag = validator;
        } finally {
          if (head) cancelRegionalResponse(head);
          headDeadline.close();
        }
        controller.signal.throwIfAborted();
        const ranges = REGIONAL_REGIONS.map((_, part) => regionalRange(bytes, part));
        if (ranges.some(range => range === null)) return null;
        const output = Buffer.alloc(bytes);
        const id = randomBytes(16).toString('hex'), issuedAt = clock();
        const jobs = REGIONAL_ROUTES.map((_, part): RegionalJob => ({ v: REGIONAL_PROTOCOL_VERSION, id, part, source, album, etag, bytes,
          issuedAt, expiresAt: issuedAt + REGIONAL_DEADLINE_MS }));
        for (const job of jobs) active.set(entryKey(job), { raw: serializeRegionalJob(job), claimed: false });
        dispatchedAt = issuedAt;
        await Promise.all(ranges.map(async (range, part) => {
          const deadline = requestDeadline(controller.signal, REGIONAL_DEADLINE_MS);
          let response: Response | undefined;
          try {
            const job = jobs[part], remote = part < REGIONAL_ROUTES.length;
            response = await regionalAbortable<Response>(Promise.resolve().then(() => {
              deadline.signal.throwIfAborted();
              if (!remote) return requestOrigin(source, { method: 'GET', album, range: range!, etag, signal: deadline.signal });
              const route = REGIONAL_ROUTES[part], raw = active.get(entryKey(job))!.raw;
              return fetchWorker(new URL(route, base), { method: 'POST', redirect: 'manual', credentials: 'omit',
                headers: { 'content-type': 'application/json', 'accept-encoding': 'identity',
                  [REGIONAL_SIGNATURE_HEADER]: signRegionalJob(raw, route, key) }, body: raw, signal: deadline.signal });
            }), deadline.signal, cancelRegionalResponse);
            const headers = response.headers;
            if (!validHeaders(response, remote ? 'application/octet-stream' : 'video/mp4') ||
              headers.get('content-length') !== String(range!.length)) throw Error('regional_headers');
            if (remote) {
              const milliseconds = headers.get('x-linky-headers-ms');
              if (response.status !== 200 || !active.get(entryKey(job))?.claimed ||
                headers.get('x-linky-id') !== id || headers.get('x-linky-part') !== String(part) ||
                headers.get('x-linky-region') !== REGIONAL_REGIONS[part] ||
                headers.get('x-linky-range-start') !== String(range!.start) || headers.get('x-linky-range-end') !== String(range!.end) ||
                headers.get('x-linky-source-bytes') !== String(bytes) || headers.get('x-linky-source-etag') !== etag ||
                headers.get('x-linky-streaming') !== 'true' || !milliseconds ||
                !/^\d+(?:\.\d+)?$/.test(milliseconds) || Number(milliseconds) > REGIONAL_DEADLINE_MS)
                throw Error('regional_headers');
            } else if (response.status !== 206 || headers.get('etag') !== etag ||
              headers.get('content-range') !== `bytes ${range!.start}-${range!.end}/${bytes}`) throw Error('regional_headers');
            await readPart(response, range!, output, deadline.signal);
          } catch (error) { controller.abort(); throw error; }
          finally {
            if (response) cancelRegionalResponse(response);
            deadline.close();
          }
        }));
        controller.signal.throwIfAborted();
        succeeded = true;
        return output;
      } catch { return null; }
      finally {
        // A disconnected worker can finish its bounded request even after this collector has failed.
        if (!succeeded && dispatchedAt !== undefined)
          admitAfter = Math.max(admitAfter, dispatchedAt + REGIONAL_DEADLINE_MS, workerMayRunUntil);
        controller.abort(); clearTimeout(timer); signal?.removeEventListener('abort', abort);
        active.clear(); activeController = undefined; workerMayRunUntil = 0; busy = false;
      }
    },
  };
}
