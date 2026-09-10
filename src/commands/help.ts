import { SlashCommandBuilder, MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import type { Config } from '../config';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Show how link fixing and tweet translation work.');

export async function execute(interaction: ChatInputCommandInteraction, settings: Config): Promise<void> {
  const enabled = settings.channelIds.includes(interaction.channelId);
  const platforms = settings.rewritePlatforms.map(platform => ({ x: 'X', instagram: 'Instagram', tiktok: 'TikTok' })[platform]);
  await interaction.reply({
    content: [
      '**Linky**',
      enabled ? 'Link fixing is enabled in this channel.' : 'Link fixing is disabled in this channel. Ask the bot operator to enable it here.',
      platforms.length ? `Supported platforms: ${platforms.join(', ')}.` : 'All platforms are currently disabled.',
      'Post a supported link and I will repost it with a working preview, remove tracking parameters, and credit you. The original is removed only after the replacement succeeds.',
      settings.translateTweets ? 'Non-English tweets are shown in English with a small source-language label when translation is available.' : 'English translation is currently disabled.',
      'I stay silent when joining a server.',
    ].join('\n\n'),
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}
