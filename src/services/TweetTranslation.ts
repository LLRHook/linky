export interface TweetTranslation {
  text: string;
  language: string;
  url?: string;
  quote?: TweetTranslation;
  author: { name: string; url: string; icon_url?: string };
  photos: string[];
  hasMedia: boolean;
  hasVideo: boolean;
}

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

/** Keep translated prose literal and shorten displayed URLs without changing their targets. */
function formatTranslation(text: string): string {
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
    const url = new URL(href);
    if (['x.com', 'twitter.com'].includes(url.hostname) && !url.port &&
        /^\/(?:\w+\/status|i\/web\/status)\/\d{1,20}\/?$/.test(url.pathname)) {
      return `https://x.com${url.pathname.replace(/\/$/, '')}`;
    }
  }
  const id = typeof status.id === 'string' ? status.id : fallbackId;
  return id && /^\d{1,20}$/.test(id) ? `https://x.com/i/status/${id}` : undefined;
}

/** Parse at most three posts, preserving each quoted post's own text and media. */
function parseStatus(value: unknown, fallbackId?: string, depth = 0): TweetTranslation | null {
  if (depth >= 3) return null;
  const status = record(value);
  const mediaPayload = record(status.media);
  const language = languageCode(status.lang)?.split('-')[0];
  if (status.type !== 'status' || !language || status.poll ||
      mediaPayload.broadcast || mediaPayload.external) return null;

  const translation = record(status.translation);
  const prose = language === 'en' ? status.text : translation.text;
  if (language !== 'en' && (
    languageCode(translation.source_lang)?.split('-')[0] !== language ||
    languageCode(translation.target_lang)?.split('-')[0] !== 'en'
  )) return null;
  if (typeof prose !== 'string' || !prose.trim() || prose.length > 100_000) return null;
  const text = formatTranslation(prose.trim());
  if (text.length > 100_000) return null;

  const url = statusUrl(status, fallbackId);
  const author = record(status.author);
  const authorUrl = httpsUrl(author.url);
  if (!url || typeof author.name !== 'string' || !author.name.trim() || !authorUrl) return null;
  const quote = status.quote == null ? undefined : parseStatus(status.quote, undefined, depth + 1);
  if (quote === null) return null;

  const all = mediaPayload.all;
  const media = (Array.isArray(all) ? all : []).map(record)
    .filter((item) => httpsUrl(item.url) && ['photo', 'video', 'gif'].includes(String(item.type)));
  const photos = [...new Set(media.filter((item) => item.type === 'photo')
    .map((item) => httpsUrl(item.url)!))].slice(0, 4);
  const icon = httpsUrl(author.avatar_url);
  return {
    text, url,
    language: languageNames.of(language) ?? language,
    author: {
      name: author.name.trim().slice(0, 256),
      url: authorUrl,
      ...(icon ? { icon_url: icon } : {}),
    },
    photos,
    hasMedia: media.length > 0,
    hasVideo: media.some((item) => item.type === 'video' || item.type === 'gif'),
    ...(quote ? { quote } : {}),
  };
}

/** Fetch only usable English translations; any upstream failure leaves reposting available. */
export async function fetchTweetTranslation(
  statusId: string,
  fetchJson: typeof fetch = fetch
): Promise<TweetTranslation | null> {
  if (!/^\d{1,20}$/.test(statusId)) return null;
  try {
    const response = await fetchJson(`https://api.fxtwitter.com/2/status/${statusId}?lang=en`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const json = record(await response.json());
    const result = json.code === 200 ? parseStatus(json.status, statusId) : null;
    for (let post = result; post; post = post.quote ?? null) {
      if (post.language !== 'English') return result;
    }
    return null;
  } catch {
    return null;
  }
}
