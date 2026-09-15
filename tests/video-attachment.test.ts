import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createVideoAttachment, MAX_ATTACHMENT_BYTES, MAX_VIDEO_BYTES, normalizeAttachmentLimit } from '../src/services/VideoAttachment';

const info = (duration = 30, width = 1280, height = 720, video: Record<string, unknown> = {}, audio = 'aac') => JSON.stringify({
  format: { duration: String(duration) }, streams: [{ codec_type: 'video', codec_name: 'h264', profile: 'High',
    pix_fmt: 'yuv420p', avg_frame_rate: '24/1', r_frame_rate: '24/1', width, height, duration: String(duration), ...video },
  ...(audio ? [{ codec_type: 'audio', codec_name: audio, duration: String(duration) }] : [])],
});
const needsEncoding = () => info(30, 1280, 720, { codec_name: 'vp9', profile: 'Profile 0' });

function box(type: string, size = 8): Buffer {
  const value = Buffer.alloc(size);
  value.writeUInt32BE(size); value.write(type, 4, 'ascii');
  return value;
}
const prefix = () => Buffer.concat([box('ftyp'), box('moov', 16)]);

test('video conversion uses local-only subprocesses, bounded codecs and cleans temporary files', async () => {
  const calls: { program: string; args: readonly string[]; cwd: string; timeout: number; env: NodeJS.ProcessEnv }[] = [];
  const convert = createVideoAttachment({ execute: async (program, args, options) => {
    calls.push({ program, args, ...options });
    if (program === 'ffmpeg') { await writeFile(args.at(-1)!, 'synthetic MP4 output'); return ''; }
    return calls.length === 1 ? needsEncoding() : info();
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
  assert.equal(encode[encode.indexOf('-b:a') + 1], '128000');
  assert.equal(encode.includes('-r'), false);
  assert.equal(encode.includes('-fpsmax'), false);
  assert.equal(encode[encode.indexOf('-fps_mode') + 1], 'vfr');
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
      if (++probes === 1) return needsEncoding();
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
      return needsEncoding();
    } })(Buffer.from('synthetic input')), null);
    await assert.rejects(stat(directory), { code: 'ENOENT' });
  }
});

test('encoding accepts native landscape, portrait and rotated resolutions but rejects upscaling or outputs above 1080p', async () => {
  for (const [width, height, outputWidth, outputHeight, accepted] of [
    [1920, 1080, 1920, 1080, true], [1080, 1920, 1080, 1920, true],
    [720, 1280, 720, 1280, true], [640, 360, 640, 360, true],
    [1920, 1080, 1080, 1920, true], [3840, 2160, 1920, 1080, true],
    [3840, 2160, 2560, 1440, false], [640, 360, 1280, 720, false],
    [720, 1280, 1080, 1920, false],
  ] as const) {
    let probes = 0;
    const result = await createVideoAttachment({ execute: async (program, args) => {
      if (program === 'ffprobe') return ++probes === 1 ?
        info(30, width, height, { codec_name: 'hevc' }) : info(30, outputWidth, outputHeight);
      assert.equal(args.includes('copy'), false);
      assert.equal(args[args.indexOf('-preset') + 1], width * height > 1280 * 720 ? 'superfast' : 'veryfast');
      await writeFile(args.at(-1)!, 'complete encoded video'); return '';
    } })(Buffer.from('source'));
    assert.equal(Boolean(result), accepted, `${width}x${height} to ${outputWidth}x${outputHeight}`);
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
  release(needsEncoding());
  assert.ok(await pending);
});

test('attachment allowances use a bounded 19 MiB default and reject malformed values', () => {
  assert.equal(normalizeAttachmentLimit(), 19 * 1024 * 1024);
  assert.equal(normalizeAttachmentLimit(50 * 1024 * 1024), 50 * 1024 * 1024);
  assert.equal(normalizeAttachmentLimit(100 * 1024 * 1024), 63 * 1024 * 1024);
  for (const value of [0, -1, 0.5, 1024, NaN, Infinity]) assert.equal(normalizeAttachmentLimit(value), null);
});

test('compatible sources that fit are remuxed without changing their video, audio, resolution or frame rate', async () => {
  for (const audio of ['aac', '']) {
    const calls: readonly string[][] = [];
    const result = await createVideoAttachment({ execute: async (program, args) => {
      if (program === 'ffmpeg') {
        (calls as string[][]).push([...args]); await writeFile(args.at(-1)!, 'unchanged packets'); return '';
      }
      return info(30, 1920, 1080, { avg_frame_rate: '60/1', r_frame_rate: '60/1' }, audio);
    } })(Buffer.from('small compatible MP4'));
    assert.equal(result?.toString(), 'unchanged packets');
    assert.equal(calls.length, 1);
    const args = calls[0];
    assert.equal(args[args.indexOf('-c') + 1], 'copy');
    for (const flag of ['-vf', '-fpsmax', '-r', '-b:v', '-b:a']) assert.equal(args.includes(flag), false, flag);
    assert.equal(args[args.indexOf('-map_metadata') + 1], '-1');
    assert.equal(args[args.indexOf('-map_chapters') + 1], '-1');
    assert.equal(args[args.indexOf('-movflags') + 1], '+faststart');
  }
});

test('remux overflow falls back to encoding the existing source once', async () => {
  const commands: string[] = [];
  let probes = 0;
  const result = await createVideoAttachment({ execute: async (program, args) => {
    if (program === 'ffprobe') return ++probes === 1 ? info() : info();
    commands.push(args.includes('copy') ? 'copy' : 'encode');
    await writeFile(args.at(-1)!, commands.length === 1 ? Buffer.alloc(MAX_ATTACHMENT_BYTES + 1) : 'fits');
    return '';
  } })(Buffer.from('source'));
  assert.equal(result?.toString(), 'fits');
  assert.deepEqual(commands, ['copy', 'encode']);
});

test('codec, pixel format, resolution and allowance decide whether encoding is necessary', async () => {
  for (const source of [info(30, 1280, 720, { codec_name: 'hevc' }), info(30, 1280, 720, { pix_fmt: 'yuv420p10le' }),
    info(30, 1280, 720, { profile: 'High 10' }), info(30, 3840, 2160), info(30, 1280, 720, {}, 'opus')]) {
    let probes = 0;
    assert.ok(await createVideoAttachment({ execute: async (program, args) => {
      if (program === 'ffprobe') return ++probes === 1 ? source : info();
      assert.equal(args.includes('copy'), false);
      await writeFile(args.at(-1)!, 'encoded'); return '';
    } })(Buffer.from('source')));
  }
});

test('invalid codec or frame-rate metadata never reaches an encoder', async () => {
  for (const fields of [{ codec_name: undefined }, { pix_fmt: undefined }, { avg_frame_rate: '0/0', r_frame_rate: '0/0' },
    { avg_frame_rate: '9000/1' }]) {
    assert.equal(await createVideoAttachment({ execute: async program => {
      assert.equal(program, 'ffprobe'); return info(30, 1280, 720, fields);
    } })(Buffer.from('input')), null);
  }
});

test('a complete front moov starts encoding before the rest of the source downloads and spools every byte', async () => {
  let started = false, finished = false, cancelled = 0, probes = 0, directory = '';
  const first = prefix(), tail = box('mdat', 64);
  const stream = async function* () {
    yield first;
    assert.equal(started, true, 'encoding should overlap the rest of the download');
    yield tail; finished = true;
  };
  const result = await createVideoAttachment({ execute: async (_program, args, options) => {
    directory = options.cwd;
    if (++probes === 1) assert.equal(finished, false);
    if (probes === 2) assert.deepEqual(await readFile(args.at(-1)!), Buffer.concat([first, tail]));
    return probes <= 2 ? needsEncoding() : info();
  }, executeStream: async (program, args, options, bytes) => {
    started = true;
    assert.equal(program, 'ffmpeg');
    assert.equal(options.timeout, 150_000);
    assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file,pipe');
    assert.equal(args[args.indexOf('-i') + 1], 'pipe:0');
    assert.equal(args.some(arg => /https?:/.test(arg)), false);
    const received = [];
    for await (const chunk of bytes) received.push(chunk);
    assert.deepEqual(Buffer.concat(received), Buffer.concat([first, tail]));
    await writeFile(args.at(-1)!, 'streamed'); return '';
  } })({ stream: stream(), size: first.length + tail.length, cancel: () => { cancelled++; } });
  assert.equal(result?.toString(), 'streamed');
  assert.equal(finished, true);
  assert.equal(cancelled, 1);
  assert.equal(probes, 3);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('late, incomplete or oversized moov layouts download fully before the file-only fallback', async () => {
  const oversized = box('free'); oversized.writeUInt32BE(2 * 1024 * 1024);
  const partial = box('moov'); partial.writeUInt32BE(100);
  for (const header of [box('mdat', 16), oversized, partial, Buffer.from([0, 0, 0])]) {
    let finished = false, probes = 0;
    const result = await createVideoAttachment({ execute: async (program, args) => {
      assert.equal(finished, true);
      if (program === 'ffprobe') return ++probes === 1 ? needsEncoding() : info();
      assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file');
      await writeFile(args.at(-1)!, 'fallback'); return '';
    }, executeStream: async () => { assert.fail('unverified layout was piped'); } })({ stream: (async function* () {
      yield header; yield Buffer.from('tail'); finished = true;
    })() });
    assert.equal(result?.toString(), 'fallback');
  }
});

test('broken, empty, incorrectly sized and over-limit streams cancel and release the conversion slot', async () => {
  for (const scenario of ['empty', 'throws', 'too-short', 'too-long', 'over-limit']) {
    let cancelled = 0;
    const convert = createVideoAttachment({ execute: async () => { assert.fail('invalid download should not be probed'); } });
    const value = await convert({ size: scenario === 'too-short' ? 50 : scenario === 'too-long' ? 1 : undefined,
      stream: (async function* () {
        if (scenario === 'empty') return;
        if (scenario === 'throws') throw new Error('disconnected');
        yield scenario === 'over-limit' ? Buffer.alloc(MAX_VIDEO_BYTES + 1) : Buffer.from('bad');
      })(), cancel: () => { cancelled++; } });
    assert.equal(value, null, scenario);
    assert.equal(cancelled, 1);
  }
});

test('a streaming process failure cancels a pending producer, closes its spool and unlocks the converter', async () => {
  let cancelled = 0, directory = '', returned = 0;
  const stream: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]() {
    let reads = 0;
    return { next: async () => ++reads === 1 ? { value: prefix(), done: false } : new Promise(() => {}),
      return: async () => { returned++; return { value: undefined, done: true }; } };
  } };
  const result = await createVideoAttachment({ execute: async (_program, _args, options) => {
    directory = options.cwd; return needsEncoding();
  }, executeStream: async (_program, _args, _options, bytes, cancel) => {
    const reader = bytes[Symbol.asyncIterator]();
    await reader.next();
    const pending = reader.next();
    cancel();
    await assert.rejects(pending, /cancelled/);
    throw new Error('process timeout');
  } })({ stream, cancel: () => { cancelled++; } });
  assert.equal(result, null);
  assert.equal(cancelled, 1);
  assert.equal(returned, 1);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('changed complete-source metadata and truncated streamed output are rejected', async () => {
  for (const changedSource of [true, false]) {
    let probes = 0;
    const result = await createVideoAttachment({ execute: async () => {
      probes++;
      return probes === 1 ? needsEncoding() : probes === 2 ? (changedSource ? info(40) : needsEncoding()) : info(20);
    }, executeStream: async (_program, args, _options, bytes) => {
      for await (const _chunk of bytes) { /* Consume the source fully. */ }
      await writeFile(args.at(-1)!, 'invalid output'); return '';
    } })({ stream: (async function* () { yield prefix(); yield box('mdat', 32); })() });
    assert.equal(result, null);
  }
});

test('missing prefix codec details are probed again within 1 MiB, then fall back to the complete file', async () => {
  for (const minimum of [256 * 1024, 1536 * 1024]) {
    const payload = Buffer.concat([prefix(), box('mdat', 1536 * 1024)]);
    const prefixSizes: number[] = [];
    let streamed = false, encoded = false;
    const result = await createVideoAttachment({ execute: async (program, args) => {
      if (program === 'ffprobe') {
        if (args.at(-1)!.endsWith('input.mp4')) {
          const size = (await stat(args.at(-1)!)).size;
          prefixSizes.push(size);
          return size < minimum ? info(30, 1280, 720, { pix_fmt: undefined }) : needsEncoding();
        }
        return info();
      }
      encoded = true;
      await writeFile(args.at(-1)!, 'file encoded'); return '';
    }, executeStream: async (_program, args, _options, bytes) => {
      streamed = true;
      for await (const _chunk of bytes) { /* Complete the download. */ }
      await writeFile(args.at(-1)!, 'pipe encoded'); return '';
    } })({ stream: (async function* () { yield payload; })(), size: payload.length });
    assert.ok(result);
    assert.equal(streamed, minimum <= 1024 * 1024);
    assert.equal(encoded, !streamed);
    assert.equal(prefixSizes.at(-1), payload.length);
    assert.ok(prefixSizes.slice(0, -1).every(size => size <= 1024 * 1024));
    assert.ok(prefixSizes.length <= 6);
  }
});

test('encoding progress errors, including rejected promises, do not interrupt processing', async () => {
  for (const onEncoding of [() => { throw new Error('message removed'); }, async () => { throw new Error('reply failed'); }]) {
    const result = await createVideoAttachment({ execute: async (program, args) => {
      if (program === 'ffprobe') return info();
      await writeFile(args.at(-1)!, 'remuxed'); return '';
    } })(Buffer.from('input'), { onEncoding });
    assert.ok(result);
  }
  await new Promise(resolve => setImmediate(resolve));
});
