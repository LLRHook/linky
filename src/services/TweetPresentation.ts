import { AttachmentBuilder, escapeMarkdown, type APIEmbed } from 'discord.js';
import type { TweetTranslation } from './TweetTranslation';

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
