import type { APIEmbed } from 'discord.js';
import type { TruthSocialFile } from './TruthSocial';

/**
 * A public LinkedIn post read from the signed-out page's Schema.org JSON-LD. The page's own Open Graph image is a
 * generic LinkedIn logo, so the card names the post's media instead, and uploads its video so Discord can play it.
 */
export interface LinkedInPost {
  /** Canonical `https://www.linkedin.com/posts/...` permalink. */
  url: string;
  author: { name: string; url?: string; avatar?: string };
  text: string;
  /** A video's own title. */
  title?: string;
  /** The title of a link the post shares, shown as text. */
  link?: string;
  /** The first post image, or the video's poster. */
  image?: string;
  imageCount: number;
  /** A playable MP4 rendition of the post's video. */
  video?: string;
  counts?: { likes: number; comments: number };
  publishedAt?: string;
  /** The uploaded copy of `video`; the card then leaves the poster to Discord's player. */
  files?: TruthSocialFile[];
}

const LINKEDIN_HOST = 'www.linkedin.com';
const HOSTS = new Set([LINKEDIN_HOST, 'linkedin.com']);
// `/posts/<author>_<slug>-activity-<id>-<suffix>`; shared links also use `ugcPost` or `share` ids.
const POST_PATH = /^\/posts\/[^/?#\s]{1,400}-(?:activity|ugcPost|share)-\d{15,22}-[A-Za-z0-9_-]{2,8}\/?$/;
const FEED_PATH = /^\/feed\/update\/urn:li:(?:activity|ugcPost|share):\d{15,22}\/?$/;
const ACTIVITY = /-activity-(\d{15,22})-[A-Za-z0-9_-]{2,8}$/;
// LinkedIn's signed media: long-lived, query-signed addresses on its image and video CDNs, without dot segments.
const SIGNED = '(?:\\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,120}){1,12}\\?e=\\d{1,12}&v=beta&t=[A-Za-z0-9_-]{8,200}$';
const IMAGE = new RegExp(`^https:\\/\\/media\\.licdn\\.com\\/dms\\/image${SIGNED}`);
const VIDEO = new RegExp(`^https:\\/\\/dms\\.licdn\\.com\\/playlist\\/vid${SIGNED}`);
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function linkedInUrl(raw: string): URL | null {
  if (raw.length > 1000 || /[\\\s\u0000-\u001f\u007f]/.test(raw)) return null;
  const parts = /^https:\/\/([^/?#]+)([^?#]*)(?:\?[^#]*)?(?:#.*)?$/i.exec(raw);
  if (!parts) return null;
  try {
    const url = new URL(raw);
    return parts[1].toLowerCase() === url.hostname && parts[2] === url.pathname && HOSTS.has(url.hostname) ? url : null;
  } catch { return null; }
}

/** A LinkedIn post page (`/posts/...` or `/feed/update/urn:li:...`); profiles, articles and other pages are not posts. */
export function isLinkedInPostUrl(raw: string): boolean {
  const url = linkedInUrl(raw);
  return Boolean(url && (POST_PATH.test(url.pathname) || FEED_PATH.test(url.pathname)));
}

/** A canonical `/posts/` permalink without tracking parameters, or null. */
export function linkedInPermalink(raw: unknown): string | null {
  const url = typeof raw === 'string' ? linkedInUrl(raw) : null;
  return url && POST_PATH.test(url.pathname) ? `https://${LINKEDIN_HOST}${url.pathname.replace(/\/$/, '')}` : null;
}

function linkedInImage(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 1024 && IMAGE.test(value) ? value : null;
}

function linkedInVideo(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 1024 && VIDEO.test(value) ? value : null;
}

/** Upload name for a post's video, keyed by its activity id. */
export function linkedInVideoName(post: Pick<LinkedInPost, 'url'>): string | null {
  const id = ACTIVITY.exec(linkedInPermalink(post.url) ?? '')?.[1];
  return id ? `linkedin-${id}.mp4` : null;
}

function text(value: unknown, maximum = 10_000): string {
  return typeof value === 'string' && value.length <= maximum ? value.replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : '';
}

function count(value: unknown, type: RegExp): number | undefined {
  for (const item of Array.isArray(value) ? value.slice(0, 10) : [value]) {
    const counter = record(item), amount = counter.userInteractionCount;
    if (typeof counter.interactionType === 'string' && type.test(counter.interactionType) &&
        typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0) return amount;
  }
  return undefined;
}

/**
 * The page's own VideoObject or SocialMediaPosting for the canonical post. `ogUrl` is the page's declared
 * permalink; the JSON-LD must describe that same post.
 */
export function parseLinkedInPost(json: readonly unknown[], ogUrl: string | undefined): LinkedInPost | null {
  const url = linkedInPermalink(ogUrl);
  if (!url) return null;
  const item = json.slice(0, 8).map(record).find(entry => typeof entry['@context'] === 'string' &&
    /^https?:\/\/schema\.org\/?$/.test(entry['@context']) && ['VideoObject', 'SocialMediaPosting'].includes(String(entry['@type'])) &&
    linkedInPermalink(entry['@id']) === url);
  if (!item) return null;
  const isVideo = item['@type'] === 'VideoObject';
  const creator = record(isVideo ? item.creator : item.author);
  const name = text(creator.name, 300);
  if (!name) return null;
  const profile = typeof creator.url === 'string' && linkedInUrl(creator.url) &&
    /^\/(?:in|company|school|showcase)\/[A-Za-z0-9_%-]{1,200}\/?$/.test(new URL(creator.url).pathname)
    ? `https://${LINKEDIN_HOST}${new URL(creator.url).pathname.replace(/\/$/, '')}` : undefined;
  const avatar = linkedInImage(record(creator.image).url);
  const body = text(isVideo ? item.description : item.articleBody) || text(item.headline, 2000);
  const images = isVideo ? [] : (Array.isArray(item.image) ? item.image : item.image ? [item.image] : []).slice(0, 50);
  const image = isVideo ? linkedInImage(item.thumbnailUrl) : images.map(entry => linkedInImage(record(entry).url ?? entry)).find(Boolean) ?? null;
  const video = isVideo ? linkedInVideo(item.contentUrl) : null;
  if (isVideo && !video) return null;
  const title = isVideo ? text(item.text, 500) : '', link = isVideo ? '' : text(item.text, 500);
  if (!body && !image && !video) return null;
  const likes = count(item.interactionStatistic, /^https?:\/\/schema\.org\/LikeAction$/);
  const comments = count(item.interactionStatistic, /^https?:\/\/schema\.org\/CommentAction$/) ??
    (typeof item.commentCount === 'number' && Number.isSafeInteger(item.commentCount) && item.commentCount >= 0 ? item.commentCount : undefined);
  const date = item.datePublished;
  const publishedAt = typeof date === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(date) && Number.isFinite(Date.parse(date))
    ? new Date(date).toISOString() : undefined;
  return {
    url, author: { name, ...(profile ? { url: profile } : {}), ...(avatar ? { avatar } : {}) }, text: body,
    ...(title ? { title } : {}), ...(link ? { link } : {}), ...(image ? { image } : {}), imageCount: images.length,
    ...(video ? { video } : {}), ...(likes !== undefined ? { counts: { likes, comments: comments ?? 0 } } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  };
}

/** Inert Discord text: no mentions, markdown, masked links or invite links; line breaks are kept. */
function literal(value: string, limit: number): string {
  const clean = text(value).replace(/(?:https?:\/\/|www\.|\bdiscord\.gg\/|\bdiscord(?:app)?\.com\/invite\/)\S+/gi, '[link]');
  const escaped = clean.replace(/[\\`*_{}\[\]()<>~|#+\-]/g, '\\$&').replace(/@/g, '@\u200b');
  return escaped.length <= limit ? escaped : escaped.slice(0, limit - 1).replace(/\\$/, '').trimEnd() + '…';
}

/** Embed author names do not render markdown; only remove controls and bound the length. */
function plain(value: string, limit: number): string {
  const clean = text(value).replace(/\s+/g, ' ');
  return clean.length <= limit ? clean : clean.slice(0, limit - 1).trimEnd() + '…';
}

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

/**
 * One card with the author, post text, counts and time. An uploaded video plays as the message's attachment;
 * otherwise the card shows the poster and links the MP4.
 */
export function formatLinkedInPost(post: LinkedInPost): APIEmbed[] {
  const url = linkedInPermalink(post?.url);
  if (!url || url !== post.url || typeof post.author?.name !== 'string' || typeof post.text !== 'string' ||
      (post.image !== undefined && linkedInImage(post.image) !== post.image) ||
      (post.video !== undefined && linkedInVideo(post.video) !== post.video) ||
      (post.author.avatar !== undefined && linkedInImage(post.author.avatar) !== post.author.avatar) ||
      (post.author.url !== undefined && !linkedInUrl(post.author.url))) return [];
  const files = post.files ?? [];
  const expectedName = linkedInVideoName(post);
  if (!Array.isArray(files) || files.length > 1 || files.some(file => !post.video || file?.url !== post.video ||
      file.name !== expectedName || !(file.data instanceof Uint8Array) || !file.data.byteLength)) return [];
  const uploaded = files.length === 1;
  const name = plain(post.author.name, 200);
  if (!name) return [];
  const parts = [literal(post.text, 3000)];
  if (typeof post.link === 'string' && post.link) parts.push(`**Link:** ${literal(post.link, 300)}`);
  if (post.video && !uploaded) parts.push(`**[▶ Play video](${post.video})**`);
  else if (post.imageCount > 1) parts.push(`*${post.imageCount} images: open the post to see all of them.*`);
  const description = parts.filter(Boolean).join('\n\n');
  const image = uploaded ? undefined : post.image;
  if (!description && !image && !uploaded) return [];
  const counts = post.counts && [[post.counts.likes, 'reactions'], [post.counts.comments, 'comments']]
    .map(([value, label]) => `${compact.format(value as number)} ${label}`).join(' · ');
  const date = post.publishedAt && Number.isFinite(Date.parse(post.publishedAt)) ? new Date(post.publishedAt).toISOString() : undefined;
  const title = typeof post.title === 'string' ? literal(post.title, 256) : '';
  return [{
    title: title || (post.video ? 'LinkedIn video' : 'LinkedIn post'), url, color: 0x0a66c2,
    author: { name, ...(post.author.url ? { url: post.author.url } : {}), ...(post.author.avatar ? { icon_url: post.author.avatar } : {}) },
    ...(description ? { description } : {}), ...(image ? { image: { url: image } } : {}),
    footer: { text: counts ? `LinkedIn · ${counts}` : 'LinkedIn' },
    ...(date ? { timestamp: date } : {}),
  }];
}
