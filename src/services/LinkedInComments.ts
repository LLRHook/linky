import { sanitizeReplyText } from './ReplyText';
import { ButtonBuilder, ButtonStyle, type APIEmbed, type ChannelType } from 'discord.js';
import { linkedInPermalink, parseLinkedInPost } from './LinkedIn';
import { repliesChannel, type ReplyPage, type PublicReply } from './ReplyThreads';

const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export const linkedInActivity = (url: string): string | undefined => /-(?:activity|ugcPost|share)-(\d{15,22})-[A-Za-z0-9_-]{2,8}$/.exec(linkedInPermalink(url) ?? '')?.[1];

/** Isolated from the card parser: keep only bounded usable comments, in page order. */
export function parseLinkedInComments(json: readonly unknown[], ogUrl: string | undefined, now: number): ReplyPage | null {
  const post = parseLinkedInPost(json, ogUrl);
  if (!post?.counts || post.counts.comments <= 0) return null;
  const item = json.slice(0, 8).map(record).find(entry => typeof entry['@context'] === 'string' && /^https?:\/\/schema\.org\/?$/.test(entry['@context']) &&
    ['VideoObject', 'SocialMediaPosting'].includes(typeof entry['@type'] === 'string' ? entry['@type'] : '') && linkedInPermalink(entry['@id']) === post.url);
  if (!Array.isArray(item?.comment)) return null;
  const replies: PublicReply[] = [];
  let m = 0;
  for (const value of item.comment) {
    const c = record(value), author = record(item['@type'] === 'VideoObject' ? c.creator : c.author);
    const likes = (Array.isArray(c.interactionStatistic) ? c.interactionStatistic : [c.interactionStatistic]).map(record)
      .find(s => typeof s.interactionType === 'string' && /^https?:\/\/schema\.org\/LikeAction$/.test(s.interactionType))?.userInteractionCount;
    const date = c.datePublished;
    if (c['@type'] !== 'Comment' || author['@type'] !== 'Person' || typeof author.name !== 'string' ||
        author.name.length > 300 || typeof c.text !== 'string' || c.text.length > 3000 ||
        typeof likes !== 'number' || !Number.isSafeInteger(likes) || likes < 0 || typeof date !== 'string' ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(date) || !Number.isFinite(Date.parse(date)) || Date.parse(date) < 0) { m++; continue; }
    const name = sanitizeReplyText(author.name, 300, true), text = sanitizeReplyText(c.text, 500, true);
    if (!name || !text) { m++; continue; }
    if (replies.length < 10) replies.push({ name: author.name, text, likes,
      timestamp: Math.floor(Date.parse(date) / 1000), handle: '', profileUrl: '', url: '', hasMedia: false });
  }
  return replies.length ? { N: post.counts.comments, countTime: now, r: item.comment.length, m, replies,
    source: 'LinkedIn', orderLabel: "in LinkedIn's order", maxShown: 10, threadHandle: post.author.name,
    commentsUrl: post.url } : null;
}

/** Production publish gate; N is read from the same authored card footer visible to the member. */
export function linkedInCommentsButton(cards: readonly APIEmbed[], type: ChannelType | undefined, enabled: boolean, page?: ReplyPage | null) {
  if (!enabled || !repliesChannel(type) || cards.length !== 1 || !page?.replies.length) return undefined;
  const card = cards[0], url = linkedInPermalink(card.url), id = url && linkedInActivity(url);
  const count = /^LinkedIn · [\d.,KMBT]+ reactions · ([\d.,KMBT]+) comments$/.exec(card.footer?.text ?? '')?.[1];
  return id && page.commentsUrl === url && count && count !== '0' ? new ButtonBuilder().setStyle(ButtonStyle.Secondary)
    .setLabel(`Comments (${count})`).setCustomId(`linky:replies:linkedin:${id}`) : undefined;
}

/** Resolve only a canonical post URL present in the clicked, ownership-checked Linky message. */
export function linkedInCommentsUrl(message: { embeds?: readonly { url?: string | null }[]; components?: readonly unknown[] }, id: string): string | null {
  if (!/^\d{15,22}$/.test(id)) return null;
  const embedded = message.embeds?.map(e => e.url) ?? [];
  const headings: string[] = [];
  const visit = (value: unknown, inCard = false): void => {
    const node = record(value && typeof value === 'object' && 'toJSON' in value && typeof value.toJSON === 'function' ? value.toJSON() : value);
    if (inCard && node.type === 10 && typeof node.content === 'string') {
      for (const match of node.content.matchAll(/^### \[.*?\]\((https:\/\/www\.linkedin\.com\/posts\/[^\s)]+)\)/gm)) headings.push(match[1]);
    }
    if (Array.isArray(node.components)) node.components.forEach(child => visit(child, inCard || node.type === 17));
  };
  message.components?.forEach(value => visit(value));
  const urls = [...new Set([...embedded, ...headings].filter((v): v is string => typeof v === 'string' && linkedInPermalink(v) === v && linkedInActivity(v) === id))];
  return urls.length === 1 ? urls[0] : null;
}
