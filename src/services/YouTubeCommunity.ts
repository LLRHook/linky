import { lookup as lookupDns } from 'node:dns/promises';
import type { RequestOptions } from 'node:https';
import type { APIEmbed } from 'discord.js';
import { mapLinks, visibleLink } from './LinkTokens';
import { cancelRegionalResponse, connectHttps, isPublicIpv4, regionalAbortable } from './RegionalHttp';

export interface YouTubeCommunityLink { id: string; url: string }
export interface YouTubeCommunityPost extends YouTubeCommunityLink {
  author: { name: string; url: string };
  text: string;
  images: string[];
}

const POST_ID = /^Ug[A-Za-z0-9_-]{10,126}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_IMAGES = 10;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Only post permalinks; channel pages, video links and nested URLs are not posts. */
export function parseYouTubeCommunityUrl(value: string): YouTubeCommunityLink | null {
  if (value.length > 2048 || /[\\\s\u0000-\u001f\u007f]/.test(value)) return null;
  const parts = /^https:\/\/((?:(?:www|m)\.)?youtube\.com)(\/[^?#]*)(?:\?[^#]*)?(?:#.*)?$/i.exec(value);
  if (!parts) return null;
  try {
    const url = new URL(value);
    if (parts[1].toLowerCase() !== url.hostname || parts[2] !== url.pathname) return null;
    const id = /^\/post\/(Ug[A-Za-z0-9_-]{10,126})\/?$/.exec(url.pathname)?.[1];
    return id ? { id, url: `https://www.youtube.com/post/${id}` } : null;
  } catch { return null; }
}

export function findYouTubeCommunityLinks(content: string, limit = 5): YouTubeCommunityLink[] {
  const links = new Map<string, YouTubeCommunityLink>();
  mapLinks(content, (url, position) => {
    // Callers may request one extra sentinel to reject an over-limit source message.
    const post = links.size < Math.max(1, Math.min(6, limit)) && visibleLink(content, position) && parseYouTubeCommunityUrl(url);
    if (post && !links.has(post.id)) links.set(post.id, post);
    return url;
  });
  return [...links.values()];
}

function textRuns(value: unknown): string | null {
  const text = record(value);
  if (typeof text.simpleText === 'string') return text.simpleText.length <= 20_000 ? text.simpleText : null;
  if (!Array.isArray(text.runs) || text.runs.length > 500) return null;
  if (!text.runs.every(run => typeof record(run).text === 'string')) return null;
  const joined = text.runs.map(run => record(run).text as string).join('');
  return joined.length <= 20_000 ? joined : null;
}

function imageUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  const raw = value.startsWith('//') ? `https:${value}` : value;
  // Exact YouTube image authorities; no credentials, ports, queries, fragments,
  // encoded paths or arbitrary redirect endpoints reach Discord's media proxy.
  if (!/^https:\/\/(?:yt3\.ggpht\.com|yt3\.googleusercontent\.com)\/[A-Za-z0-9_=-][A-Za-z0-9_,=/-]*$/.test(raw)) return null;
  const url = new URL(raw);
  return url.pathname === raw.slice(url.origin.length) && !url.pathname.split('/').some(part => part === '.' || part === '..') ? raw : null;
}

function largestImage(value: unknown): string | null {
  const thumbnails = record(value).thumbnails;
  if (!Array.isArray(thumbnails) || !thumbnails.length || thumbnails.length > 20) return null;
  let largest: { url: string; area: number } | null = null;
  for (const raw of thumbnails) {
    const item = record(raw), url = imageUrl(item.url);
    if (!url || typeof item.width !== 'number' || typeof item.height !== 'number' ||
        !Number.isInteger(item.width) || !Number.isInteger(item.height) ||
        item.width < 1 || item.height < 1 || item.width > 16_384 || item.height > 16_384) return null;
    const area = item.width * item.height;
    if (!largest || area > largest.area) largest = { url, area };
  }
  return largest?.url ?? null;
}

/** Parse an inert JSON assignment, never JavaScript or generic Open Graph fallbacks. */
function initialData(html: string): unknown {
  const marker = /<script\b[^>]*>\s*(?:(?:var|let|const)\s+)?(?:ytInitialData|window\["ytInitialData"\])\s*=\s*/i.exec(html);
  if (!marker) return null;
  const start = marker.index + marker[0].length;
  if (html[start] !== '{') return null;
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') { if (++depth > 100) return null; }
    else if (char === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(start, i + 1)) as unknown; } catch { return null; }
    }
  }
  return null;
}

/** Accept only the requested public post with its own channel identity and supported attachment. */
export function parseYouTubeCommunityHtml(html: string, source: string): YouTubeCommunityPost | null {
  const link = parseYouTubeCommunityUrl(source);
  if (!link || Buffer.byteLength(html) > MAX_BYTES) return null;
  const data = initialData(html);
  if (!data) return null;
  const pending: { value: unknown; depth: number }[] = [{ value: data, depth: 0 }];
  let visited = 0, renderer: Record<string, unknown> | undefined;
  while (pending.length) {
    if (++visited > 50_000) return null;
    const entry = pending.pop()!;
    if (entry.depth > 60) return null;
    if (entry.value === null || typeof entry.value !== 'object') continue;
    const object = record(entry.value), candidate = record(object.backstagePostRenderer);
    if (candidate.postId === link.id) {
      if (renderer) return null;
      renderer = candidate;
    }
    const children = Array.isArray(entry.value) ? entry.value : Object.values(object);
    if (pending.length + children.length > 50_000) return null;
    for (const child of children) if (child !== null && typeof child === 'object') pending.push({ value: child, depth: entry.depth + 1 });
  }
  if (!renderer || ['sponsorOnlyBadge', 'sponsorsOnlyBadge', 'membersOnly', 'isMembersOnly', 'isPrivate', 'isDeleted', 'isUnavailable']
    .some(key => Boolean(renderer![key]))) return null;
  const authorName = textRuns(renderer.authorText)?.trim();
  const channelId = record(record(renderer.authorEndpoint).browseEndpoint).browseId;
  if (!authorName || authorName.length > 256 || typeof channelId !== 'string' || !CHANNEL_ID.test(channelId)) return null;
  const publishedRuns = record(renderer.publishedTimeText).runs;
  const permalink = Array.isArray(publishedRuns) && publishedRuns.some(run => {
    const endpoint = record(record(record(run).navigationEndpoint).browseEndpoint);
    return endpoint.browseId === 'FEpost_detail' && endpoint.canonicalBaseUrl === `/post/${link.id}`;
  });
  if (!permalink) return null;
  const text = renderer.contentText === undefined ? '' : textRuns(renderer.contentText);
  if (text === null) return null;
  if (renderer.backstageAttachment !== undefined && (renderer.backstageAttachment === null ||
      typeof renderer.backstageAttachment !== 'object' || Array.isArray(renderer.backstageAttachment))) return null;
  const attachment = record(renderer.backstageAttachment), attachmentKeys = Object.keys(attachment);
  let images: string[] = [];
  if (attachmentKeys.length) {
    if (attachmentKeys.length !== 1) return null;
    if (attachmentKeys[0] === 'backstageImageRenderer') {
      const image = largestImage(record(attachment.backstageImageRenderer).image);
      if (!image) return null;
      images = [image];
    } else if (attachmentKeys[0] === 'postMultiImageRenderer') {
      const entries = record(attachment.postMultiImageRenderer).images;
      if (!Array.isArray(entries) || !entries.length || entries.length > MAX_IMAGES) return null;
      for (const entry of entries) {
        const image = largestImage(record(record(entry).backstageImageRenderer).image);
        if (!image) return null;
        images.push(image);
      }
      if (new Set(images).size !== images.length) return null;
    } else return null;
  }
  if (!text.trim() && !images.length) return null;
  return { ...link, author: { name: authorName, url: `https://www.youtube.com/channel/${channelId}` }, text, images };
}

export interface YouTubeCommunityLookupOptions {
  dns?: (hostname: string) => Promise<string[]>;
  connect?: (options: RequestOptions, signal: AbortSignal) => Promise<Response>;
  now?: () => number;
  timeoutMs?: number;
}

async function readHtml(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body || Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('community_body');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await regionalAbortable(reader.read(), signal);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_BYTES) throw new Error('community_body');
      chunks.push(next.value);
    }
    signal.throwIfAborted();
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

/** Cookie-free first-party GETs, pinned public DNS, no redirects, and bounded concurrency/cache. */
export function createYouTubeCommunityLookup(options: YouTubeCommunityLookupOptions = {}) {
  const dns = options.dns ?? (async (hostname: string) =>
    (await lookupDns(hostname, { all: true, family: 4 })).map(answer => answer.address));
  const connect = options.connect ?? connectHttps, now = options.now ?? Date.now;
  type Pending = { promise: Promise<YouTubeCommunityPost | null>; controller: AbortController; subscribers: number };
  const pending = new Map<string, Pending>();
  const cache = new Map<string, { value: YouTubeCommunityPost | null; expires: number }>();
  const timeout = Math.max(1, Math.min(10_000, options.timeoutMs ?? 5_000));
  let windowStart = now(), requests = 0;
  async function request(link: YouTubeCommunityLink, controller: AbortController): Promise<YouTubeCommunityPost | null> {
    const timer = setTimeout(() => controller.abort(), timeout);
    let response: Response | undefined;
    try {
      const addresses = await regionalAbortable(dns('www.youtube.com'), controller.signal);
      if (!addresses.length || addresses.length > 32 || !addresses.every(isPublicIpv4)) return null;
      const address = addresses[0];
      response = await regionalAbortable(connect({
        protocol: 'https:', hostname: 'www.youtube.com', servername: 'www.youtube.com', port: 443,
        method: 'GET', path: `/post/${link.id}`, family: 4, agent: false, rejectUnauthorized: true, maxHeaderSize: 8192,
        headers: { accept: 'text/html', 'accept-encoding': 'identity', 'accept-language': 'en-US,en;q=0.9',
          'user-agent': 'Mozilla/5.0 (compatible; Linky/1.0)' },
        lookup: (_hostname, lookupOptions, callback) => {
          if (lookupOptions.all) callback(null, [{ address, family: 4 }]);
          else callback(null, address, 4);
        },
      }, controller.signal), controller.signal, cancelRegionalResponse);
      if (response.status !== 200 || !/^text\/html(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') ||
          ![null, 'identity'].includes(response.headers.get('content-encoding'))) return null;
      return parseYouTubeCommunityHtml(await readHtml(response, controller.signal), link.url);
    } catch { return null; }
    finally { clearTimeout(timer); if (response) cancelRegionalResponse(response); }
  }
  async function wait(id: string, entry: Pending, signal?: AbortSignal): Promise<YouTubeCommunityPost | null> {
    entry.subscribers++;
    try { return structuredClone(await (signal ? regionalAbortable(entry.promise, signal) : entry.promise)); }
    catch { return null; }
    finally {
      entry.subscribers--;
      // One edited/deleted message must not cancel another message's shared lookup.
      if (!entry.subscribers && pending.get(id) === entry) {
        pending.delete(id);
        entry.controller.abort();
      }
    }
  }
  return async (source: string | YouTubeCommunityLink, signal?: AbortSignal): Promise<YouTubeCommunityPost | null> => {
    if (signal?.aborted) return null;
    const link = parseYouTubeCommunityUrl(typeof source === 'string' ? source : source.url);
    if (!link || (typeof source !== 'string' && source.id !== link.id) || !POST_ID.test(link.id)) return null;
    for (const [id, entry] of cache) if (entry.expires <= now()) cache.delete(id);
    const hit = cache.get(link.id);
    if (hit) return structuredClone(hit.value);
    const existing = pending.get(link.id);
    if (existing) return wait(link.id, existing, signal);
    if (now() - windowStart >= 60_000) { windowStart = now(); requests = 0; }
    if (pending.size >= 4 || requests >= 30) return null;
    requests++;
    const entry: Pending = { promise: Promise.resolve(null), controller: new AbortController(), subscribers: 0 };
    entry.promise = request(link, entry.controller).then(value => {
      if (!entry.controller.signal.aborted) {
        cache.set(link.id, { value, expires: now() + (value ? 60_000 : 15_000) });
        while (cache.size > 100) cache.delete(cache.keys().next().value!);
      }
      return value;
    }).finally(() => { if (pending.get(link.id) === entry) pending.delete(link.id); });
    pending.set(link.id, entry);
    return wait(link.id, entry, signal);
  };
}

function literalText(value: string, limit: number): string {
  const clean = value.replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g, ' ')
    .replace(/(?:https?:\/\/|www\.|\bdiscord\.gg\/|\bdiscord(?:app)?\.com\/invite\/)\S+/gi, '[link]')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const escaped = clean.replace(/[\\`*_{}\[\]()<>~|#+\-]/g, '\\$&').replace(/@/g, '@\u200b');
  return escaped.length <= limit ? escaped : escaped.slice(0, limit - 2).replace(/\\$/, '') + '…';
}

/** Full-width images in source order; shared URL groups gallery embeds on Discord. */
export function formatYouTubeCommunityPost(post: YouTubeCommunityPost): APIEmbed[] {
  const link = parseYouTubeCommunityUrl(post.url);
  const authorId = /^https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})$/.exec(post.author?.url ?? '');
  if (!link || link.id !== post.id || !authorId || typeof post.author.name !== 'string' || typeof post.text !== 'string' ||
      !Array.isArray(post.images) || post.images.length > MAX_IMAGES || post.images.some(url => imageUrl(url) !== url)) return [];
  const name = literalText(post.author.name, 200), description = literalText(post.text, 3500);
  if (!name || (!description && !post.images.length)) return [];
  const first: APIEmbed = { title: 'YouTube community post', url: link.url, color: 0xff0000,
    author: { name, url: post.author.url }, ...(description ? { description } : {}),
    ...(post.images.length ? { image: { url: post.images[0] } } : {}) };
  return [first, ...post.images.slice(1).map(url => ({ url: link.url, image: { url } }))];
}

export type YouTubeCommunityLookup = ReturnType<typeof createYouTubeCommunityLookup>;
export interface PreparedCommunityPost { source: string; embeds: APIEmbed[] }

/** Prepare every requested post or preserve the source; sequential requests respect the shared pool. */
export async function prepareYouTubeCommunityPosts(links: readonly YouTubeCommunityLink[], lookup: YouTubeCommunityLookup | undefined,
  signal?: AbortSignal): Promise<PreparedCommunityPost[] | null> {
  if (!links.length) return [];
  if (!lookup || links.length > 5 || signal?.aborted) return null;
  const prepared: PreparedCommunityPost[] = [];
  for (const link of links) {
    const post = await lookup(link, signal).catch(() => null);
    if (!post || signal?.aborted || post.id !== link.id || post.url !== link.url) return null;
    const embeds = formatYouTubeCommunityPost(post);
    if (!embeds.length) return null;
    prepared.push({ source: link.url, embeds });
  }
  return prepared;
}

/** Reserve one embed for each native source, never slice a gallery or truncate source coverage. */
export function communityEmbedBudget(embeds: readonly APIEmbed[], nativeCount = 0): boolean {
  const textLength = embeds.reduce((total, embed) => total + (embed.title?.length ?? 0) + (embed.description?.length ?? 0) +
    (embed.author?.name.length ?? 0) + (embed.footer?.text.length ?? 0) +
    (embed.fields ?? []).reduce((sum, field) => sum + field.name.length + field.value.length, 0), 0);
  return embeds.length + nativeCount <= 10 && textLength <= 6000;
}
