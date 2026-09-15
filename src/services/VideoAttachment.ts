import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export const MAX_VIDEO_BYTES = 64 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 9 * 1024 * 1024;
const MAX_DURATION = 300;
let busy = false;

type Run = (program: string, args: readonly string[], options: {
  cwd: string; timeout: number; env: NodeJS.ProcessEnv;
}) => Promise<string>;
const run: Run = (program, args, options) => new Promise((resolve, reject) => {
  execFile(program, [...args], { ...options, maxBuffer: 128 * 1024, killSignal: 'SIGKILL', windowsHide: true },
    (error, stdout) => error ? reject(error) : resolve(stdout));
});

function metadata(text: string): { duration: number; width: number; height: number } | null {
  const value = JSON.parse(text) as { format?: { duration?: string }; streams?: {
    codec_type?: string; width?: number; height?: number; duration?: string;
  }[] };
  const video = value.streams?.find(stream => stream.codec_type === 'video');
  const durations = [value.format?.duration, ...(value.streams ?? []).map(stream => stream.duration)]
    .filter((duration): duration is string => duration !== undefined && duration !== 'N/A').map(Number);
  const duration = Math.max(...durations);
  const width = video?.width ?? 0, height = video?.height ?? 0;
  return durations.length && durations.every(time => Number.isFinite(time) && time > 0) && duration <= MAX_DURATION &&
    Number.isInteger(width) && Number.isInteger(height) && width >= 2 && height >= 2 && width <= 8192 && height <= 8192 &&
    width * height <= 33_554_432 ? { duration, width, height } : null;
}

/** Convert one local MP4 at a time; a busy or unsuccessful conversion leaves the original link intact. */
export function createVideoAttachment({ execute = run }: { execute?: Run } = {}): (input: Buffer) => Promise<Buffer | null> {
  return async input => {
    if (busy || !input.length || input.length > MAX_VIDEO_BYTES) return null;
    busy = true;
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), 'linky-video-'));
      const source = join(directory, 'input.mp4'), output = join(directory, 'preview.mp4');
      await writeFile(source, input, { mode: 0o600 });
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C',
        ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) };
      const probe = async (path: string) => metadata(await execute('ffprobe', [
        '-v', 'error', '-max_alloc', '134217728', '-protocol_whitelist', 'file', '-format_whitelist', 'mov',
        '-enable_drefs', '0', '-use_absolute_path', '0', '-threads', '2',
        '-show_entries', 'format=duration:stream=codec_type,width,height,duration', '-of', 'json', path,
      ], { cwd: directory!, timeout: 15_000, env }));
      const before = await probe(source);
      if (!before) return null;
      // Leave room for audio and container overhead rather than relying on truncation to hit the limit.
      const videoBitrate = Math.min(4_000_000, Math.floor((MAX_ATTACHMENT_BYTES - 768 * 1024) * 8 / before.duration - 64_000));
      if (videoBitrate < 64_000) return null;
      await execute('ffmpeg', [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-max_alloc', '134217728',
        '-protocol_whitelist', 'file', '-format_whitelist', 'mov', '-enable_drefs', '0', '-use_absolute_path', '0',
        '-threads', '2', '-filter_threads', '2', '-filter_complex_threads', '2',
        '-i', source, '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1', '-map_chapters', '-1',
        '-sn', '-dn', '-vf', 'scale=w=min(1280\\,iw):h=min(720\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2',
        '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
        '-b:v', String(videoBitrate), '-maxrate', String(videoBitrate), '-bufsize', String(videoBitrate * 2),
        '-c:a', 'aac', '-b:a', '64000', '-ac', '2', '-threads', '2', '-movflags', '+faststart',
        '-fs', String(MAX_ATTACHMENT_BYTES + 1), '-f', 'mp4', output,
      ], { cwd: directory, timeout: 150_000, env });
      const size = (await stat(output)).size;
      if (!size || size > MAX_ATTACHMENT_BYTES) return null;
      const after = await probe(output);
      // ffmpeg's file-size guard can exit successfully after cutting a video short.
      if (!after || after.width > 1280 || after.height > 720 ||
          after.duration < before.duration - 0.25 || after.duration > before.duration + 1) return null;
      return await readFile(output);
    } catch { return null; }
    finally {
      try {
        if (directory && dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith('linky-video-')) {
          await rm(directory, { recursive: true, force: true });
        }
      }
      finally { busy = false; }
    }
  };
}
