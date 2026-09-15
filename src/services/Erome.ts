import { AttachmentBuilder } from 'discord.js';
import { createVideoAttachment, createOriginalImageInspector, normalizeAttachmentLimit, MAX_VIDEO_BYTES,
  type VideoInput, type VideoOptions } from './VideoAttachment';
import type { EromePreparer, EromeProgress } from './EromeDelivery';
import { parseEromeUrl, resolveEromeItems, selectEromeItem, type EromeSelection } from './EromeAlbum';
import { createEromeImageDownloader } from './EromeImage';
import { createEromeWorkScheduler, type EromeWorkScheduler } from './EromeWorkScheduler';
import { createEromeJobs, eromeStage, safely } from './EromeJobs';
import type { EromeItemInfo } from './EromeMedia';
import type { DeliveryContext } from './DeliveryContext';

export { parseEromeUrl } from './EromeAlbum';
export const eromeScheduler = createEromeWorkScheduler();
const CACHE_TTL_MS = 300_000, MAX_CACHE_ENTRIES = 32, MAX_CACHE_BYTES = 128 * 1024 * 1024;
type Prepared = EromeItemInfo & { bytes: Buffer; videoCount: number; filename: string };
type CacheEntry = Prepared & { expiresAt: number; timer: ReturnType<typeof setTimeout> };
const sharedPreparations = new WeakMap<EromeWorkScheduler, { jobs: ReturnType<typeof createEromeJobs<Prepared>>; cache: Map<string, CacheEntry> }>();

export async function resolveEromeAlbum(raw: string, request: typeof fetch = fetch, selection?: EromeSelection, signal?: AbortSignal) {
  const album = await resolveEromeItems(raw, request, signal), item = album && selectEromeItem(album, selection);
  return album && item ? { album: album.album, source: item.source, videoCount: album.videoCount, kind: item.kind,
    itemIndex: item.index, itemFingerprint: item.fingerprint, itemCount: album.items.length,
    itemFingerprints: album.items.map(value => value.fingerprint), truncated: album.truncated } : null;
}

/** Compatibility seam for existing callers; runtime preparation uses the injected shared scheduler. */
export async function withEromePreparation<T>(work: () => Promise<T>): Promise<T | null> {
  try { return await eromeScheduler.run(undefined, 'attachment', work); } catch { return null; }
}

function progressContext(context: DeliveryContext | undefined, observer?: EromeProgress): DeliveryContext {
  let previous: string | undefined;
  const notify = (stage: Parameters<NonNullable<EromeProgress>>[0]) => {
    if (stage !== previous) { previous = stage; safely(() => observer?.(stage)); }
  };
  return { ...context, progress: event => {
    safely(() => context?.progress?.(event));
    if (event.cache === 'hit') notify('cached');
    else if (event.state !== 'done') {
      const stage = event.stage === 'queue' ? 'queued' : event.stage === 'convert' || event.stage === 'inspect' ? 'preparing' : 'downloading';
      notify(stage);
    }
  } };
}

/** Complete bounded items, coalesced without allowing one consumer to cancel another. */
export function createEromePreparer({ fetch: request = fetch, convert = createVideoAttachment(),
  inspectImage = createOriginalImageInspector(), imageDownloader = createEromeImageDownloader(), scheduler = eromeScheduler }: {
  fetch?: typeof fetch; convert?: (input: VideoInput, options?: VideoOptions) => Promise<Buffer | null>;
  inspectImage?: ReturnType<typeof createOriginalImageInspector>;
  imageDownloader?: ReturnType<typeof createEromeImageDownloader>;
  scheduler?: EromeWorkScheduler;
} = {}): EromePreparer {
  let shared = sharedPreparations.get(scheduler);
  if (!shared) { shared = { jobs: createEromeJobs<Prepared>(), cache: new Map() }; sharedPreparations.set(scheduler, shared); }
  const { jobs, cache } = shared;
  const evict = (key: string) => { clearTimeout(cache.get(key)?.timer); cache.delete(key); };
  function remember(key: string, value: Prepared) {
    while (cache.size && (cache.size >= MAX_CACHE_ENTRIES || [...cache.values()].reduce((sum, entry) => sum + entry.bytes.length, value.bytes.length) > MAX_CACHE_BYTES)) evict(cache.keys().next().value!);
    if (value.bytes.length > MAX_CACHE_BYTES) return;
    const timer = setTimeout(() => cache.delete(key), CACHE_TTL_MS); timer.unref();
    cache.set(key, { ...value, expiresAt: Date.now() + CACHE_TTL_MS, timer });
  }
  const attachment = (value: Prepared) => {
    const { bytes, filename, ...info } = value;
    // Discord.js reads Buffer inputs without mutation. Builders are independent; media bytes are internal read-only data.
    return { ...info, file: new AttachmentBuilder(bytes, { name: filename,
      description: `${value.kind === 'image' ? 'Image' : 'Video'} from the linked album.` }) };
  };
  return async (raw, onStage, options) => {
    const album = parseEromeUrl(raw), maxBytes = normalizeAttachmentLimit(options?.maxBytes);
    const context = progressContext(options?.context, onStage);
    if (!album || maxBytes === null || context.signal?.aborted) return null;
    const key = `${maxBytes}:${album.url}:${JSON.stringify(options?.selection ?? null)}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      safely(() => context.trace?.setCache?.('hit'));
      cache.delete(key); cache.set(key, cached); safely(() => context.progress?.({ stage: 'store', state: 'done', cache: 'hit' }));
      return attachment(cached);
    }
    if (cached) evict(key);
    safely(() => context.trace?.setCache?.('miss'));
    try {
      const result = await jobs.run(key, context, shared => scheduler.run(shared, 'attachment', async signal => {
        const active = { ...shared, signal };
        const resolved = await eromeStage(active, 'resolve', () => resolveEromeAlbum(album.url, request, options?.selection, signal));
        if (!resolved || signal.aborted) return null;
        const { source, album: canonical, ...info } = resolved;
        if (resolved.kind === 'image') {
          const head = await imageDownloader.inspect(source, canonical, signal);
          if (!head || head.bytes > maxBytes) return null;
          const bytes = await eromeStage(active, 'download', () => imageDownloader.download(source, canonical, head, signal));
          if (!bytes || !await eromeStage(active, 'inspect', () => inspectImage(bytes, head.mimeType, { signal }))) return null;
          return { ...info, bytes, filename: head.mimeType === 'image/png' ? 'linky-image.png' : 'linky-image.jpg' };
        }
        const abort = new AbortController(), downloadSignal = AbortSignal.any([signal, abort.signal, AbortSignal.timeout(120_000)]);
        let downloadSpan: ReturnType<NonNullable<DeliveryContext['trace']>['startStage']> | undefined;
        let transferEnded = false;
        safely(() => { downloadSpan = active.trace?.startStage('download'); });
        safely(() => active.progress?.({ stage: 'download', state: 'running' }));
        const endTransfer = (ok: boolean) => {
          if (transferEnded) return; transferEnded = true;
          safely(() => downloadSpan?.finish(ok ? 'ok' : downloadSignal.aborted ? 'cancelled' : 'failed'));
          safely(() => active.progress?.({ stage: 'download', state: 'done' }));
        };
        let media: Response;
        try { media = await request(source, { redirect: 'error', signal: downloadSignal,
          headers: { Accept: 'video/mp4', Referer: canonical, 'User-Agent': 'Linky/1.0 (+https://linkybot.dev)' } }); }
        catch (error) { endTransfer(false); throw error; }
        const length = media.headers.get('content-length'), size = length === null ? undefined : Number(length);
        if (!media.ok || media.redirected || !/^video\/mp4(?:;|$)/i.test(media.headers.get('content-type') ?? '') ||
            length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(size) || !size || size > MAX_VIDEO_BYTES)) {
          await media.body?.cancel(); endTransfer(false); return null;
        }
        const reader = media.body?.getReader(); if (!reader) { endTransfer(false); return null; }
        let complete = false;
        const cancel = () => { abort.abort(); void reader.cancel().catch(() => {}); };
        signal.addEventListener('abort', cancel, { once: true });
        const stream = (async function* () {
          let total = 0;
          for (;;) {
            downloadSignal.throwIfAborted();
            const { done, value } = await reader.read();
            downloadSignal.throwIfAborted();
            if (done) break;
            total += value.byteLength;
            if (total > MAX_VIDEO_BYTES || size !== undefined && total > size) throw Error('Erome media exceeds its size limit');
            yield value;
          }
          if (!total || size !== undefined && total !== size) throw Error('Incomplete Erome media');
          complete = true;
          endTransfer(true);
        })();
        try {
          const output = await eromeStage(active, 'convert', () => convert({ stream, size, cancel }, { maxBytes, signal,
            onEncoding: () => safely(() => shared.progress?.({ stage: 'convert', state: 'running' })) }));
          return complete && !signal.aborted && output?.length && output.length <= maxBytes
            ? { ...info, bytes: output, filename: 'linky-video.mp4' } : null;
        } finally {
          signal.removeEventListener('abort', cancel);
          if (!complete) cancel();
          endTransfer(complete);
          reader.releaseLock();
        }
      }).then(value => { if (value) remember(key, value); return value; }));
      return result && !context.signal?.aborted ? attachment(result) : null;
    } catch { return null; }
  };
}
