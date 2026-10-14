import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { REWRITE_PLATFORMS } from '../src/services/LinkConfiguration';
import { SHARE_FALLBACK_HOSTS } from '../src/services/MobileShareLinks';
import { SOCIAL_PROVIDERS } from '../src/services/SocialProviders';

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

/** Comma-separated platform list captured by `pattern` in `path`. */
function platformList(path: string, pattern: RegExp): string[] {
  const match = pattern.exec(read(path));
  assert.ok(match, `${path}: REWRITE_PLATFORMS list not found`);
  return match[1].split(',').map(value => value.trim());
}

/** Rows of the first Markdown table whose header starts with `| Platform |`. */
function platformTable(path: string): string {
  const lines = read(path).split(/\r?\n/);
  const start = lines.findIndex(line => line.startsWith('| Platform |'));
  assert.ok(start >= 0, `${path}: platform table not found`);
  const end = lines.findIndex((line, index) => index > start && !line.startsWith('|'));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

/** Every host Linky sends preview or share-resolution traffic to outside the source platforms. */
const outboundHosts = [...new Set([...SOCIAL_PROVIDERS.map(provider => new URL(provider.origin).hostname), ...SHARE_FALLBACK_HOSTS])];

test('operator REWRITE_PLATFORMS lists name every platform, in code order', () => {
  assert.deepEqual(platformList('.env.example', /^# Optional subset of ([a-z,]+)\.$/m), [...REWRITE_PLATFORMS],
    '.env.example REWRITE_PLATFORMS comment differs from src/services/LinkConfiguration.ts');
  assert.deepEqual(platformList('docs/self-hosting.md', /^\| `REWRITE_PLATFORMS` \| Subset of `([a-z,]+)`/m), [...REWRITE_PLATFORMS],
    'docs/self-hosting.md REWRITE_PLATFORMS row differs from src/services/LinkConfiguration.ts');
});

for (const path of ['README.md', 'docs/provider-checks.md']) {
  test(`${path} platform table names every preview provider and share fallback host`, () => {
    const table = platformTable(path);
    const missing = outboundHosts.filter(host => !table.includes(`\`${host}\``));
    assert.deepEqual(missing, [], `${path} platform table does not mention: ${missing.join(', ')}`);
  });
}

test('outbound host list covers each provider and fallback exactly once', () => {
  assert.ok(outboundHosts.includes('rxddit.com'));
  assert.ok(outboundHosts.includes('facebed.com'));
  assert.equal(outboundHosts.length, new Set(outboundHosts).size);
});
