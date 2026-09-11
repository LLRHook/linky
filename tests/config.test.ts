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

function readChannels(overrides: NodeJS.ProcessEnv, field = 'channelIds') {
  const env = { ...process.env };
  delete env['LINK_CHANNEL_IDS'];
  delete env['LINK_SERVER_IDS'];
  const result = spawnSync(process.execPath, [
    '--require', require.resolve('tsx/cjs'), '-e',
    'process.stdout.write(JSON.stringify(require(process.argv[1]).config[process.argv[2]]))',
    path.resolve(__dirname, '../src/config.ts'), field,
  ], {
    cwd: emptyDirectory,
    env: { ...env, DISCORD_TOKEN: 'test-token', REWRITE_PLATFORMS: 'x,instagram,tiktok', DOTENV_CONFIG_PATH: path.join(emptyDirectory, '.env'), ...overrides },
    encoding: 'utf8', timeout: 10000,
  });
  return result;
}

test('LINK_CHANNEL_IDS configures one channel', () => {
  const result = readChannels({ LINK_CHANNEL_IDS: SECOND });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [SECOND]);
});

test('an explicitly empty LINK_CHANNEL_IDS disables rewriting', () => {
  const result = readChannels({ LINK_CHANNEL_IDS: '' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
});

test('LINK_CHANNEL_IDS trims and deduplicates a channel list', () => {
  const result = readChannels({ LINK_CHANNEL_IDS: ` ${FIRST}, ${SECOND}, ${FIRST} ` });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [FIRST, SECOND]);
});

test('missing channel settings disable rewriting', () => {
  const result = readChannels({});
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
});

test('malformed LINK_CHANNEL_IDS fails closed', () => {
  const result = readChannels({ LINK_CHANNEL_IDS: `${FIRST},invalid` });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Channel IDs must be comma-separated Discord IDs/);
});


test('LINK_SERVER_IDS configures and deduplicates servers independently of channels', () => {
  const env = { LINK_SERVER_IDS: ` ${FIRST},${SECOND}, ${FIRST} `, LINK_CHANNEL_IDS: SECOND };
  const servers = readChannels(env, 'serverIds');
  assert.equal(servers.status, 0, servers.stderr);
  assert.deepEqual(JSON.parse(servers.stdout), [FIRST, SECOND]);
  assert.deepEqual(JSON.parse(readChannels(env).stdout), [SECOND]);
});

test('server scope defaults off and rejects malformed IDs', () => {
  assert.deepEqual(JSON.parse(readChannels({}, 'serverIds').stdout), []);
  assert.deepEqual(JSON.parse(readChannels({ LINK_SERVER_IDS: '' }, 'serverIds').stdout), []);
  for (const value of ['all', '*', `${FIRST},`, `${FIRST},invalid`]) {
    const result = readChannels({ LINK_SERVER_IDS: value });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Server IDs must be comma-separated Discord IDs/);
  }
});
