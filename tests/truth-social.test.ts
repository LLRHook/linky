import assert from 'node:assert/strict';
import test from 'node:test';
import type { RequestOptions } from 'node:https';
import { createArticleLookup, findArticleLinks, formatArticlePreview, type ArticleLookupOptions } from '../src/services/ArticlePreview';
import { prepareArticlePosts } from '../src/services/ArticlePosts';
import { expectedPreviews, inspectPreviews } from '../src/services/PreviewRecovery';
import { formatTruthSocialPost, parseTruthArchiveFeed, parseTruthSocialPage, parseTruthSocialRelay, parseTruthSocialStatus,
  parseTruthSocialUrl } from '../src/services/TruthSocial';

const id = '117497314507062631';
const source = `https://truthsocial.com/@realDonaldTrump/${id}`;
const asset = (path: string) => `https://static-assets-1.truthsocial.com/tmtg:prime-ts-assets/${path}`;
const avatar = asset('accounts/avatars/107/780/original/454286ac07a6f6e6.jpeg');
const photo = asset('media_attachments/files/117/497/original/d2c8ca4d0b00e832.jpg');
const account = (acct = 'realDonaldTrump', display_name = 'Donald J. Trump') => ({ acct, display_name, avatar });
const status = (overrides: Record<string, unknown> = {}) => ({
  id, visibility: 'public', sensitive: false, spoiler_text: '', created_at: '2026-10-24T18:32:17.473Z',
  content: '<p>First &amp; <b>bold</b> line<br/>second @here</p><p>See https://example.com/a</p>',
  account: account(), media_attachments: [{ type: 'image', url: photo, preview_url: photo }],
  replies_count: 1825, reblogs_count: 5164, favourites_count: 17684, reblog: null, quote: null, card: null, ...overrides,
});
const link = parseTruthSocialUrl(source)!;
const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
const fixture = (connect: NonNullable<ArticleLookupOptions['connect']>, extra: ArticleLookupOptions = {}) => {
  const calls: RequestOptions[] = [];
  const lookup = createArticleLookup({ resolve4: async () => ['1.1.1.1'], pageRetryMs: 0, ...extra,
    connect: async (settings, signal) => { calls.push(settings); return connect(settings, signal); } });
  return { lookup, calls };
};
const blocked = () => new Response('<!DOCTYPE html><title>Attention Required! | Cloudflare</title>', {
  status: 403, headers: { 'content-type': 'text/html; charset=UTF-8' } });
const placeholder = (url = source) => new Response(`<html><head><title>Truth Social</title><meta property="og:title" content="Truth Social">
  <meta property="og:url" content="${url}"><meta property="og:type" content="website"></head><body></body></html>`,
{ headers: { 'content-type': 'text/html' } });
const archiveMediaUrl = (name: string) => `https://truth-archive.us-iad-1.linodeobjects.com/attachments/18700/${name}`;
const archiveItem = (postId: string, body: string, extra = '') => `<item>
  <title><![CDATA[Image post]]></title><description><![CDATA[${body}]]></description><dc:creator>Donald J. Trump</dc:creator>
  <pubDate>Sat, 24 Oct 2026 18:32:17 +0000</pubDate><truth:originalUrl>https://truthsocial.com/@realDonaldTrump/${postId}</truth:originalUrl>
  <truth:originalId>${postId}</truth:originalId><archive:postType>original</archive:postType><archive:removed>false</archive:removed>${extra}</item>`;
const feed = (...items: string[]) => new Response(`<?xml version="1.0"?><rss><channel>${items.join('')}</channel></rss>`,
  { headers: { 'content-type': 'application/xml;charset=UTF-8' } });

test('Truth Social post permalinks normalize; profiles, API paths and lookalikes do not', () => {
  assert.deepEqual(parseTruthSocialUrl(source), { id, handle: 'realDonaldTrump', url: source });
  assert.deepEqual(parseTruthSocialUrl(`https://www.truthsocial.com/@realDonaldTrump/posts/${id}/?ref=x#top`),
    { id, handle: 'realDonaldTrump', url: source });
  for (const value of ['https://truthsocial.com/@realDonaldTrump', `https://truthsocial.com/api/v1/statuses/${id}`,
    `http://truthsocial.com/@a/${id}`, `https://truthsocial.com:443/@a/${id}`, `https://evil.truthsocial.com/@a/${id}`,
    `https://truthsocial.com.evil.com/@a/${id}`, `https://truthsocial.com/@a/../${id}`, `https://truthsocial.com/@a-b/${id}`,
    `https://truthsocial.com/@a/${id}/embed`, `https://truthsocial.com/users/a/statuses/${id}`]) {
    assert.equal(parseTruthSocialUrl(value), null, value);
  }
  assert.deepEqual(findArticleLinks(`look ${source}`), [source]);
});

test('public statuses become one inert card with author, text, first image, counts and time', () => {
  const post = parseTruthSocialStatus(status(), link)!;
  const [card, ...rest] = formatTruthSocialPost(post);
  assert.equal(rest.length, 0);
  assert.equal(card.url, source);
  assert.equal(card.title, 'Truth Social post');
  assert.deepEqual(card.author, { name: 'Donald J. Trump (@realDonaldTrump)', url: 'https://truthsocial.com/@realDonaldTrump', icon_url: avatar });
  assert.equal(card.description, 'First & bold line\nsecond @​here\n\nSee \\[link\\]');
  assert.deepEqual(card.image, { url: photo });
  assert.equal(card.footer?.text, 'Truth Social · 1.8K replies · 5.2K ReTruths · 17.7K likes');
  assert.equal(card.timestamp, '2026-10-24T18:32:17.473Z');
});

test('image-only, video, link-card, quote and ReTruth posts keep their context', () => {
  const imageOnly = formatTruthSocialPost(parseTruthSocialStatus(status({ content: '<p></p>' }), link)!)[0];
  assert.equal(imageOnly.description, undefined);
  assert.deepEqual(imageOnly.image, { url: photo });

  const poster = asset('media_attachments/files/1/small/poster.png');
  const video = formatTruthSocialPost(parseTruthSocialStatus(status({ content: '', media_attachments: [
    { type: 'video', url: asset('media_attachments/files/1/original/clip.mp4'), preview_url: poster }] }), link)!)[0];
  assert.deepEqual(video.image, { url: poster });
  assert.equal(video.description, `**[▶ Play video](${asset('media_attachments/files/1/original/clip.mp4')})**`);
  const foreignVideo = formatTruthSocialPost(parseTruthSocialStatus(status({ content: '', media_attachments: [
    { type: 'video', url: 'https://evil.example/clip.mp4', preview_url: poster }] }), link)!)[0];
  assert.match(foreignVideo.description!, /Video: open the post to play it/);

  const cardImage = asset('cache/preview_cards/images/078/original/6daa042738f6a693.jpg');
  const linked = formatTruthSocialPost(parseTruthSocialStatus(status({ media_attachments: [],
    card: { title: 'Exclusive | Story', provider_name: 'nypost.com', image: cardImage } }), link)!)[0];
  assert.deepEqual(linked.image, { url: cardImage });
  assert.match(linked.description!, /\*\*Link:\*\* Exclusive \\\| Story · nypost\.com$/);

  const quoted = formatTruthSocialPost(parseTruthSocialStatus(status({ media_attachments: [],
    content: '<p><span class="quote-inline"><br/>RT: https://truthsocial.com/users/a/statuses/1</span>Endorsed</p>',
    quote: { visibility: 'public', sensitive: false, account: account('second_acct', 'Second'), content: '<p>Original</p>' } }), link)!)[0];
  assert.equal(quoted.description, 'Endorsed\n\n**Quoting Second (@​second\\_acct)**\n> Original');

  const reposted = parseTruthSocialStatus(status({ content: '', media_attachments: [], account: account('reposter', 'Reposter'),
    reblog: status({ id: '1', account: account('origin', 'Origin'), content: '<p>Original text</p>', media_attachments: [] }) }), link)!;
  const repost = formatTruthSocialPost(reposted)[0];
  assert.equal(repost.url, `https://truthsocial.com/@reposter/${id}`);
  assert.equal(repost.title, 'ReTruthed by Reposter');
  assert.equal(repost.author?.name, 'Origin (@origin)');
  assert.equal(repost.description, 'Original text');
});

test('the longest markdown-heavy post still fits Discord embed limits', () => {
  const heavy = '*_-#'.repeat(5000);
  const [card] = formatTruthSocialPost(parseTruthSocialStatus(status({ content: `<p>${heavy}</p>`,
    media_attachments: [{ type: 'video', preview_url: photo }], card: { title: heavy, provider_name: heavy },
    quote: { visibility: 'public', account: account('q', heavy), content: heavy } }), link)!);
  assert.ok(card.description!.length <= 4096, String(card.description!.length));
  assert.ok(card.author!.name.length <= 256 && card.title!.length <= 256 && card.footer!.text.length <= 2048);
});

test('mismatched, private, sensitive, warned, empty or foreign-media statuses are rejected or stripped', () => {
  for (const overrides of [{ id: '1' }, { visibility: 'private' }, { visibility: 'direct' }, { sensitive: true },
    { spoiler_text: 'CW' }, { content: '', media_attachments: [] }, { account: { acct: 'bad@remote.example' } },
    { media_attachments: 'nope' }, { reblog: status({ visibility: 'private' }) }, { content: 7 }]) {
    assert.equal(parseTruthSocialStatus(status(overrides), link), null, JSON.stringify(overrides));
  }
  const foreign = parseTruthSocialStatus(status({ media_attachments: [{ type: 'image', url: 'https://evil.example/a.jpg' }],
    account: { ...account(), avatar: 'https://static-assets-1.truthsocial.com/a/../b.jpg' } }), link)!;
  assert.equal(foreign.image, undefined);
  assert.equal(foreign.author.avatar, undefined);
  assert.deepEqual(formatTruthSocialPost({ ...foreign, image: 'https://evil.example/a.jpg' }), []);
  assert.deepEqual(formatTruthSocialPost({ ...foreign, url: 'https://example.com/@a/1' }), []);
  const hidden = parseTruthSocialStatus(status({ quote: { visibility: 'private', account: account(), content: 'secret' } }), link)!;
  assert.equal(hidden.quote, undefined);
});

test('the article lookup requests the public status API and prepares a confirmable card', async () => {
  const f = fixture(async () => json(status()));
  const prepared = await prepareArticlePosts([`https://truthsocial.com/@realDonaldTrump/posts/${id}`], f.lookup);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].hostname, 'truthsocial.com');
  assert.equal(f.calls[0].path, `/api/v1/statuses/${id}`);
  assert.equal((f.calls[0].headers as Record<string, string>).accept, 'application/json');
  assert.equal(prepared?.length, 1);
  const [card] = prepared![0].embeds;
  assert.equal(card.url, source);
  const original = `https://truthsocial.com/@realDonaldTrump/posts/${id}`;
  const expected = expectedPreviews(original, `<${original}>`, [], prepared!);
  assert.equal(expected.length, 1);
  assert.equal(inspectPreviews([{ ...card }], expected).ok, true);
  assert.equal(inspectPreviews([{ ...card, description: 'changed' }], expected).ok, false);
});

test('placeholder pages, redirects, non-JSON and oversized bodies from every source leave the original', async () => {
  for (const respond of [
    () => placeholder(),
    () => new Response(null, { status: 302, headers: { location: 'https://truthsocial.com/login' } }),
    () => json(status(), { 'content-encoding': 'gzip' }),
    () => new Response('{', { headers: { 'content-type': 'application/json' } }),
    () => json({ ...status(), padding: 'x'.repeat(600 * 1024) }),
    blocked,
  ]) {
    const f = fixture(async () => respond());
    assert.equal(await f.lookup(source), null);
    assert.equal(f.calls[0].path, `/api/v1/statuses/${id}`);
    // Status API, archive feed, oEmbed author and two page visits; nothing else is requested.
    assert.deepEqual(new Set(f.calls.map(call => `${call.hostname}${call.path!.replace(/\?.*/, '')}`)), new Set([
      `truthsocial.com/api/v1/statuses/${id}`, 'www.trumpstruth.org/feed', 'truthsocial.com/api/oembed', `truthsocial.com/@realDonaldTrump/${id}`]));
    assert.ok(f.calls.length <= 5);
  }
  // A Truth Social preview never falls back to the generic placeholder metadata path.
  assert.deepEqual(formatArticlePreview({ source, url: source, title: 'Truth Social', publisher: 'Truth Social' }), []);
});

test('when the status API is blocked, @realDonaldTrump posts come from the archive feed with playable video', async () => {
  const videoId = '117504332756417928', poster = archiveMediaUrl('poster/1bb08d8ba8020647-1f16488fe142.jpg');
  const archived = feed(
    archiveItem(id, `<p></p><p><a href="${archiveMediaUrl('d2c8ca4d0b00e832-c85da474c153.jpg')}">View image</a></p>`,
      `<media:content url="${archiveMediaUrl('d2c8ca4d0b00e832-c85da474c153.jpg')}" medium="image"><media:thumbnail url="${photo}" /></media:content>`),
    archiveItem(videoId, '<p>Watch &amp; share</p>',
      `<media:content url="${archiveMediaUrl('02ca0a8f8b012c1f-40c7a9f5027b.mp4')}" medium="video"><media:thumbnail url="${poster}" /></media:content>`));
  const f = fixture(async settings => settings.hostname === 'www.trumpstruth.org' ? archived.clone() : blocked());
  const [image] = (await prepareArticlePosts([source], f.lookup))![0].embeds;
  assert.deepEqual(image.image, { url: archiveMediaUrl('d2c8ca4d0b00e832-c85da474c153.jpg') });
  assert.equal(image.author?.name, 'Donald J. Trump (@realDonaldTrump)');
  assert.equal(image.footer?.text, 'Truth Social · via Trump’s Truth archive');
  assert.equal(image.timestamp, '2026-10-24T18:32:17.000Z');
  assert.equal(image.description, undefined);
  const [video] = (await prepareArticlePosts([`https://truthsocial.com/@realDonaldTrump/${videoId}`], f.lookup))![0].embeds;
  assert.deepEqual(video.image, { url: poster });
  assert.equal(video.description, `Watch & share\n\n**[▶ Play video](${archiveMediaUrl('02ca0a8f8b012c1f-40c7a9f5027b.mp4')})**`);
  assert.equal(f.calls.filter(call => call.hostname === 'www.trumpstruth.org').length, 1, 'the feed is cached across lookups');
});

test('archive entries must match, remain published and use the archive or Truth Social media hosts', () => {
  const xml = (item: string) => `<rss>${item}</rss>`;
  const parse = (item: string, target = link) => parseTruthArchiveFeed(xml(item), target);
  assert.equal(parse(archiveItem('1', '<p>Other</p>')), null);
  assert.equal(parse(archiveItem(id, '<p>Gone</p>').replace('<archive:removed>false', '<archive:removed>true')), null);
  assert.equal(parse(archiveItem(id, '<p>Hi</p>').replace(`@realDonaldTrump/${id}</truth:originalUrl>`, '@realDonaldTrump/2</truth:originalUrl>')), null);
  assert.equal(parse(archiveItem(id, '<p>Hi</p>'), parseTruthSocialUrl(`https://truthsocial.com/@someoneElse/${id}`)!), null);
  const foreign = parse(archiveItem(id, '<p>Hi</p>', '<media:content url="https://evil.example/a.mp4" medium="video"><media:thumbnail url="https://evil.example/a.jpg" /></media:content>'))!;
  assert.equal(foreign.videoUrl, undefined);
  assert.equal(foreign.image, undefined);
  assert.equal(foreign.video, true);
  assert.deepEqual(formatTruthSocialPost({ ...foreign, videoUrl: 'https://evil.example/a.mp4' }), []);
});

test('other accounts fall back to Truth Social page metadata after the warming visit', async () => {
  const other = 'https://truthsocial.com/@TeamTrump/113902121017724220';
  const teamAvatar = asset('accounts/avatars/1/original/team.png');
  let visits = 0;
  const f = fixture(async settings => {
    if (settings.path!.startsWith('/api/oembed')) return json({ author_name: 'Team Trump', author_url: 'https://truthsocial.com/@TeamTrump' });
    if (settings.path === '/@TeamTrump/113902121017724220') {
      return ++visits === 1 ? placeholder(other) : new Response(`<html><head><title>Official portrait</title>
        <meta property="og:title" content="Official portrait of First Lady"><meta property="og:description" content="Official portrait of First Lady &amp; more">
        <meta property="og:image" content="${teamAvatar}"><meta property="og:url" content="${other}"></head><body></body></html>`,
      { headers: { 'content-type': 'text/html' } });
    }
    return blocked();
  });
  const [card] = (await prepareArticlePosts([other], f.lookup))![0].embeds;
  assert.equal(visits, 2);
  assert.ok(!f.calls.some(call => call.hostname === 'www.trumpstruth.org'));
  assert.deepEqual(card.author, { name: 'Team Trump (@TeamTrump)', url: 'https://truthsocial.com/@TeamTrump', icon_url: teamAvatar });
  assert.equal(card.description, 'Official portrait of First Lady & more');
  assert.equal(card.footer?.text, 'Truth Social');
  assert.equal(card.image, undefined);
  assert.equal(parseTruthSocialPage({ url: other, title: 'Truth Social', description: 'x' }, parseTruthSocialUrl(other)!), null);
  assert.equal(parseTruthSocialPage({ url: source, title: 't', description: 'x' }, parseTruthSocialUrl(other)!), null);
});

const relay = { hostname: 'relay.example.workers.dev', token: 'r'.repeat(40) };

test("when the status API blocks this host, a configured relay serves any account's status, video included", async () => {
  const videoId = '117507817818004689', other = `https://truthsocial.com/@WhiteHouse/${videoId}`;
  const clip = asset('media_attachments/files/117/507/original/bea9456685d25a9d.mp4');
  const poster = asset('media_attachments/thumbnails/117/507/original/b07222c171ec6af7.jpg');
  const f = fixture(async settings => settings.hostname === relay.hostname ? json(status({ id: videoId,
    account: account('WhiteHouse', 'The White House'), content: '<p>Watch</p>',
    media_attachments: [{ type: 'video', url: clip, preview_url: poster }] })) : blocked(), { truthSocialRelay: relay });
  const [card] = (await prepareArticlePosts([other], f.lookup))![0].embeds;
  assert.deepEqual(f.calls.map(call => `${call.hostname}${call.path}`), [`truthsocial.com/api/v1/statuses/${videoId}`,
    `${relay.hostname}/status/${videoId}`]);
  assert.equal((f.calls[0].headers as Record<string, string>).authorization, undefined);
  assert.equal((f.calls[1].headers as Record<string, string>).authorization, `Bearer ${relay.token}`);
  assert.equal(card.author?.name, 'The White House (@WhiteHouse)');
  assert.deepEqual(card.image, { url: poster });
  assert.equal(card.description, `Watch\n\n**[▶ Play video](${clip})**`);
  assert.equal(card.footer?.text, 'Truth Social · 1.8K replies · 5.2K ReTruths · 17.7K likes');
});

test('a reachable status API skips the relay; a failing relay falls through; a relay never answers for a different post', async () => {
  const direct = fixture(async () => json(status()), { truthSocialRelay: relay });
  assert.equal((await direct.lookup(source))?.truthSocial?.via, 'api');
  assert.deepEqual(direct.calls.map(call => call.hostname), ['truthsocial.com']);
  const down = fixture(async settings => settings.hostname === relay.hostname
    ? new Response('upstream 403', { status: 502, headers: { 'content-type': 'text/plain' } }) : blocked(), { truthSocialRelay: relay });
  assert.equal(await down.lookup(source), null);
  assert.deepEqual(down.calls.slice(0, 2).map(call => call.hostname), ['truthsocial.com', relay.hostname]);
  assert.ok(down.calls.some(call => call.hostname === 'www.trumpstruth.org'), 'the archive and page fallbacks still run');
  const wrong = fixture(async settings => settings.hostname === relay.hostname ? json(status({ id: '1' })) : blocked(),
    { truthSocialRelay: relay });
  assert.equal(await wrong.lookup(source), null);
  // The relay token goes only to the relay.
  assert.ok(wrong.calls.filter(call => call.hostname !== relay.hostname)
    .every(call => !('authorization' in (call.headers as Record<string, string>))));
});

test("image-only posts by any account use the page's original first image when every API route is blocked", async () => {
  const other = 'https://truthsocial.com/@WhiteHouse/117496479654563409';
  const files = asset('media_attachments/files/117/496/479/500/000/001');
  let visits = 0;
  const f = fixture(async settings => {
    if (settings.path === '/@WhiteHouse/117496479654563409') {
      return ++visits === 1 ? placeholder(other) : new Response(`<html><head>
        <meta property="og:image" content="${files}/small/a1b2c3.jpg"><meta property="og:url" content="${other}"></head></html>`,
      { headers: { 'content-type': 'text/html' } });
    }
    return blocked();
  });
  const [card] = (await prepareArticlePosts([other], f.lookup))![0].embeds;
  assert.deepEqual(card.image, { url: `${files}/original/a1b2c3.jpg` });
  assert.equal(card.description, undefined);
  assert.deepEqual(card.author, { name: 'WhiteHouse (@WhiteHouse)', url: 'https://truthsocial.com/@WhiteHouse' });
  // An avatar is not post media, and a page with neither text nor media is not a post.
  assert.equal(parseTruthSocialPage({ url: other, image: avatar }, parseTruthSocialUrl(other)!), null);
  assert.equal(parseTruthSocialPage({ url: other, image: `${files}/small/../a.jpg` }, parseTruthSocialUrl(other)!), null);
});

test('relay settings need both an https origin and a long token', () => {
  assert.equal(parseTruthSocialRelay(undefined, ' '), undefined);
  assert.deepEqual(parseTruthSocialRelay('https://Relay.Example.workers.dev/', relay.token), relay);
  for (const [url, token] of [['https://relay.example.workers.dev', undefined], [undefined, relay.token],
    ['https://relay.example.workers.dev', 'short'], ['http://relay.example.workers.dev', relay.token],
    ['https://relay.example.workers.dev/status', relay.token], ['https://user@relay.example.workers.dev', relay.token],
    ['https://relay.example.workers.dev:8443', relay.token], ['https://1.2.3.4', relay.token], ['https://localhost', relay.token]]) {
    assert.throws(() => parseTruthSocialRelay(url, token), /TRUTH_SOCIAL_RELAY/, `${url} ${token}`);
  }
});
