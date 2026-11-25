import { evaluateScope, type ScopeInput } from './ServerScope';
import { ComponentType, type ButtonInteraction, type Message } from 'discord.js';
import type { ReplyPage, ReplyTarget } from './ReplyThreads';
import { repliesChannel } from './ReplyThreads';
import type { YouTubeDisplay } from './YouTube';

export function youtubeCommentsScopeEnabled(input: ScopeInput, operatorYouTube: boolean): boolean {
  return operatorYouTube && input.preferences?.platforms?.youtube !== false && evaluateScope(input).enabled;
}

export function youtubeCommentsEnabled(replies: boolean, display: YouTubeDisplay, hasKey: boolean, channelType: number): boolean {
  return replies && display === 'counts-and-comment' && hasKey && repliesChannel(channelType);
}
/** Read the exact publish count from the bot's control; keep the ticket's stable custom ID. */
export function youtubeReplyTarget(interaction: ButtonInteraction, options: {
  enabled: (message: Message) => boolean;
  canView: (message: Message, id: string) => boolean;
  lookup?: (id: string, count: string, time: number) => Promise<ReplyPage | null>;
}): ReplyTarget | undefined {
  const id = /^linky:yt:replies:([\w-]{11})$/.exec(interaction.customId)?.[1];
  if (!id) return undefined;
  const button = interaction.message.components.filter(row => row.type === ComponentType.ActionRow).flatMap(row => row.components)
    .find(button => 'customId' in button && button.customId === interaction.customId);
  const count = button && 'label' in button ? /^Comments \((\d{1,20})\)$/.exec(button.label ?? '')?.[1] : undefined;
  return { id, handle: '', name: 'YouTube comments',
    valid: message => Boolean(count && BigInt(count) > 0n && options.lookup && options.enabled(message) && options.canView(message, id)),
    lookup: () => options.lookup!(id, count!, interaction.message.createdTimestamp) };
}
