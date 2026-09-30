// Exploratory CPU baseline, without network requests or a CI performance budget.
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(process.argv[2] ?? 'dist');
const { rewriteSocialLinks } = require(path.join(root, 'services/SocialLinkService.js'));
const { expectedPreviews, inspectPreviews } = require(path.join(root, 'services/PreviewRecovery.js'));

const samples = [
  'An ordinary message without links.',
  'https://x.com/user/status/123?s=20',
  'https://www.instagram.com/reel/Test123/',
  'https://www.tiktok.com/@user/video/123',
  'https://bsky.app/profile/test.example/post/abc123',
  'https://www.reddit.com/r/test/comments/abc123/post/',
  'https://clips.twitch.tv/TestClip',
  '<https://x.com/user/status/123> ||https://x.com/user/status/456||',
  '`https://www.instagram.com/p/Test123/` [post](https://x.com/user/status/123)',
  'https://publisher.example/articles/test',
  'https://youtu.be/dQw4w9WgXcQ',
  'https://unrelated.example/?nested=https://x.com/user/status/123',
  'A long ordinary message '.repeat(80),
];
const corpus = Array.from({ length: 1000 }, (_, index) => samples[index % samples.length]);
const many = count => Array.from({ length: count }, (_, i) => `https://x.com/user/status/${i + 1000}`).join(' ');
const cases = [1, 8, 40].map(count => ({ count, source: many(count), rendered: rewriteSocialLinks(many(count)) }));
for (const item of cases) assert.equal(expectedPreviews(item.source, item.rendered).length, item.count);
const expectations = expectedPreviews(cases[1].source, cases[1].rendered);
const embeds = expectations.map(item => ({
  url: item.url, type: 'video', video: { url: 'https://media.example/video.mp4' }, title: 'Public synthetic preview',
}));
assert.equal(inspectPreviews(embeds, expectations).ok, true);

function measure(name, iterations, task) {
  for (let warm = 0; warm < 3; warm++) for (let i = 0; i < iterations; i++) task(i);
  const rounds = [];
  for (let round = 0; round < 7; round++) {
    const started = performance.now();
    for (let i = 0; i < iterations; i++) task(i);
    rounds.push((performance.now() - started) / iterations);
  }
  const ordered = [...rounds].sort((a, b) => a - b);
  return { name, iterations, roundsMsPerCall: rounds, medianMsPerCall: ordered[3], p95RoundMsPerCall: ordered[6] };
}

const results = [
  measure('rewrite-mixed-corpus', 10000, i => rewriteSocialLinks(corpus[i % corpus.length])),
  ...cases.map(item => measure(`expectations-${item.count}-links`, item.count === 40 ? 100 : 500,
    () => expectedPreviews(item.source, item.rendered))),
  measure('inspect-8-video-previews', 1000, () => inspectPreviews(embeds, expectations)),
];
console.log(JSON.stringify({
  environment: {
    platform: process.platform, arch: process.arch, node: process.version,
    cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem(),
  },
  method: {
    warmupRounds: 3, measuredRounds: 7, corpusMessages: corpus.length,
    maxSourceCharacters: Math.max(...corpus.map(s => s.length), ...cases.map(s => s.source.length)),
    statistic: 'median and p95 of round-average milliseconds per call, not per-message tail latency',
  },
  results,
}, null, 2));
