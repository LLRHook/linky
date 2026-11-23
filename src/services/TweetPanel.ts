import { ComponentType, escapeMarkdown, type APIMessageTopLevelComponent } from 'discord.js';
import { galleryItems, type MediaMessage } from './MediaWatch';
import { mapLinks } from './LinkTokens';
import type { TweetMedia, TweetTranslation } from './TweetTranslation';

// Discord's limit for all text displays in one Components V2 message, and for one gallery.
export const MAX_COMPONENT_TEXT = 4000;
export const MAX_GALLERY_ITEMS = 10;
const MEDIA_HOSTS: Record<TweetMedia['type'], string> = { photo: 'pbs.twimg.com', video: 'video.twimg.com', gif: 'video.twimg.com' };

function parts(tweet: TweetTranslation): TweetTranslation[] {
  return [tweet, ...(tweet.quote ? parts(tweet.quote) : [])];
}

function onHost(url: string, host: string): boolean {
  try {
    const address = new URL(url);
    return address.protocol === 'https:' && address.hostname === host && !address.port && !address.username && !address.password;
  } catch { return false; }
}

/**
 * Every photo and video of a post and its quotes, when all of it can be shown from X's own media hosts in one gallery.
 * Null when any media-bearing part lacks its media list, uses another host, or the set does not fit.
 */
export function tweetPanelMedia(tweet: TweetTranslation): TweetMedia[] | null {
  const media: TweetMedia[] = [];
  for (const part of parts(tweet)) {
    if (part.hasMedia && !part.media?.length) return null;
    for (const item of part.media ?? []) {
      if (!onHost(item.url, MEDIA_HOSTS[item.type])) return null;
      if (!media.some(existing => existing.url === item.url)) media.push(item);
    }
  }
  return media.length && media.length <= MAX_GALLERY_ITEMS ? media : null;
}

/**
 * The sharer's own words around a lone post link, without that link; the block shows the post itself.
 * A masked link and punctuation ending at the link go with it; the words on either side keep one space.
 */
export function panelLead(content: string): string {
  const link = '\u0000';
  return mapLinks(content.replaceAll(link, ''), () => link)
    .replace(/\[[^\]\n]*\]\(\u0000\)/g, link)
    .replace(/\u0000[.,!?;:]+(?=\s|$)/g, link)
    .replace(/^[ \t]*\u0000[ \t]*|[ \t]*\u0000[ \t]*$/gm, '')
    .replace(/[ \t]*\u0000[ \t]*/g, ' ')
    .split('\n').map(line => line.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** A label that cannot open or close the surrounding Markdown link. */
const label = (text: string): string => escapeMarkdown(text).replace(/[\[\]]/g, '\\$&');

function heading(part: TweetTranslation, quoted: boolean): string {
  const name = `**${label(part.author.name.slice(0, 100))}**`;
  const target = part.url ? `(<${part.url}>)` : '';
  const handle = part.author.handle ? `@${part.author.handle}` : '';
  const linked = target ? handle ? `${name} [${label(handle)}]${target}` : `[${name}]${target}` : `${name}${handle ? ` ${label(handle)}` : ''}`;
  return quoted ? `Quoting ${linked}` : linked;
}

function partText(part: TweetTranslation, quoted: boolean): string {
  const lines = [heading(part, quoted), ...(part.text ? part.text.split('\n') : [])];
  if (part.language && part.language !== 'English') lines.push(`-# Translated from ${part.language}`);
  return quoted ? lines.map(line => `> ${line}`).join('\n') : lines.join('\n');
}

/**
 * One translated post as a single Components V2 block: an optional lead line (the sharer credit), then a container
 * holding the author, the post text, each quoted post's translated text and every photo or video. Null when the
 * media cannot be shown from X's hosts or the text does not fit.
 */
export function tweetPanelComponents(tweet: TweetTranslation, lead: string,
  controls: APIMessageTopLevelComponent[] = []): APIMessageTopLevelComponent[] | null {
  const media = tweetPanelMedia(tweet);
  if (!media) return null;
  const [post, ...quotes] = parts(tweet);
  const body = partText(post, false);
  const quoted = quotes.map(part => partText(part, true));
  if (lead.length + body.length + quoted.reduce((total, text) => total + text.length, 0) > MAX_COMPONENT_TEXT) return null;
  const text = { type: ComponentType.TextDisplay as const, content: body };
  const icon = post.author.icon_url && onHost(post.author.icon_url, 'pbs.twimg.com') ? post.author.icon_url : undefined;
  return [
    ...(lead ? [{ type: ComponentType.TextDisplay as const, content: lead }] : []),
    { type: ComponentType.Container, accent_color: 0x637dff, components: [
      icon ? { type: ComponentType.Section, components: [text],
        accessory: { type: ComponentType.Thumbnail, media: { url: icon } } } : text,
      ...quoted.map(content => ({ type: ComponentType.TextDisplay as const, content })),
      { type: ComponentType.MediaGallery, items: media.map(item => ({ media: { url: item.url },
        description: item.type === 'photo' ? 'Photo from the post.' : 'Video from the post.' })) },
    ] },
    ...controls,
  ];
}

/** Discord has fetched every gallery item of a post block: each has a proxy address and the expected kind of content. */
export function panelMediaReady(value: MediaMessage, media: readonly Pick<TweetMedia, 'type' | 'url'>[]): boolean {
  const items = galleryItems(value.components);
  return media.length > 0 && media.every(expected => items.some(item => {
    const shown = item?.media;
    if (!shown || shown.url !== expected.url || typeof shown.proxy_url !== 'string' || !shown.proxy_url) return false;
    if (shown.loading_state !== undefined && shown.loading_state !== 2) return false;
    const type = typeof shown.content_type === 'string' ? shown.content_type.toLowerCase() : '';
    return type.startsWith(expected.type === 'photo' ? 'image/' : 'video/');
  }));
}
