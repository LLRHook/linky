import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanupFailure, logCleanupFailure } from '../src/services/CleanupFailure';

test('cleanup error reporting accepts only finite numeric code and HTTP status', () => {
  for (const failure of [null, 'private detail', { code: '50001', status: '403' }, { code: NaN, status: Infinity }]) {
    const error = cleanupFailure('Safe cleanup notice', failure);
    assert.deepEqual({ ...error }, {});
    assert.equal(error.message, 'Safe cleanup notice');
  }
  const error = cleanupFailure('Safe cleanup notice', { code: 50013, status: 403, message: 'private detail', token: 'synthetic-value' });
  const logged: unknown[] = [];
  logCleanupFailure({ warn: (...args) => logged.push(...args) }, error);
  assert.deepEqual(logged, [{ code: 50013, status: 403 }, 'Safe cleanup notice']);
});
