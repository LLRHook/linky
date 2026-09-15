import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MAX_REGIONAL_BYTES, MAX_REGIONAL_PART_BYTES, parseRegionalJob, REGIONAL_CLAIM_PATH,
  REGIONAL_PROTOCOL_VERSION, REGIONAL_REGIONS, REGIONAL_ROUTES, REGIONAL_SIGNATURE_HEADER, regionalRange, serializeRegionalJob,
  signRegionalClaim, signRegionalJob, verifyRegionalClaim, verifyRegionalJob, type RegionalJob, type RegionalRange,
} from '../src/services/RegionalProtocol';
import { createRegionalWorker, type RegionalWorkerDependencies } from '../src/services/RegionalWorker';

const key = 'test-key-only-00000000000000000000000000000000';
const now = 1_800_000_000_000;
const endpoint = `https://media.example.com${REGIONAL_CLAIM_PATH}`;
const job: RegionalJob = {
  v: REGIONAL_PROTOCOL_VERSION, id: '0123456789abcdef0123456789abcdef', part: 0,
  source: 'https://v63.erome.com/7242/Album123/video_720p.mp4',
  album: 'https://www.erome.com/a/Album123', etag: '"strong-etag"', bytes: 40,
  issuedAt: now, expiresAt: now + 30_000,
};

function invocation(value = job, body = serializeRegionalJob(value)): Request {
  return new Request(`https://worker.example.com${REGIONAL_ROUTES[0]}`, {
    method: 'POST', body,
    headers: { 'content-type': 'application/json', [REGIONAL_SIGNATURE_HEADER]: signRegionalJob(body, REGIONAL_ROUTES[0], key) },
  });
}

function source(body: ReadableStream<Uint8Array> | Uint8Array = new Uint8Array([1, 2, 3, 4]), overrides: Record<string, string> = {}): Response {
  return new Response(body, { status: 206, headers: {
    'content-type': 'video/mp4', 'content-length': '4', 'content-range': 'bytes 0-3/40', etag: job.etag, ...overrides,
  } });
}

function worker(overrides: RegionalWorkerDependencies = {}): (request: Request) => Promise<Response> {
  return createRegionalWorker(0, {
    key, coordinatorUrl: endpoint, region: 'iad1', now: () => now,
    claimFetch: async () => new Response(null, { status: 204 }), origin: async () => source(),
    ...overrides,
  });
}

test('protocol derives disjoint bounded parts, including empty tail parts', () => {
  assert.equal(REGIONAL_PROTOCOL_VERSION, 3);
  assert.deepEqual(REGIONAL_REGIONS, ['iad1', 'fra1', 'lhr1', 'cle1', 'sfo1', 'cdg1', 'dub1', 'pdx1', 'yul1', 'local']);
  assert.deepEqual(REGIONAL_ROUTES, ['/api/iad', '/api/fra', '/api/lhr', '/api/cle', '/api/sfo', '/api/cdg', '/api/dub', '/api/pdx', '/api/yul']);
  assert.equal(MAX_REGIONAL_BYTES, 24 * 1024 * 1024);
  assert.equal(MAX_REGIONAL_PART_BYTES, 4 * 1024 * 1024);
  assert.equal(regionalRange(MAX_REGIONAL_BYTES, 0)?.length, 2_516_583);
  assert.equal(regionalRange(MAX_REGIONAL_BYTES, 9)?.length, 2_516_577);
  for (const size of [1, 5, 6, 7, 8, 9, 10, 11, 25_026_293, MAX_REGIONAL_BYTES]) {
    const ranges: RegionalRange[] = REGIONAL_REGIONS.map((_, part) => regionalRange(size, part)).filter(value => value !== null);
    assert.equal(ranges[0].start, 0);
    assert.equal(ranges.at(-1)!.end, size - 1);
    assert.equal(ranges.reduce((sum, value) => sum + value.length, 0), size);
    for (let part = 0; part < ranges.length; part++) {
      assert.ok(ranges[part].length <= MAX_REGIONAL_PART_BYTES);
      if (part) assert.equal(ranges[part].start, ranges[part - 1].end + 1);
    }
  }
  assert.equal(regionalRange(MAX_REGIONAL_BYTES + 1, 0), null);
});

test('protocol rejects extras, weak validators, noncanonical URLs/JSON and expired jobs', () => {
  assert.deepEqual(parseRegionalJob(serializeRegionalJob(job), now), job);
  const invalid: unknown[] = [
    { ...job, extra: true }, { ...job, etag: 'W/"weak"' }, { ...job, etag: '"a\r\nb"' },
    { ...job, source: job.source + '?next=private' }, { ...job, source: job.source.replace('v63.', 'v63.erome.com@') },
    { ...job, album: job.album + '/' }, { ...job, source: job.source.replace('https:', 'http:') },
    { ...job, bytes: MAX_REGIONAL_BYTES + 1 }, { ...job, id: 'ABC' }, { ...job, part: 10 }, { ...job, v: 1 }, { ...job, v: 2 },
    { ...job, expiresAt: now }, { ...job, expiresAt: now + 30_001 },
    { ...job, issuedAt: now + 5001, expiresAt: now + 6000 }, { ...job, bytes: 1, part: 1 },
  ];
  for (const value of invalid) assert.equal(parseRegionalJob(JSON.stringify(value), now), null);
  assert.equal(parseRegionalJob(' ' + serializeRegionalJob(job), now), null);
  assert.equal(parseRegionalJob(serializeRegionalJob(job).replace('"v":3', '"v":3,"v":3'), now), null);
});

test('version-one and version-two jobs and MACs are rejected before any claim or source request', async () => {
  let claims = 0, sources = 0;
  const handler = worker({ claimFetch: async () => { claims++; return new Response(null, { status: 204 }); },
    origin: async () => { sources++; return source(); } });
  for (const version of [1, 2]) {
    const legacy = JSON.stringify({ ...job, v: version });
    const oldSignature = (raw: string, purpose: 'job' | 'claim', route: string) => createHmac('sha256', key)
      .update(`linky-regional-${purpose}-v${version}\nPOST\n${route}\n`).update(raw).digest('hex');
    for (const [raw, signature, status] of [
      [legacy, oldSignature(legacy, 'job', REGIONAL_ROUTES[0]), 401],
      [legacy, signRegionalJob(legacy, REGIONAL_ROUTES[0], key), 400],
      [serializeRegionalJob(job), oldSignature(serializeRegionalJob(job), 'job', REGIONAL_ROUTES[0]), 401],
    ] as const) {
      const request = invocation(job, raw);
      request.headers.set(REGIONAL_SIGNATURE_HEADER, signature);
      assert.equal((await handler(request)).status, status);
    }
    assert.equal(verifyRegionalClaim(legacy, oldSignature(legacy, 'claim', REGIONAL_CLAIM_PATH), key), false);
  }
  assert.equal(claims, 0);
  assert.equal(sources, 0);
});

test('MACs bind raw bytes, route and job/claim purpose', () => {
  const raw = serializeRegionalJob(job), signature = signRegionalJob(raw, REGIONAL_ROUTES[0], key);
  assert.equal(verifyRegionalJob(raw, REGIONAL_ROUTES[0], signature, key), true);
  assert.equal(verifyRegionalJob(raw + ' ', REGIONAL_ROUTES[0], signature, key), false);
  assert.equal(verifyRegionalJob(raw, REGIONAL_ROUTES[1], signature, key), false);
  assert.equal(verifyRegionalClaim(raw, signature, key), false);
  assert.equal(verifyRegionalClaim(raw, signRegionalClaim(raw, key), key), true);
  assert.equal(verifyRegionalJob(raw, REGIONAL_ROUTES[0], 'zz', key), false);
});

test('worker claims the exact registered body before fetching, and emits bounded metadata without a known hash', async () => {
  const events: string[] = [];
  const response = await worker({
    claimFetch: async (url, options) => {
      events.push('claim');
      assert.equal(url, endpoint);
      assert.equal(options?.redirect, 'error');
      assert.equal(options?.body, serializeRegionalJob(job));
      assert.equal(verifyRegionalClaim(String(options?.body), new Headers(options?.headers).get(REGIONAL_SIGNATURE_HEADER), key), true);
      return new Response(null, { status: 204 });
    },
    origin: async (url, options) => {
      events.push('origin');
      assert.equal(url, job.source);
      assert.deepEqual(options.range, { start: 0, end: 3, length: 4 });
      assert.equal(options.etag, job.etag);
      return source();
    },
  })(invocation());
  assert.deepEqual(events, ['claim', 'origin']);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-linky-streaming'), 'true');
  assert.equal(response.headers.get('content-length'), '4');
  assert.equal(response.headers.get('x-linky-source-etag'), job.etag);
  assert.equal(response.headers.has('x-linky-sha256'), false);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3, 4]);
});

test('authentication, route/part/region, expiry and configuration failures perform no origin call', async () => {
  let calls = 0;
  const origin = async (): Promise<Response> => { calls++; return source(); };
  const badMac = invocation(); badMac.headers.set(REGIONAL_SIGNATURE_HEADER, '0'.repeat(64));
  assert.equal((await worker({ origin })(badMac)).status, 401);
  assert.equal((await worker({ origin, region: 'fra1' })(invocation())).status, 503);
  assert.equal((await worker({ origin })(invocation({ ...job, part: 1 }))).status, 400);
  assert.equal((await worker({ origin, now: () => now + 30_000 })(invocation())).status, 400);
  assert.equal((await worker({ origin, key: '' })(invocation())).status, 503);
  assert.equal((await worker({ origin, coordinatorUrl: endpoint + '?next=elsewhere' })(invocation())).status, 503);
  const query = new Request(invocation().url + '?x=1', invocation());
  assert.equal((await worker({ origin })(query)).status, 400);
  assert.equal(calls, 0);
});

test('denied admission cannot initiate a source fetch', async () => {
  let calls = 0;
  const response = await worker({
    claimFetch: async () => new Response('sensitive details', { status: 409 }),
    origin: async () => { calls++; return source(); },
  })(invocation());
  assert.equal(response.status, 403);
  assert.equal(await response.text(), '{"error":"claim_denied"}');
  assert.equal(calls, 0);
});

test('first bytes arrive before source EOF and the last byte stays private until EOF', async () => {
  let control!: ReadableStreamDefaultController<Uint8Array>;
  let reads = 0;
  const origin = source(new ReadableStream({ start(c) { control = c; }, pull() { reads++; } }, { highWaterMark: 0 }));
  const response = await worker({ origin: async () => origin })(invocation());
  assert.equal(reads, 0);
  const reader = response.body!.getReader();
  const first = reader.read();
  control.enqueue(new Uint8Array([1, 2, 3, 4]));
  assert.deepEqual([...(await first).value!], [1, 2, 3]);
  let completed = false;
  const last = reader.read().then(value => { completed = true; return value; });
  await delay(5);
  assert.equal(completed, false);
  control.close();
  assert.deepEqual([...(await last).value!], [4]);
  assert.equal((await reader.read()).done, true);
});

test('a single-byte final chunk does not deadlock the EOF check', async () => {
  const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4])];
  const response = await worker({ origin: async () => source(new ReadableStream({
    pull(controller) { const chunk = chunks.shift(); if (chunk) controller.enqueue(chunk); else controller.close(); },
  }, { highWaterMark: 0 })) })(invocation());
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3, 4]);
});

test('wrong ETag/range/length/MIME/encoding/cookies fail before any outgoing media body', async () => {
  const examples: Record<string, string>[] = [
    { etag: '"changed"' }, { 'content-range': 'bytes 0-3/25' }, { 'content-length': '5' },
    { 'content-type': 'text/html' }, { 'content-encoding': 'gzip' }, { 'set-cookie': 'session=private' },
  ];
  for (const headers of examples) {
    let cancelled = false;
    const response = await worker({ origin: async () => source(new ReadableStream({ cancel() { cancelled = true; } }), headers) })(invocation());
    assert.equal(response.status, 502);
    assert.equal(await response.text(), '{"error":"source_headers"}');
    assert.equal(cancelled, true);
  }
});

test('short, excessive and errored origin bodies abort the client stream', async () => {
  for (const kind of ['short', 'excess', 'error']) {
    let pulled = false;
    const response = await worker({ origin: async () => source(new ReadableStream({
      pull(controller) {
        if (pulled) { controller.error(new Error('private upstream error')); return; }
        pulled = true;
        controller.enqueue(new Uint8Array(kind === 'excess' ? [1, 2, 3, 4, 5] : [1, 2]));
        if (kind === 'short') controller.close();
      },
    }, { highWaterMark: 0 })) })(invocation());
    await assert.rejects(response.arrayBuffer(), /source_incomplete/);
  }
});

test('total deadline covers stalled claim and disposes a late response without fetching', async () => {
  let resolve!: (response: Response) => void;
  let cancelled = false;
  let calls = 0;
  const response = await worker({
    deadlineMs: 15, claimFetch: async () => new Promise<Response>(done => { resolve = done; }),
    origin: async () => { calls++; return source(); },
  })(invocation());
  assert.equal(response.status, 504);
  resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await delay(0);
  assert.equal(cancelled, true);
  assert.equal(calls, 0);
});

test('deadline aborts a stalled body even when the consumer is not pulling', async () => {
  let cancelled = false;
  let sourceSignal!: AbortSignal;
  const response = await worker({ deadlineMs: 15, origin: async (_source, options) => {
    sourceSignal = options.signal;
    return source(new ReadableStream({ cancel() { cancelled = true; } }));
  } })(invocation());
  await delay(30);
  await assert.rejects(response.arrayBuffer(), /deadline/);
  assert.equal(cancelled, true);
  assert.equal(sourceSignal.aborted, true);
});

test('client cancellation aborts the same origin signal and cancels its reader', async () => {
  let cancelled = false;
  let sourceSignal!: AbortSignal;
  const response = await worker({ origin: async (_source, options) => {
    sourceSignal = options.signal;
    return source(new ReadableStream({ cancel() { cancelled = true; } }));
  } })(invocation());
  await response.body!.cancel();
  assert.equal(cancelled, true);
  assert.equal(sourceSignal.aborted, true);
});

test('abort between a resolved claim and its continuation prevents any origin request', async () => {
  const caller = new AbortController();
  let calls = 0;
  const response = await worker({ claimFetch: () => {
    queueMicrotask(() => queueMicrotask(() => caller.abort()));
    return Promise.resolve(new Response(null, { status: 204 }));
  }, origin: async () => { calls++; return source(); } })(new Request(invocation(), { signal: caller.signal }));
  assert.equal(calls, 0);
  assert.equal(response.status, 502);
  assert.equal(await response.text(), '{"error":"request_failed"}');
});

test('abort between resolved origin headers and its continuation cancels the unclaimed source body', async () => {
  const caller = new AbortController();
  let cancelled = 0;
  const openSource = source(new ReadableStream({ cancel() { cancelled++; } }));
  const response = await worker({ deadlineMs: 20, origin: () => {
    queueMicrotask(() => queueMicrotask(() => caller.abort()));
    return Promise.resolve(openSource);
  } })(new Request(invocation(), { signal: caller.signal }));
  assert.equal(response.status, 502);
  assert.equal(cancelled, 1);
  assert.equal(await response.text(), '{"error":"request_failed"}');
});

test('oversized and stalled request bodies cannot bypass the global budget', async () => {
  const big = invocation(job, 'x'.repeat(4097));
  assert.equal((await worker()(big)).status, 400);
  let cancelled = false;
  const stalled = new Request(invocation().url, {
    method: 'POST', body: new ReadableStream({ cancel() { cancelled = true; } }), duplex: 'half',
    headers: { 'content-type': 'application/json' },
  });
  assert.equal((await worker({ deadlineMs: 15 })(stalled)).status, 504);
  assert.equal(cancelled, true);
});
