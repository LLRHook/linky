import assert from 'node:assert/strict';
import { test } from 'node:test';
import { communityEmbedBudget, prepareYouTubeCommunityPosts, createYouTubeCommunityLookup, findYouTubeCommunityLinks, formatYouTubeCommunityPost,
  parseYouTubeCommunityHtml, parseYouTubeCommunityUrl } from '../src/services/YouTubeCommunity';

const ID = 'Ugkxvw3nKUJFYnzgAx5YBGKZ5wuaHdkelGlO';
const OTHER = 'UgkxfDv1kUvzbKSzXHNJ97AS3wqbFUaU6rkE';
const CHANNEL = 'UCLA_DiR1FfKNvjuUpBHmylQ';
const url = (id = ID) => `https://www.youtube.com/post/${id}`;
const image = (name = 'First', size = 640) => `https://yt3.ggpht.com/${name}=s${size}-nd-v1`;
const imageRenderer = (name = 'First') => ({ image: { thumbnails: [
  { url: image(name, 288), width: 288, height: 192 }, { url: image(name), width: 640, height: 427 },
] } });
// Synthetic content in the public first-party schema observed on NASA's post on 2026-09-18.
const renderer = (id = ID) => ({ postId: id, authorText: { runs: [{ text: 'Creator' }] },
  authorEndpoint: { browseEndpoint: { browseId: CHANNEL } }, contentText: { runs: [{ text: 'Post text' }] },
  publishedTimeText: { runs: [{ text: 'One day ago', navigationEndpoint: { browseEndpoint: {
    browseId: 'FEpost_detail', canonicalBaseUrl: `/post/${id}`,
  } } }] },
});
const html = (value: unknown = renderer()) => `<html><script>var ytInitialData = ${JSON.stringify({ contents: {
  backstagePostThreadRenderer: { post: { backstagePostRenderer: value } },
} })};</script></html>`;
const response = (body = html()) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const dns = async () => ['142.250.80.46'];

test('community URL parsing accepts canonical and mobile permalinks, drops tracking and deduplicates', () => {
  for (const host of ['youtube.com', 'www.youtube.com', 'm.youtube.com'])
    assert.deepEqual(parseYouTubeCommunityUrl(`https://${host}/post/${ID}/?si=tracking#reply`), { id: ID, url: url() });
  assert.deepEqual(findYouTubeCommunityLinks(`[post](${url()}) ${url()} ${url(OTHER)}`),
    [{ id: ID, url: url() }, { id: OTHER, url: url(OTHER) }]);
});

test('community URLs reject spoofed authorities, normalized paths, videos and nested links', () => {
  for (const value of [url().replace('https:', 'http:'), url().replace('www.', 'www.youtube.com@'),
    url().replace('.com/', '.com:443/'), url().replace('.com/', '.com.evil.test/'),
    url().replace('/post/', '/../post/'), url().replace('/post/', '/%70ost/'),
    url().replace('/post/', '\\post/'), url() + '/extra', url() + '\n',
    `https://evil.test/?url=${url()}`, `https://www.youtube.com/redirect?q=${url()}`,
    'https://youtu.be/dQw4w9WgXcQ', 'https://www.youtube.com/@NASA/posts',
    'https://www.youtube.com/post/no-id', 'https://www.youtube.com/post/' + 'Ug' + 'a'.repeat(127)])
    assert.equal(parseYouTubeCommunityUrl(value), null, value);
  assert.deepEqual(findYouTubeCommunityLinks(`<${url()}> \`${url()}\` ||${url()}||`), []);
  assert.equal(findYouTubeCommunityLinks(Array.from({ length: 7 }, (_, n) => url('Ug' + 'a'.repeat(20) + n)).join(' ')).length, 5);
});

test('text-only posts require matching post identity and authentic author channel attribution', () => {
  const post = parseYouTubeCommunityHtml(html(), url());
  assert.deepEqual(post, { id: ID, url: url(), author: { name: 'Creator', url: `https://www.youtube.com/channel/${CHANNEL}` },
    text: 'Post text', images: [] });
  assert.equal(parseYouTubeCommunityHtml(html(renderer(OTHER)), url()), null);
  assert.equal(parseYouTubeCommunityHtml(html({ ...renderer(), authorEndpoint: { browseEndpoint: { browseId: 'other' } } }), url()), null);
  assert.equal(parseYouTubeCommunityHtml(html({ ...renderer(), authorText: {} }), url()), null);
  assert.equal(parseYouTubeCommunityHtml(html({ ...renderer(), publishedTimeText: renderer(OTHER).publishedTimeText }), url()), null);
});

test('single and multiple image posts choose the largest supplied images and keep source order', () => {
  const single = parseYouTubeCommunityHtml(html({ ...renderer(), backstageAttachment: { backstageImageRenderer: imageRenderer() } }), url());
  assert.deepEqual(single?.images, [image()]);
  const multi = parseYouTubeCommunityHtml(html({ ...renderer(), backstageAttachment: { postMultiImageRenderer: {
    images: [{ backstageImageRenderer: imageRenderer('Second') }, { backstageImageRenderer: imageRenderer('First') }],
  } } }), url());
  assert.deepEqual(multi?.images, [image('Second'), image('First')]);
  const embeds = formatYouTubeCommunityPost(multi!);
  assert.deepEqual(embeds.map(embed => embed.image?.url), [image('Second'), image('First')]);
  assert(embeds.every(embed => embed.url === url()));
  assert(embeds.every(embed => !embed.thumbnail && !embed.fields));
  assert.equal(embeds[0].author?.name, 'Creator');
  assert.equal(embeds[0].description, 'Post text');
});

test('image-only posts work without fabricated captions or statistics', () => {
  const post = parseYouTubeCommunityHtml(html({ ...renderer(), contentText: undefined,
    voteCount: { simpleText: '1M' }, backstageAttachment: { backstageImageRenderer: imageRenderer() } }), url());
  assert(post);
  const card = formatYouTubeCommunityPost(post)[0];
  assert.equal(card.description, undefined);
  assert.equal(card.fields, undefined);
  assert.equal(card.image?.url, image());
});

test('private, deleted, unavailable, generic metadata and unknown attachment pages preserve the source', () => {
  for (const flag of ['isPrivate', 'isMembersOnly', 'sponsorsOnlyBadge', 'isDeleted', 'isUnavailable'])
    assert.equal(parseYouTubeCommunityHtml(html({ ...renderer(), [flag]: true }), url()), null, flag);
  for (const kind of ['videoRenderer', 'pollRenderer', 'quizRenderer', 'playlistRenderer'])
    assert.equal(parseYouTubeCommunityHtml(html({ ...renderer(), backstageAttachment: { [kind]: {} } }), url()), null);
  for (const page of ['', '<meta property="og:description" content="Deleted post"><meta property="og:image" content="https://yt3.ggpht.com/logo=s32">',
    '<script>var ytInitialData = {"alerts":[{"alertRenderer":{"type":"ERROR"}}]};</script>',
    '<script>var ytInitialData = {bad};</script>', html({ ...renderer(), contentText: {} }),
    html({ ...renderer(), contentText: { simpleText: '' } })]) assert.equal(parseYouTubeCommunityHtml(page, url()), null);
});

test('HTML parser treats escaped braces and quotes as text and bounds data depth/size', () => {
  const text = 'Literal } { "backstagePostRenderer": and <script> text';
  assert.equal(parseYouTubeCommunityHtml(html({ ...renderer(), contentText: { simpleText: text } }), url())?.text, text);
  assert.equal(parseYouTubeCommunityHtml('x'.repeat(2 * 1024 * 1024 + 1), url()), null);
  let nested: unknown = { backstagePostRenderer: renderer() };
  for (let i = 0; i < 110; i++) nested = { nested };
  assert.equal(parseYouTubeCommunityHtml(`<script>var ytInitialData = ${JSON.stringify(nested)};</script>`, url()), null);
  assert.equal(parseYouTubeCommunityHtml(`<script>var ytInitialData = ${JSON.stringify({ contents: [
    { backstagePostRenderer: renderer() }, { backstagePostRenderer: renderer() },
  ] })};</script>`, url()), null);
});

test('media validation rejects hostile URLs, dimensions, incomplete galleries and excessive media', () => {
  for (const bad of ['https://127.0.0.1/a', 'http://yt3.ggpht.com/a', 'https://yt3.ggpht.com.evil.test/a',
    'https://user@yt3.ggpht.com/a', 'https://yt3.ggpht.com:443/a', 'https://yt3.ggpht.com/../a',
    'https://yt3.ggpht.com/a?redirect=https://evil.test', 'https://yt3.ggpht.com/a#fragment', 'https://yt3.ggpht.com/a%2fb']) {
    assert.equal(parseYouTubeCommunityHtml(html({ ...renderer(), backstageAttachment: { backstageImageRenderer: {
      image: { thumbnails: [{ url: bad, width: 100, height: 100 }] },
    } } }), url()), null, bad);
  }
  for (const entries of [[], Array.from({ length: 11 }, (_, n) => ({ backstageImageRenderer: imageRenderer(String(n)) })),
    [{ backstageImageRenderer: imageRenderer() }, {}], [{ backstageImageRenderer: imageRenderer() }, { backstageImageRenderer: imageRenderer() }]])
    assert.equal(parseYouTubeCommunityHtml(html({ ...renderer(), backstageAttachment: { postMultiImageRenderer: { images: entries } } }), url()), null);
  assert.equal(parseYouTubeCommunityHtml(html({ ...renderer(), backstageAttachment: { backstageImageRenderer: {
    image: { thumbnails: [{ url: image(), width: 20000, height: 2 }] },
  } } }), url()), null);
});

test('presentation escapes Discord markup, bounds text and suppresses mentions and untrusted links', () => {
  const post = parseYouTubeCommunityHtml(html(), url())!;
  post.author.name = '@everyone **Creator**';
  post.text = '> header\n-# heading <@123> ||spoiler|| [link](https://evil.test) discord.gg/invite\n' + '*'.repeat(5000);
  const card = formatYouTubeCommunityPost(post)[0];
  assert(!card.author?.name.includes('@everyone'));
  assert(!card.description?.includes('<@123>'));
  assert(!card.description?.includes('https://evil.test'));
  assert(!card.description?.includes('discord.gg/'));
  assert(card.description!.length <= 3500);
  assert(card.description!.startsWith('\\> header\n\\-\\#'));
  assert.equal(formatYouTubeCommunityPost({ ...post, url: 'https://evil.test' }).length, 0);
  assert.equal(formatYouTubeCommunityPost({ ...post, images: ['https://127.0.0.1/x'] }).length, 0);
});

test('transport pins public DNS, requests only canonical public HTML without cookies and coalesces lookups', async () => {
  let calls = 0;
  const lookup = createYouTubeCommunityLookup({ dns, connect: async (options, signal) => {
    calls++;
    assert.equal(options.hostname, 'www.youtube.com'); assert.equal(options.servername, 'www.youtube.com');
    assert.equal(options.path, `/post/${ID}`); assert.equal(options.port, 443); assert.equal(options.method, 'GET');
    assert.equal(options.agent, false); assert.equal(options.rejectUnauthorized, true);
    assert(signal instanceof AbortSignal); assert.equal(typeof options.lookup, 'function');
    assert.deepEqual(options.headers, { accept: 'text/html', 'accept-encoding': 'identity', 'accept-language': 'en-US,en;q=0.9',
      'user-agent': 'Mozilla/5.0 (compatible; Linky/1.0)' });
    return response();
  } });
  const [one, two] = await Promise.all([lookup(url()), lookup({ id: ID, url: url() })]);
  assert(one && two); assert.equal(calls, 1);
  one.author.name = 'mutation'; one.images.push(image());
  assert.equal(two.author.name, 'Creator'); assert.deepEqual((await lookup(url()))?.images, []);
  assert.equal(calls, 1);
});

test('unsafe DNS and invalid requests never reach the transport', async () => {
  for (const addresses of [[], ['127.0.0.1'], ['10.0.0.1'], ['169.254.169.254'], ['::1'], ['142.250.80.46', '192.168.1.1']]) {
    const lookup = createYouTubeCommunityLookup({ dns: async () => addresses, connect: async () => assert.fail('unsafe DNS') });
    assert.equal(await lookup(url()), null);
  }
  const lookup = createYouTubeCommunityLookup({ dns: async () => assert.fail('invalid request reached DNS') });
  assert.equal(await lookup('https://evil.test'), null);
  assert.equal(await lookup({ id: OTHER, url: url() }), null);
});

test('redirects, failures, compression and non-HTML responses do not create community cards', async () => {
  const cases: ResponseInit[] = [
    { status: 302, headers: { location: 'https://www.youtube.com/post/' + OTHER } },
    { status: 302, headers: { location: 'https://127.0.0.1/' } },
    { status: 403 }, { status: 404 }, { status: 429 }, { status: 500 },
    { status: 200, headers: { 'content-type': 'application/json' } },
    { status: 200, headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' } },
  ];
  for (const options of cases) {
    let calls = 0;
    const lookup = createYouTubeCommunityLookup({ dns, connect: async () => { calls++; return new Response(html(), options); } });
    assert.equal(await lookup(url()), null); assert.equal(calls, 1);
  }
});

test('announced and streamed oversized bodies stop before parsing', async () => {
  for (const announced of [true, false]) {
    let cancelled = false;
    const lookup = createYouTubeCommunityLookup({ dns, connect: async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'text/html', ...(announced ? { 'content-length': String(2 * 1024 * 1024 + 1) } : {}) } }) });
    assert.equal(await lookup(url()), null); assert(cancelled);
  }
});

test('DNS, transport and body stalls are bounded even when injected operations ignore abort', async () => {
  const stalled = () => new Promise<never>(() => undefined);
  for (const dependencies of [{ dns: stalled }, { dns, connect: stalled },
    { dns, connect: async () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/html' } }) }]) {
    const lookup = createYouTubeCommunityLookup({ ...dependencies, timeoutMs: 5 });
    assert.equal(await lookup(url()), null);
  }
});

test('cache expiry allows changed/unavailable posts to be rechecked and request volume is limited', async () => {
  let time = 0, calls = 0;
  const lookup = createYouTubeCommunityLookup({ dns, now: () => time, connect: async () => {
    calls++; return calls === 1 ? response() : response('<html>Unavailable</html>');
  } });
  assert(await lookup(url())); time = 59_999; assert(await lookup(url())); assert.equal(calls, 1);
  time = 60_000; assert.equal(await lookup(url()), null); assert.equal(calls, 2);
  time = 75_000; assert.equal(await lookup(url()), null); assert.equal(calls, 3);
  for (let i = 0; i < 35; i++) await lookup(url('Ug' + 'a'.repeat(20) + i));
  assert.equal(calls, 31, 'thirty requests in the second minute');
});

test('at most four distinct community lookups can be active at once', async () => {
  const lookups: Promise<unknown>[] = [];
  let requests = 0;
  const lookup = createYouTubeCommunityLookup({ dns, timeoutMs: 10, connect: async () => {
    requests++; return new Promise<Response>(() => undefined);
  } });
  for (let i = 0; i < 4; i++) lookups.push(lookup(url('Ug' + 'a'.repeat(20) + i)));
  assert.equal(await lookup(url(OTHER)), null);
  await Promise.all(lookups); assert.equal(requests, 4);
});

test('source cancellation returns promptly without aborting another active subscriber', async () => {
  let release!: (value: Response) => void, entered!: () => void, sharedSignal!: AbortSignal;
  const connected = new Promise<void>(resolve => { entered = resolve; });
  const lookup = createYouTubeCommunityLookup({ dns, connect: async (_options, signal) => {
    sharedSignal = signal; entered(); return new Promise<Response>(resolve => { release = resolve; });
  } });
  const first = new AbortController(), second = new AbortController();
  const one = lookup(url(), first.signal), two = lookup(url(), second.signal);
  await connected; first.abort();
  assert.equal(await one, null); assert.equal(sharedSignal.aborted, false);
  release(response()); assert(await two);
  const preAborted = new AbortController(); preAborted.abort();
  assert.equal(await lookup(url(), preAborted.signal), null, 'even cached content is hidden after source cancellation');
});

test('last cancelled subscriber aborts transport and cancelled results never populate the cache', async () => {
  let release!: (value: Response) => void, entered!: () => void, sharedSignal!: AbortSignal, calls = 0;
  const connected = new Promise<void>(resolve => { entered = resolve; });
  const lookup = createYouTubeCommunityLookup({ dns, connect: async (_options, signal) => {
    calls++; sharedSignal = signal;
    if (calls > 1) return response();
    entered(); return new Promise<Response>(resolve => { release = resolve; });
  } });
  const source = new AbortController(), operation = lookup(url(), source.signal);
  await connected; source.abort();
  assert.equal(await operation, null); assert(sharedSignal.aborted);
  let disposed = false;
  release(new Response(new ReadableStream({ cancel() { disposed = true; } }), { headers: { 'content-type': 'text/html' } }));
  await new Promise(resolve => setImmediate(resolve));
  assert(disposed); assert(await lookup(url())); assert.equal(calls, 2);
});

test('an already cancelled source does not start DNS or a request', async () => {
  const source = new AbortController(); source.abort();
  const lookup = createYouTubeCommunityLookup({ dns: async () => assert.fail('cancelled source reached DNS') });
  assert.equal(await lookup(url(), source.signal), null);
});

test('preparation is all-or-nothing with five-source and aggregate embed/text budgets', async () => {
  const links = findYouTubeCommunityLinks(Array.from({ length: 6 }, (_, n) => url('Ug' + 'a'.repeat(20) + n)).join(' '), 6);
  assert.equal(links.length, 6);
  assert.equal(await prepareYouTubeCommunityPosts(links, async () => assert.fail('excess sources requested')), null);
  assert.equal(await prepareYouTubeCommunityPosts(links.slice(0, 1), undefined), null);
  let calls = 0;
  const prepared = await prepareYouTubeCommunityPosts(links.slice(0, 2), async link => {
    calls++; const source = typeof link === 'string' ? parseYouTubeCommunityUrl(link)! : link;
    return calls === 2 ? null : { ...source, author: { name: 'Creator', url: `https://www.youtube.com/channel/${CHANNEL}` }, text: 'Public post', images: [] };
  });
  assert.equal(prepared, null); assert.equal(calls, 2);
  const ten = Array.from({ length: 10 }, () => ({ url: url(), image: { url: image() } }));
  assert(communityEmbedBudget(ten)); assert(!communityEmbedBudget(ten, 1));
  assert(!communityEmbedBudget([{ description: 'x'.repeat(3500) }, { description: 'x'.repeat(3000) }]));
});
