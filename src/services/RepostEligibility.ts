import { MessageFlags, MessageType, type Message } from 'discord.js';
import { isSpoiler } from './RepostAttachments';

export function bypassLinky(content: string): boolean {
  return /(?:^|\s)!nolinky(?=\s|$)/i.test(content);
}

export function canCopy(message: Message): boolean {
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

export function sourceVersion(message: Message): string {
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
