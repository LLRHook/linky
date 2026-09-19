import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessSource, embedFromMetadata, formatSummary, parseCorpus, readMetadata, runProviderMetadataCheck, summarize } from '../ops/provider-metadata-check.mjs';
import * as providers from '../dist/services/SocialProviders.js';
import * as recovery from '../dist/services/PreviewRecovery.js';

const services = { ...providers, ...recovery };
const page = tags => Object.entries(tags).map(([name, content]) => `<meta property="${name}" content="${content}"/>`).join('');
const respond = (status, html, location) => ({ status, headers: { get: name => name === 'location' ? location ?? null : null },
  arrayBuffer: async () => new TextEncoder().encode(html).buffer });

test('metadata reading accepts either attribute order, decodes entities and keeps the first value per name', () => {
  const tags = readMetadata('<meta content="https://x.com/a/status/1" property="og:url"><meta name="twitter:title" content="A &amp; B">' +
    '<meta property="og:image" content="https://cdn.example/first"><meta property="og:image" content="https://cdn.example/second">');
  assert.equal(tags.get('og:url'), 'https://x.com/a/status/1');
  assert.equal(tags.get('twitter:title'), 'A & B');
  assert.equal(tags.get('og:image'), 'https://cdn.example/first');
  const embed = embedFromMetadata(new Map([['twitter:player:stream', 'https://cdn.example/v.mp4'], ['og:title', 'T']]), 'https://tnktok.com/t/abc/');
  assert.deepEqual(embed, { url: 'https://tnktok.com/t/abc/', title: 'T', video: { url: 'https://cdn.example/v.mp4' } });
});

test('a TikTok share link is satisfied by the canonical post metadata and a full link still needs its own ID', async () => {
  const canonical = page({ 'og:url': 'https://www.tiktok.com/@e0rik00/video/7686471409861659936', 'og:title': '@e0rik00',
    'og:video': 'https://offload.example/7686471409861659936.mp4' });
  const fetch = async () => respond(200, canonical);
  const share = await assessSource({ source: 'https://www.tiktok.com/t/ZTU7oFukc/', expect: 'video' }, services, { fetch });
  assert.equal(share.platform, 'tiktok'); assert.equal(share.ok, true);
  assert.deepEqual(share.providers.map(item => [item.providerId, item.satisfied, item.media, item.expectationMet]), [['tnktok', true, 'video', true]]);
  const other = await assessSource({ source: 'https://www.tiktok.com/@e0rik00/video/1', expect: 'video' }, services, { fetch });
  assert.equal(other.ok, false); assert.equal(other.providers[0].satisfied, false);
});

test('error cards, missing media, HTTP failures and cross-origin redirects are reported without satisfying Linky', async () => {
  const reel = { source: 'https://www.instagram.com/reel/DdFKS1ABmK4/', expect: 'video' };
  const byHost = {
    'www.instagram7.com': respond(200, page({ 'og:url': 'https://www.instagram.com/reel/DdFKS1ABmK4/', 'og:title': 'Error', 'og:description': 'Try again later' })),
    'oginstagram.com': respond(403, ''),
  };
  const result = await assessSource(reel, services, { fetch: async url => byHost[new URL(url).hostname] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.providers.map(item => [item.providerId, item.status, item.satisfied]), [['instagram7', 200, false], ['oginstagram', 403, false]]);
  const thumbnailOnly = await assessSource(reel, services, { fetch: async () => respond(200, page({ 'og:url': 'https://www.instagram.com/reel/DdFKS1ABmK4/', 'og:image': 'https://cdn.example/t.jpg' })) });
  assert.equal(thumbnailOnly.ok, false, 'a Reel thumbnail without video metadata is not a useful preview');
  const redirected = await assessSource({ source: 'https://x.com/jack/status/20', expect: 'text' }, services,
    { fetch: async () => respond(302, '', 'http://insecure.example/') });
  assert.equal(redirected.ok, false); assert.equal(redirected.providers[0].redirectRejected, true);
  const failing = await assessSource({ source: 'https://x.com/jack/status/20', expect: 'text' }, services, { fetch: async () => { throw new Error('boom'); } });
  assert.equal(failing.providers[0].error, 'fetch_failed'); assert.equal(failing.ok, false);
});

test('an unavailable expectation passes only when no provider claims the post', async () => {
  const entry = { source: 'https://x.com/jack/status/20', expect: 'unavailable' };
  const missing = await assessSource(entry, services, { fetch: async () => respond(404, page({ 'og:title': 'Not found' })) });
  assert.equal(missing.ok, true);
  const present = await assessSource(entry, services, { fetch: async () => respond(200, page({ 'og:url': 'https://x.com/jack/status/20', 'og:title': 'jack (@jack)', 'og:description': 'just setting up my twttr' })) });
  assert.equal(present.ok, false);
});

test('the summary counts sources, provider responses, errors and latency per platform and the CLI validates its input', async () => {
  const fetch = async url => new URL(url).hostname === 'vxtwitter.com' ? respond(500, '')
    : respond(200, page({ 'og:url': 'https://x.com/jack/status/20', 'og:title': 'jack (@jack)', 'og:description': 'text' }));
  const report = summarize([await assessSource({ source: 'https://x.com/jack/status/20', expect: 'text' }, services, { fetch })], new Date(0));
  assert.deepEqual(report.platforms.x, { sources: 1, ok: 1, providers: 2, satisfied: 1, expectationMet: 1, errors: 1, medianMs: report.platforms.x.medianMs, maxMs: report.platforms.x.maxMs });
  assert.match(formatSummary(report), /x: 1\/1 sources met their expectation; 1\/2 provider responses satisfied Linky; 1 errors/);
  assert.throws(() => parseCorpus('[{"source":"https://x.com/jack/status/20","expect":"maybe"}]'), /corpus_entry_invalid/);
  let output = '';
  const write = text => { output += text; };
  assert.equal(await runProviderMetadataCheck(['--days', '1'], { write, services, fetch }), 2);
  assert.match(output, /provider_metadata_check_failed/);
  output = '';
  assert.equal(await runProviderMetadataCheck(['--json', 'https://x.com/jack/status/20'], { write, services, fetch }), 0);
  assert.equal(JSON.parse(output).scope, 'provider-metadata-only');
});
