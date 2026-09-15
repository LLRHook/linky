import { setTimeout as delay } from 'node:timers/promises';
import type { AttachmentBuilder, Message } from 'discord.js';
import { parseEromeUrl } from './Erome';
import { mapLinks, visibleLink } from './LinkTokens';

export type EromePreparer = (source: string) => Promise<{ file: AttachmentBuilder; videoCount: number } | null>;

export function findEromeLinks(content: string): string[] {
  const links = new Set<string>();
  mapLinks(content, (url, position) => {
    const album = visibleLink(content, position) && parseEromeUrl(url);
    if (album) links.add(album.url);
    return url;
  });
  return [...links];
}

/** Threads inherit their parent's age restriction; DMs and unknown channels fail closed. */
export function isAgeRestricted(channel: { isThread(): boolean; nsfw?: boolean; parent?: unknown } | null): boolean {
  if (!channel) return false;
  const target = channel.isThread() ? channel.parent : channel;
  return Boolean(target && typeof target === 'object' && 'nsfw' in target && target.nsfw === true);
}

export function eromeNotice(videoCount: number): string {
  return `\n-# ${videoCount > 1 ? `First of ${videoCount} videos` : 'Video preview'} · Original album kept. Video may be compressed to fit Discord.`;
}

/** Confirm Discord accepted the prepared MP4 as video, not a thumbnail or unrelated attachment. */
export async function verifyEromeAttachment(message: Pick<Message, 'attachments' | 'fetch'>, file: AttachmentBuilder,
  sleep: (ms: number) => Promise<unknown> = delay): Promise<boolean> {
  if (!Buffer.isBuffer(file.attachment) || !file.name) return false;
  const size = file.attachment.length;
  let current = message;
  for (const wait of [0, 1000, 2000, 3000]) {
    if (wait) {
      await sleep(wait);
      try { current = await message.fetch(true); } catch { return false; }
    }
    if (current.attachments.some(attachment => attachment.name === file.name && attachment.size === size &&
      attachment.contentType === 'video/mp4' && (attachment.width ?? 0) > 0 && (attachment.height ?? 0) > 0)) return true;
  }
  return false;
}
