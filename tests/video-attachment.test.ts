import assert from 'node:assert/strict';
import { stat, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createVideoAttachment, MAX_ATTACHMENT_BYTES, MAX_VIDEO_BYTES } from '../src/services/VideoAttachment';

const info = (duration = 30, width = 1280, height = 720) => JSON.stringify({
  format: { duration: String(duration) }, streams: [{ codec_type: 'video', width, height, duration: String(duration) }],
});

test('video conversion uses local-only subprocesses, bounded codecs and cleans temporary files', async () => {
  const calls: { program: string; args: readonly string[]; cwd: string; timeout: number; env: NodeJS.ProcessEnv }[] = [];
  const convert = createVideoAttachment({ execute: async (program, args, options) => {
    calls.push({ program, args, ...options });
    if (program === 'ffmpeg') { await writeFile(args.at(-1)!, 'synthetic MP4 output'); return ''; }
    return info();
  } });
  assert.equal((await convert(Buffer.from('synthetic MP4 input')))?.toString(), 'synthetic MP4 output');
  assert.deepEqual(calls.map(call => call.program), ['ffprobe', 'ffmpeg', 'ffprobe']);
  for (const call of calls) {
    assert.equal(call.args[call.args.indexOf('-protocol_whitelist') + 1], 'file');
    assert.equal(call.args[call.args.indexOf('-format_whitelist') + 1], 'mov');
    assert.ok(call.timeout <= 150_000);
    assert.equal(call.args.some(arg => arg.includes('https://')), false);
    assert.deepEqual(Object.keys(call.env).sort(), process.platform === 'win32' ? ['LANG', 'LC_ALL', 'PATH', 'SystemRoot'] : ['LANG', 'LC_ALL', 'PATH']);
  }
  const encode = calls[1].args;
  assert.equal(encode[encode.indexOf('-c:v') + 1], 'libx264');
  assert.equal(encode[encode.indexOf('-c:a') + 1], 'aac');
  assert.equal(encode[encode.lastIndexOf('-threads') + 1], '2');
  assert.equal(encode[encode.indexOf('-filter_threads') + 1], '2');
  assert.equal(encode[encode.indexOf('-fs') + 1], String(MAX_ATTACHMENT_BYTES + 1));
  assert.equal(encode.includes('-t'), false);
  await assert.rejects(stat(calls[0].cwd), { code: 'ENOENT' });
});

test('video conversion rejects empty or oversized inputs without starting a process', async () => {
  const convert = createVideoAttachment({ execute: async () => { assert.fail('invalid bytes probed'); } });
  assert.equal(await convert(Buffer.alloc(0)), null);
  assert.equal(await convert(Buffer.alloc(MAX_VIDEO_BYTES + 1)), null);
});

test('video conversion rejects missing, malformed, oversized or overlong metadata', async () => {
  for (const probe of ['not JSON', '{}', 'null', info(301), info(0), info(-1), info(30, 9000, 9000),
    JSON.stringify({ format: { duration: 'Infinity' }, streams: [{ codec_type: 'video', width: 100, height: 100 }] }),
    JSON.stringify({ format: { duration: '30' }, streams: [{ codec_type: 'audio' }] })]) {
    let directory = '';
    assert.equal(await createVideoAttachment({ execute: async (program, _args, options) => {
      directory = options.cwd; assert.equal(program, 'ffprobe'); return probe;
    } })(Buffer.from('synthetic input')), null);
    await assert.rejects(stat(directory), { code: 'ENOENT' });
  }
});

test('video conversion rejects size-limited truncation and oversized or invalid output', async () => {
  for (const scenario of ['truncated', 'oversized', 'empty', 'over-resolution', 'too-long']) {
    let probes = 0, directory = '';
    const result = await createVideoAttachment({ execute: async (program, args, options) => {
      directory = options.cwd;
      if (program === 'ffmpeg') {
        await writeFile(args.at(-1)!, scenario === 'oversized' ? Buffer.alloc(MAX_ATTACHMENT_BYTES + 1) :
          scenario === 'empty' ? '' : 'synthetic output'); return '';
      }
      if (++probes === 1) return info();
      return scenario === 'truncated' ? info(20) : scenario === 'over-resolution' ? info(30, 1920, 1080) :
        scenario === 'too-long' ? info(35) : info();
    } })(Buffer.from('synthetic input'));
    assert.equal(result, null, scenario);
    await assert.rejects(stat(directory), { code: 'ENOENT' });
  }
});

test('video conversion cleans up and unlocks when ffprobe or ffmpeg fails or times out', async () => {
  for (const failProgram of ['ffprobe', 'ffmpeg']) {
    let directory = '';
    assert.equal(await createVideoAttachment({ execute: async (program, _args, options) => {
      directory = options.cwd;
      if (program === failProgram) throw new Error('process timeout');
      return info();
    } })(Buffer.from('synthetic input')), null);
    await assert.rejects(stat(directory), { code: 'ENOENT' });
  }
});

test('only one transcode can run across converter instances', async () => {
  let release!: (text: string) => void, probes = 0;
  const convert = createVideoAttachment({ execute: async (program, args) => {
    if (program === 'ffmpeg') { await writeFile(args.at(-1)!, 'synthetic output'); return ''; }
    return ++probes === 1 ? new Promise<string>(resolve => { release = resolve; }) : info();
  } });
  const pending = convert(Buffer.from('synthetic input'));
  assert.equal(await createVideoAttachment({ execute: async () => { assert.fail('concurrent process started'); } })(Buffer.from('input')), null);
  // The first request creates and writes its temporary input before starting ffprobe.
  while (!release) await new Promise(resolve => setImmediate(resolve));
  release(info());
  assert.ok(await pending);
});
