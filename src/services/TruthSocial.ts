import type { APIEmbed } from 'discord.js';

export interface TruthSocialLink { id: string; handle: string; url: string }
/** Where the post data came from; the status API is preferred, the others serve hosts its bot protection blocks. */
export type TruthSocialSource = 'api' | 'archive' | 'page';
/** Display data for one post; the article pipeline carries it as an authored card. */
export interface TruthSocialPost {
  url: string;
  author: { name: string; handle: string; avatar?: string };
  text: string;
  repostedBy?: string;
  quote?: { name: string; handle: string; text: string };
  /** The post's own link preview, shown as text because outbound links are not rendered. */
  link?: { title: string; site?: string };
  image?: string;
  video: boolean;
  /** A playable archived copy of the post's video. */
  videoUrl?: string;
  mediaCount: number;
  counts?: { replies: number; reposts: number; likes: number };
  publishedAt?: string;
  via?: TruthSocialSource;
}

export const TRUTH_SOCIAL_HOST = 'truthsocial.com';
/** Trump's Truth (Defending Democracy Together) archives @realDonaldTrump with his media; its feed holds the latest 100 posts. */
export const TRUTH_ARCHIVE = { host: 'www.trumpstruth.org', feed: '/feed', handle: 'realdonaldtrump' } as const;
const HOSTS = new Set([TRUTH_SOCIAL_HOST, 'www.truthsocial.com']);
const HANDLE = /^[A-Za-z0-9_]{1,30}$/;
const STATUS_ID = /^\d{1,20}$/;
// Truth Social's own media hosts; no queries, ports, credentials or dot segments reach Discord's image proxy.
const ASSET = /^https:\/\/static-assets(?:-\d{1,2})?\.truthsocial\.com\/[A-Za-z0-9_:-]+(?:\/[A-Za-z0-9_:-]+)*\.(?:jpe?g|png|webp|gif)$/i;
// The archive's object storage, with the same path restrictions.
const ARCHIVE_MEDIA = /^https:\/\/truth-archive\.[a-z]{2}-[a-z]{3,6}-\d\.linodeobjects\.com\/attachments(?:\/[A-Za-z0-9_-]+)+\.(jpe?g|png|webp|gif|mp4)$/i;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Post permalinks only; profiles, groups and API paths are not posts. */
export function parseTruthSocialUrl(raw: string): TruthSocialLink | null {
  if (raw.length > 500 || /[\\\s\u0000-\u001f\u007f]/.test(raw)) return null;
  const parts = /^https:\/\/([^/?#]+)([^?#]*)(?:\?[^#]*)?(?:#.*)?$/i.exec(raw);
  if (!parts) return null;
  try {
    const url = new URL(raw);
    if (parts[1].toLowerCase() !== url.hostname || parts[2] !== url.pathname || !HOSTS.has(url.hostname)) return null;
    const post = /^\/@([A-Za-z0-9_]{1,30})\/(?:posts\/)?(\d{1,20})\/?$/.exec(url.pathname);
    return post ? { id: post[2], handle: post[1], url: `https://${TRUTH_SOCIAL_HOST}/@${post[1]}/${post[2]}` } : null;
  } catch { return null; }
}

export function truthSocialAsset(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 1024 && ASSET.test(value) ? value : null;
}

function archiveMedia(value: unknown, kind: 'image' | 'video'): string | null {
  const match = typeof value === 'string' && value.length <= 1024 ? ARCHIVE_MEDIA.exec(value) : null;
  return match && (match[1].toLowerCase() === 'mp4') === (kind === 'video') ? value as string : null;
}

/** Card images come only from Truth Social or its archive's storage. */
export function truthSocialImage(value: unknown): string | null {
  return truthSocialAsset(value) ?? archiveMedia(value, 'image');
}

/** Status HTML to plain text; paragraphs and line breaks survive, markup and attributes do not. */
function statusText(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 100_000) return null;
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  // Truth Social repeats a quoted post's address inline; the quote is shown separately.
  return value.replace(/<span class="quote-inline">[\s\S]{0,2000}?<\/span>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*<p\b[^>]*>/gi, '\n\n').replace(/<[^>]{0,2000}>/g, '')
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, entity: string) => {
      if (entity[0] !== '#') return named[entity.toLowerCase()] ?? whole;
      const point = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : ' ';
    }).trim();
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function account(value: unknown): { name: string; handle: string; avatar?: string } | null {
  const item = record(value), handle = item.acct;
  if (typeof handle !== 'string' || !HANDLE.test(handle)) return null;
  const display = typeof item.display_name === 'string' && item.display_name.length <= 256 ? item.display_name.trim() : '';
  const avatar = truthSocialAsset(item.avatar);
  return { name: display || handle, handle, ...(avatar ? { avatar } : {}) };
}

/** Only content anyone can open without signing in; content warnings and sensitive media stay on Truth Social. */
function visible(status: Record<string, unknown>): boolean {
  return ['public', 'unlisted'].includes(String(status.visibility)) && status.sensitive !== true &&
    !(typeof status.spoiler_text === 'string' && status.spoiler_text.trim());
}

/** Accept only the requested public status; a ReTruth shows the reposted post and credits the reposter. */
export function parseTruthSocialStatus(value: unknown, link: TruthSocialLink): TruthSocialPost | null {
  const outer = record(value);
  if (outer.id !== link.id || !STATUS_ID.test(link.id) || !visible(outer)) return null;
  const reposter = account(outer.account);
  if (!reposter) return null;
  const reblog = outer.reblog === null || outer.reblog === undefined ? null : record(outer.reblog);
  if (reblog && (!Object.keys(reblog).length || !visible(reblog))) return null;
  const status = reblog ?? outer, author = reblog ? account(reblog.account) : reposter;
  const text = statusText(status.content);
  if (!author || text === null) return null;
  const media = status.media_attachments === undefined ? [] : status.media_attachments;
  if (!Array.isArray(media) || media.length > 20) return null;
  let image: string | null = null, video = false;
  for (const raw of media) {
    const item = record(raw), type = String(item.type);
    // Uncached remote media ('unknown') has no usable preview; it still counts toward the post's media.
    if (['video', 'gifv', 'audio'].includes(type)) video = true;
    if (type !== 'unknown') image ??= truthSocialAsset(type === 'image' ? item.url : item.preview_url) ?? truthSocialAsset(item.preview_url);
  }
  const card = record(status.card), title = typeof card.title === 'string' && card.title.length <= 1000 ? card.title.trim() : '';
  const site = typeof card.provider_name === 'string' && card.provider_name.length <= 200 ? card.provider_name.trim() : '';
  if (title) image ??= truthSocialAsset(card.image);
  if (!text && !media.length && !title) return null;
  const quoted = status.quote === null || status.quote === undefined ? null : record(status.quote);
  const quoteAuthor = quoted && visible(quoted) ? account(quoted.account) : null;
  const quoteText = quoteAuthor ? statusText(quoted!.content) : null;
  const date = status.created_at;
  const publishedAt = typeof date === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(date) && Number.isFinite(Date.parse(date))
    ? new Date(date).toISOString() : undefined;
  return {
    url: `https://${TRUTH_SOCIAL_HOST}/@${reposter.handle}/${link.id}`, author, text,
    ...(reblog ? { repostedBy: reposter.name } : {}),
    ...(quoteAuthor && quoteText ? { quote: { name: quoteAuthor.name, handle: quoteAuthor.handle, text: quoteText } } : {}),
    ...(title ? { link: { title, ...(site ? { site } : {}) } } : {}), ...(image ? { image } : {}), video, mediaCount: media.length,
    counts: { replies: count(status.replies_count), reposts: count(status.reblogs_count), likes: count(status.favourites_count) },
    ...(publishedAt ? { publishedAt } : {}), via: 'api',
  };
}

function xmlText(value: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(value);
  return cdata ? cdata[1] : value.replace(/&(lt|gt|quot|apos|amp);/g, (_whole, entity: string) =>
    ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[entity]!).trim();
}

/** Find the requested @realDonaldTrump post in the archive feed by its Truth Social ID. */
export function parseTruthArchiveFeed(xml: string, link: TruthSocialLink): TruthSocialPost | null {
  if (link.handle.toLowerCase() !== TRUTH_ARCHIVE.handle || !STATUS_ID.test(link.id) || xml.length > 4 * 1024 * 1024) return null;
  const items = xml.split('<item>').slice(1, 201);
  const item = items.find(entry => new RegExp(`<truth:originalId>\\s*${link.id}\\s*</truth:originalId>`).test(entry));
  if (!item) return null;
  const field = (name: string) => { const match = new RegExp(`<${name}>([\\s\\S]{0,200000}?)</${name}>`).exec(item); return match ? xmlText(match[1]) : null; };
  const original = field('truth:originalUrl');
  if (field('archive:removed') !== 'false' || !original || parseTruthSocialUrl(original)?.id !== link.id) return null;
  const html = (field('description') ?? '')
    .replace(/<p>\s*<a href="[^"]*">View (?:image|video|media)<\/a>\s*<\/p>/gi, '');
  const text = statusText(html);
  if (text === null) return null;
  let image: string | null = null, videoUrl: string | null = null, video = false, mediaCount = 0;
  for (const [, attributes, body, selfClosing] of item.matchAll(/<media:content\b([^>]{0,2000})>([\s\S]{0,4000}?)<\/media:content>|<media:content\b([^>]{0,2000})\/>/g)) {
    const attrs = attributes ?? selfClosing ?? '', url = /\burl="([^"]{1,1024})"/.exec(attrs)?.[1], medium = /\bmedium="(\w+)"/.exec(attrs)?.[1];
    const thumbnail = /<media:thumbnail\b[^>]*\burl="([^"]{1,1024})"/.exec(body ?? '')?.[1];
    if (++mediaCount > 20) return null;
    if (medium === 'video') {
      video = true;
      videoUrl ??= archiveMedia(url, 'video');
      image ??= truthSocialImage(thumbnail);
    } else image ??= archiveMedia(url, 'image') ?? truthSocialImage(thumbnail);
  }
  if (!text && !mediaCount) return null;
  const date = Date.parse(field('pubDate') ?? '');
  const name = field('dc:creator');
  return { url: `https://${TRUTH_SOCIAL_HOST}/@realDonaldTrump/${link.id}`,
    author: { name: name && name.length <= 256 ? name : 'Donald J. Trump', handle: 'realDonaldTrump' }, text,
    ...(image ? { image } : {}), video, ...(videoUrl ? { videoUrl } : {}), mediaCount,
    ...(Number.isFinite(date) ? { publishedAt: new Date(date).toISOString() } : {}), via: 'archive' };
}

/**
 * Truth Social's own crawler metadata: some text posts carry their full text in og:description.
 * The placeholder served for other posts is never a post.
 */
export function parseTruthSocialPage(meta: { url?: string; title?: string; description?: string; image?: string },
  link: TruthSocialLink, authorName?: string): TruthSocialPost | null {
  const canonical = meta.url && parseTruthSocialUrl(meta.url);
  const text = (meta.description ?? '').trim();
  if (!canonical || canonical.id !== link.id || !text || text.length > 100_000 || meta.title?.trim() === 'Truth Social') return null;
  const avatar = truthSocialAsset(meta.image);
  const name = authorName?.trim();
  return { url: canonical.url, author: { name: name && name.length <= 256 ? name : canonical.handle, handle: canonical.handle,
    ...(avatar ? { avatar } : {}) }, text, video: false, mediaCount: 0, via: 'page' };
}

/** Inert Discord text: no mentions, markdown, masked links or invite links; line breaks are kept. */
function literal(value: string, limit: number): string {
  const clean = value.replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g, ' ')
    .replace(/(?:https?:\/\/|www\.|\bdiscord\.gg\/|\bdiscord(?:app)?\.com\/invite\/)\S+/gi, '[link]')
    .replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const escaped = clean.replace(/[\\`*_{}\[\]()<>~|#+\-]/g, '\\$&').replace(/@/g, '@\u200b');
  return escaped.length <= limit ? escaped : escaped.slice(0, limit - 1).replace(/\\$/, '').trimEnd() + '…';
}

/** Embed author names do not render markdown; only remove controls and bound the length. */
function plain(value: string, limit: number): string {
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length <= limit ? clean : clean.slice(0, limit - 1).trimEnd() + '…';
}

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

/** One card with the author, text, first image or video poster, counts and post time. */
export function formatTruthSocialPost(post: TruthSocialPost): APIEmbed[] {
  const link = parseTruthSocialUrl(post?.url ?? '');
  if (!link || link.url !== post.url || !HANDLE.test(post.author?.handle ?? '') || typeof post.author.name !== 'string' ||
      typeof post.text !== 'string' || (post.image !== undefined && truthSocialImage(post.image) !== post.image) ||
      (post.videoUrl !== undefined && archiveMedia(post.videoUrl, 'video') !== post.videoUrl) ||
      (post.author.avatar !== undefined && truthSocialAsset(post.author.avatar) !== post.author.avatar)) return [];
  const name = plain(post.author.name, 200) || post.author.handle;
  const parts = [literal(post.text, 2800)];
  if (post.quote && HANDLE.test(post.quote.handle)) {
    const quote = literal(post.quote.text, 500);
    parts.push(`**Quoting ${literal(post.quote.name, 100) || literal(post.quote.handle, 40)} (${literal(`@${post.quote.handle}`, 60)})**` +
      (quote ? `\n${quote.split('\n').map(line => `> ${line}`).join('\n')}` : ''));
  }
  if (post.link && typeof post.link.title === 'string') {
    const site = typeof post.link.site === 'string' ? literal(post.link.site, 100) : '';
    parts.push(`**Link:** ${literal(post.link.title, 300)}${site ? ` · ${site}` : ''}`);
  }
  if (post.videoUrl) parts.push(`**[▶ Play video](${post.videoUrl})**`);
  else if (post.video) parts.push('*Video: open the post to play it.*');
  else if (post.mediaCount > 1) parts.push(`*${post.mediaCount} images: open the post to see all of them.*`);
  const description = parts.filter(Boolean).join('\n\n');
  if (!description && !post.image) return [];
  const counts = post.counts && [[post.counts.replies, 'replies'], [post.counts.reposts, 'ReTruths'], [post.counts.likes, 'likes']]
    .map(([value, label]) => `${compact.format(value as number)} ${label}`).join(' · ');
  const footer = post.via === 'archive' ? 'Truth Social · via Trump’s Truth archive' : counts ? `Truth Social · ${counts}` : 'Truth Social';
  const date = post.publishedAt && Number.isFinite(Date.parse(post.publishedAt)) ? new Date(post.publishedAt).toISOString() : undefined;
  return [{
    title: post.repostedBy ? literal(`ReTruthed by ${post.repostedBy}`, 256) : 'Truth Social post', url: link.url, color: 0x5448ee,
    author: { name: `${name} (@${post.author.handle})`, url: `https://${TRUTH_SOCIAL_HOST}/@${post.author.handle}`,
      ...(post.author.avatar ? { icon_url: post.author.avatar } : {}) },
    ...(description ? { description } : {}), ...(post.image ? { image: { url: post.image } } : {}),
    footer: { text: footer },
    ...(date ? { timestamp: date } : {}),
  }];
}
