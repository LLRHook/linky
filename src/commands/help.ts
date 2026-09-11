import { SlashCommandBuilder, MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import type { Config } from '../config';
import type { ServerSettings } from '../services/ServerSettings';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Show how link fixing and tweet translation work.');

export async function execute(interaction: ChatInputCommandInteraction, settings: Config, servers: ServerSettings): Promise<void> {
  const override = interaction.guildId ? servers.get(interaction.guildId) : undefined;
  const serverEnabled = interaction.guildId !== null && (override ?? settings.serverIds.includes(interaction.guildId));
  const enabled = interaction.guildId !== null && (override ?? (settings.channelIds.includes(interaction.channelId) || serverEnabled));
  const platforms = settings.rewritePlatforms.map(platform => ({ x: 'X', instagram: 'Instagram', tiktok: 'TikTok' })[platform]);
  await interaction.reply({
    content: [
      '**Linky**',
      serverEnabled ? 'Link fixing is enabled throughout this server wherever I have channel permissions.' :
        enabled ? 'Link fixing is enabled in this channel.' : 'Link fixing is disabled in this channel.',
      platforms.length ? `Supported platforms: ${platforms.join(', ')}.` : 'All platforms are currently disabled.',
      'Post a supported link and I will repost it with a working preview, remove tracking parameters, and credit you. The original is removed only after the replacement succeeds.',
      settings.translateTweets ? 'Non-English tweets are shown in English with a small source-language label when translation is available.' : 'English translation is currently disabled.',
      'I stay silent when joining a server.',
      'Admins with Manage Server permission can use /setup enabled:true or /setup enabled:false to enable or disable this entire server.',
    ].join('\n\n'),
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}
