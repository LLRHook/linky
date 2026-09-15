import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createMediaAssetStore, mediaExtension, type MediaAssetStore, type MediaMime } from './MediaAssetStore';
import { createMediaServer } from './MediaServer';
import { createRegionalDownloader, type RegionalDownloader } from './RegionalDownloader';
import { createOriginalVideoInspector, createOriginalImageInspector } from './VideoAttachment';
import { parseEromeUrl, resolveEromeAlbum, eromeScheduler } from './Erome';
import type { EromeItemInfo, EromeMedia, EromeMediaPreparer } from './EromeMedia';
import { createMediaReuseIndex, type MediaReuseIndex, type ReuseSource } from './MediaReuseIndex';
import { createEromeJobs, eromeStage, safely } from './EromeJobs';
import { createEromeImageDownloader } from './EromeImage';
import type { EromeSelection } from './EromeAlbum';
import type { EromeWorkScheduler } from './EromeWorkScheduler';

export interface EromeMediaSettings { key: string; workerBaseUrl: string; publicBaseUrl: string; directory: string; port: number }
export function mediaBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash ||
    url.pathname !== '/' || !/^[a-z0-9.-]+$/.test(url.hostname) || !/^https:\/\/[^/?#:@]+\/?$/.test(raw))
    throw Error('Invalid media base URL');
  return url.origin;
}
type Resolved = { album: string; source: string; videoCount: number } & EromeItemInfo;
type Store = Pick<MediaAssetStore, 'publish' | 'get'> & Partial<Pick<MediaAssetStore, 'reserve' | 'cancelReservation'>>;

async function verifiedLocalBytes(asset: { path: string; size: number; sha256: string }, signal: AbortSignal): Promise<Buffer | null> {
  if (signal.aborted || asset.size <= 0 || asset.size > 24 * 1024 * 1024) return null;
  const file = await open(asset.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size !== asset.size) return null;
    const bytes = Buffer.alloc(asset.size + 1);
    let total = 0;
    while (total < bytes.length) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(bytes, total, bytes.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    const after = await file.stat();
    return !signal.aborted && total === asset.size && after.size === before.size && after.mtimeMs === before.mtimeMs &&
      createHash('sha256').update(bytes.subarray(0, total)).digest('hex') === asset.sha256 ? bytes.subarray(0, total) : null;
  } finally { await file.close(); }
}

export function createEromeMediaPreparer({ store, download, inspect, resolve = resolveEromeAlbum, baseUrl, signal,
  inspectSource, downloadValidated, waitUntilReady, reuse, scheduler = eromeScheduler,
  imageDownloader = createEromeImageDownloader(), inspectImage = createOriginalImageInspector() }: {
  store: Store; download: RegionalDownloader['download']; inspect: ReturnType<typeof createOriginalVideoInspector>;
  resolve?: (raw: string, request?: typeof fetch, selection?: EromeSelection, signal?: AbortSignal) => Promise<Resolved | null>;
  inspectSource?: RegionalDownloader['inspectSource']; downloadValidated?: RegionalDownloader['downloadValidated'];
  waitUntilReady?: RegionalDownloader['waitUntilReady']; reuse?: MediaReuseIndex; scheduler?: EromeWorkScheduler;
  imageDownloader?: ReturnType<typeof createEromeImageDownloader>; inspectImage?: ReturnType<typeof createOriginalImageInspector>;
  baseUrl: string; signal: AbortSignal;
}): EromeMediaPreparer & { drain(): Promise<void> } {
  const publicBase = mediaBaseUrl(baseUrl), jobs = createEromeJobs<EromeMedia>(signal), rolloverJobs = createEromeJobs<EromeMedia>(signal);
  const running = new Set<Promise<EromeMedia | null>>();
  const track = (work: Promise<EromeMedia | null>) => {
    running.add(work); void work.then(() => running.delete(work), () => running.delete(work)); return work;
  };
  const cache = new Map<string, { media: EromeMedia; expiresAt: number; timer: ReturnType<typeof setTimeout> }>();
  // Only completed descriptors enter this LRU. Active copies are scheduler-owned and tracked separately.
  const rollovers = new Map<string, EromeMedia>();
  const location = (id: string, mime?: MediaMime) => `${publicBase}/media/${id}.${mediaExtension(mime)}`;
  const forget = (key: string) => { clearTimeout(cache.get(key)?.timer); cache.delete(key); };
  const remember = (key: string, media: EromeMedia) => {
    forget(key); while (cache.size >= 64) forget(cache.keys().next().value!);
    const timer = setTimeout(() => cache.delete(key), 300_000); timer.unref();
    cache.set(key, { media, expiresAt: Date.now() + 300_000, timer });
  };
  async function reserve(media: EromeMedia, caller: Parameters<EromeMediaPreparer>[1], rolloverRetried = false): Promise<EromeMedia | null> {
    if (signal.aborted || caller?.context?.signal?.aborted) return null;
    if (!store.reserve) return media;
    const token = await store.reserve(media.id);
    if (token) {
      if (signal.aborted) { store.cancelReservation?.(token); return null; }
      return { ...media, reservation: token };
    }
    // A full asset can be rolled over using verified local bytes, without a new source download.
    const copied = rollovers.get(media.id) ?? await rolloverJobs.run(media.id, caller?.context, context =>
      scheduler.run(context, 'original', activeSignal => track((async () => {
        const source = await store.get(media.id);
        if (!source || activeSignal.aborted) return null;
        const bytes = await eromeStage({ ...context, signal: activeSignal }, 'store',
          () => verifiedLocalBytes({ ...source, sha256: media.sha256, size: media.size }, activeSignal));
        if (!bytes) return null;
        const asset = await store.publish(bytes, { mimeType: media.mimeType });
        if (!asset || activeSignal.aborted) return null;
        const copied = { ...media, ...asset, url: location(asset.id, asset.mimeType), reservation: undefined };
        while (rollovers.size >= 32) rollovers.delete(rollovers.keys().next().value!);
        rollovers.set(media.id, copied); return copied;
      })())));
    if (!copied || signal.aborted || caller?.context?.signal?.aborted) return null;
    const reservation = await store.reserve(copied.id);
    if (!reservation) {
      rollovers.delete(media.id);
      return rolloverRetried ? null : reserve(media, caller, true);
    }
    if (signal.aborted) { store.cancelReservation?.(reservation); return null; }
    return { ...copied, reservation };
  }
  const prepare: EromeMediaPreparer = async (raw, options) => {
    const album = parseEromeUrl(raw), caller = options?.context;
    if (!album || signal.aborted || caller?.signal?.aborted) return null;
    const jobKey = `${album.url}:${JSON.stringify(options?.selection ?? null)}`;
    try {
      const prepared = await jobs.run(jobKey, caller, context => scheduler.run(context, 'original', activeSignal => track((async () => {
        const active = { ...context, signal: activeSignal };
        const request: typeof fetch = (input, init) => fetch(input, { ...init,
          signal: init?.signal ? AbortSignal.any([init.signal, activeSignal]) : activeSignal });
        const resolved = await eromeStage(active, 'resolve', () => resolve(album.url, request, options?.selection, activeSignal));
        if (!resolved || activeSignal.aborted) return null;
        const { source, album: canonical, ...info } = resolved;
        const imageHead = resolved.kind === 'image' ? await imageDownloader.inspect(source, canonical, activeSignal) : null;
        const videoHead = resolved.kind !== 'image' && inspectSource ? await inspectSource(resolved, activeSignal) : null;
        if (resolved.kind === 'image' && !imageHead || resolved.kind !== 'image' && inspectSource && !videoHead) return null;
        const head = imageHead ?? videoHead;
        const mimeType: MediaMime = imageHead?.mimeType ?? 'video/mp4';
        let cacheKey = `${canonical}\n${source}\n${head?.etag ?? ''}\n${head?.bytes ?? ''}`;
        let identity: ReuseSource | undefined = head ? { album: canonical, source, etag: head.etag, bytes: head.bytes, mimeType } : undefined;
        const cached = cache.get(cacheKey), persistent = identity ? await reuse?.get(identity) : undefined;
        const candidate = cached && cached.expiresAt > Date.now() ? cached.media : persistent;
        if (cached && cached.expiresAt <= Date.now()) forget(cacheKey);
        if (candidate) {
          const asset = await store.get(candidate.id);
          if (asset && asset.size === candidate.size && asset.sha256 === candidate.sha256 &&
              (asset.mimeType ?? 'video/mp4') === mimeType && (!head || head.bytes === asset.size &&
                await eromeStage(active, 'store', () => verifiedLocalBytes(asset, activeSignal)))) {
            const media: EromeMedia = { id: asset.id, size: asset.size, sha256: asset.sha256, ...info, mimeType, metadata: candidate.metadata,
              url: location(asset.id, mimeType) };
            remember(cacheKey, media); safely(() => active.progress?.({ stage: 'store', state: 'done', cache: 'hit' }));
            safely(() => active.trace?.setCache?.('hit'));
            return activeSignal.aborted ? null : media;
          }
          forget(cacheKey); await reuse?.invalidateAsset(candidate.id);
        }
        safely(() => active.progress?.({ stage: 'store', state: 'waiting', cache: 'miss' }));
        safely(() => active.trace?.setCache?.('miss'));
        if (resolved.kind !== 'image' && waitUntilReady && !await waitUntilReady(activeSignal)) return null;
        const bytes = await eromeStage(active, 'download', async () => {
          if (imageHead) return imageDownloader.download(source, canonical, imageHead, activeSignal);
          if (downloadValidated) {
            const result = await downloadValidated(resolved, activeSignal, videoHead ?? undefined);
            if (!result) return null;
            identity = { album: canonical, source, etag: result.etag, bytes: result.bytes.length, mimeType };
            cacheKey = `${canonical}\n${source}\n${result.etag}\n${result.bytes.length}`;
            return result.bytes;
          }
          return download(resolved, activeSignal);
        });
        if (!bytes || activeSignal.aborted) return null;
        const metadata = await eromeStage(active, 'inspect', () => imageHead
          ? inspectImage(bytes, imageHead.mimeType, { signal: activeSignal }) : inspect(bytes, { signal: activeSignal }));
        if (!metadata || activeSignal.aborted) return null;
        const asset = await eromeStage(active, 'store', () => store.publish(bytes, { mimeType }));
        if (!asset || activeSignal.aborted) return null;
        const media: EromeMedia = { ...asset, ...info, mimeType, metadata, url: location(asset.id, mimeType) };
        if (identity) await reuse?.remember(identity, { ...asset, mimeType, metadata });
        remember(cacheKey, media); return media;
      })())));
      if (!prepared || caller?.signal?.aborted || signal.aborted) return null;
      const result = await reserve(prepared, options);
      if (caller?.signal?.aborted || signal.aborted) {
        if (result?.reservation) store.cancelReservation?.(result.reservation); return null;
      }
      return result;
    } catch { return null; }
  };
  return Object.assign(prepare, { async drain() {
    await jobs.drain(); await rolloverJobs.drain(); await Promise.allSettled([...running]);
    for (const key of cache.keys()) forget(key); rollovers.clear();
  } });
}

export interface EromeMediaRuntime {
  prepare: EromeMediaPreparer;
  bind: MediaAssetStore['bind']; release: MediaAssetStore['release'];
  unbind?: MediaAssetStore['unbind']; cancelReservation?: MediaAssetStore['cancelReservation'];
  close(): Promise<void>;
}
export async function createEromeMediaRuntime(settings: EromeMediaSettings,
  injected: EromeWorkScheduler | { scheduler?: EromeWorkScheduler } = {}): Promise<EromeMediaRuntime> {
  const scheduler = 'run' in injected ? injected : injected.scheduler ?? eromeScheduler;
  const publicBase = mediaBaseUrl(settings.publicBaseUrl);
  if (!Number.isSafeInteger(settings.port) || settings.port < 1024 || settings.port > 65535) throw Error('Invalid media listener port');
  const downloader = createRegionalDownloader({ key: settings.key, workerBaseUrl: settings.workerBaseUrl });
  const store = await createMediaAssetStore({ directory: settings.directory });
  const reuse = await createMediaReuseIndex({ directory: join(dirname(settings.directory), 'erome-reuse') }).catch(() => undefined);
  const stopped = new AbortController(), server = createMediaServer({ store, claim: downloader.claim });
  try { server.listen(settings.port, '0.0.0.0'); await once(server, 'listening'); }
  catch (error) { downloader.close(); await store.close(); await reuse?.close(); throw error; }
  const prepare = createEromeMediaPreparer({ store, download: downloader.download, inspectSource: downloader.inspectSource,
    downloadValidated: downloader.downloadValidated, waitUntilReady: downloader.waitUntilReady, reuse, scheduler,
    inspect: createOriginalVideoInspector(), baseUrl: publicBase, signal: stopped.signal });
  let closing: Promise<void> | undefined, closingStore: Promise<void> | undefined;
  const closeStore = () => closingStore ??= store.close();
  return {
    prepare: prepare as EromeMediaPreparer, bind: store.bind, release: store.release,
    unbind: store.unbind, cancelReservation: store.cancelReservation,
    close(): Promise<void> {
      if (closing) return closing;
      stopped.abort(); downloader.close(); server.closeAllConnections();
      const cleanup = (async () => {
        await new Promise<void>(resolve => server.close(() => resolve()));
        await prepare.drain(); await reuse?.close(); await closeStore();
      })();
      closing = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { void closeStore().catch(() => undefined); reject(Error('Media shutdown timed out')); }, 5_000);
        cleanup.then(resolve, reject).finally(() => clearTimeout(timer));
      });
      return closing;
    },
  };
}
