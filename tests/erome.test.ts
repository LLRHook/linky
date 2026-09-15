import assert from 'node:assert/strict';
import { beforeEach, test, type TestContext } from 'node:test';
import { createEromePreparer as createStreamingEromePreparer, parseEromeUrl } from '../src/services/Erome';
import { MAX_ATTACHMENT_BYTES, MAX_VIDEO_BYTES } from '../src/services/VideoAttachment';
import { MessagePayload } from 'discord.js';

let source = 'https://www.erome.com/a/Test_123', sequence = 0;
beforeEach(() => { source = `https://www.erome.com/a/Test_${++sequence}`; });
const video = 'https://v54.erome.com/1/Test_123/video.mp4';
const page = (html = `<video><source src="${video}" type="video/mp4"></video>`) =>
  new Response(`<div class="media-group">${html}</div>`, { headers: { 'content-type': 'text/html; charset=UTF-8' } });
const media = () => new Response('synthetic video input', { headers: { 'content-type': 'video/mp4' } });

test('the download trace covers body consumption and cached builders share bytes safely with Discord.js', async () => {
  const events: string[] = [], output = Buffer.from('prepared immutable result');
  const prepare = createStreamingEromePreparer({ fetch: async input => String(input).includes('www.erome') ? page() : media(),
    convert: async input => {
      assert.equal(events.includes('download:ok'), false, 'headers cannot finish the download span');
      assert.ok(events.includes('convert:start')); assert.ok(!Buffer.isBuffer(input));
      for await (const _chunk of input.stream) assert.equal(events.includes('download:ok'), false);
      assert.ok(events.includes('download:ok')); return output;
    } });
  const first = await prepare(source, undefined, { context: { trace: { id: 'body', startStage(stage) {
    events.push(`${stage}:start`); return { finish(outcome) { events.push(`${stage}:${outcome ?? 'ok'}`); } };
  }, setPath() {}, finish() { assert.fail('preparation finalized a delivery'); } } } });
  const second = await prepare(source); assert.ok(first && second);
  assert.notEqual(first.file, second.file); assert.equal(first.file.attachment, second.file.attachment);
  const before = Buffer.from(output);
  // The library's narrower static typing excludes nullable builder names even though message upload accepts builders.
  const [a, b] = await Promise.all([MessagePayload.resolveFile({ attachment: first.file.attachment, name: first.file.name! }),
    MessagePayload.resolveFile({ attachment: second.file.attachment, name: second.file.name! })]);
  assert.equal(a.data, output); assert.equal(b.data, output); assert.deepEqual(output, before);
  second.file.setName('different.mp4'); assert.equal(first.file.name, 'linky-video.mp4');
});

// Most fixtures inspect the completed download. Streaming-specific cases use the real seam below.
function createEromePreparer({ convert, ...options }: {
  fetch?: typeof fetch; convert?: (input: Buffer) => Promise<Buffer | null>;
} = {}) {
  return createStreamingEromePreparer({ ...options, ...(convert ? { convert: async (input, settings) => {
    const chunks: Uint8Array[] = [];
    if (Buffer.isBuffer(input)) chunks.push(input);
    else for await (const chunk of input.stream) chunks.push(chunk);
    settings?.onEncoding?.();
    return convert(Buffer.concat(chunks));
  } } : {}) });
}

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
  for (const raw of [source, `${source}/?tracking=1#video`, source.replace('www.erome.com', 'EROME.com')]) {
    assert.deepEqual(parseEromeUrl(raw), { id: source.split('/').at(-1), url: source });
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

function heldPreparation(name: string, events: string[], fail = false) {
  const album = `${source}_${name}`;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const prepare = createEromePreparer({ fetch: async url => {
    events.push(`${name}:${parseEromeUrl(String(url)) ? 'album' : 'video'}`);
    return parseEromeUrl(String(url)) ? page() : media();
  }, convert: async () => {
    events.push(`${name}:convert`);
    await gate;
    if (fail) throw new Error('Synthetic conversion failure');
    return Buffer.from(name);
  } });
  return { prepare, release, album };
}

const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test('Erome queues an overlapping request across preparer instances and fetches only after the active one releases', async () => {
  const events: string[] = [];
  const first = heldPreparation('first', events), second = heldPreparation('second', events);
  const active = first.prepare(first.album);
  await turn();
  const waiting = second.prepare(second.album);
  try {
    await turn();
    assert.deepEqual(events, ['first:album', 'first:video', 'first:convert']);
    first.release();
    assert.ok(await active);
    await turn();
    second.release();
    const result = await waiting;
    assert.ok(result, 'A concurrent request must receive a preview after the active request finishes');
    assert.equal((result.file.attachment as Buffer).toString(), 'second');
    assert.deepEqual(events, ['first:album', 'first:video', 'first:convert', 'second:album', 'second:video', 'second:convert']);
  } finally { first.release(); second.release(); await Promise.allSettled([active, waiting]); }
});

test('Erome admits at most two FIFO waiters and rejects excess or invalid requests without fetching', async () => {
  const events: string[] = [], entries = ['first', 'second', 'third', 'excess'].map(name => heldPreparation(name, events));
  const pending = entries.slice(0, 3).map(entry => entry.prepare(entry.album));
  try {
    await turn();
    assert.deepEqual(events, ['first:album', 'first:video', 'first:convert']);
    assert.equal(await entries[3].prepare(entries[3].album), null);
    assert.equal(await entries[3].prepare('https://example.test/invalid'), null);
    for (let index = 0; index < 3; index++) {
      assert.deepEqual(events.filter(event => event.endsWith(':album')), ['first', 'second', 'third'].slice(0, index + 1).map(name => `${name}:album`));
      entries[index].release();
      assert.ok(await pending[index]);
      await turn();
    }
    assert(!events.some(event => event.startsWith('excess:')));
  } finally { entries.forEach(entry => entry.release()); await Promise.allSettled(pending); }
});

test('an expired Erome waiter is removed at five minutes and never fetches or prevents a later admission', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const events: string[] = [], first = heldPreparation('first', events), expired = heldPreparation('expired', events), later = heldPreparation('later', events);
  const active = first.prepare(first.album), waiting = expired.prepare(expired.album);
  const pending = [active, waiting];
  let settled = false;
  void waiting.then(() => { settled = true; });
  try {
    await turn();
    assert.equal(settled, false, 'The waiter must remain queued before its deadline');
    t.mock.timers.tick(299_999);
    await turn();
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    assert.equal(await waiting, null);
    const next = later.prepare(later.album);
    pending.push(next);
    first.release();
    assert.equal(await active, null, 'The overall deadline also cancels already admitted work');
    await turn();
    later.release();
    assert.ok(await next);
    assert.deepEqual(events.filter(event => event.endsWith(':album')), ['first:album', 'later:album']);
  } finally {
    first.release(); expired.release(); later.release();
    await Promise.allSettled(pending);
    t.mock.timers.reset();
  }
});

test('Erome drains queued work after conversion failure and applies an overall deadline after admission', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const events: string[] = [], failed = heldPreparation('failed', events, true), second = heldPreparation('second', events), third = heldPreparation('third', events);
  const first = failed.prepare(failed.album), waiting = second.prepare(second.album);
  const pending = [first, waiting];
  try {
    await turn();
    failed.release();
    assert.equal(await first, null);
    await turn();
    t.mock.timers.tick(300_000);
    const next = third.prepare(third.album);
    pending.push(next);
    await turn();
    assert.deepEqual(events.filter(event => event.endsWith(':album')), ['failed:album', 'second:album']);
    second.release();
    assert.equal(await waiting, null, 'The total deadline bounds admitted work too');
    await turn();
    third.release();
    assert.ok(await next);
  } finally {
    failed.release(); second.release(); third.release();
    await Promise.allSettled(pending);
    t.mock.timers.reset();
  }
});

test('Erome shares concurrent canonical-album preparation across instances and returns independent attachments', async () => {
  const events: string[] = [], first = heldPreparation('shared', events);
  const other = createEromePreparer({ fetch: async () => { assert.fail('The same album must not be fetched twice'); } });
  const active = first.prepare(first.album);
  await turn();
  const joined = other(first.album.replace('www.erome.com', 'erome.com') + '/?tracking=1#video');
  first.release();
  const [a, b] = await Promise.all([active, joined]);
  assert.ok(a && b, 'Both callers should receive the shared successful preparation');
  assert.deepEqual(events, ['shared:album', 'shared:video', 'shared:convert']);
  assert.notEqual(a.file, b.file);
  assert.equal(a.file.attachment, b.file.attachment, 'Prepared bytes are shared read-only, avoiding a copy for every requester');
  a.file.setName('changed.mp4');
  a.file.setFile(Buffer.from('different caller file'));
  assert.equal(b.file.name, 'linky-video.mp4');
  assert.equal((b.file.attachment as Buffer).toString(), 'shared');
});

test('Erome reuses a successful recent album across instances without fetching and without sharing mutable attachments', async () => {
  let fetches = 0;
  const prepare = createEromePreparer({ fetch: async url => {
    fetches++;
    return parseEromeUrl(String(url)) ? page() : media();
  }, convert: async () => Buffer.from('cached output') });
  const first = await prepare(source);
  assert.ok(first);
  first.file.setName('changed.mp4');
  first.file.setFile(Buffer.from('different caller file'));
  const stages: string[] = [];
  const second = await createEromePreparer({ fetch: async () => { assert.fail('A recent album should reuse its prepared video'); } })(
    source.replace('www.erome.com', 'erome.com') + '?tracking=1', stage => { stages.push(stage); });
  assert.ok(second);
  assert.equal(second.file.name, 'linky-video.mp4');
  assert.equal((second.file.attachment as Buffer).toString(), 'cached output');
  assert.equal(fetches, 2);
  assert.deepEqual(stages, ['cached']);
});

test('Erome evicts cached bytes at five minutes even without another request and cache hits do not extend retention', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let fetches = 0;
  const prepare = createEromePreparer({ fetch: async url => {
    fetches++;
    return parseEromeUrl(String(url)) ? page() : media();
  }, convert: async () => Buffer.from('cached output') });
  try {
    assert.ok(await prepare(source));
    t.mock.timers.tick(299_999);
    assert.ok(await prepare(source));
    assert.equal(fetches, 2);
    t.mock.timers.tick(1);
    // Rewind the clock: a lazy expiry check alone would incorrectly reuse the retained bytes.
    t.mock.timers.setTime(0);
    assert.ok(await prepare(source));
    assert.equal(fetches, 4, 'The eviction timer must remove bytes without a cache lookup');
    t.mock.timers.tick(300_000);
  } finally { t.mock.timers.reset(); }
});

test('Erome retains more than two outputs while evicting the least recently used bytes at its cap', async () => {
  const fetched: string[] = [];
  const prepare = createEromePreparer({ fetch: async url => {
    if (parseEromeUrl(String(url))) { fetched.push(String(url)); return page(); }
    return media();
  }, convert: async () => Buffer.alloc(MAX_ATTACHMENT_BYTES) });
  const a = `${source}_a`, b = `${source}_b`, c = `${source}_c`;
  for (const url of [a, b, a, c, a]) assert.ok(await prepare(url));
  assert.deepEqual(fetched, [a, b, c]);
  assert.ok(await prepare(b));
  assert.deepEqual(fetched, [a, b, c], 'Three recent outputs are retained');
  for (let i = 0; i < 7; i++) assert.ok(await prepare(`${source}_more_${i}`));
  assert.ok(await prepare(b));
  assert.equal(fetched.at(-1), b, 'More than 128 MiB must evict old outputs');
});

test('Erome caps one shared album at eight consumers without consuming the unique-album queue', async () => {
  const events: string[] = [], first = heldPreparation('shared', events), other = heldPreparation('other', events);
  const active = first.prepare(first.album);
  await turn();
  const pending = [active, ...Array.from({ length: 7 }, () => other.prepare(first.album))];
  const queued = other.prepare(other.album);
  try {
    assert.equal(await other.prepare(first.album), null, 'The ninth consumer must be rejected');
    assert.equal(await other.prepare(first.album + '\n'), null, 'Invalid URLs must not reach a shared job');
    assert.deepEqual(events, ['shared:album', 'shared:video', 'shared:convert']);
    first.release();
    assert((await Promise.all(pending)).every(Boolean));
    await turn();
    other.release();
    assert.ok(await queued);
    assert.deepEqual(events.filter(event => event.endsWith(':album')), ['shared:album', 'other:album']);
  } finally { first.release(); other.release(); await Promise.allSettled([...pending, queued]); }
});

test('Erome does not cache a failed shared preparation and admits a fresh retry', async () => {
  const events: string[] = [], failed = heldPreparation('failed', events, true), retry = heldPreparation('retry', events);
  const first = failed.prepare(failed.album), joined = retry.prepare(failed.album);
  failed.release();
  assert.deepEqual(await Promise.all([first, joined]), [null, null]);
  retry.release();
  assert.ok(await retry.prepare(failed.album));
  assert.deepEqual(events.filter(event => event.endsWith(':album')), ['failed:album', 'retry:album']);
});

test('Erome reports queue and preparation stages without waiting for or failing on observers', async () => {
  const events: string[] = [], stages: string[] = [], first = heldPreparation('first', events), second = heldPreparation('second', events);
  const active = first.prepare(first.album, () => new Promise<void>(() => {}));
  const queued = second.prepare(second.album, stage => { stages.push(stage); throw new Error('Deleted progress reply'); });
  try {
    await turn();
    assert.deepEqual(stages, ['queued']);
    first.release();
    assert.ok(await active, 'A stalled observer must not block shared preparation');
    await turn();
    assert.deepEqual(stages, ['queued', 'downloading', 'preparing']);
    second.release();
    assert.ok(await queued);
    assert.ok(await second.prepare(second.album, async () => { throw new Error('Async progress failure'); }));
    await turn();
  } finally { first.release(); second.release(); await Promise.allSettled([active, queued]); }
});

test('Erome keeps output allowances separate when sharing and caching the same album', async () => {
  let conversions = 0;
  const prepare = createEromePreparer({ fetch: async url => parseEromeUrl(String(url)) ? page() : media(),
    convert: async () => Buffer.alloc(++conversions === 1 ? 3 * 1024 * 1024 : 1024 * 1024) });
  const large = await prepare(source, undefined, { maxBytes: 4 * 1024 * 1024 });
  const small = await prepare(source, undefined, { maxBytes: 2 * 1024 * 1024 });
  assert.ok(large && small);
  assert.equal((small.file.attachment as Buffer).length, 1024 * 1024,
    'A large caller’s cached result must not be reused for a smaller allowance');
  assert.equal(conversions, 2);
  assert.ok(await prepare(source, undefined, { maxBytes: 4 * 1024 * 1024 }));
  assert.equal(conversions, 2);
});

test('Erome passes a bounded stream to conversion before the media response finishes', async () => {
  let fetches = 0, complete = false, total = 0;
  const stages: string[] = [];
  const prepare = createStreamingEromePreparer({ fetch: async () => ++fetches === 1 ? page() :
    new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++total <= 4) controller.enqueue(Uint8Array.of(total));
        else { complete = true; controller.close(); }
      },
    }), { headers: { 'content-type': 'video/mp4', 'content-length': '4' } }),
  convert: async (input, options) => {
    assert.equal(complete, false, 'Conversion must start before the entire download is buffered');
    assert(!Buffer.isBuffer(input));
    assert.equal(input.size, 4);
    assert.equal(options?.maxBytes, 2 * 1024 * 1024);
    const bytes: number[] = [];
    for await (const chunk of input.stream) {
      bytes.push(...chunk);
      if (bytes.length === 1) options.onEncoding?.();
    }
    assert.deepEqual(bytes, [1, 2, 3, 4]);
    return Buffer.from('prepared');
  } });
  assert.ok(await prepare(source, stage => { stages.push(stage); }, { maxBytes: 2 * 1024 * 1024 }));
  assert.deepEqual(stages, ['queued', 'downloading', 'preparing']);
});

test('Erome cancels unused media and rejects an output when conversion does not consume the complete source', async () => {
  let fetches = 0, cancelled = false;
  const prepare = createStreamingEromePreparer({ fetch: async () => ++fetches === 1 ? page() :
    new Response(new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(Uint8Array.of(1)); },
      cancel() { cancelled = true; } }), { headers: { 'content-type': 'video/mp4' } }),
  convert: async () => Buffer.from('not a complete video') });
  assert.equal(await prepare(source), null);
  assert.equal(cancelled, true);
});

test('Erome rejects incomplete declared lengths and invalid output allowances without caching', async () => {
  let fetches = 0;
  const prepare = createEromePreparer({ fetch: async () => ++fetches % 2 ? page() :
    new Response('short', { headers: { 'content-type': 'video/mp4', 'content-length': '100' } }),
  convert: async () => assert.fail('Incomplete download must not reach buffered conversion') });
  for (const maxBytes of [0, -1, NaN, Infinity, 1.5]) {
    assert.equal(await prepare(source, undefined, { maxBytes }), null);
  }
  assert.equal(fetches, 0);
  assert.equal(await prepare(source), null);
  assert.equal(await prepare(source), null);
  assert.equal(fetches, 4);
});
