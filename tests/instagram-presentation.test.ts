import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addInstagramMedia } from '../src/services/InstagramPresentation';
import type { InstagramPost } from '../src/services/InstagramPost';

const source = 'https://www.instagram.com/p/DdFwAIqgncQ/';
const fixed = 'https://oginstagram.com/p/DdFwAIqgncQ/';
const gallery = 'https://g.oginstagram.com/p/DdFwAIqgncQ/';
const OFFLOAD = 'https://oginstagram.com/offload/DdFwAIqgncQ/1?v=2&kid=k1&exp=1798041600&sig=abc';
const post: InstagramPost = { sourceUrl: source, shortcode: 'DdFwAIqgncQ', username: 'bustervro', mediaTypes: ['GraphImage'],
  media: [{ type: 'photo', url: OFFLOAD, width: 720, height: 1280 }] };

test('a lone Instagram post offers one block with its author and media, and never a caption', async () => {
  const requests: string[] = [];
  const result = await addInstagramMedia(source, { content: fixed }, async url => { requests.push(url); return post; }, 1900);
  assert.deepEqual(requests, [source]);
  assert.equal(result.content, gallery, 'the fallback card is the caption-free gallery');
  assert.deepEqual(result.instagramSources, [source]);
  assert.deepEqual(result.instagramVideos, []);
  assert.deepEqual(result.instagramPanel, { post, media: post.media });
  assert.equal('embeds' in result, false);
});

test('current and legacy primary links use the caption-free gallery', async () => {
  for (const host of ['oginstagram.com', 'www.instagram7.com', 'instagram7.com']) {
    const result = await addInstagramMedia(source, { content: `https://${host}/p/DdFwAIqgncQ/` }, undefined, 1900);
    assert.equal(result.content, gallery);
    assert.deepEqual(result.instagramSources, [source]);
    assert.equal(result.instagramPanel, undefined);
  }
});

test('without a usable lookup the gallery card remains and no block is offered', async () => {
  for (const lookup of [undefined, async () => null, async () => { throw new Error('unavailable'); },
    async () => ({ ...post, shortcode: 'another' }), async () => ({ ...post, sourceUrl: 'https://www.instagram.com/p/another/' }),
    async () => { const { media: _media, ...rest } = post; return rest; }, async () => ({ ...post, media: [] }),
    async () => ({ ...post, media: Array.from({ length: 11 }, () => post.media![0]) })]) {
    const result = await addInstagramMedia(source, { content: fixed }, lookup, 1900);
    assert.equal(result.content, gallery);
    assert.equal(result.instagramPanel, undefined);
  }
});

test('a video post requires a video on its gallery card', async () => {
  const video = { ...post, mediaTypes: ['GraphVideo'], media: [{ type: 'video' as const, url: OFFLOAD }] };
  const result = await addInstagramMedia(source, { content: fixed }, async () => video, 1900);
  assert.deepEqual(result.instagramVideos, [source]);
  for (const kind of ['reel', 'reels', 'tv']) {
    const reel = source.replace('/p/', `/${kind}/`), provider = fixed.replace('/p/', `/${kind}/`);
    const reelResult = await addInstagramMedia(reel, { content: provider }, undefined, 1900);
    assert.equal(reelResult.content, gallery);
    assert.deepEqual(reelResult.instagramVideos, [reel]);
  }
});

test('messages with several links use gallery cards without any lookup', async () => {
  const other = 'https://www.instagram.com/p/Other/';
  for (const original of [`${source}\n${other}`, `${source}\nhttps://www.youtube.com/watch?v=u0_UyltqaFI`, `${source}\n${source}`]) {
    const rendered = original.replaceAll('www.instagram.com', 'oginstagram.com');
    const result = await addInstagramMedia(original, { content: rendered }, async () => assert.fail('one lookup per lone post only'), 1900);
    assert.equal(result.content, rendered.replaceAll('https://oginstagram.com', 'https://g.oginstagram.com'));
    assert.equal(result.instagramPanel, undefined);
  }
});

test('hidden links, unrelated provider links, rich presentations and oversized content are left alone', async () => {
  for (const hidden of [`<${source}>`, `||${source}||`, `\`${source}\``, `\`\`\`\n${source}\n\`\`\``]) {
    const presentation = { content: hidden };
    assert.equal(await addInstagramMedia(hidden, presentation, async () => assert.fail('hidden lookup'), 1900), presentation);
  }
  const unrelated = 'https://oginstagram.com/p/Unrelated/';
  const mixed = await addInstagramMedia(`${source}\nhttps://www.youtube.com/watch?v=u0_UyltqaFI`,
    { content: `${fixed}\n${unrelated}\n<${fixed}>\nhttps://www.youtube.com/watch?v=u0_UyltqaFI` }, undefined, 1900);
  assert.equal(mixed.content, `${gallery}\n${unrelated}\n<${fixed}>\nhttps://www.youtube.com/watch?v=u0_UyltqaFI`);
  const rich = { content: fixed, embeds: [{ description: 'Preserved X translation' }] };
  assert.equal(await addInstagramMedia(source, rich, async () => assert.fail('would suppress native media'), 1900), rich);
  const tooLong = { content: fixed + 'a'.repeat(2000) };
  assert.equal(await addInstagramMedia(source, tooLong, undefined, 1900), tooLong);
});

test('provider-looking links that are not the catalogued provider are not rewritten', async () => {
  for (const url of ['https://evil.test/p/DdFwAIqgncQ/', 'https://instagram7.com.evil.test/p/DdFwAIqgncQ/',
    'https://oginstagram.com.evil.test/p/DdFwAIqgncQ/', 'https://oginstagram.com:443/p/DdFwAIqgncQ/',
    'https://user@oginstagram.com/p/DdFwAIqgncQ/']) {
    const presentation = { content: url };
    assert.equal(await addInstagramMedia(source, presentation, undefined, 1900), presentation);
  }
});
