import { execFile, spawn } from 'node:child_process';
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EromeCleanupError } from './EromeWorkScheduler';

export const MAX_VIDEO_BYTES = 64 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 19 * 1024 * 1024;
export const MAX_ORIGINAL_VIDEO_BYTES = 24 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 63 * 1024 * 1024, MAX_HEADER_BYTES = 1024 * 1024;
const MAX_DURATION = 300, ENCODE_TIMEOUT_MS = 150_000;
const MAX_COPY_FPS = 60, ORIGINAL_PROBE_TIMEOUT_MS = 2_000;
let busy = false;

export type VideoInput = Buffer | {
  stream: AsyncIterable<Uint8Array>;
  size?: number;
  cancel?: () => void | Promise<void>;
};
export type VideoOptions = { maxBytes?: number; onEncoding?: () => void; signal?: AbortSignal };
type ProcessOptions = { cwd: string; timeout: number; env: NodeJS.ProcessEnv; signal?: AbortSignal };
type Run = (program: string, args: readonly string[], options: ProcessOptions) => Promise<string>;
type StreamRun = (program: string, args: readonly string[], options: ProcessOptions,
  input: AsyncIterable<Uint8Array>, cancel: () => void) => Promise<string>;

/** Invalid allowances fail closed; a server's larger allowance never removes our own resource bound. */
export function normalizeAttachmentLimit(value = MAX_ATTACHMENT_BYTES): number | null {
  return Number.isSafeInteger(value) && value >= 1024 * 1024 ? Math.min(value, MAX_OUTPUT_BYTES) : null;
}
const run: Run = (program, args, options) => new Promise((resolve, reject) => {
  let closed = false, result: { error: Error | null; stdout: string } | undefined;
  const finish = () => { if (closed && result) { if (result.error) reject(result.error); else resolve(result.stdout); } };
  const child = execFile(program, [...args], { ...options, maxBuffer: 128 * 1024, killSignal: 'SIGKILL', windowsHide: true },
    (error, stdout) => { result = { error, stdout }; finish(); });
  // execFile's AbortError callback can precede process exit. Scratch cannot be reused until close.
  child.once('close', () => { closed = true; finish(); });
});

const runStream: StreamRun = async (program, args, options, input, cancel) => {
  const child = spawn(program, [...args], { cwd: options.cwd, env: options.env, windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'] });
  const source = Readable.from(input);
  let stdout = '', outputBytes = 0, failure: Error | undefined;
  const stop = (error: Error) => {
    failure ??= error;
    cancel(); source.destroy(error); child.kill('SIGKILL');
  };
  const completed = new Promise<string>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 && !failure ? resolve(stdout) : reject(failure ?? new Error('Video process failed')));
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 128 * 1024) stop(new Error('Video process output exceeded its limit'));
      else stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 128 * 1024) stop(new Error('Video process output exceeded its limit'));
    });
  });
  const pumped = pipeline(source, child.stdin).catch(error => { stop(error); throw error; });
  const timer = setTimeout(() => stop(new Error('Video process timed out')), options.timeout);
  const abort = () => stop(new Error('Video process cancelled'));
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    const [, output] = await Promise.all([pumped, completed]);
    return output;
  } catch (error) {
    stop(error instanceof Error ? error : new Error('Video process failed'));
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    await Promise.allSettled([pumped, completed]);
  }
};

type Metadata = {
  duration: number; width: number; height: number; fps: number; cadence: number; codec: string; profile: string; pixelFormat: string;
  audioCodec?: string; frames?: number;
};

function frameRate(value: unknown): number {
  if (typeof value !== 'string' || !/^\d+(?:\/\d+)?$/.test(value)) return NaN;
  const [numerator, denominator = 1] = value.split('/').map(Number);
  return numerator / denominator;
}

function metadata(text: string, strictStreams = false): Metadata | null {
  const value = JSON.parse(text) as { format?: { duration?: string }; streams?: {
    codec_type?: string; codec_name?: string; profile?: string; pix_fmt?: string; width?: number; height?: number;
    duration?: string; avg_frame_rate?: string; r_frame_rate?: string; nb_frames?: string;
    disposition?: { attached_pic?: number };
  }[] } | null;
  if (!value || !Array.isArray(value.streams)) return null;
  if (strictStreams && (value.streams.filter(stream => stream.codec_type === 'video').length !== 1 ||
    value.streams.filter(stream => stream.codec_type === 'audio').length > 1 ||
    value.streams.some(stream => !['video', 'audio'].includes(stream.codec_type ?? '') ||
      stream.disposition?.attached_pic !== 0 || stream.codec_name === ''))) return null;
  const video = value.streams.find(stream => stream.codec_type === 'video');
  const audio = value.streams.find(stream => stream.codec_type === 'audio');
  const durations = [value.format?.duration, ...value.streams.map(stream => stream.duration)]
    .filter((duration): duration is string => duration !== undefined && duration !== 'N/A').map(Number);
  const duration = Math.max(...durations);
  const width = video?.width ?? 0, height = video?.height ?? 0;
  const average = frameRate(video?.avg_frame_rate), nominal = frameRate(video?.r_frame_rate);
  const fps = Number.isFinite(average) && average > 0 ? average : nominal;
  const frames = Number(video?.nb_frames);
  return durations.length && durations.every(time => Number.isFinite(time) && time > 0) && duration <= MAX_DURATION &&
    Number.isInteger(width) && Number.isInteger(height) && width >= 2 && height >= 2 && width <= 8192 && height <= 8192 &&
    width * height <= 33_554_432 && Number.isFinite(fps) && fps > 0 && fps <= 240 &&
    typeof video?.codec_name === 'string' && typeof video.pix_fmt === 'string' &&
    (!audio || typeof audio.codec_name === 'string') ? {
      duration, width, height, fps, cadence: Number.isFinite(nominal) && nominal > 0 ? nominal : fps,
      codec: video.codec_name, profile: video.profile ?? '', pixelFormat: video.pix_fmt,
      ...(audio ? { audioCodec: audio.codec_name } : {}),
      ...(Number.isSafeInteger(frames) && frames > 0 ? { frames } : {}),
    } : null;
}

function copyable(value: Metadata): boolean {
  return value.codec === 'h264' && value.pixelFormat === 'yuv420p' &&
    /^(?:Constrained Baseline|Baseline|Main|High)$/.test(value.profile) &&
    (!value.audioCodec || value.audioCodec === 'aac') && value.fps <= MAX_COPY_FPS &&
    Math.max(value.width, value.height) <= 1920 && Math.min(value.width, value.height) <= 1080;
}

function processEnvironment(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C',
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) };
}

function probeArguments(path: string, strictStreams = false): string[] {
  return [
    '-v', 'error', '-max_alloc', '134217728', '-protocol_whitelist', 'file', '-format_whitelist', 'mov',
    '-enable_drefs', '0', '-use_absolute_path', '0', '-threads', '2',
    '-show_entries', 'format=duration:stream=codec_type,codec_name,profile,pix_fmt,width,height,duration,avg_frame_rate,r_frame_rate,nb_frames' +
      (strictStreams ? ':stream_disposition=attached_pic' : ''),
    '-of', 'json', path,
  ];
}

export type OriginalVideoMetadata = { width: number; height: number; duration: number; fps: number };
export type OriginalImageMetadata = { width: number; height: number };

function staticPng(input: Buffer): boolean {
  if (!input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  let offset = 8, hasData = false;
  while (offset + 12 <= input.length) {
    const length = input.readUInt32BE(offset), type = input.toString('latin1', offset + 4, offset + 8);
    if (length > input.length - offset - 12 || !/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type) || type === 'acTL' ||
        (offset === 8 ? type !== 'IHDR' || length !== 13 : type === 'IHDR')) return false;
    offset += length + 12;
    if (type === 'IEND') return length === 0 && hasData && offset === input.length;
    if (type === 'IDAT') hasData = true;
  }
  return false;
}

/** Decode one bounded JPEG/PNG to validate it, while retaining the exact original bytes for delivery. */
export function createOriginalImageInspector({ execute = run }: { execute?: Run } = {}) {
  return async (input: Buffer, mimeType: 'image/jpeg' | 'image/png', { signal }: { signal?: AbortSignal } = {}): Promise<OriginalImageMetadata | null> => {
    if (!Buffer.isBuffer(input) || input.length < 12 || input.length > 8 * 1024 * 1024 || signal?.aborted) return null;
    const png = mimeType === 'image/png';
    if (png ? !staticPng(input)
      : input[0] !== 255 || input[1] !== 216 || input[input.length - 2] !== 255 || input[input.length - 1] !== 217) return null;
    const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000);
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), 'linky-original-image-'));
      const path = join(directory, png ? 'input.png' : 'input.jpg');
      await writeFile(path, input, { flag: 'wx', mode: 0o600, signal: deadline });
      const limits = ['-v', 'error', '-max_alloc', '134217728', '-protocol_whitelist', 'file,pipe',
        '-format_whitelist', 'image2,jpeg_pipe,png_pipe', '-threads', '1'];
      const options = { cwd: directory, timeout: 5_000, env: processEnvironment(), signal: deadline };
      const probe = JSON.parse(await execute('ffprobe', [...limits, '-show_entries',
        'stream=codec_type,codec_name,width,height', '-of', 'json', path], options)) as { streams?: {
          codec_type?: string; codec_name?: string; width?: number; height?: number;
        }[] };
      const image = probe.streams?.[0], width = image?.width ?? 0, height = image?.height ?? 0;
      if (probe.streams?.length !== 1 || image?.codec_type !== 'video' || image.codec_name !== (png ? 'png' : 'mjpeg') ||
          !Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width > 8192 || height > 8192 ||
          width * height > 33_554_432) return null;
      await execute('ffmpeg', ['-nostdin', ...limits, '-xerror', '-i', path, '-map', '0:v:0', '-frames:v', '1', '-f', 'null', '-'], options);
      deadline.throwIfAborted();
      return { width, height };
    } catch { return null; }
    finally {
      if (directory && dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith('linky-original-image-')) {
        await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }).catch(() => { throw new EromeCleanupError(); });
      }
    }
  };
}

/** Inspect complete source bytes without changing them; the caller establishes download integrity. */
export function createOriginalVideoInspector({ execute = run }: { execute?: Run } = {}):
  (input: Buffer, options?: { signal?: AbortSignal }) => Promise<OriginalVideoMetadata | null> {
  return async (input, { signal } = {}) => {
    if (!Buffer.isBuffer(input) || !input.length || input.length > MAX_ORIGINAL_VIDEO_BYTES || signal?.aborted) return null;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    let directory: string | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), 'linky-original-video-'));
      const source = join(directory, 'input.mp4');
      await writeFile(source, input, { mode: 0o600, flag: 'wx', signal: controller.signal });
      controller.signal.throwIfAborted();
      timer = setTimeout(cancel, ORIGINAL_PROBE_TIMEOUT_MS);
      controller.signal.throwIfAborted();
      const output = await execute('ffprobe', probeArguments(source, true), {
        cwd: directory, timeout: ORIGINAL_PROBE_TIMEOUT_MS, env: processEnvironment(), signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      if (Buffer.byteLength(output) > 128 * 1024) return null;
      const inspected = metadata(output, true);
      if (!inspected || !copyable(inspected) || inspected.cadence > MAX_COPY_FPS) return null;
      const { width, height, duration, fps } = inspected;
      return { width, height, duration, fps };
    } catch { return null; }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      controller.abort();
      if (directory && dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith('linky-original-video-')) {
        await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }).catch(() => { throw new EromeCleanupError(); });
      }
    }
  };
}

/** Only an entire moov box before any mdat makes a bounded prefix eligible for pipe input. */
function streamableHeader(bytes: Buffer): 'ready' | 'more' | 'fallback' {
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    let size = bytes.readUInt32BE(offset), header = 8;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (size === 1) {
      if (offset + 16 > bytes.length) return 'more';
      const large = bytes.readBigUInt64BE(offset + 8);
      if (large > BigInt(MAX_VIDEO_BYTES)) return 'fallback';
      size = Number(large); header = 16;
    }
    if (type === 'mdat' || size < header || offset + size > MAX_HEADER_BYTES) return 'fallback';
    if (offset + size > bytes.length) return 'more';
    if (type === 'moov') return 'ready';
    offset += size;
  }
  return bytes.length >= MAX_HEADER_BYTES ? 'fallback' : 'more';
}

function argumentsFor(source: string, output: string, before: Metadata, maxBytes: number, copy: boolean): string[] {
  const shared = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-y', '-max_alloc', '134217728',
    '-protocol_whitelist', source === 'pipe:0' ? 'file,pipe' : 'file', '-format_whitelist', 'mov',
    '-enable_drefs', '0', '-use_absolute_path', '0', '-threads', '2', '-filter_threads', '2', '-filter_complex_threads', '2',
    '-i', source, '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1', '-map_chapters', '-1', '-sn', '-dn'];
  if (copy) shared.push('-c', 'copy');
  else {
    const availableBitrate = Math.floor((maxBytes - 768 * 1024) * 8 / before.duration);
    const audioBitrate = before.audioCodec ? (availableBitrate >= 256_000 ? 128_000 : 64_000) : 0;
    const videoBitrate = Math.min(4_000_000, availableBitrate - audioBitrate);
    if (videoBitrate < 64_000) throw new Error('Video cannot fit its attachment allowance');
    const scale = "scale=w='min(iw,if(gte(iw,ih),1920,1080))':h='min(ih,if(gte(iw,ih),1080,1920))':" +
      'force_original_aspect_ratio=decrease:force_divisible_by=2';
    const cap = Math.max(before.fps, before.cadence) > 30 ?
      ",select='isnan(prev_selected_t)+gt(floor(t*30+0.000001),floor(prev_selected_t*30+0.000001))'" : '';
    const preset = before.width * before.height > 1280 * 720 ? 'superfast' : 'veryfast';
    shared.push('-vf', scale + cap, '-fps_mode', 'vfr', '-c:v', 'libx264', '-preset', preset, '-pix_fmt', 'yuv420p',
      '-b:v', String(videoBitrate), '-maxrate', String(videoBitrate), '-bufsize', String(videoBitrate * 2),
      '-c:a', 'aac', '-b:a', String(audioBitrate || 128_000), '-ac', '2', '-threads', '2');
  }
  return [...shared, '-movflags', '+faststart', '-fs', String(maxBytes + 1), '-f', 'mp4', output];
}

function sameSource(before: Metadata, after: Metadata): boolean {
  return before.width === after.width && before.height === after.height && before.codec === after.codec &&
    before.audioCodec === after.audioCodec && before.profile === after.profile && before.pixelFormat === after.pixelFormat &&
    before.frames === after.frames &&
    Math.abs(before.duration - after.duration) < 0.01 && Math.abs(before.fps - after.fps) < 0.01 &&
    Math.abs(before.cadence - after.cadence) < 0.01;
}

function validOutput(before: Metadata, after: Metadata | null, copy: boolean): boolean {
  if (!after) return false;
  const noAddedFrames = before.frames !== undefined && after.frames !== undefined ? after.frames <= before.frames :
    after.fps * after.duration <= before.fps * before.duration + 1;
  // Compare edges so a source's display rotation can swap width and height without permitting upscaling.
  const noUpscaling = Math.max(after.width, after.height) <= Math.max(before.width, before.height) &&
    Math.min(after.width, after.height) <= Math.min(before.width, before.height);
  return Boolean(after && copyable(after) && after.duration >= before.duration - 0.25 && after.duration <= before.duration + 1 &&
    (Boolean(before.audioCodec) === Boolean(after.audioCodec)) &&
    noAddedFrames && (copy ? sameSource({ ...before, duration: after.duration, fps: after.fps }, after) :
      noUpscaling && after.fps <= 30 + 1 / after.duration));
}

/** Prepare one bounded video at a time. Network reads stay in the caller; FFmpeg can read only files and its input pipe. */
export function createVideoAttachment({ execute = run, executeStream = runStream }: {
  execute?: Run; executeStream?: StreamRun;
} = {}): (input: VideoInput, options?: VideoOptions) => Promise<Buffer | null> {
  return async (input, options = {}) => {
    const maxBytes = normalizeAttachmentLimit(options.maxBytes);
    const suppliedSize = Buffer.isBuffer(input) ? input.length : input.size;
    const invalid = options.signal?.aborted || maxBytes === null || (suppliedSize !== undefined &&
      (!Number.isSafeInteger(suppliedSize) || suppliedSize <= 0 || suppliedSize > MAX_VIDEO_BYTES));
    let iterator: AsyncIterator<Uint8Array> | undefined;
    const aborted = new AbortController();
    let cancelled = false;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true; aborted.abort();
      if (!Buffer.isBuffer(input)) {
        try { void Promise.resolve(input.cancel?.()).catch(() => {}); } catch { /* Cleanup must not replace the original failure. */ }
        try { void Promise.resolve(iterator?.return?.()).catch(() => {}); } catch { /* A failed producer is already being abandoned. */ }
      }
    };
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (busy || invalid) { cancel(); options.signal?.removeEventListener('abort', cancel); return null; }
    busy = true;
    let directory: string | undefined, file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), 'linky-video-'));
      const source = join(directory, 'input.mp4'), output = join(directory, 'preview.mp4');
      const env = processEnvironment();
      const probe = async (path: string) => metadata(await execute('ffprobe', probeArguments(path),
        { cwd: directory!, timeout: 15_000, env, signal: aborted.signal }));
      let total = 0, complete = Buffer.isBuffer(input), streaming = false;
      let pendingChunk: Uint8Array | undefined;
      const initial: Uint8Array[] = [];
      const read = async (): Promise<Uint8Array | null> => {
        if (aborted.signal.aborted) throw new Error('Video input cancelled');
        const next = pendingChunk ? { value: pendingChunk, done: false } : await new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
          const abort = () => reject(new Error('Video input cancelled'));
          aborted.signal.addEventListener('abort', abort, { once: true });
          Promise.resolve().then(() => iterator!.next()).then(resolve, reject)
            .finally(() => aborted.signal.removeEventListener('abort', abort));
        });
        if (next.done) {
          if (!total || suppliedSize !== undefined && total !== suppliedSize) throw new Error('Video input is incomplete');
          complete = true; return null;
        }
        if (!(next.value instanceof Uint8Array) || total + next.value.length > MAX_VIDEO_BYTES ||
          suppliedSize !== undefined && total + next.value.length > suppliedSize) throw new Error('Video input exceeds its limit');
        if (!next.value.length) throw new Error('Video input contained an empty chunk');
        const chunk = next.value.subarray(0, 64 * 1024);
        pendingChunk = chunk.length < next.value.length ? next.value.subarray(chunk.length) : undefined;
        total += chunk.length;
        await file!.writeFile(chunk);
        return chunk;
      };
      if (Buffer.isBuffer(input)) {
        total = input.length;
        await writeFile(source, input, { mode: 0o600 });
      } else {
        iterator = input.stream[Symbol.asyncIterator]();
        file = await open(source, 'w', 0o600);
        let header = Buffer.alloc(0), state: ReturnType<typeof streamableHeader> = 'more';
        while (!complete && state === 'more') {
          const chunk = await read();
          if (!chunk) break;
          initial.push(chunk);
          header = Buffer.concat([header, chunk.subarray(0, MAX_HEADER_BYTES - header.length)]);
          state = streamableHeader(header);
        }
        streaming = state === 'ready' && !complete;
        if (!streaming) {
          initial.length = 0;
          while (!complete) await read();
          await file.close(); file = undefined;
        }
      }
      let inspected = await probe(source).catch(() => null);
      // Some MP4s expose pixel format/profile only after the first complete video packet, even with a complete moov.
      while (streaming && !inspected && !complete && total < MAX_HEADER_BYTES) {
        const target = Math.min(MAX_HEADER_BYTES, Math.max(total * 2, total + 64 * 1024));
        while (!complete && total < target) {
          const chunk = await read(); if (chunk) initial.push(chunk);
        }
        inspected = await probe(source).catch(() => null);
      }
      if (streaming && !inspected) {
        initial.length = 0;
        while (!complete) await read();
        await file!.close(); file = undefined; streaming = false;
        inspected = await probe(source);
      }
      const before = inspected;
      if (!before) return null;
      let copy = copyable(before) && suppliedSize !== undefined && suppliedSize <= maxBytes;
      const processOptions = { cwd: directory, timeout: ENCODE_TIMEOUT_MS, env, signal: aborted.signal };
      try { void Promise.resolve(options.onEncoding?.()).catch(() => {}); } catch { /* Status callbacks cannot interrupt preparation. */ }
      if (streaming) {
        async function* chunks() {
          for (const chunk of initial) yield chunk;
          initial.length = 0;
          while (!complete) { const chunk = await read(); if (chunk) yield chunk; }
        }
        await executeStream('ffmpeg', argumentsFor('pipe:0', output, before, maxBytes, copy), processOptions, chunks(), cancel);
        if (!complete) throw new Error('Video process did not consume its complete input');
        await file!.close(); file = undefined;
        const downloaded = await probe(source);
        if (!downloaded || !sameSource(before, downloaded)) return null;
      } else await execute('ffmpeg', argumentsFor(source, output, before, maxBytes, copy), processOptions);
      const accepted = async () => {
        const size = (await stat(output)).size;
        return size > 0 && size <= maxBytes && validOutput(before, await probe(output), copy);
      };
      if (!await accepted()) {
        if (!copy) return null;
        // Remux overhead can push a fitting source over the allowance; the complete spool allows one encode fallback.
        copy = false;
        await execute('ffmpeg', argumentsFor(source, output, before, maxBytes, false), processOptions);
        if (!await accepted()) return null;
      }
      return await readFile(output);
    } catch { return null; }
    finally {
      cancel();
      options.signal?.removeEventListener('abort', cancel);
      try {
        await file?.close();
        if (directory && dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith('linky-video-')) {
          await rm(directory, { recursive: true, force: true }).catch(() => { throw new EromeCleanupError(); });
        }
      }
      finally { busy = false; }
    }
  };
}
