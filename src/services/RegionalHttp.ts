import { resolve4 } from 'node:dns/promises';
import { request, type RequestOptions } from 'node:https';
import { isIPv4 } from 'node:net';
import { Readable } from 'node:stream';
import {
  isCanonicalEromeAlbum, isEromeMediaUrl, isStrongEtag, MAX_REGIONAL_BYTES,
  MAX_REGIONAL_PART_BYTES, regionalRange, type RegionalJob, type RegionalRange,
} from './RegionalProtocol';

export type RegionalOriginOptions = {
  method: 'HEAD' | 'GET'; album: string; range?: RegionalRange; etag?: string; signal: AbortSignal;
};
export type RegionalHttpDependencies = {
  resolve4?: (hostname: string) => Promise<string[]>;
  connect?: (options: RequestOptions, signal: AbortSignal) => Promise<Response>;
  request?: typeof request;
};

export function isPublicIpv4(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && ((b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99) || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}

/** Bound non-abortable DNS and injected transports; dispose responses that arrive after cancellation. */
export function regionalAbortable<T>(promise: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      reject(new Error('regional_aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    promise.then(value => {
      if (settled) { late?.(value); return; }
      settled = true;
      signal.removeEventListener('abort', abort);
      resolve(value);
    }, () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      reject(new Error('regional_transport'));
    });
  });
}

export function cancelRegionalResponse(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

export function validRegionalSourceResponse(response: Response, job: RegionalJob): boolean {
  const range = regionalRange(job.bytes, job.part);
  const encoding = response.headers.get('content-encoding');
  return range !== null && response.status === 206 && response.body !== null &&
    response.headers.get('content-range') === `bytes ${range.start}-${range.end}/${job.bytes}` &&
    response.headers.get('content-length') === String(range.length) &&
    response.headers.get('etag') === job.etag &&
    /^video\/mp4(?:\s*;[^\r\n]*)?$/i.test(response.headers.get('content-type') ?? '') &&
    !response.headers.has('set-cookie') && (encoding === null || encoding.toLowerCase() === 'identity');
}

function connectHttps(options: RequestOptions, signal: AbortSignal, send = request): Promise<Response> {
  return new Promise((resolve, reject) => {
    const outgoing = send({ ...options, signal }, incoming => {
      incoming.once('error', () => reject(new Error('regional_transport')));
      try {
        if (!incoming.statusCode || incoming.statusCode < 200 || incoming.statusCode > 599) throw new Error('regional_status');
        const headers = new Headers();
        for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
          headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
        }
        if (options.method === 'HEAD' || [204, 205, 304].includes(incoming.statusCode)) {
          incoming.resume();
          resolve(new Response(null, { status: incoming.statusCode, headers }));
          return;
        }
        const readable = Readable.toWeb(incoming, { strategy: { highWaterMark: 1 } });
        resolve(new Response(readable as ReadableStream<Uint8Array>, { status: incoming.statusCode, headers }));
      } catch {
        incoming.destroy();
        outgoing.destroy();
        reject(new Error('regional_transport'));
      }
    });
    outgoing.once('error', () => reject(new Error('regional_transport')));
    outgoing.end();
  });
}

/** Only canonical Erome MP4s, identity bytes, no redirects and no connection to DNS supplied private addresses. */
export async function requestErome(
  source: string, options: RegionalOriginOptions, dependencies: RegionalHttpDependencies = {},
): Promise<Response> {
  const { method, album, range, etag, signal } = options;
  if (!isEromeMediaUrl(source) || !isCanonicalEromeAlbum(album) || !['HEAD', 'GET'].includes(method) ||
      (method === 'HEAD' && (range !== undefined || etag !== undefined)) ||
      (method === 'GET' && (!range || !isStrongEtag(etag) ||
        !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 ||
        range.end < range.start || range.end >= MAX_REGIONAL_BYTES ||
        range.length !== range.end - range.start + 1 || range.length > MAX_REGIONAL_PART_BYTES))) {
    throw new Error('regional_source');
  }
  if (signal.aborted) throw new Error('regional_aborted');
  const url = new URL(source);
  const addresses = await regionalAbortable((dependencies.resolve4 ?? resolve4)(url.hostname), signal);
  if (addresses.length === 0 || addresses.length > 32 || !addresses.every(isPublicIpv4)) {
    throw new Error('regional_dns');
  }
  const address = addresses[0];
  const headers: Record<string, string> = {
    accept: 'video/mp4', 'accept-encoding': 'identity', referer: album,
    'user-agent': 'Mozilla/5.0 (compatible; Linky/1.0)',
  };
  if (range) {
    headers.range = `bytes=${range.start}-${range.end}`;
    headers['if-match'] = etag!;
  }
  const connect = dependencies.connect ?? ((settings: RequestOptions, abort: AbortSignal) => connectHttps(settings, abort, dependencies.request));
  const response = await regionalAbortable(connect({
    protocol: 'https:', hostname: url.hostname, servername: url.hostname, port: 443,
    path: url.pathname, method, headers, agent: false, family: 4, rejectUnauthorized: true,
    maxHeaderSize: 8192,
    lookup: (_hostname, lookupOptions, callback) => {
      if (lookupOptions.all) callback(null, [{ address, family: 4 }]);
      else callback(null, address, 4);
    },
  }, signal), signal, cancelRegionalResponse);
  const encoding = response.headers.get('content-encoding');
  if (response.status >= 300 && response.status <= 399 || response.headers.has('set-cookie') ||
      (encoding !== null && encoding.toLowerCase() !== 'identity')) {
    cancelRegionalResponse(response);
    throw new Error('regional_source_headers');
  }
  return response;
}
