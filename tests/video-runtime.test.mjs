import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('production FFmpeg prepares a complete, playable MP4 from a generated test pattern', {
  skip: process.env.LINKY_VIDEO_RUNTIME_TEST !== 'true', timeout: 180_000,
}, async () => {
  const require = createRequire(join(process.cwd(), 'package.json'));
  const { createVideoAttachment, MAX_ATTACHMENT_BYTES } = require('./dist/services/VideoAttachment.js');
  const directory = mkdtempSync(join(tmpdir(), 'linky-runtime-test-'));
  try {
    const input = join(directory, 'input.mp4');
    execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '20', '-c:v', 'libx264',
      '-preset', 'ultrafast', '-threads', '2', '-c:a', 'aac', '-pix_fmt', 'yuv420p', input],
    { timeout: 60_000, windowsHide: true, stdio: 'pipe' });
    const original = readFileSync(input);
    const testLimit = 9 * 1024 * 1024;
    assert(original.length > testLimit, 'test video must exceed this test’s attachment allowance');
    const prepared = await createVideoAttachment()(original, { maxBytes: testLimit });
    assert(prepared?.length && prepared.length <= testLimit && prepared.length <= MAX_ATTACHMENT_BYTES);
    const output = join(directory, 'output.mp4');
    writeFileSync(output, prepared);
    const metadata = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
      'format=duration:stream=codec_type,codec_name,width,height', '-of', 'json', output],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true }));
    const video = metadata.streams.find(stream => stream.codec_type === 'video');
    assert.equal(video.codec_name, 'h264');
    assert.equal(video.width, 1280);
    assert.equal(video.height, 720);
    assert.equal(metadata.streams.find(stream => stream.codec_type === 'audio').codec_name, 'aac');
    assert(Number(metadata.format.duration) >= 19.9 && Number(metadata.format.duration) <= 20.1);

    const frontMetadata = join(directory, 'faststart.mp4');
    execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-i', input, '-c', 'copy', '-movflags', '+faststart', frontMetadata],
      { timeout: 15_000, windowsHide: true, stdio: 'pipe' });
    const streamInput = readFileSync(frontMetadata);
    let encoding = false, ended = false, cancelled = 0;
    const streamed = await createVideoAttachment()({ size: streamInput.length, cancel: () => { cancelled++; },
      stream: (async function* () {
        for (let offset = 0; offset < streamInput.length; offset += 256 * 1024) {
          if (offset) assert.equal(encoding, true, 'FFmpeg should start before the entire source is read');
          yield streamInput.subarray(offset, offset + 256 * 1024);
        }
        ended = true;
      })(),
    }, { maxBytes: testLimit, onEncoding: () => { assert.equal(ended, false); encoding = true; } });
    assert(streamed?.length && streamed.length <= testLimit);
    assert.equal(cancelled, 1);
    writeFileSync(output, streamed);
    const streamedMetadata = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
      'format=duration:stream=codec_type,codec_name,width,height', '-of', 'json', output],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true }));
    assert.deepEqual(streamedMetadata, metadata, 'streaming must preserve the complete output and codecs');
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-i', output, '-f', 'null', '-'],
      { timeout: 30_000, windowsHide: true, stdio: 'pipe' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('production FFmpeg remuxes a fitting 24 fps source without quality loss and rejects a truncated stream', {
  skip: process.env.LINKY_VIDEO_RUNTIME_TEST !== 'true', timeout: 60_000,
}, async t => {
  const require = createRequire(join(process.cwd(), 'package.json'));
  const { createVideoAttachment } = require('./dist/services/VideoAttachment.js');
  const directory = mkdtempSync(join(tmpdir(), 'linky-runtime-test-'));
  try {
    const source = join(directory, 'source.mp4'), output = join(directory, 'output.mp4');
    execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '2', '-c:v', 'libx264',
      '-preset', 'ultrafast', '-threads', '2', '-c:a', 'aac', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', source],
    { timeout: 30_000, windowsHide: true, stdio: 'pipe' });
    const bytes = readFileSync(source);
    const streamed = () => (async function* () {
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) yield bytes.subarray(offset, offset + 64 * 1024);
    })();
    const remuxed = await createVideoAttachment()({ stream: streamed(), size: bytes.length });
    assert(remuxed?.length);
    writeFileSync(output, remuxed);
    const packets = path => execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', path,
      '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-f', 'streamhash', '-hash', 'sha256', '-'],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true }).trim();
    assert.equal(packets(output), packets(source), 'video and audio compressed packets must be unchanged');
    const metadata = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'stream=width,height,avg_frame_rate', '-of', 'json', output], { encoding: 'utf8', windowsHide: true }));
    assert.equal(metadata.streams[0].width, 1920);
    assert.equal(metadata.streams[0].height, 1080);
    assert.equal(metadata.streams[0].avg_frame_rate, '24/1');

    let cancelled = 0;
    const broken = await createVideoAttachment()({ stream: (async function* () {
      yield bytes.subarray(0, 64 * 1024);
      yield bytes.subarray(64 * 1024, Math.floor(bytes.length / 2));
    })(), size: bytes.length, cancel: () => { cancelled++; } });
    assert.equal(broken, null);
    assert.equal(cancelled, 1);

    let began;
    const started = new Promise(resolve => { began = resolve; });
    let release;
    const stalled = new Promise(resolve => { release = resolve; });
    let timeoutCancellation = 0;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const pending = createVideoAttachment()({ size: bytes.length, stream: (async function* () {
        yield bytes.subarray(0, Math.floor(bytes.length / 2));
        await stalled;
        yield bytes.subarray(Math.floor(bytes.length / 2));
      })(), cancel: () => { timeoutCancellation++; release(); } }, { onEncoding: () => { began(); } });
      await started;
      t.mock.timers.tick(150_001);
      assert.equal(await pending, null, 'the actual child process must stop at its deadline, even when download stalls');
      assert.equal(timeoutCancellation, 1);
    } finally { t.mock.timers.reset(); release(); }
    assert.ok(await createVideoAttachment()(bytes), 'timeout cleanup must release the global converter slot');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('production FFmpeg preserves variable frame timing while encoding a compatible bounded MP4', {
  skip: process.env.LINKY_VIDEO_RUNTIME_TEST !== 'true', timeout: 60_000,
}, async () => {
  const require = createRequire(join(process.cwd(), 'package.json'));
  const { createVideoAttachment } = require('./dist/services/VideoAttachment.js');
  const directory = mkdtempSync(join(tmpdir(), 'linky-runtime-test-'));
  try {
    const source = join(directory, 'variable.mp4'), output = join(directory, 'output.mp4');
    execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
      '-t', '2', '-vf', 'select=if(lt(t\\,1)\\,1\\,not(mod(n\\,2)))', '-fps_mode', 'vfr',
      '-c:v', 'mpeg4', '-q:v', '2', '-threads', '2', '-movflags', '+faststart', source],
    { timeout: 15_000, windowsHide: true, stdio: 'pipe' });
    const prepared = await createVideoAttachment()(readFileSync(source));
    assert(prepared?.length, 'variable-rate inputs below the cap must not be rejected or inflated to 30 fps');
    writeFileSync(output, prepared);
    const probe = path => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=avg_frame_rate,nb_frames,duration', '-of', 'json', path],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true })).streams[0];
    const before = probe(source), after = probe(output);
    assert.equal(after.nb_frames, before.nb_frames);
    const frames = path => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'frame=best_effort_timestamp_time,pkt_duration_time,duration_time', '-of', 'json', path],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true })).frames;
    const sourceFrames = frames(source), outputFrames = frames(output);
    const timestamps = values => values.map(frame => Number(frame.best_effort_timestamp_time));
    assert.deepEqual(timestamps(outputFrames), timestamps(sourceFrames), 'encoding must retain every source frame timestamp below the cap');
    // Older FFmpeg versions report a shorter stream duration for reordered VFR packets, despite identical presentation times.
    const presentationEnd = values => Number(values.at(-1).best_effort_timestamp_time) +
      Number(values.at(-1).duration_time ?? values.at(-1).pkt_duration_time);
    assert(Math.abs(presentationEnd(outputFrames) - presentationEnd(sourceFrames)) < 0.000001,
      'the final decoded frame must retain its presentation end time');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('production FFmpeg caps 40, 50 and 60 fps sources near 30 without dropping half their frames unnecessarily', {
  skip: process.env.LINKY_VIDEO_RUNTIME_TEST !== 'true', timeout: 60_000,
}, async () => {
  const require = createRequire(join(process.cwd(), 'package.json'));
  const { createVideoAttachment } = require('./dist/services/VideoAttachment.js');
  const directory = mkdtempSync(join(tmpdir(), 'linky-runtime-test-'));
  try {
    for (const rate of [40, 50, 60]) {
      const source = join(directory, `source-${rate}.mp4`), output = join(directory, `output-${rate}.mp4`);
      execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=${rate}`,
        '-t', '2', '-c:v', 'mpeg4', '-q:v', '2', '-threads', '2', '-movflags', '+faststart', source],
      { timeout: 15_000, windowsHide: true, stdio: 'pipe' });
      const result = await createVideoAttachment()(readFileSync(source));
      assert(result?.length, `${rate} fps source must produce a complete video`);
      writeFileSync(output, result);
      const stream = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
        'stream=nb_frames,duration', '-of', 'json', output], { encoding: 'utf8', timeout: 15_000, windowsHide: true })).streams[0];
      assert(Number(stream.nb_frames) >= 59 && Number(stream.nb_frames) <= 61, 'retain approximately 30 frames per second');
      assert(Number(stream.duration) >= 1.9 && Number(stream.duration) <= 2.1);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
