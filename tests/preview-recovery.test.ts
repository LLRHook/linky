import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type APIEmbed, type Message } from 'discord.js';
import { expectedPreviews, inspectPreviews, nextProviderContent, PreviewHealth, waitForPreviews } from '../src/services/PreviewRecovery';
import { translationEmbeds } from '../src/services/TweetPresentation';

const source = 'https://www.instagram.com/reel/DdFKS1ABmK4/';
const fixed = 'https://www.instagram7.com/reel/DdFKS1ABmK4/';
const expected = expectedPreviews(source, fixed);
const media: APIEmbed = { url: fixed, video: { url: 'https://cdn.example/video.mp4' } };

test('a provider homepage, error card or unrelated embed does not qualify as a useful preview', () => {
  assert.equal(expected.length, 1);
  for (const embed of [
    { url: fixed, title: 'Error', description: 'Try again later' },
    { url: 'https://www.instagram7.com/', thumbnail: { url: 'https://cdn.example/logo.png' } },
    { url: 'https://www.instagram7.com/reel/wrong/', video: { url: 'https://cdn.example/video.mp4' } },
    { url: 'https://evil.test/reel/DdFKS1ABmK4/', video: { url: 'https://cdn.example/video.mp4' } },
  ]) assert.equal(inspectPreviews([embed], expected).ok, false);
  assert.equal(inspectPreviews([media], expected).ok, true);
  assert.equal(inspectPreviews([{ ...media, url: source }], expected).ok, true);
});

test('every visible rewritten post requires its own preview and hidden posts are excluded', () => {
  const original = `${source} https://instagram.com/p/Another/ <https://instagram.com/p/Hidden/>`;
  const rendered = `${fixed} https://www.instagram7.com/p/Another/ <https://instagram.com/p/Hidden/>`;
  const items = expectedPreviews(original, rendered);
  assert.equal(items.length, 2);
  assert.equal(inspectPreviews([media], items).ok, false);
  assert.equal(inspectPreviews([media], items).missing[0].source, 'https://www.instagram.com/p/Another/');
});

test('video metadata and useful image previews are reported separately from playback', () => {
  const imageSource = 'https://instagram.com/p/Photo/';
  const imageFixed = 'https://www.instagram7.com/p/Photo/';
  const image = inspectPreviews([{ url: imageFixed, image: { url: 'https://cdn.example/photo.jpg' } }], expectedPreviews(imageSource, imageFixed));
  assert.equal(image.ok, true);
  assert.equal(image.videoMetadata, false);
  assert.equal(inspectPreviews([media], expected).videoMetadata, true);
  assert.equal(inspectPreviews([{ url: fixed, image: { url: 'https://cdn.example/photo.jpg' } }], expected).ok, false,
    'A thumbnail alone does not replace an Instagram Reel');
  const yt = expectedPreviews('https://youtu.be/dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(inspectPreviews([{ url: yt[0].url, title: 'YouTube stats', fields: [{ name: 'Views', value: '2' }] }], yt).ok, false);
  assert.equal(inspectPreviews([{ url: yt[0].url, video: { url: 'https://www.youtube.com/embed/dQw4w9WgXcQ' } }], yt).ok, true);
});

test('wait accepts delayed Discord embeds but exhausts a bounded schedule on failure', async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const message = { embeds: [], fetch: async () => ({ embeds: ++calls === 2 ? [{ toJSON: () => media }] : [] }) } as unknown as Message;
  const result = await waitForPreviews(message, expected, { intervals: [1, 2, 3], sleep: async ms => { sleeps.push(ms); } });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [1, 2]);
  calls = 0;
  message.fetch = (async () => { calls++; return { embeds: [] }; }) as unknown as Message['fetch'];
  assert.equal((await waitForPreviews(message, expected, { intervals: [1, 2], sleep: async () => {} })).ok, false);
  assert.equal(calls, 2);
});

test('explicit X video paths require video metadata while photo and text posts retain their previews', () => {
  for (const suffix of ['/video/1', '/video/4/', '/photo/1', '']) {
    const source = `https://twitter.com/author/status/20${suffix}`;
    const fixed = source.replace('twitter.com', 'fixupx.com');
    const items = expectedPreviews(source, fixed);
    const image: APIEmbed = { url: fixed, title: 'Author', description: 'Caption', thumbnail: { url: 'https://cdn.example/poster.jpg' } };
    assert.equal(inspectPreviews([image], items).ok, !suffix.includes('/video/'), suffix);
    assert.equal(inspectPreviews([{ ...image, video: { url: 'https://cdn.example/clip.mp4' } }], items).ok, true, suffix);
  }
});

test('new platform previews match canonical post identities and reject unrelated posts', () => {
  for (const [source, fixed, canonical, media] of [
    ['https://www.reddit.com/r/example/comments/90bu6w/old_title/abc', 'https://vxreddit.com/r/example/comments/90bu6w/old_title/abc',
      'https://www.reddit.com/comments/90bu6w', { image: { url: 'https://i.redd.it/example.jpg' } }],
    ['https://www.twitch.tv/channel/clip/RealClip', 'https://fxtwitch.seria.moe/clip/RealClip',
      'https://clips.twitch.tv/RealClip', { video: { url: 'https://cdn.example/clip.mp4' } }],
    ['https://bsky.app/profile/bsky.app/post/3mv3shqdfuc2e', 'https://bskx.app/profile/bsky.app/post/3mv3shqdfuc2e',
      'https://bsky.app/profile/bsky.app/post/3mv3shqdfuc2e', { image: { url: 'https://cdn.bsky.app/image.jpg' } }],
  ] as const) {
    const items = expectedPreviews(source, fixed);
    assert.equal(items.length, 1);
    assert.equal(inspectPreviews([{ url: canonical, ...media }], items).ok, true);
    assert.equal(inspectPreviews([{ url: `${canonical}wrong`, ...media }], items).ok, false);
    assert.equal(inspectPreviews([{ url: fixed, title: 'Error', description: 'Try again later' }], items).ok, false);
  }
});

test('an unavailable message aborts the preview wait instead of manufacturing success', async () => {
  const message = { embeds: [], fetch: async () => { throw { code: 10008 }; } } as unknown as Message;
  await assert.rejects(waitForPreviews(message, expected, { intervals: [1], sleep: async () => {} }));
});

test('provider recovery only changes failed links to catalogued alternatives and never loops', () => {
  const attempted = new Set<string>();
  let content = fixed;
  const visited = [new URL(content).hostname];
  for (let count = 0; count < 10; count++) {
    const next = nextProviderContent(content, expectedPreviews(source, content), attempted);
    if (next === content) break;
    assert.equal(new URL(next).hostname, 'oginstagram.com');
    assert.equal(visited.includes(new URL(next).hostname), false, 'Recovery must not revisit a provider');
    visited.push(new URL(next).hostname);
    content = next;
  }
  assert.deepEqual(visited, ['www.instagram7.com', 'oginstagram.com']);
  assert.equal(content, 'https://oginstagram.com/reel/DdFKS1ABmK4/');
  assert.equal(attempted.size, 2);
  assert.equal(nextProviderContent(content, expectedPreviews(source, content), attempted), content);
  assert.equal(nextProviderContent('https://evil.test/path', [{ source: 'https://evil.test/path', url: 'https://evil.test/path', platform: 'instagram', providerId: 'evil' }], new Set()), 'https://evil.test/path');
});

test('OGInstagram photo recovery requires media for the same case-sensitive shortcode', () => {
  const source = 'https://www.instagram.com/p/DdKVPMEhTXe/';
  const fixed = 'https://oginstagram.com/p/DdKVPMEhTXe/';
  const items = expectedPreviews(source, fixed);
  assert.deepEqual(items, [{ source, url: fixed, platform: 'instagram', providerId: 'oginstagram' }]);
  for (const url of [source, fixed, 'https://www.oginstagram.com/p/DdKVPMEhTXe/']) {
    assert.equal(inspectPreviews([{ url, image: { url: 'https://cdn.example/post.jpg' } }], items).ok, true, url);
    assert.equal(inspectPreviews([{ url, title: 'Author', description: 'Caption without media' }], items).ok, false, url);
  }
  for (const url of ['https://oginstagram.com/p/ddKVPMEhTXe/', 'https://oginstagram.com/p/DdKVPMEhTXeOther/',
    'https://oginstagram.com/', 'https://oginstagram.com.evil.test/p/DdKVPMEhTXe/']) {
    assert.equal(inspectPreviews([{ url, image: { url: 'https://cdn.example/post.jpg' } }], items).ok, false, url);
  }
  const image = inspectPreviews([{ url: fixed, thumbnail: { url: 'https://cdn.example/post.jpg' } }], items);
  assert.equal(image.ok, true);
  assert.equal(image.videoMetadata, false);
});

test('OGInstagram temporary error cards do not pass because they include a thumbnail', () => {
  const fixed = 'https://oginstagram.com/p/DdKVPMEhTXe/';
  const items = expectedPreviews('https://instagram.com/p/DdKVPMEhTXe/', fixed);
  assert.equal(items.length, 1);
  for (const title of ['Temporarily unavailable', '  TEMPORARILY UNAVAILABLE  ']) {
    const result = inspectPreviews([{ url: fixed, title, description: 'Please try again later.',
      thumbnail: { url: 'https://cdn.example/provider-logo.png' } }], items);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, items);
  }
});

test('Instagram fallback still requires video metadata for Reel source paths', () => {
  for (const kind of ['reel', 'reels']) {
    const source = `https://www.instagram.com/${kind}/DdFKS1ABmK4/`;
    const rendered = `https://oginstagram.com/${kind}/DdFKS1ABmK4/`;
    const items = expectedPreviews(source, rendered);
    assert.equal(items.length, 1);
    const imageOnly: APIEmbed = { url: 'https://www.oginstagram.com/reel/DdFKS1ABmK4/',
      image: { url: 'https://cdn.example/poster.jpg' }, thumbnail: { url: 'https://cdn.example/poster.jpg' } };
    assert.equal(inspectPreviews([imageOnly], items).ok, false);
    const result = inspectPreviews([{ ...imageOnly, video: { url: 'https://cdn.example/reel.mp4' } }], items);
    assert.equal(result.ok, true);
    assert.equal(result.videoMetadata, true);
  }
});

test('Instagram recovery preserves working mixed links, hidden posts and surrounding text', () => {
  const photo = 'https://www.instagram.com/p/DdKVPMEhTXe/';
  const primary = 'https://www.instagram7.com/p/DdKVPMEhTXe/';
  const hidden = '<https://instagram.com/p/Hidden/> ||https://instagram.com/p/Spoiler/|| `https://instagram.com/p/Code/`';
  const untouched = 'https://example.com/?next=https://instagram.com/p/Nested/';
  const original = `Photo: ${photo}\nAlready useful: https://x.com/jack/status/20\n${hidden}\n${untouched}`;
  const rendered = `Photo: ${primary}\nAlready useful: https://fixupx.com/jack/status/20\n${hidden}\n${untouched}`;
  const working: APIEmbed = { url: 'https://fixupx.com/jack/status/20', title: 'Author', description: 'A useful text post' };
  const expectations = expectedPreviews(original, rendered);
  assert.equal(expectations.length, 2);
  const initial = inspectPreviews([working], expectations);
  assert.deepEqual(initial.missing.map(item => item.source), [photo]);
  const attempted = new Set<string>();
  const recovered = nextProviderContent(rendered, initial.missing, attempted);
  assert.equal(recovered, rendered.replace(primary, 'https://oginstagram.com/p/DdKVPMEhTXe/'));
  const next = expectedPreviews(original, recovered);
  const success = inspectPreviews([working,
    { url: 'https://oginstagram.com/p/DdKVPMEhTXe/', image: { url: 'https://cdn.example/photo.jpg' } }], next);
  assert.equal(success.ok, true);
  assert.equal(nextProviderContent(recovered, success.missing, attempted), recovered);
  assert.equal(nextProviderContent(recovered, inspectPreviews([working], next).missing, attempted), recovered,
    'An exhausted Instagram backup must not change the working X link or restart recovery');
});

test('plural Instagram reel URLs match the canonical singular path', () => {
  const expected = expectedPreviews('https://instagram.com/reels/DdFKS1ABmK4/', 'https://www.instagram7.com/reels/DdFKS1ABmK4/');
  assert.equal(inspectPreviews([media], expected).ok, true);
});

test('translated gallery previews recover using the actual rendered provider URL', () => {
  const source = 'https://x.com/person/status/123';
  const rendered = 'https://g.fixupx.com/person/status/123';
  const expected = expectedPreviews(source, rendered);
  assert.equal(expected[0].url, rendered);
  assert.equal(nextProviderContent(rendered, expected, new Set()), 'https://vxtwitter.com/person/status/123');
});

test('Linky’s actual text translation cards qualify without a fabricated title', () => {
  const source = 'https://x.com/Nintendo/status/1802857036474167769';
  const fixed = source.replace('x.com', 'fixupx.com');
  const cards = translationEmbeds({ text: 'A translated announcement.', language: 'Japanese',
    author: { name: 'Nintendo', url: 'https://x.com/Nintendo' }, hasMedia: false, hasVideo: false, photos: [] }, fixed)!;
  assert.equal(cards[0].title, undefined);
  assert.equal(inspectPreviews(cards, expectedPreviews(source, fixed)).ok, true);
  assert.equal(inspectPreviews([{ url: fixed, title: 'FixupX', description: "Sorry, that post doesn't exist :(" }], expectedPreviews(source, fixed)).ok, false);
});

test('diagnostics describe recent observations without claiming a provider outage or playback', () => {
  const health = new PreviewHealth();
  assert.match(health.describe(source), /no recent/);
  health.record(expected, inspectPreviews([], expected));
  assert.match(health.describe(source), /failed; that post may be unavailable/);
  health.record(expected, inspectPreviews([media], expected));
  assert.match(health.describe(source), /passed/);
  assert.match(health.describe(source), /does not confirm video playback/);
});
