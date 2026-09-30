import { AttachmentBuilder, escapeMarkdown, type APIEmbed } from 'discord.js';
import type { TweetTranslation } from './TweetTranslation';
import type { RewritePlatform } from './LinkConfiguration';
import { mapLinks, visibleLink } from './LinkTokens';
import { parseSocialUrl, rewriteSocialLinks } from './SocialProviders';

export function tweetParts(tweet: TweetTranslation): TweetTranslation[] {
  return [tweet, ...(tweet.quote ? tweetParts(tweet.quote) : [])];
}

function languageLabel(tweet: TweetTranslation): string {
  return tweet.language === 'English' ? '' : `Translated from ${tweet.language}`;
}

export function translationCaption(tweet: TweetTranslation): string {
  return tweetParts(tweet).map((part, index) => {
    const author = index ? `**Quoted post by ${escapeMarkdown(part.author.name)}**\n` : '';
    const label = languageLabel(part);
    return `${author}${part.text}${label ? `\n-# ${label}` : ''}`;
  }).join('\n\n');
}

/** Split at readable boundaries without cutting a generated Markdown link or escape. */
export function splitDescription(text: string, limit = 4_096): string[] | undefined {
  const chunks: string[] = [];
  while (text.length > limit) {
    let cut = Math.max(text.lastIndexOf('\n', limit), text.lastIndexOf(' ', limit));
    if (cut < limit / 2) cut = limit;
    for (const match of text.matchAll(/\[(?:\\.|[^\]\\])*\]\(<[^>]+>\)/g)) {
      if (match.index < cut && match.index + match[0].length > cut) cut = match.index;
    }
    if (cut === 0) return undefined;
    if (/[\uD800-\uDBFF]/.test(text[cut - 1])) cut--;
    if ((text.slice(0, cut).match(/\\*$/)?.[0].length ?? 0) % 2) cut--;
    if (cut === 0) return undefined;
    chunks.push(text.slice(0, cut));
    text = text.slice(cut);
  }
  if (text) chunks.push(text);
  return chunks;
}

/** Discord allows 4096 characters per description and 6000 across all cards. */
export function translationEmbeds(tweet: TweetTranslation, sourceUrl: string): APIEmbed[] | undefined {
  const embeds: APIEmbed[] = [];
  for (const [partIndex, part] of tweetParts(tweet).entries()) {
    const chunks = splitDescription(part.text);
    if (!chunks) return undefined;
    const url = partIndex ? part.url! : sourceUrl;
    const label = languageLabel(part);
    for (const [index, description] of chunks.entries()) {
      const continuation = new URL(url);
      continuation.hash = `translation-${index + 1}`;
      embeds.push({
        url: index ? continuation.href : url, description, color: 0x637dff,
        ...(index === 0 ? {
          author: { ...part.author, name: `${partIndex ? 'Quoted: ' : ''}${part.author.name}`.slice(0, 256) },
          ...(part.photos[0] ? { image: { url: part.photos[0] } } : {}),
        } : {}),
        ...(label && index === chunks.length - 1 ? { footer: { text: label } } : {}),
      });
    }
    for (const photo of part.photos.slice(1)) embeds.push({ url, image: { url: photo } });
  }
  const length = embeds.reduce((total, embed) => total + (embed.description?.length ?? 0) +
    (embed.author?.name.length ?? 0) + (embed.footer?.text.length ?? 0), 0);
  return embeds.length <= 10 && length <= 6_000 ? embeds : undefined;
}

export function translationAttachment(tweets: TweetTranslation[]): AttachmentBuilder {
  const text = tweets.map((tweet) => tweetParts(tweet).map((part, index) =>
    `${index ? 'Quoted post: ' : ''}${part.author.name}\n${part.url ?? ''}\n` +
    `${languageLabel(part)}\n\n${part.text}`).join('\n\n')).join('\n\n---\n\n');
  return new AttachmentBuilder(Buffer.from(text, 'utf8'), {
    name: 'translation.txt', description: 'Full English translation, including quoted posts.',
  });
}

/** Build one compact card, or captions alongside native video/mixed-link previews. */
export async function translateRepost(
  original: string,
  platforms: readonly RewritePlatform[],
  fetchTranslation: (statusId: string) => Promise<TweetTranslation | null>,
  contentLimit: number,
): Promise<{ content: string; embeds?: APIEmbed[]; translationFiles?: AttachmentBuilder[];
  textStatusIds?: string[]; videoStatusIds?: string[]; mediaSources?: string } | null> {
  const content = rewriteSocialLinks(original, platforms);
  const links = new Map<string, string>();
  let linkCount = 0;
  mapLinks(original, (url, position) => {
    linkCount++;
    const id = parseSocialUrl(url)?.statusId;
    if (id && visibleLink(original, position)) links.set(id, rewriteSocialLinks(url, platforms));
    return url;
  });
  const results = await Promise.all([...links.keys()].map(async (id) => {
    try { return [id, await fetchTranslation(id)] as const; }
    catch { return [id, null] as const; }
  }));
  const translations = new Map(results.filter((entry): entry is readonly [string, TweetTranslation] => entry[1] !== null));
  if (!translations.size) return { content };
  const [id, translation] = translations.entries().next().value!;
  if (linkCount === 1 && !tweetParts(translation).some((part) => part.hasVideo)) {
    const embeds = translationEmbeds(translation, links.get(id)!);
    if (embeds) return { content, embeds };
  }
  const galleries = new Set<string>();
  const mediaSources = new Set<string>();
  const textStatusIds: string[] = [];
  const videoStatusIds: string[] = [];
  const rewritten = mapLinks(original, (url, position) => {
    if (!visibleLink(original, position)) return url;
    const rewritten = rewriteSocialLinks(url, platforms);
    const id = parseSocialUrl(url)?.statusId;
    const translation = id && translations.get(id);
    if (!translation) return rewritten;
    if (!translation.hasMedia) textStatusIds.push(id!);
    if (translation.hasVideo) videoStatusIds.push(id!);
    for (const quote of tweetParts(translation).slice(1)) {
      if (quote.hasMedia && quote.url) {
        mediaSources.add(quote.url);
        const quoteId = parseSocialUrl(quote.url)?.statusId;
        if (quote.hasVideo && quoteId) videoStatusIds.push(quoteId);
        galleries.add(quote.url.replace(/^https:\/\/(?:x|twitter)\.com\//, 'https://g.fixupx.com/'));
      }
    }
    return translation.hasMedia ? rewritten.replace('https://fixupx.com/', 'https://g.fixupx.com/') : `<${rewritten}>`;
  });
  const tweets = [...translations.values()];
  const captions = tweets.map((tweet) => translationCaption(tweet)).join('\n\n');
  const withMedia = `${rewritten}${galleries.size ? '\n' + [...galleries].join('\n') : ''}`;
  const translated = `${withMedia}\n\n${captions}`;
  const rendered = { textStatusIds, videoStatusIds, mediaSources: [...mediaSources].join('\n') };
  if (translated.length <= contentLimit) return { content: translated, ...rendered };
  if (withMedia.length > contentLimit) return null;

  // Keep complete long translations downloadable instead of silently abandoning them.
  const base = withMedia;
  const note = '\n-# Full English translation attached.';
  const budget = contentLimit - base.length - note.length - 3;
  const preview = budget >= 100 ? splitDescription(captions, Math.min(budget, 800))?.[0] : undefined;
  const summary = `${base}${preview ? '\n\n' + preview + '\u2026' : ''}${note}`;
  return {
    content: summary.length <= contentLimit ? summary : base,
    translationFiles: [translationAttachment(tweets)],
    ...rendered,
  };
}
