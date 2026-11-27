import { parseSocialUrl } from './SocialProviders';
import { readBoundedJson } from './BoundedJson';

/** One validated photo, video or GIF address with the dimensions the provider reported. */
export interface TweetMedia { type: 'photo' | 'video' | 'gif'; url: string; width?: number; height?: number }

export interface TweetTranslation {
  text: string;
  /**
   * The source language of translated text. Null for an empty post, which can still carry translated quotes and media,
   * and for a post read as written without translation.
   */
  language: string | null;
  url?: string;
  quote?: TweetTranslation;
  author: { name: string; url: string; icon_url?: string; handle?: string };
  photos: string[];
  /** Every photo, video and GIF in source order; absent from hand-built values. */
  media?: TweetMedia[];
  replies?: number;
  hasMedia: boolean;
  hasVideo: boolean;
}

const dimension = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 16_384 ? value : undefined;

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};

function languageCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.toLowerCase();
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(code) &&
    !['und', 'zxx', 'mul'].includes(code.split('-')[0]) ? code : null;
}

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

const escapeText = (text: string): string => text.replace(/[\\`*_{}\[\]()<>~|#+\-]/g, '\\$&');

/** Keep post prose literal and shorten displayed URLs without changing their targets. */
export function formatProse(text: string): string {
  let result = '';
  let cursor = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>`]+/gi)) {
    let candidate = match[0].replace(/[.,!?;:]+$/, '');
    for (const [opening, closing] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      while (candidate.endsWith(closing) && candidate.split(closing).length > candidate.split(opening).length) {
        candidate = candidate.slice(0, -1);
      }
    }
    result += escapeText(text.slice(cursor, match.index));
    const target = httpsUrl(candidate);
    if (target) {
      const url = new URL(target);
      const label = url.hostname + (url.pathname === '/' ? '' : url.pathname);
      const shortLabel = label.length > 60 ? `${label.slice(0, 59)}…` : label;
      result += `[${shortLabel.replace(/[\\\[\]]/g, '\\$&')}](<${target}>)`;
    } else {
      // An unsupported or malformed URL remains readable without creating a preview.
      result += `\`${candidate}\``;
    }
    result += escapeText(match[0].slice(candidate.length));
    cursor = match.index + match[0].length;
  }
  return result + escapeText(text.slice(cursor));
}

/** Keep media links tied to a source status, never an arbitrary fixer authority. */
function statusUrl(status: Record<string, unknown>, fallbackId?: string): string | undefined {
  const href = httpsUrl(status.url);
  if (href) {
    const source = parseSocialUrl(href);
    if (source?.platform === 'x') return `https://x.com${source.path.replace(/\/$/, '')}`;
  }
  const id = typeof status.id === 'string' ? status.id : fallbackId;
  return id && /^\d{1,20}$/.test(id) ? `https://x.com/i/status/${id}` : undefined;
}

/**
 * Parse at most three posts, preserving each quoted post's own text and media. `translate` requires every non-English
 * part to carry its English translation; otherwise each part keeps the words it was written in, without a label.
 */
function parseStatus(value: unknown, fallbackId?: string, depth = 0, translate = true): TweetTranslation | null {
  if (depth >= 3) return null;
  const status = record(value);
  const mediaPayload = record(status.media);
  const language = languageCode(status.lang)?.split('-')[0];
  const empty = typeof status.text === 'string' && !status.text.trim();
  if (status.type !== 'status' || (translate && !language && !empty) || status.poll ||
      mediaPayload.broadcast || mediaPayload.external) return null;

  const translation = record(status.translation);
  const prose = empty ? '' : !translate || language === 'en' ? status.text : translation.text;
  if (translate && !empty && language !== 'en' && (
    languageCode(translation.source_lang)?.split('-')[0] !== language ||
    languageCode(translation.target_lang)?.split('-')[0] !== 'en'
  )) return null;
  if (typeof prose !== 'string' || (!empty && !prose.trim()) || prose.length > 100_000) return null;
  const text = formatProse(prose.trim());
  if (text.length > 100_000) return null;

  const url = statusUrl(status, fallbackId);
  const author = record(status.author);
  const authorUrl = httpsUrl(author.url);
  if (!url || typeof author.name !== 'string' || !author.name.trim() || !authorUrl) return null;
  const quote = status.quote == null ? undefined : parseStatus(status.quote, undefined, depth + 1, translate);
  if (quote === null) return null;

  const all = mediaPayload.all;
  const media = (Array.isArray(all) ? all : []).map(record)
    .filter((item) => httpsUrl(item.url) && ['photo', 'video', 'gif'].includes(String(item.type)));
  if (empty && !media.length && !quote) return null;
  const photos = [...new Set(media.filter((item) => item.type === 'photo')
    .map((item) => httpsUrl(item.url)!))].slice(0, 4);
  const icon = httpsUrl(author.avatar_url);
  const handle = typeof author.screen_name === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(author.screen_name)
    ? author.screen_name : undefined;
  return {
    text, url,
    ...(Number.isSafeInteger(status.replies) && Number(status.replies) >= 0 ? { replies: Number(status.replies) } : {}),
    language: translate && !empty && language ? languageNames.of(language) ?? language : null,
    author: {
      name: author.name.trim().slice(0, 256),
      url: authorUrl,
      ...(icon ? { icon_url: icon } : {}),
      ...(handle ? { handle } : {}),
    },
    photos,
    media: media.slice(0, 10).map((item) => {
      const width = dimension(item.width), height = dimension(item.height);
      return { type: item.type as TweetMedia['type'], url: httpsUrl(item.url)!,
        ...(width && height ? { width, height } : {}) };
    }),
    hasMedia: media.length > 0,
    hasVideo: media.some((item) => item.type === 'video' || item.type === 'gif'),
    ...(quote ? { quote } : {}),
  };
}

/** One status as written, and with English translations when they were requested and some part needs one. */
export interface TweetStatus { post: TweetTranslation | null; translation: TweetTranslation | null }

/** Look up one public status by ID for a one-post block; `translate` asks for English translations as well. */
export type TweetLookup = (statusId: string, options: { translate: boolean }) => Promise<TweetTranslation | null>;

const NO_STATUS: TweetStatus = { post: null, translation: null };

/**
 * Fetch one public status. `post` is what a one-post block shows: the translation when one was requested and a part is
 * not English, otherwise the words as written. Any upstream failure leaves reposting available.
 */
export async function fetchTweetStatus(
  statusId: string,
  { translate }: { translate: boolean },
  fetchJson: typeof fetch = fetch
): Promise<TweetStatus> {
  if (!/^\d{1,20}$/.test(statusId)) return NO_STATUS;
  try {
    const signal = AbortSignal.timeout(5_000);
    // Only the public status ID is sent; the language parameter is added only when a translation is wanted.
    const response = await fetchJson(`https://api.fxtwitter.com/2/status/${statusId}${translate ? '?lang=en' : ''}`, {
      signal, redirect: 'error',
    });
    if (!response.ok) { void response.body?.cancel().catch(() => {}); return NO_STATUS; }
    const json = record(await readBoundedJson(response, 1024 * 1024, signal));
    if (json.code !== 200) return NO_STATUS;
    const translated = translate ? parseStatus(json.status, statusId) : null;
    let foreign = false;
    for (let post = translated; post && !foreign; post = post.quote ?? null) {
      foreign = Boolean(post.language && post.language !== 'English');
    }
    return foreign ? { post: translated, translation: translated }
      : { post: parseStatus(json.status, statusId, 0, false), translation: null };
  } catch {
    return NO_STATUS;
  }
}

/** Fetch only usable English translations; any upstream failure leaves reposting available. */
export async function fetchTweetTranslation(
  statusId: string,
  fetchJson: typeof fetch = fetch
): Promise<TweetTranslation | null> {
  return (await fetchTweetStatus(statusId, { translate: true }, fetchJson)).translation;
}

const LOOKUP_TIMEOUT = 20_000, CACHE_TTL = 5 * 60_000, FAILURE_TTL = 30_000;
const CACHE_LIMIT = 100, PENDING_LIMIT = 8, CACHED_TEXT_LIMIT = 50_000;

const textLength = (post: TweetTranslation | null): number => post ? post.text.length + textLength(post.quote ?? null) : 0;

/**
 * Status lookup shared by translation and one-post blocks, with bounded memory and duplicate suppression: one
 * request per status and mode for five minutes (30 s after a failure), at most 100 entries and eight requests in
 * flight. A status holding more than 50,000 characters of text is returned but not kept.
 */
export function createTweetLookup(fetchJson: typeof fetch = fetch):
  (statusId: string, options: { translate: boolean }) => Promise<TweetStatus> {
  const cache = new Map<string, { value: TweetStatus; expiresAt: number }>();
  const pending = new Map<string, Promise<TweetStatus>>();
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  function expire(): void {
    clearTimeout(expiryTimer);
    for (const [key, entry] of cache) if (entry.expiresAt <= Date.now()) cache.delete(key);
    if (cache.size) {
      expiryTimer = setTimeout(expire, Math.max(1, Math.min(...[...cache.values()].map(entry => entry.expiresAt)) - Date.now()));
      expiryTimer.unref();
    }
  }

  return async (statusId, { translate }) => {
    if (!/^\d{1,20}$/.test(statusId)) return NO_STATUS;
    expire();
    const key = `${statusId}:${translate ? 'en' : 'source'}`;
    const hit = cache.get(key);
    let result = hit?.value;
    if (!hit) {
      let waiting = pending.get(key);
      if (!waiting) {
        if (pending.size >= PENDING_LIMIT) return NO_STATUS;
        waiting = fetchTweetStatus(statusId, { translate }, fetchJson).catch(() => NO_STATUS);
        pending.set(key, waiting);
        void waiting.then(value => {
          pending.delete(key);
          const size = textLength(value.post) + (value.translation === value.post ? 0 : textLength(value.translation));
          if (size > CACHED_TEXT_LIMIT) return;
          cache.set(key, { value, expiresAt: Date.now() + (value.post ? CACHE_TTL : FAILURE_TTL) });
          while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
          expire();
        });
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        result = await Promise.race([waiting, new Promise<TweetStatus>(resolve => {
          timer = setTimeout(() => resolve(NO_STATUS), LOOKUP_TIMEOUT);
        })]);
      } finally { clearTimeout(timer); }
    }
    // Each caller receives its own copy; the cached value stays as fetched.
    return structuredClone(result ?? NO_STATUS);
  };
}
