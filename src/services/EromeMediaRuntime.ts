import { once } from 'node:events';
import { createMediaAssetStore, type MediaAssetStore } from './MediaAssetStore';
import { createMediaServer } from './MediaServer';
import { createRegionalDownloader } from './RegionalDownloader';
import { createOriginalVideoInspector } from './VideoAttachment';
import { parseEromeUrl, resolveEromeAlbum, withEromePreparation } from './Erome';
import type { EromeMedia, EromeMediaPreparer } from './EromeMedia';

export interface EromeMediaSettings {
  key: string;
  workerBaseUrl: string;
  publicBaseUrl: string;
  directory: string;
  port: number;
}

export function mediaBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash ||
    url.pathname !== '/' || !/^[a-z0-9.-]+$/.test(url.hostname) || !/^https:\/\/[^/?#:@]+\/?$/.test(raw))
    throw Error('Invalid media base URL');
  return url.origin;
}

export function createEromeMediaPreparer({ store, download, inspect, resolve = resolveEromeAlbum, baseUrl, signal }: {
  store: Pick<MediaAssetStore, 'publish' | 'get'>;
  download: ReturnType<typeof createRegionalDownloader>['download'];
  inspect: ReturnType<typeof createOriginalVideoInspector>;
  resolve?: typeof resolveEromeAlbum;
  baseUrl: string;
  signal: AbortSignal;
}): EromeMediaPreparer & { drain(): Promise<void> } {
  const publicBase = mediaBaseUrl(baseUrl);
  const jobs = new Map<string, { consumers: number; result: Promise<EromeMedia | null> }>();
  const cache = new Map<string, { media: EromeMedia; expiresAt: number }>();
  const running = new Set<Promise<EromeMedia | null>>();
  const prepare: EromeMediaPreparer = async raw => {
    const album = parseEromeUrl(raw);
    if (!album || signal.aborted) return null;
    const cached = cache.get(album.url);
    if (cached) {
      try {
        if (cached.expiresAt > Date.now() && await store.get(cached.media.id)) return signal.aborted ? null : cached.media;
      } catch { cache.delete(album.url); return null; }
      cache.delete(album.url);
    }
    if (signal.aborted) return null;
    let job = jobs.get(album.url);
    if (!job) {
      if (jobs.size >= 3) return null;
      const request: typeof fetch = (input, init) => fetch(input, { ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
      const result = withEromePreparation(() => {
        if (signal.aborted) return Promise.resolve(null);
        const work = (async () => {
          const source = await resolve(album.url, request);
          if (!source || signal.aborted) return null;
          const bytes = await download(source, signal);
          if (!bytes || signal.aborted) return null;
          const metadata = await inspect(bytes, { signal });
          if (!metadata || signal.aborted) return null;
          const asset = await store.publish(bytes);
          if (!asset || signal.aborted) return null;
          const media = { ...asset, metadata, videoCount: source.videoCount, url: `${publicBase}/media/${asset.id}.mp4` };
          while (cache.size >= 2) cache.delete(cache.keys().next().value!);
          cache.set(album.url, { media, expiresAt: Date.now() + 300_000 });
          return media;
        })();
        running.add(work);
        void work.then(() => running.delete(work), () => running.delete(work));
        return work;
      }).catch(() => null).finally(() => { jobs.delete(album.url); });
      job = { consumers: 0, result };
      jobs.set(album.url, job);
    }
    if (job.consumers >= 8) return null;
    job.consumers++;
    try { return await job.result; } finally { job.consumers--; }
  };
  return Object.assign(prepare, { async drain() { await Promise.allSettled([...running]); } });
}

export async function createEromeMediaRuntime(settings: EromeMediaSettings) {
  const publicBase = mediaBaseUrl(settings.publicBaseUrl);
  if (!Number.isSafeInteger(settings.port) || settings.port < 1024 || settings.port > 65535)
    throw Error('Invalid media listener port');
  const downloader = createRegionalDownloader({ key: settings.key, workerBaseUrl: settings.workerBaseUrl });
  const store = await createMediaAssetStore({ directory: settings.directory });
  const stopped = new AbortController();
  const server = createMediaServer({ store, claim: downloader.claim });
  try {
    server.listen(settings.port, '0.0.0.0');
    await once(server, 'listening');
  } catch (error) { downloader.close(); await store.close(); throw error; }
  const prepare = createEromeMediaPreparer({ store, download: downloader.download, inspect: createOriginalVideoInspector(),
    baseUrl: publicBase, signal: stopped.signal });
  let closing: Promise<void> | undefined, closingStore: Promise<void> | undefined;
  const closeStore = () => closingStore ??= store.close();
  return {
    prepare: prepare as EromeMediaPreparer,
    bind: store.bind,
    release: store.release,
    close(): Promise<void> {
      if (closing) return closing;
      stopped.abort(); downloader.close(); server.closeAllConnections();
      const cleanup = (async () => {
        await new Promise<void>(resolve => server.close(() => resolve()));
        await prepare.drain();
        await closeStore();
      })();
      closing = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          void closeStore().catch(() => undefined);
          reject(Error('Media shutdown timed out'));
        }, 5_000);
        cleanup.then(resolve, reject).finally(() => clearTimeout(timer));
      });
      return closing;
    },
  };
}
