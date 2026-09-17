import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isEromeAvailable, parseEromeGuildIds } from '../src/services/EromeAvailability';

const FIRST = '111111111111111111', SECOND = '222222222222222222';

test('Erome operator policy distinguishes unset, none and exact deduplicated server IDs', () => {
  assert.equal(parseEromeGuildIds(undefined), undefined);
  assert.deepEqual(parseEromeGuildIds(' none '), []);
  assert.deepEqual(parseEromeGuildIds(` ${FIRST}, ${SECOND},${FIRST} `), [FIRST, SECOND]);
  for (const invalid of ['', ' ', '*', 'all', 'NONE', `none,${FIRST}`, `${FIRST},`, '012345678901234567', '123']) {
    assert.throws(() => parseEromeGuildIds(invalid), /EROME_GUILD_IDS/, invalid);
  }
});

test('Erome allowlists never enable a disabled platform or a private conversation', () => {
  const config = { rewritePlatforms: ['erome'] as const };
  assert.equal(isEromeAvailable(config, FIRST), true);
  assert.equal(isEromeAvailable({ ...config, eromeGuildIds: [] }, FIRST), false);
  assert.equal(isEromeAvailable({ ...config, eromeGuildIds: [FIRST] }, FIRST), true);
  assert.equal(isEromeAvailable({ ...config, eromeGuildIds: [FIRST] }, SECOND), false);
  assert.equal(isEromeAvailable({ rewritePlatforms: [], eromeGuildIds: [FIRST] }, FIRST), false);
  for (const guildId of [undefined, null, '']) assert.equal(isEromeAvailable(config, guildId), false);
});
