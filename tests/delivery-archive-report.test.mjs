import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createArchiveReport, formatArchiveReport, runArchiveReport } from '../ops/delivery-archive-report.mjs';

const NOW = Date.parse('2026-09-17T12:00:00Z'), DAY = 86_400_000;
const row = (changes = {}) => ({ id: randomUUID(), startedAt: NOW - 1_000, platform: 'erome', mode: 'automatic',
  path: 'hosted-original', cache: 'hit', outcome: 'confirmed', durationMs: 100, stages: [], ...changes });
const counters = { written: 0, duplicates: 0, queueDrops: 0, invalidDrops: 0, expiredDrops: 0, closedDrops: 0,
  writeErrors: 0, capacityFiles: 0, invalidLines: 0, readErrors: 0, closeTimeouts: 0 };
const input = rows => ({ rows, files: [], invalidLines: 0, readErrors: 0, scanLimited: false,
  health: { version: 1, firstStartedAt: NOW - 60 * DAY, updatedAt: NOW, retentionDays: 30, maxBytes: 64 * 1_024 * 1_024,
    counters, observedDays: Array.from({ length: 8 }, (_, index) => {
      const when = NOW - index * DAY;
      return { day: new Date(when).toISOString().slice(0, 10), firstSeenAt: when, lastSeenAt: when };
    }) } });

test('archive report deduplicates UUIDs and exposes all-finalized confirmation denominator without identities', () => {
  const a = row(), b = row({ platform: 'instagram', path: 'native', cache: undefined, outcome: 'metadata-unconfirmed', durationMs: 500 }),
    c = row({ outcome: 'interrupted', durationMs: undefined }), d = row({ outcome: 'disabled', durationMs: 50 });
  const report = createArchiveReport(input([a, a, b, c, d]), { now: NOW, days: 7 });
  assert.deepEqual(report.confirmation, { confirmed: 1, denominator: 4, rate: 0.25,
    denominatorDefinition: 'all recorded finalized attempts in the selected time window', playbackVerified: false });
  assert.equal(report.coverage.duplicatesIgnored, 1);
  assert.deepEqual(report.latency.allCompleted, { samples: 3, medianMs: 100, p95Ms: 500 });
  assert.deepEqual(report.counts.cache, { hit: 3, miss: 0, unknown: 1 });
  assert.equal(report.byPlatform.instagram.outcomes['metadata-unconfirmed'], 1);
  assert.equal(report.byPath['hosted-original'].attempts, 3);
  assert.equal(report.byPath.native.confirmation.denominator, 1);
  assert.deepEqual(report.coverage.warnings, []);
  assert.doesNotMatch(JSON.stringify(report), new RegExp([a.id, b.id, c.id, d.id].join('|')));
  assert.match(formatArchiveReport(report), /not a playback success rate/);
});

test('stage totals sum repeated spans per completed attempt and retain interrupted failure counts', () => {
  const a = row({ stages: [{ stage: 'download', durationMs: 20, outcome: 'ok' }, { stage: 'download', durationMs: 80, outcome: 'timeout' }] });
  const b = row({ outcome: 'interrupted', durationMs: undefined,
    stages: [{ stage: 'download', durationMs: 500, outcome: 'failed' }] });
  const report = createArchiveReport(input([a, b]), { now: NOW });
  assert.deepEqual(report.stages.download, { samples: 1, medianMs: 100, p95Ms: 100, spanSamples: 3,
    outcomes: { ok: 1, unavailable: 0, busy: 0, timeout: 1, cancelled: 0, failed: 1 } });
  assert.match(formatArchiveReport(report), /Stage download: n=1, median=100 ms, p95=100 ms; spans=3; timeout=1, failed=1/);
});

test('coverage distinguishes heartbeat markers, expiry, capacity and lifetime write failures', () => {
  const data = input([]); data.health.retentionDays = 7;
  let report = createArchiveReport(data, { now: NOW, days: 7 });
  assert.deepEqual(report.coverage.missingDays, []);
  assert(report.coverage.warnings.includes('requested_window_exceeds_retention'));
  assert.equal(report.coverage.retentionBoundaryAt, '2026-09-11T00:00:00.000Z');
  data.health.observedDays = data.health.observedDays.slice(0, 2);
  data.health.counters = { ...counters, queueDrops: 1, capacityFiles: 1, writeErrors: 1 };
  report = createArchiveReport(data, { now: NOW });
  assert.equal(report.coverage.missingDays.length, 6);
  assert(report.coverage.warnings.includes('capacity_evictions_recorded'));
  assert(report.coverage.warnings.includes('archive_loss_or_io_errors_recorded'));
  assert.equal(report.confirmation.rate, null);
  assert.equal(report.latency.allCompleted.medianMs, null);
  assert.match(report.notes.join(' '), /not uninterrupted coverage/);
});

test('report excludes out-of-window samples and counts conflicting duplicates without exposing their contents', () => {
  const a = row();
  const report = createArchiveReport(input([a, { ...a, outcome: 'timeout' }, row({ startedAt: NOW + 1 }),
    row({ startedAt: NOW - 8 * DAY })]), { now: NOW });
  assert.equal(report.samples.selected, 1);
  assert.equal(report.coverage.conflictingDuplicates, 1);
  assert(report.coverage.warnings.includes('conflicting_duplicate_attempts'));
});

test('CLI validates its finite window, returns fixed errors and can produce text or JSON without exposing paths', async () => {
  for (const args of [['--days', '0'], ['--days', '91'], ['--days', '7', '--days', '7'], ['--secret', 'private-token'], ['--json', '--json']]) {
    const output = [];
    assert.equal(await runArchiveReport(args, value => output.push(value), async () => assert.fail('Invalid arguments must not read files')), 2);
    assert.doesNotMatch(output.join(''), /private-token/);
  }
  let path;
  const output = [];
  assert.equal(await runArchiveReport(['--days', '7', '--json', '--directory', 'private-path'], value => output.push(value),
    async directory => { path = directory; return input([row({ startedAt: Date.now() - 100 })]); }), 0);
  assert.equal(path, 'private-path');
  assert.equal(JSON.parse(output[0]).scope, 'operator-local-archive');
  assert.doesNotMatch(output[0], /private-path/);
  const unavailable = [];
  assert.equal(await runArchiveReport([], value => unavailable.push(value), async () => ({ ...input([]), readErrors: 1 })), 1);
  assert.match(unavailable[0], /unreadable_or_invalid_records/);
});

test('archive aggregate keeps unsupported mixtures distinct in the all-finalized denominator', () => {
  const report = createArchiveReport(input([row({ platform: 'mixed', path: 'explicit', outcome: 'unsupported' })]), { now: NOW });
  assert.equal(report.confirmation.confirmed, 0); assert.equal(report.confirmation.denominator, 1);
  assert.equal(report.counts.outcome.unsupported, 1); assert.equal(report.counts.outcome['metadata-unconfirmed'], 0);
});
