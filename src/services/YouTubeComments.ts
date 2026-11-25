import type { ReplyPage } from './ReplyThreads';

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Keep only top-level comments for the requested video, preserving relevance order. */
export function parseYouTubeComments(value: unknown, videoId: string): ReplyPage | null {
  const items = record(value).items;
  if (!Array.isArray(items)) return null;
  const replies = items.flatMap(value => {
    const thread = record(record(value).snippet), comment = record(thread.topLevelComment), snippet = record(comment.snippet);
    const time = typeof snippet.publishedAt === 'string' ? Date.parse(snippet.publishedAt) : NaN;
    if (thread.videoId !== videoId || typeof comment.id !== 'string' || !comment.id ||
        typeof snippet.textDisplay !== 'string' || !snippet.textDisplay.trim() || snippet.textDisplay.length > 100_000 ||
        typeof snippet.authorDisplayName !== 'string' || !snippet.authorDisplayName.trim() ||
        typeof snippet.likeCount !== 'number' || !Number.isSafeInteger(snippet.likeCount) || snippet.likeCount < 0 || !Number.isFinite(time) || time < 0) return [];
    return [{ name: snippet.authorDisplayName.slice(0, 256), handle: '', profileUrl: '',
      url: `https://www.youtube.com/watch?v=${videoId}`, text: snippet.textDisplay.slice(0, 501),
      likes: snippet.likeCount, timestamp: Math.floor(time / 1000), hasMedia: false }];
  });
  return { N: 0, countTime: 0, r: items.length, m: items.length - replies.length, replies: replies.slice(0, 25), source: 'YouTube', orderLabel: "in YouTube's relevance order" };
}
/** One quota unit per uncached click; cache contains parsed data only and never publish counts. */
export function createYouTubeComments(key: string,
  request: (parameters: Record<string, string>, comment: boolean, byteCap: number) => Promise<Record<string, unknown> | null>, now = Date.now) {
  const cache = new Map<string, { until: number; page: ReplyPage | null }>();
  const pending = new Map<string, Promise<ReplyPage | null>>();
  return async (videoId: string, N: number | string, countTime: number): Promise<ReplyPage | null> => {
    if (!key.trim() || !/^[\w-]{11}$/.test(videoId)) return null;
    for (const [id, entry] of cache) if (entry.until <= now()) cache.delete(id);
    let page = cache.get(videoId)?.page;
    if (page === undefined) {
      let flight = pending.get(videoId);
      if (!flight) {
        if (pending.size >= 8) return null;
        flight = (async () => {
          const body = await request({ part: 'snippet', videoId, order: 'relevance', maxResults: '25', textFormat: 'plainText',
            fields: 'items(id,snippet(videoId,topLevelComment(id,snippet(textDisplay,authorDisplayName,authorChannelUrl,likeCount,publishedAt))))' }, true, 256 * 1024);
          const parsed = parseYouTubeComments(body, videoId);
          if (cache.size >= 100) cache.delete(cache.keys().next().value!);
          cache.set(videoId, { until: now() + (parsed ? 300_000 : 30_000), page: parsed });
          return parsed;
        })();
        pending.set(videoId, flight);
      }
      try { page = await flight; } finally { pending.delete(videoId); }
    }
    return page ? { ...page, N, countTime } : null;
  };
}
