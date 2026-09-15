import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readDeliveryHistory, runDeliveryReport } from '../ops/delivery-report.mjs';

const execute = promisify(execFile), cli = fileURLToPath(new URL('../ops/delivery-report.mjs', import.meta.url));
const since = Date.parse('2026-09-15T12:00:00Z');
function attempt(index, values = {}) {
  return { id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, requesterId: '1491242185331576884',
    channelId: '1491242185331576885', guildId: '1491242185331576886', messageId: '1491242185331576887',
    mode: 'automatic', platform: 'erome', path: 'hosted-original', outcome: 'confirmed', cache: 'miss',
    startedAt: since + index, durationMs: 100 * index,
    stages: [{ stage: 'download', outcome: 'ok', durationMs: 50 * index }], ...values };
}
async function fixture(t, attempts = []) {
  const directory = await mkdtemp(join(tmpdir(), 'linky-delivery-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'private-diagnostics.json');
  await writeFile(path, JSON.stringify({ version: 1, attempts }));
  return { directory, path };
}
async function report(path, ...args) {
  let output = '';
  const code = await runDeliveryReport(['--file', path, ...args], line => { output += line; });
  return { code, output, data: JSON.parse(output) };
}

test('actual CLI reports only aggregate whitelisted fields and leaves the source byte-identical', async t => {
  const { path } = await fixture(t, [attempt(1), attempt(2, { cache: 'hit' })]);
  const before = await readFile(path), checksum = bytes => createHash('sha256').update(bytes).digest('hex');
  const { stdout, stderr } = await execute(process.execPath, [cli, '--file', path]);
  const data = JSON.parse(stdout);
  assert.equal(stderr, ''); assert.equal(checksum(await readFile(path)), checksum(before));
  assert.deepEqual(data.samples, { available: 2, selected: 2, completed: 2, pending: 0, interrupted: 0 });
  assert.deepEqual(data.counts.cache, { hit: 1, miss: 1, unknown: 0 });
  assert.deepEqual(data.latency.confirmed, { samples: 2, medianMs: 150, p95Ms: 200 });
  assert.equal(data.playbackVerified, false); assert.equal(data.checks.passed, null);
  for (const privateValue of ['1491242185331576884', '1491242185331576885', '1491242185331576886',
    '1491242185331576887', '00000000-0000-4000', 'requesterId', 'channelId', 'messageId', path]) assert(!stdout.includes(privateValue));
  assert(stdout.length < 6000); assert.match(data.notes.join(' '), /not representative production percentiles/);
});

test('nearest-rank sample p95, median and per-attempt repeated-stage totals have explicit denominators', async t => {
  const rows = Array.from({ length: 20 }, (_, i) => attempt(i + 1));
  rows[0].stages.push({ stage: 'download', outcome: 'failed', durationMs: 50, itemIndex: 1 });
  const { path } = await fixture(t, rows), { data } = await report(path);
  assert.deepEqual(data.latency.confirmed, { samples: 20, medianMs: 1050, p95Ms: 1900 });
  assert.equal(data.stages.download.samples, 20); assert.equal(data.stages.download.p95Ms, 950);
  assert.equal(data.stages.download.outcomes.ok, 20); assert.equal(data.stages.download.outcomes.failed, 1);
  assert.deepEqual(data.stages.convert, { samples: 0, medianMs: null, p95Ms: null,
    outcomes: { ok: 0, unavailable: 0, busy: 0, timeout: 0, cancelled: 0, failed: 0 } });
});

test('since, platform, path and cache filters apply before release requirements and latency selection', async t => {
  const { path } = await fixture(t, [attempt(1, { startedAt: since - 1 }), attempt(2, { cache: 'hit' }),
    attempt(3, { platform: 'instagram', path: 'native' }), attempt(4, { path: 'attachment' }),
    attempt(5, { startedAt: since }), attempt(6, { outcome: 'unavailable' })]);
  const result = await report(path, '--since', '2026-09-15T12:00:00Z', '--platform', 'erome',
    '--path', 'hosted-original', '--cache', 'miss', '--min-completed', '2', '--require', 'erome:confirmed');
  assert.equal(result.code, 0); assert.equal(result.data.samples.selected, 2);
  assert.equal(result.data.latency.allCompleted.samples, 2); assert.equal(result.data.latency.confirmed.samples, 1);
  assert.equal(result.data.checks.requirements[0].observed, 1);
  const missing = await report(path, '--platform', 'erome', '--require', 'instagram:confirmed');
  assert.equal(missing.code, 1); assert.equal(missing.data.checks.requirements[0].met, false);
});

test('controlled release checks fail for insufficient samples, missing expected outcomes and selected uncertainty', async t => {
  const { path } = await fixture(t, [attempt(1), attempt(2, { outcome: 'metadata-unconfirmed' }),
    attempt(3, { outcome: 'interrupted', durationMs: undefined }), attempt(4, { outcome: undefined, durationMs: undefined }),
    attempt(5, { durationMs: undefined })]);
  const result = await report(path, '--min-completed', '3', '--require', 'erome:confirmed:2',
    '--reject-outcome', 'interrupted', '--reject-outcome', 'metadata-unconfirmed', '--reject-outcome', 'pending');
  assert.equal(result.code, 1); assert.equal(result.data.samples.completed, 2);
  assert.equal(result.data.checks.minimumCompleted.met, false); assert.equal(result.data.checks.requirements[0].observed, 1);
  assert.deepEqual(result.data.checks.rejected.map(item => item.met), [false, false, false]);
  const allowed = await report(path, '--since', new Date(since + 1).toISOString(), '--require', 'erome:confirmed');
  assert.equal(allowed.code, 0, 'uncertainty is rejected only when explicitly selected by a release check');
});

test('missing cache/path stay unknown and an empty report is not evidence of a passing release requirement', async t => {
  const first = await fixture(t, [attempt(1, { path: undefined, cache: undefined })]);
  const { data } = await report(first.path, '--cache', 'unknown');
  assert.equal(data.counts.path.unknown, 1); assert.equal(data.counts.cache.unknown, 1);
  const empty = await fixture(t, []), result = await report(empty.path, '--min-completed', '1', '--require', 'erome:confirmed');
  assert.equal(result.code, 1); assert.deepEqual(result.data.latency.confirmed, { samples: 0, medianMs: null, p95Ms: null });
});

test('malformed JSON, private extra fields, unknown enums, duplicate attempts and invalid finite metadata fail closed', async t => {
  const { path } = await fixture(t);
  const privateContent = 'private-caption-https://private.example/media';
  const invalid = ['{', { version: 2, attempts: [] }, { version: 1, attempts: [], caption: privateContent },
    ...[attempt(1, { caption: privateContent }), attempt(1, { cache: privateContent }), attempt(1, { path: privateContent }),
      attempt(1, { requesterId: 1491242185331576884 }), attempt(1, { durationMs: -1 }), attempt(1, { durationMs: null }),
      attempt(1, { stages: [{ stage: 'download', durationMs: 10, outcome: 'ok', url: privateContent }] }),
      attempt(1, { stages: [{ stage: 'download', durationMs: 1e200, outcome: 'ok' }] }),
      attempt(1, { stages: Array.from({ length: 97 }, () => ({ stage: 'queue', durationMs: 0, outcome: 'ok' })) })]
      .map(record => ({ version: 1, attempts: [record] })), { version: 1, attempts: [attempt(1), attempt(1)] },
    { version: 1, attempts: Array.from({ length: 4097 }, (_, i) => attempt(i + 1)) }];
  for (const value of invalid) {
    await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
    const result = await report(path);
    assert.equal(result.code, 2); assert(['invalid_json', 'invalid_schema'].includes(result.data.error));
    assert(!result.output.includes(privateContent)); assert(!result.output.includes(path)); assert(result.output.length < 50);
  }
});

test('capped file reads reject oversized, nonregular, hardlinked and missing inputs without disclosing paths', async t => {
  const { path, directory } = await fixture(t);
  await writeFile(path, Buffer.alloc(4 * 1024 * 1024 + 1, 32));
  assert.equal((await report(path)).data.error, 'too_large');
  assert.equal((await report(directory)).data.error, 'invalid_file');
  assert.equal((await report(join(directory, 'secret-filename'))).data.error, 'read_failed');
  await writeFile(path, JSON.stringify({ version: 1, attempts: [] }));
  await link(path, join(directory, 'hardlink'));
  assert.equal((await report(path)).data.error, 'invalid_file');
});

test('invalid CLI values are never echoed and actual CLI failures use nonzero exit status', async t => {
  const { path } = await fixture(t);
  const invalid = [['--unknown', 'private'], ['--since', '2026-02-30T00:00:00Z'], ['--since', 'yesterday'],
    ['--min-completed', '-1'], ['--min-completed', '4097'], ['--require', 'secret:confirmed'],
    ['--require', 'erome:confirmed:0'], ['--reject-outcome', 'secret'], ['--path', 'http://private.example'],
    ['--cache', 'all'], ['--platform', 'erome', '--platform', 'x'], ['--since']];
  for (const args of invalid) assert.deepEqual((await report(path, ...args)).data, { error: 'invalid_args' });
  await assert.rejects(execute(process.execPath, [cli, '--file', path, '--require', 'erome:confirmed']), error =>
    error.code === 1 && JSON.parse(error.stdout).checks.passed === false && error.stderr === '');
  await assert.rejects(execute(process.execPath, [cli, '--file', join(path, 'private')]), error =>
    error.code === 2 && JSON.parse(error.stdout).error === 'read_failed' && error.stderr === '');
});

test('reader returns only finite aggregate inputs and discards all identity and item fields', async t => {
  const { path } = await fixture(t, [attempt(1)]), rows = await readDeliveryHistory(path);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['cache', 'durationMs', 'outcome', 'path', 'platform', 'stages', 'startedAt']);
  assert.deepEqual(Object.keys(rows[0].stages[0]).sort(), ['durationMs', 'outcome', 'stage']);
});

test('operator can stream the standalone script to node stdin without installing application dependencies', async t => {
  const { path } = await fixture(t, [attempt(1)]);
  const source = await readFile(cli, 'utf8');
  const output = await new Promise((done, reject) => {
    const child = execFile(process.execPath, ['--input-type=module', '-', '--file', path, '--require', 'erome:confirmed'],
      { timeout: 5000, maxBuffer: 16 * 1024 }, (error, stdout, stderr) => error ? reject(error) : done({ stdout, stderr }));
    child.stdin.end(source);
  });
  assert.equal(output.stderr, ''); assert.equal(JSON.parse(output.stdout).checks.passed, true);
});
