import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';

test('production image saves private measurements and runs the operator report without npm or network', {
  skip: process.env.LINKY_ARCHIVE_RUNTIME_TEST !== 'true',
}, async () => {
  assert.notEqual(process.getuid(), 0);
  const directory = await mkdtemp('/app/data/archive-smoke-');
  const require = createRequire(join(process.cwd(), 'package.json'));
  const { DeliveryArchive } = require('./dist/services/DeliveryArchive.js');
  const archive = new DeliveryArchive({ directory });
  try {
    await archive.ready;
    assert(archive.record({ id: 'd4c5030e-9fb3-48a7-98f1-911e14f56743', startedAt: Date.now(),
      platform: 'instagram', mode: 'automatic', path: 'native', outcome: 'confirmed', durationMs: 750,
      stages: [{ stage: 'preview', outcome: 'ok', durationMs: 500 }],
      requesterId: '111111111111111111', sourceUrl: 'https://example.invalid/private-source',
      caption: 'Never archive this sample caption' }));
    assert(await archive.close());
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    const files = await readdir(directory);
    assert(files.some(file => file.endsWith('.jsonl')));
    for (const file of files) {
      assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600);
      const content = await readFile(join(directory, file), 'utf8');
      assert(!/111111111111111111|private-source|sample caption|requesterId|sourceUrl/.test(content));
    }
    const output = execFileSync(process.execPath, ['ops/delivery-archive-report.mjs',
      '--directory', directory, '--days', '7', '--json'], { encoding: 'utf8', timeout: 10_000 });
    const report = JSON.parse(output);
    assert.equal(report.scope, 'operator-local-archive');
    assert.equal(report.confirmation.confirmed, 1);
    assert.equal(report.confirmation.denominator, 1);
    assert.equal(report.confirmation.playbackVerified, false);
    assert(!/d4c5030e|111111111111111111|private-source|sample caption/.test(output));
  } finally {
    await archive.close();
    await rm(directory, { recursive: true, force: true });
  }
});
