import { createHash } from 'node:crypto';

export const MAX_ALBUM_ITEMS = 100;
export const MAX_ALBUM_HTML_BYTES = 1024 * 1024;
export type EromeItem = { kind: 'video' | 'image'; source: string; fingerprint: string; index: number };
export type EromeAlbum = { album: string; items: EromeItem[]; videoCount: number; truncated: boolean };
export type EromeSelection = { fingerprint: string } | { index: number };

/** Canonical public album URLs only. Query/fragment tracking never selects another album. */
export function parseEromeUrl(raw: string): { id: string; url: string } | null {
  if (raw.length > 2048 || /[\\\s\u0000-\u001f\u007f]/.test(raw)) return null;
  const parts = /^https:\/\/([^/?#]+)(\/[^?#]*)(?:\?[^#]*)?(?:#.*)?$/i.exec(raw);
  const id = parts && /^(?:www\.)?erome\.com$/i.test(parts[1]) && /^\/a\/([A-Za-z0-9_]{1,64})\/?$/.exec(parts[2])?.[1];
  return id ? { id, url: `https://www.erome.com/a/${id}` } : null;
}

export function isEromeImageUrl(source: string): boolean {
  return source.length <= 2048 && /^https:\/\/s\d{1,4}\.erome\.com\/(?:[A-Za-z0-9_-]{1,128}\/){0,5}[A-Za-z0-9_-]{1,128}\.(?:jpg|jpeg|png)$/.test(source);
}

function attribute(tag: string, name: string): string | undefined {
  const matches = [...tag.matchAll(new RegExp(`\\s${name}\\s*=\\s*(["'])([^"']{0,2048})\\1`, 'gi'))];
  return matches.length === 1 ? matches[0][2] : undefined;
}

/** Extract only album media containers, never avatars, suggestions, scripts, posters or ads. */
export function parseEromeItems(html: string): { items: EromeItem[]; truncated: boolean } {
  if (Buffer.byteLength(html) > MAX_ALBUM_HTML_BYTES) return { items: [], truncated: false };
  const clean = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const sources = new Map<string, 'video' | 'image'>();
  const stack: boolean[] = [];
  let inside = 0, inVideo = false, selectedVideo = false, truncated = false;
  const add = (source: string, kind: 'video' | 'image') => {
    if (sources.has(source)) return;
    if (sources.size >= MAX_ALBUM_ITEMS) { truncated = true; return; }
    sources.set(source, kind);
  };
  for (const match of clean.matchAll(/<\/?(?:div|video|source|img)\b[^>]{0,4096}>/gi)) {
    const tag = match[0], name = /^<\/?([a-z]+)/i.exec(tag)![1].toLowerCase();
    const closing = tag.startsWith('</');
    if (name === 'div') {
      if (closing) { if (stack.pop()) inside--; }
      else {
        if (stack.length >= 128) return { items: [], truncated: false };
        const group = (attribute(tag, 'class') ?? '').split(/\s+/).includes('media-group');
        stack.push(group); if (group) inside++;
      }
    } else if (name === 'video') {
      inVideo = inside > 0 && !closing; selectedVideo = false;
    } else if (inside && !closing) {
      const source = attribute(tag, 'src');
      if (!source) continue;
      if (name === 'source' && inVideo && !selectedVideo && /^https:\/\/v\d{1,4}\.erome\.com\/(?:[A-Za-z0-9_-]{1,128}\/){0,5}[A-Za-z0-9_-]{1,128}\.mp4$/.test(source)) {
        add(source, 'video'); selectedVideo = true;
      }
      if (name === 'img' && (attribute(tag, 'class') ?? '').split(/\s+/).includes('img-front') && isEromeImageUrl(source)) add(source, 'image');
    }
  }
  return { items: [...sources].map(([source, kind], index) => ({ source, kind, index,
    fingerprint: createHash('sha256').update(`${kind}\n${source}`).digest('hex') })), truncated };
}

export async function boundedEromeBody(response: Response, limit: number, signal?: AbortSignal): Promise<Buffer | null> {
  const length = response.headers.get('content-length');
  if (!response.ok || response.redirected || (length !== null && (!/^\d+$/.test(length) || Number(length) > limit))) {
    await response.body?.cancel(); return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0, complete = false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > limit) return null;
      chunks.push(value);
    }
    complete = true;
    return total && (length === null || total === Number(length)) ? Buffer.concat(chunks, total) : null;
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function resolveEromeItems(raw: string, request: typeof fetch = fetch, signal?: AbortSignal): Promise<EromeAlbum | null> {
  const album = parseEromeUrl(raw);
  if (!album || signal?.aborted) return null;
  const deadline = AbortSignal.timeout(10_000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const response = await request(album.url, { redirect: 'error', signal: combined,
      headers: { Accept: 'text/html', 'User-Agent': 'Linky/1.0 (+https://linkybot.dev)' } });
    if (!/^text\/html(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel(); return null;
    }
    const bytes = await boundedEromeBody(response, MAX_ALBUM_HTML_BYTES, combined);
    if (!bytes) return null;
    const html = bytes.toString('utf8');
    if (/Please wait a few moments|cf-challenge|Just a moment/i.test(html)) return null;
    const parsed = parseEromeItems(html);
    return parsed.items.length ? { album: album.url, ...parsed, videoCount: parsed.items.filter(item => item.kind === 'video').length } : null;
  } catch { return null; }
}

export function selectEromeItem(album: EromeAlbum, selection?: EromeSelection): EromeItem | null {
  if (!selection) return album.items.find(item => item.kind === 'video') ?? album.items[0] ?? null;
  if ('fingerprint' in selection) return /^[a-f0-9]{64}$/.test(selection.fingerprint)
    ? album.items.find(item => item.fingerprint === selection.fingerprint) ?? null : null;
  return Number.isInteger(selection.index) && selection.index >= 0 ? album.items[selection.index] ?? null : null;
}
