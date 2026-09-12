import { AttachmentBuilder, escapeMarkdown, type APIEmbed } from 'discord.js';
import { parseInstagramUrl, type InstagramTranslation } from './InstagramTranslation';
import { mapLinks, visibleLink } from './LinkTokens';
import { splitDescription } from './TweetPresentation';

export interface CaptionPresentation {
  content: string;
  embeds?: APIEmbed[];
  translationFiles?: AttachmentBuilder[];
}

const languages = new Intl.DisplayNames(['en'], { type: 'language' });

function label(post: InstagramTranslation): string {
  return `Translated from ${post.languages.map(code => languages.of(code) ?? code).join(', ')}`;
}

/** Render caption URLs literally without generating more automatic embeds. */
function literal(text: string): string {
  return text.split(/(https?:\/\/[^\s<>`]+)/gi).map((part, index) => index % 2
    ? `<${part}>` : escapeMarkdown(part)).join('');
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
  const captions = values.map(post => `**[@${post.username}](<https://www.instagram.com/${post.username}/>)**\n` +
    `${literal(post.text)}\n-# ${label(post)}`).join('\n\n');
  const metadata = { instagramSources: values.map(post => post.sourceUrl),
    instagramVideos: values.filter(post => post.mediaTypes.includes('GraphVideo')).map(post => post.sourceUrl) };
  const content = `${media}\n\n${captions}`;
  if (content.length <= contentLimit) return { ...presentation, content, ...metadata };
  const sourceLanguages = [...new Set(values.flatMap(post => post.languages))];
  const note = `\n-# ${label({ ...values[0], languages: sourceLanguages })}. Full English Instagram caption attached.`;
  const budget = contentLimit - media.length - note.length - 3;
  if (budget < 100 || (presentation.translationFiles?.length ?? 0) >= 10) return presentation;
  // URLs can exceed the entire preview budget. Preserve them in the attachment,
  // keeping the shortened message free of partial links and unlabeled translations.
  const excerpt = `**@${values[0].username}**\n` + literal(values[0].text.replace(/https?:\/\/[^\s<>`]+/gi, '[link in attachment]'));
  const preview = splitDescription(excerpt, Math.min(budget, 700))?.[0];
  if (!preview) return presentation;
  const fullText = values.map(post => `@${post.username}\n${post.sourceUrl}\n${label(post)}\n\n${post.text}`).join('\n\n');
  const file = new AttachmentBuilder(Buffer.from(fullText), {
    name: 'instagram-translation.txt', description: 'Full English Instagram captions and source-language labels.',
  });
  return { ...presentation, content: `${media}\n\n${preview}…${note}`,
    translationFiles: [...presentation.translationFiles ?? [], file], ...metadata };
}
