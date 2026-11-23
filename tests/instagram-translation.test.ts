import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInstagramLookup, parseInstagramUrl } from '../src/services/InstagramTranslation';

const CODE = 'DdFwAIqgncQ';
const source = (code = CODE, kind = 'p') => `https://www.instagram.com/${kind}/${code}/`;
// A long mixed-language fixture reproduces the English-introduction regression without retaining a real caption.
const caption = 'Follow @bustervro for more.\n\n' + 'See on eestikeelne lõik, mis vajab tõlkimist. '.repeat(18) + '\n\n#eesti';
const translated = { text: 'Follow @bustervro for more.\n\nThis is the complete English caption.\n\n#eesti', languages: ['et'] };
const ORIGIN = 'https://oginstagram.com';
const html = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/[@#]\w+/g, tag => `<a href="${ORIGIN}/${tag.slice(1)}">${tag}</a>`).replace(/\n/g, '<br>');
const OFFLOAD = `${ORIGIN}/offload/${CODE}/1?v=2&kid=k1&exp=1798041600&sig=abc_-1`;
const media = (mediaType = 'image/jpeg', url = OFFLOAD) => ({ type: 'Document', mediaType, url, width: 720, height: 1280 });
/** OGInstagram's ActivityStreams Note, as served for `Accept: application/activity+json`. */
const payload = (patch: Record<string, unknown> = {}, code = CODE, kind = 'p') => ({
  '@context': 'https://www.w3.org/ns/activitystreams', type: 'Note', id: `${ORIGIN}/${kind}/${code}`,
  attributedTo: `${ORIGIN}/bustervro`, content: `<p><b>❤️ 1,234 💬 56</b></p><p>${html(caption)}</p>`,
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
  const lookup = createInstagramLookup(async () => assert.fail('No translation for rejected input'),
    async () => assert.fail('No metadata request for rejected input'));
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

test('DdFwAIqgncQ passes its full mixed-language caption to the translator and returns gallery metadata', async () => {
  const requests: string[] = [], captions: string[] = [];
  const lookup = createInstagramLookup(async text => { captions.push(text); return translated; }, async (input, options) => {
    requests.push(String(input));
    assert.equal(options?.redirect, 'error'); assert.equal(options?.credentials, 'omit');
    assert(options?.signal instanceof AbortSignal);
    assert.deepEqual(options.headers, { Accept: 'application/activity+json', 'User-Agent': 'LinkyBot/1.0 (+https://linkybot.dev)' });
    return json(payload());
  });
  const result = await lookup(source() + '?igsh=tracking');
  assert.deepEqual(requests, [`${ORIGIN}/p/${CODE}/`], 'the lookup uses the live provider, never a retired host');
  assert.deepEqual(captions, [caption]); assert(caption.length > 250);
  assert.deepEqual(result, { sourceUrl: source(), shortcode: CODE, username: 'bustervro',
    text: translated.text, languages: ['et'], mediaOnlyUrl: `https://g.oginstagram.com/p/${CODE}/`, mediaTypes: ['GraphImage'],
    media: [{ type: 'photo', url: OFFLOAD, width: 720, height: 1280 }] });
  assert.equal(Object.hasOwn(result!, 'hasWorkingMedia'), false, 'GraphImage is metadata, not a media-health assertion');
});

test('Reels use the provider Reel route but still return the canonical gallery path', async () => {
  // The provider has no /tv/ route, so a legacy IGTV shortcode is requested as a post.
  for (const [kind, route] of [['reel', 'reel'], ['reels', 'reel'], ['tv', 'p']]) {
    const lookup = createInstagramLookup(async () => translated, async input => {
      assert.equal(String(input), `${ORIGIN}/${route}/${CODE}/`);
      return json(payload({ attachment: [media('video/mp4')] }, CODE, route));
    });
    const result = await lookup(source(CODE, kind));
    assert.equal(result?.sourceUrl, source(CODE, kind)); assert.deepEqual(result?.mediaTypes, ['GraphVideo']);
    assert.equal(result?.mediaOnlyUrl, `https://g.oginstagram.com/p/${CODE}/`);
  }
});

test('carousel attachments map to image and video hints in order', async () => {
  const lookup = createInstagramLookup(async () => translated,
    serve({ attachment: [media(), media('video/mp4'), media('IMAGE/WEBP')] }));
  assert.deepEqual((await lookup(source()))?.mediaTypes, ['GraphImage', 'GraphVideo', 'GraphImage']);
});

test('media keeps each provider offload address in order and is omitted when any item lacks one', async () => {
  const video = `https://g.oginstagram.com/offload/${CODE}/2?sig=x`;
  const ordered = createInstagramLookup(async () => translated,
    serve({ attachment: [media(), media('video/mp4', video), { ...media(), width: 0 }] }));
  assert.deepEqual((await ordered(source()))?.media, [
    { type: 'photo', url: OFFLOAD, width: 720, height: 1280 }, { type: 'video', url: video, width: 720, height: 1280 },
    { type: 'photo', url: OFFLOAD }]);
  for (const url of [undefined, 4, `http://oginstagram.com/offload/${CODE}/1`, `https://evil.test/offload/${CODE}/1`,
    `https://oginstagram.com.evil.test/offload/${CODE}/1`, `https://oginstagram.com:8443/offload/${CODE}/1`,
    `https://user@oginstagram.com/offload/${CODE}/1`, `https://oginstagram.com/offload/OtherPost/1`,
    `https://oginstagram.com/p/${CODE}/`, `https://scontent.cdninstagram.com/v/${CODE}.mp4`, `${OFFLOAD}&${'x'.repeat(2048)}`]) {
    const lookup = createInstagramLookup(async () => translated, serve({ attachment: [media(), { ...media(), url }] }));
    const result = await lookup(source());
    assert(result, 'the caption stays available without media addresses');
    assert.equal(Object.hasOwn(result, 'media'), false, String(url).slice(0, 80));
  }
});

test('caption text drops provider statistics and markup while escaped characters stay literal', async () => {
  const cases: [string, string][] = [
    ['<p><b>❤️ 12 &amp; 💬 3</b></p><p>Tere &amp; tere &lt;b&gt;not bold&lt;/b&gt;<br>teine rida <a href="https://oginstagram.com/explore/tags/eesti">#eesti</a></p>',
      'Tere & tere <b>not bold</b>\nteine rida #eesti'],
    ['<p>Esimene</p><p>Teine<br/>rida</p>', 'Esimene\n\nTeine\nrida'],
    ['<p>&#128512; &#x1F600; &quot;q&quot; &apos;a&apos; &unknown; &#0; &#xD800; &amp;lt;</p>', '😀 😀 "q" \'a\' &unknown; &#0; &#xD800; &lt;'],
  ];
  for (const [content, expected] of cases) {
    const captions: string[] = [];
    const lookup = createInstagramLookup(async text => { captions.push(text); return translated; }, serve({ content }));
    assert(await lookup(source()));
    assert.deepEqual(captions, [expected]);
  }
});

test('invalid and incomplete provider responses never reach the translator', async () => {
  for (const value of [null, [], {}, { error: 'unavailable' },
    payload({ type: 'Article' }), payload({ type: undefined }),
    payload({ id: `${ORIGIN}/p/OtherPost` }), payload({ id: `${ORIGIN}/p/${CODE}/` }), payload({ id: `${ORIGIN}/tv/${CODE}` }),
    payload({ id: `https://evil.test/p/${CODE}` }), payload({ id: 4 }),
    payload({ attributedTo: '' }), payload({ attributedTo: `${ORIGIN}/` }), payload({ attributedTo: 'https://evil.test/bustervro' }),
    payload({ attributedTo: `${ORIGIN}/@everyone` }), payload({ attributedTo: `${ORIGIN}/${'x'.repeat(31)}` }),
    payload({ attributedTo: `${ORIGIN}/a/b` }), payload({ attributedTo: ['bustervro'] }),
    payload({ content: '' }), payload({ content: '<p><b>❤️ 12</b></p>' }), payload({ content: '<p>  <br></p>' }), payload({ content: 4 }),
    payload({ content: `<p>${'é'.repeat(8193)}</p>` }),
    payload({ attachment: [] }), payload({ attachment: null }), payload({ attachment: [{}] }), payload({ attachment: [null] }),
    payload({ attachment: [media('text/html')] }), payload({ attachment: [media(), media('unknown')] }),
    payload({ attachment: Array.from({ length: 21 }, () => media()) }),
    // The retired provider's payload shape is not a Note.
    { Username: 'bustervro', Caption: caption, Medias: [{ TypeName: 'GraphImage' }] },
  ]) {
    // The lookup swallows translator errors, so count calls instead of throwing from the translator.
    let translations = 0;
    const lookup = createInstagramLookup(async () => { translations++; return translated; }, async () => json(value));
    assert.equal(await lookup(source()), null, JSON.stringify(value)?.slice(0, 120));
    assert.equal(translations, 0, JSON.stringify(value)?.slice(0, 120));
  }
});

test('the mistyped lowercase-l shortcode cannot reuse the uppercase-I post cache', async () => {
  const requests: string[] = [];
  const lookup = createInstagramLookup(async () => translated, async input => {
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
    new Response(JSON.stringify({ type: 'about:blank', title: 'Not Found', status: 404 }),
      { status: 404, headers: { 'Content-Type': 'application/problem+json' } }),
    new Response('<html>login</html>'), new Response(new Uint8Array([0xff, 0xfe])),
    new Response(null, { status: 204 })]) {
    const lookup = createInstagramLookup(async () => assert.fail('Invalid response cannot be translated'), async () => response);
    assert.equal(await lookup(source()), null);
  }
  const lookup = createInstagramLookup(async () => translated, async () => { throw new Error('private-provider-details'); });
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
    const lookup = createInstagramLookup(async () => assert.fail('Oversized payload cannot be translated'), async () =>
      new Response(body, { headers: declared ? { 'content-length': '65537' } : {} }));
    assert.equal(await lookup(source()), null); assert.equal(cancelled, true);
  }
});

test('empty, failed, oversized and invalid-language translations fall back without labeling a translation', async () => {
  for (const value of [null, { text: '', languages: ['et'] }, { text: ' \n', languages: ['et'] },
    { text: 'é'.repeat(8193), languages: ['et'] }, { text: 'English only', languages: ['en', 'en-US'] },
    { text: 'Unknown language', languages: ['und', 'zxx', 'mul'] }, { text: 'Caption', languages: [] },
    { text: 'Caption', languages: ['Estonian'] }, { text: 'Caption', languages: ['et\n'] },
    { text: 'Caption', languages: ['et', 'de', 'fr', 'ja', 'ko', 'es', 'it', 'fi', 'sv'] },
  ]) {
    const lookup = createInstagramLookup(async () => value, async () => json(payload()));
    assert.equal(await lookup(source()), null);
  }
  const lookup = createInstagramLookup(async () => { throw new Error('translation-secret'); }, async () => json(payload()));
  assert.equal(await lookup(source()), null);
});

test('normalizes and deduplicates non-English language codes without interpreting script or caption prefix', async () => {
  const lookup = createInstagramLookup(async () => ({ text: '  English result\nSecond line  ', languages: ['en', 'ET', 'et', 'DE-de', 'und'] }),
    async () => json(payload()));
  const result = await lookup(source());
  assert.equal(result?.text, 'English result\nSecond line'); assert.deepEqual(result?.languages, ['et', 'de-de']);
});

test('concurrent equivalent URLs share one lookup and cached results are not externally mutable', async () => {
  let requests = 0, translations = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const lookup = createInstagramLookup(async () => { translations++; await gate; return translated; },
    async () => { requests++; return json(payload()); });
  const first = lookup(source()), second = lookup(`https://m.instagram.com/p/${CODE}?igsh=other`);
  await turn(); assert.equal(requests, 1); assert.equal(translations, 1); release();
  const [one, two] = await Promise.all([first, second]); assert(one); assert(two);
  one.languages.push('de'); one.mediaTypes.push('GraphVideo'); one.text = 'Mutated';
  one.media![0].url = 'https://evil.test/'; one.media!.push({ type: 'video', url: 'https://evil.test/' });
  assert.deepEqual(two.languages, ['et']); assert.deepEqual(two.mediaTypes, ['GraphImage']);
  assert.deepEqual(two.media, [{ type: 'photo', url: OFFLOAD, width: 720, height: 1280 }]);
  assert.equal((await lookup(source()))?.text, translated.text); assert.equal(requests, 1);
});

test('source post and Reel metadata retain distinct provider lookup hints', async () => {
  const requests: string[] = [];
  const lookup = createInstagramLookup(async () => translated, async input => {
    requests.push(String(input)); return serve()(input);
  });
  await lookup(source()); await lookup(source(CODE, 'reel')); await lookup(source(CODE, 'reels'));
  assert.deepEqual(requests, [`${ORIGIN}/p/${CODE}/`, `${ORIGIN}/reel/${CODE}/`]);
  assert.equal((await lookup(source(CODE, 'reels')))?.sourceUrl, source(CODE, 'reels'));
});

test('positive cache entries expire after five minutes and failures retry after thirty seconds', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let requests = 0, fail = false;
  const lookup = createInstagramLookup(async () => fail ? null : translated, async () => { requests++; return json(payload()); });
  assert(await lookup(source())); t.mock.timers.tick(299_999); assert(await lookup(source())); assert.equal(requests, 1);
  t.mock.timers.tick(1); fail = true; assert.equal(await lookup(source()), null); assert.equal(requests, 2);
  t.mock.timers.tick(29_999); assert.equal(await lookup(source()), null); assert.equal(requests, 2);
  t.mock.timers.tick(1); fail = false; assert(await lookup(source())); assert.equal(requests, 3);
});

test('cache capacity evicts older results without retaining unbounded caption data', async () => {
  let requests = 0;
  const lookup = createInstagramLookup(async () => translated, async input => { requests++; return serve()(input); });
  for (let i = 0; i < 101; i++) assert(await lookup(source(`Post_${i}`)));
  assert.equal(requests, 101); assert(await lookup(source('Post_100'))); assert.equal(requests, 101);
  assert(await lookup(source('Post_0'))); assert.equal(requests, 102);
});

test('at most eight distinct requests can be pending while duplicates still share their result', async () => {
  let requests = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const lookup = createInstagramLookup(async () => { await gate; return translated; },
    async input => { requests++; return serve()(input); });
  const first = Array.from({ length: 8 }, (_, i) => lookup(source(`Post_${i}`)));
  const duplicate = lookup(source('Post_0'));
  assert.equal(await lookup(source('Post_8')), null); assert.equal(requests, 8);
  release(); assert((await Promise.all([...first, duplicate])).every(Boolean));
});

test('a stalled metadata request is aborted after five seconds', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let signal: AbortSignal | null | undefined;
  const lookup = createInstagramLookup(async () => assert.fail('Timed out metadata cannot be translated'), async (_input, options) => {
    signal = options?.signal; return new Promise<Response>(() => {});
  });
  const result = lookup(source()); t.mock.timers.tick(5_000);
  assert.equal(await result, null); assert.equal(signal?.aborted, true);
});

test('a stalled response body is cancelled within the metadata timeout', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let cancelled = false;
  const lookup = createInstagramLookup(async () => assert.fail('Timed out body cannot be translated'), async () =>
    new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } })));
  const result = lookup(source()); await turn(); t.mock.timers.tick(5_000);
  assert.equal(await result, null); assert.equal(cancelled, true);
});

test('a stalled translator cannot hold a message handler beyond the overall lookup deadline', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const lookup = createInstagramLookup(async () => new Promise(() => {}), async () => json(payload()));
  const result = lookup(source()); await turn(); t.mock.timers.tick(20_000);
  assert.equal(await result, null);
});
