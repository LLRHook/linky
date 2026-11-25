import { record, count, labelled } from './JsonFields';
import { JsonBodyTooLargeError, readBoundedJson } from './BoundedJson';
import { BLUESKY_APPVIEW, parseBlueskyAuthor, parseBlueskyPostUri, parsePostId } from './BlueskyPost';
import { blueskyActor } from './SocialProviders';
import { ReplyLookupError, type ReplyPage } from './ReplyThreads';

const VIEW = 'app.bsky.feed.defs#threadViewPost';
const TOO_MANY = 'This post has too many replies for Linky to load';

/** Validate anchor identity independently of embeds; keep only public direct replies. */
export function parseBlueskyReplies(value: unknown, postId: string, now: number): ReplyPage | null {
  const requested = parsePostId(postId);
  if (!requested) return null;
  const thread = record(record(value).thread), post = record(thread.post), author = record(post.author);
  const anchor = parseBlueskyPostUri(post.uri), parsedAuthor = parseBlueskyAuthor(post.author);
  if (thread.$type !== VIEW || !anchor || anchor.rkey !== requested.rkey || anchor.actor !== author.did ||
      !anchor.actor.startsWith('did:') || (requested.actor.startsWith('did:') ? requested.actor !== author.did : requested.actor !== parsedAuthor?.handle) ||
      !parsedAuthor || labelled(post.labels) || labelled(author.labels) ||
      labelled(record(post.record).labels) || !count(post.replyCount) || !Array.isArray(thread.replies)) return null;
  // AppView also returns the root gate at the top level when the anchor itself is a reply.
  const gates = [record(record(post.threadgate).record).hiddenReplies, record(record(record(value).threadgate).record).hiddenReplies];
  if (gates.some(hidden => hidden !== undefined && !Array.isArray(hidden))) return null;
  const hidden = new Set(gates.flatMap(value => Array.isArray(value) ? value : []));
  const replies = thread.replies.flatMap(value => {
    const entry = record(value), reply = record(entry.post), writer = record(reply.author), words = record(reply.record);
    const identity = parseBlueskyPostUri(reply.uri);
    const created = typeof words.createdAt === 'string' ? Date.parse(words.createdAt) : NaN;
    const indexed = typeof reply.indexedAt === 'string' ? Date.parse(reply.indexedAt) : NaN;
    const timestamp = Math.min(created, Number.isFinite(indexed) ? indexed : created) / 1000;
    if (entry.$type !== VIEW || !identity || identity.actor !== writer.did || !identity.actor.startsWith('did:') ||
        record(record(words.reply).parent).uri !== post.uri || hidden.has(reply.uri) ||
        labelled(reply.labels) || labelled(writer.labels) || labelled(words.labels) ||
        typeof writer.handle !== 'string' || blueskyActor(writer.handle) !== writer.handle || writer.handle === 'handle.invalid' ||
        typeof words.text !== 'string' || words.text.length > 100_000 || !count(reply.likeCount) || !Number.isFinite(timestamp) || timestamp < 0) return [];
    const outer = record(reply.embed);
    const embed = outer.$type === 'app.bsky.embed.recordWithMedia#view' ? record(outer.media) : outer;
    const media = embed.$type === 'app.bsky.embed.images#view' && Array.isArray(embed.images) ? embed.images.slice(0, 4).map(value => {
      const image = record(value);
      return { url: typeof image.fullsize === 'string' ? image.fullsize : typeof image.thumb === 'string' ? image.thumb : '', alt: typeof image.alt === 'string' ? image.alt : undefined };
    }) : embed.$type === 'app.bsky.embed.video#view' ? [{ url: typeof embed.thumbnail === 'string' ? embed.thumbnail : '' }] : [];
    const profileUrl = `https://bsky.app/profile/${identity.actor}`;
    return [{ avatarUrl: typeof writer.avatar === 'string' ? writer.avatar : undefined, media, name: typeof writer.displayName === 'string' && writer.displayName.trim() ? writer.displayName.slice(0, 256) : writer.handle,
      handle: writer.handle, profileUrl, url: `${profileUrl}/post/${identity.rkey}`, text: words.text.slice(0, 501),
      likes: reply.likeCount, timestamp: Math.floor(timestamp), hasMedia: ['app.bsky.embed.images#view', 'app.bsky.embed.video#view', 'app.bsky.embed.gallery#view', 'app.bsky.embed.recordWithMedia#view'].includes(String(record(reply.embed).$type)) }];
  });
  replies.sort((a, b) => b.likes - a.likes || b.timestamp - a.timestamp);
  return { N: post.replyCount, countTime: now, r: thread.replies.length, m: thread.replies.length - replies.length,
    replies: replies.slice(0, 25), maxShown: 25, threadHandle: parsedAuthor.handle, orderLabel: 'most liked first', source: 'Bluesky' };
}

/** One bounded anonymous public request, coalesced and cached independently of post previews. */
export function createBlueskyReplies(fetchJson: typeof fetch = fetch, now = Date.now) {
  const cache = new Map<string, { until: number; page: ReplyPage | null; oversize: boolean }>();
  const pending = new Map<string, Promise<ReplyPage | null>>();
  return async (postId: string): Promise<ReplyPage | null> => {
    const identity = parsePostId(postId);
    if (!identity) return null;
    const hit = cache.get(postId);
    if (hit && hit.until > now()) { if (hit.oversize) throw new ReplyLookupError(TOO_MANY); return hit.page; }
    const waiting = pending.get(postId);
    if (waiting) return waiting;
    if (pending.size >= 8) return null;
    const promise = (async () => {
      let page: ReplyPage | null = null, oversize = false;
      try {
        const signal = AbortSignal.timeout(5_000);
        const uri = `at://${identity.actor}/app.bsky.feed.post/${identity.rkey}`;
        const response = await fetchJson(`${BLUESKY_APPVIEW}/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}&depth=1&parentHeight=0`,
          { signal, redirect: 'error', credentials: 'omit' });
        if (response.ok && !response.redirected) page = parseBlueskyReplies(await readBoundedJson(response, 1024 * 1024, signal), postId, now());
        else await response.body?.cancel();
      } catch (error) { oversize = error instanceof JsonBodyTooLargeError; }
      cache.delete(postId);
      if (cache.size >= 100) cache.delete(cache.keys().next().value!);
      cache.set(postId, { until: now() + (page ? 300_000 : 30_000), page, oversize });
      if (oversize) throw new ReplyLookupError(TOO_MANY);
      return page;
    })();
    pending.set(postId, promise);
    try { return await promise; } finally { pending.delete(postId); }
  };
}
