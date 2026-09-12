import { mapLinks, visibleLink } from './LinkTokens';
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
import type { ServerPreferences } from './ServerSettings';
import type { StatsPublication } from './YouTubeStats';
import { findYouTubeLinks, formatYouTubeStatistics, parseYouTubeUrl, type YouTubeStatistics } from './YouTube';
import { splitDescription, translationAttachment, translationCaption, translationEmbeds, tweetParts } from './TweetPresentation';

const MAX_CONTENT_LENGTH = 2_000;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const RECENT_MESSAGE_LIMIT = 1_000;
const DISCORD_ID = /^[1-9]\d{16,19}$/;

export const REWRITE_PLATFORMS = ['x', 'instagram', 'tiktok', 'youtube'] as const;
export type RewritePlatform = typeof REWRITE_PLATFORMS[number];

interface Platform {
  name: RewritePlatform;
  /** An allowed subdomain plus the literal apex host, anchored at the scheme. */
  host: RegExp;
  /** Replacement authority; a matched subdomain is dropped. */
  fixer: string;
  /** Paths worth rewriting. Without one, every path on the host qualifies. */
  path?: RegExp;
}

// Subdomains are a fixed allowlist per platform, never a wildcard: `www.x.com` and
// other lookalike authorities must keep falling through untouched.
const PLATFORMS: readonly Platform[] = [
  { name: 'x', host: /^https:\/\/x\.com(?=[/?#]|$)/i, fixer: 'https://fixupx.com' },
  {
    name: 'instagram',
    host: /^https:\/\/(?:www\.|m\.|mobile\.)?instagram\.com(?=[/?#]|$)/i,
    fixer: 'https://www.instagram7.com',
    path: /^\/(?:p|reels?|tv)\/[\w-]+\/?$/,
  },
  {
    name: 'tiktok',
    host: /^https:\/\/(?:www\.|m\.)?tiktok\.com(?=[/?#]|$)/i,
    fixer: 'https://tnktok.com',
    path: /^\/(?:@[\w.-]+\/(?:video|photo)\/\d+|t\/[\w-]+)\/?$/,
  },
  // Share links carry the code at the root, which must not be accepted on the apex host.
  {
    name: 'tiktok',
    host: /^https:\/\/(?:vm|vt)\.tiktok\.com(?=[/?#]|$)/i,
    fixer: 'https://tnktok.com',
    path: /^\/[\w-]+\/?$/,
  },
];

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
  return mapLinks(content, (url) => rewriteUrl(url, enabled) ?? url);
}

function rewriteUrl(url: string, enabled: ReadonlySet<RewritePlatform>): string | undefined {
  for (const platform of PLATFORMS) {
    if (!enabled.has(platform.name)) continue;
    const host = platform.host.exec(url);
    if (!host) continue;
    // The query string is share/tracking noise (?s=..&t=..); drop it, keeping any fragment.
    const rest = url.slice(host[0].length).replace(/^([^?#]*)\?[^#]*/, '$1');
    if (platform.path && !platform.path.test(rest.split('#', 1)[0])) continue;
    return platform.fixer + rest;
  }
  return undefined;
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
): Promise<{ content: string; embeds?: APIEmbed[]; translationFiles?: AttachmentBuilder[] } | null> {
  const content = rewriteSocialLinks(original, platforms);
  const statusLink = /^https:\/\/x\.com\/[^\s/?#]+\/status\/(\d+)(?=[?#]|$)/i;
  const links = new Map<string, string>();
  let linkCount = 0;
  mapLinks(original, (url, position) => {
    linkCount++;
    const id = statusLink.exec(url)?.[1];
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
  const rewritten = mapLinks(original, (url, position) => {
    const rewritten = rewriteSocialLinks(url, platforms);
    const id = statusLink.exec(url)?.[1];
    const translation = id && translations.get(id);
    if (!translation || !visibleLink(original, position)) return rewritten;
    for (const quote of tweetParts(translation).slice(1)) {
      if (quote.hasMedia && quote.url) galleries.add(quote.url.replace(/^https:\/\/(?:x|twitter)\.com\//, 'https://g.fixupx.com/'));
    }
    return translation.hasMedia ? rewritten.replace('https://fixupx.com/', 'https://g.fixupx.com/') : `<${rewritten}>`;
  });
  const tweets = [...translations.values()];
  const captions = tweets.map((tweet) => translationCaption(tweet)).join('\n\n');
  const withMedia = `${rewritten}${galleries.size ? '\n' + [...galleries].join('\n') : ''}`;
  const translated = `${withMedia}\n\n${captions}`;
  if (translated.length <= contentLimit) return { content: translated };
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
  { platforms = REWRITE_PLATFORMS, translateTweet, serverIds = [], serverEnabled, serverPreferences,
    lookupYouTube, publishYouTube }: {
    platforms?: readonly RewritePlatform[];
    translateTweet?: (statusId: string) => Promise<TweetTranslation | null>;
    serverIds?: readonly string[];
    serverEnabled?: (serverId: string) => boolean | undefined;
    serverPreferences?: (serverId: string) => ServerPreferences;
    lookupYouTube?: (ids: readonly string[]) => Promise<Map<string, YouTubeStatistics>>;
    publishYouTube?: (message: Message, embeds: APIEmbed[]) => Promise<StatsPublication | null>;
  } = {}
): (message: Message) => Promise<void> {
  const allowedChannelIds = new Set(typeof channelIds === 'string' ? [channelIds] : channelIds);
  const allowedServerIds = new Set(serverIds);
  const inFlight = new Set<string>();
  const reposted = new Set<string>();

  return async (message) => {
    if (!message.inGuild()) return;
    const preferences = serverPreferences?.(message.guildId) ?? {};
    const preferenceVersion = JSON.stringify(preferences);
    const enabled = () => (serverEnabled?.(message.guildId) ??
      (allowedChannelIds.has(message.channelId) || allowedServerIds.has(message.guildId))) &&
      JSON.stringify(serverPreferences?.(message.guildId) ?? {}) === preferenceVersion;
    const activePlatforms = platforms.filter(platform => preferences.platforms?.[platform] !== false);
    const reply = preferences.mode === 'reply';
    if (!enabled() ||
        !canCopy(message) || inFlight.has(message.id) || reposted.has(message.id)) return;
    const rewritten = rewriteSocialLinks(message.content, activePlatforms);
    const youtubeLinks = activePlatforms.includes('youtube') && lookupYouTube && publishYouTube &&
      !message.flags.has(MessageFlags.SuppressEmbeds) ? findYouTubeLinks(message.content).slice(0, 3) : [];
    if (rewritten === message.content && !youtubeLinks.length) return;

    const channelId = message.channelId;
    const context = { messageId: message.id, channelId, guildId: message.guildId };
    inFlight.add(message.id);
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
      if (youtubeLinks.length) {
        try { youtube = await lookupYouTube!(youtubeLinks.map(link => link.id)); }
        catch { log.warn(context, 'YouTube lookup unavailable; keeping native links'); }
      }
      if (rewritten === message.content && !youtube.size) return;
      const body = formatLinkRepost(rewritten, message.author.id, replyUrl);
      const translated = translateTweet && preferences.translateTweets !== false && activePlatforms.includes('x') &&
        !message.flags.has(MessageFlags.SuppressEmbeds)
        ? await translateRepost(message.content, activePlatforms, translateTweet,
          MAX_CONTENT_LENGTH - (body.length - rewritten.length)) : { content: rewritten };
      if (!translated) {
        log.warn(context, 'Keeping original: source context and every media link exceed the message limit');
        return;
      }
      const canonical = mapLinks(translated.content, (url, position) => {
        const video = parseYouTubeUrl(url);
        return video && youtube.has(video.id) && visibleLink(translated.content, position) ? video.url : url;
      });
      const formatted = formatLinkRepost(canonical, message.author.id, replyUrl);
      const content = formatted.length <= MAX_CONTENT_LENGTH ? formatted : body;
      const youtubeCards = youtubeLinks.filter(link => youtube.has(link.id))
        .map(link => formatYouTubeStatistics(youtube.get(link.id)!, link.url))
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
        allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
        nonce: message.id,
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
      if (!enabled()) {
        await removeReplacement();
        return;
      }
      if (replacement.attachments.size !== files.length) {
        log.warn(resultContext, 'Keeping original: repost did not contain every attachment');
        return;
      }
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
        return;
      }
      if (reply) {
        log.info(resultContext, 'Replied with fixed social links; kept original message');
      } else {
        // Sending, checking and deleting are separate Discord requests, not a transaction.
        await latest.delete();
        log.info(resultContext, 'Replaced social links and deleted original message');
      }
    } catch (err) {
      log.error({ ...context, err }, 'link replacement failed; no further deletion will be attempted');
    } finally {
      inFlight.delete(message.id);
    }
  };
}
