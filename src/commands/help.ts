import { SlashCommandBuilder, MessageFlags, ApplicationIntegrationType, InteractionContextType, type ChatInputCommandInteraction } from 'discord.js';
import type { Config } from '../config';
import type { ServerSettings } from '../services/ServerSettings';
import { effectivePreferences, PLATFORM_NAMES } from './settings';
import { evaluateScope } from '../services/ServerScope';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Show how link fixing and tweet translation work.')
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
  .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel);

export async function execute(interaction: ChatInputCommandInteraction, settings: Config, servers: ServerSettings): Promise<void> {
  const override = interaction.guildId ? servers.get(interaction.guildId) : undefined;
  const saved = interaction.guildId ? servers.getPreferences(interaction.guildId) : {};
  const scope = evaluateScope({ guildId: interaction.guildId ?? '', channelId: interaction.channelId,
    threadParentId: interaction.channel?.isThread() ? interaction.channel.parentId : undefined,
    serverEnabled: override, preferences: saved, operatorChannelIds: settings.channelIds, operatorServerIds: settings.serverIds });
  const enabled = interaction.guildId !== null && scope.enabled;
  const serverEnabled = enabled && saved.channelIds === undefined && ['server', 'operator-server'].includes(scope.source);
  const preferences = effectivePreferences(settings, saved);
  const platforms = preferences.platforms.map(platform => PLATFORM_NAMES[platform]);
  await interaction.reply({
    content: [
      '**Linky**',
      serverEnabled ? 'Link fixing is enabled throughout this server wherever I have channel permissions.' :
        enabled ? 'Link fixing is enabled in this channel.' : 'Link fixing is disabled in this channel.',
      platforms.length ? `Supported platforms: ${platforms.join(', ')}.` : 'All platforms are currently disabled.',
      preferences.mode === 'reply'
        ? 'Post a supported link and I will reply with a cleaned link or available preview, keeping your original message.'
        : 'Post a supported link and I will repost it with a cleaned link or available preview and credit you. The original is removed only after the replacement succeeds.',
      'Automatic fixing checks for a useful preview before removing an original. Video playback can still depend on Discord and the provider.',
      preferences.translateTweets ? 'Non-English tweets are shown in English with a small source-language label when translation is available.' : 'English translation is currently disabled.',
      'I stay silent when joining a server.',
      'Use !nolinky anywhere in a message to skip it. Links inside <angle brackets>, code or spoilers are left alone.',
      'Use /fix link: or a message’s Apps → Fix with Linky action for an explicit preview. Personal installation only runs commands you invoke; it never monitors DMs.',
      'Admins with Manage Server permission can open /setup for channels, mode and platforms; use /diagnose to check a problem. /settings also controls YouTube preview only, counts, or counts plus comment.',
    ].join('\n\n'),
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}
