import { ComponentType, escapeMarkdown, type APIMessageTopLevelComponent } from 'discord.js';
import type { BlueskyImage, BlueskyLookup, BlueskyPart, BlueskyPost } from './BlueskyPost';
import type { RewritePlatform } from './LinkConfiguration';
import { mapLinks, visibleLink } from './LinkTokens';
import { parseSocialUrl, rewriteSocialLinks } from './SocialProviders';
import { MAX_COMPONENT_TEXT, MAX_GALLERY_ITEMS } from './TweetPanel';

/** A lone Bluesky post that can be shown as one block, with its images and fixer link. */
export interface BlueskyPanel { post: BlueskyPost; media: BlueskyImage[]; source: string }

// Bluesky's brand blue.
const ACCENT = 0x1185fe;

const parts = (post: BlueskyPost): BlueskyPart[] => [post, ...(post.quote ? [post.quote] : [])];

/** Every image of the post and its quote, once each, when there are 1-10. */
export function blueskyPanelMedia(post: BlueskyPost): BlueskyImage[] | null {
  const media: BlueskyImage[] = [];
  for (const image of parts(post).flatMap(part => part.images)) {
    if (!media.some(existing => existing.url === image.url)) media.push(image);
  }
  return media.length && media.length <= MAX_GALLERY_ITEMS ? media : null;
}

/**
 * The message's only link as one block: a visible Bluesky post with 1-10 images of its own or in its quote. Any other
 * message, a disabled platform, a failed lookup or a post without images has no block.
 */
export async function blueskyPostPanel(original: string, platforms: readonly RewritePlatform[],
  lookup: BlueskyLookup): Promise<BlueskyPanel | undefined> {
  if (!platforms.includes('bluesky')) return undefined;
  let linkCount = 0, source: { id: string; fixed: string } | undefined;
  mapLinks(original, (url, position) => {
    linkCount++;
    const parsed = parseSocialUrl(url);
    if (parsed?.platform === 'bluesky' && parsed.postId && visibleLink(original, position)) {
      source = { id: parsed.postId, fixed: rewriteSocialLinks(url, platforms) };
    }
    return url;
  });
  if (linkCount !== 1 || !source) return undefined;
  const post = await lookup(source.id).catch(() => null);
  const media = post && blueskyPanelMedia(post);
  return post && media ? { post, media, source: source.fixed } : undefined;
}

/** A label that cannot open or close the surrounding Markdown link. */
const label = (text: string): string => escapeMarkdown(text).replace(/[\[\]]/g, '\\$&');

/** The display name, then the @handle linked to the profile (a quote's handle links to the quoted post). */
function heading(part: BlueskyPart, quoted: boolean): string {
  const target = quoted ? part.url : `https://bsky.app/profile/${part.author.handle}`;
  const handle = `[@${label(part.author.handle)}](<${target}>)`;
  const linked = part.author.name ? `**${label(part.author.name)}** ${handle}` : `**${handle}**`;
  return quoted ? `Quoting ${linked}` : linked;
}

function partText(part: BlueskyPart, quoted: boolean): string {
  const lines = [heading(part, quoted), ...(part.text ? part.text.split('\n') : [])];
  return quoted ? lines.map(line => `> ${line}`).join('\n') : lines.join('\n');
}

/**
 * One post as a single Components V2 block: an optional lead line (the sharer credit), then a container with the
 * author, the post text, the quoted post's text and a gallery of every image. Null when the images or text do not fit.
 */
export function blueskyPanelComponents(panel: BlueskyPanel, lead: string,
  controls: APIMessageTopLevelComponent[] = []): APIMessageTopLevelComponent[] | null {
  const media = blueskyPanelMedia(panel.post);
  if (!media) return null;
  const body = partText(panel.post, false);
  const quoted = panel.post.quote ? [partText(panel.post.quote, true)] : [];
  if (lead.length + body.length + quoted.reduce((total, text) => total + text.length, 0) > MAX_COMPONENT_TEXT) return null;
  const text = { type: ComponentType.TextDisplay as const, content: body };
  const icon = panel.post.author.avatar;
  return [
    ...(lead ? [{ type: ComponentType.TextDisplay as const, content: lead }] : []),
    { type: ComponentType.Container, accent_color: ACCENT, components: [
      icon ? { type: ComponentType.Section, components: [text],
        accessory: { type: ComponentType.Thumbnail, media: { url: icon } } } : text,
      ...quoted.map(content => ({ type: ComponentType.TextDisplay as const, content })),
      { type: ComponentType.MediaGallery, items: media.map(item => ({ media: { url: item.url },
        description: item.alt || 'Photo from the post.' })) },
    ] },
    ...controls,
  ];
}
