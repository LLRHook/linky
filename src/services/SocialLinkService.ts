import { mapLinks, visibleLink } from './LinkTokens';
import { randomBytes } from 'node:crypto';
import {
  Attachment,
  AttachmentBuilder,
  AttachmentFlags,
  Message,
  MessageFlags,
  MessageType,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import type { Logger } from 'pino';
import type { APIEmbed } from 'discord.js';
import type { TweetTranslation } from './TweetTranslation';
import { parseInstagramUrl, type InstagramTranslation } from './InstagramTranslation';
import { addInstagramCaptions } from './InstagramPresentation';
import type { ServerPreferences } from './ServerSettings';
import type { StatsPublication } from './YouTubeStats';
import { findYouTubeLinks, formatYouTubeStatistics, parseYouTubeUrl, type YouTubeStatistics, type YouTubeDisplay } from './YouTube';
import { getProviderCandidates, parseSocialUrl } from './SocialProviders';
import { evaluateScope } from './ServerScope';
import type { RepostRecord, RepostRefreshResult } from './RepostRegistry';
import { expectedPreviews, nextProviderContent, waitForPreviews, type PreviewResult, type ExpectedPreview } from './PreviewRecovery';
import { splitDescription, translationAttachment, translationCaption, translationEmbeds, tweetParts } from './TweetPresentation';

const MAX_CONTENT_LENGTH = 2_000;
const INSTAGRAM_PREVIEW_NOTICE = '\n-# Instagram preview could not be verified; the original post is still here.';
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const RECENT_MESSAGE_LIMIT = 1_000;
const DISCORD_ID = /^[1-9]\d{16,19}$/;

export const REWRITE_PLATFORMS = ['x', 'instagram', 'tiktok', 'youtube', 'bluesky', 'reddit', 'twitch'] as const;
export type RewritePlatform = typeof REWRITE_PLATFORMS[number];

/** Reject an unknown name instead of silently leaving that platform unrewritten. */
export function parseRewritePlatforms(value: string | undefined): readonly RewritePlatform[] {
  if (!value?.trim()) return REWRITE_PLATFORMS;
  const platforms = new Set<RewritePlatform>();
  for (const entry of value.split(',')) {
    const name = entry.trim();
    if (!(REWRITE_PLATFORMS as readonly string[]).includes(name)) {
      throw new Error(`REWRITE_PLATFORMS must be a comma-separated subset of ${REWRITE_PLATFORMS.join(', ')}, with no empty entries.`);
    }
    platforms.add(name as RewritePlatform);
  }
  return [...platforms];
}

/** Rewrite supported post URLs, retaining surrounding text and fragments. */
export function rewriteSocialLinks(content: string, platforms: readonly RewritePlatform[] = REWRITE_PLATFORMS): string {
  const enabled = new Set(platforms);
  return mapLinks(content, (url, position) => {
    if (!visibleLink(content, position)) return url;
    const source = parseSocialUrl(url);
    return source && enabled.has(source.platform) ? getProviderCandidates(source)[0]?.url ?? url : url;
  });
}

export function bypassLinky(content: string): boolean {
  return /(?:^|\s)!nolinky(?=\s|$)/i.test(content);
}

export function originalPostUrl(source: string): string {
  const url = new URL(source);
  url.hash = '';
  return url.href;
}

export function repostControls(original: string, { retry = false, remove = true } = {}) {
  const urls = new Set<string>();
  mapLinks(original, (url, position) => {
    if (visibleLink(original, position)) {
      const source = parseSocialUrl(url)?.sourceUrl ?? parseYouTubeUrl(url)?.url;
      if (source) urls.add(originalPostUrl(source));
    }
    return url;
  });
  const buttons = [...urls].slice(0, retry ? 3 : 4).map((url, index) => new ButtonBuilder()
    .setStyle(ButtonStyle.Link).setLabel(index ? `Original post ${index + 1}` : 'Original post').setURL(url));
  if (retry) buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel('Retry preview').setCustomId('linky:retry'));
  if (remove) buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel('Remove').setCustomId('linky:remove'));
  return buttons.length ? [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)] : [];
}

/** Quote plain leading context without pulling apart existing Markdown or URLs. */
export function formatLinkRepost(content: string, authorId: string, replyUrl?: string): string {
  const credit = `> **Shared by <@${authorId}>**${replyUrl ? ` (reply to ${replyUrl})` : ''}`;
  const fallback = `${credit}\n${content}`;
  // Start at the first URL, even if it is unrelated to X. Never extract a nested URL.
  const firstUrl = /[a-z][a-z\d+.-]*:\/\//i.exec(content);
  if (!firstUrl || firstUrl.index === 0) return fallback;
  const prefix = content.slice(0, firstUrl.index);
  // Replace one ordinary separator with the layout's line break. Preserve more
  // complex whitespace by leaving the entire body unchanged beneath the credit.
  if (!/[ \n]$/.test(prefix)) return fallback;
  const context = prefix.slice(0, -1);
  const lines = context.split('\n');
  if (/[\\`*_~|<>\[\](){}#]/.test(context) || lines.some((line) =>
    !line || /^\s|\s$/.test(line) || /^(?:[-+]|\d+[.)])\s/.test(line)
  )) return fallback;
  return `${credit}\n${lines.map((line) => `> ${line}`).join('\n')}\n${content.slice(firstUrl.index)}`;
}

/** Build one compact card, or captions alongside native video/mixed-link previews. */
async function translateRepost(
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

function isSpoiler(attachment: Attachment): boolean {
  return attachment.spoiler || attachment.flags.has(AttachmentFlags.IsSpoiler);
}

/** Reject malformed scope instead of accidentally processing unrelated channels or servers. */
export function parseDiscordIds(value: string | undefined, label = 'Channel IDs'): string[] {
  if (!value?.trim()) return [];
  const ids = value.split(',').map(entry => entry.trim());
  if (ids.some(id => !DISCORD_ID.test(id))) {
    throw new Error(`${label} must be comma-separated Discord IDs (17-20 digits), with no empty entries.`);
  }
  return [...new Set(ids)];
}

/** Discord.js URL uploads do not check HTTP status, so download and verify first. */
export async function downloadAttachment(
  attachment: Attachment,
  fetchFile: typeof fetch = fetch
): Promise<AttachmentBuilder> {
  if (attachment.size > MAX_ATTACHMENT_BYTES) throw new Error('Attachment exceeds copy limit.');
  const response = await fetchFile(attachment.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Attachment download failed (${response.status}).`);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > attachment.size || size > MAX_ATTACHMENT_BYTES) {
        await reader.cancel();
        throw new Error('Attachment download exceeded its expected size.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (size !== attachment.size) throw new Error('Attachment download was incomplete.');
  return new AttachmentBuilder(Buffer.concat(chunks), {
    name: attachment.name,
    description: attachment.description ?? undefined,
  }).setSpoiler(isSpoiler(attachment));
}

function canCopy(message: Message): boolean {
  return !message.partial &&
    !message.author.bot && !message.webhookId &&
    (message.type === MessageType.Default || message.type === MessageType.Reply) &&
    !message.poll && !message.pinned && !message.hasThread &&
    message.stickers.size === 0 && message.components.length === 0 &&
    message.messageSnapshots.size === 0 &&
    !message.flags.has(MessageFlags.IsVoiceMessage) &&
    !message.flags.has(MessageFlags.Crossposted) &&
    !message.flags.has(MessageFlags.IsCrosspost) &&
    !message.attachments.some((attachment) => attachment.ephemeral);
}

function sourceVersion(message: Message): string {
  // Exclude the SDK's link-warning metadata only from this comparison. Neither
  // message's actual flags are changed, and all other flags remain guarded.
  const flags = message.flags.bitfield;
  const comparisonFlags = flags - (flags & MessageFlags.ShouldShowLinkNotDiscordWarning);
  return JSON.stringify({
    content: message.content,
    editedTimestamp: message.editedTimestamp,
    flags: comparisonFlags,
    reference: message.reference,
    attachments: message.attachments.map((attachment) => [
      attachment.id, attachment.name, attachment.size, attachment.description, isSpoiler(attachment),
    ]),
  });
}

export function createLinkRepostHandler(
  channelIds: readonly string[] | string | undefined,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
  copyAttachment: (attachment: Attachment) => Promise<AttachmentBuilder> = downloadAttachment,
  { platforms = REWRITE_PLATFORMS, translateTweet, translateInstagram, serverIds = [], serverEnabled, serverPreferences,
    lookupYouTube, publishYouTube, verifyPreview = waitForPreviews, observePreview, rememberRepost }: {
    platforms?: readonly RewritePlatform[];
    translateTweet?: (statusId: string) => Promise<TweetTranslation | null>;
    translateInstagram?: (sourceUrl: string) => Promise<InstagramTranslation | null>;
    serverIds?: readonly string[];
    serverEnabled?: (serverId: string) => boolean | undefined;
    serverPreferences?: (serverId: string) => ServerPreferences;
    lookupYouTube?: (ids: readonly string[], display?: YouTubeDisplay) => Promise<Map<string, YouTubeStatistics>>;
    publishYouTube?: (message: Message, embeds: APIEmbed[]) => Promise<StatsPublication | null>;
    verifyPreview?: (message: Message, expected: readonly ExpectedPreview[]) => Promise<PreviewResult>;
    observePreview?: (expected: readonly ExpectedPreview[], result: PreviewResult) => void;
    rememberRepost?: (record: RepostRecord) => Promise<boolean>;
  } = {}
): (message: Message, options?: { refresh?: boolean; forceReply?: boolean }) => Promise<RepostRefreshResult> {
  const allowedChannelIds = typeof channelIds === 'string' ? [channelIds] : channelIds;
  const inFlight = new Set<string>();
  const reposted = new Set<string>();

  return async (message, { refresh = false, forceReply = false } = {}) => {
    if (!message.inGuild()) return;
    const preferences = serverPreferences?.(message.guildId) ?? {};
    const preferenceVersion = JSON.stringify(preferences);
    const enabled = () => evaluateScope({
      guildId: message.guildId, channelId: message.channelId,
      threadParentId: message.channel.isThread() ? message.channel.parentId : undefined,
      serverEnabled: serverEnabled?.(message.guildId), preferences,
      operatorChannelIds: allowedChannelIds, operatorServerIds: serverIds,
    }).enabled &&
      JSON.stringify(serverPreferences?.(message.guildId) ?? {}) === preferenceVersion;
    const activePlatforms = platforms.filter(platform => preferences.platforms?.[platform] !== false);
    let reply = forceReply || preferences.mode === 'reply';
    if (!enabled() ||
        !canCopy(message) || bypassLinky(message.content) || message.flags.has(MessageFlags.SuppressEmbeds) ||
        (!refresh && reposted.has(message.id))) return;
    if (inFlight.has(message.id)) {
      if (refresh) throw new Error('Source repost is still in flight.');
      return;
    }
    const rewritten = rewriteSocialLinks(message.content, activePlatforms);
    const youtubeLinks = activePlatforms.includes('youtube') && lookupYouTube && publishYouTube &&
      !message.flags.has(MessageFlags.SuppressEmbeds) ? findYouTubeLinks(message.content).slice(0, 3) : [];
    if (rewritten === message.content && !youtubeLinks.length) return;

    const channelId = message.channelId;
    const context = { messageId: message.id, channelId, guildId: message.guildId };
    inFlight.add(message.id);
    let rollback: (() => Promise<void>) | undefined;
    try {
      const channel = message.channel;
      const member = message.guild.members.me;
      if (!member || !channel.isSendable()) return;
      const permissions = channel.permissionsFor(member);
      const required = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.EmbedLinks,
        channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages,
      ];
      if (!reply) required.push(PermissionFlagsBits.ManageMessages);
      if (!reply && message.attachments.size) required.push(PermissionFlagsBits.AttachFiles);
      if ((!reply && !message.deletable) || !permissions?.has(required)) {
        log.warn(context, 'Skipping link replacement: missing channel permissions');
        return;
      }

      // IDs provide unambiguous credit without interpolating user-controlled display names.
      const replyUrl = message.reference?.messageId
        ? `https://discord.com/channels/${message.guildId}/${message.reference.channelId ?? channelId}/${message.reference.messageId}`
        : undefined;
      // Discord can mutate this cached message while a language lookup is pending.
      const version = sourceVersion(message);
      let youtube = new Map<string, YouTubeStatistics>();
      const youtubeDisplay = preferences.youtubeDisplay ?? 'counts-and-comment';
      if (youtubeLinks.length && youtubeDisplay !== 'preview') {
        try { youtube = await lookupYouTube!(youtubeLinks.map(link => link.id), youtubeDisplay); }
        catch { log.warn(context, 'YouTube lookup unavailable; keeping native links'); }
      }
      // Preview-only keeps Discord's already-native YouTube message untouched.
      if (rewritten === message.content && !youtube.size) return;
      const body = formatLinkRepost(rewritten, message.author.id, replyUrl);
      const tweetPresentation = translateTweet && preferences.translateTweets !== false && activePlatforms.includes('x') &&
        !message.flags.has(MessageFlags.SuppressEmbeds)
        ? await translateRepost(message.content, activePlatforms, translateTweet,
          MAX_CONTENT_LENGTH - (body.length - rewritten.length)) : { content: rewritten };
      if (!tweetPresentation) {
        log.warn(context, 'Keeping original: source context and every media link exceed the message limit');
        return;
      }
      const translated: NonNullable<typeof tweetPresentation> & { instagramSources?: string[]; instagramVideos?: string[] } =
        translateInstagram && preferences.translateInstagram !== false && activePlatforms.includes('instagram') &&
          !message.flags.has(MessageFlags.SuppressEmbeds)
          ? await addInstagramCaptions(message.content, tweetPresentation, translateInstagram,
            MAX_CONTENT_LENGTH - INSTAGRAM_PREVIEW_NOTICE.length - (body.length - rewritten.length)) : tweetPresentation;
      const canonical = mapLinks(translated.content, (url, position) => {
        const video = parseYouTubeUrl(url);
        return video && youtube.has(video.id) && visibleLink(translated.content, position) ? video.url : url;
      });
      const formatted = formatLinkRepost(canonical, message.author.id, replyUrl);
      let content = formatted.length <= MAX_CONTENT_LENGTH ? formatted : body;
      const youtubeCards = youtubeLinks.filter(link => youtube.has(link.id))
        .map(link => formatYouTubeStatistics(youtube.get(link.id)!, link.url, youtubeDisplay))
        .filter((card): card is APIEmbed => card !== null);
      if (rewritten === message.content && !youtubeCards.length) return;
      const embeds = translated.embeds;
      const translationFiles = translated.translationFiles ?? [];
      if (translationFiles.length && !permissions.has(PermissionFlagsBits.AttachFiles)) {
        log.warn(context, 'Keeping original: a full translation attachment needs Attach Files permission');
        return;
      }
      // Reply mode leaves source attachments on the original instead of duplicating them.
      const attachments = reply ? [] : [...message.attachments.values()];
      const translationBytes = translationFiles.reduce((total, file) =>
        total + (Buffer.isBuffer(file.attachment) ? file.attachment.byteLength : 0), 0);
      if (content.length > MAX_CONTENT_LENGTH || attachments.length + translationFiles.length > 10 ||
          attachments.reduce((total, attachment) => total + attachment.size, translationBytes) > MAX_ATTACHMENT_BYTES) {
        log.warn(context, 'Skipping link replacement: content or attachments exceed copy limits');
        return;
      }

      const files: AttachmentBuilder[] = [];
      for (const attachment of attachments) files.push(await copyAttachment(attachment));
      files.push(...translationFiles);
      if (!enabled()) return;
      const replacement = await channel.send({
        content,
        ...(embeds ? { embeds } : {}),
        files,
        components: repostControls(message.content, { remove: false }),
        allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
        nonce: refresh ? randomBytes(12).toString('hex') : message.id,
        enforceNonce: true,
        ...(reply ? { reply: { messageReference: message.id, failIfNotExists: true } } : {}),
        ...(message.flags.has(MessageFlags.SuppressEmbeds) ? { flags: MessageFlags.SuppressEmbeds } : {}),
      });

      // Remember successes even when deletion fails. The nonce also guards REST retries.
      reposted.add(message.id);
      if (reposted.size > RECENT_MESSAGE_LIMIT) reposted.delete(reposted.values().next().value!);
      const resultContext = { ...context, replacementId: replacement.id };
      let publication: StatsPublication | null = null;
      const removeReplacement = async () => {
        await publication?.remove();
        await replacement.delete();
      };
      rollback = removeReplacement;
      if (!enabled()) {
        await removeReplacement();
        return;
      }
      if (replacement.attachments.size !== files.length) {
        log.warn(resultContext, 'Keeping original: repost did not contain every attachment');
        await removeReplacement();
        return;
      }
      // Caption-mode text is already delivered as translated message content (or
      // a verified attachment). Only media and untranslated posts need an embed.
      const textStatusIds = new Set(content === formatted ? translated.textStatusIds : []);
      const videoStatusIds = new Set(translated.videoStatusIds);
      const instagramIds = new Set((content === formatted ? translated.instagramSources ?? [] : [])
        .map(url => parseInstagramUrl(url)?.shortcode));
      const instagramVideos = new Set((translated.instagramVideos ?? []).map(url => parseInstagramUrl(url)?.shortcode));
      const expectations = () => expectedPreviews(`${message.content}\n${translated.mediaSources ?? ''}`, content)
        .filter(item => !textStatusIds.has(parseSocialUrl(item.source)?.statusId ?? ''))
        .map(item => {
          const instagramId = parseInstagramUrl(item.source)?.shortcode;
          return { ...item,
            ...(instagramId && instagramIds.has(instagramId) ? { captionFree: true } : {}),
            ...(videoStatusIds.has(parseSocialUrl(item.source)?.statusId ?? '') ||
              (instagramId && instagramVideos.has(instagramId)) ? { requireVideo: true } : {}),
          };
        });
      const verify = (expected: ExpectedPreview[]) => expected.length
        ? verifyPreview(replacement, expected)
        : Promise.resolve({ ok: textStatusIds.size > 0, missing: [], videoMetadata: false });
      let expected = expectations();
      const attempted = new Set<string>();
      let preview = await verify(expected);
      observePreview?.(expected, preview);
      // Retry only catalogued alternatives, on the same output, with a bounded budget.
      for (let attempt = 0; !preview.ok && attempt < 2 && enabled(); attempt++) {
        const recovered = nextProviderContent(content, preview.missing, attempted);
        if (recovered === content) break;
        content = recovered;
        await replacement.edit({ content, embeds: embeds ?? [], allowedMentions: { parse: [] } });
        expected = expectations();
        preview = await verify(expected);
        observePreview?.(expected, preview);
      }
      const captionFallback = !preview.ok && expected.length === 1 && preview.missing.length === 1 && preview.missing.every(item => {
        const id = parseInstagramUrl(item.source)?.shortcode;
        return id && instagramIds.has(id);
      });
      if (captionFallback) {
        // An English caption is still useful when Instagram's image is unavailable.
        // Keep the source and register reply ownership so edits/removal remain safe.
        reply = true;
        content += INSTAGRAM_PREVIEW_NOTICE;
        await replacement.edit({ content, embeds: [], flags: MessageFlags.SuppressEmbeds,
          allowedMentions: { parse: [], repliedUser: false } });
      }
      if (!preview.ok && !captionFallback) {
        await removeReplacement();
        log.warn({ ...resultContext, providers: expected.map(item => item.providerId) }, 'Keeping original: no useful preview appeared');
        // A small retry reply is useful only when ownership can be saved and checked.
        if (rememberRepost && enabled()) {
          const latest = await message.fetch(true);
          if (!enabled() || !canCopy(latest)) return;
          if (sourceVersion(latest) !== version) return refresh ? 'retry' : undefined;
          const notice = await channel.send({
            content: 'Linky could not confirm a preview. Your original is still here. You can retry or use /diagnose.',
            components: repostControls(message.content, { retry: true }),
            allowedMentions: { parse: [], repliedUser: false },
            reply: { messageReference: message.id, failIfNotExists: true },
          });
          rollback = async () => { await notice.delete(); };
          const saved = await rememberRepost({ guildId: message.guildId, channelId, sourceId: message.id,
            replacementId: notice.id, authorId: message.author.id, mode: 'reply' });
          const current = saved ? await message.fetch(true) : latest;
          if (!saved || !enabled() || !canCopy(current) || sourceVersion(current) !== version) {
            await notice.delete();
            rollback = undefined;
            if (!saved && refresh) throw new Error('Could not save regenerated retry notice ownership.');
            if (saved && enabled() && canCopy(current) && refresh) return 'retry';
            return;
          }
          rollback = undefined;
        }
        return;
      }
      log.info({ ...resultContext, providers: expected.map(item => item.providerId), videoMetadata: preview.videoMetadata,
        playbackChecked: false, translatedTextPosts: textStatusIds.size },
      captionFallback ? 'Translated Instagram caption delivered; kept original because preview could not be verified' :
        expected.length ? 'Useful Discord preview observed' : 'Translated text delivered');
      if (youtubeCards.length) {
        try { publication = await publishYouTube!(replacement, youtubeCards); }
        catch { log.warn(resultContext, 'Could not publish YouTube details'); }
        if (!publication && rewritten === message.content) {
          await removeReplacement();
          return;
        }
      }
      let latest: Message;
      try {
        latest = await message.fetch(true);
      } catch (err) {
        if (typeof err === 'object' && err !== null && 'code' in err && err.code === 10008) {
          log.info(resultContext, 'Removing repost: original was deleted during copying');
          await removeReplacement();
          return;
        }
        throw err;
      }
      if (!enabled() || !canCopy(latest) || sourceVersion(latest) !== version) {
        log.warn(resultContext, 'Keeping original: message changed or link fixing was disabled while reposting');
        await removeReplacement();
        if (enabled() && canCopy(latest) && refresh) return 'retry';
        return;
      }
      if (rememberRepost && !await rememberRepost({ guildId: message.guildId, channelId, sourceId: message.id,
        replacementId: replacement.id, authorId: message.author.id, mode: reply ? 'reply' : 'replace' })) {
        await removeReplacement();
        log.warn(resultContext, 'Keeping original: could not save repost ownership');
        if (refresh) throw new Error('Could not save regenerated repost ownership.');
        return;
      }
      // State may have changed while the durable ownership record was written.
      const confirmed = rememberRepost ? await message.fetch(true) : latest;
      if (!enabled() || !canCopy(confirmed) || sourceVersion(confirmed) !== version) {
        await removeReplacement();
        if (enabled() && canCopy(confirmed) && refresh) return 'retry';
        return;
      }
      if (reply) {
        rollback = undefined;
        log.info(resultContext, 'Replied with fixed social links; kept original message');
      } else {
        // Sending, checking and deleting are separate Discord requests, not a transaction.
        // An ambiguous deletion error must not remove the only remaining copy.
        rollback = undefined;
        await confirmed.delete();
        log.info(resultContext, 'Replaced social links and deleted original message');
      }
      // Do not expose a Remove action while original deletion is still in flight.
      if (rememberRepost) await replacement.edit({
        components: [...repostControls(message.content), ...publication?.controls ?? []], allowedMentions: { parse: [] },
      });
    } catch (err) {
      if (rollback) await rollback().catch(() => log.warn(context, 'Could not remove incomplete preview'));
      log.error({ ...context, err }, 'link replacement failed; no further deletion will be attempted');
      if (refresh) throw err;
    } finally {
      inFlight.delete(message.id);
    }
    return undefined;
  };
}
