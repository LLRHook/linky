import assert from 'node:assert/strict';
import test from 'node:test';
import type { RequestOptions } from 'node:https';
import { createArticleLookup, findArticleLinks, type ArticleLookupOptions } from '../src/services/ArticlePreview';
import { articleAttachments, fitArticleFiles, isArticleVideo, prepareArticlePosts, withoutArticleFiles } from '../src/services/ArticlePosts';
import { formatLinkedInPost, isLinkedInPostUrl, linkedInPermalink, parseLinkedInPost } from '../src/services/LinkedIn';
import { expectedPreviews, inspectPreviews } from '../src/services/PreviewRecovery';

// Shapes observed on signed-out LinkedIn post pages (November 2026), trimmed to the fields Linky reads.
const activity = '7500720890129756160';
const permalink = `https://www.linkedin.com/posts/rtx_turn-bold-engineering-ideas-into-real-world-activity-${activity}-lOHY`;
const shared = 'https://www.linkedin.com/posts/turn-bold-engineering-ideas-into-real-world-ugcPost-7500720889349464064-tWFx/';
const short = 'https://lnkd.in/p/eMizdACP';
const signed = (host: string, path: string) => `https://${host}/${path}?e=2147483647&v=beta&t=76k7toleEmMEweImIAQh26xjwzdppqZyX8kWMrWX4_w`;
const mp4 = signed('dms.licdn.com', 'playlist/vid/v2/D4E10AQGwmDk6ncG1cg/mp4-640p-30fp-crf28/B4EaBfptUzG4BI-/0/1788311170094');
const poster = signed('media.licdn.com', 'dms/image/v2/D4E10AQGwmDk6ncG1cg/videocover-high/B4EaBfptUzG4Ao-/0/1788311167342');
const logo = signed('media.licdn.com', 'dms/image/v2/D560BAQFITBtnCzFO9w/company-logo_100_100/company-logo_100_100/0/1687169432565/raytheontechnologies_logo');
const photo = (n: number) => signed('media.licdn.com', `dms/image/v2/D5610AQGO147Fwyf${n}/image-shrink_800/B56aGyP7oEJEAk-/0/1793991884406`);
const counters = [{ '@type': 'InteractionCounter', interactionType: 'http://schema.org/LikeAction', userInteractionCount: 1640 },
  { '@type': 'InteractionCounter', interactionType: 'https://schema.org/CommentAction', userInteractionCount: 12 }];
const videoObject = (overrides: Record<string, unknown> = {}) => ({
  '@context': 'http://schema.org', '@type': 'VideoObject', '@id': permalink, datePublished: '2026-09-02T01:06:56.860Z',
  headline: 'Ready to build what’s next?', text: 'Turn bold engineering ideas into real world impact. ',
  description: 'Ready to build what’s next? Push aerospace and defense forward at Raytheon. @everyone https://example.com',
  contentUrl: mp4, thumbnailUrl: poster, duration: 'PT29S', interactionStatistic: counters,
  creator: { '@type': 'Organization', name: 'RTX', url: 'https://www.linkedin.com/company/rtx', image: { '@type': 'ImageObject', url: logo } },
  ...overrides,
});
const posting = (overrides: Record<string, unknown> = {}) => ({
  '@context': 'http://schema.org', '@type': 'SocialMediaPosting', '@id': permalink, datePublished: '2026-11-06T20:00:01.701Z',
  headline: 'For more than 30 years, we partnered with the USO.', articleBody: 'For more than 30 years, we partnered with the USO.\n\nTogether.',
  image: [1, 2, 3].map(n => ({ '@type': 'ImageObject', url: photo(n) })), commentCount: 3, interactionStatistic: counters,
  author: { '@type': 'Organization', name: 'RTX', url: 'https://www.linkedin.com/company/rtx/', image: { url: logo } },
  ...overrides,
});
const page = (ld: unknown, ogUrl = permalink) => new Response(`<!DOCTYPE html><html><head>
  <meta property="og:type" content="article"><meta property="og:url" content="${ogUrl}">
  <meta property="og:title" content="Turn bold engineering ideas into real world impact. | RTX">
  <meta property="og:image" content="https://static.licdn.com/aero-v1/sc/h/c45fy346jw096z9pbphyyhdz7">
  <script type="application/ld+json">${JSON.stringify(ld)}</script></head><body><video data-sources="ignored"></video></body></html>`,
{ headers: { 'content-type': 'text/html; charset=utf-8' } });
const movie = (bytes = 64, type = 'video/mp4') => {
  const data = new Uint8Array(bytes).fill(1);
  data.set(new TextEncoder().encode('ftypisom'), 4);
  return new Response(data, { headers: { 'content-type': type } });
};
const redirect = (location: string) => new Response(null, { status: 301, headers: { location } });
const fixture = (respond: (settings: RequestOptions, signal: AbortSignal) => Response | Promise<Response>, extra: ArticleLookupOptions = {}) => {
  const calls: RequestOptions[] = [];
  const lookup = createArticleLookup({ resolve4: async () => ['1.1.1.1'], ...extra,
    connect: async (settings, signal) => { calls.push(settings); return respond(settings, signal); } });
  return { lookup, calls };
};
const site = (ld: unknown, video: () => Response | Promise<Response> = () => movie()) => (settings: RequestOptions) =>
  settings.hostname === 'lnkd.in' ? redirect(`${shared}?utm_source=share&utm_medium=member_ios&rcm=ACoAACUIVpkB-lZndscunyBboi76Ft_wsymlc48`)
    : settings.hostname === 'dms.licdn.com' ? video() : page(ld);

test('LinkedIn post permalinks are recognized; profiles, articles and lookalikes are not', () => {
  for (const url of [permalink, shared, `${permalink}/?utm_source=share`, `https://linkedin.com/posts/a_b-share-${activity}-AbCd`,
    `https://www.linkedin.com/feed/update/urn:li:activity:${activity}/`]) assert(isLinkedInPostUrl(url), url);
  for (const url of ['https://www.linkedin.com/company/rtx', 'https://www.linkedin.com/pulse/some-article-author',
    `http://www.linkedin.com/posts/a-activity-${activity}-lOHY`, `https://www.linkedin.com:443/posts/a-activity-${activity}-lOHY`,
    `https://uk.linkedin.com/posts/a-activity-${activity}-lOHY`, `https://www.linkedin.com.evil.com/posts/a-activity-${activity}-lOHY`,
    `https://www.linkedin.com/posts/a-activity-${activity}-lOHY/comments`]) assert(!isLinkedInPostUrl(url), url);
  assert.equal(linkedInPermalink(`https://linkedin.com/posts/rtx_turn-bold-engineering-ideas-into-real-world-activity-${activity}-lOHY/?rcm=x`), permalink);
  assert.equal(linkedInPermalink(`https://www.linkedin.com/feed/update/urn:li:activity:${activity}/`), null);
  assert.deepEqual(findArticleLinks(`look ${short}`), [short]);
});

test('a video post becomes an inert card with its title, text, author, counts and time', () => {
  const post = parseLinkedInPost([videoObject()], permalink)!;
  assert.equal(post.video, mp4);
  assert.equal(post.image, poster);
  const [card, ...rest] = formatLinkedInPost(post);
  assert.equal(rest.length, 0);
  assert.equal(card.url, permalink);
  assert.equal(card.title, 'Turn bold engineering ideas into real world impact.');
  assert.deepEqual(card.author, { name: 'RTX', url: 'https://www.linkedin.com/company/rtx', icon_url: logo });
  assert.equal(card.description, `Ready to build what’s next? Push aerospace and defense forward at Raytheon. @​everyone \\[link\\]\n\n**[▶ Play video](${mp4})**`);
  assert.deepEqual(card.image, { url: poster });
  assert.equal(card.footer?.text, 'LinkedIn · 1.6K reactions · 12 comments');
  assert.equal(card.timestamp, '2026-09-02T01:06:56.860Z');
  // Without its own title a video is labelled as one.
  assert.equal(formatLinkedInPost(parseLinkedInPost([videoObject({ text: undefined })], permalink)!)[0].title, 'LinkedIn video');
});

test('image and text posts show the first image, the image count and a shared link title', () => {
  const [card] = formatLinkedInPost(parseLinkedInPost([posting({ text: 'A production boost, powered by hard data' })], permalink)!);
  assert.equal(card.title, 'LinkedIn post');
  assert.deepEqual(card.image, { url: photo(1) });
  assert.equal(card.author?.url, 'https://www.linkedin.com/company/rtx');
  assert.equal(card.description, 'For more than 30 years, we partnered with the USO.\n\nTogether.\n\n**Link:** A production boost, powered by hard data' +
    '\n\n*3 images: open the post to see all of them.*');
  assert.equal(card.footer?.text, 'LinkedIn · 1.6K reactions · 12 comments');
  const [text] = formatLinkedInPost(parseLinkedInPost([posting({ image: undefined, interactionStatistic: undefined })], permalink)!);
  assert.equal(text.image, undefined);
  assert.equal(text.footer?.text, 'LinkedIn');
});

test('JSON-LD for another post, foreign media hosts and unsigned addresses are rejected or stripped', () => {
  const other = `https://www.linkedin.com/posts/rtx_other-activity-7524561250484342784-Po3N`;
  assert.equal(parseLinkedInPost([videoObject({ '@id': other })], permalink), null);
  assert.equal(parseLinkedInPost([videoObject()], other), null);
  assert.equal(parseLinkedInPost([videoObject()], undefined), null);
  assert.equal(parseLinkedInPost([{ ...videoObject(), '@context': 'https://evil.example' }], permalink), null);
  assert.equal(parseLinkedInPost([videoObject({ '@type': 'NewsArticle' })], permalink), null);
  assert.equal(parseLinkedInPost([videoObject({ creator: {} })], permalink), null);
  for (const contentUrl of ['https://evil.example/video.mp4', mp4.replace('dms.licdn.com', 'dms.licdn.com.evil.com'),
    mp4.split('?')[0], mp4.replace('/v2/', '/../'), mp4.replace('https:', 'http:')]) {
    assert.equal(parseLinkedInPost([videoObject({ contentUrl })], permalink), null, contentUrl);
  }
  const stripped = parseLinkedInPost([videoObject({ thumbnailUrl: 'https://evil.example/a.jpg',
    creator: { name: 'RTX', url: 'https://evil.example/company/rtx', image: { url: 'https://evil.example/logo.png' } } })], permalink)!;
  assert.equal(stripped.image, undefined);
  assert.deepEqual(stripped.author, { name: 'RTX' });
  // The formatter refuses posts or uploads that were not produced for this post.
  const post = parseLinkedInPost([videoObject()], permalink)!;
  for (const files of [[{ name: 'evil.mp4', url: mp4, data: new Uint8Array(1) }],
    [{ name: `linkedin-${activity}.mp4`, url: 'https://evil.example/a.mp4', data: new Uint8Array(1) }],
    [{ name: `linkedin-${activity}.mp4`, url: mp4, data: new Uint8Array(0) }]]) {
    assert.deepEqual(formatLinkedInPost({ ...post, files }), []);
  }
  assert.deepEqual(formatLinkedInPost({ ...post, image: 'https://evil.example/a.jpg' }), []);
});

test('a shared lnkd.in link resolves without tracking, uploads the MP4 and prepares a confirmable card', async () => {
  const f = fixture(site(videoObject()));
  const prepared = await prepareArticlePosts([short], f.lookup);
  assert.deepEqual(f.calls.map(call => `${call.hostname}${call.path}`), ['lnkd.in/p/eMizdACP',
    `www.linkedin.com${new URL(shared).pathname}`, `dms.licdn.com${new URL(mp4).pathname}${new URL(mp4).search}`]);
  assert.equal(prepared?.length, 1);
  const [card] = prepared![0].embeds;
  assert.equal(card.url, permalink);
  // Discord plays the uploaded MP4 as the message's attachment; the card does not repeat its poster.
  assert.equal(card.image, undefined);
  assert.doesNotMatch(card.description!, /Play video/);
  const uploads = articleAttachments(prepared!);
  assert.deepEqual(uploads.map(file => file.name), [`linkedin-${activity}.mp4`]);
  assert(isArticleVideo(uploads[0].name));
  assert(!isArticleVideo(`truth-${activity}.jpg`));
  const expected = expectedPreviews(short, `<${short}>`, [], prepared!);
  assert.equal(expected.length, 1);
  assert.equal(inspectPreviews([card], expected).ok, true);
  assert.equal(inspectPreviews([{ ...card, description: 'changed' }], expected).ok, false);
  // Without Attach Files, or past the upload budget, the card shows the poster and links the MP4.
  for (const fitted of [fitArticleFiles(prepared!, false), withoutArticleFiles(prepared!)]) {
    assert.equal(articleAttachments(fitted).length, 0);
    assert.deepEqual(fitted[0].embeds[0].image, { url: poster });
    assert.match(fitted[0].embeds[0].description!, /\*\*\[▶ Play video\]\(https:\/\/dms\.licdn\.com\//);
    assert.equal(inspectPreviews(fitted[0].embeds, expectedPreviews(short, `<${short}>`, [], fitted)).ok, true);
  }
  assert.deepEqual(fitArticleFiles(prepared!, true), prepared);
  // Repeated lookups reuse the cached download.
  await f.lookup(short);
  assert.equal(f.calls.length, 3);
});

test('videos that fail, are too large, are not MP4 or arrive too late are linked instead of uploaded', async () => {
  const big = () => { const response = movie(); response.headers.set('content-length', String(16 * 1024 * 1024)); return response; };
  const responses = [() => movie(64, 'text/html'), () => new Response(new Uint8Array(64), { headers: { 'content-type': 'video/mp4' } }),
    big, () => new Response(null, { status: 403 }), () => { throw new Error('reset'); }];
  for (const respond of responses) {
    const [post] = (await prepareArticlePosts([short], fixture(site(videoObject(), respond)).lookup))!;
    assert.equal(post.files, undefined);
    assert.deepEqual(post.embeds[0].image, { url: poster });
    assert.match(post.embeds[0].description!, /Play video/);
  }
  // The video has its own window after the page; a stalled download is abandoned without losing the card.
  const stalled = fixture((settings, signal) => settings.hostname === 'dms.licdn.com'
    ? new Promise<Response>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    : site(videoObject())(settings), { videoTimeoutMs: 400 });
  const [late] = (await prepareArticlePosts([short], stalled.lookup))!;
  assert.equal(late.files, undefined);
  assert.deepEqual(late.embeds[0].image, { url: poster });
});

test('image posts need no upload; pages without matching post JSON-LD keep the generic article card', async () => {
  const images = fixture(site(posting()));
  const [post] = (await prepareArticlePosts([permalink], images.lookup))!;
  assert.equal(post.files, undefined);
  assert.deepEqual(post.embeds[0].image, { url: photo(1) });
  assert.equal(images.calls.length, 1);
  // Without the post's own JSON-LD this is an ordinary article page, as before.
  const generic = fixture(() => page({ '@context': 'http://schema.org', '@type': 'Organization', '@id': permalink }));
  const [card] = (await prepareArticlePosts([permalink], generic.lookup))![0].embeds;
  assert.equal(card.footer?.text, 'www.linkedin.com · Article metadata');
});
