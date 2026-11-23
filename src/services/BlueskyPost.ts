import { readBoundedJson } from './BoundedJson';
import { blueskyActor } from './SocialProviders';
import { formatProse } from './TweetTranslation';

/** One full-size image of a post on Bluesky's own image CDN, with its alt text. */
export interface BlueskyImage { type: 'photo'; url: string; alt: string }

/** One post's author, words as written (Markdown-safe, link facets as masked links) and images. */
export interface BlueskyPart {
  url: string;
  author: { did: string; handle: string; name: string; avatar?: string };
  text: string;
  images: BlueskyImage[];
}

/** A public, unlabelled post and the one post it quotes, when that is a plain or image post. */
export interface BlueskyPost extends BlueskyPart { quote?: BlueskyPart }

/** Look up one post by the `actor/rkey` identity `parseSocialUrl` gives a Bluesky link. */
export type BlueskyLookup = (postId: string) => Promise<BlueskyPost | null>;

export const BLUESKY_APPVIEW = 'https://public.api.bsky.app';
const MAX_BODY_BYTES = 256 * 1024;
const FETCH_TIMEOUT = 5_000, LOOKUP_TIMEOUT = 20_000, CACHE_TTL = 5 * 60_000, FAILURE_TTL = 30_000;
const CACHE_LIMIT = 100, PENDING_LIMIT = 8, MAX_TEXT = 3_000, MAX_IMAGES = 20;
const RKEY = /^[A-Za-z0-9._:~-]{1,512}$/;
const POST_URI = /^at:\/\/([^/]{1,2048})\/app\.bsky\.feed\.post\/([A-Za-z0-9._:~-]{1,512})$/;
const LINK_FACET = 'app.bsky.richtext.facet#link';

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Any moderation or self label means Linky leaves the post to the native card. */
const labelled = (value: unknown): boolean => value !== undefined && (!Array.isArray(value) || value.length > 0);

/** The requested identity: a lowercased handle or a supported DID, and a record key. */
function parsePostId(postId: string): { actor: string; rkey: string } | null {
  const slash = postId.indexOf('/');
  const actor = postId.slice(0, slash), rkey = postId.slice(slash + 1);
  return slash > 0 && blueskyActor(actor) === actor && RKEY.test(rkey) && rkey !== '.' && rkey !== '..' ? { actor, rkey } : null;
}

/** An address on Bluesky's image CDN under the given route and owner, without credentials or a port. */
function cdnUrl(value: unknown, route: string, did: string): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'cdn.bsky.app' && !url.port && !url.username && !url.password &&
      url.pathname.startsWith(`/img/${route}/plain/${did}/`) ? url.href : undefined;
  } catch { return undefined; }
}

function httpsTarget(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

/** A byte offset that starts a UTF-8 character (or ends the text). */
const boundary = (bytes: Buffer, index: number): boolean => index === bytes.length || (bytes[index] & 0xc0) !== 0x80;

/**
 * The post text kept literal, with each well-formed HTTPS link facet as a masked link to its full address. Facets
 * use UTF-8 byte offsets; a malformed, overlapping or non-HTTPS facet leaves its text as written.
 */
export function blueskyText(text: string, facets: unknown): string {
  const bytes = Buffer.from(text, 'utf8');
  const links: { start: number; end: number; uri: string }[] = [];
  for (const facet of Array.isArray(facets) ? facets.slice(0, 100) : []) {
    const fields = record(facet), index = record(fields.index);
    const start = index.byteStart, end = index.byteEnd;
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start < 0 || end <= start || end > bytes.length || !boundary(bytes, start) || !boundary(bytes, end)) continue;
    const features = Array.isArray(fields.features) ? fields.features.map(record) : [];
    const uri = httpsTarget(features.find(feature => feature.$type === LINK_FACET)?.uri);
    if (uri) links.push({ start, end, uri });
  }
  links.sort((first, second) => first.start - second.start);
  let result = '', cursor = 0;
  for (const link of links) {
    if (link.start < cursor) continue;
    result += formatProse(bytes.subarray(cursor, link.start).toString('utf8'));
    const shown = bytes.subarray(link.start, link.end).toString('utf8').replace(/\s+/g, ' ').trim() || new URL(link.uri).hostname;
    const label = shown.length > 60 ? `${shown.slice(0, 59)}…` : shown;
    result += `[${label.replace(/[\\\[\]]/g, '\\$&')}](<${link.uri}>)`;
    cursor = link.end;
  }
  return result + formatProse(bytes.subarray(cursor).toString('utf8'));
}

function parseAuthor(value: unknown): BlueskyPart['author'] | null {
  const author = record(value);
  const did = typeof author.did === 'string' && author.did.startsWith('did:') && blueskyActor(author.did) === author.did ? author.did : '';
  const handle = typeof author.handle === 'string' && !author.handle.startsWith('did:') ? blueskyActor(author.handle) : null;
  if (!did || !handle || handle === 'handle.invalid' || labelled(author.labels)) return null;
  const name = typeof author.displayName === 'string' ? author.displayName.replace(/\s+/g, ' ').trim().slice(0, 100) : '';
  const avatar = cdnUrl(author.avatar, 'avatar', did);
  return { did, handle, name, ...(avatar ? { avatar } : {}) };
}

/** Every image of an images or gallery view, all on the author's CDN path; null for any other embed or a bad item. */
function viewImages(value: unknown, did: string): BlueskyImage[] | null {
  const view = record(value);
  const items = view.$type === 'app.bsky.embed.images#view' ? view.images
    : view.$type === 'app.bsky.embed.gallery#view' ? view.items : undefined;
  if (!Array.isArray(items) || !items.length || items.length > MAX_IMAGES) return null;
  const images: BlueskyImage[] = [];
  for (const item of items) {
    const fields = record(item);
    if (view.$type === 'app.bsky.embed.gallery#view' && fields.$type !== undefined &&
        fields.$type !== 'app.bsky.embed.gallery#viewImage') return null;
    const url = cdnUrl(fields.fullsize, 'feed_fullsize', did);
    if (!url) return null;
    images.push({ type: 'photo', url, alt: typeof fields.alt === 'string' ? fields.alt.trim().slice(0, 1024) : '' });
  }
  return images;
}

/** The post a link names, from its validated record URI. */
const postUrl = (handle: string, rkey: string): string => `https://bsky.app/profile/${handle}/post/${rkey}`;

/** The post record's words; `embedded` when the record attaches anything, which its view must then show. */
function postRecord(value: unknown): { text: string; facets: unknown; embedded: boolean } | null {
  const post = record(value);
  return post.$type === 'app.bsky.feed.post' && typeof post.text === 'string' && post.text.length <= MAX_TEXT &&
    !labelled(post.labels) ? { text: post.text, facets: post.facets, embedded: post.embed !== undefined } : null;
}

/** A quoted post shown with its own words and images; a quote of a quote, a video or a link card abstains. */
function parseQuote(value: unknown): BlueskyPart | null {
  const quote = record(value);
  const author = parseAuthor(quote.author);
  const uri = typeof quote.uri === 'string' ? POST_URI.exec(quote.uri) : null;
  const words = postRecord(quote.value);
  if (quote.$type !== 'app.bsky.embed.record#viewRecord' || !author || !uri || uri[1] !== author.did || !words ||
      labelled(quote.labels)) return null;
  const embeds = quote.embeds === undefined ? [] : quote.embeds;
  if (!Array.isArray(embeds) || embeds.length > 1 || words.embedded !== (embeds.length > 0)) return null;
  const images = embeds.length ? viewImages(embeds[0], author.did) : [];
  if (!images) return null;
  return { url: postUrl(author.handle, uri[2]), author, text: blueskyText(words.text, words.facets), images };
}

/**
 * Read one thread response. It must be the requested post (record key and author, by DID or handle), unlabelled, with
 * no embed, images, a gallery, a quote, or images with a quote. Video, link cards and anything else abstain.
 */
export function parseBlueskyThread(value: unknown, actor: string, rkey: string): BlueskyPost | null {
  const thread = record(record(value).thread);
  const post = record(thread.post);
  const author = parseAuthor(post.author);
  const uri = typeof post.uri === 'string' ? POST_URI.exec(post.uri) : null;
  const words = postRecord(post.record);
  if (thread.$type !== 'app.bsky.feed.defs#threadViewPost' || !author || !uri || uri[2] !== rkey || uri[1] !== author.did ||
      (actor.startsWith('did:') ? actor !== author.did : actor !== author.handle) || !words || labelled(post.labels) ||
      words.embedded !== (post.embed !== undefined)) return null;
  const embed = record(post.embed);
  let images: BlueskyImage[] | null = [], quote: BlueskyPart | null | undefined;
  if (post.embed === undefined) images = [];
  else if (embed.$type === 'app.bsky.embed.record#view') quote = parseQuote(embed.record);
  else if (embed.$type === 'app.bsky.embed.recordWithMedia#view') {
    images = viewImages(embed.media, author.did);
    quote = parseQuote(record(embed.record).record);
  } else images = viewImages(embed, author.did);
  if (!images || quote === null) return null;
  return { url: postUrl(author.handle, rkey), author, text: blueskyText(words.text, words.facets), images,
    ...(quote ? { quote } : {}) };
}

/** Fetch one public post from the Bluesky AppView. Only the post's actor and record key are sent. */
export async function fetchBlueskyPost(postId: string, fetchJson: typeof fetch = fetch): Promise<BlueskyPost | null> {
  const identity = parsePostId(postId);
  if (!identity) return null;
  try {
    const signal = AbortSignal.timeout(FETCH_TIMEOUT);
    const uri = `at://${identity.actor}/app.bsky.feed.post/${identity.rkey}`;
    const response = await fetchJson(`${BLUESKY_APPVIEW}/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}&depth=0&parentHeight=0`, {
      signal, redirect: 'error', credentials: 'omit',
      headers: { Accept: 'application/json', 'User-Agent': 'LinkyBot/1.0 (+https://linkybot.dev)' },
    });
    if (!response.ok) { void response.body?.cancel().catch(() => {}); return null; }
    return parseBlueskyThread(await readBoundedJson(response, MAX_BODY_BYTES, signal), identity.actor, identity.rkey);
  } catch { return null; }
}

/**
 * Post lookup with bounded memory and duplicate suppression: one AppView request per post for five minutes (30 s after
 * a failure), at most 100 entries and eight requests in flight. Each caller receives its own copy.
 */
export function createBlueskyLookup(fetchJson: typeof fetch = fetch): BlueskyLookup {
  const cache = new Map<string, { value: BlueskyPost | null; expiresAt: number }>();
  const pending = new Map<string, Promise<BlueskyPost | null>>();
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  function expire(): void {
    clearTimeout(expiryTimer);
    for (const [key, entry] of cache) if (entry.expiresAt <= Date.now()) cache.delete(key);
    if (cache.size) {
      expiryTimer = setTimeout(expire, Math.max(1, Math.min(...[...cache.values()].map(entry => entry.expiresAt)) - Date.now()));
      expiryTimer.unref();
    }
  }

  return async postId => {
    if (!parsePostId(postId)) return null;
    expire();
    const hit = cache.get(postId);
    let result = hit?.value;
    if (!hit) {
      let waiting = pending.get(postId);
      if (!waiting) {
        if (pending.size >= PENDING_LIMIT) return null;
        waiting = fetchBlueskyPost(postId, fetchJson).catch(() => null);
        pending.set(postId, waiting);
        void waiting.then(value => {
          pending.delete(postId);
          cache.set(postId, { value, expiresAt: Date.now() + (value ? CACHE_TTL : FAILURE_TTL) });
          while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
          expire();
        });
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        result = await Promise.race([waiting, new Promise<null>(resolve => {
          timer = setTimeout(() => resolve(null), LOOKUP_TIMEOUT);
        })]);
      } finally { clearTimeout(timer); }
    }
    return result ? structuredClone(result) : null;
  };
}
