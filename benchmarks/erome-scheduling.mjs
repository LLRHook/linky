// Isolated synthetic benchmark: no provider or Discord requests, and no production data.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, statfs } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const application = process.env.LINKY_BENCH_APP ?? resolve('dist');
const schedulerModule = process.env.LINKY_BENCH_SCHEDULER ?? join(application, 'services/EromeWorkScheduler.js');
const { createEromeWorkScheduler } = require(schedulerModule);
const { createVideoAttachment, createOriginalVideoInspector } = require(join(application, 'services/VideoAttachment.js'));
const { rewriteSocialLinks } = require(join(application, 'services/SocialLinkService.js'));
const execute = promisify(execFile), environment = { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' };
const rounded = number => Math.round(number * 1000) / 1000;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))] ?? 0;
const deadline = setTimeout(() => { process.stdout.write(JSON.stringify({ event: 'benchmark', failure: 'deadline' }) + '\n'); process.exit(1); }, 180_000);

// The released baseline had one admitted preparation and two FIFO waiters.
function baseline() {
  let tail = Promise.resolve();
  return { run(_context, _profile, work) {
    const job = tail.then(() => work(new AbortController().signal));
    tail = job.then(() => undefined, () => undefined); return job;
  }, close: () => tail };
}

async function sampleMemory() {
  let containerBytes;
  try { containerBytes = Number(await readFile('/sys/fs/cgroup/memory.current', 'utf8')); } catch { /* Non-cgroup local run. */ }
  const usage = process.memoryUsage(), temporary = await statfs(tmpdir());
  return { nodeRss: usage.rss, external: usage.external, containerBytes,
    temporaryBytes: (temporary.blocks - temporary.bfree) * temporary.bsize };
}

async function run(mode, source) {
  const schedulerEvents = [], scheduler = mode === 'baseline' ? baseline() : createEromeWorkScheduler({ observe: event => schedulerEvents.push(event) });
  const monitor = monitorEventLoopDelay({ resolution: 10 }); monitor.enable();
  const before = await sampleMemory(), peaks = { ...before }, ordinary = [], timerLag = [], jobs = [];
  let sampling, expected = performance.now() + 20;
  const timer = setInterval(() => {
    const started = performance.now(); timerLag.push(Math.max(0, started - expected)); expected = started + 20;
    const content = rewriteSocialLinks('https://x.com/test/status/1234567890123456789');
    assert.ok(content.length > 0); ordinary.push(performance.now() - started);
    if (!sampling) sampling = sampleMemory().then(value => {
      for (const field of Object.keys(peaks)) if (Number.isFinite(value[field])) peaks[field] = Math.max(peaks[field] ?? 0, value[field]);
    }).finally(() => { sampling = undefined; });
  }, 20);
  const started = performance.now(), originalHash = hash(source);
  const request = (guild, profile, work) => {
    const queuedAt = performance.now();
    return scheduler.run({ fairnessKey: guild }, profile, async signal => {
      const runAt = performance.now();
      const result = await work(signal);
      jobs.push({ profile, guild, queueMs: rounded(runAt - queuedAt), completedMs: rounded(performance.now() - started), ...result });
    });
  };
  try {
    const attachment = request('guild-a', 'attachment', async () => {
      const result = await createVideoAttachment()(source, { maxBytes: 1024 * 1024 });
      assert.ok(result); assert.ok(result.length <= 1024 * 1024);
      return { resultBytes: result.length, originalUnchanged: hash(source) === originalHash };
    });
    const original = guild => request(guild, 'original', async signal => {
      await delay(200, undefined, { signal }); // Controlled local source latency; no network access.
      const metadata = await createOriginalVideoInspector()(source, { signal });
      assert.ok(metadata); assert.equal(metadata.width, 1280); assert.equal(metadata.height, 720);
      assert.ok(Math.abs(metadata.duration - 8) < 0.1); assert.equal(hash(source), originalHash);
      return { resultBytes: source.length, originalUnchanged: true, width: metadata.width, height: metadata.height };
    });
    await Promise.all([attachment, original('guild-b'), original('guild-c')]);
    await scheduler.close();
  } finally {
    clearInterval(timer); await sampling; monitor.disable(); await scheduler.close();
  }
  const encoded = jobs.find(job => job.profile === 'attachment');
  const originals = jobs.filter(job => job.profile === 'original');
  return { mode, sourceTransport: 'local-200ms-delay', elapsedMs: rounded(performance.now() - started), jobs,
    originalsBeforeEncoderFinished: originals.filter(job => job.completedMs < encoded.completedMs).length,
    peakTemporaryDeltaBytes: Math.max(0, peaks.temporaryBytes - before.temporaryBytes),
    peakNodeRssBytes: peaks.nodeRss, peakExternalBytes: peaks.external, peakContainerBytes: peaks.containerBytes,
    maxReservedTemporaryBytes: Math.max(0, ...schedulerEvents.map(event => event.scratchBytes)),
    ordinaryLinkCalls: ordinary.length, ordinaryLinkP95Ms: rounded(percentile(ordinary, 0.95)),
    ordinaryTimerLagP95Ms: rounded(percentile(timerLag, 0.95)), eventLoopP95Ms: rounded(monitor.percentile(95) / 1e6) };
}

async function cancellation(source) {
  const scheduler = createEromeWorkScheduler(), controller = new AbortController();
  let encodingStarted, producerFinished = false;
  const started = new Promise(resolve => { encodingStarted = resolve; });
  const pending = scheduler.run({ fairnessKey: 'cancelled', signal: controller.signal }, 'attachment', async signal => {
    try { await createVideoAttachment()(source, { maxBytes: 1024 * 1024, signal, onEncoding: encodingStarted }); }
    finally { producerFinished = true; }
  });
  await started; await delay(150);
  const abortedAt = performance.now(); controller.abort();
  await assert.rejects(pending, error => error.reason === 'cancelled');
  const responseMs = performance.now() - abortedAt;
  let childCount = 0, directories = [];
  await scheduler.run({ fairnessKey: 'next' }, 'attachment', async () => {
    assert.ok(producerFinished);
    for (const pid of (await readdir('/proc')).filter(value => /^\d+$/.test(value))) {
      const command = await readFile(`/proc/${pid}/comm`, 'utf8').catch(() => '');
      if (/^ff(?:mpeg|probe)\n$/.test(command)) childCount++;
    }
    directories = (await readdir(tmpdir())).filter(name => name.startsWith('linky-video-'));
    process.stdout.write(JSON.stringify({ event: 'cancellation_cleanup', producerFinished,
      remainingVideoChildren: childCount, remainingVideoDirectories: directories.length }) + '\n');
    assert.equal(childCount, 0); assert.equal(directories.length, 0);
  });
  await scheduler.close();
  return { responseMs: rounded(responseMs), cleanupBeforeNextAdmissionMs: rounded(performance.now() - abortedAt),
    remainingVideoChildren: childCount, remainingVideoDirectories: directories.length };
}

let directory;
try {
  directory = await mkdtemp(join(tmpdir(), 'linky-scheduler-benchmark-'));
  const path = join(directory, 'source.mp4');
  await execute('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
    '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '14', '-pix_fmt', 'yuv420p', '-threads', '2',
    '-movflags', '+faststart', path], { timeout: 30_000, maxBuffer: 128 * 1024, env: environment });
  const source = await readFile(path); await rm(directory, { recursive: true, force: true }); directory = undefined;
  assert.ok(source.length > 1024 * 1024 && source.length <= 24 * 1024 * 1024);
  const results = [];
  for (const mode of process.env.LINKY_BENCH_CANCELLATION_ONLY === 'true' ? [] : ['baseline', 'scheduler', 'scheduler', 'baseline']) results.push(await run(mode, source));
  assert.ok(results.filter(result => result.mode === 'scheduler').every(result => result.originalsBeforeEncoderFinished === 2));
  assert.ok(results.every(result => result.jobs.every(job => job.originalUnchanged)));
  const cancelled = process.env.LINKY_BENCH_CANCELLATION === 'true' ? await cancellation(source) : undefined;
  process.stdout.write(JSON.stringify({ event: 'scheduler_benchmark', sourceBytes: source.length, trials: results, cancellation: cancelled,
    scope: 'Generated video, three guilds, no cache, no network or Discord; throughput and queue evidence only.' }) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({ event: 'benchmark', failure: 'failed', errorClass: error instanceof assert.AssertionError ? 'AssertionError' : 'Error' }) + '\n');
  process.exitCode = 1;
} finally {
  clearTimeout(deadline); if (directory) await rm(directory, { recursive: true, force: true });
}
