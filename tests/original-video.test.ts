import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { createOriginalVideoInspector, MAX_ORIGINAL_VIDEO_BYTES } from '../src/services/VideoAttachment';

const source = Buffer.from('complete original bytes supplied by the downloader');
const video = (fields: Record<string, unknown> = {}) => ({
  codec_type: 'video', codec_name: 'h264', profile: 'High', pix_fmt: 'yuv420p',
  width: 1280, height: 720, duration: '160.121', avg_frame_rate: '30/1', r_frame_rate: '30/1',
  disposition: { attached_pic: 0 }, ...fields,
});
const audio = (fields: Record<string, unknown> = {}) => ({
  codec_type: 'audio', codec_name: 'aac', duration: '160.121', disposition: { attached_pic: 0 }, ...fields,
});
const info = (streams: Record<string, unknown>[] = [video(), audio()], duration = '160.121') =>
  JSON.stringify({ format: { duration }, streams });

test('original inspection writes unchanged private bytes and invokes only a bounded local ffprobe', async () => {
  let directory = '', file = '', calls = 0;
  const inspect = createOriginalVideoInspector({ execute: async (program, args, options) => {
    calls++; directory = options.cwd; file = args.at(-1)!;
    assert.equal(program, 'ffprobe');
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.equal(dirname(file), directory);
    assert.deepEqual(await readFile(file), source);
    assert.equal(options.timeout, 2_000);
    assert.equal(options.signal?.aborted, false);
    assert.deepEqual(Object.keys(options.env).sort(),
      process.platform === 'win32' ? ['LANG', 'LC_ALL', 'PATH', 'SystemRoot'] : ['LANG', 'LC_ALL', 'PATH']);
    for (const [flag, value] of [['-protocol_whitelist', 'file'], ['-format_whitelist', 'mov'],
      ['-enable_drefs', '0'], ['-use_absolute_path', '0'], ['-threads', '2'], ['-max_alloc', '134217728']]) {
      assert.equal(args[args.indexOf(flag) + 1], value);
    }
    assert.match(args[args.indexOf('-show_entries') + 1], /stream_disposition=attached_pic/);
    assert.equal(args.some(arg => /https?:|pipe:/.test(arg)), false);
    for (const flag of ['-t', '-vf', '-c:v', '-show_frames', '-show_packets', '-count_frames']) assert.equal(args.includes(flag), false);
    if (process.platform !== 'win32') {
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
    return info();
  } });
  assert.deepEqual(await inspect(source), { width: 1280, height: 720, duration: 160.121, fps: 30 });
  assert.equal(calls, 1);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  await assert.rejects(stat(file), { code: 'ENOENT' });
});

test('original inspection accepts supported profiles, portrait, no audio and exact policy boundaries', async () => {
  for (const profile of ['Constrained Baseline', 'Baseline', 'Main', 'High']) {
    for (const [width, height] of [[1920, 1080], [1080, 1920]]) {
      const inspect = createOriginalVideoInspector({ execute: async () => info([video({
        profile, width, height, duration: '300', avg_frame_rate: '60/1', r_frame_rate: '60/1',
      })], '300') });
      assert.deepEqual(await inspect(source), { width, height, duration: 300, fps: 60 });
    }
  }
  assert.deepEqual(await createOriginalVideoInspector({ execute: async () => info() })(Buffer.alloc(MAX_ORIGINAL_VIDEO_BYTES)),
    { width: 1280, height: 720, duration: 160.121, fps: 30 });
});

test('invalid or cancelled source inputs never start a process', async () => {
  const inspect = createOriginalVideoInspector({ execute: async () => { assert.fail('invalid source was probed'); } });
  assert.equal(await inspect(Buffer.alloc(0)), null);
  assert.equal(await inspect(Buffer.alloc(MAX_ORIGINAL_VIDEO_BYTES + 1)), null);
  assert.equal(await inspect(new Uint8Array(2) as Buffer), null);
  assert.equal(await inspect(source, { signal: AbortSignal.abort() }), null);
});

test('original inspection rejects incompatible codecs, dimensions, rates and full durations', async () => {
  const invalid = [
    info([video({ codec_name: 'hevc' })]), info([video({ profile: 'High 10' })]),
    info([video({ pix_fmt: 'yuv420p10le' })]), info([video(), audio({ codec_name: 'opus' })]),
    info([video(), audio({ codec_name: '' })]),
    info([video({ width: 1921, height: 1080 })]), info([video({ width: 1081, height: 1920 })]),
    info([video({ width: 0 })]), info([video({ width: 1279.5 })]),
    info([video({ avg_frame_rate: '61/1' })]), info([video({ r_frame_rate: '120/1' })]),
    info([video({ avg_frame_rate: '0/0', r_frame_rate: '0/0' })]),
    info([video()], '301'), info([video({ duration: '301' })]), info([video(), audio({ duration: '301' })]),
    info([video()], '0'), info([video()], 'Infinity'), info([video({ codec_name: undefined })]),
    info([video({ pix_fmt: undefined })]),
  ];
  for (const output of invalid) {
    let directory = '';
    assert.equal(await createOriginalVideoInspector({ execute: async (_program, _args, options) => {
      directory = options.cwd; return output;
    } })(source), null, output);
    await assert.rejects(stat(directory), { code: 'ENOENT' });
  }
});

test('original inspection rejects extra tracks, attached pictures and malformed probe output', async () => {
  for (const output of [
    info([]), info([audio()]), info([video(), video()]), info([video(), audio(), audio()]),
    info([video(), { codec_type: 'data', disposition: { attached_pic: 0 } }]),
    info([video(), { codec_type: 'subtitle', disposition: { attached_pic: 0 } }]),
    info([video({ disposition: { attached_pic: 1 } })]), info([video({ disposition: undefined })]),
    info([video(), audio({ disposition: { attached_pic: 1 } })]),
    'null', '{}', 'not JSON', JSON.stringify({ streams: [null] }), ' '.repeat(128 * 1024 + 1),
  ]) {
    let directory = '';
    assert.equal(await createOriginalVideoInspector({ execute: async (_program, _args, options) => {
      directory = options.cwd; return output;
    } })(source), null);
    await assert.rejects(stat(directory), { code: 'ENOENT' });
  }
});

test('probe failures clean input and cancellation waits for child exit before cleaning input', async () => {
  let failedDirectory = '';
  assert.equal(await createOriginalVideoInspector({ execute: async (_program, _args, options) => {
    failedDirectory = options.cwd; throw new Error('probe unavailable');
  } })(source), null);
  await assert.rejects(stat(failedDirectory), { code: 'ENOENT' });

  const controller = new AbortController();
  let directory = '', processSignal: AbortSignal | undefined;
  let started!: () => void, finish!: (value: string) => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const pending = createOriginalVideoInspector({ execute: async (_program, _args, options) => {
    directory = options.cwd; processSignal = options.signal; started();
    return new Promise<string>(resolve => { finish = resolve; });
  } })(source, { signal: controller.signal });
  await began;
  controller.abort();
  assert.equal(processSignal?.aborted, true);
  let settled = false;
  void pending.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal((await stat(directory)).isDirectory(), true);
  finish(info());
  assert.equal(await pending, null);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('the two-second probe deadline aborts a stalled executor and cleans its private input', async () => {
  let directory = '', processSignal: AbortSignal | undefined, began = 0;
  assert.equal(await createOriginalVideoInspector({ execute: async (_program, _args, options) => {
    directory = options.cwd; processSignal = options.signal; began = performance.now();
    return new Promise<string>((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(new Error('child exited after abort')), { once: true });
    });
  } })(source), null);
  const elapsed = performance.now() - began;
  assert.ok(elapsed >= 1_900 && elapsed < 4_000, `probe deadline took ${elapsed}ms`);
  assert.equal(processSignal?.aborted, true);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});
