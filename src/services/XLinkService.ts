import {
  Attachment,
  AttachmentBuilder,
  Message,
  MessageFlags,
  MessageType,
  PermissionFlagsBits,
} from 'discord.js';
import type { Logger } from 'pino';

const MAX_CONTENT_LENGTH = 2_000;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const RECENT_MESSAGE_LIMIT = 1_000;
const DISCORD_CHANNEL_ID = /^[1-9]\d{16,19}$/;
// Discord's IS_SPOILER attachment flag is not named in the installed v14 enum.
// https://docs.discord.com/developers/resources/message#attachment-object
const ATTACHMENT_IS_SPOILER = 1 << 3;

export const REWRITE_PLATFORMS = ['x', 'instagram', 'tiktok'] as const;
export type RewritePlatform = typeof REWRITE_PLATFORMS[number];

interface Platform {
  name: RewritePlatform;
  /** An allowed subdomain plus the literal apex host, anchored at the scheme. */
  host: RegExp;
  /** Replacement authority. Fixers are apex-only, so a matched subdomain is dropped. */
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
    fixer: 'https://kkclip.com',
    path: /^\/(?:(?:p|reels?|tv)\/[\w-]+|share\/(?:reel\/)?[\w-]+)\/?$/,
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

/** Change only a literal HTTPS authority of an enabled platform, leaving all other bytes intact. */
export function rewriteSocialLinks(
  content: string,
  platforms: readonly RewritePlatform[] = REWRITE_PLATFORMS
): string {
  const enabled = new Set(platforms);
  const schemes = /[a-z][a-z\d+.-]*:\/\//gi;
  let rewritten = '';
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = schemes.exec(content)) !== null) {
    let end = schemes.lastIndex;
    const closing: string[] = [];
    // Balanced punctuation can belong to a URL. An unmatched closing delimiter
    // ends a Markdown link, allowing an adjacent link to be processed separately.
    while (end < content.length && !/[\s<>"`]/.test(content[end])) {
      const char = content[end];
      const opening = '([{'.indexOf(char);
      if (opening !== -1) closing.push(')]}'[opening]);
      else if (')]}'.includes(char)) {
        if (closing.pop() !== char) break;
      }
      end++;
    }
    // Consume other URLs too, including URLs nested inside their paths/queries.
    const url = content.slice(match.index, end);
    rewritten += content.slice(cursor, match.index) + (rewriteUrl(url, enabled) ?? url);
    cursor = end;
    schemes.lastIndex = end;
  }
  return rewritten + content.slice(cursor);
}

function rewriteUrl(url: string, enabled: ReadonlySet<RewritePlatform>): string | undefined {
  const sentenceEnd = /[.,!?:;}]+$/;
  for (const platform of PLATFORMS) {
    if (!enabled.has(platform.name)) continue;
    // Trailing sentence punctuation is not part of the authority, but is kept in the output.
    const host = platform.host.exec(url.replace(sentenceEnd, ''));
    if (!host) continue;
    // The query string is share/tracking noise (?s=..&t=..); drop it, keeping any fragment.
    const rest = url.slice(host[0].length).replace(/\?[^#]*/, '');
    if (platform.path && !platform.path.test(rest.split('#', 1)[0].replace(sentenceEnd, ''))) continue;
    return platform.fixer + rest;
  }
  return undefined;
}

/** Quote plain leading context without pulling apart existing Markdown or URLs. */
export function formatXLinkRepost(content: string, authorId: string, replyUrl?: string): string {
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

function isSpoiler(attachment: Attachment): boolean {
  return attachment.spoiler || (attachment.flags.bitfield & ATTACHMENT_IS_SPOILER) !== 0;
}

/** Reject malformed scope instead of accidentally processing unrelated channels. */
export function parseFixupXChannelId(value: string | undefined): string | undefined {
  const channelId = value?.trim();
  if (!channelId) return undefined;
  if (!DISCORD_CHANNEL_ID.test(channelId)) {
    throw new Error('FIXUPX_CHANNEL_ID must be a Discord channel ID (17-20 digits).');
  }
  return channelId;
}

/** Combine explicit channels with the legacy setting; malformed lists fail closed. */
export function parseFixupXChannelIds(
  value: string | undefined,
  legacyValue?: string
): string[] {
  const channelIds = new Set<string>();
  const legacyChannelId = parseFixupXChannelId(legacyValue);
  if (legacyChannelId) channelIds.add(legacyChannelId);
  if (value?.trim()) {
    for (const entry of value.split(',')) {
      const channelId = entry.trim();
      if (!DISCORD_CHANNEL_ID.test(channelId)) {
        throw new Error('FIXUPX_CHANNEL_IDS must be comma-separated Discord channel IDs (17-20 digits), with no empty entries.');
      }
      channelIds.add(channelId);
    }
  }
  return [...channelIds];
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

export function createXLinkHandler(
  channelIds: readonly string[] | string | undefined,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
  copyAttachment: (attachment: Attachment) => Promise<AttachmentBuilder> = downloadAttachment,
  platforms: readonly RewritePlatform[] = REWRITE_PLATFORMS
): (message: Message) => Promise<void> {
  const allowedChannelIds = new Set(typeof channelIds === 'string' ? [channelIds] : channelIds);
  const inFlight = new Set<string>();
  const reposted = new Set<string>();

  return async (message) => {
    if (!allowedChannelIds.has(message.channelId) || !message.inGuild() ||
        !canCopy(message) || inFlight.has(message.id) || reposted.has(message.id)) return;
    const rewritten = rewriteSocialLinks(message.content, platforms);
    if (rewritten === message.content) return;

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
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.EmbedLinks,
        channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages,
      ];
      if (message.attachments.size) required.push(PermissionFlagsBits.AttachFiles);
      if (!message.deletable || !permissions?.has(required)) {
        log.warn(context, 'Skipping X link replacement: missing channel permissions');
        return;
      }

      // IDs provide unambiguous credit without interpolating user-controlled display names.
      const replyUrl = message.reference?.messageId
        ? `https://discord.com/channels/${message.guildId}/${message.reference.channelId ?? channelId}/${message.reference.messageId}`
        : undefined;
      const content = formatXLinkRepost(rewritten, message.author.id, replyUrl);
      const attachments = [...message.attachments.values()];
      if (content.length > MAX_CONTENT_LENGTH || attachments.length > 10 ||
          attachments.reduce((total, attachment) => total + attachment.size, 0) > MAX_ATTACHMENT_BYTES) {
        log.warn(context, 'Skipping X link replacement: content or attachments exceed copy limits');
        return;
      }

      const version = sourceVersion(message);
      const files: AttachmentBuilder[] = [];
      for (const attachment of attachments) files.push(await copyAttachment(attachment));
      const replacement = await channel.send({
        content,
        files,
        allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
        nonce: message.id,
        enforceNonce: true,
        ...(message.flags.has(MessageFlags.SuppressEmbeds) ? { flags: MessageFlags.SuppressEmbeds } : {}),
      });

      // Remember successes even when deletion fails. The nonce also guards REST retries.
      reposted.add(message.id);
      if (reposted.size > RECENT_MESSAGE_LIMIT) reposted.delete(reposted.values().next().value!);
      const resultContext = { ...context, replacementId: replacement.id };
      if (replacement.attachments.size !== attachments.length) {
        log.warn(resultContext, 'Keeping original: repost did not contain every attachment');
        return;
      }
      let latest: Message;
      try {
        latest = await message.fetch(true);
      } catch (err) {
        if (typeof err === 'object' && err !== null && 'code' in err && err.code === 10008) {
          log.info(resultContext, 'Removing repost: original was deleted during copying');
          await replacement.delete();
          return;
        }
        throw err;
      }
      if (!canCopy(latest) || sourceVersion(latest) !== version) {
        log.warn(resultContext, 'Keeping original: message changed while reposting');
        await replacement.delete();
        return;
      }
      // Sending, checking and deleting are separate Discord requests, not a transaction.
      await latest.delete();
      log.info(resultContext, 'Replaced X links and deleted original message');
    } catch (err) {
      log.error({ ...context, err }, 'X link replacement failed; no further deletion will be attempted');
    } finally {
      inFlight.delete(message.id);
    }
  };
}
