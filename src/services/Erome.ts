import { AttachmentBuilder } from 'discord.js';
import { createVideoAttachment, normalizeAttachmentLimit, MAX_VIDEO_BYTES, type VideoInput, type VideoOptions } from './VideoAttachment';
import type { EromePreparer, EromeProgress, EromeStage } from './EromeDelivery';

const MAX_HTML_BYTES = 1024 * 1024;
const MAX_WAITING = 2, WAIT_TIMEOUT_MS = 300_000;
const MAX_CONSUMERS = 8;
const CACHE_TTL_MS = 300_000, MAX_CACHE_ENTRIES = 2, MAX_CACHE_BYTES = 128 * 1024 * 1024;
type Prepared = { bytes: Buffer; videoCount: number };
type Job = { result: Promise<Prepared | null>; stage: EromeStage; consumers: number; observers: Set<EromeProgress> };
const jobs = new Map<string, Job>();
const cache = new Map<string, Prepared & { expiresAt: number; timer: ReturnType<typeof setTimeout> }>();
let busy = false;
const waiting: { resolve(accepted: boolean): void; expiresAt: number; timer: ReturnType<typeof setTimeout> }[] = [];

function enter(): Promise<boolean> {
  if (!busy) { busy = true; return Promise.resolve(true); }
  if (waiting.length >= MAX_WAITING) return Promise.resolve(false);
  return new Promise(resolve => {
    const entry = { resolve, expiresAt: Date.now() + WAIT_TIMEOUT_MS, timer: setTimeout(() => {
      const index = waiting.indexOf(entry);
      if (index >= 0) { waiting.splice(index, 1); resolve(false); }
    }, WAIT_TIMEOUT_MS) };
    waiting.push(entry);
  });
}

function leave(): void {
  while (waiting.length) {
    const next = waiting.shift()!;
    clearTimeout(next.timer);
    const accepted = next.expiresAt > Date.now();
    next.resolve(accepted);
    if (accepted) return;
  }
  busy = false;
}

function notify(observer: EromeProgress | undefined, stage: EromeStage): void {
  try { void Promise.resolve(observer?.(stage)).catch(() => {}); } catch { /* Progress must not interrupt preparation. */ }
}

function attachment(value: Prepared) {
  return { file: new AttachmentBuilder(Buffer.from(value.bytes), { name: 'linky-video.mp4',
    description: value.videoCount > 1 ? `First video of ${value.videoCount} in the linked album.` : 'Video from the linked album.' }),
  videoCount: value.videoCount };
}

function evict(url: string): void {
  clearTimeout(cache.get(url)?.timer);
  cache.delete(url);
}

function remember(url: string, value: Prepared): void {
  while (cache.size >= MAX_CACHE_ENTRIES || [...cache.values()].reduce((sum, item) => sum + item.bytes.length, value.bytes.length) > MAX_CACHE_BYTES) {
    evict(cache.keys().next().value!);
  }
  const timer = setTimeout(() => { cache.delete(url); }, CACHE_TTL_MS);
  timer.unref?.();
  cache.set(url, { ...value, expiresAt: Date.now() + CACHE_TTL_MS, timer });
}

/** Only complete public album URLs are accepted; profiles, redirects and nested URLs are not followed. */
export function parseEromeUrl(raw: string): { id: string; url: string } | null {
  if (raw.length > 2048 || /[\\\s\u0000-\u001f\u007f]/.test(raw)) return null;
  const parts = /^https:\/\/([^/?#]+)(\/[^?#]*)(?:\?[^#]*)?(?:#.*)?$/i.exec(raw);
  const id = parts && /^(?:www\.)?erome\.com$/i.test(parts[1]) && /^\/a\/([A-Za-z0-9_]{1,64})\/?$/.exec(parts[2])?.[1];
  return id ? { id, url: `https://www.erome.com/a/${id}` } : null;
}

function videoSources(html: string): string[] {
  const sources = new Set<string>();
  // Only source elements carry the video payload; never inspect page text, titles or unrelated links.
  const markup = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  for (const video of markup.matchAll(/<video\b[^>]{0,4096}>([\s\S]*?)<\/video\s*>/gi)) {
    for (const tag of video[1].matchAll(/<source\b[^>]{0,4096}>/gi)) {
      const source = /\ssrc\s*=\s*(["'])([^"']{1,2048})\1/i.exec(tag[0])?.[2];
      if (!source || !/^https:\/\/v\d{1,4}\.erome\.com\/(?:[A-Za-z0-9_-]{1,128}\/){0,5}[A-Za-z0-9_-]{1,128}\.mp4$/i.test(source)) continue;
      sources.add(source);
      break; // Alternate sources within a video element are qualities of the same video.
    }
  }
  return [...sources];
}

async function boundedBody(response: Response, limit: number): Promise<Buffer | null> {
  const length = response.headers.get('content-length');
  if (!response.ok || (length !== null && (!/^\d+$/.test(length) || Number(length) > limit))) {
    await response.body?.cancel(); return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    return total ? Buffer.concat(chunks, total) : null;
  } finally { reader.releaseLock(); }
}

/** Prepare the first distinct video, without cookies, redirects, persistent media or an unbounded work queue. */
export function createEromePreparer({ fetch: request = fetch, convert = createVideoAttachment() }: {
  fetch?: typeof fetch; convert?: (input: VideoInput, options?: VideoOptions) => Promise<Buffer | null>;
} = {}): EromePreparer {
  const prepare = async (url: string, maxBytes: number, progress: (stage: EromeStage) => void): Promise<Prepared | null> => {
    if (!await enter()) return null;
    try {
      progress('downloading');
      const response = await request(url, { redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { Accept: 'text/html', 'User-Agent': 'Linky/1.0 (+https://linkybot.dev)' } });
      if (!/^text\/html(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel(); return null;
      }
      const html = await boundedBody(response, MAX_HTML_BYTES);
      if (!html) return null;
      const text = html.toString('utf8');
      if (/Please wait a few moments|cf-challenge|Just a moment/i.test(text)) return null;
      const videos = videoSources(text);
      if (!videos.length) return null;
      const abort = new AbortController();
      const media = await request(videos[0], { redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]),
        headers: { Accept: 'video/mp4', Referer: url, 'User-Agent': 'Linky/1.0 (+https://linkybot.dev)' } });
      const length = media.headers.get('content-length');
      const size = length === null ? undefined : Number(length);
      if (!media.ok || !/^video\/mp4(?:;|$)/i.test(media.headers.get('content-type') ?? '') ||
          (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(size) || !size || size > MAX_VIDEO_BYTES))) {
        await media.body?.cancel(); return null;
      }
      const reader = media.body?.getReader();
      if (!reader) return null;
      let complete = false;
      const cancel = () => { abort.abort(); void reader.cancel().catch(() => {}); };
      const stream = (async function* () {
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_VIDEO_BYTES || (size !== undefined && total > size)) throw new Error('Erome media exceeds its size limit');
          yield value;
        }
        if (!total || (size !== undefined && total !== size)) throw new Error('Incomplete Erome media');
        complete = true;
      })();
      try {
        const output = await convert({ stream, size, cancel }, { maxBytes, onEncoding: () => progress('preparing') });
        return complete && output?.length && output.length <= maxBytes ? { bytes: output, videoCount: videos.length } : null;
      } finally {
        if (!complete) cancel();
        reader.releaseLock();
      }
    } catch { return null; }
    finally { leave(); }
  };
  return async (raw, onStage, options) => {
    const source = parseEromeUrl(raw);
    const maxBytes = normalizeAttachmentLimit(options?.maxBytes);
    if (!source || maxBytes === null) return null;
    const key = `${maxBytes}:${source.url}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      cache.delete(key);
      cache.set(key, cached);
      notify(onStage, 'cached');
      return attachment(cached);
    }
    if (cached) evict(key);
    let job = jobs.get(key);
    if (!job) {
      if (jobs.size >= MAX_WAITING + 1) return null;
      const created: Job = { result: Promise.resolve(null), stage: busy ? 'queued' : 'downloading', consumers: 0, observers: new Set() };
      jobs.set(key, created);
      created.result = prepare(source.url, maxBytes, stage => {
        if (created.stage === stage) return;
        created.stage = stage;
        for (const observer of created.observers) notify(observer, stage);
      }).then(result => {
        if (result) remember(key, result);
        return result;
      }).finally(() => { jobs.delete(key); });
      job = created;
    }
    if (job.consumers >= MAX_CONSUMERS) return null;
    job.consumers++;
    if (onStage) job.observers.add(onStage);
    notify(onStage, job.stage);
    try {
      const result = await job.result;
      return result ? attachment(result) : null;
    } finally {
      job.consumers--;
      if (onStage) job.observers.delete(onStage);
    }
  };
}
