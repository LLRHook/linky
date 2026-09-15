import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchTweetTranslation } from '../src/services/TweetTranslation';
import { createYouTubeLookup } from '../src/services/YouTube';

const videoId = 'dQw4w9WgXcQ';
const tweet = { code: 200, status: { type: 'status', lang: 'ja',
  author: { name: 'Fixture', url: 'https://x.com/fixture' }, media: {},
  translation: { text: 'An English caption.', source_lang: 'ja', target_lang: 'en' } } };
const youtube = { items: [{ id: videoId, statistics: { viewCount: '1' }, status: { privacyStatus: 'public', embeddable: true } }] };

function responseBody(value: unknown, declaredBytes?: number, status = 200) {
  const bytes = Buffer.from(JSON.stringify(value));
  let consumed = 0, cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (consumed === bytes.length) { controller.close(); return; }
      const end = Math.min(consumed + 4096, bytes.length);
      controller.enqueue(bytes.subarray(consumed, end)); consumed = end;
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), {
    status, headers: declaredBytes === undefined ? {} : { 'content-length': String(declaredBytes) },
  });
  return { response, consumed: () => consumed, cancelled: () => cancelled, size: bytes.length };
}

for (const provider of ['tweet', 'youtube'] as const) {
  const payload = provider === 'tweet' ? tweet : youtube;
  const limit = provider === 'tweet' ? 1024 * 1024 : 128_000;
  const lookup = async (response: Response) => provider === 'tweet'
    ? await fetchTweetTranslation('20', async () => response)
    : (await createYouTubeLookup('fixture-key', { fetch: async () => response })([videoId], 'counts')).get(videoId) ?? null;

  test(`${provider} rejects an oversized declared body before reading it`, async () => {
    const body = responseBody(payload, 1024 * 1024 * 1024);
    assert.equal(await lookup(body.response), null);
    assert.equal(body.consumed(), 0);
    assert.equal(body.cancelled(), true);
  });

  test(`${provider} cancels an oversized chunked JSON body before buffering it completely`, async () => {
    const body = responseBody({ ...payload, unused: 'x'.repeat(limit * 2) });
    assert.equal(await lookup(body.response), null);
    assert.equal(body.cancelled(), true);
    assert(body.consumed() <= limit + 4096, 'stop reading as soon as the byte limit is crossed');
    assert(body.consumed() < body.size);
  });
}

test('tweet metadata requests reject redirects and cancel unusable HTTP bodies', async () => {
  const body = responseBody({ unused: 'x'.repeat(16_384) }, undefined, 503);
  let redirect: RequestInit['redirect'];
  assert.equal(await fetchTweetTranslation('20', async (_input, options) => {
    redirect = options?.redirect;
    return body.response;
  }), null);
  assert.equal(redirect, 'error');
  assert.equal(body.consumed(), 0);
  assert.equal(body.cancelled(), true);
});
