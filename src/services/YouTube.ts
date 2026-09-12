import { mapLinks, visibleLink } from './LinkTokens';
import type { APIEmbed, APIEmbedField } from 'discord.js';

export interface YouTubeLink { id: string; url: string }
export interface YouTubeStatistics {
  viewCount?: string;
  likeCount?: string;
  commentCount?: string;
  topComment?: { author: string; text: string };
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const COUNT = /^\d{1,20}$/;
const LIMIT = 5;
const CACHE_TTL = 5 * 60_000;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};

function timestamp(value: string | null): number | undefined {
  if (!value) return undefined;
  const units = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  const seconds = /^\d+$/.test(value) ? Number(value) : units
    ? Number(units[1] || 0) * 3600 + Number(units[2] || 0) * 60 + Number(units[3] || 0)
    : NaN;
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

/** Keep native YouTube playback, accepting only exact video URL shapes. */
export function parseYouTubeUrl(value: string): YouTubeLink | null {
  // Check the raw authority too: URL would otherwise normalize an explicit :443 away.
  if (!/^https:\/\/(?:(?:www\.|m\.)?youtube\.com|youtu\.be)(?=\/)/i.test(value) ||
      /[\\\s\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    const rawPath = value.replace(/^https:\/\/[^/]+/i, '').split(/[?#]/, 1)[0];
    if (url.username || url.password || url.port || url.pathname !== rawPath) return null;
    const id = url.hostname === 'youtu.be' ? /^\/([\w-]{11})\/?$/.exec(url.pathname)?.[1]
      : url.pathname === '/watch' && url.searchParams.getAll('v').length === 1
        ? url.searchParams.get('v')
        : /^\/(?:shorts|live|embed)\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
    if (!id || !VIDEO_ID.test(id)) return null;
    const seconds = ['t', 'start'].map(key => url.searchParams.getAll(key).length === 1
      ? timestamp(url.searchParams.get(key)) : undefined).find(value => value !== undefined);
    return { id, url: `https://www.youtube.com/watch?v=${id}${seconds === undefined ? '' : `&t=${seconds}`}` };
  } catch { return null; }
}

export function findYouTubeLinks(content: string): YouTubeLink[] {
  const links = new Map<string, YouTubeLink>();
  mapLinks(content, (url, position) => {
    const link = links.size < LIMIT && visibleLink(content, position) && parseYouTubeUrl(url);
    if (link && !links.has(link.id)) links.set(link.id, link);
    return url;
  });
  return [...links.values()];
}

interface LookupOptions { fetch?: typeof fetch; now?: () => number; timeoutMs?: number }
type Cached = { value: YouTubeStatistics | null; expiresAt: number };
type Pending = { promise: Promise<YouTubeStatistics | null>; resolve: (value: YouTubeStatistics | null) => void };

/** Public API only; bounded batches, coalescing, cache and backoff keep failure optional. */
export function createYouTubeLookup(apiKey: string, options: LookupOptions = {}) {
  const fetchJson = options.fetch ?? fetch, now = options.now ?? Date.now;
  const cache = new Map<string, Cached>(), pending = new Map<string, Pending>(), queued = new Set<string>();
  let running = false, failures = 0, blockedUntil = 0, windowStart = now(), requests = 0;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  function expire(): void {
    clearTimeout(expiryTimer);
    for (const [id, entry] of cache) if (entry.expiresAt <= now()) cache.delete(id);
    if (cache.size) {
      const earliest = Math.min(...[...cache.values()].map(entry => entry.expiresAt));
      expiryTimer = setTimeout(expire, Math.max(1, earliest - now()));
      expiryTimer.unref();
    }
  }

  async function request(parameters: Record<string, string>, comment = false): Promise<Record<string, unknown> | null> {
    if (now() < blockedUntil) return null;
    if (now() - windowStart >= 60_000) { windowStart = now(); requests = 0; }
    if (requests >= 30) { blockedUntil = windowStart + 60_000; return null; }
    requests++;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const operation = (async () => {
        const response = await fetchJson(`https://www.googleapis.com/youtube/v3/${comment ? 'commentThreads' : 'videos'}?${new URLSearchParams(parameters)}`, {
          headers: { 'X-Goog-Api-Key': apiKey }, signal: controller.signal, redirect: 'error',
        });
        const text = await response.text();
        if (text.length > 128_000) throw new Error('Oversized YouTube response');
        const body = record(JSON.parse(text));
        if (!response.ok) {
          const errors = record(body.error).errors;
          const quota = Array.isArray(errors) && errors.some(error =>
            /quota|dailyLimit|keyInvalid|accessNotConfigured/i.test(String(record(error).reason)));
          if (comment && [403, 404].includes(response.status) && !quota) return null;
          if (quota || [400, 401, 403, 429].includes(response.status)) blockedUntil = now() + 60 * 60_000;
          throw new Error('YouTube lookup unavailable');
        }
        return body;
      })();
      const result = await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('YouTube lookup timed out')); }, options.timeoutMs ?? 5_000);
      })]);
      failures = 0;
      return result;
    } catch {
      blockedUntil = Math.max(blockedUntil, now() + Math.min(60_000, 1000 * 2 ** Math.min(failures++, 6)));
      return null;
    } finally { clearTimeout(timer); }
  }

  async function flush(): Promise<void> {
    if (running) return;
    running = true;
    try {
      while (queued.size) {
        const ids = [...queued].slice(0, LIMIT);
        ids.forEach(id => queued.delete(id));
        const body = await request({ part: 'statistics,status', id: ids.join(','),
          fields: 'items(id,statistics(viewCount,likeCount,commentCount),status(privacyStatus,embeddable))' });
        const values = new Map<string, YouTubeStatistics>();
        if (Array.isArray(body?.items)) {
          for (const value of body.items) {
            const item = record(value), status = record(item.status), statistics = record(item.statistics);
            if (typeof item.id !== 'string' || !ids.includes(item.id) || values.has(item.id) || status.privacyStatus !== 'public' || status.embeddable === false) continue;
            const stats: YouTubeStatistics = {};
            for (const key of ['viewCount', 'likeCount', 'commentCount'] as const) {
              if (typeof statistics[key] === 'string' && COUNT.test(statistics[key])) stats[key] = statistics[key];
            }
            const comments = await request({ part: 'snippet', videoId: item.id, order: 'relevance', maxResults: '1', textFormat: 'plainText',
              fields: 'items(snippet(videoId,topLevelComment(snippet(textDisplay,authorDisplayName))))' }, true);
            const first = Array.isArray(comments?.items) ? record(comments.items[0]) : {};
            const thread = record(first.snippet), top = record(record(thread.topLevelComment).snippet);
            if (thread.videoId === item.id && typeof top.textDisplay === 'string' && top.textDisplay.trim() && typeof top.authorDisplayName === 'string') {
              stats.topComment = { text: top.textDisplay.slice(0, 2000), author: top.authorDisplayName.slice(0, 200) };
            }
            values.set(item.id, stats);
          }
        }
        for (const id of ids) {
          const value = values.get(id) ?? null;
          if (Array.isArray(body?.items)) {
            cache.delete(id);
            cache.set(id, { value, expiresAt: now() + CACHE_TTL });
            while (cache.size > 1000) cache.delete(cache.keys().next().value!);
          }
          pending.get(id)?.resolve(value);
          pending.delete(id);
        }
        expire();
      }
    } finally { running = false; }
  }

  return async (videoIds: readonly string[]): Promise<Map<string, YouTubeStatistics>> => {
    expire();
    const ids = [...new Set(videoIds.filter(id => VIDEO_ID.test(id)))].slice(0, LIMIT);
    if (!apiKey.trim()) return new Map();
    const results = await Promise.all(ids.map(async id => {
      const hit = cache.get(id);
      if (hit) return [id, hit.value] as const;
      let waiting = pending.get(id);
      if (!waiting && pending.size < 1000 && now() >= blockedUntil) {
        let resolve!: Pending['resolve'];
        waiting = { promise: new Promise(done => { resolve = done; }), resolve };
        pending.set(id, waiting);
        queued.add(id);
        queueMicrotask(() => { void flush(); });
      }
      return [id, waiting ? await waiting.promise : null] as const;
    }));
    return new Map(results.filter((entry): entry is readonly [string, YouTubeStatistics] => entry[1] !== null));
  };
}

function commentText(value: string, limit: number): string {
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g, ' ')
    .replace(/(?:https?:\/\/|www\.|\bdiscord\.gg\/|\bdiscord(?:app)?\.com\/invite\/)\S+/gi, '[link]')
    .replace(/\s+/g, ' ').trim();
  const shortened = clean.length > limit ? clean.slice(0, limit - 1).trimEnd() + '…' : clean;
  return shortened.replace(/[\\`*_{}\[\]()<>~|#+\-]/g, '\\$&').replace(/@/g, '@\u200b');
}

export function formatYouTubeStatistics(stats: YouTubeStatistics, videoUrl: string): APIEmbed | null {
  const fields: APIEmbedField[] = (['viewCount', 'likeCount', 'commentCount'] as const).flatMap((key, index) =>
    stats[key] !== undefined && COUNT.test(stats[key])
      ? [{ name: ['Views', 'Likes', 'Comments'][index],
        value: `**${BigInt(stats[key]).toLocaleString('en-US')}**`, inline: true }] : []);
  const comment = stats.topComment && commentText(stats.topComment.text, 240);
  if (!fields.length && !comment) return null;
  const url = parseYouTubeUrl(videoUrl)?.url;
  if (!url) return null;
  if (comment) fields.push({ name: 'Top comment',
    value: `${comment}\n\nBy ${commentText(stats.topComment!.author, 50) || 'YouTube user'}`, inline: false });
  return { title: 'YouTube stats', url, color: 0xff0000, fields, footer: { text: 'Snapshot when shared' } };
}
