import { INSTAGRAM_PROVIDER } from './SocialProviders';

/** One item of the post on the provider's signed offload route, with the dimensions it reported. */
export interface InstagramMedia { type: 'photo' | 'video'; url: string; width?: number; height?: number }

export interface InstagramTranslation {
  sourceUrl: string;
  shortcode: string;
  username: string;
  text: string;
  languages: string[];
  mediaOnlyUrl: string;
  /** Provider hints only (`GraphImage` or `GraphVideo` per listed item); they do not establish working media. */
  mediaTypes: string[];
  /** Every item in post order; absent when any item lacks a provider offload address for this post. */
  media?: InstagramMedia[];
}

type Translate = (text: string) => Promise<{ text: string; languages: string[] } | null>;
type Caption = Omit<InstagramTranslation, 'sourceUrl'>;
const MAX_BODY_BYTES = 64 * 1024, MAX_TEXT_BYTES = 16 * 1024;
const FETCH_TIMEOUT = 5_000, LOOKUP_TIMEOUT = 20_000, CACHE_TTL = 5 * 60_000;
const CACHE_LIMIT = 100, PENDING_LIMIT = 8;

/** Accept complete public source links, without normalizing a different authority or post path. */
export function parseInstagramUrl(value: string): { sourceUrl: string; shortcode: string } | null {
  if (value.length > 2048 || /[\\\s\u0000-\u001f\u007f]/.test(value) ||
      !/^https:\/\/(?:www\.|m\.|mobile\.)?instagram\.com(?=\/)/i.test(value)) return null;
  try {
    const url = new URL(value), rawPath = value.replace(/^https:\/\/[^/]+/i, '').split(/[?#]/, 1)[0];
    if (url.username || url.password || url.port || url.pathname !== rawPath) return null;
    const post = /^\/(p|reel|reels|tv)\/([A-Za-z0-9_-]{1,64})\/?$/.exec(url.pathname);
    return post ? { sourceUrl: `https://www.instagram.com/${post[1]}/${post[2]}/`, shortcode: post[2] } : null;
  } catch { return null; }
}

const dimension = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 16_384 ? value : undefined;

/** The provider's own HTTPS offload address for an item of this post, without credentials or a port. */
function offloadUrl(value: unknown, shortcode: string): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (INSTAGRAM_PROVIDER.hosts as readonly string[]).includes(url.hostname) &&
      !url.port && !url.username && !url.password && url.pathname.startsWith(`/offload/${shortcode}/`) ? url.href : undefined;
  } catch { return undefined; }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * Plain caption from OGInstagram's Note `content`: an optional bold statistics paragraph, then one caption
 * paragraph with `<br>` line breaks and `<a>` links. Tags are removed before entities are decoded, so escaped
 * markup in a caption stays literal text.
 */
function captionText(content: string): string {
  return content.replace(/^<p><b>[^<]*<\/b><\/p>/, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*<p>/gi, '\n\n').replace(/<[^>]*>/g, '')
    .replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(amp|lt|gt|quot|apos));/gi, (entity: string, decimal?: string, hex?: string, name?: string) => {
      if (name) return ENTITIES[name.toLowerCase()];
      const code = decimal ? Number(decimal) : parseInt(hex!, 16);
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : entity;
    });
}

/** OGInstagram serves the post as an ActivityStreams Note at its card URL when asked for that media type. */
async function metadata(sourceUrl: string, shortcode: string, fetchJson: typeof fetch): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const operation = (async () => {
      // The provider has no /tv/ route; it serves any shortcode, including a legacy IGTV one, under /p/.
      const response = await fetchJson(`${INSTAGRAM_PROVIDER.origin}/${/\/reels?\//.test(sourceUrl) ? 'reel' : 'p'}/${shortcode}/`, {
        signal: controller.signal, redirect: 'error', credentials: 'omit',
        headers: { Accept: 'application/activity+json', 'User-Agent': 'LinkyBot/1.0 (+https://linkybot.dev)' },
      });
      const declaredLength = Number(response.headers.get('content-length'));
      if (!response.ok || !response.body || declaredLength > MAX_BODY_BYTES) {
        await response.body?.cancel(); return null;
      }
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > MAX_BODY_BYTES) { await reader.cancel(); return null; }
        chunks.push(chunk.value);
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
    })();
    return await Promise.race([operation, new Promise<null>(resolve => {
      timer = setTimeout(() => {
        controller.abort(); void reader?.cancel().catch(() => {}); resolve(null);
      }, FETCH_TIMEOUT);
    })]);
  } catch { return null; }
  finally { clearTimeout(timer); reader?.releaseLock(); }
}

/** Optional caption enrichment with bounded memory, duplicate suppression and no provider-error logging. */
export function createInstagramLookup(translate: Translate, fetchJson: typeof fetch = fetch) {
  const cache = new Map<string, { value: Caption | null; expiresAt: number }>();
  const pending = new Map<string, Promise<Caption | null>>();
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  function expire(): void {
    clearTimeout(expiryTimer);
    for (const [key, entry] of cache) if (entry.expiresAt <= Date.now()) cache.delete(key);
    if (cache.size) {
      expiryTimer = setTimeout(expire, Math.max(1, Math.min(...[...cache.values()].map(entry => entry.expiresAt)) - Date.now()));
      expiryTimer.unref();
    }
  }

  async function request(sourceUrl: string, shortcode: string): Promise<Caption | null> {
    try {
      const value = await metadata(sourceUrl, shortcode, fetchJson);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const data = value as Record<string, unknown>;
      // The Note must be this post, written by an account on the provider's own origin.
      const actor = `${INSTAGRAM_PROVIDER.origin}/`;
      const username = typeof data.attributedTo === 'string' && data.attributedTo.startsWith(actor) ? data.attributedTo.slice(actor.length) : '';
      if (data.type !== 'Note' || (data.id !== `${actor}p/${shortcode}` && data.id !== `${actor}reel/${shortcode}`) ||
          !/^[A-Za-z0-9._]{1,30}$/.test(username) || typeof data.content !== 'string' ||
          !Array.isArray(data.attachment) || !data.attachment.length || data.attachment.length > 20) return null;
      const caption = captionText(data.content).trim();
      if (!caption || Buffer.byteLength(caption) > MAX_TEXT_BYTES) return null;
      const mediaTypes: string[] = [], media: InstagramMedia[] = [];
      let addressed = true;
      for (const item of data.attachment as unknown[]) {
        const fields = (item && typeof item === 'object' ? item : {}) as { mediaType?: unknown; url?: unknown; width?: unknown; height?: unknown };
        const type = fields.mediaType;
        if (typeof type !== 'string' || !/^(?:image|video)\/[a-z0-9.+-]{1,40}$/i.test(type)) return null;
        const video = /^video\//i.test(type);
        mediaTypes.push(video ? 'GraphVideo' : 'GraphImage');
        const url = offloadUrl(fields.url, shortcode), width = dimension(fields.width), height = dimension(fields.height);
        if (url) media.push({ type: video ? 'video' : 'photo', url, ...(width && height ? { width, height } : {}) });
        else addressed = false;
      }
      // Send the full caption, including English introductions and later non-English paragraphs.
      const translated = await translate(caption);
      if (!translated || typeof translated.text !== 'string' || !translated.text.trim() ||
          Buffer.byteLength(translated.text) > MAX_TEXT_BYTES || !Array.isArray(translated.languages) || translated.languages.length > 32 ||
          translated.languages.some(language => typeof language !== 'string' || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(language))) return null;
      const languages = [...new Set(translated.languages.map(language => language.toLowerCase()))]
        .filter(language => !['en', 'und', 'zxx', 'mul'].includes(language.split('-')[0]));
      if (!languages.length || languages.length > 8) return null;
      return { shortcode, username, text: translated.text.trim(), languages,
        mediaOnlyUrl: `${INSTAGRAM_PROVIDER.captionFreeOrigin}/p/${shortcode}/`, mediaTypes, ...(addressed ? { media } : {}) };
    } catch { return null; }
  }

  return async (source: string): Promise<InstagramTranslation | null> => {
    const parsed = parseInstagramUrl(source);
    if (!parsed) return null;
    expire();
    // Reel hints can select different provider metadata; retain that distinction in the cache.
    const key = `${parsed.shortcode}:${/\/(?:reels?|tv)\//.test(parsed.sourceUrl) ? 'video' : 'post'}`;
    const hit = cache.get(key);
    let result = hit?.value;
    if (!hit) {
      let waiting = pending.get(key);
      if (!waiting) {
        if (pending.size >= PENDING_LIMIT) return null;
        waiting = request(parsed.sourceUrl, parsed.shortcode);
        pending.set(key, waiting);
        void waiting.then(value => {
          pending.delete(key);
          cache.set(key, { value, expiresAt: Date.now() + (value ? CACHE_TTL : 30_000) });
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
    return result ? { ...result, sourceUrl: parsed.sourceUrl, languages: [...result.languages], mediaTypes: [...result.mediaTypes],
      ...(result.media ? { media: result.media.map(item => ({ ...item })) } : {}) } : null;
  };
}
