import { escapeMarkdown, type AttachmentBuilder, type APIEmbed } from 'discord.js';
import { parseInstagramUrl, type InstagramTranslation } from './InstagramTranslation';
import { mapLinks, visibleLink } from './LinkTokens';

export interface CaptionPresentation {
  content: string;
  embeds?: APIEmbed[];
  translationFiles?: AttachmentBuilder[];
}

const languages = new Intl.DisplayNames(['en'], { type: 'language' });
const characters = new Intl.Segmenter('en', { granularity: 'grapheme' });
const CAPTION_LIMIT = 300;

function label(post: InstagramTranslation): string {
  return `Translated from ${post.languages.map(code => languages.of(code) ?? code).join(', ')}`;
}

/** Render caption URLs literally without generating more automatic embeds. */
function literal(text: string): string {
  return text.split(/(https?:\/\/[^\s<>`]+)/gi).map((part, index) => index % 2
    ? `<${part}>` : escapeMarkdown(part)).join('');
}

/** One short paragraph, without splitting emoji, Markdown escapes or caption URLs. */
function excerpt(text: string, budget: number): string {
  const compact = text.replace(/\s+/g, ' ').trim(), limit = Math.min(CAPTION_LIMIT, budget);
  const full = literal(compact);
  if (full.length <= limit) return full;
  const urls = [...compact.matchAll(/https?:\/\/[^\s<>`]+/gi)];
  const boundaries = [...characters.segment(compact)].map(part => part.index).filter(index => index < limit);
  for (const end of boundaries.reverse()) {
    const crossing = urls.find(url => url.index < end && url.index + url[0].length > end);
    const prefix = literal(compact.slice(0, crossing?.index ?? end).trimEnd());
    if (prefix.length < limit) return `${prefix}…`;
  }
  return '…';
}

/** Preserve the native media, replacing its provider caption with English message text. */
export async function addInstagramCaptions<T extends CaptionPresentation>(
  original: string, presentation: T,
  lookup: (sourceUrl: string) => Promise<InstagramTranslation | null>, contentLimit: number,
): Promise<T & { instagramSources?: string[]; instagramVideos?: string[] }> {
  // Explicit rich embeds can suppress the native media we need to retain.
  if (presentation.embeds?.length || presentation.content.length > contentLimit) return presentation;
  const sources = new Map<string, string>();
  mapLinks(original, (url, position) => {
    const source = visibleLink(original, position) && parseInstagramUrl(url);
    if (source && sources.size < 3) sources.set(source.shortcode, source.sourceUrl);
    return url;
  });
  const posts = new Map<string, InstagramTranslation>();
  for (const [shortcode, sourceUrl] of sources) {
    try {
      const post = await lookup(sourceUrl);
      if (post && post.shortcode === shortcode && parseInstagramUrl(post.sourceUrl)?.shortcode === shortcode &&
          post.mediaOnlyUrl === `https://g.instagram7.com/p/${shortcode}/` && post.text.trim() && post.languages.length) {
        posts.set(shortcode, post);
      }
    } catch { /* A failed caption lookup leaves that link's original preview available. */ }
  }
  const included = new Map<string, InstagramTranslation>();
  const media = mapLinks(presentation.content, (url, position) => {
    if (!visibleLink(presentation.content, position)) return url;
    const source = parseInstagramUrl(url.replace(/^https:\/\/(?:www\.)?instagram7\.com(?=\/)/i, 'https://www.instagram.com'));
    const post = source && posts.get(source.shortcode);
    if (!post) return url;
    included.set(post.shortcode, post);
    return post.mediaOnlyUrl;
  });
  if (!included.size) return presentation;
  const values = [...included.values()];
  const frames = values.map(post => ({
    heading: `**[@${post.username}](<https://www.instagram.com/${post.username}/>)**\n`,
    footer: `\n-# ${label(post)}`,
  }));
  const budget = Math.floor((contentLimit - media.length - 2 - (values.length - 1) * 2 -
    frames.reduce((length, frame) => length + frame.heading.length + frame.footer.length, 0)) / values.length);
  if (budget < 1) return presentation;
  const captions = values.map((post, index) =>
    `${frames[index].heading}${excerpt(post.text, budget)}${frames[index].footer}`).join('\n\n');
  const metadata = { instagramSources: values.map(post => post.sourceUrl),
    instagramVideos: values.filter(post => post.mediaTypes.includes('GraphVideo')).map(post => post.sourceUrl) };
  return { ...presentation, content: `${media}\n\n${captions}`, ...metadata };
}
