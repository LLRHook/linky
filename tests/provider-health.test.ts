import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EmbedType } from 'discord.js';
import { ProviderHealth, type ProviderMode } from '../src/services/ProviderHealth';
import { expectedPreviews, inspectPreviews } from '../src/services/PreviewRecovery';
import { getProviderCandidates } from '../src/services/SocialProviders';

// X is the platform with two catalog providers; Instagram has one since Instagram7 was retired.
const source = 'https://x.com/jack/status/1000';
function attempts(post: number, { requireVideo = false }: ProviderMode = {}, canonical = false) {
  const original = source.replace('1000', String(1000 + post));
  return getProviderCandidates(original).map((candidate, index) => {
    const expected = expectedPreviews(original, candidate.url).map(item => ({ ...item, requireVideo }));
    return { expected, result: inspectPreviews(index ? [{ url: canonical ? original : candidate.url,
      video: { url: 'https://cdn.example/video.mp4' } }] : [], expected) };
  });
}
function first(health: ProviderHealth, mode: ProviderMode = {}) {
  return health.order(getProviderCandidates(source), mode)[0].providerId;
}

test('three distinct paired failures temporarily prefer the proven alternate and allow one bounded probe', () => {
  let now = 0;
  const health = new ProviderHealth({ now: () => now, cooldownMs: 100, probeMs: 30 });
  for (let index = 0; index < 3; index++) health.recordRecovery(attempts(index));
  assert.equal(first(health), 'fixvx');
  now = 101;
  assert.equal(first(health), 'fixupx', 'First post after cooldown probes the catalog preference');
  assert.equal(first(health), 'fixvx', 'Concurrent requests do not all become probes');
  now += 31;
  assert.equal(first(health), 'fixupx');
  const candidate = attempts(500)[0];
  health.recordRecovery([{ ...candidate, result: inspectPreviews([{ url: candidate.expected[0].url,
    video: { url: 'https://cdn.example/video.mp4' } }], candidate.expected) }]);
  assert.equal(first(health), 'fixupx');
  assert.equal(first(health), 'fixupx', 'A successful probe closes the degraded state');
});

test('retries of one post, all-provider failures, and canonical-only metadata do not imply provider outage', () => {
  for (const kind of ['same', 'private', 'canonical'] as const) {
    const health = new ProviderHealth();
    for (let index = 0; index < 10; index++) {
      const pair = attempts(kind === 'same' ? 0 : index, {}, kind === 'canonical');
      if (kind === 'private') pair[1].result = inspectPreviews([], pair[1].expected);
      health.recordRecovery(pair);
    }
    assert.equal(first(health), 'fixupx', kind);
  }
});

test('a late previous-provider embed cannot manufacture an alternate success', () => {
  const health = new ProviderHealth();
  for (let index = 0; index < 5; index++) {
    const pair = attempts(index);
    pair[1].result = inspectPreviews([{ url: pair[0].expected[0].url, video: { url: 'https://cdn.example/video.mp4' } }], pair[1].expected);
    assert.equal(pair[1].result.ok, true);
    assert.deepEqual(pair[1].result.attributed, []);
    health.recordRecovery(pair);
  }
  assert.equal(first(health), 'fixupx');
});

test('alternate path forms of the same post do not count as distinct outage evidence', () => {
  const health = new ProviderHealth();
  for (const form of ['/jack/status/', '/i/status/', '/i/web/status/']) {
    const pair = attempts(0);
    for (const [index, attempt] of pair.entries()) {
      attempt.expected = attempt.expected.map(item => ({ ...item, source: item.source.replace('/jack/status/', form),
        url: item.url.replace('/jack/status/', form) }));
      attempt.result = inspectPreviews(index ? [{ url: attempt.expected[0].url, video: { url: 'https://cdn.example/video.mp4' } }] : [], attempt.expected);
    }
    assert.deepEqual(pair.map(attempt => attempt.result.ok), [false, true], form);
    health.recordRecovery(pair);
  }
  assert.equal(first(health), 'fixupx');
});

test('Linky-authored rich cards remain useful metadata without crediting an external provider', () => {
  const primary = attempts(7)[0];
  const result = inspectPreviews([{ url: primary.expected[0].url, type: EmbedType.Rich, video: { url: 'https://cdn.example/video.mp4' } }], primary.expected);
  assert.equal(result.ok, true);
  assert.deepEqual(result.attributed, []);
});

test('health modes remain separate and preference rewrites only visible links', () => {
  const health = new ProviderHealth();
  for (let index = 0; index < 3; index++) health.recordRecovery(attempts(index, { requireVideo: true }));
  assert.equal(first(health), 'fixupx');
  assert.equal(first(health, { requireVideo: true }), 'fixvx');
  assert.equal(first(health, { captionFree: true, requireVideo: true }), 'fixupx');
  const primary = 'https://fixupx.com/jack/status/1000';
  const text = `${primary}\nTranslated caption <${primary}> \`${primary}\``;
  assert.equal(health.preferContent(text), text, 'the default mode holds no evidence');
  assert.equal(health.preferContent(text, { requireVideo: true }), text.replace(primary, 'https://vxtwitter.com/jack/status/1000'));
  assert.equal(health.order(getProviderCandidates('https://www.tiktok.com/@name/video/123'))[0].providerId, 'tnktok');
});

test('a visible retired Instagram7 link moves to OGInstagram and keeps its gallery capability', () => {
  const health = new ProviderHealth();
  for (const [retired, live] of [
    ['https://fkinstagram.com/reel/Post/', 'https://oginstagram.com/reel/Post/'],
    ['https://www.instagram7.com/p/Post/', 'https://oginstagram.com/p/Post/'],
    ['https://g.fkinstagram.com/p/Post/', 'https://g.oginstagram.com/p/Post/'],
    ['https://g.instagram7.com/reel/Post/', 'https://g.oginstagram.com/reel/Post/'],
  ]) {
    const text = `${retired}\nTranslated caption <${retired}> \`${retired}\``;
    assert.equal(health.preferContent(text), text.replace(retired, live));
  }
  const live = 'https://g.oginstagram.com/p/Post/';
  assert.equal(health.preferContent(live), live);
  assert.deepEqual(health.order(getProviderCandidates('https://www.instagram.com/reel/Post/')).map(item => item.providerId), ['oginstagram']);
});

test('stale evidence expires and no candidate or alternate is removed from recovery', () => {
  let now = 0;
  const health = new ProviderHealth({ now: () => now, windowMs: 200, cooldownMs: 50 });
  for (let index = 0; index < 3; index++) health.recordRecovery(attempts(index));
  assert.deepEqual(health.order(getProviderCandidates(source)).map(item => item.providerId), ['fixvx', 'fixupx']);
  now = 201;
  assert.equal(first(health), 'fixupx');
  assert.equal(first(health), 'fixupx');
});
