import { Events, ComponentType, type APIMessageTopLevelComponent, type Client, type Message } from 'discord.js';
import { mapLinks, visibleLink } from './LinkTokens';
import { parseEromeUrl } from './Erome';
import type { MediaAsset } from './MediaAssetStore';
import type { OriginalVideoMetadata } from './VideoAttachment';
import { setTimeout as delay } from 'node:timers/promises';

export type EromeMedia = MediaAsset & { url: string; videoCount: number; metadata: OriginalVideoMetadata };
export type EromeMediaPreparer = (source: string) => Promise<EromeMedia | null>;
export type EromeMediaBinding = (id: string, messageId: string) => Promise<boolean>;

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
  controls: APIMessageTopLevelComponent[] = []): APIMessageTopLevelComponent[] {
  const notice = media.videoCount > 1 ? `First of ${media.videoCount} videos` : 'Video preview';
  return [{ type: ComponentType.TextDisplay, content: `${content}\n-# ${notice} · Original video and audio. Album kept.` },
    { type: ComponentType.MediaGallery, items: [{ media: { url: media.url }, description: 'Original video from the linked album.' }] },
    ...controls];
}

type MediaMessage = { id?: unknown; channel_id?: unknown; author?: { id?: unknown }; components?: unknown };
function matchesMedia(value: MediaMessage, media: EromeMedia): boolean {
  if (!Array.isArray(value.components)) return false;
  return value.components.some(component => component?.type === ComponentType.MediaGallery &&
    Array.isArray(component.items) && component.items.some((item: { media?: {
      url?: string; content_type?: string; proxy_url?: string; width?: number; height?: number;
    } }) => {
      const video = item?.media, expected = media.metadata;
      return video?.url === media.url && video.content_type === 'video/mp4' && Boolean(video.proxy_url) &&
        (video.width === expected.width && video.height === expected.height ||
          video.width === expected.height && video.height === expected.width);
    }));
}

/** Subscribe before publishing, using the bot's existing connection; only the returned message ID can pass. */
export function watchEromeMedia(client: Client, channelId: string, media: EromeMedia) {
  const ready = new Set<string>();
  let closed = false;
  let target: string | undefined, resolve: ((value: boolean) => void) | undefined;
  const listener = (packet: { t?: string; d?: MediaMessage }) => {
    const value = packet.d;
    if (!['MESSAGE_CREATE', 'MESSAGE_UPDATE'].includes(packet.t ?? '') || !value ||
      value.channel_id !== channelId || typeof value.id !== 'string' ||
      value.author?.id && value.author.id !== client.user?.id || !matchesMedia(value, media)) return;
    ready.add(value.id);
    if (ready.size > 16) ready.delete(ready.values().next().value!);
    if (target === value.id) resolve?.(true);
  };
  client.on(Events.Raw, listener);
  const identity = (message: Message) => message.channelId === channelId && message.author.id === client.user?.id;
  const inspect = (message: Message) => !closed && message.id === target && identity(message) &&
    matchesMedia({ components: message.components.map(component => component.toJSON()) }, media);
  return {
    async verify(message: Message): Promise<boolean> {
      if (closed || !identity(message)) return false;
      target = message.id;
      if (ready.has(target) || inspect(message)) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const observed = await new Promise<boolean>(done => {
          resolve = done; timer = setTimeout(() => done(false), 6000);
          if (ready.has(message.id)) done(true);
        });
        if (closed) return false;
        if (observed) return true;
        try { return inspect(await message.fetch(true)); } catch { return false; }
      } finally { clearTimeout(timer); resolve = undefined; }
    },
    close() { closed = true; client.off(Events.Raw, listener); resolve?.(false); resolve = undefined; ready.clear(); },
  };
}
