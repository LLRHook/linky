import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchTweetTranslation } from '../src/services/TweetTranslation';

function payload(status: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: 200,
    status: {
      type: 'status', lang: 'ja', text: 'Original Japanese text',
      author: { name: 'Nintendo', url: 'https://x.com/Nintendo', avatar_url: 'https://pbs.twimg.com/avatar.jpg' },
      translation: { text: 'An English announcement.', source_lang: 'ja', target_lang: 'en' },
      media: {}, ...status,
    },
  };
}

const jsonFetch = (json: unknown): typeof fetch => async () => new Response(JSON.stringify(json));

test('fetches English-only text and derives the source language without source_lang_en', async () => {
  const result = await fetchTweetTranslation('1802857036474167769', async (url, options) => {
    assert.equal(url, 'https://api.fxtwitter.com/2/status/1802857036474167769?lang=en');
    assert.ok(options?.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    return new Response(JSON.stringify(payload()));
  });
  assert.deepEqual(result, {
    text: 'An English announcement.', language: 'Japanese',
    author: { name: 'Nintendo', url: 'https://x.com/Nintendo', icon_url: 'https://pbs.twimg.com/avatar.jpg' },
    photos: [], hasMedia: false, hasVideo: false,
  });
});

test('rejects invalid status IDs without making a request', async () => {
  for (const id of ['', '../20', '20?lang=ja', '1'.repeat(21)]) {
    assert.equal(await fetchTweetTranslation(id, async () => assert.fail('must not fetch')), null);
  }
});

test('fails open on HTTP errors, rejected requests, and malformed JSON', async () => {
  for (const fetchJson of [
    async () => new Response('{}', { status: 503 }),
    async () => { throw new Error('offline'); },
    async () => new Response('{broken'),
  ] as typeof fetch[]) assert.equal(await fetchTweetTranslation('20', fetchJson), null);
});

test('requires a successful v2 status and a matching English translation', async () => {
  const invalid = [null, [], { code: 404, status: payload().status }, { code: 200 },
    payload({ type: 'tombstone' }), payload({ translation: null }),
    payload({ translation: { text: '', source_lang: 'ja', target_lang: 'en' } }),
    payload({ translation: { text: '  \n', source_lang: 'ja', target_lang: 'en' } }),
    payload({ translation: { text: 123, source_lang: 'ja', target_lang: 'en' } }),
    payload({ translation: { text: 'Hello', source_lang: 'ko', target_lang: 'en' } }),
    payload({ translation: { text: 'Hello', source_lang: 'ja', target_lang: 'fr' } }),
    payload({ translation: { text: 'Hello', target_lang: 'en' } }),
  ];
  for (const json of invalid) assert.equal(await fetchTweetTranslation('20', jsonFetch(json)), null);
});

test('skips English and indeterminate languages, while accepting regional source tags', async () => {
  for (const lang of ['en', 'en-GB', 'und', 'zxx', 'mul', 'und-Latn', '', null, 5, 'ja_XX']) {
    assert.equal(await fetchTweetTranslation('20', jsonFetch(payload({ lang }))), null);
  }
  const result = await fetchTweetTranslation('20', jsonFetch(payload({
    lang: 'ZH-cn', translation: { text: 'Hello', source_lang: 'zh-TW', target_lang: 'en' },
  })));
  assert.equal(result?.language, 'Chinese');
});

test('escapes translated prose and shortens URL labels without losing query targets', async () => {
  const text = '**News** @everyone <@123>\nhttps://nintendo.com/news/direct?utm_source=x&item=1\n' +
    '(https://example.com/one_(two)).';
  const result = await fetchTweetTranslation('20', jsonFetch(payload({
    translation: { text, source_lang: 'ja', target_lang: 'en' },
  })));
  assert.equal(result?.text, '\\*\\*News\\*\\* @everyone \\<@123\\>\n' +
    '[nintendo.com/news/direct](<https://nintendo.com/news/direct?utm_source=x&item=1>)\n' +
    '\\([example.com/one_(two)](<https://example.com/one_(two)>)\\).');
  assert.ok(!result?.text.includes('Original Japanese text'));
});

test('keeps underscores readable inside masked link labels and escapes only link delimiters', async () => {
  const result = await fetchTweetTranslation('20', jsonFetch(payload({
    translation: {
      text: 'https://nintendo.com/nintendo_direct https://example.com/a[b]',
      source_lang: 'ja', target_lang: 'en',
    },
  })));
  assert.equal(result?.text, '[nintendo.com/nintendo_direct](<https://nintendo.com/nintendo_direct>) ' +
    '[example.com/a\\[b\\]](<https://example.com/a[b]>)');
  assert.ok(!result?.text.includes('\\_'));
});

test('limits URL labels and keeps unsupported HTTP links from creating previews', async () => {
  const url = `https://example.com/${'long'.repeat(25)}?tracking=kept`;
  const result = await fetchTweetTranslation('20', jsonFetch(payload({
    translation: { text: `${url} http://example.com/a`, source_lang: 'ja', target_lang: 'en' },
  })));
  assert.ok(result?.text.includes(`](<${url}>)`));
  assert.equal(result?.text.match(/^\[(.*?)\]/)?.[1].length, 60);
  assert.ok(result?.text.endsWith('`http://example.com/a`'));
});

test('uses only validated photo and video metadata and ignores external card images', async () => {
  const result = await fetchTweetTranslation('20', jsonFetch(payload({
    media: { all: [
      { type: 'photo', url: 'https://pbs.twimg.com/photo.jpg' },
      { type: 'photo', url: 'javascript:alert(1)' },
      { type: 'photo', url: 'https://pbs.twimg.com/photo.jpg' },
      { type: 'video', url: 'https://video.twimg.com/movie.mp4' },
      { type: 'unknown', url: 'https://example.com/file' }, null,
    ] },
    card: { image: { url: 'https://example.com/unrelated.jpg' } },
  })));
  assert.deepEqual(result?.photos, ['https://pbs.twimg.com/photo.jpg']);
  assert.equal(result?.hasMedia, true);
  assert.equal(result?.hasVideo, true);
  const empty = await fetchTweetTranslation('20', jsonFetch(payload({
    media: { all: [{ type: 'video', url: 'file:///private.mp4' }] },
    card: { image: { url: 'https://example.com/unrelated.jpg' } },
  })));
  assert.equal(empty?.hasMedia, false);
});

test('caps photos at four and treats GIF media as playable media', async () => {
  const result = await fetchTweetTranslation('20', jsonFetch(payload({
    media: { all: [
      ...Array.from({ length: 6 }, (_, i) => ({ type: 'photo', url: `https://pbs.twimg.com/${i}.jpg` })),
      { type: 'gif', url: 'https://video.twimg.com/animated.mp4' },
    ] },
  })));
  assert.equal(result?.photos.length, 4);
  assert.equal(result?.hasVideo, true);
});

test('keeps native previews for quotes, polls, broadcasts, and externally hosted media', async () => {
  for (const status of [
    { quote: { type: 'status', text: 'Quoted context' } },
    { quote: { type: 'tombstone', reason: 'deleted' } },
    { poll: { choices: [{ label: 'One' }, { label: 'Two' }] } },
    { media: { broadcast: { url: 'https://x.com/i/broadcasts/example' } } },
    { media: { external: { url: 'https://youtube.com/watch?v=example' } } },
  ]) assert.equal(await fetchTweetTranslation('20', jsonFetch(payload(status))), null);
  assert.ok(await fetchTweetTranslation('20', jsonFetch(payload({
    quote: null, poll: null, media: { broadcast: null, external: null },
  }))));
});

test('requires a valid author and excludes unsafe optional author icons', async () => {
  for (const author of [null, {}, { name: '', url: 'https://x.com/a' },
    { name: 'Author', url: 'http://x.com/a' }, { name: 'Author', url: 'https://user:pass@x.com/a' }]) {
    assert.equal(await fetchTweetTranslation('20', jsonFetch(payload({ author }))), null);
  }
  const result = await fetchTweetTranslation('20', jsonFetch(payload({
    author: { name: 'A'.repeat(300), url: 'https://x.com/a', avatar_url: 'data:image/png;base64,AA==' },
  })));
  assert.equal(result?.author.name.length, 256);
  assert.equal(result?.author.icon_url, undefined);
});

test('returns null instead of truncating translations that exceed the embed limit after formatting', async () => {
  for (const text of ['a'.repeat(4_097), '*'.repeat(2_049)]) {
    assert.equal(await fetchTweetTranslation('20', jsonFetch(payload({
      translation: { text, source_lang: 'ja', target_lang: 'en' },
    }))), null);
  }
  const result = await fetchTweetTranslation('20', jsonFetch(payload({
    translation: { text: 'a'.repeat(4_096), source_lang: 'ja', target_lang: 'en' },
  })));
  assert.equal(result?.text.length, 4_096);
});
