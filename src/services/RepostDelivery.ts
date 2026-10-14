import { PermissionFlagsBits } from 'discord.js';
import type { PreparedArticle } from './ArticlePosts';
import { parseEromeUrl } from './Erome';
import { parseInstagramUrl } from './InstagramTranslation';
import { mapLinks, visibleLink } from './LinkTokens';
import { expectedPreviews, type ExpectedPreview } from './PreviewRecovery';
import { parseArticleUrl } from './ArticlePreview';
import { parseSocialUrl } from './SocialProviders';
import { parseYouTubeUrl } from './YouTube';
import { parseYouTubeCommunityUrl, type PreparedCommunityPost } from './YouTubeCommunity';

/** Channel permissions an automatic repost needs before it sends anything. */
export function requiredRepostPermissions({ reply, thread, attachments, erome }:
  { reply: boolean; thread: boolean; attachments: boolean; erome: boolean }): bigint[] {
  const required = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.EmbedLinks,
    thread ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages,
  ];
  if (!reply) required.push(PermissionFlagsBits.ManageMessages);
  if (!reply && attachments) required.push(PermissionFlagsBits.AttachFiles);
  if (erome) required.push(PermissionFlagsBits.AttachFiles);
  return required;
}

/** Suppress links whose explicit card or media Linky posts itself; keep counted YouTube videos native. */
export function canonicalRepostLinks(content: string, { articles, community, eromeMedia, youtubeIds }: {
  articles: readonly PreparedArticle[]; community: readonly PreparedCommunityPost[]; eromeMedia: boolean;
  youtubeIds: ReadonlySet<string> | ReadonlyMap<string, unknown>;
}): string {
  return mapLinks(content, (url, position) => {
    const article = parseArticleUrl(url);
    if (article && visibleLink(content, position) && articles.some(post => post.source === article)) return `<${article}>`;
    const communityPost = parseYouTubeCommunityUrl(url);
    if (communityPost && visibleLink(content, position) && community.some(post => post.source === communityPost.url)) return `<${communityPost.url}>`;
    if (eromeMedia && visibleLink(content, position) && parseEromeUrl(url)) return `<${parseEromeUrl(url)!.url}>`;
    const video = parseYouTubeUrl(url);
    return video && youtubeIds.has(video.id) && visibleLink(content, position) ? video.url : url;
  });
}

export function instagramShortcodes(urls: readonly string[] | undefined): Set<string | undefined> {
  return new Set((urls ?? []).map(url => parseInstagramUrl(url)?.shortcode));
}

/**
 * Previews to verify for published content. Translated text posts need no embed; caption-free
 * Instagram posts and known videos are marked so the matcher checks the right preview.
 */
export function repostExpectations(source: string, content: string, community: readonly PreparedCommunityPost[],
  articles: readonly PreparedArticle[], { textStatusIds, videoStatusIds, captionFreeInstagram, videoInstagram }: {
    textStatusIds: ReadonlySet<string>; videoStatusIds: ReadonlySet<string>;
    captionFreeInstagram: ReadonlySet<string | undefined>; videoInstagram: ReadonlySet<string | undefined>;
  }): ExpectedPreview[] {
  return expectedPreviews(source, content, community, articles)
    .filter(item => !textStatusIds.has(parseSocialUrl(item.source)?.statusId ?? ''))
    .map(item => {
      const instagramId = parseInstagramUrl(item.source)?.shortcode;
      return { ...item,
        ...(instagramId && captionFreeInstagram.has(instagramId) ? { captionFree: true } : {}),
        ...(videoStatusIds.has(parseSocialUrl(item.source)?.statusId ?? '') ||
          (instagramId && videoInstagram.has(instagramId)) ? { requireVideo: true } : {}),
      };
    });
}
