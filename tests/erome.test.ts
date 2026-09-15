import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createEromePreparer, parseEromeUrl } from '../src/services/Erome';
import { MAX_ATTACHMENT_BYTES, MAX_VIDEO_BYTES } from '../src/services/VideoAttachment';

const source = 'https://www.erome.com/a/Test_123';
const video = 'https://v54.erome.com/1/Test_123/video.mp4';
const page = (html = `<video><source src="${video}" type="video/mp4"></video>`) =>
  new Response(html, { headers: { 'content-type': 'text/html; charset=UTF-8' } });
const media = () => new Response('synthetic video input', { headers: { 'content-type': 'video/mp4' } });

/** Exercise the fetch signal with a progressing stream, advancing only synthetic time. */
function progressingDownload(t: TestContext, chunks: number) {
  const originalTimeout = AbortSignal.timeout;
  const deadlines: { at: number; controller: AbortController }[] = [];
  const state = { elapsed: 0, abortedAt: 0, completed: false, listeners: 0 };
  let dispose = () => {};
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    const controller = new AbortController();
    deadlines.push({ at: state.elapsed + milliseconds, controller });
    return controller.signal;
  });
  let requests = 0;
  const request: typeof fetch = async (_url, options) => {
    if (++requests === 1) return page();
    const signal = options?.signal;
    assert.ok(signal, 'The video request must supply its own deadline signal');
    let sent = 0;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const abort = () => {
          state.abortedAt = state.elapsed;
          dispose();
          controller.error(signal.reason);
        };
        dispose = () => { signal.removeEventListener('abort', abort); state.listeners = 0; };
        signal.addEventListener('abort', abort, { once: true });
        state.listeners = 1;
      },
      pull(controller) {
        if (sent === chunks) {
          state.completed = true;
          dispose();
          controller.close();
          return;
        }
        const nextChunk = state.elapsed + 20_000;
        for (const deadline of [...deadlines].sort((a, b) => a.at - b.at)) {
          if (deadline.at <= nextChunk && !deadline.controller.signal.aborted) {
            state.elapsed = deadline.at;
            deadline.controller.abort(new DOMException('Synthetic download deadline', 'TimeoutError'));
            if (signal.aborted) return;
          }
        }
        state.elapsed = nextChunk;
        if (!signal.aborted) controller.enqueue(Uint8Array.of(++sent));
      },
      cancel() { dispose(); },
    }), { headers: { 'content-type': 'video/mp4', 'content-length': String(chunks) } });
  };
  return { request, state, restore() {
    dispose();
    deadlines.length = 0;
    t.mock.restoreAll();
    assert.equal(AbortSignal.timeout, originalTimeout);
  } };
}

test('Erome accepts complete public album links and canonicalizes only the host and tracking suffix', () => {
  for (const raw of [source, `${source}/?tracking=1#video`, 'https://EROME.com/a/Test_123']) {
    assert.deepEqual(parseEromeUrl(raw), { id: 'Test_123', url: source });
  }
  for (const raw of ['http://erome.com/a/Test', 'https://erome.com/profile', 'https://erome.com/a/',
    'https://erome.com/a/' + 'a'.repeat(65), 'https://erome.com:443/a/Test', 'https://user@erome.com/a/Test',
    'https://erome.com.evil.test/a/Test', 'https://evil.test/?url=' + source, 'https://erome.com/a/Test%2fother',
    'https://erome.com/a/Test/../other', 'https://erome.com/a/Test\\other', `${source}\n`, 'https://erome.com/a/Test/other',
    'https://erome.com/A/Test']) {
    assert.equal(parseEromeUrl(raw), null, raw);
  }
});

test('Erome fetches one fixed album and first distinct video, retains album count, and supplies no cookies', async () => {
  const calls: { url: string; options?: RequestInit }[] = [];
  const convertInputs: Buffer[] = [];
  const prepare = createEromePreparer({ fetch: async (url, options) => {
    calls.push({ url: String(url), options });
    return calls.length === 1 ? page(`<video><source src="${video}"><source src='${video}'></video>` +
      '<video><source src="https://v55.erome.com/2/Test_123/another.mp4"></video>') : media();
  }, convert: async bytes => { convertInputs.push(bytes); return Buffer.from('synthetic output'); } });
  const result = await prepare(`${source}?tracking=1`);
  assert.equal(result?.videoCount, 2);
  assert.equal(result?.file.name, 'linky-video.mp4');
  assert.equal((result?.file.attachment as Buffer).toString(), 'synthetic output');
  assert.deepEqual(calls.map(call => call.url), [source, video]);
  for (const call of calls) {
    assert.equal(call.options?.redirect, 'error');
    assert.ok(call.options?.signal instanceof AbortSignal);
    assert.equal(new Headers(call.options?.headers).has('cookie'), false);
  }
  assert.equal(new Headers(calls[1].options?.headers).get('referer'), source);
  assert.equal(convertInputs[0].toString(), 'synthetic video input');
});

test('Erome rejects untrusted CDN sources without making a media request', async () => {
  for (const candidate of ['http://v54.erome.com/video.mp4', 'https://v54.erome.com:443/video.mp4',
    'https://user@v54.erome.com/video.mp4', 'https://v54.erome.com.evil.test/video.mp4',
    'https://s54.erome.com/video.mp4', 'https://v54.erome.com/video.m3u8',
    'https://v54.erome.com/../video.mp4', 'https://v54.erome.com/%2e%2e/video.mp4',
    'https://v54.erome.com/video.mp4?redirect=https://evil.test', '//v54.erome.com/video.mp4']) {
    let calls = 0;
    const result = await createEromePreparer({ fetch: async () => { calls++; return page(`<video><source src="${candidate}"></video>`); },
      convert: async () => { assert.fail('untrusted source converted'); } })(source);
    assert.equal(result, null, candidate);
    assert.equal(calls, 1);
  }
  for (const html of [`<video><source data-src="${video}"></video>`, `<!-- <video><source src="${video}"></video> -->`,
    `<script>const tag = '<video><source src="${video}"></video>';</script>`, `<source src="${video}">`]) {
    assert.equal(await createEromePreparer({ fetch: async () => page(html),
      convert: async () => { assert.fail('non-source attribute converted'); } })(source), null);
  }
});

test('Erome counts alternate quality sources as one video and ignores duplicate video elements', async () => {
  let calls = 0;
  const first = `<video><source src="${video}"><source src="https://v54.erome.com/1/Test_123/lower.mp4"></video>`;
  const result = await createEromePreparer({ fetch: async () => ++calls === 1 ? page(first + first) : media(),
    convert: async () => Buffer.from('ok') })(source);
  assert.equal(result?.videoCount, 1);
});

test('Erome fails open on protected, empty, invalid or oversized HTML', async () => {
  const responses = [() => new Response('protected', { status: 403, headers: { 'content-type': 'text/html' } }),
    () => page(''), () => page('<title>Please wait a few moments</title>'), () => page('no media'),
    () => new Response('not HTML', { headers: { 'content-type': 'application/json' } }),
    () => new Response('', { headers: { 'content-type': 'text/html', 'content-length': '1048577' } }),
    () => page('x'.repeat(1024 * 1024 + 1))];
  for (const response of responses) {
    let calls = 0;
    assert.equal(await createEromePreparer({ fetch: async () => { calls++; return response(); },
      convert: async () => { assert.fail('unavailable album converted'); } })(source), null);
    assert.equal(calls, 1);
  }
});

test('Erome rejects protected, wrong-type and oversized video responses before conversion', async () => {
  const responses = [() => new Response('protected', { status: 403, headers: { 'content-type': 'video/mp4' } }),
    () => new Response('not video', { headers: { 'content-type': 'text/html' } }),
    () => new Response('', { headers: { 'content-type': 'video/mp4', 'content-length': String(MAX_VIDEO_BYTES + 1) } })];
  for (const response of responses) {
    let calls = 0;
    assert.equal(await createEromePreparer({ fetch: async () => ++calls === 1 ? page() : response(),
      convert: async () => { assert.fail('unavailable video converted'); } })(source), null);
    assert.equal(calls, 2);
  }
});

test('Erome enforces the streamed media byte bound even without Content-Length', async () => {
  let cancelled = false, calls = 0;
  const chunk = new Uint8Array(1024 * 1024);
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(chunk); },
    cancel() { cancelled = true; } });
  assert.equal(await createEromePreparer({ fetch: async () => ++calls === 1 ? page() :
    new Response(stream, { headers: { 'content-type': 'video/mp4' } }),
  convert: async () => { assert.fail('oversized stream converted'); } })(source), null);
  assert.equal(cancelled, true);
});

test('Erome accepts a progressing video download that takes 60 seconds', async t => {
  const download = progressingDownload(t, 3);
  const converted: Buffer[] = [];
  try {
    const result = await createEromePreparer({ fetch: download.request,
      convert: async input => { converted.push(input); return Buffer.from('synthetic output'); } })(source);
    assert.ok(result, 'A complete 60-second download must reach conversion');
    assert.deepEqual(converted, [Buffer.from([1, 2, 3])]);
    assert.deepEqual(download.state, { elapsed: 60_000, abortedAt: 0, completed: true, listeners: 0 });
  } finally { download.restore(); }
});

test('Erome stops a still-progressing video download at its 120-second absolute deadline', async t => {
  const download = progressingDownload(t, 12);
  try {
    const result = await createEromePreparer({ fetch: download.request,
      convert: async () => { assert.fail('An incomplete timed-out video must not be converted'); } })(source);
    assert.equal(result, null);
    assert.deepEqual(download.state, { elapsed: 120_000, abortedAt: 120_000, completed: false, listeners: 0 });
  } finally { download.restore(); }
});

test('Erome returns null for failed conversions and releases its lock after exceptions', async () => {
  for (const convert of [async () => null, async () => Buffer.alloc(0), async () => Buffer.alloc(MAX_ATTACHMENT_BYTES + 1),
    async () => { throw new Error('conversion failed'); }]) {
    let calls = 0;
    assert.equal(await createEromePreparer({ fetch: async () => ++calls === 1 ? page() : media(), convert })(source), null);
  }
  assert.equal(await createEromePreparer({ fetch: async () => { throw new Error('network failed'); } })(source), null);
  let calls = 0;
  assert.ok(await createEromePreparer({ fetch: async () => ++calls === 1 ? page() : media(),
    convert: async () => Buffer.from('ok') })(source));
});

test('Erome declines concurrent requests across preparer instances instead of queueing', async () => {
  let release!: (response: Response) => void, calls = 0;
  const prepare = createEromePreparer({ fetch: async () => ++calls === 1 ?
    new Promise<Response>(resolve => { release = resolve; }) : media(), convert: async () => Buffer.from('ok') });
  const pending = prepare(source);
  assert.equal(await createEromePreparer({ fetch: async () => { assert.fail('busy request fetched'); } })(source), null);
  release(page());
  assert.ok(await pending);
});
