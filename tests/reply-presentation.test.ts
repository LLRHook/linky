import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ComponentType as C } from 'discord.js';
import { replyThreadPayloads, REPLY_PAGE_MARKER, type ReplyPage } from '../src/services/ReplyThreads';
import { parseXReplies } from '../src/services/XReplies';
import { parseBlueskyReplies } from '../src/services/BlueskyReplies';
import { parseYouTubeComments } from '../src/services/YouTubeComments';
import x from './fixtures/x-conversation.json';
import b from './fixtures/bluesky-replies.json';
const reply = { name: 'Writer', handle: 'writer', profileUrl: 'https://x.com/writer', url: 'https://x.com/writer/status/1', text: 'Hello', timestamp: 1, likes: 2, hasMedia: false };
const page = (source = 'X'): ReplyPage => ({ source, N: 10, r: 10, m: 0, countTime: 0, orderLabel: 'most liked first', replies: [reply, reply] });
const walk = (items: any[]): any[] => items.flatMap(c => [c, ...walk(c.components ?? []), ...(c.accessory ? [c.accessory] : [])]);
for (const source of ['X', 'Bluesky', 'YouTube', 'LinkedIn']) test(`${source} author heading precedes text and divider separates replies`, () => {
 const p = page(source); if (source === 'LinkedIn') p.commentsUrl = 'https://www.linkedin.com/posts/example';
 const parts = walk(replyThreadPayloads(p)[0].components);
 assert.equal(parts.filter(c => c.type === C.Separator && c.divider).length, 1);
 const texts = parts.filter(c => c.type === C.TextDisplay).slice(1);
 assert.equal(texts.length, 2);
 for (const t of texts) { assert(t.content.startsWith('**Writer**')); assert(t.content.indexOf('Writer') < t.content.indexOf('Hello')); assert(t.content.includes('-# 2 likes')); }
 assert.equal(texts[0].content.includes(' · @writer\n'), source === 'X' || source === 'Bluesky');
});

for (const [source, handle, escaped, profileUrl] of [
 ['X', 'a_b', 'a\\_b', 'https://x.com/a_b'],
 ['Bluesky', 'elric-mtl.bsky.social', 'elric\\-mtl.bsky.social', 'https://bsky.app/profile/did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'],
 ['X', '_abc_', '\\_abc\\_', 'https://x.com/_abc_'],
]) test(`${source} handle ${handle} stays plain with a fixed Profile label`, () => {
 const p = page(source); p.replies = [{ ...reply, handle, profileUrl }];
 const payloads = replyThreadPayloads(p);
 const content = walk(payloads[0].components).filter(c => c.type === C.TextDisplay)[1].content;
 assert.equal(content, `**Writer** · @${escaped}\n-# 2 likes · <t:1:R> · [Open reply](<${reply.url}>) · [Profile](<${profileUrl}>)\nHello`);
 const labels = [...JSON.stringify(payloads).matchAll(/\[([^\[\]]*)\]\(</g)].map(m => m[1]);
 assert.deepEqual(labels, ['Open reply', 'Profile']);
});

test('Profile links omit missing and invalid targets while retaining plain handles', () => {
 for (const source of ['X', 'Bluesky']) for (const profileUrl of ['', 'http://x.com/a_b', 'https://x.com.evil.test/a_b', 'https://user@x.com/a_b', 'https://x.com:444/a_b', 'https://x.com/a_b>)[evil](<https://evil.test', 'https://bsky.app/profile/invalid', 'https://bsky.app/profile/did:plc:abc?x=1', 'https://bsky.app/profile/writer.bsky.social/post/x', 'https://bsky.app/profile/writer.bsky.social>)[evil](<https://evil.test']) {
  const p = page(source); p.replies = [{ ...reply, handle: 'a_b', profileUrl }];
  const content = walk(replyThreadPayloads(p)[0].components).filter(c => c.type === C.TextDisplay)[1].content;
  assert(content.startsWith('**Writer** · @a\\_b\n'));
  assert(!content.includes('[Profile]')); assert(!content.includes(profileUrl) || !profileUrl);
 }
 for (const [source, profileUrl] of [['X', 'https://bsky.app/profile/writer.bsky.social'], ['Bluesky', 'https://x.com/writer']]) {
  const p = page(source); p.replies = [{ ...reply, profileUrl }];
  assert(!JSON.stringify(replyThreadPayloads(p)).includes('[Profile]'));
 }
});

test('maximum serialized reply text packs with Profile subtext within every budget', () => {
 const p = page('Bluesky');
 const actor = 'did:web:' + ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.');
 p.replies = Array.from({ length: 10 }, (_, i) => ({ ...reply, name: '*'.repeat(200), handle: `user-${i}.` + 'a'.repeat(63) + '.' + 'b'.repeat(63) + '.' + 'c'.repeat(63) + '.social', profileUrl: `https://bsky.app/profile/${actor}`, url: `https://bsky.app/profile/${actor}/post/${'r'.repeat(512)}`, text: '*'.repeat(1000), avatarUrl: 'https://cdn.bsky.app/avatar.jpg', media: [{ url: 'https://cdn.bsky.app/image.jpg' }] }));
 const payloads = replyThreadPayloads(p);
 const contents = payloads.flatMap(payload => {
  const parts = walk(payload.components);
  assert(parts.length <= 40);
  const texts = parts.filter(c => c.type === C.TextDisplay).map(c => c.content as string);
  assert(texts.reduce((sum, t) => sum + t.length, 0) <= 3800);
  assert(parts.filter(c => c.type === C.Section).length <= 10);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  return texts;
 });
 assert.equal(contents.filter(t => t.includes(`[Profile](<https://bsky.app/profile/${actor}>)`)).length, 10);
 assert.equal(payloads.flatMap(p => walk(p.components)).filter(c => c.type === C.Section).length, 10);
});
test('avatars accept exact HTTPS provider hosts and reject missing and hostile URLs without empty sections', () => {
 for (const [source, host] of [['X', 'pbs.twimg.com'], ['Bluesky', 'cdn.bsky.app'], ['YouTube', 'yt3.ggpht.com'], ['YouTube', 'yt3.googleusercontent.com']]) {
  for (const avatarUrl of [`https://${host}/a.jpg`, undefined, `http://${host}/a`, `https://${host}.evil.test/a`, `https://user@${host}/a`, `https://${host}:444/a`, `https://${host}/` + 'a'.repeat(2048)]) {
   const p = page(source); p.replies = [{ ...reply, avatarUrl }];
   const parts = walk(replyThreadPayloads(p)[0].components);
   assert.equal(parts.filter(c => c.type === C.Thumbnail).length, avatarUrl === `https://${host}/a.jpg` ? 1 : 0);
   assert.equal(parts.filter(c => c.type === C.Section).length, avatarUrl === `https://${host}/a.jpg` ? 1 : 0);
  }
 }
});
test('ordered galleries cap four images and sanitize alt; rejected media gets linked note; video is poster only', () => {
 const p = page(); p.replies = [{ ...reply, hasMedia: true, media: Array.from({ length: 6 }, (_, i) => ({ url: `https://pbs.twimg.com/${i}.jpg`, alt: '@everyone **photo** https://evil.test ' + 'x'.repeat(2000) })) }];
 const parts = walk(replyThreadPayloads(p)[0].components); const gallery = parts.find(c => c.type === C.MediaGallery);
 assert.deepEqual(gallery.items.map((i: any) => i.media.url), [0, 1, 2, 3].map(i => `https://pbs.twimg.com/${i}.jpg`));
 assert(gallery.items.every((i: any) => i.description.length <= 1024 && !i.description.includes('https://evil.test') && i.description.includes('@\u200beveryone')));
 p.replies[0].media = [{ url: 'https://video.twimg.com/video.mp4' }];
 const missing = JSON.stringify(replyThreadPayloads(p)); assert(missing.includes('-# media not shown')); assert(missing.includes('Open reply')); assert(!missing.includes('video.mp4'));
});
test('ten media heavy replies pack greedily under nested component, text and ten reply budgets without controls', () => {
 const p = page(); p.replies = Array.from({ length: 10 }, (_, i) => ({ ...reply, text: `Body${i}`, avatarUrl: 'https://pbs.twimg.com/avatar.jpg', media: [{ url: 'https://pbs.twimg.com/image.jpg' }] }));
 const pages = replyThreadPayloads(p); assert.deepEqual(pages.map(p => walk(p.components).filter(c => c.type === C.Section).length), [7, 3]);
 for (const payload of pages) {
  const parts = walk(payload.components); assert(parts.length <= 40); assert(parts.filter(c => c.type === C.TextDisplay).reduce((s, c) => s + c.content.length, 0) <= 3800);
  assert.equal(payload.components[0].id, REPLY_PAGE_MARKER); assert.equal(payload.flags, 36868); assert.deepEqual(payload.allowedMentions, { parse: [] }); assert(!parts.some(c => c.type === C.Button));
 }
 assert.equal(walk(pages.flatMap(p => p.components)).filter(c => c.type === C.Section).length, 10);
});
test('X adapter retains avatar, ordered photos and video thumbnail without changing counts', () => {
 const data: any = structuredClone(x); data.replies[0].author.avatar_url = 'https://pbs.twimg.com/avatar.jpg';
 data.replies[0].media = { photos: [{ url: 'https://pbs.twimg.com/one.jpg', altText: 'one' }, { url: 'https://pbs.twimg.com/two.jpg' }], videos: [{ url: 'https://video.twimg.com/a.mp4', thumbnail_url: 'https://pbs.twimg.com/poster.jpg' }] };
 const p = parseXReplies(data, data.status.id, 0)!; const r = p.replies.find(r => r.handle === data.replies[0].author.screen_name)!;
 assert.equal(r.avatarUrl, data.replies[0].author.avatar_url); assert.equal(r.media?.[0].alt, 'one'); assert.deepEqual(r.media?.map(i => i.url), ['https://pbs.twimg.com/one.jpg', 'https://pbs.twimg.com/two.jpg', 'https://pbs.twimg.com/poster.jpg']); assert.equal(p.r, data.replies.length);
});
test('Bluesky adapter retains images, recordWithMedia and video posters and avatar', () => {
 for (const nested of [false, true]) for (const video of [false, true]) {
  const data: any = structuredClone(b); const post = data.thread.replies[0].post;
  post.author.avatar = 'https://cdn.bsky.app/avatar.jpg';
  const media = video ? { $type: 'app.bsky.embed.video#view', thumbnail: 'https://video.bsky.app/poster.jpg' } : { $type: 'app.bsky.embed.images#view', images: [{ fullsize: 'https://cdn.bsky.app/one.jpg', alt: 'one' }, { thumb: 'https://cdn.bsky.app/two.jpg', alt: 'two' }] };
  post.embed = nested ? { $type: 'app.bsky.embed.recordWithMedia#view', media } : media;
  const p = parseBlueskyReplies(data, data.thread.post.uri.split('at://')[1].replace('/app.bsky.feed.post/', '/'), 0)!;
  const r = p.replies.find(r => r.url.endsWith(post.uri.split('/').at(-1)))!;
  assert.equal(r.avatarUrl, post.author.avatar); assert.deepEqual(r.media?.map(m => m.url), video ? ['https://video.bsky.app/poster.jpg'] : ['https://cdn.bsky.app/one.jpg', 'https://cdn.bsky.app/two.jpg']);
 }
});
test('YouTube adapter retains author profile image', () => {
 const p = parseYouTubeComments({ items: [{ snippet: { videoId: 'abcdefghijk', topLevelComment: { id: 'c', snippet: { textDisplay: 'text', authorDisplayName: 'Writer', authorProfileImageUrl: 'https://yt3.ggpht.com/avatar.jpg', likeCount: 0, publishedAt: '2026-01-01' } } } }] }, 'abcdefghijk')!;
 assert.equal(p.replies[0].avatarUrl, 'https://yt3.ggpht.com/avatar.jpg');
});
