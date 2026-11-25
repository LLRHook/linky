import { record, count } from './JsonFields';
import { readBoundedJson } from './BoundedJson';
import type { ReplyPage } from './ReplyThreads';

const id = (value: unknown): value is string => typeof value === 'string' && /^\d{1,20}$/.test(value);

/** Validate the one public conversation page; count each discarded entry once. */
export function parseXReplies(value: unknown, statusId: string, now: number): ReplyPage | null {
  const body = record(value), status = record(body.status);
  if (status.id !== statusId || !count(status.replies) || !Array.isArray(body.replies)) return null;
  const replies = body.replies.flatMap(value => {
    const reply = record(value), author = record(reply.author), parent = record(reply.replying_to);
    if (!id(reply.id) || parent.status !== statusId || reply.possibly_sensitive === true ||
        typeof reply.text !== 'string' || reply.text.length > 100_000 ||
        typeof author.name !== 'string' || !author.name.trim() ||
        typeof author.screen_name !== 'string' || !/^[A-Za-z0-9_]{1,15}$/.test(author.screen_name) ||
        !count(reply.likes) || !count(reply.created_timestamp) || reply.created_timestamp > 8_640_000_000_000) return [];
    return [{ name: author.name.slice(0, 256), handle: author.screen_name,
      profileUrl: `https://x.com/${author.screen_name}`, url: `https://x.com/${author.screen_name}/status/${reply.id}`,
      text: reply.text.slice(0, 501), likes: reply.likes, timestamp: reply.created_timestamp,
      hasMedia: Array.isArray(record(reply.media).all) && (record(reply.media).all as unknown[]).length > 0 }];
  });
  replies.sort((a, b) => b.likes - a.likes || b.timestamp - a.timestamp);
  return { N: status.replies, countTime: now, r: body.replies.length, m: body.replies.length - replies.length,
    replies: replies.slice(0, 10), orderLabel: 'most liked first', source: 'X' };
}

/** Fixed public host only, no cursor, credentials or redirect; bounded memory and concurrent work. */
export function createXReplies(fetchJson: typeof fetch = fetch, now = Date.now) {
  const cache = new Map<string, { until: number; page: ReplyPage | null }>();
  const pending = new Map<string, Promise<ReplyPage | null>>();
  return async (statusId: string): Promise<ReplyPage | null> => {
    if (!id(statusId)) return null;
    const hit = cache.get(statusId);
    if (hit && hit.until > now()) return hit.page;
    const waiting = pending.get(statusId);
    if (waiting) return waiting;
    if (pending.size >= 8) return null;
    const promise = (async () => {
      let page: ReplyPage | null = null;
      try {
        const signal = AbortSignal.timeout(5_000);
        const response = await fetchJson(`https://api.fxtwitter.com/2/conversation/${statusId}`,
          { redirect: 'error', credentials: 'omit', signal });
        if (response.ok && !response.redirected) page = parseXReplies(await readBoundedJson(response, 256 * 1024, signal), statusId, now());
        else await response.body?.cancel();
      } catch { /* Optional enrichment abstains on provider failure. */ }
      cache.delete(statusId);
      if (cache.size >= 100) cache.delete(cache.keys().next().value!);
      cache.set(statusId, { until: now() + (page ? 300_000 : 30_000), page });
      return page;
    })();
    pending.set(statusId, promise);
    try { return await promise; } finally { pending.delete(statusId); }
  };
}
