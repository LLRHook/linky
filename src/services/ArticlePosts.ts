import { AttachmentBuilder, type APIEmbed } from 'discord.js';
import { findArticleLinks, formatArticlePreview, parseArticleUrl, type ArticleLookup } from './ArticlePreview';
import type { RewritePlatform } from './LinkConfiguration';
import { mapLinks, visibleLink } from './LinkTokens';
import type { TruthSocialFile } from './TruthSocial';

/** `files` are uploaded with the message; the card names them as `attachment://name`. */
export interface PreparedArticle { source: string; embeds: APIEmbed[]; files?: TruthSocialFile[] }

// Uploaded card media per message, within Discord's ten files and well under its request size.
const MAX_ARTICLE_FILES = 6, MAX_ARTICLE_FILE_BYTES = 16 * 1024 * 1024;

export const ARTICLE_MIXED_GUIDANCE = 'Share articles separately from other links so every preview can appear. Your original message is unchanged.';

/** Authored cards suppress native unfurls, including unsupported or disabled platform links. */
export function hasMixedArticleLinks(content: string, platforms: readonly RewritePlatform[]): boolean {
  if (!platforms.includes('articles') || !findArticleLinks(content, 1).length) return false;
  let other = false;
  mapLinks(content, (url, position) => {
    if (visibleLink(content, position) && !parseArticleUrl(url)) other = true;
    return url;
  });
  return other;
}

/** Tracking aliases can share one card only when their publisher metadata agrees. */
export function articleEmbeds(posts: readonly PreparedArticle[]): APIEmbed[] {
  const cards = new Map<string, APIEmbed>();
  for (const post of posts) {
    if (post.embeds.length !== 1) return [];
    const card = post.embeds[0];
    if (!card.url || !parseArticleUrl(card.url)) return [];
    const existing = cards.get(card.url);
    if (existing && JSON.stringify(existing) !== JSON.stringify(card)) return [];
    cards.set(card.url, card);
  }
  return [...cards.values()];
}

const uploads = (posts: readonly PreparedArticle[]) => {
  const files = new Map<string, TruthSocialFile>();
  for (const post of posts) for (const file of post.files ?? []) files.set(file.name, file);
  return [...files.values()];
};

/** The cards' uploaded media, once per name. */
export function articleAttachments(posts: readonly PreparedArticle[]): AttachmentBuilder[] {
  return uploads(posts).map(file => new AttachmentBuilder(Buffer.from(file.data), { name: file.name }));
}

/** Cards that link their media's original addresses, for messages that cannot carry the uploads. */
export function withoutArticleFiles(posts: readonly PreparedArticle[]): PreparedArticle[] {
  return posts.map(post => {
    if (!post.files?.length) return post;
    const original = (url?: string) => post.files!.find(file => url === `attachment://${file.name}`)?.url ?? url;
    return { source: post.source, embeds: post.embeds.map(embed => ({ ...embed,
      ...(embed.author ? { author: { ...embed.author, ...(embed.author.icon_url ? { icon_url: original(embed.author.icon_url) } : {}) } } : {}),
      ...(embed.image ? { image: { ...embed.image, url: original(embed.image.url)! } } : {}) })) };
  });
}

/** Uploads stay within the per-message budget, and only where the channel allows attachments. */
export function fitArticleFiles(posts: readonly PreparedArticle[], canAttach: boolean): PreparedArticle[] {
  const files = uploads(posts);
  return canAttach && files.length <= MAX_ARTICLE_FILES &&
    files.reduce((total, file) => total + file.data.byteLength, 0) <= MAX_ARTICLE_FILE_BYTES ? [...posts] : withoutArticleFiles(posts);
}

/** Publish the whole requested set or leave the source intact. */
export async function prepareArticlePosts(sources: readonly string[], lookup?: ArticleLookup,
  signal?: AbortSignal): Promise<PreparedArticle[] | null> {
  if (!sources.length) return [];
  if (!lookup || sources.length > 3 || signal?.aborted) return null;
  const posts = await Promise.all(sources.map(source => lookup(source, signal).catch(() => null)));
  if (signal?.aborted || posts.some((post, index) => !post || post.source !== sources[index])) return null;
  const prepared = posts.map((post, index): PreparedArticle => {
    const embeds = formatArticlePreview(post!), shown = JSON.stringify(embeds);
    const files = post!.truthSocial?.files?.filter(file => shown.includes(JSON.stringify(`attachment://${file.name}`)));
    return { source: sources[index], embeds, ...(files?.length ? { files } : {}) };
  });
  return articleEmbeds(prepared).length ? prepared : null;
}
