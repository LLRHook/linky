import { ComponentType, escapeMarkdown, type AttachmentBuilder, type APIEmbed, type APIMessageTopLevelComponent } from 'discord.js';
import { parseInstagramUrl, type InstagramMedia, type InstagramPost } from './InstagramPost';
import { mapLinks, visibleLink } from './LinkTokens';
import { INSTAGRAM_PROVIDER, parseProviderUrl } from './SocialProviders';
import { MAX_COMPONENT_TEXT, MAX_GALLERY_ITEMS } from './TweetPanel';

export interface MediaPresentation {
  content: string;
  embeds?: APIEmbed[];
  translationFiles?: AttachmentBuilder[];
}

// OGInstagram's card colour, which its native preview showed before.
const ACCENT = 0xff0069;

/** A lone post whose every item has a provider address, shown as one block: its author and media, never its caption. */
export interface InstagramPanel { post: InstagramPost; media: InstagramMedia[] }

/**
 * One post as a single Components V2 block: an optional lead line (the sharer credit), then a container with the
 * author and a gallery of every item. Null when the text or the gallery does not fit.
 */
export function instagramPanelComponents(panel: InstagramPanel, lead: string): APIMessageTopLevelComponent[] | null {
  const { username } = panel.post;
  const heading = `**[@${escapeMarkdown(username)}](<https://www.instagram.com/${username}/>)**`;
  if (lead.length + heading.length > MAX_COMPONENT_TEXT || !panel.media.length || panel.media.length > MAX_GALLERY_ITEMS) return null;
  return [
    ...(lead ? [{ type: ComponentType.TextDisplay as const, content: lead }] : []),
    { type: ComponentType.Container, accent_color: ACCENT, components: [
      { type: ComponentType.TextDisplay, content: heading },
      { type: ComponentType.MediaGallery, items: panel.media.map(item => ({ media: { url: item.url },
        description: item.type === 'photo' ? 'Photo from the post.' : 'Video from the post.' })) },
    ] },
  ];
}

/**
 * Show Instagram media without its caption. Every visible Instagram link becomes the provider's caption-free gallery
 * card. A message whose only link is one Instagram post also offers `instagramPanel`, which delivery publishes instead
 * as one block when it can. Callers must verify the caption-free media before removing the original.
 */
export async function addInstagramMedia<T extends MediaPresentation>(
  original: string, presentation: T,
  lookup: ((sourceUrl: string) => Promise<InstagramPost | null>) | undefined, contentLimit: number,
): Promise<T & { instagramSources?: string[]; instagramVideos?: string[]; instagramPanel?: InstagramPanel }> {
  // Explicit rich embeds can suppress the native media we need to retain.
  if (presentation.embeds?.length || presentation.content.length > contentLimit) return presentation;
  const sources = new Map<string, string>();
  let links = 0;
  mapLinks(original, (url, position) => {
    links++;
    const source = visibleLink(original, position) && parseInstagramUrl(url);
    if (source) sources.set(source.shortcode, source.sourceUrl);
    return url;
  });
  const included = new Map<string, string>();
  const content = mapLinks(presentation.content, (url, position) => {
    if (!visibleLink(presentation.content, position)) return url;
    const provider = parseProviderUrl(url);
    const source = parseInstagramUrl(provider?.platform === 'instagram' ? provider.sourceUrl : url);
    const originalSource = source && sources.get(source.shortcode);
    if (!source || !originalSource) return url;
    included.set(source.shortcode, originalSource);
    return `${INSTAGRAM_PROVIDER.captionFreeOrigin}/p/${source.shortcode}/`;
  });
  if (!included.size || content.length > contentLimit) return presentation;
  const instagramSources = [...included.values()];
  const videos = new Set(instagramSources.filter(url => /\/(?:reels?|tv)\//.test(url)));
  let instagramPanel: InstagramPanel | undefined;
  // One lookup per message at most: the provider limits how often its post data can be read.
  if (lookup && links === 1 && included.size === 1) {
    const [[shortcode, sourceUrl]] = included;
    try {
      const post = await lookup(sourceUrl);
      if (post && post.shortcode === shortcode && parseInstagramUrl(post.sourceUrl)?.shortcode === shortcode) {
        if (post.mediaTypes.includes('GraphVideo')) videos.add(sourceUrl);
        if (post.media?.length && post.media.length <= MAX_GALLERY_ITEMS) instagramPanel = { post, media: post.media };
      }
    } catch { /* A failed lookup leaves the gallery card. */ }
  }
  return { ...presentation, content, instagramSources, instagramVideos: [...videos], ...(instagramPanel ? { instagramPanel } : {}) };
}
