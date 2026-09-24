import { lookup as lookupDns } from 'node:dns/promises';
import type { RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import type { APIEmbed } from 'discord.js';
import { mapLinks, visibleLink } from './LinkTokens';
import { cancelRegionalResponse, connectHttps, isPublicIpv4, regionalAbortable } from './RegionalHttp';
import { SOCIAL_PROVIDERS } from './SocialProviders';

export interface ArticlePreview {
  source: string;
  url: string;
  title: string;
  publisher: string;
  description?: string;
  image?: string;
  publishedAt?: string;
}
export interface ArticleLookupOptions {
  resolve4?: (hostname: string) => Promise<string[]>;
  connect?: (options: RequestOptions, signal: AbortSignal) => Promise<Response>;
  now?: () => number;
  timeoutMs?: number;
}

const MAX_BYTES = 512 * 1024;
// Discord's own domains; its invites, messages and gifts render first-party cards.
const DISCORD_HOSTS = ['discord.com', 'discordapp.com', 'discord.gg', 'discordapp.net', 'discord.media', 'discord.new',
  'discord.gift', 'discord.gifts', 'discord.co', 'discord.dev', 'discordstatus.com', 'discordcdn.com', 'discordsays.com', 'dis.gd'];
// Hosts Discord unfurls with a native GIF, video or audio player; an authored card would replace that player.
const NATIVE_MEDIA_HOSTS = ['tenor.com', 'giphy.com', 'gph.is', 'klipy.com', 'imgur.com', 'gfycat.com', 'streamable.com',
  'vimeo.com', 'medal.tv', 'spotify.com', 'spotify.link', 'soundcloud.com', 'music.apple.com'];
const EXCLUDED = new Set([
  'x.com', 'twitter.com', 't.co', 'twimg.com', 'instagram.com', 'cdninstagram.com', 'facebook.com', 'fb.com', 'fb.watch',
  'tiktok.com', 'tiktokv.com', 'bsky.app', 'bsky.social', 'reddit.com', 'redd.it', 'redditmedia.com',
  'twitch.tv', 'twitchcdn.net', 'youtube.com', 'youtu.be', 'youtube-nocookie.com', 'ytimg.com',
  'erome.com', 'erome.net', ...DISCORD_HOSTS, ...NATIVE_MEDIA_HOSTS,
  'kkclip.com', 'kkclips.com', 'ddinstagram.com', 'vxtiktok.com', 'fxtiktok.com', 'rxddit.com',
  ...SOCIAL_PROVIDERS.flatMap(provider => [...provider.hosts]),
]);
const LOCAL_SUFFIX = /\.(?:localhost|local|internal|lan|home|test|invalid|example|onion|arpa)$/i;
const SERVICE_PATH = /^\/(?:api|admin|login|logout|signin|signout|oauth|auth|account|wp-admin|wp-json|\.well-known)(?:\/|$)|^\/xmlrpc\.php$/i;

/** Inspect raw authority before URL normalizes credentials, ports, IPs or dot segments. */
function publicUrl(raw: string): URL | null {
  if (!raw || raw.length > 2048 || /[\\\s\u0000-\u001f\u007f]/.test(raw)) return null;
  const parts = /^https:\/\/([^/?#]+)([^?#]*)(?:\?[^#]*)?(?:#.*)?$/i.exec(raw);
  if (!parts) return null;
  try {
    const url = new URL(raw), host = url.hostname;
    if (parts[1].toLowerCase() !== host || (parts[2] || '/') !== url.pathname || isIP(host) ||
        host.length > 253 || LOCAL_SUFFIX.test(host) ||
        !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host)) return null;
    return url;
  } catch { return null; }
}

/** Existing social/provider domains never bypass their platform settings through articles. */
export function parseArticleUrl(raw: string): string | null {
  if (raw.length > 500) return null;
  const url = publicUrl(raw);
  if (!url || [...EXCLUDED].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`)) ||
      SERVICE_PATH.test(url.pathname)) return null;
  url.hash = '';
  return url.href;
}

export function findArticleLinks(content: string, limit = 3): string[] {
  if (/(?:^|\s)!nolinky(?=\s|$)/i.test(content)) return [];
  const links = new Set<string>();
  const maximum = Number.isFinite(limit) ? Math.max(1, Math.min(4, Math.floor(limit))) : 3;
  mapLinks(content, (raw, position) => {
    const link = links.size < maximum && visibleLink(content, position) && parseArticleUrl(raw);
    if (link) links.add(link);
    return raw;
  });
  return [...links];
}

function entities(value: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®' };
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, entity: string) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? whole;
    const point = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : ' ';
  });
}

function metadataText(value: unknown, maximum = 4000): string {
  return typeof value === 'string' && value.length <= maximum ? entities(value)
    .replace(/<[^>]{0,500}>/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g, ' ')
    .replace(/\s+/g, ' ').trim() : '';
}

function attributes(tag: string): Record<string, string> {
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  let cursor = tag.search(/\s/);
  if (cursor < 0) return values;
  while (cursor < tag.length) {
    while (cursor < tag.length && /[\s/]/.test(tag[cursor])) cursor++;
    const start = cursor;
    while (cursor < tag.length && !/[\s=<>"'`/]/.test(tag[cursor])) cursor++;
    if (start === cursor) { cursor++; continue; }
    const key = tag.slice(start, cursor).toLowerCase();
    while (cursor < tag.length && /\s/.test(tag[cursor])) cursor++;
    if (tag[cursor] !== '=') continue;
    cursor++;
    while (cursor < tag.length && /\s/.test(tag[cursor])) cursor++;
    const quote = tag[cursor] === '"' || tag[cursor] === "'" ? tag[cursor++] : undefined;
    const valueStart = cursor;
    while (cursor < tag.length && (quote ? tag[cursor] !== quote : !/[\s"'=<>`]/.test(tag[cursor]))) cursor++;
    const value = tag.slice(valueStart, cursor);
    if (!(key in values) && key.length <= 128 && value.length <= 8192) values[key] = entities(value);
    if (quote || cursor === valueStart) cursor++;
  }
  return values;
}

type HeadMetadata = { meta: Map<string, string>; canonical?: string; title?: string; json: unknown[] };
/** A small inert head scanner: comments, scripts and templates cannot masquerade as meta tags. */
function headMetadata(html: string): HeadMetadata {
  const result: HeadMetadata = { meta: new Map(), json: [] };
  const tagName = /\/?([a-z][a-z\d:-]*)/iy;
  let inHead = false, count = 0, cursor = 0;
  while (cursor < html.length && ++count <= 1000) {
    const start = html.indexOf('<', cursor);
    if (start < 0) break;
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4);
      if (end < 0) break;
      cursor = end + 3;
      continue;
    }
    tagName.lastIndex = start + 1;
    const match = tagName.exec(html);
    if (!match) { cursor = start + 1; continue; }
    if (!/[\s/>]/.test(html[tagName.lastIndex] ?? '') || tagName.lastIndex - start > 128) break;
    cursor = tagName.lastIndex;
    let quote = '';
    // A malicious unterminated tag is not searched again from each later '<'.
    // Bound each tag as well as the whole head, and consume every character once.
    while (cursor < html.length && cursor - start <= 16_384) {
      const char = html[cursor++];
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (cursor - start > 16_384 || html[cursor - 1] !== '>' || quote) break;
    const name = match[1].toLowerCase(), closing = html[start + 1] === '/';
    if (name === 'body' || name === 'head' && closing) break;
    if (name === 'head') { inHead = true; continue; }
    if (!inHead || closing) continue;
    const attrs = attributes(html.slice(start, cursor));
    if (['script', 'style', 'title', 'template', 'noscript'].includes(name)) {
      const end = new RegExp(`</${name}\\s*>`, 'gi');
      end.lastIndex = cursor;
      const ending = end.exec(html);
      if (!ending) break;
      const content = html.slice(cursor, ending.index);
      if (name === 'title' && !result.title) result.title = metadataText(content);
      if (name === 'script' && attrs.type?.toLowerCase() === 'application/ld+json' && content.length <= 128 * 1024 && result.json.length < 8) {
        try { result.json.push(JSON.parse(content) as unknown); } catch { /* Malformed metadata is not an article signal. */ }
      }
      cursor = end.lastIndex;
    } else if (name === 'meta') {
      const key = (attrs.property ?? attrs.name ?? '').toLowerCase();
      if (key && attrs.content !== undefined && !result.meta.has(key) && result.meta.size < 128) result.meta.set(key, attrs.content);
    } else if (name === 'link' && attrs.rel?.toLowerCase().split(/\s+/).includes('canonical') && !result.canonical) result.canonical = attrs.href;
  }
  return result;
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function sameOriginUrl(value: unknown, current: URL): string | null {
  if (typeof value !== 'string' || value.length > 2048 || /[\\\s\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const resolved = parseArticleUrl(resolveUrl(value, current));
    return resolved && new URL(resolved).origin === current.origin ? resolved : null;
  } catch { return null; }
}

function resolveUrl(value: string, current: URL): string {
  // Do not let URL erase a forbidden explicit :443 on absolute metadata/redirect URLs.
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) return value;
  if (value.startsWith('//')) return `https:${value}`;
  return new URL(value, current).href;
}

function structuredArticle(data: unknown[], current: URL, canonical: string): Record<string, unknown> | null {
  const normalize = (url: string) => { const value = new URL(url); return value.origin + value.pathname.replace(/\/$/, '') + value.search; };
  let visited = 0;
  const pending = data.map(value => ({ value, schema: false, depth: 0 }));
  while (pending.length) {
    if (++visited > 500) return null;
    const { value, schema, depth } = pending.shift()!;
    if (depth > 8) continue;
    if (Array.isArray(value)) {
      if (value.length > 100) continue;
      for (const item of value) pending.push({ value: item, schema, depth: depth + 1 });
      continue;
    }
    const item = object(value), context = item['@context'];
    const validContext = schema || typeof context === 'string' && /^https?:\/\/schema\.org\/?$/.test(context);
    if (!validContext) continue;
    if (Array.isArray(item['@graph'])) pending.push({ value: item['@graph'], schema: true, depth: depth + 1 });
    const types = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
    if (!types.some(type => ['Article', 'NewsArticle', 'BlogPosting'].includes(String(type))) || !metadataText(item.headline)) continue;
    const identity = item.url ?? object(item.mainEntityOfPage)['@id'] ?? item.mainEntityOfPage ?? item['@id'];
    const identityUrl = sameOriginUrl(identity, current);
    if (!identityUrl || ![normalize(current.href), normalize(canonical)].includes(normalize(identityUrl))) continue;
    return item;
  }
  return null;
}

function imageUrl(value: unknown, current: URL): string | null {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\\\s\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = publicUrl(resolveUrl(value, current));
    if (!url || SERVICE_PATH.test(url.pathname) || !/\.(?:jpe?g|png|webp|gif|avif)(?:$|\/)/i.test(url.pathname)) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

function parseMetadata(html: string, source: string, current: URL): ArticlePreview | null {
  const head = headMetadata(html), get = (key: string) => head.meta.get(key);
  const canonical = sameOriginUrl(head.canonical, current) ?? sameOriginUrl(get('og:url'), current) ?? current.href;
  const type = get('og:type')?.toLowerCase().trim();
  // Discord already plays media pages natively; an Article JSON-LD (as on Tenor) must not replace that player.
  if (/^(?:video|music)(?:\.|$)/.test(type ?? '') || get('twitter:card')?.toLowerCase().trim() === 'player' ||
      ['og:video', 'og:video:url', 'og:video:secure_url', 'twitter:player:stream'].some(key => get(key))) return null;
  const article = structuredArticle(head.json, current, canonical);
  if (type !== 'article' && !article) return null;
  const title = metadataText(get('og:title')) || metadataText(article?.headline) || head.title;
  if (!title) return null;
  const publisher = metadataText(get('og:site_name'), 1000) || metadataText(object(article?.publisher).name, 1000) || current.hostname;
  const description = metadataText(get('og:description')) || metadataText(article?.description) || metadataText(get('description'));
  const jsonImage = Array.isArray(article?.image) ? article.image[0] : article?.image;
  const image = imageUrl(get('og:image:secure_url') ?? get('og:image') ?? object(jsonImage).url ?? jsonImage, current);
  const date = get('article:published_time') ?? article?.datePublished;
  const publishedAt = typeof date === 'string' && /^\d{4}-\d\d-\d\d(?:T[\d:.+-]+Z?)?$/.test(date) && Number.isFinite(Date.parse(date))
    ? new Date(date).toISOString() : undefined;
  return { source, url: canonical, title, publisher, ...(description ? { description } : {}), ...(image ? { image } : {}),
    ...(publishedAt ? { publishedAt } : {}) };
}

async function readHead(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) throw new Error('article_body');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  let html = '', bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await regionalAbortable(reader.read(), signal);
      if (part.done) { html += decoder.decode(); break; }
      bytes += part.value.byteLength;
      if (bytes > MAX_BYTES) throw new Error('article_body');
      html += decoder.decode(part.value, { stream: true });
      // Stop reading after metadata. An incidental boundary inside raw text may
      // conservatively skip a page; it can never include article-body prose.
      const end = /<\/head\s*>|<body\b/i.exec(html);
      if (end) { html = html.slice(0, end.index + end[0].length); break; }
    }
    signal.throwIfAborted();
    return html;
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

/** Public, cookie-free metadata only; each redirect has a newly validated, pinned address. */
export function createArticleLookup(options: ArticleLookupOptions = {}) {
  const dns = options.resolve4 ?? (async (hostname: string) =>
    (await lookupDns(hostname, { all: true, family: 4 })).map(answer => answer.address));
  const connect = options.connect ?? connectHttps, now = options.now ?? Date.now;
  const timeout = Math.max(1, Math.min(5000, options.timeoutMs ?? 5000));
  type Pending = { promise: Promise<ArticlePreview | null>; controller: AbortController; subscribers: number };
  const pending = new Map<string, Pending>();
  const cache = new Map<string, { value: ArticlePreview | null; expires: number }>();
  let windowStart = now(), requests = 0;
  async function publicAddresses(hostname: string, signal: AbortSignal): Promise<string[]> {
    const addresses = await regionalAbortable(dns(hostname), signal);
    if (!addresses.length || addresses.length > 32 || !addresses.every(isPublicIpv4)) throw new Error('article_dns');
    signal.throwIfAborted();
    return addresses;
  }
  async function request(source: string, controller: AbortController): Promise<ArticlePreview | null> {
    const { signal } = controller, timer = setTimeout(() => controller.abort(), timeout), seen = new Set<string>();
    let current = new URL(source);
    try {
      for (let hop = 0; hop <= 3; hop++) {
        if (seen.has(current.href)) return null;
        seen.add(current.href);
        const [address] = await publicAddresses(current.hostname, signal);
        const response = await regionalAbortable(connect({
          protocol: 'https:', hostname: current.hostname, servername: current.hostname, port: 443,
          method: 'GET', path: current.pathname + current.search, family: 4, agent: false, rejectUnauthorized: true, maxHeaderSize: 8192,
          headers: { accept: 'text/html,application/xhtml+xml;q=0.9', 'accept-encoding': 'identity',
            'user-agent': 'Mozilla/5.0 (compatible; Linky/1.0; +https://linkybot.dev/)' },
          lookup: (_hostname, lookupOptions, callback) => {
            if (lookupOptions.all) callback(null, [{ address, family: 4 }]);
            else callback(null, address, 4);
          },
        }, signal), signal, cancelRegionalResponse);
        try {
          signal.throwIfAborted();
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            if (!location || /[\\\s\u0000-\u001f\u007f]/.test(location)) return null;
            const next = parseArticleUrl(resolveUrl(location, current));
            if (!next) return null;
            current = new URL(next);
            continue;
          }
          if (response.status !== 200 || !/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') ||
              ![null, 'identity'].includes(response.headers.get('content-encoding')?.toLowerCase() ?? null)) return null;
          const article = parseMetadata(await readHead(response, signal), source, current);
          if (article?.image) {
            try { await publicAddresses(new URL(article.image).hostname, signal); }
            catch { delete article.image; }
          }
          return signal.aborted ? null : article;
        } finally { cancelRegionalResponse(response); }
      }
      return null;
    } catch { return null; }
    finally { clearTimeout(timer); }
  }
  async function wait(source: string, entry: Pending, signal?: AbortSignal): Promise<ArticlePreview | null> {
    entry.subscribers++;
    try { return structuredClone(await (signal ? regionalAbortable(entry.promise, signal) : entry.promise)); }
    catch { return null; }
    finally {
      entry.subscribers--;
      if (!entry.subscribers && pending.get(source) === entry) {
        pending.delete(source);
        entry.controller.abort();
      }
    }
  }
  return async (raw: string, signal?: AbortSignal): Promise<ArticlePreview | null> => {
    const source = parseArticleUrl(raw);
    if (!source || signal?.aborted) return null;
    for (const [key, entry] of cache) if (entry.expires <= now()) cache.delete(key);
    const hit = cache.get(source);
    if (hit) return structuredClone(hit.value);
    const existing = pending.get(source);
    if (existing) return wait(source, existing, signal);
    if (now() - windowStart >= 60_000) { windowStart = now(); requests = 0; }
    if (pending.size >= 4 || requests >= 30) return null;
    requests++;
    const entry: Pending = { promise: Promise.resolve(null), controller: new AbortController(), subscribers: 0 };
    entry.promise = request(source, entry.controller).then(value => {
      if (!entry.controller.signal.aborted) {
        cache.set(source, { value, expires: now() + (value ? 300_000 : 15_000) });
        while (cache.size > 100) cache.delete(cache.keys().next().value!);
      }
      return value;
    }).finally(() => { if (pending.get(source) === entry) pending.delete(source); });
    pending.set(source, entry);
    return wait(source, entry, signal);
  };
}

function literal(value: string, limit: number): string {
  const escaped = metadataText(value)
    .replace(/(?:https?:\/\/|www\.|\bdiscord\.gg\/)\S+/gi, '[link]')
    .replace(/[\\`*_{}\[\]()<>~|#+\-]/g, '\\$&').replace(/@/g, '@\u200b');
  return escaped.length <= limit ? escaped : escaped.slice(0, limit - 1).replace(/\\$/, '') + '…';
}

/** Publisher-provided metadata, explicitly attributed, with no generated claims. */
export function formatArticlePreview(article: ArticlePreview): APIEmbed[] {
  const source = parseArticleUrl(article.source), url = parseArticleUrl(article.url);
  if (!source || !url || typeof article.title !== 'string' || typeof article.publisher !== 'string') return [];
  const title = literal(article.title, 256), publisher = literal(article.publisher, 180);
  if (!title || !publisher) return [];
  const description = typeof article.description === 'string' ? literal(article.description, 300) : '';
  const image = article.image && imageUrl(article.image, new URL(url));
  const date = article.publishedAt && Number.isFinite(Date.parse(article.publishedAt)) ? new Date(article.publishedAt).toISOString() : undefined;
  return [{ title, url, author: { name: `Publisher: ${publisher}`, url: new URL(url).origin },
    footer: { text: `${new URL(url).hostname} · Article metadata` }, ...(description ? { description } : {}),
    ...(image ? { image: { url: image } } : {}), ...(date ? { timestamp: date } : {}) }];
}

export type ArticleLookup = ReturnType<typeof createArticleLookup>;
