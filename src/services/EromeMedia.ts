import { ComponentType, type APIMessageTopLevelComponent, type Client, type Message } from 'discord.js';
import { watchMessageMedia, type MediaMessage } from './MediaWatch';
import { mapLinks, visibleLink } from './LinkTokens';
import { parseEromeUrl } from './Erome';
import type { MediaAsset } from './MediaAssetStore';
import type { OriginalVideoMetadata, OriginalImageMetadata } from './VideoAttachment';
import type { DeliveryContext } from './DeliveryContext';
import type { EromeSelection } from './EromeAlbum';
import { setTimeout as delay } from 'node:timers/promises';

export type EromeItemInfo = { kind?: 'video' | 'image'; itemIndex?: number; itemFingerprint?: string;
  itemCount?: number; itemFingerprints?: string[]; truncated?: boolean };
export type EromeMedia = MediaAsset & EromeItemInfo & { url: string; videoCount: number;
  metadata: OriginalVideoMetadata | OriginalImageMetadata; reservation?: string };
export type EromeMediaPreparer = (source: string, options?: { context?: DeliveryContext; selection?: EromeSelection }) => Promise<EromeMedia | null>;
export type EromeMediaBinding = (id: string, messageId: string, reservation?: string) => Promise<boolean>;

export function messageHasEromeMedia(message: Message, url: string): boolean {
  return message.components.some(component => {
    const value = component.toJSON();
    return value.type === ComponentType.MediaGallery && value.items.some(item => item.media.url === url);
  });
}

/** A timed-out POST can still have succeeded. Read once after a grace period; never submit it again here. */
export async function sendEromeMedia(send: () => Promise<Message>, reconcile: () => Promise<Message | null>): Promise<Message> {
  try { return await send(); }
  catch (error) {
    await delay(10_000);
    try { const existing = await reconcile(); if (existing) return existing; } catch { /* Preserve the original uncertainty. */ }
    throw error;
  }
}

/** Other platforms keep the existing publisher until their previews have a V2 representation. */
export function onlyEromeLinks(content: string): boolean {
  let found = false, other = false;
  mapLinks(content, (url, position) => {
    if (visibleLink(content, position)) {
      if (parseEromeUrl(url)) found = true;
      else other = true;
    }
    return url;
  });
  return found && !other;
}

export function eromeMediaComponents(media: EromeMedia, content: string,
  controls: APIMessageTopLevelComponent[] = [], items: readonly EromeMedia[] = [media]): APIMessageTopLevelComponent[] {
  const selected = items.slice(0, 10);
  const notice = media.itemCount ? `${selected.length} of ${media.itemCount}${media.truncated ? '+' : ''} items` :
    media.videoCount > 1 ? `First of ${media.videoCount} videos` : 'Video preview';
  return [{ type: ComponentType.TextDisplay, content: `${content}\n-# ${notice} · Original media. Full album: Original post.` },
    { type: ComponentType.MediaGallery, items: selected.map(item => ({ media: { url: item.url },
      description: `Original ${item.kind === 'image' ? 'image' : 'video'} from the linked album.` })) },
    ...controls];
}

// Discord can round a displayed dimension by one pixel (for example, 480×852 to 479×852).
function matchesDimension(actual: unknown, expected: number): boolean {
  return typeof actual === 'number' && Number.isSafeInteger(actual) && actual >= 2 && Math.abs(actual - expected) <= 1;
}

function matchesMedia(value: MediaMessage, media: EromeMedia): boolean {
  if (!Array.isArray(value.components)) return false;
  return value.components.some(component => component?.type === ComponentType.MediaGallery &&
    Array.isArray(component.items) && component.items.some((item: { media?: {
      url?: string; content_type?: string; proxy_url?: string; width?: number; height?: number;
    } }) => {
      const video = item?.media, expected = media.metadata;
      return video?.url === media.url && video.content_type === (media.mimeType ?? 'video/mp4') && Boolean(video.proxy_url) &&
        (matchesDimension(video.width, expected.width) && matchesDimension(video.height, expected.height) ||
          matchesDimension(video.width, expected.height) && matchesDimension(video.height, expected.width));
    }));
}

/** Subscribe before publishing, using the bot's existing connection; only the returned message ID can pass. */
export function watchEromeMedia(client: Client, channelId: string, media: EromeMedia) {
  return watchMessageMedia(client, channelId, value => matchesMedia(value, media));
}
