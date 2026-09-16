import { MessageFlags, PermissionFlagsBits, type ButtonInteraction, type Message } from 'discord.js';
import type { Config } from '../config';
import type { AlbumOwner } from './EromeAlbumSessions';
import { canPreviewErome, findEromeLinks } from './EromeDelivery';
import { evaluateScope } from './ServerScope';
import type { ServerSettings } from './ServerSettings';
import { bypassLinky } from './SocialLinkService';

export interface EromeAlbumPolicyOptions {
  settings: Pick<Config, 'rewritePlatforms' | 'channelIds' | 'serverIds'>;
  servers: Pick<ServerSettings, 'get' | 'getPreferences'>;
  fetchMessage: (channelId: string, messageId: string) => Promise<Pick<Message, 'id' | 'channelId' | 'content' | 'author' | 'webhookId' | 'flags'> | null>;
  signal?: AbortSignal;
}

/** Recheck public album actions against current channel, member, source and server policy. */
export function createEromeAlbumPolicy({ settings, servers, fetchMessage, signal }: EromeAlbumPolicyOptions) {
  return async (owner: AlbumOwner, interaction: ButtonInteraction): Promise<boolean> => {
    const actorId = interaction.user.id;
    const active = () => !signal?.aborted && interaction.guild?.id === owner.guildId &&
      interaction.guildId === owner.guildId && interaction.channelId === owner.channelId && interaction.user.id === actorId;
    if (!active() || !settings.rewritePlatforms.includes('erome')) return false;
    try {
      const channel = await interaction.guild!.channels.fetch(owner.channelId, { force: true });
      if (!active() || !channel || channel.id !== owner.channelId || channel.guildId !== owner.guildId) return false;
      const actor = await interaction.guild!.members.fetch({ user: actorId, force: true });
      const allowed = () => {
        const preferences = servers.getPreferences(owner.guildId);
        const send = channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
        const member = interaction.guild!.members.me;
        return active() && settings.rewritePlatforms.includes('erome') && actor.id === actorId &&
          (actor.communicationDisabledUntilTimestamp ?? 0) <= Date.now() &&
          canPreviewErome(channel, preferences.eromeChannels) &&
          Boolean(channel.permissionsFor(actor)?.has([PermissionFlagsBits.ViewChannel, send])) &&
          Boolean(member && channel.permissionsFor(member)?.has([PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles, send])) &&
          (owner.mode === 'manual' || preferences.platforms?.erome !== false && evaluateScope({
            guildId: owner.guildId, channelId: owner.channelId, threadParentId: channel.isThread() ? channel.parentId : undefined,
            serverEnabled: servers.get(owner.guildId), preferences,
            operatorChannelIds: settings.channelIds, operatorServerIds: settings.serverIds,
          }).enabled);
      };
      if (!allowed()) return false;
      if (owner.sourceMessageId) {
        const source = await fetchMessage(owner.channelId, owner.sourceMessageId);
        if (!allowed() || !source || source.id !== owner.sourceMessageId || source.channelId !== owner.channelId ||
          !findEromeLinks(source.content).includes(owner.source) || owner.mode === 'automatic' &&
          (source.author.id !== owner.requesterId || source.author.bot || source.webhookId ||
            source.flags.has(MessageFlags.SuppressEmbeds) || bypassLinky(source.content))) return false;
      }
      return allowed();
    } catch { return false; }
  };
}
