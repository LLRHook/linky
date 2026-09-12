import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createYouTubeLookup, findYouTubeLinks, formatYouTubeStatistics, parseYouTubeUrl } from '../src/services/YouTube';

const A = 'dQw4w9WgXcQ', B = 'abcdefghijk', C = '0123456789_';
const native = (id = A) => `https://www.youtube.com/watch?v=${id}`;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const video = (id = A, statistics: unknown = { viewCount: '12345', likeCount: '0', commentCount: '20' }, status: unknown = { privacyStatus: 'public', embeddable: true }) => ({ id, statistics, status });
const comment = (id = A, text = 'A useful comment', author = 'Viewer') => ({ items: [{ snippet: {
  videoId: id, topLevelComment: { snippet: { textDisplay: text, authorDisplayName: author } },
} }] });

test('recognizes only supported YouTube video shapes and retains valid timestamps', () => {
  for (const host of ['youtube.com', 'www.youtube.com', 'm.youtube.com']) {
    for (const path of [`watch?v=${A}`, `shorts/${A}`, `live/${A}/`, `embed/${A}`]) {
      assert.deepEqual(parseYouTubeUrl(`https://${host}/${path}`), { id: A, url: native() });
    }
  }
  assert.equal(parseYouTubeUrl(`https://youtu.be/${A}?si=tracking&t=1h2m3s`)?.url, native() + '&t=3723');
  assert.equal(parseYouTubeUrl(native() + '&start=90&feature=shared')?.url, native() + '&t=90');
  assert.equal(parseYouTubeUrl(native() + '&t=0')?.url, native() + '&t=0');
  for (const invalid of ['-1', '1.5', 'tomorrow', '1m2h', '999999999999999999999']) {
    assert.equal(parseYouTubeUrl(native() + '&t=' + invalid)?.url, native());
  }
});

test('rejects credentials, explicit ports, lookalikes, nested URLs and non-video links', () => {
  for (const url of [
    `http://youtu.be/${A}`, `https://www.youtu.be/${A}`, `https://youtube.com.evil.test/watch?v=${A}`,
    `https://youtube.com:443/watch?v=${A}`, `https://user@youtube.com/watch?v=${A}`,
    `https://evil.test/?url=${native()}`, `https://youtube.com/redirect?url=${native()}`,
    `https://youtube.com/watch?v=${A}&v=${B}`, 'https://youtube.com/playlist?list=abc',
    'https://youtube.com/@creator', `https://youtu.be/${A}/more`,
    `https://youtube.com/shorts/${A}%2fmore`, `https://youtube.com/../watch?v=${A}`,
    `https://youtube.com\\@evil.test/watch?v=${A}`, `https://youtu.be/${A}\n`,
  ]) assert.equal(parseYouTubeUrl(url), null, url);
});

test('finds at most five unique visible videos without revealing suppressed content', () => {
  const more = Array.from({ length: 8 }, (_, i) => `https://youtu.be/V${String(i).padStart(10, '0')}`);
  const content = `<${native()}> \`${native(B)}\` ||${native(C)}|| https://evil.test/?next=${native()}\n` + more.join(' ') + ' ' + more[0];
  assert.deepEqual(findYouTubeLinks(content).map(link => link.id), more.slice(0, 5).map(url => url.slice(-11)));
  assert.deepEqual(findYouTubeLinks(`[watch](${native()}) and ${native()}!`).map(link => link.id), [A]);
});

test('batches overlapping requests, uses only the public API and caches available counts/comments', async () => {
  let time = 0;
  const calls: URL[] = [];
  const lookup = createYouTubeLookup('test-key', { now: () => time, fetch: async (input, options) => {
    const url = new URL(String(input)); calls.push(url);
    assert.equal(url.origin, 'https://www.googleapis.com');
    assert(!url.href.includes('test-key'));
    assert.equal(new Headers(options?.headers).get('X-Goog-Api-Key'), 'test-key');
    assert.equal(options?.redirect, 'error');
    assert(options?.signal instanceof AbortSignal);
    if (url.pathname.endsWith('/videos')) {
      assert.equal(url.searchParams.get('part'), 'statistics,status');
      return json({ items: url.searchParams.get('id')!.split(',').map(id => video(id)) });
    }
    assert.equal(url.searchParams.get('order'), 'relevance');
    assert.equal(url.searchParams.get('maxResults'), '1');
    assert.equal(url.searchParams.get('textFormat'), 'plainText');
    return json(comment(url.searchParams.get('videoId')!));
  } });
  const [first, second] = await Promise.all([lookup([A, B]), lookup([B, C])]);
  assert.equal(calls.filter(url => url.pathname.endsWith('/videos')).length, 1);
  assert.equal(calls.length, 4);
  assert.equal(first.get(A)?.likeCount, '0');
  assert.equal(second.get(C)?.topComment?.text, 'A useful comment');
  await lookup([A]); assert.equal(calls.length, 4);
  time += 300_001;
  await lookup([A]); assert.equal(calls.length, 6);
});

test('ignores private, unlisted and unembeddable videos and never invents absent counts', async () => {
  let comments = 0;
  const lookup = createYouTubeLookup('key', { fetch: async input => {
    if (String(input).includes('/commentThreads?')) { comments++; return json({ items: [] }); }
    return json({ items: [video(A, { viewCount: '0', likeCount: -1, commentCount: 'unknown', dislikeCount: '50' }),
      video(B, {}, { privacyStatus: 'unlisted' }), video(C, {}, { privacyStatus: 'public', embeddable: false }),
      video('V0000000001', {}, { privacyStatus: 'private' }), video('V0000000002', {}, {})] });
  } });
  const result = await lookup([A, B, C, 'V0000000001', 'V0000000002']);
  assert.deepEqual([...result], [[A, { viewCount: '0' }]]);
  assert.equal(comments, 1);
});

test('caps each lookup at five valid IDs and briefly caches unavailable videos', async () => {
  const calls: string[] = [];
  const lookup = createYouTubeLookup('key', { fetch: async input => {
    calls.push(new URL(String(input)).searchParams.get('id')!);
    return json({ items: [] });
  } });
  assert.equal((await lookup(['invalid', '../video'])).size, 0);
  assert.equal(calls.length, 0);
  const ids = [A, B, C, 'V0000000001', 'V0000000002', 'V0000000003'];
  await lookup(ids); await lookup(ids.slice(0, 5));
  assert.deepEqual(calls, [ids.slice(0, 5).join(',')]);
  await lookup([ids[5]]);
  assert.equal(calls.length, 2);
});

test('comment failures and missing comments retain statistics without an empty comment section', async () => {
  for (const response of [() => json({ error: { errors: [{ reason: 'commentsDisabled' }] } }, 403),
    () => json({ items: [] }), () => json(comment(B)), () => json({ items: [null] }),
    () => json({}, 503)]) {
    const lookup = createYouTubeLookup('key', { fetch: async input =>
      String(input).includes('/videos?') ? json({ items: [video()] }) : response() });
    const stats = (await lookup([A])).get(A)!;
    assert.equal(stats.viewCount, '12345');
    assert.equal(stats.topComment, undefined);
    assert(!formatYouTubeStatistics(stats, native())?.fields?.some(field => field.name === 'Top comment'));
  }
});

test('API errors, malformed payloads and timeouts fail open and back off without leaking errors', async () => {
  for (const failedFetch of [async () => json({}, 503), async () => new Response('{bad'),
    async () => { throw new Error('sensitive upstream URL/key'); }, async () => new Promise<Response>(() => {})] as typeof fetch[]) {
    let calls = 0;
    const lookup = createYouTubeLookup('key', { now: () => 0, timeoutMs: 5, fetch: async (...args) => { calls++; return failedFetch(...args); } });
    assert.equal((await lookup([A])).size, 0);
    assert.equal((await lookup([B])).size, 0);
    assert.equal(calls, 1);
  }
  const off = createYouTubeLookup('', { fetch: async () => assert.fail('no API key') });
  assert.equal((await off([A])).size, 0);
});

test('a stalled comment response does not discard successful video statistics', async () => {
  const lookup = createYouTubeLookup('key', { timeoutMs: 5, fetch: async input =>
    String(input).includes('/videos?') ? json({ items: [video(A, { viewCount: '3' }, { privacyStatus: 'public' })] })
      : new Promise<Response>(() => {}) });
  assert.deepEqual((await lookup([A])).get(A), { viewCount: '3' });
});

test('quota errors open an hour-long circuit; recovery and the per-minute limit are bounded', async () => {
  let time = 0, calls = 0, quota = true;
  const lookup = createYouTubeLookup('key', { now: () => time, fetch: async input => {
    calls++;
    if (quota) return json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, 403);
    const url = new URL(String(input));
    return url.pathname.endsWith('/videos') ? json({ items: url.searchParams.get('id')!.split(',').map(id => video(id)) }) : json({ items: [] });
  } });
  await lookup([A]); quota = false; time = 60_000;
  assert.equal((await lookup([B])).size, 0); assert.equal(calls, 1);
  time = 3_600_001;
  for (let i = 0; i < 16; i++) await lookup([`V${String(i).padStart(10, '0')}`]);
  assert.equal(calls, 31, 'one failed call followed by at most thirty requests per minute');
  time += 60_000;
  assert.equal((await lookup([B])).size, 1);
});

test('statistics use readable fields followed by a literal, bounded comment and separate author', () => {
  const card = formatYouTubeStatistics({ viewCount: '12345678901234567890', likeCount: '0',
    topComment: { author: '@everyone **Viewer**', text: '> hacked\n-# changed ||spoiler|| <@123> https://evil.test/x discord.gg/invite ' + 'x'.repeat(400) } }, native());
  assert(card);
  assert.equal(card.title, 'YouTube stats');
  assert.equal(card.url, native());
  assert.equal(card.footer?.text, 'Snapshot when shared');
  assert.equal(card.description, undefined, 'The comment must appear after the count fields');
  assert.deepEqual(card.fields?.slice(0, 2), [
    { name: 'Views', value: '**12,345,678,901,234,567,890**', inline: true },
    { name: 'Likes', value: '**0**', inline: true },
  ]);
  const comment = card.fields?.at(-1);
  assert.equal(comment?.name, 'Top comment');
  assert.equal(comment?.inline, false);
  const text = comment!.value;
  assert(!text.includes('https://evil.test'));
  assert(!text.includes('discord.gg'));
  assert(!text.includes('@everyone'));
  assert(!card.fields?.some(field => field.name === 'Comments'));
  assert(text.split('\n\n')[0].endsWith('…'));
  assert(text.split('\n\n')[1].startsWith('By @\u200beveryone'));
  assert.equal(formatYouTubeStatistics({}, native()), null);
  assert.equal(formatYouTubeStatistics({ viewCount: '2' }, 'https://evil.test'), null);
});
