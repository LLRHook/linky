import { performance } from 'node:perf_hooks';
import {
  MAX_REGIONAL_JOB_BYTES, parseRegionalJob, REGIONAL_CLAIM_PATH, REGIONAL_DEADLINE_MS,
  REGIONAL_REGIONS, REGIONAL_ROUTES, REGIONAL_SIGNATURE_HEADER, regionalRange,
  signRegionalClaim, validRegionalKey, verifyRegionalJob,
} from './RegionalProtocol';
import {
  cancelRegionalResponse, regionalAbortable, requestErome, validRegionalSourceResponse,
} from './RegionalHttp';

export type RegionalWorkerDependencies = {
  key?: string; coordinatorUrl?: string; region?: string;
  origin?: typeof requestErome; claimFetch?: typeof fetch;
  now?: () => number; monotonicNow?: () => number; deadlineMs?: number;
};

const PRIVATE_HEADERS = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' };

function claimEndpoint(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      !url.search && !url.hash && url.pathname === REGIONAL_CLAIM_PATH && url.href === value
      ? value : null;
  } catch { return null; }
}

function failure(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status, headers: { ...PRIVATE_HEADERS, 'content-type': 'application/json' },
  });
}

async function jobBody(request: Request, signal: AbortSignal): Promise<string> {
  const length = request.headers.get('content-length');
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '') ||
      request.headers.has('content-encoding') || !request.body ||
      (length !== null && (!/^[0-9]{1,5}$/.test(length) || Number(length) > MAX_REGIONAL_JOB_BYTES))) {
    throw new Error('invalid_request');
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await regionalAbortable(reader.read(), signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_REGIONAL_JOB_BYTES) throw new Error('invalid_request');
      chunks.push(next.value);
    }
    if (length !== null && Number(length) !== size) throw new Error('invalid_request');
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

/** Each wrapper supplies its immutable part; all production configuration is server supplied. */
export function createRegionalWorker(part: number, dependencies: RegionalWorkerDependencies = {}): (request: Request) => Promise<Response> {
  if (!Number.isInteger(part) || part < 0 || part >= REGIONAL_ROUTES.length) throw new Error('regional_part');
  return async (request: Request): Promise<Response> => {
    const clock = dependencies.monotonicNow ?? (() => performance.now());
    const started = clock();
    const abort = new AbortController();
    let finished = false;
    let deadline = false;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let sourceReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cleanup = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      request.signal.removeEventListener('abort', callerAbort);
    };
    const stop = (): void => {
      abort.abort();
      if (sourceReader) void sourceReader.cancel().catch(() => undefined);
      if (streamController && !finished) {
        streamController.error(new Error(deadline ? 'deadline' : 'cancelled'));
      }
      cleanup();
    };
    const callerAbort = (): void => stop();
    const timer = setTimeout(() => { deadline = true; stop(); }, dependencies.deadlineMs ?? REGIONAL_DEADLINE_MS);
    request.signal.addEventListener('abort', callerAbort, { once: true });
    if (request.signal.aborted) stop();
    const reject = (status: number, error: string): Response => {
      stop();
      return failure(status, error);
    };
    try {
      const key = dependencies.key ?? process.env.REGIONAL_JOB_KEY;
      const endpoint = claimEndpoint(dependencies.coordinatorUrl ?? process.env.REGIONAL_CLAIM_URL);
      if (!validRegionalKey(key) || !endpoint) return reject(503, 'unavailable');
      const url = new URL(request.url);
      if (request.method !== 'POST' || url.pathname !== REGIONAL_ROUTES[part] || url.search ||
          request.headers.has('range') || request.headers.has('cookie')) return reject(400, 'invalid_request');
      const raw = await jobBody(request, abort.signal);
      if (!verifyRegionalJob(raw, REGIONAL_ROUTES[part], request.headers.get(REGIONAL_SIGNATURE_HEADER), key)) {
        return reject(401, 'unauthorized');
      }
      const job = parseRegionalJob(raw, (dependencies.now ?? Date.now)());
      if (!job || job.part !== part) return reject(400, 'invalid_job');
      if ((dependencies.region ?? process.env.VERCEL_REGION) !== REGIONAL_REGIONS[part]) {
        return reject(503, 'region_mismatch');
      }
      const claim = await regionalAbortable((dependencies.claimFetch ?? fetch)(endpoint, {
        method: 'POST', body: raw, redirect: 'error', signal: abort.signal,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store', [REGIONAL_SIGNATURE_HEADER]: signRegionalClaim(raw, key) },
      }), abort.signal, cancelRegionalResponse);
      cancelRegionalResponse(claim);
      if (finished || abort.signal.aborted) return reject(deadline ? 504 : 502, deadline ? 'deadline' : 'request_failed');
      if (claim.status !== 204 || claim.headers.has('set-cookie')) return reject(403, 'claim_denied');
      const range = regionalRange(job.bytes, part)!;
      const source = await regionalAbortable((dependencies.origin ?? requestErome)(job.source, {
        method: 'GET', album: job.album, range, etag: job.etag, signal: abort.signal,
      }), abort.signal, cancelRegionalResponse);
      if (finished || abort.signal.aborted) {
        cancelRegionalResponse(source);
        return reject(deadline ? 504 : 502, deadline ? 'deadline' : 'request_failed');
      }
      if (!validRegionalSourceResponse(source, job)) {
        cancelRegionalResponse(source);
        return reject(502, 'source_headers');
      }
      sourceReader = source.body!.getReader();
      let received = 0;
      let finalByte: Uint8Array | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { streamController = controller; },
        async pull(controller) {
          try {
            while (!finished) {
              const next = await regionalAbortable(sourceReader!.read(), abort.signal);
              if (finished) return;
              if (next.done) {
                if (received !== range.length || !finalByte) throw new Error('source_incomplete');
                controller.enqueue(finalByte);
                controller.close();
                cleanup();
                return;
              }
              received += next.value.byteLength;
              if (received > range.length) throw new Error('source_overflow');
              if (received === range.length && next.value.byteLength > 0) {
                finalByte = next.value.slice(-1);
                if (next.value.byteLength > 1) {
                  controller.enqueue(next.value.subarray(0, -1));
                  return;
                }
                // The final source chunk can be one byte: check EOF in this same pull.
              } else if (next.value.byteLength > 0) {
                controller.enqueue(next.value);
                return;
              }
            }
          } catch {
            if (!finished) {
              controller.error(new Error(deadline ? 'deadline' : 'source_incomplete'));
              cleanup();
              abort.abort();
              void sourceReader!.cancel().catch(() => undefined);
            }
          }
        },
        cancel() {
          cleanup();
          abort.abort();
          void sourceReader!.cancel().catch(() => undefined);
        },
      }, { highWaterMark: 0 });
      return new Response(stream, {
        headers: {
          ...PRIVATE_HEADERS, 'content-type': 'application/octet-stream', 'content-length': String(range.length),
          'x-linky-id': job.id, 'x-linky-part': String(part), 'x-linky-region': REGIONAL_REGIONS[part],
          'x-linky-range-start': String(range.start), 'x-linky-range-end': String(range.end),
          'x-linky-source-bytes': String(job.bytes), 'x-linky-source-etag': job.etag,
          'x-linky-streaming': 'true', 'x-linky-headers-ms': String(Math.max(0, clock() - started)),
        },
      });
    } catch (error) {
      if (!deadline && error instanceof Error && error.message === 'invalid_request') return reject(400, 'invalid_request');
      return reject(deadline ? 504 : 502, deadline ? 'deadline' : 'request_failed');
    }
  };
}
