import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInstagramLookup, parseInstagramUrl } from '../src/services/InstagramPost';

const CODE = 'DdFwAIqgncQ';
const source = (code = CODE, kind = 'p') => `https://www.instagram.com/${kind}/${code}/`;
const ORIGIN = 'https://oginstagram.com';
const OFFLOAD = `${ORIGIN}/offload/${CODE}/1?v=2&kid=k1&exp=1798041600&sig=abc_-1`;
const media = (mediaType = 'image/jpeg', url = OFFLOAD) => ({ type: 'Document', mediaType, url, width: 720, height: 1280 });
/** OGInstagram's ActivityStreams Note, as served for `Accept: application/activity+json`. */
const payload = (patch: Record<string, unknown> = {}, code = CODE, kind = 'p') => ({
  '@context': 'https://www.w3.org/ns/activitystreams', type: 'Note', id: `${ORIGIN}/${kind}/${code}`,
  attributedTo: `${ORIGIN}/bustervro`, content: '<p><b>❤️ 1,234 💬 56</b></p><p>Tere tulemast</p>',
  attachment: [media()], ...patch });
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/activity+json' } });
/** Answer each request with the Note for the post that request names. */
const serve = (patch: Record<string, unknown> = {}) => async (input: Parameters<typeof fetch>[0]) => {
  const [, kind, code] = /^https:\/\/oginstagram\.com\/(p|reel)\/([^/]+)\/$/.exec(String(input))!;
  return json(payload(patch, code, kind));
};
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test('parses exact source hosts and post paths while preserving case-sensitive shortcodes', () => {
  for (const host of ['instagram.com', 'www.instagram.com', 'm.instagram.com', 'mobile.instagram.com']) {
    for (const kind of ['p', 'reel', 'reels', 'tv']) {
      assert.deepEqual(parseInstagramUrl(`https://${host}/${kind}/${CODE}?igsh=tracking#section`), { sourceUrl: source(CODE, kind), shortcode: CODE });
    }
  }
  assert.deepEqual(parseInstagramUrl(`HTTPS://WWW.INSTAGRAM.COM/p/${CODE}/`), { sourceUrl: source(), shortcode: CODE });
  assert.equal(parseInstagramUrl(source('Aa_-09'))?.shortcode, 'Aa_-09');
  assert.equal(parseInstagramUrl(source('A'.repeat(64)))?.shortcode.length, 64);
});

test('rejects fixer links, profiles, unknown paths and authorities without making any request', async () => {
  const lookup = createInstagramLookup(async () => assert.fail('No metadata request for rejected input'));
  for (const value of [
    source().replace('https:', 'http:'), source().replace('www.', 'g.'), source().replace('instagram.com', 'instagram7.com'),
    `https://g.fkinstagram.com/p/${CODE}/`, `https://oginstagram.com/p/${CODE}/`, `https://www.instagram.com:443/p/${CODE}/`,
    `https://www.instagram.com:444/p/${CODE}/`, `https://user@www.instagram.com/p/${CODE}/`,
    `https://www.instagram.com.evil.test/p/${CODE}/`, `https://www.instagram.com./p/${CODE}/`,
    `https://www.instagram.com\\@evil.test/p/${CODE}/`, `https://evil.test/?next=${source()}`,
    'https://www.instagram.com/bustervro/', 'https://www.instagram.com/',
    `https://www.instagram.com/bustervro/p/${CODE}/`, `https://www.instagram.com/stories/bustervro/${CODE}/`,
    `https://www.instagram.com/p/${CODE}/extra`, `https://www.instagram.com/reel/../p/${CODE}/`,
    `https://www.instagram.com/p/%44dFwAIqgncQ/`, source('A'.repeat(65)), source() + '\n',
    source().replace(CODE, 'code with spaces'), ' ' + source(), source() + '?x=' + 'x'.repeat(2100),
  ]) {
    assert.equal(parseInstagramUrl(value), null, value);
    assert.equal(await lookup(value), null, value);
  }
});

test('DdFwAIqgncQ returns its author and media, and no caption', async () => {
  const requests: string[] = [];
  const lookup = createInstagramLookup(async (input, options) => {
    requests.push(String(input));
    assert.equal(options?.redirect, 'error'); assert.equal(options?.credentials, 'omit');
    assert(options?.signal instanceof AbortSignal);
    assert.deepEqual(options.headers, { Accept: 'application/activity+json', 'User-Agent': 'LinkyBot/1.0 (+https://linkybot.dev)' });
    return json(payload());
  });
  const result = await lookup(source() + '?igsh=tracking');
  assert.deepEqual(requests, [`${ORIGIN}/p/${CODE}/`], 'the lookup uses the live provider, never a retired host');
  assert.deepEqual(result, { sourceUrl: source(), shortcode: CODE, username: 'bustervro', mediaTypes: ['GraphImage'],
    media: [{ type: 'photo', url: OFFLOAD, width: 720, height: 1280 }] });
  assert.equal(JSON.stringify(result).includes('Tere'), false, 'the caption is never kept');
});

test('a post without a caption still returns its author and media', async () => {
  for (const patch of [{ content: '' }, { content: undefined }, { content: 4 }, { content: '<p><b>❤️ 12</b></p>' }]) {
    const result = await createInstagramLookup(async () => json(payload(patch)))(source());
    assert.equal(result?.username, 'bustervro', JSON.stringify(patch));
    assert.equal(result?.media?.length, 1);
  }
});

test('Reels use the provider Reel route', async () => {
  // The provider has no /tv/ route, so a legacy IGTV shortcode is requested as a post.
  for (const [kind, route] of [['reel', 'reel'], ['reels', 'reel'], ['tv', 'p']]) {
    const lookup = createInstagramLookup(async input => {
      assert.equal(String(input), `${ORIGIN}/${route}/${CODE}/`);
      return json(payload({ attachment: [media('video/mp4')] }, CODE, route));
    });
    const result = await lookup(source(CODE, kind));
    assert.equal(result?.sourceUrl, source(CODE, kind)); assert.deepEqual(result?.mediaTypes, ['GraphVideo']);
  }
});

test('carousel attachments map to image and video hints in order', async () => {
  const lookup = createInstagramLookup(serve({ attachment: [media(), media('video/mp4'), media('IMAGE/WEBP')] }));
  assert.deepEqual((await lookup(source()))?.mediaTypes, ['GraphImage', 'GraphVideo', 'GraphImage']);
});

test('media keeps each provider offload address in order and is omitted when any item lacks one', async () => {
  const video = `https://g.oginstagram.com/offload/${CODE}/2?sig=x`;
  const ordered = createInstagramLookup(serve({ attachment: [media(), media('video/mp4', video), { ...media(), width: 0 }] }));
  assert.deepEqual((await ordered(source()))?.media, [
    { type: 'photo', url: OFFLOAD, width: 720, height: 1280 }, { type: 'video', url: video, width: 720, height: 1280 },
    { type: 'photo', url: OFFLOAD }]);
  for (const url of [undefined, 4, `http://oginstagram.com/offload/${CODE}/1`, `https://evil.test/offload/${CODE}/1`,
    `https://oginstagram.com.evil.test/offload/${CODE}/1`, `https://oginstagram.com:8443/offload/${CODE}/1`,
    `https://user@oginstagram.com/offload/${CODE}/1`, `https://oginstagram.com/offload/OtherPost/1`,
    `https://oginstagram.com/p/${CODE}/`, `https://scontent.cdninstagram.com/v/${CODE}.mp4`, `${OFFLOAD}&${'x'.repeat(2048)}`]) {
    const lookup = createInstagramLookup(serve({ attachment: [media(), { ...media(), url }] }));
    const result = await lookup(source());
    assert(result, 'the post stays known without media addresses');
    assert.equal(Object.hasOwn(result, 'media'), false, String(url).slice(0, 80));
  }
});

test('invalid and incomplete provider responses are rejected', async () => {
  for (const value of [null, [], {}, { error: 'unavailable' },
    payload({ type: 'Article' }), payload({ type: undefined }),
    payload({ id: `${ORIGIN}/p/OtherPost` }), payload({ id: `${ORIGIN}/p/${CODE}/` }), payload({ id: `${ORIGIN}/tv/${CODE}` }),
    payload({ id: `https://evil.test/p/${CODE}` }), payload({ id: 4 }),
    payload({ attributedTo: '' }), payload({ attributedTo: `${ORIGIN}/` }), payload({ attributedTo: 'https://evil.test/bustervro' }),
    payload({ attributedTo: `${ORIGIN}/@everyone` }), payload({ attributedTo: `${ORIGIN}/${'x'.repeat(31)}` }),
    payload({ attributedTo: `${ORIGIN}/a/b` }), payload({ attributedTo: ['bustervro'] }),
    payload({ attachment: [] }), payload({ attachment: null }), payload({ attachment: [{}] }), payload({ attachment: [null] }),
    payload({ attachment: [media('text/html')] }), payload({ attachment: [media(), media('unknown')] }),
    payload({ attachment: Array.from({ length: 21 }, () => media()) }),
    // The retired provider's payload shape is not a Note.
    { Username: 'bustervro', Caption: 'Caption', Medias: [{ TypeName: 'GraphImage' }] },
  ]) {
    const lookup = createInstagramLookup(async () => json(value));
    assert.equal(await lookup(source()), null, JSON.stringify(value)?.slice(0, 120));
  }
});

test('the mistyped lowercase-l shortcode cannot reuse the uppercase-I post cache', async () => {
  const requests: string[] = [];
  const lookup = createInstagramLookup(async input => {
    requests.push(String(input));
    // A provider answering with another post's Note is rejected by its id.
    return json(payload());
  });
  assert(await lookup(source()));
  assert.equal(await lookup(source('DdFwAlqgncQ')), null);
  assert.deepEqual(requests, [`${ORIGIN}/p/${CODE}/`, `${ORIGIN}/p/DdFwAlqgncQ/`]);
});

test('provider errors, redirects, invalid JSON and malformed UTF-8 fail open', async () => {
  for (const response of [new Response('provider error', { status: 500 }), new Response('', { status: 302 }),
    new Response('rate limited', { status: 429 }),
    new Response(JSON.stringify({ type: 'about:blank', title: 'Not Found', status: 404 }),
      { status: 404, headers: { 'Content-Type': 'application/problem+json' } }),
    new Response('<html>login</html>'), new Response(new Uint8Array([0xff, 0xfe])),
    new Response(null, { status: 204 })]) {
    const lookup = createInstagramLookup(async () => response);
    assert.equal(await lookup(source()), null);
  }
  const lookup = createInstagramLookup(async () => { throw new Error('private-provider-details'); });
  assert.equal(await lookup(source()), null);
});

test('declared and streamed oversized responses are cancelled before JSON parsing', async () => {
  for (const declared of [true, false]) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (!declared) {
          controller.enqueue(new Uint8Array(40_000)); controller.enqueue(new Uint8Array(40_000));
        }
      }, cancel() { cancelled = true; },
    });
    const lookup = createInstagramLookup(async () =>
      new Response(body, { headers: declared ? { 'content-length': '65537' } : {} }));
    assert.equal(await lookup(source()), null); assert.equal(cancelled, true);
  }
});

test('concurrent equivalent URLs share one lookup and cached results are not externally mutable', async () => {
  let requests = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const lookup = createInstagramLookup(async () => { requests++; await gate; return json(payload()); });
  const first = lookup(source()), second = lookup(`https://m.instagram.com/p/${CODE}?igsh=other`);
  await turn(); assert.equal(requests, 1); release();
  const [one, two] = await Promise.all([first, second]); assert(one); assert(two);
  one.mediaTypes.push('GraphVideo'); one.username = 'mutated';
  one.media![0].url = 'https://evil.test/'; one.media!.push({ type: 'video', url: 'https://evil.test/' });
  assert.deepEqual(two.mediaTypes, ['GraphImage']); assert.equal(two.username, 'bustervro');
  assert.deepEqual(two.media, [{ type: 'photo', url: OFFLOAD, width: 720, height: 1280 }]);
  assert.equal((await lookup(source()))?.username, 'bustervro'); assert.equal(requests, 1);
});

test('source post and Reel metadata retain distinct provider lookup hints', async () => {
  const requests: string[] = [];
  const lookup = createInstagramLookup(async input => {
    requests.push(String(input)); return serve()(input);
  });
  await lookup(source()); await lookup(source(CODE, 'reel')); await lookup(source(CODE, 'reels'));
  assert.deepEqual(requests, [`${ORIGIN}/p/${CODE}/`, `${ORIGIN}/reel/${CODE}/`]);
  assert.equal((await lookup(source(CODE, 'reels')))?.sourceUrl, source(CODE, 'reels'));
});

test('positive cache entries expire after five minutes and failures retry after thirty seconds', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let requests = 0, fail = false;
  const lookup = createInstagramLookup(async () => { requests++; return fail ? new Response('', { status: 429 }) : json(payload()); });
  assert(await lookup(source())); t.mock.timers.tick(299_999); assert(await lookup(source())); assert.equal(requests, 1);
  t.mock.timers.tick(1); fail = true; assert.equal(await lookup(source()), null); assert.equal(requests, 2);
  t.mock.timers.tick(29_999); assert.equal(await lookup(source()), null); assert.equal(requests, 2);
  t.mock.timers.tick(1); fail = false; assert(await lookup(source())); assert.equal(requests, 3);
});

test('cache capacity evicts older results', async () => {
  let requests = 0;
  const lookup = createInstagramLookup(async input => { requests++; return serve()(input); });
  for (let i = 0; i < 101; i++) assert(await lookup(source(`Post_${i}`)));
  assert.equal(requests, 101); assert(await lookup(source('Post_100'))); assert.equal(requests, 101);
  assert(await lookup(source('Post_0'))); assert.equal(requests, 102);
});

test('at most eight distinct requests can be pending while duplicates still share their result', async () => {
  let requests = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const lookup = createInstagramLookup(async input => { requests++; await gate; return serve()(input); });
  const first = Array.from({ length: 8 }, (_, i) => lookup(source(`Post_${i}`)));
  const duplicate = lookup(source('Post_0'));
  assert.equal(await lookup(source('Post_8')), null); assert.equal(requests, 8);
  release(); assert((await Promise.all([...first, duplicate])).every(Boolean));
});

test('a stalled metadata request is aborted after five seconds', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let signal: AbortSignal | null | undefined;
  const lookup = createInstagramLookup(async (_input, options) => {
    signal = options?.signal; return new Promise<Response>(() => {});
  });
  const result = lookup(source()); t.mock.timers.tick(5_000);
  assert.equal(await result, null); assert.equal(signal?.aborted, true);
});

test('a stalled response body is cancelled within the metadata timeout', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let cancelled = false;
  const lookup = createInstagramLookup(async () =>
    new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } })));
  const result = lookup(source()); await turn(); t.mock.timers.tick(5_000);
  assert.equal(await result, null); assert.equal(cancelled, true);
});
