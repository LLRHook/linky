import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blueskyText, createBlueskyLookup, fetchBlueskyPost, parseBlueskyThread } from '../src/services/BlueskyPost';

// Synthetic AppView payloads in the documented app.bsky.feed.getPostThread shape; no network is used.
const DID = 'did:plc:abcdefghijklmnopqrstuvwx', QUOTE_DID = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const HANDLE = 'linky-test.bsky.social', RKEY = '3n2m24be4e223', QUOTE_RKEY = '3mquotedpost2';
const image = (did: string, index: number) => `https://cdn.bsky.app/img/feed_fullsize/plain/${did}/bafkreiimage${index}@jpeg`;

const author = (did = DID, handle = HANDLE, extra: Record<string, unknown> = {}) => ({
  did, handle, displayName: 'Linky Test', avatar: `https://cdn.bsky.app/img/avatar/plain/${did}/bafkreiavatar@jpeg`, labels: [], ...extra,
});
const imagesView = (did = DID, count = 1, type = 'app.bsky.embed.images#view') => ({
  $type: type, [type.includes('gallery') ? 'items' : 'images']: Array.from({ length: count }, (_, index) => ({
    ...(type.includes('gallery') ? { $type: 'app.bsky.embed.gallery#viewImage', thumbnail: 'unused' } : { thumb: 'unused' }),
    fullsize: image(did, index), alt: index ? '' : 'A test photo', aspectRatio: { width: 1, height: 1 },
  })),
});
const quoteView = (extra: Record<string, unknown> = {}, embeds?: unknown[]) => ({
  $type: 'app.bsky.embed.record#viewRecord', uri: `at://${QUOTE_DID}/app.bsky.feed.post/${QUOTE_RKEY}`, cid: 'bafyreiquote',
  author: author(QUOTE_DID, 'quoted.bsky.social', { displayName: 'Quoted' }),
  value: { $type: 'app.bsky.feed.post', text: 'The quoted words', createdAt: '2026-11-01T00:00:00Z',
    ...(embeds ? { embed: { $type: 'app.bsky.embed.images' } } : {}) },
  labels: [], ...(embeds ? { embeds } : {}), ...extra,
});
function thread(post: Record<string, unknown> = {}, words: Record<string, unknown> = {}) {
  return { thread: { $type: 'app.bsky.feed.defs#threadViewPost', post: {
    uri: `at://${DID}/app.bsky.feed.post/${RKEY}`, cid: 'bafyreipost', author: author(),
    record: { $type: 'app.bsky.feed.post', text: 'Hello from Bluesky', createdAt: '2026-11-01T00:00:00Z',
      embed: { $type: 'app.bsky.embed.images' }, ...words },
    embed: imagesView(), labels: [], indexedAt: '2026-11-01T00:00:00Z', ...post,
  } } };
}
const jsonFetch = (value: unknown, init?: ResponseInit) => async () => new Response(JSON.stringify(value), init);
/** The thread of whichever post a request names. */
const threadFor = (url: unknown) => {
  const rkey = decodeURIComponent(/uri=([^&]+)/.exec(String(url))![1]).split('/').at(-1)!;
  const value = thread({ uri: `at://${DID}/app.bsky.feed.post/${rkey}` });
  return new Response(JSON.stringify(value));
};
const parse = (value: unknown, actor = HANDLE, rkey = RKEY) => parseBlueskyThread(value, actor, rkey);

test('a post lookup sends only the post identity to the public AppView, bounded and without credentials', async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const post = await fetchBlueskyPost(`${HANDLE}/${RKEY}`, async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify(thread()));
  });
  assert.deepEqual(requests.map(request => request.url), [
    `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(`at://${HANDLE}/app.bsky.feed.post/${RKEY}`)}&depth=0&parentHeight=0`,
  ]);
  const init = requests[0].init!;
  assert.equal(init.redirect, 'error');
  assert.equal(init.credentials, 'omit');
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(Object.keys(init.headers as Record<string, string>).sort(), ['Accept', 'User-Agent'], 'no cookies or authorization');
  assert.deepEqual(post, {
    url: `https://bsky.app/profile/${HANDLE}/post/${RKEY}`,
    author: { did: DID, handle: HANDLE, name: 'Linky Test', avatar: `https://cdn.bsky.app/img/avatar/plain/${DID}/bafkreiavatar@jpeg` },
    text: 'Hello from Bluesky',
    images: [{ type: 'photo', url: image(DID, 0), alt: 'A test photo' }],
  });
  for (const postId of ['', RKEY, `${HANDLE}/`, `/${RKEY}`, `${HANDLE}/..`, `Upper.bsky.social/${RKEY}`, `did:plc:short/${RKEY}`, `${HANDLE}/a/b`]) {
    assert.equal(await fetchBlueskyPost(postId, async () => assert.fail(`must not fetch ${postId}`)), null);
  }
});

test('the response must be the requested post by its record key and author handle or DID', () => {
  assert.equal(parse(thread(), DID)?.author.handle, HANDLE, 'a DID link matches the author DID');
  assert.equal(parse(thread(), HANDLE)?.author.did, DID, 'a handle link matches the author handle');
  assert.equal(parse(thread({ author: author(DID, 'Linky-Test.BSKY.social') }))?.author.handle, HANDLE, 'handles compare lowercased');
  const rejected: [string, unknown, string?][] = [
    ['another record key', thread(), 'otherrecord'],
    ['another author handle', thread({ author: author(DID, 'someone.else.social') })],
    ['a URI owned by another DID', thread({ uri: `at://${QUOTE_DID}/app.bsky.feed.post/${RKEY}` })],
    ['another collection', thread({ uri: `at://${DID}/app.bsky.feed.like/${RKEY}` })],
    ['an invalid handle', thread({ author: author(DID, 'handle.invalid') })],
    ['a missing DID', thread({ author: author('', HANDLE) })],
    ['a not-found post', { thread: { $type: 'app.bsky.feed.defs#notFoundPost', uri: `at://${DID}/app.bsky.feed.post/${RKEY}`, notFound: true } }],
    ['a blocked post', { thread: { $type: 'app.bsky.feed.defs#blockedPost', uri: `at://${DID}/app.bsky.feed.post/${RKEY}`, blocked: true } }],
    ['a non-post record', thread({}, { $type: 'app.bsky.feed.like' })],
    ['text over 3000 characters', thread({}, { text: 'a'.repeat(3001) })],
  ];
  assert.equal(parse(thread(), 'did:plc:cccccccccccccccccccccccc'), null, 'a link naming another DID');
  for (const [name, value, rkey] of rejected) assert.equal(parse(value, HANDLE, rkey), null, name);
});

test('any label on the post, its record, its author, the quote or the quote author abstains', () => {
  const label = [{ src: DID, uri: `at://${DID}/app.bsky.feed.post/${RKEY}`, val: 'porn', cts: '2026-11-01T00:00:00Z' }];
  const quoteRecord = { $type: 'app.bsky.embed.record#view', record: quoteView() };
  assert.ok(parse(thread({ embed: quoteRecord }, { embed: { $type: 'app.bsky.embed.record' } }))?.quote, 'an unlabelled quote is kept');
  for (const [name, value] of [
    ['post label', thread({ labels: label })],
    ['record self-label', thread({}, { labels: { $type: 'com.atproto.label.defs#selfLabels', values: [{ val: 'nudity' }] } })],
    ['author label', thread({ author: author(DID, HANDLE, { labels: [{ val: '!no-unauthenticated' }] }) })],
    ['malformed labels', thread({ labels: {} })],
    ['quote label', thread({ embed: { ...quoteRecord, record: quoteView({ labels: label }) } }, { embed: { $type: 'app.bsky.embed.record' } })],
    ['quote author label', thread({ embed: { ...quoteRecord, record: quoteView({ author: author(QUOTE_DID, 'quoted.bsky.social', { labels: label }) }) } },
      { embed: { $type: 'app.bsky.embed.record' } })],
  ] as const) assert.equal(parse(value), null, name);
});

test('images, galleries, quotes and images with a quote are read; video, link cards and nested quotes abstain', () => {
  const gallery = parse(thread({ embed: imagesView(DID, 10, 'app.bsky.embed.gallery#view') }));
  assert.equal(gallery?.images.length, 10, 'a gallery view keeps every item');
  assert.deepEqual(gallery?.images[1], { type: 'photo', url: image(DID, 1), alt: '' });
  const withQuote = parse(thread({ embed: { $type: 'app.bsky.embed.recordWithMedia#view', media: imagesView(DID, 2),
    record: { record: quoteView() } } }, { embed: { $type: 'app.bsky.embed.recordWithMedia' } }));
  assert.equal(withQuote?.images.length, 2);
  assert.deepEqual(withQuote?.quote, { url: `https://bsky.app/profile/quoted.bsky.social/post/${QUOTE_RKEY}`,
    author: { did: QUOTE_DID, handle: 'quoted.bsky.social', name: 'Quoted', avatar: `https://cdn.bsky.app/img/avatar/plain/${QUOTE_DID}/bafkreiavatar@jpeg` },
    text: 'The quoted words', images: [] });
  const quotedImages = parse(thread({ embed: { $type: 'app.bsky.embed.record#view', record: quoteView({}, [imagesView(QUOTE_DID, 3)]) } },
    { embed: { $type: 'app.bsky.embed.record' } }));
  assert.deepEqual(quotedImages?.images, [], 'the outer post has no images of its own');
  assert.equal(quotedImages?.quote?.images.length, 3, 'the quoted post keeps its own images');
  const textOnly = parse(thread({ embed: undefined }, { embed: undefined }));
  assert.deepEqual(textOnly?.images, [], 'a text-only post is read, and has nothing to show as a block');
  const video = { $type: 'app.bsky.embed.video#view', cid: 'bafkreivideo', playlist: `https://video.bsky.app/watch/${DID}/bafkreivideo/playlist.m3u8` };
  for (const [name, value] of [
    ['video', thread({ embed: video }, { embed: { $type: 'app.bsky.embed.video' } })],
    ['link card', thread({ embed: { $type: 'app.bsky.embed.external#view', external: { uri: 'https://example.com', title: 'x', description: '' } } })],
    ['video with a quote', thread({ embed: { $type: 'app.bsky.embed.recordWithMedia#view', media: video, record: { record: quoteView() } } })],
    ['a quote of a quote', thread({ embed: { $type: 'app.bsky.embed.record#view',
      record: quoteView({}, [{ $type: 'app.bsky.embed.record#view', record: quoteView() }]) } })],
    ['a quote with a video', thread({ embed: { $type: 'app.bsky.embed.record#view', record: quoteView({}, [video]) } })],
    ['a missing quote', thread({ embed: { $type: 'app.bsky.embed.record#view', record: { $type: 'app.bsky.embed.record#viewNotFound', uri: 'at://x', notFound: true } } })],
    ['a quoted feed', thread({ embed: { $type: 'app.bsky.embed.record#view', record: { $type: 'app.bsky.feed.defs#generatorView' } } })],
    ['a quote whose record attaches media its view omits', thread({ embed: { $type: 'app.bsky.embed.record#view',
      record: { ...quoteView(), value: { $type: 'app.bsky.feed.post', text: 'q', embed: { $type: 'app.bsky.embed.video' } } } } })],
    ['a record embed without a view', thread({ embed: undefined })],
    ['a view without a record embed', thread({}, { embed: undefined })],
    ['an unknown embed', thread({ embed: { $type: 'app.bsky.embed.future#view' } })],
    ['more than 20 images', thread({ embed: imagesView(DID, 21, 'app.bsky.embed.gallery#view') })],
    ['an empty image list', thread({ embed: { $type: 'app.bsky.embed.images#view', images: [] } })],
  ] as const) assert.equal(parse(value), null, name);
});

test('images must be full-size files on Bluesky\'s CDN under the author\'s own DID', () => {
  const withImage = (fullsize: unknown) => thread({ embed: { $type: 'app.bsky.embed.images#view', images: [{ fullsize, alt: '' }] } });
  assert.ok(parse(withImage(image(DID, 0))));
  for (const fullsize of [
    image(QUOTE_DID, 0), `https://cdn.bsky.app/img/feed_thumbnail/plain/${DID}/x@jpeg`, `http://cdn.bsky.app/img/feed_fullsize/plain/${DID}/x@jpeg`,
    `https://cdn.bsky.app:8443/img/feed_fullsize/plain/${DID}/x@jpeg`, `https://user@cdn.bsky.app/img/feed_fullsize/plain/${DID}/x@jpeg`,
    `https://cdn.bsky.app.example/img/feed_fullsize/plain/${DID}/x@jpeg`, `https://video.bsky.app/img/feed_fullsize/plain/${DID}/x@jpeg`,
    'not a url', 7, undefined,
  ]) assert.equal(parse(withImage(fullsize)), null, String(fullsize));
  const offHostAvatar = parse(thread({ author: author(DID, HANDLE, { avatar: 'https://example.com/avatar.jpg' }) }));
  assert.equal(offHostAvatar?.author.avatar, undefined, 'an off-CDN avatar is dropped, the post kept');
  assert.equal(parse(thread({ embed: { $type: 'app.bsky.embed.images#view', images: [{ fullsize: image(DID, 0), alt: 'a'.repeat(2000) }] } }))
    ?.images[0].alt.length, 1024, 'alt text fits a gallery description');
});

test('link facets become masked links by UTF-8 byte offset; malformed facets leave the text as written', () => {
  const link = (byteStart: unknown, byteEnd: unknown, uri: unknown = 'https://example.com/a/long/path?q=1') =>
    ({ index: { byteStart, byteEnd }, features: [{ $type: 'app.bsky.richtext.facet#link', uri }] });
  const text = 'é see example.com/a/lo... now';
  const start = Buffer.byteLength('é see '), end = start + Buffer.byteLength('example.com/a/lo...');
  assert.equal(blueskyText(text, [link(start, end)]), 'é see [example.com/a/lo...](<https://example.com/a/long/path?q=1>) now');
  assert.equal(blueskyText('*bold* #tag @someone', []), '\\*bold\\* \\#tag @someone', 'Markdown stays literal');
  assert.equal(blueskyText('go https://example.com/x now', undefined), 'go [example.com/x](<https://example.com/x>) now', 'bare links stay links');
  const plain = 'é see example.com/a/lo... now';
  for (const facets of [
    [link(1, end)], [link(start, end + 100)], [link(end, start)], [link(-1, end)], [link('6', end)],
    [link(start, end, 'http://example.com/')], [link(start, end, 'javascript:alert(1)')], [link(start, end, 'https://u:p@example.com/')],
    [{ index: { byteStart: start, byteEnd: end }, features: [{ $type: 'app.bsky.richtext.facet#mention', did: DID }] }], 'not facets',
  ]) assert.equal(blueskyText(plain, facets), 'é see example.com/a/lo... now', JSON.stringify(facets));
  assert.equal(blueskyText('ab cd', [link(0, 2, 'https://one.example/'), link(1, 5, 'https://two.example/')]),
    '[ab](<https://one.example/>) cd', 'an overlapping facet is ignored');
  assert.equal(blueskyText('[x](y)', [link(0, 6, 'https://e.example/')]), '[\\[x\\](y)](<https://e.example/>)', 'labels cannot close the link');
});

test('a post lookup reads at most 256 KiB and treats an HTTP error or a refused request as no post', async () => {
  const sized = (bytes: number) => {
    const base = JSON.stringify({ ...thread(), padding: '' });
    return async () => new Response(JSON.stringify({ ...thread(), padding: 'x'.repeat(bytes - base.length) }));
  };
  assert.ok(await fetchBlueskyPost(`${HANDLE}/${RKEY}`, sized(256 * 1024)), 'a 256 KiB body is read');
  assert.equal(await fetchBlueskyPost(`${HANDLE}/${RKEY}`, sized(256 * 1024 + 1)), null, 'one byte more keeps the native card');
  assert.equal(await fetchBlueskyPost(`${HANDLE}/${RKEY}`, jsonFetch({ error: 'NotFound', message: 'Post not found' }, { status: 400 })), null);
  assert.equal(await fetchBlueskyPost(`${HANDLE}/${RKEY}`, async () => { throw new TypeError('redirect refused'); }), null);
  assert.equal(await fetchBlueskyPost(`${HANDLE}/${RKEY}`, async () => new Response('not json')), null);
});

test('the post lookup caches five minutes (30 s after a failure), at most 100 posts and eight requests, with copies', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const requests: string[] = [];
  let failing = false;
  const lookup = createBlueskyLookup(async url => {
    requests.push(String(url));
    return failing ? new Response('{}', { status: 502 }) : new Response(JSON.stringify(thread()));
  });
  const [first, second] = await Promise.all([lookup(`${HANDLE}/${RKEY}`), lookup(`${HANDLE}/${RKEY}`)]);
  assert.equal(requests.length, 1, 'concurrent callers share one request');
  first!.text = 'changed by a caller';
  assert.equal(second!.text, 'Hello from Bluesky');
  assert.equal((await lookup(`${HANDLE}/${RKEY}`))!.text, 'Hello from Bluesky', 'each caller gets its own copy');
  t.mock.timers.tick(5 * 60_000 - 1);
  await lookup(`${HANDLE}/${RKEY}`);
  assert.equal(requests.length, 1, 'a post is kept for five minutes');
  t.mock.timers.tick(1);
  await lookup(`${HANDLE}/${RKEY}`);
  assert.equal(requests.length, 2);
  failing = true;
  assert.equal(await lookup(`${HANDLE}/otherrecord`), null);
  t.mock.timers.tick(29_999);
  await lookup(`${HANDLE}/otherrecord`);
  assert.equal(requests.length, 3, 'a failure is kept for 30 s');
  t.mock.timers.tick(1);
  await lookup(`${HANDLE}/otherrecord`);
  assert.equal(requests.length, 4);
  assert.equal(await lookup('not a post id'), null);
  assert.equal(requests.length, 4, 'an invalid identity sends nothing');
});

test('the post lookup keeps at most 100 posts and refuses a ninth concurrent request', async () => {
  const requested: string[] = [];
  const lookup = createBlueskyLookup(async url => { requested.push(String(url)); return threadFor(url); });
  for (let index = 1; index <= 101; index++) assert.ok(await lookup(`${HANDLE}/post${index}`));
  assert.equal(requested.length, 101);
  await lookup(`${HANDLE}/post101`);
  await lookup(`${HANDLE}/post2`);
  assert.equal(requested.length, 101, 'the newest 100 posts stay cached');
  await lookup(`${HANDLE}/post1`);
  assert.equal(requested.length, 102, 'the oldest post was dropped to keep 100');
  const gates: (() => void)[] = [];
  let requests = 0;
  const slow = createBlueskyLookup(async url => {
    requests++;
    await new Promise<void>(resolve => gates.push(resolve));
    return threadFor(url);
  });
  const waiting = Array.from({ length: 8 }, (_, index) => slow(`${HANDLE}/${RKEY}${index}`));
  assert.equal(await slow(`${HANDLE}/ninth`), null);
  assert.equal(requests, 8, 'at most eight lookups are in flight');
  gates.forEach(open => open());
  assert((await Promise.all(waiting)).every(post => post?.text === 'Hello from Bluesky'));
});
