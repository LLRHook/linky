import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTweetLookup, fetchTweetStatus, fetchTweetTranslation } from '../src/services/TweetTranslation';

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
    url: 'https://x.com/i/status/1802857036474167769',
    author: { name: 'Nintendo', url: 'https://x.com/Nintendo', icon_url: 'https://pbs.twimg.com/avatar.jpg' },
    photos: [], media: [], hasMedia: false, hasVideo: false,
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

test('keeps native previews for unsupported quotes, polls, broadcasts, and external media', async () => {
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

test('returns complete long translations so the renderer can split them safely', async () => {
  const result = await fetchTweetTranslation('20', jsonFetch(payload({
    translation: { text: 'a'.repeat(4_583), source_lang: 'ja', target_lang: 'en' },
  })));
  assert.equal(result?.text, 'a'.repeat(4_583));
  const escaped = await fetchTweetTranslation('20', jsonFetch(payload({
    translation: { text: '*'.repeat(2_049), source_lang: 'ja', target_lang: 'en' },
  })));
  assert.equal(escaped?.text, '\\*'.repeat(2_049));
});

test('translates a Japanese root and Korean quote while retaining the quoted video', async () => {
  const result = await fetchTweetTranslation('20', jsonFetch(payload({
    url: 'https://x.com/root/status/20',
    quote: payload({
      id: '21', url: 'https://x.com/quoted/status/21', lang: 'ko',
      author: { name: 'Quoted author', url: 'https://x.com/quoted', screen_name: 'quoted_author' },
      translation: { text: 'The quoted video.', source_lang: 'ko', target_lang: 'en' },
      media: { all: [{ type: 'video', url: 'https://video.twimg.com/quoted.mp4', width: 1080, height: 1920 }] },
    }).status,
  })));
  assert.equal(result?.text, 'An English announcement.');
  assert.equal(result?.language, 'Japanese');
  assert.equal(result?.url, 'https://x.com/root/status/20');
  assert.equal(result?.hasMedia, false);
  assert.equal(result?.hasVideo, false);
  assert.deepEqual(result?.quote, {
    text: 'The quoted video.', language: 'Korean', url: 'https://x.com/quoted/status/21',
    author: { name: 'Quoted author', url: 'https://x.com/quoted', handle: 'quoted_author' },
    photos: [], media: [{ type: 'video', url: 'https://video.twimg.com/quoted.mp4', width: 1080, height: 1920 }],
    hasMedia: true, hasVideo: true,
  });
});

test('keeps only well-formed handles and plausible media dimensions', async () => {
  const result = await fetchTweetTranslation('20', jsonFetch(payload({
    author: { name: 'Nintendo', url: 'https://x.com/Nintendo', screen_name: 'not a handle' },
    media: { all: [
      { type: 'photo', url: 'https://pbs.twimg.com/one.jpg', width: 0, height: 10 },
      { type: 'gif', url: 'https://video.twimg.com/two.mp4', width: 640, height: 360 },
    ] },
  })));
  assert.equal(result?.author.handle, undefined);
  assert.deepEqual(result?.media, [
    { type: 'photo', url: 'https://pbs.twimg.com/one.jpg' },
    { type: 'gif', url: 'https://video.twimg.com/two.mp4', width: 640, height: 360 },
  ]);
});

test('retains root video and separately translated quoted text', async () => {
  const result = await fetchTweetTranslation('20', jsonFetch(payload({
    lang: 'ko', translation: { text: 'Root video.', source_lang: 'ko', target_lang: 'en' },
    media: { all: [{ type: 'video', url: 'https://video.twimg.com/root.mp4' }] },
    quote: payload({
      id: '21', lang: 'ko',
      translation: { text: 'Quoted context.', source_lang: 'ko', target_lang: 'en' },
    }).status,
  })));
  assert.equal(result?.text, 'Root video.');
  assert.equal(result?.hasVideo, true);
  assert.equal(result?.quote?.text, 'Quoted context.');
  assert.equal(result?.quote?.hasMedia, false);
  assert.equal(result?.quote?.hasVideo, false);
  assert.equal(result?.quote?.url, 'https://x.com/i/status/21');
});

test('preserves an English quote without labelling its original text as translated', async () => {
  const result = await fetchTweetTranslation('20', jsonFetch(payload({
    quote: payload({
      id: '21', lang: 'en-GB', text: 'Original English context.', translation: null,
      author: { name: 'English author', url: 'https://x.com/english' },
      media: { all: [{ type: 'photo', url: 'https://pbs.twimg.com/quoted.jpg' }] },
    }).status,
  })));
  assert.equal(result?.quote?.text, 'Original English context.');
  assert.equal(result?.quote?.language, 'English');
  assert.equal(result?.quote?.author.name, 'English author');
  assert.deepEqual(result?.quote?.photos, ['https://pbs.twimg.com/quoted.jpg']);
  assert.equal(result?.hasMedia, false);
  assert.equal(result?.quote?.hasMedia, true);
});

test('translates a foreign quote under an English root and skips an entirely English chain', async () => {
  const english = { lang: 'en', text: 'An English comment.', translation: null };
  const result = await fetchTweetTranslation('20', jsonFetch(payload({
    ...english, quote: payload({ id: '21' }).status,
  })));
  assert.equal(result?.text, 'An English comment.');
  assert.equal(result?.language, 'English');
  assert.equal(result?.quote?.language, 'Japanese');
  assert.equal(result?.quote?.text, 'An English announcement.');
  assert.equal(await fetchTweetTranslation('20', jsonFetch(payload({
    ...english, quote: payload({ id: '21', ...english }).status,
  }))), null);
});

test('translates quoted text beneath an empty post without a detected language and preserves its media', async () => {
  const result = await fetchTweetTranslation('20', jsonFetch(payload({
    text: '', lang: null, translation: null,
    media: { all: [{ type: 'photo', url: 'https://pbs.twimg.com/root.jpg' }] },
    quote: payload({ id: '21' }).status,
  })));
  assert.equal(result?.text, '');
  assert.equal(result?.language, null);
  assert.deepEqual(result?.photos, ['https://pbs.twimg.com/root.jpg']);
  assert.equal(result?.quote?.text, 'An English announcement.');
  assert.equal(result?.quote?.language, 'Japanese');
});

test('empty posts do not authorize unknown-language prose, malformed quotes or untranslated chains', async () => {
  const empty = { text: '', lang: null, translation: null };
  for (const status of [
    empty,
    { ...empty, media: { all: [{ type: 'photo', url: 'https://pbs.twimg.com/root.jpg' }] } },
    { ...empty, quote: payload({ id: '21', lang: 'en', text: 'English context.', translation: null }).status },
    { ...empty, quote: payload({ id: '21', lang: null }).status },
    { ...empty, quote: { type: 'tombstone' } },
    { ...empty, text: 'Unknown language prose', quote: payload({ id: '21' }).status },
  ]) assert.equal(await fetchTweetTranslation('20', jsonFetch(payload(status))), null);
});

test('preserves two nested quotes and rejects deeper chains without dropping their context', async () => {
  const leaf = payload({ id: '22' }).status;
  const result = await fetchTweetTranslation('20', jsonFetch(payload({
    quote: payload({ id: '21', quote: leaf }).status,
  })));
  assert.equal(result?.quote?.quote?.url, 'https://x.com/i/status/22');
  assert.equal(await fetchTweetTranslation('20', jsonFetch(payload({
    quote: payload({ id: '21', quote: payload({ id: '22', quote: payload({ id: '23' }).status }).status }).status,
  }))), null);
});

test('a malformed nested quote keeps the complete native preview', async () => {
  for (const quote of [
    false, [], {}, { type: 'tombstone' }, payload({ id: '21', translation: null }).status,
    payload({ id: '21', translation: { text: 'Wrong target.', source_lang: 'ja', target_lang: 'ko' } }).status,
    payload({ id: '21', poll: { choices: [] } }).status,
    payload({ id: '21', media: { broadcast: { url: 'https://x.com/i/broadcasts/1' } } }).status,
    payload({ id: '21', media: { external: { url: 'https://youtube.com/watch?v=1' } } }).status,
  ]) assert.equal(await fetchTweetTranslation('20', jsonFetch(payload({ quote }))), null);
});

test('uses canonical X status URLs or numeric IDs and never an arbitrary quote authority', async () => {
  const result = await fetchTweetTranslation('20', jsonFetch(payload({
    url: 'https://twitter.com/root/status/20/?s=46#part',
    quote: payload({ url: 'https://x.com/quoted/status/21?s=46' }).status,
  })));
  assert.equal(result?.url, 'https://x.com/root/status/20');
  assert.equal(result?.quote?.url, 'https://x.com/quoted/status/21');
  for (const url of [
    'https://fixupx.com/u/status/21', 'https://x.com.evil/u/status/21',
    'http://x.com/u/status/21', 'https://x.com:444/u/status/21',
    'https://x.com/u/status/21/photo/invalid', 'https://user:pass@x.com/u/status/21',
  ]) {
    assert.equal(await fetchTweetTranslation('20', jsonFetch(payload({ quote: payload({ url }).status }))), null);
    const fallback = await fetchTweetTranslation('20', jsonFetch(payload({ quote: payload({ id: '21', url }).status })));
    assert.equal(fallback?.quote?.url, 'https://x.com/i/status/21');
  }
  for (const id of ['../21', '21?lang=ko', '2'.repeat(21), 21]) {
    assert.equal(await fetchTweetTranslation('20', jsonFetch(payload({ quote: payload({ id }).status }))), null);
  }
});

test('rejects excessively large translations without truncating accepted text', async () => {
  const maximum = await fetchTweetTranslation('20', jsonFetch(payload({
    translation: { text: 'a'.repeat(100_000), source_lang: 'ja', target_lang: 'en' },
  })));
  assert.equal(maximum?.text.length, 100_000);
  for (const text of ['a'.repeat(100_001), '*'.repeat(50_001)]) {
    assert.equal(await fetchTweetTranslation('20', jsonFetch(payload({
      translation: { text, source_lang: 'ja', target_lang: 'en' },
    }))), null);
  }
});

test('a one-post block reads the status as written, in any language, without asking for a translation', async () => {
  const requests: string[] = [];
  const photo = { all: [{ type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg' }] };
  const status = await fetchTweetStatus('20', { translate: false }, async (url, options) => {
    requests.push(String(url));
    assert.equal(options?.redirect, 'error');
    assert.ok(options?.signal instanceof AbortSignal);
    return new Response(JSON.stringify(payload({ translation: undefined, media: photo })));
  });
  assert.deepEqual(requests, ['https://api.fxtwitter.com/2/status/20'], 'only the status ID is sent');
  assert.equal(status.translation, null);
  assert.equal(status.post?.text, 'Original Japanese text');
  assert.equal(status.post?.language, null, 'words as written carry no Translated from label');
  assert.deepEqual(status.post?.media, [{ type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg' }]);
  for (const lang of ['und', null, undefined]) {
    assert.equal((await fetchTweetStatus('20', { translate: false }, jsonFetch(payload({ lang })))).post?.text,
      'Original Japanese text', `language ${String(lang)} is still shown as written`);
  }
  for (const extra of [{ poll: { choices: [] } }, { media: { broadcast: {} } }, { media: { external: {} } }]) {
    for (const translate of [false, true]) {
      assert.deepEqual(await fetchTweetStatus('20', { translate }, jsonFetch(payload(extra))), { post: null, translation: null },
        'polls, broadcasts and external media keep the native card');
    }
  }
  assert.deepEqual(await fetchTweetStatus('../20', { translate: false }, async () => assert.fail('must not fetch')), { post: null, translation: null });
});

test('with translation requested, English posts keep their words and other languages show the translation', async () => {
  const english = await fetchTweetStatus('20', { translate: true }, async url => {
    assert.equal(String(url), 'https://api.fxtwitter.com/2/status/20?lang=en');
    return new Response(JSON.stringify(payload({ lang: 'en', text: 'Plain English.', translation: undefined })));
  });
  assert.equal(english.translation, null, 'an English post is no translation');
  assert.equal(english.post?.text, 'Plain English.', 'an English post still has a block');
  assert.equal(english.post?.language, null);
  const foreign = await fetchTweetStatus('20', { translate: true }, jsonFetch(payload()));
  assert.equal(foreign.post?.text, 'An English announcement.');
  assert.equal(foreign.post?.language, 'Japanese');
  assert.equal(foreign.translation, foreign.post);
  const untranslated = await fetchTweetStatus('20', { translate: true }, jsonFetch(payload({ translation: null })));
  assert.equal(untranslated.translation, null);
  assert.equal(untranslated.post?.text, 'Original Japanese text', 'a post FxTwitter did not translate is shown as written');
  assert.equal(untranslated.post?.language, null);
});

test('the shared status lookup sends one request per status and mode for five minutes, 30 s after a failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const requests: string[] = [];
  let failing = false;
  const lookup = createTweetLookup(async url => {
    requests.push(String(url));
    return failing ? new Response('{}', { status: 503 }) : new Response(JSON.stringify(payload()));
  });
  const [first, second] = await Promise.all([lookup('20', { translate: true }), lookup('20', { translate: true })]);
  assert.deepEqual(requests, ['https://api.fxtwitter.com/2/status/20?lang=en'], 'concurrent callers share one request');
  assert.equal(first.translation?.text, 'An English announcement.');
  first.post!.text = 'changed by a caller';
  assert.equal(second.post?.text, 'An English announcement.');
  assert.equal((await lookup('20', { translate: true })).post?.text, 'An English announcement.', 'each caller gets its own copy');
  assert.equal((await lookup('20', { translate: false })).post?.text, 'Original Japanese text');
  assert.deepEqual(requests, ['https://api.fxtwitter.com/2/status/20?lang=en', 'https://api.fxtwitter.com/2/status/20']);
  t.mock.timers.tick(5 * 60_000 - 1);
  await lookup('20', { translate: true });
  assert.equal(requests.length, 2, 'a result is kept for five minutes');
  t.mock.timers.tick(1);
  await lookup('20', { translate: true });
  assert.equal(requests.length, 3);
  failing = true;
  assert.deepEqual(await lookup('21', { translate: true }), { post: null, translation: null });
  t.mock.timers.tick(29_999);
  await lookup('21', { translate: true });
  assert.equal(requests.length, 4, 'a failure is kept for 30 s');
  t.mock.timers.tick(1);
  await lookup('21', { translate: true });
  assert.equal(requests.length, 5);
});

test('the status lookup refuses a ninth concurrent request and does not keep very long posts', async () => {
  const gates: (() => void)[] = [];
  let requests = 0;
  const lookup = createTweetLookup(async () => {
    requests++;
    await new Promise<void>(resolve => gates.push(resolve));
    return new Response(JSON.stringify(payload()));
  });
  const waiting = Array.from({ length: 8 }, (_, index) => lookup(String(100 + index), { translate: true }));
  assert.deepEqual(await lookup('200', { translate: true }), { post: null, translation: null });
  assert.equal(requests, 8, 'at most eight lookups are in flight');
  gates.forEach(open => open());
  assert((await Promise.all(waiting)).every(status => status.post?.text === 'An English announcement.'));
  let longRequests = 0;
  const long = createTweetLookup(async () => {
    longRequests++;
    return new Response(JSON.stringify(payload({ translation: { text: 'a'.repeat(50_001), source_lang: 'ja', target_lang: 'en' } })));
  });
  assert.equal((await long('20', { translate: true })).post?.text.length, 50_001, 'a long post is still returned');
  await long('20', { translate: true });
  assert.equal(longRequests, 2, 'a status above 50,000 characters is not cached');
});

test('the status lookup reads at most 1 MiB of a response and keeps at most 100 statuses', async () => {
  const sized = (bytes: number) => {
    const base = JSON.stringify({ ...payload(), padding: '' });
    return async () => new Response(JSON.stringify({ ...payload(), padding: 'x'.repeat(bytes - base.length) }));
  };
  assert.equal((await fetchTweetStatus('20', { translate: true }, sized(1024 * 1024))).post?.text, 'An English announcement.',
    'a 1 MiB body is read');
  assert.deepEqual(await fetchTweetStatus('20', { translate: true }, sized(1024 * 1024 + 1)), { post: null, translation: null },
    'one byte more keeps the native card');
  const requested: string[] = [];
  const lookup = createTweetLookup(async url => { requested.push(String(url)); return new Response(JSON.stringify(payload())); });
  for (let id = 1; id <= 101; id++) await lookup(String(id), { translate: true });
  assert.equal(requested.length, 101);
  await lookup('101', { translate: true });
  await lookup('2', { translate: true });
  assert.equal(requested.length, 101, 'the newest 100 statuses stay cached');
  await lookup('1', { translate: true });
  assert.equal(requested.length, 102, 'the oldest status was dropped to keep 100');
});
