import { SlashCommandBuilder, MessageFlags, ApplicationIntegrationType, InteractionContextType, type ChatInputCommandInteraction } from 'discord.js';
import type { Config } from '../config';
import type { ServerSettings } from '../services/ServerSettings';
import { effectivePreferences, PLATFORM_NAMES } from './settings';
import { evaluateScope } from '../services/ServerScope';
import { EROME_UNAVAILABLE, isEromeAvailable } from '../services/EromeAvailability';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Show how link fixing and translation work.')
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
  const preferences = effectivePreferences(settings, saved, interaction.guildId);
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
      isEromeAvailable(settings, interaction.guildId)
        ? 'Automatic Erome previews follow Replace or Reply. Original post opens the album; eligible members can use hosted Load next item. Failures, manual fixes and retries keep the source. Age-restricted channels are the default; admins can use /settings erome_channels:all. No DMs. Limits: 64 MiB and five minutes. Slow jobs show progress.' : EROME_UNAVAILABLE,
      'Retry preview requires channel access, send permission and no timeout. Details opens a private report. Only the original sharer or manual requester can use Remove.',
      preferences.translateTweets ? 'Non-English tweets are shown in English with a small source-language label when translation is available.' : 'X translation is currently disabled.',
      preferences.instagramPresentation === 'media-first' ? 'Instagram uses Media-first: caption-free provider media, including when translation is off. If that media cannot be verified, the original stays.' :
        preferences.translateInstagram ? `Non-English Instagram captions are shown in English when translation and media are available: up to ${preferences.instagramPresentation === 'compact' ? 120 : 300} characters with a language label. Original post opens the source caption.` : 'Instagram caption translation is currently disabled. Native provider captions may still appear.',
      'I stay silent when joining a server.',
      'Use !nolinky anywhere in a message to skip it. Links inside <angle brackets>, code or spoilers are left alone.',
      '/autofix enabled:false privately skips your messages in this server. /autofix enabled:true restores it. Manual commands still work.',
      'Use /fix link: or a message’s Apps → Fix with Linky action for an explicit preview. Personal installation only runs commands you invoke; it never monitors DMs.',
      'Admins with Manage Server can open /setup for channels, mode and platforms. Its Test here button posts a sample only when clicked. /diagnose checks privately. /settings controls Instagram Standard, Compact or Media-first and YouTube details.',
    ].join('\n\n'),
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}
