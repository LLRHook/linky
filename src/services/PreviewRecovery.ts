import { setTimeout as delay } from 'node:timers/promises';
import type { APIEmbed, Message } from 'discord.js';
import { mapLinks, visibleLink } from './LinkTokens';
import { getProviderCandidates, parseSocialUrl, parseProviderUrl, type SocialPlatform, type ProviderCandidate } from './SocialProviders';
import { parseYouTubeUrl } from './YouTube';
import { parseYouTubeCommunityUrl, type PreparedCommunityPost } from './YouTubeCommunity';
import { parseArticleUrl } from './ArticlePreview';
import type { PreparedArticle } from './ArticlePosts';

export interface ExpectedPreview {
  source: string;
  url: string;
  platform: SocialPlatform | 'youtube' | 'articles';
  providerId: string;
  /** A trusted metadata lookup identified this post as a video. */
  requireVideo?: boolean;
  /** A translated caption is already displayed; the media embed must not repeat the original. */
  captionFree?: boolean;
  /** Exact bot-authored card payloads from a verified public metadata lookup. */
  explicitEmbeds?: readonly APIEmbed[];
}

export interface PreviewResult {
  ok: boolean;
  missing: ExpectedPreview[];
  /** Discord supplied video metadata; this does not establish client playback. */
  videoMetadata: boolean;
  /** Only matching embeds whose URL identifies the attempted provider. Canonical source URLs remain unattributed. */
  attributed?: ExpectedPreview[];
}

export function expectedPreviews(original: string, rendered: string, communityPosts: readonly PreparedCommunityPost[] = [],
  articles: readonly PreparedArticle[] = []): ExpectedPreview[] {
  const expectations = new Map<string, ExpectedPreview>();
  mapLinks(original, (url, position) => {
    if (!visibleLink(original, position)) return url;
    const social = parseSocialUrl(url);
    const youtube = parseYouTubeUrl(url);
    const community = parseYouTubeCommunityUrl(url);
    if (social) {
      mapLinks(rendered, (observed, position) => {
        if (!visibleLink(rendered, position)) return observed;
        const provider = parseProviderUrl(observed);
        if (provider && previewIdentity(observed) === previewIdentity(social.sourceUrl)) {
          expectations.set(social.sourceUrl, { source: social.sourceUrl, url: observed, platform: provider.platform, providerId: provider.providerId });
        }
        return observed;
      });
    } else if (youtube && rendered.includes(youtube.url)) {
      expectations.set(youtube.url, { source: youtube.url, url: youtube.url, platform: 'youtube', providerId: 'youtube' });
    } else if (community) {
      const prepared = communityPosts.find(post => post.source === community.url);
      if (prepared?.embeds.length) expectations.set(community.url, { source: community.url, url: community.url,
        platform: 'youtube', providerId: 'youtube-community', explicitEmbeds: prepared.embeds });
    } else {
      const source = parseArticleUrl(url), prepared = source && articles.find(article => article.source === source);
      if (source && prepared && prepared.embeds.length === 1 && prepared.embeds[0].url) expectations.set(source, { source,
        url: prepared.embeds[0].url, platform: 'articles', providerId: 'article-metadata', explicitEmbeds: prepared.embeds });
    }
    return url;
  });
  return [...expectations.values()];
}

export function previewIdentity(raw: string): string | null {
  const community = parseYouTubeCommunityUrl(raw);
  if (community) return `youtube-community:${community.id}`;
  const video = parseYouTubeUrl(raw);
  if (video) return `youtube:${video.id}`;
  const source = parseSocialUrl(raw) ?? parseProviderUrl(raw);
  if (!source) return null;
  const path = source.path.replace(/\/$/, '');
  // Instagram canonicalizes /reels/ to /reel/; usernames can change on TikTok.
  const id = source.postId ?? source.statusId ?? (source.platform === 'instagram' || /\/(?:video|photo)\/\d+$/.test(path)
    ? path.split('/').at(-1) : path);
  return `${source.platform}:${id}`;
}

/** TikTok share links (/t/, vm., vt.) hide the post ID; providers publish the canonical post URL. */
function shortTikTok(raw: string): boolean {
  const source = parseSocialUrl(raw);
  return source?.platform === 'tiktok' && !/^\/@[\w.-]+\/(?:video|photo)\/\d+\/?$/.test(source.path);
}

function matches(embed: APIEmbed, expected: ExpectedPreview): boolean {
  if (expected.explicitEmbeds) return false;
  if (!embed.url) return false;
  const observed = previewIdentity(embed.url);
  const same = observed !== null && (observed === previewIdentity(expected.url) ||
    (shortTikTok(expected.source) && /^tiktok:\d+$/.test(observed)));
  if (!same) return false;
  if (expected.captionFree && embed.description?.trim()) return false;
  const errorTitle = /^(?:error(?:\s+\d+)?|not found|temporarily unavailable|(?:tweet|post|video) (?:not found|unavailable|deleted)|something went wrong)$/i;
  const errorText = /^(?:sorry,? (?:that |this )?(?:post|tweet) (?:doesn.t exist|could not be found)|this (?:tweet|post|video) (?:is (?:unavailable|private)|has been deleted)|could not (?:find|load) (?:this |the )?(?:tweet|post|video)|try again later)/i;
  if (errorTitle.test(embed.title?.trim() ?? '') || errorText.test(embed.description?.trim() ?? '')) return false;
  const media = Boolean(embed.video?.url || embed.image?.url || embed.thumbnail?.url);
  const source = parseSocialUrl(expected.source);
  const videoPost = expected.requireVideo || expected.platform === 'youtube' || expected.platform === 'twitch' ||
    (source?.platform === 'x' && /\/video\/[1-4]\/?$/.test(source.path)) ||
    (source?.platform === 'instagram' && /^\/reels?\//.test(source.path)) ||
    (source?.platform === 'tiktok' && /\/video\//.test(source.path));
  if (videoPost) return Boolean(embed.video?.url);
  return media || (['x', 'bluesky', 'reddit'].includes(expected.platform) &&
    Boolean(embed.description?.trim() && (embed.title?.trim() || embed.author?.name?.trim())));
}

function matchesExpectation(embeds: readonly APIEmbed[], expected: ExpectedPreview): boolean {
  if (!expected.explicitEmbeds) return embeds.some(embed => matches(embed, expected));
  if (expected.platform === 'articles') return matchesArticle(embeds, expected);
  const source = parseYouTubeCommunityUrl(expected.source), cards = expected.explicitEmbeds;
  if (!source || expected.url !== source.url || expected.providerId !== 'youtube-community' ||
      cards.length < 1 || cards.length > 10) return false;
  const observed = embeds.filter(embed => embed.url && previewIdentity(embed.url) === `youtube-community:${source.id}`);
  return observed.length === cards.length && cards.every((card, index) => {
    const actual = observed[index];
    return card.url === source.url && actual.url === card.url && (!actual.type || actual.type === 'rich') &&
      actual.title === card.title && actual.description === card.description &&
      actual.author?.name === card.author?.name && actual.author?.url === card.author?.url &&
      actual.image?.url === card.image?.url && !actual.video && !actual.thumbnail && !actual.fields?.length;
  });
}

/** Discord may normalize an embed timestamp while retaining the same instant. */
function sameTimestamp(actual: string | undefined, expected: string | undefined): boolean {
  if (actual === expected) return true;
  return Boolean(actual && expected && Number.isFinite(Date.parse(expected)) && Date.parse(actual) === Date.parse(expected));
}

function matchesArticle(embeds: readonly APIEmbed[], expected: ExpectedPreview): boolean {
  const cards = expected.explicitEmbeds;
  if (expected.providerId !== 'article-metadata' || !parseArticleUrl(expected.source) ||
      !parseArticleUrl(expected.url) || cards?.length !== 1) return false;
  const card = cards[0];
  if (card.url !== expected.url || !card.title?.trim()) return false;
  const observed = embeds.filter(embed => embed.url === expected.url);
  if (observed.length !== 1) return false;
  const actual = observed[0];
  return (!actual.type || actual.type === 'rich') && actual.title === card.title &&
    actual.description === card.description && actual.color === card.color &&
    actual.author?.name === card.author?.name && actual.author?.url === card.author?.url &&
    actual.author?.icon_url === card.author?.icon_url && actual.image?.url === card.image?.url &&
    actual.footer?.text === card.footer?.text && actual.footer?.icon_url === card.footer?.icon_url &&
    sameTimestamp(actual.timestamp, card.timestamp) && !actual.video && !actual.thumbnail &&
    !actual.fields?.length && !actual.provider;
}

export function inspectPreviews(embeds: readonly APIEmbed[], expected: readonly ExpectedPreview[]): PreviewResult {
  return {
    ok: expected.length > 0 && expected.every(item => matchesExpectation(embeds, item)),
    missing: expected.filter(item => !matchesExpectation(embeds, item)),
    videoMetadata: embeds.some(embed => Boolean(embed.video?.url) && expected.some(item => matches(embed, item))),
    attributed: expected.filter(item => embeds.some(embed => embed.type !== 'rich' && matches(embed, item) &&
      (parseProviderUrl(embed.url!)?.providerId === item.providerId || (item.providerId === 'youtube' && parseYouTubeUrl(embed.url!) !== null)))),
  };
}

/** A bounded wait for Discord's asynchronously generated embeds, never a playback claim. */
export async function waitForPreviews(message: Pick<Message, 'embeds' | 'fetch'>, expected: readonly ExpectedPreview[],
  { intervals = [1_000, 2_000, 3_000], sleep = delay }: {
    intervals?: readonly number[]; sleep?: (ms: number) => Promise<unknown>;
  } = {}): Promise<PreviewResult> {
  let current = message;
  let result = inspectPreviews(current.embeds.map(embed => embed.toJSON()), expected);
  for (const ms of intervals) {
    if (result.ok) break;
    await sleep(ms);
    current = await message.fetch(true);
    result = inspectPreviews(current.embeds.map(embed => embed.toJSON()), expected);
  }
  return result;
}

export function nextProviderContent(content: string, missing: readonly ExpectedPreview[], attempted: Set<string>,
  orderCandidates: (candidates: readonly ProviderCandidate[], item: ExpectedPreview) => readonly ProviderCandidate[] = candidates => candidates): string {
  let next = content;
  for (const item of missing) {
    attempted.add(`${item.source}:${item.providerId}`);
    const candidates = getProviderCandidates(item.source, { captionFree: item.captionFree });
    const candidate = orderCandidates(candidates, item)
      .filter(candidate => candidates.some(known => known.providerId === candidate.providerId && known.url === candidate.url))
      .find(candidate => !attempted.has(`${item.source}:${candidate.providerId}`));
    if (!candidate) continue;
    attempted.add(`${item.source}:${candidate.providerId}`);
    next = mapLinks(next, url => url === item.url ? candidate.url : url);
  }
  return next;
}

/** Coarse process-local observations, containing no server IDs, links, or message text. */
export class PreviewHealth {
  private observations = new Map<string, { succeeded: number; failed: number; checkedAt: number; lastSucceeded: boolean }>();

  record(expected: readonly ExpectedPreview[], result: PreviewResult): void {
    for (const item of expected) {
      if (item.explicitEmbeds) continue;
      const old = this.observations.get(item.providerId) ?? { succeeded: 0, failed: 0, checkedAt: 0, lastSucceeded: false };
      const passed = !result.missing.some(missing => missing.source === item.source);
      if (passed && !(result.attributed ?? []).some(observed => observed.source === item.source && observed.providerId === item.providerId)) continue;
      this.observations.set(item.providerId, { succeeded: old.succeeded + Number(passed), failed: old.failed + Number(!passed),
        checkedAt: Date.now(), lastSucceeded: passed });
    }
  }

  describe(link: string): string {
    if (parseYouTubeCommunityUrl(link)) return 'YouTube community image and text posts use verified public post data and Linky-authored cards. No video playback or counts are inferred.';
    if (parseArticleUrl(link)) return 'Public articles use publisher metadata in Linky-authored cards. A confirmed card does not verify the article’s claims.';
    const candidates = getProviderCandidates(link);
    if (!candidates.length && parseYouTubeUrl(link)) return 'YouTube uses its native video preview. Counts depend on the YouTube API.';
    return candidates.map(candidate => {
      const observation = this.observations.get(candidate.providerId);
      return !observation || Date.now() - observation.checkedAt > 15 * 60_000
        ? `${candidate.providerId}: no recent Discord preview observation.`
        : `${candidate.providerId}: the last Discord preview check ${observation.lastSucceeded ? 'passed' : 'failed; that post may be unavailable'}.`;
    }).join('\n') + '\nA preview check does not confirm video playback.';
  }
}
