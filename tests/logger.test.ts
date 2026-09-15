import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';

function logErrors(script: string) {
  const result = spawnSync(process.execPath, ['--require', require.resolve('tsx/cjs'), '-e',
    `const { logger } = require(process.argv[1]);\n${script}`, resolve(__dirname, '../src/logger.ts')], {
    cwd: resolve(__dirname, '..'), encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'production', LOG_LEVEL: 'error' },
  });
  assert.equal(result.status, 0, 'Production logging must finish within its bounded output capture');
  assert.equal(result.stderr, '');
  assert(result.stdout.length < 4096, 'Error records must stay small');
  assert(!result.stdout.includes('PRIVATE_SENTINEL'), 'Error text and payload must not enter logs');
  return result.stdout.trim().split('\n').map(line => JSON.parse(line));
}

test('production Pino logging excludes a Discord error upload, message, URL, stack and nested cause', () => {
  const [entry] = logErrors(`
    const { DiscordAPIError } = require('@discordjs/rest');
    const err = new DiscordAPIError({ message: 'PRIVATE_SENTINEL_API', code: 50035 },
      50035, 400, 'POST', 'https://example.test/PRIVATE_SENTINEL_URL', {
        files: [{ data: Buffer.alloc(1024 * 1024, 123), name: 'PRIVATE_SENTINEL.mp4' }],
        body: { content: 'PRIVATE_SENTINEL_MESSAGE' },
      });
    err.cause = new Error('PRIVATE_SENTINEL_CAUSE');
    logger.error({ messageId: '123456789012345679', err }, 'link replacement failed');
  `);
  assert.equal(entry.msg, 'link replacement failed');
  assert.equal(entry.messageId, '123456789012345679');
  assert.deepEqual(entry.err, { type: 'DiscordAPIError', code: 50035, status: 400, method: 'POST' });
});

test('production logging retains known error classes and system codes without copying arbitrary properties', () => {
  const entries = logErrors(`
    logger.error({ err: Object.assign(new TypeError('PRIVATE_SENTINEL'), {
      code: 'ECONNRESET', method: 'GET', url: 'PRIVATE_SENTINEL', custom: Buffer.alloc(1024),
    }) }, 'operation failed');
    logger.child({ channelId: '123456789012345678' }).error({ err: {
      name: 'AbortError', code: 'ABORT_ERR', message: 'PRIVATE_SENTINEL',
    } }, 'operation cancelled');
  `);
  assert.deepEqual(entries[0].err, { type: 'TypeError', code: 'ECONNRESET', method: 'GET' });
  assert.deepEqual(entries[1].err, { type: 'AbortError', code: 'ABORT_ERR' });
  assert.equal(entries[1].channelId, '123456789012345678');
});

test('unknown values and throwing error properties cannot leak text or interrupt logging', () => {
  const entries = logErrors(`
    logger.error({ err: { name: 'PRIVATE_SENTINEL', code: 'PRIVATE_SENTINEL',
      status: 999, method: 'PRIVATE_SENTINEL', message: 'PRIVATE_SENTINEL' } }, 'unknown failure');
    logger.error({ err: new Proxy({}, { get() { throw new Error('PRIVATE_SENTINEL'); } }) }, 'unreadable failure');
    logger.error({ err: 'PRIVATE_SENTINEL' }, 'non-error failure');
    logger.error({ err: { name: 'RangeError', code: Infinity, status: 400.5 } }, 'invalid fields');
  `);
  assert.deepEqual(entries.map(entry => entry.err), [{ type: 'Error' }, { type: 'Error' },
    { type: 'Error' }, { type: 'RangeError' }]);
});
