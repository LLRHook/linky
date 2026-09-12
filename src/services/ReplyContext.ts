import { MessageFlags, type Message } from 'discord.js';
import { mapLinks } from './LinkTokens';
import type { RepostRecord } from './RepostRegistry';

const LOOKUP_TIMEOUT_MS = 1_500;
const MAX_EXCERPT_LENGTH = 160;
const DISCORD_ID = /^[1-9]\d{16,19}$/;
const UNAVAILABLE = 'Original message unavailable.';
const REPOST_CREDIT = /^> \*\*Shared by <@([1-9]\d{16,19})>\*\*( \(reply(?: to [^\r\n]+)?\))?\r?\n/;

export interface ReplyContext {
  authorId?: string;
  excerpt: string;
}

/** Keep quoted content on one line, without revealing spoilers or unfurling links. */
function excerptText(content: string): string {
  let visible = '', cursor = 0, spoiler = false;
  for (const match of content.matchAll(/\|\|/g)) {
    if ((content.slice(0, match.index).match(/\\*$/)?.[0].length ?? 0) % 2) continue;
    if (!spoiler) visible += content.slice(cursor, match.index) + '[spoiler]';
    spoiler = !spoiler;
    cursor = match.index + 2;
  }
  if (!spoiler) visible += content.slice(cursor);
  return mapLinks(visible, () => '[link]')
    .replace(/\bwww\.[^\s<>]+/gi, '[link]')
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

export function formatReplyExcerpt(excerpt: string): string {
  const text = excerptText(excerpt) || UNAVAILABLE;
  const characters = Array.from(text);
  const short = characters.length > MAX_EXCERPT_LENGTH
    ? characters.slice(0, MAX_EXCERPT_LENGTH - 1).join('').trimEnd() + '\u2026' : text;
  // Escape every marker, including unmatched runs that a Markdown parser might
  // otherwise combine with the surrounding italic delimiters.
  return `-# *${short.replace(/[\\`*_~|]/g, '\\$&')}*`;
}

function parentExcerpt(parent: Message, credit: RegExpExecArray | null): string {
  let content = parent.content ?? '';
  if (credit) {
    content = content.slice(credit[0].length);
    // Only the new reply layout generates this line; plain repost bodies may
    // legitimately start with subtext written by the person sharing the link.
    if (/^ \(reply(?: to <@[1-9]\d{16,19}>)?\)$/.test(credit[2] ?? '')) {
      content = content.replace(/^-# \*[^\r\n]*\*\r?\n/, '');
    }
    content = content.replace(/^> /gm, '');
  }
  const text = excerptText(content);
  const linksOnly = text.includes('[link]') && /^[\s<>()\[\].,!?:;]*$/.test(text.replaceAll('[link]', ''));
  if (text && !linksOnly) return text;
  // Use only metadata already displayed on this message, never another lookup.
  const embed = !parent.flags?.has(MessageFlags.SuppressEmbeds) &&
    parent.embeds?.find(embed => embed.description?.trim() || embed.title?.trim());
  const preview = excerptText(embed ? embed.description?.trim() || embed.title?.trim() || '' : '');
  return preview || (text ? 'Shared a link.' : parent.attachments?.size ? 'Shared an attachment.' : UNAVAILABLE);
}

/** Resolve the original sharer and a bounded excerpt from the referenced message. */
export async function findReplyContext(message: Message,
  findRepost?: (id: string) => RepostRecord | undefined): Promise<ReplyContext | undefined> {
  const { messageId, channelId = message.channelId, guildId = message.guildId } = message.reference ?? {};
  if (!messageId) return;
  const botId = message.client?.user?.id;
  const record = findRepost?.(messageId);
  const savedAuthor = record?.replacementId === messageId && record.channelId === channelId && record.guildId === guildId
    ? record.authorId : undefined;
  const knownAuthor = [savedAuthor, message.mentions?.repliedUser?.id]
    .find(id => id && id !== botId && DISCORD_ID.test(id));
  const fallback = { authorId: guildId === message.guildId ? knownAuthor : undefined, excerpt: UNAVAILABLE };
  // A reader here may not be able to read another channel, even when the bot can.
  if (guildId !== message.guildId || channelId !== message.channelId) return fallback;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const parent = await Promise.race([
      message.fetchReference(),
      new Promise<undefined>(resolve => { timeout = setTimeout(() => resolve(undefined), LOOKUP_TIMEOUT_MS); }),
    ]);
    const authorId = parent?.author?.id;
    if (parent?.id !== messageId || parent.channelId !== channelId || parent.guildId !== guildId ||
        !authorId || !DISCORD_ID.test(authorId)) return fallback;
    // A human or webhook copying a credit line does not become its named author.
    const credit = authorId === botId && !parent.webhookId ? REPOST_CREDIT.exec(parent.content) : null;
    const credited = credit?.[1];
    return {
      authorId: knownAuthor ?? (authorId !== botId ? authorId : credited !== botId ? credited : undefined),
      excerpt: parentExcerpt(parent, credit),
    };
  } catch {
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}
