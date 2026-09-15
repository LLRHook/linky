import { AttachmentBuilder } from 'discord.js';
import { createVideoAttachment, MAX_ATTACHMENT_BYTES, MAX_VIDEO_BYTES } from './VideoAttachment';

const MAX_HTML_BYTES = 1024 * 1024;
let busy = false;

/** Only complete public album URLs are accepted; profiles, redirects and nested URLs are not followed. */
export function parseEromeUrl(raw: string): { id: string; url: string } | null {
  if (raw.length > 2048 || /[\\\s\u0000-\u001f\u007f]/.test(raw)) return null;
  const parts = /^https:\/\/([^/?#]+)(\/[^?#]*)(?:\?[^#]*)?(?:#.*)?$/i.exec(raw);
  const id = parts && /^(?:www\.)?erome\.com$/i.test(parts[1]) && /^\/a\/([A-Za-z0-9_]{1,64})\/?$/.exec(parts[2])?.[1];
  return id ? { id, url: `https://www.erome.com/a/${id}` } : null;
}

function videoSources(html: string): string[] {
  const sources = new Set<string>();
  // Only source elements carry the video payload; never inspect page text, titles or unrelated links.
  const markup = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  for (const video of markup.matchAll(/<video\b[^>]{0,4096}>([\s\S]*?)<\/video\s*>/gi)) {
    for (const tag of video[1].matchAll(/<source\b[^>]{0,4096}>/gi)) {
      const source = /\ssrc\s*=\s*(["'])([^"']{1,2048})\1/i.exec(tag[0])?.[2];
      if (!source || !/^https:\/\/v\d{1,4}\.erome\.com\/(?:[A-Za-z0-9_-]{1,128}\/){0,5}[A-Za-z0-9_-]{1,128}\.mp4$/i.test(source)) continue;
      sources.add(source);
      break; // Alternate sources within a video element are qualities of the same video.
    }
  }
  return [...sources];
}

async function boundedBody(response: Response, limit: number): Promise<Buffer | null> {
  const length = response.headers.get('content-length');
  if (!response.ok || (length !== null && (!/^\d+$/.test(length) || Number(length) > limit))) {
    await response.body?.cancel(); return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    return total ? Buffer.concat(chunks, total) : null;
  } finally { reader.releaseLock(); }
}

/** Prepare the first distinct video, without cookies, redirects, persistent media or an unbounded work queue. */
export function createEromePreparer({ fetch: request = fetch, convert = createVideoAttachment() }: {
  fetch?: typeof fetch; convert?: (input: Buffer) => Promise<Buffer | null>;
} = {}): (source: string) => Promise<{ file: AttachmentBuilder; videoCount: number } | null> {
  return async raw => {
    const source = parseEromeUrl(raw);
    if (!source || busy) return null;
    busy = true;
    try {
      const response = await request(source.url, { redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { Accept: 'text/html', 'User-Agent': 'Linky/1.0 (+https://linkybot.dev)' } });
      if (!/^text\/html(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel(); return null;
      }
      const html = await boundedBody(response, MAX_HTML_BYTES);
      if (!html) return null;
      const text = html.toString('utf8');
      if (/Please wait a few moments|cf-challenge|Just a moment/i.test(text)) return null;
      const videos = videoSources(text);
      if (!videos.length) return null;
      const media = await request(videos[0], { redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { Accept: 'video/mp4', Referer: source.url, 'User-Agent': 'Linky/1.0 (+https://linkybot.dev)' } });
      if (!/^video\/mp4(?:;|$)/i.test(media.headers.get('content-type') ?? '')) {
        await media.body?.cancel(); return null;
      }
      const input = await boundedBody(media, MAX_VIDEO_BYTES);
      const output = input && await convert(input);
      return output?.length && output.length <= MAX_ATTACHMENT_BYTES ? { file: new AttachmentBuilder(output, { name: 'linky-video.mp4',
        description: videos.length > 1 ? `First video of ${videos.length} in the linked album.` : 'Video from the linked album.' }),
      videoCount: videos.length } : null;
    } catch { return null; }
    finally { busy = false; }
  };
}
