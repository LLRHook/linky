import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { archiveDelivery, DeliveryArchive, readDeliveryArchive, type DeliveryArchiveOptions, type ArchivedDelivery } from '../src/services/DeliveryArchive';
import { DeliveryDiagnostics } from '../src/services/DeliveryDiagnostics';
import { atomicWrite } from '../src/services/AtomicWrite';

const NOW = Date.parse('2026-09-17T12:00:00Z'), DAY = 86_400_000;
const request = { requesterId: '100000000000000001', channelId: '100000000000000002', guildId: '100000000000000003',
  platform: 'erome' as const, mode: 'automatic' as const };
const attempt = (changes: Partial<ArchivedDelivery> = {}): ArchivedDelivery => ({ id: randomUUID(), startedAt: NOW,
  platform: 'erome', mode: 'automatic', outcome: 'confirmed', durationMs: 1_234, path: 'hosted-original', cache: 'hit',
  stages: [{ stage: 'preview', durationMs: 234, outcome: 'ok' }], ...changes });

async function fixture(t: TestContext, options: Partial<DeliveryArchiveOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'linky-archive-'));
  const archive = new DeliveryArchive({ directory, now: () => NOW, ...options });
  t.after(async () => { await archive.close(); await rm(directory, { recursive: true, force: true }); });
  await archive.ready; await archive.flush();
  return { directory, archive };
}

test('article cards retain their own platform and explicit path without storing publisher metadata', async t => {
  const { archive, directory } = await fixture(t);
  const article = attempt({ platform: 'articles', path: 'explicit', cache: undefined,
    stages: [{ stage: 'resolve', durationMs: 150, outcome: 'ok' }, { stage: 'preview', durationMs: 1, outcome: 'ok' }] });
  assert.equal(archive.record({ ...article, sourceUrl: 'https://publisher.com/story', title: 'Private candidate title' }), true);
  assert.equal(await archive.flush(), true);
  const rows = (await readDeliveryArchive(directory)).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].platform, 'articles');
  assert.equal(rows[0].path, 'explicit');
  assert.doesNotMatch(JSON.stringify(rows), /publisher|candidate title|sourceUrl/);
});

test('archive copies only finalized finite fields, writes privately and deduplicates UUIDs', async t => {
  const { archive, directory } = await fixture(t);
  const record = attempt();
  const contaminated = { ...record, ...request, messageId: '100000000000000004', sourceUrl: 'https://private.invalid/secret',
    caption: 'private caption', error: 'arbitrary provider error', stages: [{ ...record.stages[0], secret: 'private caption' }] };
  assert.equal(archive.record(contaminated), true);
  assert.equal(archive.record(contaminated), true);
  assert.equal(await archive.flush(), true);
  const loaded = await readDeliveryArchive(directory);
  assert.deepEqual(loaded.rows, [record]);
  const raw = await readFile(join(directory, '2026-09-17.jsonl'), 'utf8');
  assert.doesNotMatch(raw, /10000000000000000|private|caption|sourceUrl|messageId|requesterId|guildId|channelId|error/);
  assert.equal(archive.snapshot().counters.duplicates, 1);
  for (const invalid of [{ outcome: undefined }, { outcome: 'private error' }, { durationMs: Infinity },
    { id: '100000000000000001' }, { platform: 'https://private.invalid' },
    { stages: [{ stage: 'download', durationMs: 1, outcome: 'bad error' }] }]) {
    assert.equal(archive.record({ ...record, ...invalid }), false);
  }
  if (process.platform !== 'win32') {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, '2026-09-17.jsonl'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, 'health.json'))).mode & 0o777, 0o600);
  }
});

test('UTC rotation removes the boundary day before it exceeds retention and rejects expired backfill', async t => {
  let now = NOW;
  const { archive, directory } = await fixture(t, { now: () => now, retentionDays: 2 });
  assert(archive.record(attempt({ startedAt: NOW - DAY })));
  assert(archive.record(attempt()));
  await archive.flush();
  assert.deepEqual((await readdir(directory)).sort(), ['2026-09-16.jsonl', '2026-09-17.jsonl', 'health.json']);
  now += DAY;
  await archive.flush();
  assert.equal(archive.record(attempt({ startedAt: NOW - DAY + 60_000 })), false);
  assert.deepEqual((await readdir(directory)).sort(), ['2026-09-17.jsonl', 'health.json']);
  assert.deepEqual(archive.snapshot().observedDays.map(entry => entry.day), ['2026-09-17', '2026-09-18']);
});

test('restart deduplicates historical finals and archives persisted unfinished attempts as interrupted', async t => {
  const { archive, directory } = await fixture(t);
  const path = join(directory, 'details-test.json');
  const diagnostics = new DeliveryDiagnostics({ path, archive, wallNow: () => NOW });
  const done = diagnostics.begin(request); done.finish('confirmed');
  const pending = diagnostics.begin(request); pending.startStage('download').finish('unavailable');
  await diagnostics.close(); await archive.close();
  const restartedArchive = new DeliveryArchive({ directory, now: () => NOW });
  const restarted = new DeliveryDiagnostics({ path, archive: restartedArchive, wallNow: () => NOW });
  await restarted.ready; await restarted.close(); await restartedArchive.close();
  const rows = (await readDeliveryArchive(directory)).rows;
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.id === done.id)?.outcome, 'confirmed');
  assert.equal(rows.find(row => row.id === pending.id)?.outcome, 'interrupted');
  assert.equal(rows.find(row => row.id === pending.id)?.durationMs, undefined, 'Restart does not invent elapsed monotonic time');
  assert.equal(restartedArchive.snapshot().counters.duplicates, 1);
});

test('a trace evicted by the interactive Details cap still archives its eventual outcome once', async t => {
  const { archive, directory } = await fixture(t);
  let mono = 0;
  const diagnostics = new DeliveryDiagnostics({ path: join(directory, 'details-test.json'), archive,
    wallNow: () => NOW, monotonicNow: () => mono, maxAttempts: 1 });
  await diagnostics.ready;
  const evicted = diagnostics.begin(request), stage = evicted.startStage('download');
  const current = diagnostics.begin(request);
  mono = 10; evicted.setCache?.('hit'); evicted.setPath('attachment'); evicted.finish('timeout'); stage.finish(); evicted.finish('confirmed');
  current.finish('confirmed'); await diagnostics.close(); await archive.flush();
  const rows = (await readDeliveryArchive(directory)).rows;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.find(row => row.id === evicted.id), { id: evicted.id, startedAt: NOW, platform: 'erome', mode: 'automatic',
    outcome: 'timeout', path: 'attachment', cache: 'hit', durationMs: 10, stages: [{ stage: 'download', durationMs: 10, outcome: 'timeout' }] });
  assert.equal(JSON.parse(await readFile(join(directory, 'details-test.json'), 'utf8')).attempts.length, 1);
});

test('failed archive writes leave delivery nonblocking, retry the queued record and account for bounded drops', async t => {
  let fail = true;
  const warnings: string[] = [];
  const { archive, directory } = await fixture(t, { maxQueue: 2, retryMs: 10,
    onWarning: code => { warnings.push(code); }, append: async (path, line) => {
      if (fail) throw Error('secret filesystem error');
      await appendFile(path, line, { mode: 0o600 });
    } });
  const path = join(directory, 'details-test.json');
  const diagnostics = new DeliveryDiagnostics({ path, archive, wallNow: () => NOW });
  const trace = diagnostics.begin(request); trace.finish('confirmed');
  assert.equal(await diagnostics.bind(trace.id, '100000000000000004'), true);
  assert.equal(await archive.flush(), false);
  assert(archive.record(attempt())); assert.equal(archive.record(attempt()), false);
  assert.equal(archive.snapshot().queued, 2);
  assert.equal(archive.snapshot().counters.queueDrops, 1);
  assert(warnings.includes('write_failed')); assert(warnings.includes('queue_full'));
  assert.doesNotMatch(JSON.stringify(warnings), /secret/);
  fail = false;
  await new Promise(resolve => setTimeout(resolve, 25)); await archive.flush();
  assert.equal((await readDeliveryArchive(directory)).rows.length, 2);
  assert.equal(archive.snapshot().queued, 0);
  await diagnostics.close();
});

test('disk capacity evicts whole daily files and startup counts oversized files before accepting new data', async t => {
  const { archive, directory } = await fixture(t, { maxBytes: 128 * 1_024 });
  const stages = Array.from({ length: 96 }, () => ({ stage: 'download' as const, durationMs: 1, outcome: 'ok' as const }));
  for (let index = 0; index < 30; index++) archive.record(attempt({ stages }));
  await archive.flush();
  assert(archive.snapshot().counters.capacityFiles > 0);
  let bytes = 0; for (const name of await readdir(directory)) bytes += (await stat(join(directory, name))).size;
  assert(bytes <= 128 * 1_024);
  await archive.close();
  await writeFile(join(directory, '2026-09-16.jsonl'), 'x'.repeat(200 * 1_024));
  const restarted = new DeliveryArchive({ directory, now: () => NOW, maxBytes: 128 * 1_024 });
  assert(restarted.record(attempt())); await restarted.close();
  assert(!(await readdir(directory)).includes('2026-09-16.jsonl'));
  bytes = 0; for (const name of await readdir(directory)) bytes += (await stat(join(directory, name))).size;
  assert(bytes <= 128 * 1_024);
  assert(restarted.snapshot().counters.readErrors > 0);
});

test('close has a finite wait and stalled persistence never throws from record or traces', async t => {
  let release: (() => void) | undefined;
  const { archive } = await fixture(t, { closeTimeoutMs: 10, append: async () => {
    await new Promise<void>(resolve => { release = resolve; });
  } });
  assert(archive.record(attempt()));
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const closing = archive.close();
  assert.equal(await closing, false);
  assert.equal(archive.snapshot().counters.closeTimeouts, 1);
  assert.equal(archive.record(attempt()), false);
  release(); await archive.flush();
  assert.equal(archive.snapshot().queued, 0);
});

test('reader counts corrupt and unfinished lines without leaking arbitrary data', async t => {
  const { archive, directory } = await fixture(t);
  const clean = attempt(); archive.record(clean); await archive.close();
  await appendFile(join(directory, '2026-09-17.jsonl'), '\n{"caption":"secret"}\n{"incomplete":');
  const read = await readDeliveryArchive(directory);
  assert.deepEqual(read.rows, [clean]); assert.equal(read.invalidLines, 2);
  assert.doesNotMatch(JSON.stringify(read), /secret|caption|incomplete/);
  assert.equal(archiveDelivery({ ...clean, stages: Array.from({ length: 97 }, () => clean.stages[0]) }), undefined);
});

test('close drains a record queued while the previous flush is writing its health snapshot', async t => {
  let block = false, release: (() => void) | undefined;
  const { archive, directory } = await fixture(t, { writeHealth: async (path, content) => {
    if (block) { block = false; await new Promise<void>(resolve => { release = resolve; }); }
    await atomicWrite(path, content);
  } });
  block = true;
  const first = archive.flush();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  archive.record(attempt());
  const closing = archive.close();
  release(); await first;
  assert.equal(await closing, true);
  assert.equal((await readDeliveryArchive(directory)).rows.length, 1);
});

test('startup cleans only its abandoned atomic health files and preserves unrelated files', async t => {
  const { archive, directory } = await fixture(t);
  await archive.close();
  const temporary = `health.json.${randomUUID()}.tmp`;
  await writeFile(join(directory, temporary), 'x'.repeat(200 * 1_024));
  await writeFile(join(directory, 'unrelated.tmp'), 'keep');
  const restarted = new DeliveryArchive({ directory, now: () => NOW });
  await restarted.close();
  assert(!(await readdir(directory)).includes(temporary));
  assert.equal(await readFile(join(directory, 'unrelated.tmp'), 'utf8'), 'keep');
});

test('explicit community delivery paths round-trip separately from historical native observations', async t => {
  const { archive, directory } = await fixture(t);
  const diagnostics = new DeliveryDiagnostics({ path: join(directory, 'details-test.json'), archive, wallNow: () => NOW });
  await diagnostics.ready;
  for (const path of ['native', 'explicit'] as const) {
    const trace = diagnostics.begin({ ...request, platform: 'youtube' });
    trace.setPath(path); trace.finish('confirmed');
  }
  await diagnostics.close(); await archive.flush();
  const rows = (await readDeliveryArchive(directory)).rows;
  assert.deepEqual(rows.map(row => row.path).sort(), ['explicit', 'native']);
  const saved = JSON.parse(await readFile(join(directory, 'details-test.json'), 'utf8'));
  assert.deepEqual(saved.attempts.map((row: any) => row.path).sort(), ['explicit', 'native']);
});

test('unsupported community mixtures round-trip through diagnostics and archive without becoming provider failures', async t => {
  const { archive, directory } = await fixture(t);
  const diagnostics = new DeliveryDiagnostics({ path: join(directory, 'details-test.json'), archive, wallNow: () => NOW });
  await diagnostics.ready;
  const trace = diagnostics.begin({ ...request, platform: 'mixed' }); trace.setPath('explicit'); trace.finish('unsupported');
  await diagnostics.close(); await archive.flush();
  assert.equal((await readDeliveryArchive(directory)).rows[0].outcome, 'unsupported');
  const restarted = new DeliveryDiagnostics({ path: join(directory, 'details-test.json'), wallNow: () => NOW });
  await restarted.ready; await restarted.close();
  assert.equal(JSON.parse(await readFile(join(directory, 'details-test.json'), 'utf8')).attempts[0].outcome, 'unsupported');
});
