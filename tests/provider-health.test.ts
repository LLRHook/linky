import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EmbedType } from 'discord.js';
import { ProviderHealth, type ProviderMode } from '../src/services/ProviderHealth';
import { expectedPreviews, inspectPreviews } from '../src/services/PreviewRecovery';
import { getProviderCandidates } from '../src/services/SocialProviders';

const source = 'https://www.instagram.com/reel/Post/';
function attempts(post: string, { captionFree = false, requireVideo = false }: ProviderMode = {}, canonical = false) {
  const original = source.replace('Post', post);
  const candidates = getProviderCandidates(original, { captionFree });
  return candidates.map((candidate, index) => {
    const expected = expectedPreviews(original, candidate.url).map(item => ({ ...item, captionFree, requireVideo }));
    return { expected, result: inspectPreviews(index ? [{ url: canonical ? original : candidate.url,
      video: { url: 'https://cdn.example/video.mp4' } }] : [], expected) };
  });
}
function first(health: ProviderHealth, mode: ProviderMode = {}) {
  return health.order(getProviderCandidates(source, mode), mode)[0].providerId;
}

test('three distinct paired failures temporarily prefer the proven alternate and allow one bounded probe', () => {
  let now = 0;
  const health = new ProviderHealth({ now: () => now, cooldownMs: 100, probeMs: 30 });
  for (let index = 0; index < 3; index++) health.recordRecovery(attempts(`Post${index}`));
  assert.equal(first(health), 'oginstagram');
  now = 101;
  assert.equal(first(health), 'instagram7', 'First post after cooldown probes the catalog preference');
  assert.equal(first(health), 'oginstagram', 'Concurrent requests do not all become probes');
  now += 31;
  assert.equal(first(health), 'instagram7');
  const candidate = attempts('Recovered')[0];
  health.recordRecovery([{ ...candidate, result: inspectPreviews([{ url: candidate.expected[0].url,
    video: { url: 'https://cdn.example/video.mp4' } }], candidate.expected) }]);
  assert.equal(first(health), 'instagram7');
  assert.equal(first(health), 'instagram7', 'A successful probe closes the degraded state');
});

test('retries of one post, all-provider failures, and canonical-only metadata do not imply provider outage', () => {
  for (const kind of ['same', 'private', 'canonical'] as const) {
    const health = new ProviderHealth();
    for (let index = 0; index < 10; index++) {
      const pair = attempts(kind === 'same' ? 'OnePost' : `Post${index}`, {}, kind === 'canonical');
      if (kind === 'private') pair[1].result = inspectPreviews([], pair[1].expected);
      health.recordRecovery(pair);
    }
    assert.equal(first(health), 'instagram7', kind);
  }
});

test('a late previous-provider embed cannot manufacture an alternate success', () => {
  const health = new ProviderHealth();
  for (let index = 0; index < 5; index++) {
    const pair = attempts(`Post${index}`);
    pair[1].result = inspectPreviews([{ url: pair[0].expected[0].url, video: { url: 'https://cdn.example/video.mp4' } }], pair[1].expected);
    assert.equal(pair[1].result.ok, true);
    assert.deepEqual(pair[1].result.attributed, []);
    health.recordRecovery(pair);
  }
  assert.equal(first(health), 'instagram7');
});

test('alternate path forms of the same Instagram post do not count as distinct outage evidence', () => {
  const health = new ProviderHealth();
  for (const kind of ['reel', 'reels', 'p']) {
    const pair = attempts('OnePost');
    for (const [index, attempt] of pair.entries()) {
      attempt.expected = attempt.expected.map(item => ({ ...item, source: item.source.replace('/reel/', `/${kind}/`),
        url: item.url.replace('/reel/', `/${kind}/`) }));
      attempt.result = inspectPreviews(index ? [{ url: attempt.expected[0].url, video: { url: 'https://cdn.example/video.mp4' } }] : [], attempt.expected);
    }
    health.recordRecovery(pair);
  }
  assert.equal(first(health), 'instagram7');
});

test('Linky-authored rich cards remain useful metadata without crediting an external provider', () => {
  const primary = attempts('Translated')[0];
  const result = inspectPreviews([{ url: primary.expected[0].url, type: EmbedType.Rich, video: { url: 'https://cdn.example/video.mp4' } }], primary.expected);
  assert.equal(result.ok, true);
  assert.deepEqual(result.attributed, []);
});

test('health modes remain separate and preference preserves hidden text and caption-free URLs', () => {
  const health = new ProviderHealth();
  for (let index = 0; index < 3; index++) health.recordRecovery(attempts(`Post${index}`, { captionFree: true }));
  assert.equal(first(health), 'instagram7');
  assert.equal(first(health, { captionFree: true }), 'oginstagram');
  assert.equal(first(health, { captionFree: true, requireVideo: true }), 'instagram7');
  const gallery = 'https://g.instagram7.com/reel/Post/';
  const text = `${gallery}\nTranslated caption <${gallery}> \`${gallery}\``;
  assert.equal(health.preferContent(text), text.replace(gallery, 'https://g.oginstagram.com/reel/Post/'));
  assert.equal(health.order(getProviderCandidates('https://www.tiktok.com/@name/video/123'))[0].providerId, 'tnktok');
});

test('stale evidence expires and no candidate or alternate is removed from recovery', () => {
  let now = 0;
  const health = new ProviderHealth({ now: () => now, windowMs: 200, cooldownMs: 50 });
  for (let index = 0; index < 3; index++) health.recordRecovery(attempts(`Post${index}`));
  assert.deepEqual(health.order(getProviderCandidates(source)).map(item => item.providerId), ['oginstagram', 'instagram7']);
  now = 201;
  assert.equal(first(health), 'instagram7');
  assert.equal(first(health), 'instagram7');
});
