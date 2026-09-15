import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { cancelRegionalResponse, regionalAbortable, requestErome } from './RegionalHttp';
import {
  isCanonicalEromeAlbum, isEromeMediaUrl, isStrongEtag, MAX_REGIONAL_BYTES, MAX_REGIONAL_JOB_BYTES,
  parseRegionalJob, REGIONAL_DEADLINE_MS, REGIONAL_PROTOCOL_VERSION, REGIONAL_REGIONS, REGIONAL_ROUTES, REGIONAL_SIGNATURE_HEADER,
  regionalRange, serializeRegionalJob, signRegionalJob, validRegionalKey, verifyRegionalClaim,
  type RegionalJob, type RegionalRange,
} from './RegionalProtocol';

const HEAD_TIMEOUT_MS = 2_000, DOWNLOAD_TIMEOUT_MS = 10_000, MAX_HEADER_BYTES = 8192;
export type RegionalSourceInspection = Readonly<{ bytes: number; etag: string }>;
export type RegionalInput = { source: string; album: string };
export type RegionalObservation = {
  kind: 'head' | 'part' | 'complete' | 'admission';
  outcome: 'ok' | 'failed' | 'cancelled' | 'rejected';
  elapsedMs: number; bytes: number; status?: number;
  part?: number; region?: typeof REGIONAL_REGIONS[number];
  headersMs?: number; firstByteMs?: number; upstreamHeadersMs?: number;
  reason?: 'busy' | 'cooldown' | 'closed' | 'invalid' | 'metadata' | 'headers' | 'body' | 'transport' | 'deadline' | 'cancelled';
};
export type RegionalObserver = (event: RegionalObservation) => void;
export type RegionalDownloaderOptions = {
  key: string; workerBaseUrl: string; requestOrigin?: typeof requestErome; fetch?: typeof fetch;
  clock?: () => number; monotonic?: () => number; startupGraceMs?: number; observe?: RegionalObserver;
};
export type RegionalDownloader = {
  download(input: RegionalInput, signal?: AbortSignal): Promise<Buffer | null>;
  inspectSource(input: RegionalInput, signal?: AbortSignal, observe?: RegionalObserver): Promise<RegionalSourceInspection | null>;
  downloadValidated(input: RegionalInput, signal?: AbortSignal, inspection?: RegionalSourceInspection,
    observe?: RegionalObserver): Promise<{ bytes: Buffer; etag: string } | null>;
  waitUntilReady(signal?: AbortSignal): Promise<boolean>;
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

async function readPart(response: Response, range: RegionalRange, output: Buffer, signal: AbortSignal,
  receivedBytes: (bytes: number) => void): Promise<void> {
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
      receivedBytes(next.value.length);
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
  clock = Date.now, monotonic = () => performance.now(), startupGraceMs = REGIONAL_DEADLINE_MS,
  observe }: RegionalDownloaderOptions): RegionalDownloader {
  let base: URL;
  try { base = new URL(workerBaseUrl); } catch { throw Error('regional_configuration'); }
  if (!validRegionalKey(key) || base.protocol !== 'https:' || base.username || base.password || base.port ||
    base.pathname !== '/' || base.search || base.hash ||
    !/^https:\/\/[^/?#:@]+\/?$/.test(workerBaseUrl) ||
    !Number.isSafeInteger(startupGraceMs) || startupGraceMs < 0 || startupGraceMs > REGIONAL_DEADLINE_MS)
    throw Error('regional_configuration');
  let closed = false, busy = false, activeController: AbortController | undefined, inspectionController: AbortController | undefined;
  let admitAfter = clock() + startupGraceMs, workerMayRunUntil = 0;
  const active = new Map<string, { raw: string; claimed: boolean }>();
  const inspections = new WeakMap<RegionalSourceInspection, RegionalInput & { expiresAt: number }>();
  const readiness = new Set<() => void>();
  const entryKey = (job: RegionalJob) => `${job.id}:${job.part}`;
  const elapsed = (start: number) => Math.round(Math.max(0, monotonic() - start) * 1000) / 1000;
  const notifyReady = () => { for (const check of [...readiness]) check(); };
  function emit(event: RegionalObservation, callback?: RegionalObserver): void {
    for (const observer of new Set([observe, callback])) {
      try { void Promise.resolve(observer?.(event)).catch(() => undefined); } catch { /* Metrics cannot affect transfers. */ }
    }
  }
  function failure(error: unknown): NonNullable<RegionalObservation['reason']> {
    const name = error instanceof Error ? error.message : '';
    return name === 'regional_metadata' ? 'metadata' : name === 'regional_headers' ? 'headers'
      : name === 'regional_body' ? 'body' : name === 'regional_aborted' ? 'cancelled' : 'transport';
  }
  async function inspect(input: RegionalInput, signal: AbortSignal, callback?: RegionalObserver): Promise<RegionalSourceInspection> {
    const started = monotonic(), deadline = requestDeadline(signal, HEAD_TIMEOUT_MS);
    let response: Response | undefined, size = 0, accepted = false, reason: RegionalObservation['reason'];
    try {
      response = await regionalAbortable<Response>(Promise.resolve().then(() => {
        deadline.signal.throwIfAborted();
        return requestOrigin(input.source, { method: 'HEAD', album: input.album, signal: deadline.signal });
      }), deadline.signal, cancelRegionalResponse);
      deadline.signal.throwIfAborted();
      const length = response.headers.get('content-length'), etag = response.headers.get('etag');
      if (response.status !== 200 || !validHeaders(response, 'video/mp4') || response.headers.has('content-range') ||
        !length || !/^[1-9]\d{0,8}$/.test(length) || Number(length) > MAX_REGIONAL_BYTES || !isStrongEtag(etag))
        throw Error('regional_metadata');
      size = Number(length); accepted = true;
      return Object.freeze({ bytes: size, etag });
    } catch (error) {
      reason = deadline.signal.aborted ? (signal.aborted ? 'cancelled' : 'deadline') : failure(error); throw error;
    } finally {
      if (response) cancelRegionalResponse(response);
      emit({ kind: 'head', outcome: accepted ? 'ok' : reason === 'cancelled' ? 'cancelled' : 'failed',
        elapsedMs: elapsed(started), bytes: size, ...(response ? { status: response.status } : {}), ...(reason ? { reason } : {}) }, callback);
      deadline.close();
    }
  }

  const downloader: RegionalDownloader = {
    waitUntilReady(signal) {
      if (closed || signal?.aborted || readiness.size >= 8) return Promise.resolve(false);
      return new Promise<boolean>(resolve => {
        let timer: ReturnType<typeof setTimeout> | undefined, settled = false;
        const finish = (ready: boolean) => {
          if (settled) return; settled = true;
          clearTimeout(timer); clearTimeout(deadline); readiness.delete(check); signal?.removeEventListener('abort', check); resolve(ready);
        };
        const check = () => {
          if (settled) return;
          clearTimeout(timer);
          if (closed || signal?.aborted) { finish(false); return; }
          if (!busy && !inspectionController) {
            const remaining = admitAfter - clock();
            if (remaining <= 0) { finish(true); return; }
            timer = setTimeout(check, remaining);
          }
        };
        const deadline = setTimeout(() => finish(false), DOWNLOAD_TIMEOUT_MS + REGIONAL_DEADLINE_MS);
        readiness.add(check); signal?.addEventListener('abort', check, { once: true }); check();
      });
    },
    async inspectSource(input, signal, callback) {
      if (closed || busy || inspectionController || signal?.aborted || !isEromeMediaUrl(input.source) || !isCanonicalEromeAlbum(input.album)) return null;
      const controller = new AbortController(), abort = () => controller.abort();
      inspectionController = controller; signal?.addEventListener('abort', abort, { once: true });
      try {
        const result = await inspect(input, controller.signal, callback);
        controller.signal.throwIfAborted();
        inspections.set(result, { ...input, expiresAt: clock() + HEAD_TIMEOUT_MS });
        return result;
      } catch { return null; }
      finally { controller.abort(); signal?.removeEventListener('abort', abort); inspectionController = undefined; notifyReady(); }
    },
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
    close() { closed = true; active.clear(); activeController?.abort(); inspectionController?.abort(); notifyReady(); },
    async download(input, signal) { return (await downloader.downloadValidated(input, signal))?.bytes ?? null; },
    async downloadValidated({ source, album }, signal, inspection, callback) {
      const started = monotonic();
      const rejected = closed ? 'closed' : busy || inspectionController ? 'busy' : signal?.aborted ? 'cancelled'
        : clock() < admitAfter ? 'cooldown' : !isEromeMediaUrl(source) || !isCanonicalEromeAlbum(album) ? 'invalid' : undefined;
      if (rejected) { emit({ kind: 'admission', outcome: 'rejected', reason: rejected, elapsedMs: 0, bytes: 0 }, callback); return null; }
      busy = true;
      const controller = new AbortController();
      activeController = controller;
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      let expired = false;
      const timer = setTimeout(() => { expired = true; abort(); }, DOWNLOAD_TIMEOUT_MS);
      let dispatchedAt: number | undefined, succeeded = false, received = 0, stoppedReason: RegionalObservation['reason'];
      try {
        if (inspection) {
          const proof = inspections.get(inspection); inspections.delete(inspection);
          if (!proof || proof.source !== source || proof.album !== album) throw Error('regional_metadata');
          if (proof.expiresAt <= clock()) inspection = undefined;
        }
        const metadata = inspection ?? await inspect({ source, album }, controller.signal, callback);
        const { bytes, etag } = metadata;
        controller.signal.throwIfAborted();
        const ranges = REGIONAL_REGIONS.map((_, part) => regionalRange(bytes, part));
        if (ranges.some(range => range === null)) return null;
        const output = Buffer.alloc(bytes);
        const id = randomBytes(16).toString('hex'), issuedAt = clock();
        const jobs = REGIONAL_ROUTES.map((_, part): RegionalJob => ({ v: REGIONAL_PROTOCOL_VERSION, id, part, source, album, etag, bytes,
          issuedAt, expiresAt: issuedAt + REGIONAL_DEADLINE_MS }));
        for (const job of jobs) active.set(entryKey(job), { raw: serializeRegionalJob(job), claimed: false });
        dispatchedAt = issuedAt;
        const transfers = ranges.map(async (range, part) => {
          const deadline = requestDeadline(controller.signal, REGIONAL_DEADLINE_MS);
          const partStarted = monotonic();
          let response: Response | undefined, headersMs: number | undefined, firstByteMs: number | undefined;
          let upstreamHeadersMs: number | undefined, partBytes = 0, complete = false, partReason: RegionalObservation['reason'];
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
            headersMs = elapsed(partStarted);
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
              upstreamHeadersMs = Number(milliseconds);
            } else if (response.status !== 206 || headers.get('etag') !== etag ||
              headers.get('content-range') !== `bytes ${range!.start}-${range!.end}/${bytes}`) throw Error('regional_headers');
            await readPart(response, range!, output, deadline.signal, size => {
              firstByteMs ??= elapsed(partStarted); partBytes += size; received += size;
            });
            complete = true;
          } catch (error) {
            partReason = deadline.signal.aborted ? (controller.signal.aborted ? (expired ? 'deadline' : 'cancelled') : 'deadline') : failure(error);
            stoppedReason ??= partReason; controller.abort(); throw error;
          }
          finally {
            if (response) cancelRegionalResponse(response);
            emit({ kind: 'part', part, region: REGIONAL_REGIONS[part], outcome: complete ? 'ok' : partReason === 'cancelled' ? 'cancelled' : 'failed',
              elapsedMs: elapsed(partStarted), bytes: partBytes, ...(response ? { status: response.status } : {}),
              ...(headersMs === undefined ? {} : { headersMs }), ...(firstByteMs === undefined ? {} : { firstByteMs }),
              ...(upstreamHeadersMs === undefined ? {} : { upstreamHeadersMs }), ...(partReason ? { reason: partReason } : {}) }, callback);
            deadline.close();
          }
        });
        const results = await Promise.allSettled(transfers);
        const failed = results.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
        controller.signal.throwIfAborted();
        succeeded = true;
        return { bytes: output, etag };
      } catch (error) {
        stoppedReason ??= expired ? 'deadline' : signal?.aborted || closed ? 'cancelled'
          : failure(error) === 'cancelled' ? 'deadline' : failure(error);
        return null;
      }
      finally {
        // A disconnected worker can finish its bounded request even after this collector has failed.
        if (!succeeded && dispatchedAt !== undefined)
          admitAfter = Math.max(admitAfter, dispatchedAt + REGIONAL_DEADLINE_MS, workerMayRunUntil);
        controller.abort(); clearTimeout(timer); signal?.removeEventListener('abort', abort);
        active.clear(); activeController = undefined; workerMayRunUntil = 0; busy = false;
        emit({ kind: 'complete', outcome: succeeded ? 'ok' : stoppedReason === 'cancelled' ? 'cancelled' : 'failed', elapsedMs: elapsed(started),
          bytes: received, ...(stoppedReason ? { reason: stoppedReason } : {}) }, callback);
        notifyReady();
      }
    },
  };
  return downloader;
}
