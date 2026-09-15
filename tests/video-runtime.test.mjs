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
    assert(original.length > 10 * 1024 * 1024, 'test video must exceed Discord’s default upload limit');
    const prepared = await createVideoAttachment()(original);
    assert(prepared?.length && prepared.length <= MAX_ATTACHMENT_BYTES);
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
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
