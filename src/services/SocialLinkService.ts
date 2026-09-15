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
import { findReplyContext } from './ReplyContext';
import { parseEromeUrl } from './Erome';
import { eromeNotice, findEromeLinks, canPreviewErome, verifyEromeAttachment, type EromePreparer } from './EromeDelivery';
import { fitsAttachmentBudget, guildAttachmentBudget } from './AttachmentLimits';
import { eromeMediaComponents, onlyEromeLinks, watchEromeMedia, sendEromeMedia, messageHasEromeMedia,
  type EromeMedia, type EromeMediaPreparer, type EromeMediaBinding } from './EromeMedia';
import { createDeliveryProgress } from './DeliveryProgress';
import { createDeliveryAttempt, deliveryPlatform } from './DeliveryAttempt';
import type { DeliveryDiagnostics } from './DeliveryDiagnostics';
import type { PreviewWatcher, PreviewWatch } from './PreviewWatcher';
import type { ProviderHealth, ProviderAttempt } from './ProviderHealth';
import type { EromeAlbumSessions } from './EromeAlbumSessions';
import { REWRITE_PLATFORMS, type RewritePlatform } from './LinkConfiguration';
import { formatLinkRepost, repostControls } from './RepostPresentation';

export { REWRITE_PLATFORMS, parseRewritePlatforms, parseDiscordIds, type RewritePlatform } from './LinkConfiguration';
export { originalPostUrl, formatLinkRepost, repostControls } from './RepostPresentation';

const MAX_CONTENT_LENGTH = 2_000;
const INSTAGRAM_PREVIEW_NOTICE = '\n-# Instagram preview could not be verified; the original post is still here.';
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const RECENT_MESSAGE_LIMIT = 1_000;

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
    lookupYouTube, publishYouTube, prepareErome, prepareEromeMedia, bindEromeMedia, releaseEromeMedia, cancelMediaReservation,
    verifyErome = verifyEromeAttachment,
    verifyPreview = waitForPreviews, observePreview, rememberRepost, findRepost, diagnostics, armPreview, providerHealth, albums, signal }: {
    platforms?: readonly RewritePlatform[];
    translateTweet?: (statusId: string) => Promise<TweetTranslation | null>;
    translateInstagram?: (sourceUrl: string) => Promise<InstagramTranslation | null>;
    serverIds?: readonly string[];
    serverEnabled?: (serverId: string) => boolean | undefined;
    serverPreferences?: (serverId: string) => ServerPreferences;
    lookupYouTube?: (ids: readonly string[], display?: YouTubeDisplay) => Promise<Map<string, YouTubeStatistics>>;
    publishYouTube?: (message: Message, embeds: APIEmbed[]) => Promise<StatsPublication | null>;
    prepareErome?: EromePreparer;
    prepareEromeMedia?: EromeMediaPreparer;
    bindEromeMedia?: EromeMediaBinding;
    releaseEromeMedia?: (messageId: string) => Promise<void>;
    cancelMediaReservation?: (reservation: string) => Promise<void>;
    verifyErome?: typeof verifyEromeAttachment;
    verifyPreview?: (message: Message, expected: readonly ExpectedPreview[]) => Promise<PreviewResult>;
    observePreview?: (expected: readonly ExpectedPreview[], result: PreviewResult) => void;
    rememberRepost?: (record: RepostRecord) => Promise<boolean>;
    findRepost?: (replacementId: string) => RepostRecord | undefined;
    diagnostics?: DeliveryDiagnostics;
    armPreview?: PreviewWatcher['arm'];
    providerHealth?: ProviderHealth;
    albums?: EromeAlbumSessions;
    signal?: AbortSignal;
  } = {}
): (message: Message, options?: { refresh?: boolean; forceReply?: boolean }) => Promise<RepostRefreshResult> {
  const allowedChannelIds = typeof channelIds === 'string' ? [channelIds] : channelIds;
  const inFlight = new Set<string>();
  const reposted = new Set<string>();

  return async (message, { refresh = false, forceReply = false } = {}) => {
    if (!message.inGuild()) return;
    const preferences = serverPreferences?.(message.guildId) ?? {};
    const preferenceVersion = JSON.stringify(preferences);
    const eromeSources = findEromeLinks(message.content);
    const enabled = () => !signal?.aborted && (!eromeSources.length || canPreviewErome(message.channel, preferences.eromeChannels)) && evaluateScope({
      guildId: message.guildId, channelId: message.channelId,
      threadParentId: message.channel.isThread() ? message.channel.parentId : undefined,
      serverEnabled: serverEnabled?.(message.guildId), preferences,
      operatorChannelIds: allowedChannelIds, operatorServerIds: serverIds,
    }).enabled &&
      JSON.stringify(serverPreferences?.(message.guildId) ?? {}) === preferenceVersion;
    const activePlatforms = platforms.filter(platform => preferences.platforms?.[platform] !== false);
    const eromeSource = activePlatforms.includes('erome') && prepareErome ? eromeSources[0] : undefined;
    // Albums may contain more than the first video, so never replace their source.
    let reply = Boolean(eromeSources.length) || forceReply || preferences.mode === 'reply';
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
    if (rewritten === message.content && !youtubeLinks.length && !eromeSource) return;

    const channelId = message.channelId;
    const context = { messageId: message.id, channelId, guildId: message.guildId };
    inFlight.add(message.id);
    let rollback: (() => Promise<void>) | undefined;
    let mediaWatcher: ReturnType<typeof watchEromeMedia> | undefined;
    let previewWatch: PreviewWatch | undefined;
    let progress: ReturnType<typeof createDeliveryProgress> | undefined;
    let progressMessage: Message | undefined;
    let originalMedia: EromeMedia | null = null;
    const providerAttempts: ProviderAttempt[] = [];
    const delivery = createDeliveryAttempt({ requesterId: message.author.id, channelId, guildId: message.guildId,
      mode: 'automatic', platform: deliveryPlatform(message.content) }, diagnostics,
      event => progress?.update(event), signal);
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
      if (eromeSource) required.push(PermissionFlagsBits.AttachFiles);
      if ((!reply && !message.deletable) || !permissions?.has(required)) {
        delivery.finish('permission');
        log.warn(context, 'Skipping link replacement: missing channel permissions');
        return;
      }

      // Discord can mutate this cached message while a metadata lookup is pending.
      const version = sourceVersion(message);
      const nonce = refresh ? randomBytes(12).toString('hex') : message.id;
      let progressAttempted = false;
      progress = createDeliveryProgress(async text => {
        if (!eromeSource || !enabled() || sourceVersion(message) !== version || delivery.context.signal?.aborted) return;
        const content = `Preparing your Erome preview…\n-# ${text}`;
        if (progressMessage) { await progressMessage.edit({ content, allowedMentions: { parse: [] } }); return; }
        if (progressAttempted) return;
        progressAttempted = true;
        progressMessage = await sendEromeMedia(() => channel.send({ content, nonce, enforceNonce: true,
          allowedMentions: { parse: [], repliedUser: false },
          reply: { messageReference: message.id, failIfNotExists: true } }), async () => {
          const recent = await channel.messages.fetch({ limit: 25 });
          const matches = recent.filter(candidate => candidate.author.id === message.client.user.id &&
            candidate.reference?.messageId === message.id && String(candidate.nonce) === nonce);
          return matches.size === 1 ? matches.first()! : null;
        });
      });
      const failureNotice = async (text: string) => {
        await progress!.stop();
        if (!rememberRepost || !enabled()) return;
        const current = await message.fetch(true);
        if (!enabled() || !canCopy(current) || sourceVersion(current) !== version) return;
        const initial = { content: text, components: repostControls(message.content, { remove: false }),
          allowedMentions: { parse: [] as never[], repliedUser: false } };
        const notice = progressMessage ? await progressMessage.edit(initial) : await channel.send({ ...initial,
          reply: { messageReference: message.id, failIfNotExists: true } });
        progressMessage = undefined;
        rollback = async () => { await notice.delete(); };
        if (!await rememberRepost({ guildId: message.guildId, channelId, sourceId: message.id,
          replacementId: notice.id, authorId: message.author.id, mode: 'reply' })) {
          await notice.delete(); rollback = undefined;
          if (refresh) throw Error('Could not save regenerated retry notice ownership.');
          return;
        }
        const latest = await message.fetch(true);
        if (!enabled() || !canCopy(latest) || sourceVersion(latest) !== version) { await notice.delete(); rollback = undefined; return; }
        const details = await delivery.controls(notice.id);
        await notice.edit({ components: [...repostControls(message.content, { retry: true }), ...details], allowedMentions: { parse: [] } });
        rollback = undefined;
      };
      if (eromeSource) progress.update({ stage: 'resolve', state: 'running' });
      const eromeBudget = guildAttachmentBudget(message.guild.premiumTier);
      originalMedia = eromeSource && prepareEromeMedia && bindEromeMedia && releaseEromeMedia && onlyEromeLinks(message.content)
        ? await prepareEromeMedia(eromeSource, { context: delivery.context }).catch(() => null) : null;
      if (eromeSource) delivery.context.trace?.setPath(originalMedia ? 'hosted-original' : 'attachment');
      const erome = eromeSource && !originalMedia && !delivery.context.signal?.aborted
        ? await prepareErome!(eromeSource, undefined, { maxBytes: eromeBudget, context: delivery.context }).catch(() => null) : null;
      if (delivery.context.signal?.aborted) {
        delivery.finish('timeout');
        await failureNotice('This media preparation reached its time limit. Your original is still here; try again later.');
        return;
      }
      if (!enabled() || sourceVersion(message) !== version) return refresh ? 'retry' : undefined;
      if (eromeSource && !originalMedia && (!erome || !fitsAttachmentBudget(erome.file, eromeBudget))) {
        delivery.finish(delivery.context.signal?.aborted ? 'timeout' : 'unavailable');
        log.warn(context, 'Erome video unavailable or outside processing limits; kept original');
        await failureNotice('The Erome preview could not be prepared within its limits. Your original is still here. Retry later if the source is busy or unavailable.');
        return;
      }
      let youtube = new Map<string, YouTubeStatistics>();
      const youtubeDisplay = preferences.youtubeDisplay ?? 'counts-and-comment';
      if (youtubeLinks.length && youtubeDisplay !== 'preview') {
        try { youtube = await lookupYouTube!(youtubeLinks.map(link => link.id), youtubeDisplay); }
        catch { log.warn(context, 'YouTube lookup unavailable; keeping native links'); }
      }
      // Preview-only keeps Discord's already-native YouTube message untouched.
      if (rewritten === message.content && !youtube.size && !erome && !originalMedia) return;
      const replyContext = await findReplyContext(message, findRepost);
      if (!enabled() || sourceVersion(message) !== version) return refresh ? 'retry' : undefined;
      const body = formatLinkRepost(rewritten, message.author.id, replyContext);
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
        if ((erome || originalMedia) && visibleLink(translated.content, position) && parseEromeUrl(url)) return `<${parseEromeUrl(url)!.url}>`;
        const video = parseYouTubeUrl(url);
        return video && youtube.has(video.id) && visibleLink(translated.content, position) ? video.url : url;
      });
      const formatted = formatLinkRepost(canonical, message.author.id, replyContext);
      let content = (formatted.length <= MAX_CONTENT_LENGTH ? formatted : body) + (erome ? eromeNotice(erome.videoCount, erome.kind) : '');
      const usedFormatted = content === formatted + (erome ? eromeNotice(erome.videoCount, erome.kind) : '');
      const youtubeCards = youtubeLinks.filter(link => youtube.has(link.id))
        .map(link => formatYouTubeStatistics(youtube.get(link.id)!, link.url, youtubeDisplay))
        .filter((card): card is APIEmbed => card !== null);
      if (rewritten === message.content && !youtubeCards.length && !erome && !originalMedia) return;
      const embeds = translated.embeds;
      const translationFiles = [...translated.translationFiles ?? [], ...erome ? [erome.file] : []];
      if (translationFiles.length && !permissions.has(PermissionFlagsBits.AttachFiles)) {
        log.warn(context, 'Keeping original: a full translation attachment needs Attach Files permission');
        return;
      }
      // Reply mode leaves source attachments on the original instead of duplicating them.
      const attachments = reply ? [] : [...message.attachments.values()];
      // Erome's separately bounded video is a reply; keep the original source-copy limit unchanged.
      const translationBytes = (translated.translationFiles ?? []).reduce((total, file) =>
        total + (Buffer.isBuffer(file.attachment) ? file.attachment.byteLength : 0), 0);
      if (content.length > MAX_CONTENT_LENGTH || attachments.length + translationFiles.length > 10 ||
          attachments.reduce((total, attachment) => total + attachment.size, translationBytes) > MAX_ATTACHMENT_BYTES) {
        log.warn(context, 'Skipping link replacement: content or attachments exceed copy limits');
        return;
      }

      const files: AttachmentBuilder[] = [];
      for (const attachment of attachments) files.push(await copyAttachment(attachment));
      files.push(...translationFiles);
      if (!enabled() || erome && !fitsAttachmentBudget(erome.file, guildAttachmentBudget(message.guild.premiumTier))) return;
      // Caption-mode text is already delivered as translated message content (or
      // a verified attachment). Only media and untranslated posts need an embed.
      const textStatusIds = new Set(usedFormatted ? translated.textStatusIds : []);
      const videoStatusIds = new Set(translated.videoStatusIds);
      const instagramIds = new Set((usedFormatted ? translated.instagramSources ?? [] : [])
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
      if (providerHealth) {
        const current = expectations();
        const preferred = mapLinks(content, (url, position) => {
          if (!visibleLink(content, position)) return url;
          const item = current.find(item => item.url === url);
          return item ? providerHealth.preferContent(url, item) : url;
        });
        if (preferred.length <= MAX_CONTENT_LENGTH) content = preferred;
      }
      let expected = expectations();
      await progress.stop();
      if (!enabled()) return;
      if (delivery.context.signal?.aborted) {
        delivery.finish('timeout');
        await failureNotice('This media preparation reached its time limit. Your original is still here; try again later.');
        return;
      }
      previewWatch = expected.length ? armPreview?.(channelId, expected, delivery.context) : undefined;
      mediaWatcher = originalMedia ? watchEromeMedia(message.client, channelId, originalMedia) : undefined;
      const preparedMedia = originalMedia;
      const publicationBody = {
        ...(originalMedia ? {
          flags: MessageFlags.IsComponentsV2 as const,
          components: eromeMediaComponents(preparedMedia!, content,
            repostControls(message.content, { remove: false }).map(row => row.toJSON())),
        } : { content, ...(embeds ? { embeds } : {}), files,
          components: repostControls(message.content, { remove: false }) }),
        allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
        ...(message.flags.has(MessageFlags.SuppressEmbeds) ? { flags: MessageFlags.SuppressEmbeds as const } : {}),
      };
      const send = () => progressMessage
        ? progressMessage.edit({ ...publicationBody, ...(preparedMedia ? { content: null, embeds: [], attachments: [] } : {}) })
        : channel.send({ ...publicationBody, nonce, enforceNonce: true,
          ...(reply ? { reply: { messageReference: message.id, failIfNotExists: true } } : {}) });
      const publishStage = delivery.context.trace?.startStage('publish');
      const replacement = originalMedia ? await sendEromeMedia(send, async () => {
        const recent = await channel.messages.fetch({ limit: 25 });
        const matches = recent.filter(candidate => candidate.author.id === message.client.user.id &&
          candidate.reference?.messageId === message.id && (candidate.nonce == null || String(candidate.nonce) === nonce) &&
          messageHasEromeMedia(candidate, preparedMedia!.url));
        return matches.size === 1 ? matches.first()! : null;
      }) : await send();
      progressMessage = undefined;
      publishStage?.finish();

      // Remember successes even when deletion fails. The nonce also guards REST retries.
      reposted.add(message.id);
      if (reposted.size > RECENT_MESSAGE_LIMIT) reposted.delete(reposted.values().next().value!);
      const resultContext = { ...context, replacementId: replacement.id };
      let publication: StatsPublication | null = null;
      const removeReplacement = async () => {
        await publication?.remove();
        await replacement.delete();
        if (originalMedia) await releaseEromeMedia?.(replacement.id);
      };
      // Until the source is deleted, an expired attempt can safely discard its copy.
      const stopExpired = async () => {
        if (!delivery.context.signal?.aborted) return false;
        delivery.finish('timeout');
        await removeReplacement();
        rollback = undefined;
        await failureNotice('This preview reached its time limit. Your original is still here; try again later.');
        return true;
      };
      rollback = removeReplacement;
      const ownershipStage = delivery.context.trace?.startStage('ownership');
      const mediaBound = !originalMedia || await bindEromeMedia!(originalMedia.id, replacement.id, originalMedia.reservation);
      ownershipStage?.finish(mediaBound ? 'ok' : 'failed');
      if (!enabled() || !mediaBound || delivery.context.signal?.aborted) {
        if (delivery.context.signal?.aborted) delivery.finish('timeout');
        await removeReplacement();
        return;
      }
      if (replacement.attachments.size !== files.length) {
        log.warn(resultContext, 'Keeping original: repost did not contain every attachment');
        await removeReplacement();
        return;
      }
      const mediaPreviewStage = erome || originalMedia ? delivery.context.trace?.startStage('preview') : undefined;
      const eromeVerified = originalMedia ? await mediaWatcher!.verify(replacement)
        : erome ? await verifyErome(replacement, erome.file) : false;
      mediaPreviewStage?.finish(eromeVerified ? 'ok' : 'unavailable');
      const verify = async (expected: ExpectedPreview[]): Promise<PreviewResult> => {
        if (delivery.context.signal?.aborted) return { ok: false, missing: [...expected], videoMetadata: false };
        const stage = expected.length ? delivery.context.trace?.startStage('preview') : undefined;
        const result = expected.length ? await (previewWatch?.verify(replacement) ?? verifyPreview(replacement, expected))
          : { ok: textStatusIds.size > 0 || eromeVerified, missing: [], videoMetadata: false };
        stage?.finish(delivery.context.signal?.aborted ? 'timeout' : result.ok ? 'ok' : 'unavailable');
        return { ...result, ok: !delivery.context.signal?.aborted && result.ok && (!(erome || originalMedia) || eromeVerified), videoMetadata: result.videoMetadata || eromeVerified && (originalMedia?.kind ?? erome?.kind) !== 'image' };
      };
      const attempted = new Set<string>();
      let preview = await verify(expected);
      providerAttempts.push({ expected, result: preview });
      observePreview?.(expected, preview);
      // Retry only catalogued alternatives, on the same output, with a bounded budget.
      for (let attempt = 0; !preview.ok && attempt < 2 && enabled() && !delivery.context.signal?.aborted; attempt++) {
        const recovered = nextProviderContent(content, preview.missing, attempted,
          providerHealth ? (candidates, item) => providerHealth.order(candidates, item) : undefined);
        // An alternate hostname can be longer, including once per repeated link.
        // Preserve room for the retained-caption notice if neither provider works.
        const recoveryLimit = MAX_CONTENT_LENGTH - (instagramIds.size ? INSTAGRAM_PREVIEW_NOTICE.length : 0);
        if (recovered === content || recovered.length > recoveryLimit) break;
        content = recovered;
        expected = expectations();
        previewWatch?.close();
        previewWatch = armPreview?.(channelId, expected, delivery.context);
        await replacement.edit({ content, embeds: embeds ?? [], allowedMentions: { parse: [] } });
        preview = await verify(expected);
        providerAttempts.push({ expected, result: preview });
        observePreview?.(expected, preview);
      }
      if (await stopExpired()) return;
      const captionFallback = !erome && !originalMedia && !preview.ok && expected.length === 1 && preview.missing.length === 1 && preview.missing.every(item => {
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
        delivery.finish('metadata-unconfirmed');
        await failureNotice('Linky could not confirm a preview. Your original is still here. You can retry or check Details.');
        return;
      }
      log.info({ ...resultContext, providers: expected.map(item => item.providerId), videoMetadata: preview.videoMetadata,
        playbackChecked: false, translatedTextPosts: textStatusIds.size },
      captionFallback ? 'Translated Instagram caption delivered; kept original because preview could not be verified' :
        erome || originalMedia ? 'Erome media metadata confirmed; client playback not checked' :
          expected.length ? 'Useful Discord preview observed' : 'Translated text delivered');
      if (youtubeCards.length) {
        try { publication = await publishYouTube!(replacement, youtubeCards); }
        catch { log.warn(resultContext, 'Could not publish YouTube details'); }
        if (!publication && rewritten === message.content) {
          await removeReplacement();
          return;
        }
      }
      if (await stopExpired()) return;
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
      if (await stopExpired()) return;
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
      if (await stopExpired()) return;
      if (!enabled() || !canCopy(confirmed) || sourceVersion(confirmed) !== version) {
        await removeReplacement();
        if (enabled() && canCopy(confirmed) && refresh) return 'retry';
        return;
      }
      if (reply) {
        if (!originalMedia) rollback = undefined;
        log.info(resultContext, 'Replied with fixed social links; kept original message');
      } else {
        // Sending, checking and deleting are separate Discord requests, not a transaction.
        // An ambiguous deletion error must not remove the only remaining copy.
        rollback = undefined;
        await confirmed.delete();
        log.info(resultContext, 'Replaced social links and deleted original message');
      }
      // Do not expose a Remove action while original deletion is still in flight.
      const details = await delivery.controls(replacement.id);
      const albumControl = originalMedia && eromeSource && rememberRepost ? albums?.register({ media: originalMedia,
        source: eromeSource, requesterId: message.author.id, guildId: message.guildId, channelId,
        messageId: replacement.id, sourceMessageId: message.id, mode: 'automatic' }) : undefined;
      if (rememberRepost) await replacement.edit({
        components: originalMedia ? eromeMediaComponents(originalMedia, content,
          [...repostControls(message.content), ...details].map(row => row.toJSON()).concat(albumControl ? [albumControl] : []))
          : [...repostControls(message.content), ...publication?.controls ?? [], ...details], allowedMentions: { parse: [] },
      });
      if (originalMedia) {
        const current = await message.fetch(true);
        if (!enabled() || !canCopy(current) || sourceVersion(current) !== version) {
          await removeReplacement();
          rollback = undefined;
          if (enabled() && canCopy(current) && refresh) return 'retry';
          return;
        }
        rollback = undefined;
      }
      // Once deletion has been sent, keep the potentially sole copy even if a final edit runs late.
      delivery.finish(delivery.context.signal?.aborted ? 'timeout' : captionFallback ? 'partial' : 'confirmed');
    } catch (err) {
      delivery.finish(delivery.context.signal?.aborted ? 'timeout' : 'discord-failure');
      if (rollback) await rollback().catch(() => log.warn(context, 'Could not remove incomplete preview'));
      const failure = err as { code?: unknown; status?: unknown } | null;
      log.error({ ...context, ...(typeof failure?.code === 'number' ? { errorCode: failure.code } : {}),
        ...(typeof failure?.status === 'number' ? { status: failure.status } : {}) },
      'link replacement failed; no further deletion will be attempted');
      if (refresh) throw err;
    } finally {
      await progress?.stop();
      if (progressMessage) await progressMessage.delete().catch(() => log.warn(context, 'Could not remove expired progress reply'));
      if (originalMedia?.reservation) await cancelMediaReservation?.(originalMedia.reservation).catch(() => {});
      mediaWatcher?.close();
      previewWatch?.close();
      providerHealth?.recordRecovery(providerAttempts);
      delivery.close();
      inFlight.delete(message.id);
    }
    return undefined;
  };
}
