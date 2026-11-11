import { AttachmentBuilder, ComponentType, type APIEmbed, type APIMessageTopLevelComponent } from 'discord.js';
import { findArticleLinks, formatArticlePreview, parseArticleUrl, type ArticleLookup } from './ArticlePreview';
import type { RewritePlatform } from './LinkConfiguration';
import { mapLinks, visibleLink } from './LinkTokens';
import type { TruthSocialFile } from './TruthSocial';

/**
 * `files` are uploaded with the message; the card names images as `attachment://name`, while a video plays as the
 * message's own attachment. `withoutFiles` is the card to show when the uploads cannot be attached.
 */
export interface PreparedArticle { source: string; embeds: APIEmbed[]; files?: TruthSocialFile[]; withoutFiles?: APIEmbed[] }

/** A card's uploaded video; Discord lists it as a message attachment, unlike images the card displays. */
export const isArticleVideo = (name: string | null | undefined): boolean =>
  typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}\.mp4$/.test(name);

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
    if (post.withoutFiles) return { source: post.source, embeds: post.withoutFiles };
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
    const linkedIn = post!.linkedIn?.files ?? [];
    const files = [...post!.truthSocial?.files ?? [], ...linkedIn].filter(file =>
      linkedIn.includes(file) && isArticleVideo(file.name) || shown.includes(JSON.stringify(`attachment://${file.name}`)));
    // Without its upload, a video card shows the poster and links the MP4 instead.
    const withoutFiles = linkedIn.length ? formatArticlePreview({ ...post!, linkedIn: { ...post!.linkedIn!, files: [] } }) : [];
    return { source: sources[index], embeds, ...(files.length ? { files } : {}), ...(withoutFiles.length ? { withoutFiles } : {}) };
  });
  return articleEmbeds(prepared).length ? prepared : null;
}

/** Markdown-inert text for a component's text display; author names are plain in embeds but rendered here. */
function inert(value: string, limit: number): string {
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g, ' ').replace(/\s+/g, ' ').trim();
  const escaped = clean.replace(/[\\`*_{}\[\]()<>~|#+\-]/g, '\\$&').replace(/@/g, '@\u200b');
  return escaped.length <= limit ? escaped : escaped.slice(0, limit - 1).replace(/\\$/, '').trimEnd() + '…';
}

// Discord's limit for all text displays in one Components V2 message.
const MAX_COMPONENT_TEXT = 4000;

/**
 * One article card with its uploaded video, as a single Components V2 block: the shared-by line, then a container
 * holding the card's author, title and text, the playable video, and its counts and time. Null when the set is not
 * exactly one card with one uploaded video, or the text would not fit; the embed card and attachment are used then.
 */
export function articleVideoComponents(posts: readonly PreparedArticle[], content: string,
  controls: APIMessageTopLevelComponent[] = []): APIMessageTopLevelComponent[] | null {
  const cards = articleEmbeds(posts), files = uploads(posts);
  const videos = files.filter(file => isArticleVideo(file.name));
  if (cards.length !== 1 || videos.length !== 1) return null;
  const card = cards[0];
  // Auxiliary uploads must be used by the card's thumbnail, never left loose beside the block.
  if (files.some(file => file !== videos[0] && card.author?.icon_url !== `attachment://${file.name}`)) return null;
  if (!card.url || !card.title || card.image || !card.footer?.text) return null;
  const author = card.author?.name ? inert(card.author.name, 200) : '';
  const byline = author ? `-# ${card.author!.url ? `[${author}](${card.author!.url})` : author}\n` : '';
  const heading = `${byline}### [${card.title}](${card.url})${card.description ? `\n${card.description}` : ''}`;
  const time = card.timestamp && Number.isFinite(Date.parse(card.timestamp)) ? ` · <t:${Math.floor(Date.parse(card.timestamp) / 1000)}:f>` : '';
  const footer = `-# ${card.footer.text}${time}`;
  if (content.length + heading.length + footer.length > MAX_COMPONENT_TEXT) return null;
  const text = { type: ComponentType.TextDisplay as const, content: heading };
  return [
    { type: ComponentType.TextDisplay, content },
    { type: ComponentType.Container, ...(card.color !== undefined ? { accent_color: card.color } : {}), components: [
      card.author?.icon_url ? { type: ComponentType.Section, components: [text],
        accessory: { type: ComponentType.Thumbnail, media: { url: card.author.icon_url } } } : text,
      { type: ComponentType.MediaGallery, items: [{ media: { url: `attachment://${videos[0].name}` }, description: 'Video from the linked post.' }] },
      { type: ComponentType.TextDisplay, content: footer },
    ] },
    ...controls,
  ];
}

/** The published block shows the uploaded video, at its Discord CDN address or as the requested attachment. */
export function messageHasArticleVideo(components: readonly { toJSON(): unknown }[], posts: readonly PreparedArticle[]): boolean {
  const [file] = uploads(posts).filter(file => isArticleVideo(file.name));
  if (!file || !isArticleVideo(file.name)) return false;
  const shown = (url: unknown) => {
    if (url === `attachment://${file.name}`) return true;
    try {
      const address = new URL(String(url));
      return address.protocol === 'https:' && ['cdn.discordapp.com', 'media.discordapp.net'].includes(address.hostname) && !address.port &&
        /^\/attachments\/\d{17,20}\/\d{17,20}\/[^/]+$/.test(address.pathname) && address.pathname.endsWith(`/${file.name}`);
    } catch { return false; }
  };
  const galleries = (value: unknown, depth = 0): boolean => {
    const item = value as { type?: unknown; items?: { media?: { url?: unknown } }[]; components?: unknown[] } | null;
    if (!item || typeof item !== 'object' || depth > 3) return false;
    if (item.type === ComponentType.MediaGallery) return Array.isArray(item.items) && item.items.some(entry => shown(entry?.media?.url));
    return Array.isArray(item.components) && item.components.some(child => galleries(child, depth + 1));
  };
  return components.some(component => {
    const value = component.toJSON() as { type?: unknown };
    return value?.type === ComponentType.Container && galleries(value);
  });
}
