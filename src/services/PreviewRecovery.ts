import { setTimeout as delay } from 'node:timers/promises';
import type { APIEmbed, Message } from 'discord.js';
import { mapLinks, visibleLink } from './LinkTokens';
import { getProviderCandidates, parseSocialUrl, parseProviderUrl, type SocialPlatform } from './SocialProviders';
import { parseYouTubeUrl } from './YouTube';

export interface ExpectedPreview {
  source: string;
  url: string;
  platform: SocialPlatform | 'youtube';
  providerId: string;
  /** A trusted metadata lookup identified this post as a video. */
  requireVideo?: boolean;
  /** A translated caption is already displayed; the media embed must not repeat the original. */
  captionFree?: boolean;
}

export interface PreviewResult {
  ok: boolean;
  missing: ExpectedPreview[];
  /** Discord supplied video metadata; this does not establish client playback. */
  videoMetadata: boolean;
}

export function expectedPreviews(original: string, rendered: string): ExpectedPreview[] {
  const expectations = new Map<string, ExpectedPreview>();
  mapLinks(original, (url, position) => {
    if (!visibleLink(original, position)) return url;
    const social = parseSocialUrl(url);
    const youtube = parseYouTubeUrl(url);
    if (social) {
      mapLinks(rendered, (observed, position) => {
        if (!visibleLink(rendered, position)) return observed;
        const provider = parseProviderUrl(observed);
        if (provider && identity(observed) === identity(social.sourceUrl)) {
          expectations.set(social.sourceUrl, { source: social.sourceUrl, url: observed, platform: provider.platform, providerId: provider.providerId });
        }
        return observed;
      });
    } else if (youtube && rendered.includes(youtube.url)) {
      expectations.set(youtube.url, { source: youtube.url, url: youtube.url, platform: 'youtube', providerId: 'youtube' });
    }
    return url;
  });
  return [...expectations.values()];
}

function identity(raw: string): string | null {
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

function matches(embed: APIEmbed, expected: ExpectedPreview): boolean {
  if (!embed.url) return false;
  const same = identity(embed.url) !== null && identity(embed.url) === identity(expected.url);
  if (!same) return false;
  if (expected.captionFree && embed.description?.trim()) return false;
  const errorTitle = /^(?:error(?:\s+\d+)?|not found|(?:tweet|post|video) (?:not found|unavailable|deleted)|something went wrong)$/i;
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

export function inspectPreviews(embeds: readonly APIEmbed[], expected: readonly ExpectedPreview[]): PreviewResult {
  return {
    ok: expected.length > 0 && expected.every(item => embeds.some(embed => matches(embed, item))),
    missing: expected.filter(item => !embeds.some(embed => matches(embed, item))),
    videoMetadata: embeds.some(embed => Boolean(embed.video?.url) && expected.some(item => matches(embed, item))),
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

export function nextProviderContent(content: string, missing: readonly ExpectedPreview[], attempted: Set<string>): string {
  let next = content;
  for (const item of missing) {
    // Normal provider fallbacks would reintroduce the caption already translated above.
    if (item.captionFree) continue;
    attempted.add(`${item.source}:${item.providerId}`);
    const candidate = getProviderCandidates(item.source).find(candidate => !attempted.has(`${item.source}:${candidate.providerId}`));
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
      const old = this.observations.get(item.providerId) ?? { succeeded: 0, failed: 0, checkedAt: 0, lastSucceeded: false };
      const passed = !result.missing.some(missing => missing.source === item.source);
      this.observations.set(item.providerId, { succeeded: old.succeeded + Number(passed), failed: old.failed + Number(!passed),
        checkedAt: Date.now(), lastSucceeded: passed });
    }
  }

  describe(link: string): string {
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
