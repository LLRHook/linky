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
const TRANSLATE_TIMEOUT_MS = 5_000;
const TRANSLATE_TARGET_LANG = 'en';
const RECENT_MESSAGE_LIMIT = 1_000;
const DISCORD_CHANNEL_ID = /^[1-9]\d{16,19}$/;
// Discord's IS_SPOILER attachment flag is not named in the installed v14 enum.
// https://docs.discord.com/developers/resources/message#attachment-object
const ATTACHMENT_IS_SPOILER = 1 << 3;

/** Keep sentence punctuation and paired Markdown outside a URL's query string. */
function urlWithoutSuffix(url: string, prefix: string): string {
  const active = new Set<string>();
  const unescaped = (text: string) => (text.match(/\\*$/)?.[0].length ?? 0) % 2 === 0;
  for (const match of prefix.matchAll(/\*{1,3}|_{1,2}|~~|\|\|/g)) {
    if (unescaped(prefix.slice(0, match.index))) {
      if (!active.delete(match[0])) active.add(match[0]);
    }
  }
  let link = url.replace(/[.,!?:;]+$/, '');
  let marker: string | undefined;
  while ((marker = link.match(/(\*{1,3}|_{1,2}|~~|\|\|)$/)?.[0]) &&
    unescaped(link.slice(0, -marker.length)) && active.delete(marker)) {
    link = link.slice(0, -marker.length).replace(/[.,!?:;]+$/, '');
  }
  return link;
}

/** Rewrite literal HTTPS x.com links, dropping queries but retaining text and fragments. */
export function rewriteXLinks(content: string): string {
  return mapLinks(content, (url) => /^https:\/\/x\.com(?=[/?#]|$)/i.test(url)
    // A question mark after # belongs to the fragment, not the query.
    ? url.replace(/^https:\/\/x\.com/i, 'https://fixupx.com').replace(/^([^?#]*)\?[^#]*/, '$1') : url);
}

/** Visit complete URL tokens, preserving surrounding text and nested URLs. */
function mapLinks(content: string, transform: (url: string) => string): string {
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
    const withoutPunctuation = urlWithoutSuffix(url,
      content.slice(content.lastIndexOf('\n', match.index - 1) + 1, match.index));
    rewritten += content.slice(cursor, match.index) + transform(withoutPunctuation) +
      url.slice(withoutPunctuation.length);
    cursor = end;
    schemes.lastIndex = end;
  }
  return rewritten + content.slice(cursor);
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

function tweetLanguage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const language = value.toLowerCase();
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(language) &&
    !['und', 'zxx', 'mul'].includes(language) ? language : null;
}

/** Read the language from FxEmbed's v2 status response, failing open on errors. */
export async function fetchTweetLang(
  statusId: string,
  fetchJson: typeof fetch = fetch
): Promise<string | null> {
  try {
    const response = await fetchJson(`https://api.fxtwitter.com/2/status/${statusId}`, {
      signal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const json = await response.json() as { code?: unknown; status?: { type?: unknown; lang?: unknown } };
    return json?.code === 200 && json.status?.type === 'status'
      ? tweetLanguage(json.status.lang) : null;
  } catch {
    return null;
  }
}

/**
 * Add FxEmbed's translation modifier to original x.com status links before rewriting
 * their host. Existing fixer links and URLs nested inside other URLs stay untouched.
 */
export async function addTranslationSuffixes(
  content: string,
  fetchLang: (statusId: string) => Promise<string | null> = fetchTweetLang
): Promise<string> {
  const statusLink = /^https:\/\/x\.com\/[^\s/?#]+\/status\/(\d+)(?=[?#]|$)/i;
  const statusIds = new Set<string>();
  mapLinks(content, (url) => {
    const id = statusLink.exec(url)?.[1];
    if (id) statusIds.add(id);
    return url;
  });
  const langs = new Map<string, string | null>();
  await Promise.all([...statusIds].map(async (statusId) => {
    try { langs.set(statusId, tweetLanguage(await fetchLang(statusId))); }
    catch { langs.set(statusId, null); }
  }));
  return mapLinks(content, (url) => {
    const match = statusLink.exec(url);
    const lang = match && langs.get(match[1]);
    return lang && lang.split('-')[0] !== TRANSLATE_TARGET_LANG
      ? url.replace(match![0], `${match![0]}/${TRANSLATE_TARGET_LANG}`) : url;
  });
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
  { translateLang }: { translateLang?: (statusId: string) => Promise<string | null> } = {}
): (message: Message) => Promise<void> {
  const allowedChannelIds = new Set(typeof channelIds === 'string' ? [channelIds] : channelIds);
  const inFlight = new Set<string>();
  const reposted = new Set<string>();

  return async (message) => {
    if (!allowedChannelIds.has(message.channelId) || !message.inGuild() ||
        !canCopy(message) || inFlight.has(message.id) || reposted.has(message.id)) return;
    const rewritten = rewriteXLinks(message.content);
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
      // Discord can mutate this cached message while a language lookup is pending.
      const version = sourceVersion(message);
      const translated = translateLang
        ? rewriteXLinks(await addTranslationSuffixes(message.content, translateLang)) : rewritten;
      const content = formatXLinkRepost(translated, message.author.id, replyUrl);
      const attachments = [...message.attachments.values()];
      if (content.length > MAX_CONTENT_LENGTH || attachments.length > 10 ||
          attachments.reduce((total, attachment) => total + attachment.size, 0) > MAX_ATTACHMENT_BYTES) {
        log.warn(context, 'Skipping X link replacement: content or attachments exceed copy limits');
        return;
      }

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
