import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { mapLinks, visibleLink } from './LinkTokens';
import { parseSocialUrl } from './SocialProviders';
import { parseYouTubeUrl } from './YouTube';
import { parseYouTubeCommunityUrl } from './YouTubeCommunity';
import { parseEromeUrl } from './Erome';
import { parseArticleUrl } from './ArticlePreview';
import { formatReplyExcerpt, type ReplyContext } from './ReplyContext';

export function originalPostUrl(source: string): string {
  const url = new URL(source);
  url.hash = '';
  return url.href;
}

export function repostControls(original: string, { retry = false, remove = true } = {}) {
  const urls = new Set<string>();
  mapLinks(original, (url, position) => {
    if (visibleLink(original, position)) {
      const source = parseSocialUrl(url)?.sourceUrl ?? parseYouTubeUrl(url)?.url ?? parseYouTubeCommunityUrl(url)?.url ?? parseEromeUrl(url)?.url ?? parseArticleUrl(url);
      if (source) urls.add(originalPostUrl(source));
    }
    return url;
  });
  const buttons = [...urls].slice(0, retry ? 3 : 4).map((url, index) => new ButtonBuilder()
    .setStyle(ButtonStyle.Link).setLabel(index ? `Original post ${index + 1}` : 'Original post').setURL(url));
  if (retry) buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel('Retry preview').setCustomId('linky:retry'));
  if (remove) buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel('Remove').setCustomId('linky:remove'));
  return buttons.length ? [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)] : [];
}

/** Quote plain leading context without pulling apart existing Markdown or URLs. */
export function formatLinkRepost(content: string, authorId: string, reply?: ReplyContext): string {
  const attribution = reply ? reply.authorId ? ` (reply to <@${reply.authorId}>)` : ' (reply)' : '';
  const credit = `> **Shared by <@${authorId}>**${attribution}${reply ? '\n' + formatReplyExcerpt(reply.excerpt) : ''}`;
  const fallback = `${credit}\n${content}`;
  // Start at the first URL, even if it is unrelated to X. Never extract a nested URL.
  const firstUrl = /[a-z][a-z\d+.-]*:\/\//i.exec(content);
  if (!firstUrl || firstUrl.index === 0) return fallback;
  const prefix = content.slice(0, firstUrl.index);
  // Replace one ordinary separator with the layout's line break. Preserve more
  // complex whitespace by leaving the entire body unchanged beneath the credit.
  if (!/[ \n]$/.test(prefix)) return fallback;
  const context = prefix.slice(0, -1);
  const lines = context.split('\n');
  if (/[\\`*_~|<>\[\](){}#]/.test(context) || lines.some((line) =>
    !line || /^\s|\s$/.test(line) || /^(?:[-+]|\d+[.)])\s/.test(line)
  )) return fallback;
  return `${credit}\n${lines.map((line) => `> ${line}`).join('\n')}\n${content.slice(firstUrl.index)}`;
}

