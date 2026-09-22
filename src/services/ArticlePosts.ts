import type { APIEmbed } from 'discord.js';
import { findArticleLinks, formatArticlePreview, parseArticleUrl, type ArticleLookup } from './ArticlePreview';
import type { RewritePlatform } from './LinkConfiguration';
import { mapLinks, visibleLink } from './LinkTokens';

export interface PreparedArticle { source: string; embeds: APIEmbed[] }

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

/** Publish the whole requested set or leave the source intact. */
export async function prepareArticlePosts(sources: readonly string[], lookup?: ArticleLookup,
  signal?: AbortSignal): Promise<PreparedArticle[] | null> {
  if (!sources.length) return [];
  if (!lookup || sources.length > 3 || signal?.aborted) return null;
  const posts = await Promise.all(sources.map(source => lookup(source, signal).catch(() => null)));
  if (signal?.aborted || posts.some((post, index) => !post || post.source !== sources[index])) return null;
  const prepared = posts.map((post, index) => ({ source: sources[index], embeds: formatArticlePreview(post!) }));
  return articleEmbeds(prepared).length ? prepared : null;
}
