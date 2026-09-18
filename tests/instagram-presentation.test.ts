import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addInstagramCaptions, type CaptionPresentation } from '../src/services/InstagramPresentation';
import type { InstagramTranslation } from '../src/services/InstagramTranslation';

const source = 'https://www.instagram.com/p/DdFwAIqgncQ/';
const fixed = 'https://www.instagram7.com/p/DdFwAIqgncQ/';
const gallery = 'https://g.instagram7.com/p/DdFwAIqgncQ/';
const caption: InstagramTranslation = { sourceUrl: source, shortcode: 'DdFwAIqgncQ', username: 'bustervro',
  text: 'follow @bustervro for more memes\nRYONEX has become a notable name in Japan’s new generation of trap and melodic drill.',
  languages: ['et'], mediaOnlyUrl: gallery, mediaTypes: ['GraphImage'] };

test('Instagram captions replace provider text with English and a source-language label', async () => {
  const requests: string[] = [];
  const result = await addInstagramCaptions(source, { content: fixed }, async url => {
    requests.push(url); return caption;
  }, 1900);
  assert.deepEqual(requests, [source]);
  assert.ok(result.content.includes('RYONEX has become a notable name'));
  assert.ok(result.content.includes('Translated from Estonian'));
  assert.ok(result.content.startsWith(gallery));
  assert.equal(result.content.includes(fixed), false);
  assert.equal('embeds' in result, false);
  assert.deepEqual(result.instagramSources, [source]);
});

test('hidden links and existing rich presentations never expose a translated caption', async () => {
  for (const original of [`<${source}>`, `||${source}||`, `\`${source}\``, `\`\`\`\n${source}\n\`\`\``]) {
    const result = await addInstagramCaptions(original, { content: original }, async () => {
      assert.fail('hidden caption lookup');
    }, 1900);
    assert.equal(result.content, original);
  }
  const rich = { content: fixed, embeds: [{ description: 'Existing translated X photo' }] };
  assert.equal(await addInstagramCaptions(source, rich, async () => { assert.fail('would suppress native media'); }, 1900), rich);
});

test('lookup failure, wrong post and unavailable translations preserve the original preview', async () => {
  for (const lookup of [async () => null, async () => { throw new Error('unavailable'); },
    async () => ({ ...caption, shortcode: 'another' }), async () => ({ ...caption, mediaOnlyUrl: 'https://evil.test/video' })]) {
    const presentation = { content: fixed };
    assert.equal(await addInstagramCaptions(source, presentation, lookup, 1900), presentation);
  }
});

test('deduplicated captions preserve other platforms and escape caption formatting', async () => {
  let calls = 0;
  const original = `${source}\n${source}\nhttps://www.youtube.com/watch?v=u0_UyltqaFI`;
  const rendered = original.replaceAll(source, fixed);
  const result = await addInstagramCaptions(original, { content: rendered }, async () => {
    calls++; return { ...caption, text: '**Caption** @everyone https://example.com/extra' };
  }, 1900);
  assert.equal(calls, 1);
  assert.equal(result.content.split('Translated from Estonian').length, 2);
  assert.ok(result.content.includes('https://www.youtube.com/watch?v=u0_UyltqaFI'));
  assert.ok(result.content.includes('\\*\\*Caption\\*\\*'));
  assert.ok(result.content.includes('<https://example.com/extra>'));
});

test('long captions are short excerpts even when the full caption fits Discord', async () => {
  const post = { ...caption, text: 'A complete English caption.\n\n'.repeat(35) + 'END OF CAPTION' };
  const result = await addInstagramCaptions<CaptionPresentation>(source, { content: fixed }, async () => post, 1900);
  const excerpt = result.content.match(/\*\*\n([^\n]+)\n-#/)?.[1];
  assert.ok(excerpt && excerpt.length <= 300 && excerpt.endsWith('…'));
  assert.ok(!result.content.includes('END OF CAPTION'));
  assert.ok(result.content.startsWith(gallery));
  assert.equal(result.translationFiles, undefined);
  assert.ok(result.content.includes('Translated from Estonian'));
});

test('a caption URL crossing the cut is omitted without creating a partial link or attachment', async () => {
  const url = 'https://example.com/' + 'a'.repeat(1400);
  const post = { ...caption, text: `See ${url}` };
  const result = await addInstagramCaptions<CaptionPresentation>(source, { content: fixed }, async () => post, 1000);
  assert.ok(result.content.length <= 1000);
  assert.ok(result.content.includes('Translated from Estonian'));
  assert.equal(result.content.includes('https://example.com'), false);
  assert.equal((result.content.match(/</g) ?? []).length, (result.content.match(/>/g) ?? []).length);
  assert.ok(result.content.includes('See…'));
  assert.equal(result.translationFiles, undefined);
});

test('caption truncation keeps emoji clusters intact', async () => {
  const post = { ...caption, text: 'A'.repeat(280) + '👨‍👩‍👧‍👦'.repeat(30) };
  const result = await addInstagramCaptions(source, { content: fixed }, async () => post, 1900);
  const excerpt = result.content.match(/\*\*\n([^\n]+)\n-#/)![1];
  assert.ok(excerpt.length <= 300 && excerpt.endsWith('…'));
  assert.match(excerpt, /^A{280}(?:👨‍👩‍👧‍👦)+…$/);
});

test('multiple captions share a tight message budget and all retain their labels and media', async () => {
  const posts = ['One', 'Two', 'Three'].map(shortcode => ({ ...caption, shortcode,
    sourceUrl: `https://www.instagram.com/p/${shortcode}/`, mediaOnlyUrl: `https://g.instagram7.com/p/${shortcode}/`,
    text: 'A long caption. '.repeat(80) }));
  const original = posts.map(post => post.sourceUrl).join('\n');
  const content = original.replaceAll('www.instagram.com', 'www.instagram7.com');
  const result = await addInstagramCaptions(original, { content }, async url => posts.find(post => post.sourceUrl === url)!, 510);
  assert.ok(result.content.length <= 510);
  assert.deepEqual(result.instagramSources, posts.map(post => post.sourceUrl));
  assert.equal(result.content.split('Translated from Estonian').length, 4);
  for (const post of posts) assert.ok(result.content.includes(post.mediaOnlyUrl));
  assert.equal((result.content.match(/…/g) ?? []).length, 3);
});

test('insufficient room for the author and language label preserves the normal preview', async () => {
  const presentation = { content: fixed };
  assert.equal(await addInstagramCaptions(source, presentation, async () => caption, 90), presentation);
});

test('Compact limits translated captions to 120 characters and retains attribution and source metadata', async () => {
  const post = { ...caption, text: 'A'.repeat(100) + '👨‍👩‍👧‍👦'.repeat(30) };
  const result = await addInstagramCaptions(source, { content: fixed }, async () => post, 1900, 'compact');
  const excerpt = result.content.match(/\*\*\n([^\n]+)\n-#/)![1];
  assert.ok(excerpt.length <= 120 && excerpt.endsWith('…'));
  assert.match(excerpt, /^A{100}(?:👨‍👩‍👧‍👦)+…$/);
  assert.ok(result.content.includes('[@bustervro]'));
  assert.ok(result.content.includes('Translated from Estonian'));
  assert.deepEqual(result.instagramSources, [source]);
  assert.deepEqual(result.instagramCaptionSources, [source]);
  assert.equal(result.content.startsWith(gallery), true);
});

test('Media-first selects caption-free media without calling translation or adding caption text', async () => {
  for (const lookup of [undefined, async () => assert.fail('Media-first must not translate')]) {
    const result = await addInstagramCaptions(source, { content: `My message\n${fixed}` }, lookup, 1900, 'media-first');
    assert.equal(result.content, `My message\n${gallery}`);
    assert.deepEqual(result.instagramSources, [source]);
    assert.deepEqual(result.instagramVideos, []);
    assert.equal(result.instagramCaptionSources, undefined);
  }
});

test('Media-first preserves other platforms, hidden links and explicit embeds with bounded content', async () => {
  const unrelated = 'https://www.instagram7.com/p/Unrelated/';
  const result = await addInstagramCaptions(`${source}\nhttps://www.youtube.com/watch?v=u0_UyltqaFI`,
    { content: `${fixed}\n${unrelated}\n<${fixed}>\nhttps://www.youtube.com/watch?v=u0_UyltqaFI` }, undefined, 1900, 'media-first');
  assert.equal(result.content, `${gallery}\n${unrelated}\n<${fixed}>\nhttps://www.youtube.com/watch?v=u0_UyltqaFI`);
  const rich = { content: fixed, embeds: [{ description: 'Preserved X translation' }] };
  assert.equal(await addInstagramCaptions(source, rich, undefined, 1900, 'media-first'), rich);
  const tooLong = { content: fixed + 'a'.repeat(2000) };
  assert.equal(await addInstagramCaptions(source, tooLong, undefined, 1900, 'media-first'), tooLong);
  for (const hidden of [`<${source}>`, `||${source}||`, `\`${source}\``]) {
    const presentation = { content: hidden };
    assert.equal(await addInstagramCaptions(hidden, presentation, undefined, 1900, 'media-first'), presentation);
  }
});

test('Media-first preserves reel and TV video verification requirements without trusting arbitrary provider URLs', async () => {
  for (const kind of ['reel', 'reels', 'tv']) {
    const reel = source.replace('/p/', `/${kind}/`), provider = fixed.replace('/p/', `/${kind}/`);
    const result = await addInstagramCaptions(reel, { content: provider }, undefined, 1900, 'media-first');
    assert.equal(result.content, gallery);
    assert.deepEqual(result.instagramVideos, [reel]);
  }
  for (const url of ['https://evil.test/p/DdFwAIqgncQ/', 'https://instagram7.com.evil.test/p/DdFwAIqgncQ/']) {
    const presentation = { content: url };
    assert.equal(await addInstagramCaptions(source, presentation, undefined, 1900, 'media-first'), presentation);
  }
});

test('Standard and Compact leave native provider text unchanged without a translation lookup', async () => {
  const presentation = { content: fixed };
  for (const style of ['standard', 'compact'] as const) {
    assert.equal(await addInstagramCaptions(source, presentation, undefined, 1900, style), presentation);
  }
});
