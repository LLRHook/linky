import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRegionalDownloader, type RegionalDownloader } from '../src/services/RegionalDownloader';
import { createRegionalWorker } from '../src/services/RegionalWorker';
import { type requestErome } from '../src/services/RegionalHttp';
import {
  MAX_REGIONAL_BYTES, REGIONAL_REGIONS, REGIONAL_ROUTES, REGIONAL_SIGNATURE_HEADER,
  regionalRange, serializeRegionalJob, signRegionalClaim, signRegionalJob, verifyRegionalJob,
  type RegionalJob,
} from '../src/services/RegionalProtocol';

const key = 'regional-test-key-with-at-least-32-characters';
const workerBaseUrl = 'https://workers.example.com';
const input = { source: 'https://v63.erome.com/7242/9f9EJu3q/eMbG5fMA_720p.mp4', album: 'https://www.erome.com/a/9f9EJu3q' };
const etag = '"unchanged-object"';
const bytes = Buffer.from(Array.from({ length: 67 }, (_, i) => i));

function headResponse(length = bytes.length, headers: Record<string, string> = {}, status = 200) {
  return new Response(null, { status, headers: { 'content-type': 'video/mp4', 'content-length': String(length), etag, ...headers } });
}
function workerResponse(job: RegionalJob, source: Buffer = bytes, changes: Record<string, string> = {},
  body?: ConstructorParameters<typeof Response>[0]) {
  const range = regionalRange(job.bytes, job.part)!;
  return new Response(body ?? source.subarray(range.start, range.end + 1), { headers: {
    'content-type': 'application/octet-stream', 'content-length': String(range.length),
    'x-linky-id': job.id, 'x-linky-part': String(job.part), 'x-linky-region': REGIONAL_REGIONS[job.part],
    'x-linky-range-start': String(range.start), 'x-linky-range-end': String(range.end),
    'x-linky-source-bytes': String(job.bytes), 'x-linky-source-etag': job.etag,
    'x-linky-streaming': 'true', 'x-linky-headers-ms': '123.456', ...changes,
  } });
}

function harness(options: {
  source?: Buffer; grace?: number; claim?: boolean;
  head?: () => Response | Promise<Response>;
  worker?: (job: RegionalJob, raw: string) => Response | Promise<Response>;
  local?: (response: Response) => Response | Promise<Response>;
} = {}) {
  let now = 100_000, heads = 0;
  const source = options.source ?? bytes, starts: string[] = [], raws: string[] = [], signals: AbortSignal[] = [];
  let downloader!: RegionalDownloader;
  downloader = createRegionalDownloader({ key, workerBaseUrl, clock: () => now, startupGraceMs: options.grace ?? 0,
    requestOrigin: async (url, request) => {
      assert.equal(url, input.source); assert.equal(request.album, input.album);
      signals.push(request.signal);
      if (request.method === 'HEAD') { heads++; return options.head?.() ?? headResponse(source.length); }
      starts.push('local');
      const range = regionalRange(source.length, REGIONAL_REGIONS.length - 1)!;
      assert.deepEqual(request.range, range); assert.equal(request.etag, etag);
      const response = new Response(source.subarray(range.start, range.end + 1), { status: 206, headers: {
        'content-type': 'video/mp4', 'content-length': String(range.length), etag,
        'content-range': `bytes ${range.start}-${range.end}/${source.length}`,
      } });
      return options.local?.(response) ?? response;
    },
    fetch: async (url, request) => {
      const raw = String(request?.body), job = JSON.parse(raw) as RegionalJob;
      starts.push(REGIONAL_REGIONS[job.part]); raws.push(raw); signals.push(request!.signal!);
      assert.equal(String(url), workerBaseUrl + REGIONAL_ROUTES[job.part]);
      assert.equal(request?.method, 'POST'); assert.equal(request.redirect, 'manual'); assert.equal(request.credentials, 'omit');
      assert.ok(verifyRegionalJob(raw, REGIONAL_ROUTES[job.part], new Headers(request.headers).get(REGIONAL_SIGNATURE_HEADER), key));
      if (options.claim !== false) assert.equal(downloader.claim(raw, signRegionalClaim(raw, key)), true);
      return options.worker?.(job, raw) ?? workerResponse(job, source);
    },
  });
  return { downloader, starts, raws, signals, heads: () => heads, advance: (ms: number) => { now += ms; } };
}

test('all ten requests start together and assemble exact bytes after authenticated one-use claims', async () => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const fixture = harness({ worker: async job => { await ready; return workerResponse(job); },
    local: async response => { release(); return response; } });
  assert.deepEqual(await fixture.downloader.download(input), bytes);
  assert.deepEqual(fixture.starts, [...REGIONAL_REGIONS]);
  assert.equal(fixture.heads(), 1);
  for (const raw of fixture.raws) assert.equal(fixture.downloader.claim(raw, signRegionalClaim(raw, key)), false);
  const firstId = (JSON.parse(fixture.raws[0]) as RegionalJob).id;
  assert.match(firstId, /^[a-f0-9]{32}$/);
  assert.deepEqual(await fixture.downloader.download(input), bytes);
  assert.notEqual((JSON.parse(fixture.raws[REGIONAL_ROUTES.length]) as RegionalJob).id, firstId);
  fixture.downloader.close();
});

test('downloader and actual worker handlers agree on claims, metadata and complete streamed ranges', async () => {
  let downloader!: RegionalDownloader, rangeReads = 0, claims = 0;
  const origin: typeof requestErome = async (_source, options) => {
    if (options.method === 'HEAD') return headResponse();
    rangeReads++;
    const range = options.range!;
    return new Response(bytes.subarray(range.start, range.end + 1), { status: 206, headers: {
      'content-type': 'video/mp4', 'content-length': String(range.length), etag,
      'content-range': `bytes ${range.start}-${range.end}/${bytes.length}`,
    } });
  };
  const workers = REGIONAL_ROUTES.map((_, part) => createRegionalWorker(part, {
    key, coordinatorUrl: 'https://coordinator.example.com/internal/regional/claim', region: REGIONAL_REGIONS[part],
    now: () => 100_000, origin, claimFetch: async (_url, options) => {
      claims++;
      const accepted = downloader.claim(String(options?.body), new Headers(options?.headers).get(REGIONAL_SIGNATURE_HEADER)!);
      return new Response(null, { status: accepted ? 204 : 403 });
    },
  }));
  downloader = createRegionalDownloader({ key, workerBaseUrl, startupGraceMs: 0, clock: () => 100_000,
    requestOrigin: origin, fetch: async (url, options) => {
      const part = REGIONAL_ROUTES.findIndex(route => String(url) === workerBaseUrl + route);
      assert.notEqual(part, -1);
      return workers[part](new Request(url, options));
    },
  });
  assert.deepEqual(await downloader.download(input), bytes);
  assert.equal(rangeReads, 10); assert.equal(claims, 9); downloader.close();
});

test('claims require the exact active body, separate HMAC, unexpired remote part, and synchronous one-use marking', async () => {
  let fixture!: ReturnType<typeof harness>;
  fixture = harness({ claim: false, worker: (job, raw) => {
    if (job.part === 0) {
      const other = harness();
      assert.equal(other.downloader.claim(raw, signRegionalClaim(raw, key)), false); other.downloader.close();
      assert.equal(fixture.downloader.claim(raw, signRegionalJob(raw, REGIONAL_ROUTES[0], key)), false);
      const changed = serializeRegionalJob({ ...job, source: 'https://v63.erome.com/different.mp4' });
      assert.equal(fixture.downloader.claim(changed, signRegionalClaim(changed, key)), false);
      const local = serializeRegionalJob({ ...job, part: REGIONAL_REGIONS.length - 1 });
      assert.equal(fixture.downloader.claim(local, signRegionalClaim(local, key)), false);
      for (const version of [1, 2]) {
        const legacy = JSON.stringify({ ...job, v: version });
        assert.equal(fixture.downloader.claim(legacy, signRegionalClaim(legacy, key)), false);
      }
      fixture.advance(8_000);
      assert.equal(fixture.downloader.claim(raw, signRegionalClaim(raw, key)), false);
      fixture.advance(-8_000);
      // Every remote body is registered before the first POST reaches its transport.
      for (let part = 0; part < REGIONAL_ROUTES.length; part++) {
        const registered = serializeRegionalJob({ ...job, part });
        assert.equal(fixture.downloader.claim(registered, signRegionalClaim(registered, key)), true);
        assert.equal(fixture.downloader.claim(registered, signRegionalClaim(registered, key)), false);
      }
    }
    return workerResponse(job);
  } });
  assert.deepEqual(await fixture.downloader.download(input), bytes);
  fixture.downloader.close();
  assert.equal(fixture.downloader.claim(fixture.raws[0], signRegionalClaim(fixture.raws[0], key)), false);
});

test('startup grace, busy admission, closed state and invalid source destinations fail before extra reads', async () => {
  let now = 0, heads = 0;
  const defaultGrace = createRegionalDownloader({ key, workerBaseUrl, clock: () => now,
    requestOrigin: async () => { heads++; return headResponse(0); }, fetch: async () => { assert.fail('worker called'); } });
  assert.equal(await defaultGrace.download(input), null); now = 7_999;
  assert.equal(await defaultGrace.download(input), null); assert.equal(heads, 0); now = 8_000;
  assert.equal(await defaultGrace.download(input), null); assert.equal(heads, 1); defaultGrace.close();

  let release!: (response: Response) => void;
  const fixture = harness({ head: () => new Promise(resolve => { release = resolve; }) });
  const pending = fixture.downloader.download(input);
  assert.equal(await fixture.downloader.download(input), null);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  release(headResponse()); assert.deepEqual(await pending, bytes);
  assert.equal(await fixture.downloader.download({ ...input, source: 'https://127.0.0.1/secret.mp4' }), null);
  assert.equal(await fixture.downloader.download({ ...input, album: 'https://example.com/a/test' }), null);
  assert.equal(await fixture.downloader.download(input, AbortSignal.abort()), null);
  fixture.downloader.close(); assert.equal(await fixture.downloader.download(input), null);
  assert.equal(fixture.heads(), 1);
  for (const invalid of ['http://workers.example.com', 'https://user:pass@workers.example.com',
    'https://workers.example.com:443', 'https://workers.example.com:8443', 'https://workers.example.com/path',
    'https://workers.example.com?secret=x', 'https://workers.example.com#fragment']) {
    assert.throws(() => createRegionalDownloader({ key, workerBaseUrl: invalid }), /regional_configuration/);
  }
  assert.throws(() => createRegionalDownloader({ key: 'short', workerBaseUrl }), /regional_configuration/);
});

test('HEAD requires bounded identity MP4 bytes and a strong validator; empty parts never dispatch', async () => {
  const invalid = [
    () => headResponse(0), () => headResponse(MAX_REGIONAL_BYTES + 1), () => headResponse(67, {}, 206),
    () => headResponse(67, { etag: 'W/"weak"' }), () => headResponse(67, { etag: '' }),
    () => headResponse(67, { 'content-length': '67, 67' }), () => headResponse(67, { 'content-type': 'text/html' }),
    () => headResponse(67, { 'content-encoding': 'gzip' }), () => headResponse(67, { 'set-cookie': 'x=y' }),
    () => headResponse(67, { 'x-large': 'x'.repeat(8192) }),
    ...[1, 5, 6, 7, 8, 9, 11, 14, 61].map(length => () => headResponse(length)),
  ];
  for (const head of invalid) {
    const fixture = harness({ head });
    assert.equal(await fixture.downloader.download(input), null); assert.equal(fixture.starts.length, 0);
    fixture.downloader.close();
  }
  const minimum = harness({ source: Buffer.from('1234567890') });
  assert.deepEqual(await minimum.downloader.download(input), Buffer.from('1234567890')); minimum.downloader.close();
});

test('unclaimed workers and changed or missing remote identity headers abort every peer', async () => {
  const changes: Record<string, string>[] = [
    { 'x-linky-source-etag': '"changed"' }, { 'x-linky-id': 'f'.repeat(32) }, { 'x-linky-part': '9' },
    { 'x-linky-region': 'wrong' }, { 'x-linky-range-start': '1' }, { 'x-linky-range-end': '99' },
    { 'x-linky-source-bytes': '99' }, { 'x-linky-streaming': 'false' }, { 'x-linky-headers-ms': '' },
    { 'x-linky-headers-ms': '8001' }, { 'content-length': '99' }, { 'content-type': 'text/html' },
    { 'content-encoding': 'gzip' }, { 'x-large': 'x'.repeat(8192) },
  ];
  for (const change of changes) {
    const fixture = harness({ worker: job => workerResponse(job, bytes, change) });
    assert.equal(await fixture.downloader.download(input), null);
    assert.ok(fixture.signals.every(signal => signal.aborted)); fixture.downloader.close();
  }
  const unclaimed = harness({ claim: false });
  assert.equal(await unclaimed.downloader.download(input), null); unclaimed.downloader.close();
});

test('local GET rejects ignored Range, changed ETag, wrong Content-Range and incomplete bytes', async () => {
  for (const scenario of ['ignored', 'etag', 'range', 'incomplete']) {
    const fixture = harness({ local: response => {
      const headers = new Headers(response.headers);
      if (scenario === 'etag') headers.set('etag', '"changed"');
      if (scenario === 'range') headers.set('content-range', 'bytes 0-5/67');
      void response.body?.cancel();
      return new Response(scenario === 'incomplete' ? 'x' : bytes.subarray(regionalRange(bytes.length, REGIONAL_REGIONS.length - 1)!.start), {
        status: scenario === 'ignored' ? 200 : 206, headers,
      });
    } });
    assert.equal(await fixture.downloader.download(input), null); fixture.downloader.close();
  }
});

test('oversized, incomplete and failed remote bodies are cancelled; uncertain failure keeps admission closed for eight seconds', async () => {
  for (const scenario of ['oversized', 'incomplete', 'error-status']) {
    let cancelled = 0;
    const fixture = harness({ worker: job => {
      if (job.part !== 0) return workerResponse(job);
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(Buffer.alloc(scenario === 'oversized' ? 100 : 1));
        if (scenario === 'incomplete') controller.close();
      }, cancel() { cancelled++; } });
      return scenario === 'error-status' ? new Response(body, { status: 500 }) : workerResponse(job, bytes, {}, body);
    } });
    assert.equal(await fixture.downloader.download(input), null);
    assert.equal(await fixture.downloader.download(input), null); assert.equal(fixture.heads(), 1);
    assert.equal(cancelled, scenario === 'incomplete' ? 0 : 1);
    fixture.advance(8_000);
    assert.equal(await fixture.downloader.download(input), null); assert.equal(fixture.heads(), 2);
    fixture.downloader.close();
  }
});

test('caller cancellation returns promptly and disposes every transport response arriving late', async () => {
  const releases: (() => void)[] = [];
  let cancelled = 0;
  const delayed = () => new Promise<Response>(resolve => releases.push(() => resolve(new Response(
    new ReadableStream({ cancel() { cancelled++; } }),
  ))));
  const fixture = harness({ worker: delayed, local: response => { void response.body?.cancel(); return delayed(); } });
  const controller = new AbortController(), pending = fixture.downloader.download(input, controller.signal);
  while (releases.length < REGIONAL_REGIONS.length) await new Promise(resolve => setImmediate(resolve));
  controller.abort(); assert.equal(await pending, null);
  assert.ok(fixture.signals.every(signal => signal.aborted));
  for (const release of releases) release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, 10); fixture.downloader.close();
});

test('failure cooldown covers a late claimed worker, beyond the original dispatch deadline', async () => {
  let first = true, fixture!: ReturnType<typeof harness>;
  fixture = harness({ worker: job => {
    if (first && job.part === 0) {
      first = false; fixture.advance(3_000);
      return workerResponse(job, bytes, { 'x-linky-streaming': 'false' });
    }
    return workerResponse(job);
  } });
  assert.equal(await fixture.downloader.download(input), null);
  fixture.advance(5_000);
  assert.equal(await fixture.downloader.download(input), null); assert.equal(fixture.heads(), 1);
  fixture.advance(3_000);
  assert.deepEqual(await fixture.downloader.download(input), bytes); assert.equal(fixture.heads(), 2);
  fixture.downloader.close();
});

test('HEAD and every dispatched worker have independent bounded deadlines even if transports ignore abort', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const head = harness({ head: () => new Promise<Response>(() => {}) });
  const pendingHead = head.downloader.download(input);
  while (!head.heads()) await new Promise(resolve => setImmediate(resolve));
  context.mock.timers.tick(2_000);
  assert.equal(await pendingHead, null); assert.equal(head.starts.length, 0); head.downloader.close();

  const parts = harness({ worker: () => new Promise<Response>(() => {}),
    local: response => { void response.body?.cancel(); return new Promise<Response>(() => {}); } });
  const pendingParts = parts.downloader.download(input);
  while (parts.starts.length < REGIONAL_REGIONS.length) await new Promise(resolve => setImmediate(resolve));
  context.mock.timers.tick(8_000);
  assert.equal(await pendingParts, null); assert.ok(parts.signals.every(signal => signal.aborted));
  parts.downloader.close();

  let waitingForEof = false, cancelled = 0;
  const noEof = harness({ worker: job => job.part ? workerResponse(job) : workerResponse(job, bytes, {},
    new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.subarray(0, regionalRange(bytes.length, 0)!.length)); },
      pull() { waitingForEof = true; }, cancel() { cancelled++; } })),
  });
  const pendingEof = noEof.downloader.download(input);
  while (!waitingForEof) await new Promise(resolve => setImmediate(resolve));
  context.mock.timers.tick(8_000);
  assert.equal(await pendingEof, null); assert.equal(cancelled, 1); noEof.downloader.close();
});
