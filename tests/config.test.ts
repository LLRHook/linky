import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const emptyDirectory = mkdtempSync(path.join(tmpdir(), 'linky-config-tests-'));
after(() => rmdirSync(emptyDirectory));
const FIRST = '1491242185331576884';
const SECOND = '688096448679903281';

function readChannels(overrides: NodeJS.ProcessEnv) {
  const env = { ...process.env };
  for (const name of ['LINK_CHANNEL_IDS', 'FIXUPX_CHANNEL_IDS', 'FIXUPX_CHANNEL_ID']) delete env[name];
  const result = spawnSync(process.execPath, [
    '--require', require.resolve('tsx/cjs'), '-e',
    'process.stdout.write(JSON.stringify(require(process.argv[1]).config.channelIds))',
    path.resolve(__dirname, '../src/config.ts'),
  ], {
    cwd: emptyDirectory,
    env: { ...env, DISCORD_TOKEN: 'test-token', REWRITE_PLATFORMS: 'x,instagram,tiktok', DOTENV_CONFIG_PATH: path.join(emptyDirectory, '.env'), ...overrides },
    encoding: 'utf8', timeout: 10000,
  });
  return result;
}

test('LINK_CHANNEL_IDS takes precedence over both legacy settings, even malformed ones', () => {
  const result = readChannels({ LINK_CHANNEL_IDS: SECOND, FIXUPX_CHANNEL_IDS: 'invalid', FIXUPX_CHANNEL_ID: FIRST });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [SECOND]);
});

test('an explicitly empty LINK_CHANNEL_IDS disables rewriting despite legacy configuration', () => {
  const result = readChannels({ LINK_CHANNEL_IDS: '', FIXUPX_CHANNEL_IDS: FIRST, FIXUPX_CHANNEL_ID: SECOND });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
});

test('legacy channel settings still combine and deduplicate when LINK_CHANNEL_IDS is absent', () => {
  const result = readChannels({ FIXUPX_CHANNEL_IDS: `${FIRST},${SECOND}`, FIXUPX_CHANNEL_ID: FIRST });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [FIRST, SECOND]);
});

test('missing channel settings disable rewriting', () => {
  const result = readChannels({});
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
});

test('malformed LINK_CHANNEL_IDS fails closed instead of falling back to legacy scope', () => {
  const result = readChannels({ LINK_CHANNEL_IDS: `${FIRST},invalid`, FIXUPX_CHANNEL_IDS: SECOND });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Channel IDs must be comma-separated Discord channel IDs/);
});
