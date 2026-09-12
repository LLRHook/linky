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

test('long captions retain their complete text in an attachment and respect message limits', async () => {
  const post = { ...caption, text: 'A complete English caption. '.repeat(180) };
  const result = await addInstagramCaptions<CaptionPresentation>(source, { content: fixed }, async () => post, 1000);
  assert.ok(result.content.length <= 1000);
  assert.ok(result.content.startsWith(gallery));
  assert.equal(result.translationFiles?.length, 1);
  const attachment = result.translationFiles![0].attachment as Buffer;
  assert.ok(attachment.toString().includes(post.text));
  assert.ok(result.content.includes('Full English Instagram caption attached.'));
  assert.ok(result.content.includes('Translated from Estonian'));
});

test('a long caption URL stays intact in the attachment with a visible source-language label', async () => {
  const url = 'https://example.com/' + 'a'.repeat(1400);
  const post = { ...caption, text: `See ${url}` };
  const result = await addInstagramCaptions<CaptionPresentation>(source, { content: fixed }, async () => post, 1000);
  assert.ok(result.content.length <= 1000);
  assert.ok(result.content.includes('Translated from Estonian'));
  assert.equal(result.content.includes('https://example.com'), false);
  assert.equal((result.content.match(/</g) ?? []).length, (result.content.match(/>/g) ?? []).length);
  assert.ok((result.translationFiles![0].attachment as Buffer).toString().includes(url));
});
