import { SlashCommandBuilder, MessageFlags, PermissionFlagsBits, InteractionContextType, ApplicationIntegrationType, type ChatInputCommandInteraction } from 'discord.js';
import type { Config } from '../config';
import type { ServerPreferences, ServerSettings } from '../services/ServerSettings';
import { REWRITE_PLATFORMS } from '../services/SocialLinkService';
import { describeScope, evaluateScope } from '../services/ServerScope';

export const PLATFORM_NAMES = { x: 'X', instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube',
  bluesky: 'Bluesky', reddit: 'Reddit', twitch: 'Twitch clips' };

export function effectivePreferences(config: Config, preferences: ServerPreferences) {
  const platforms = config.rewritePlatforms.filter(platform => preferences.platforms?.[platform] !== false);
  return {
    mode: preferences.mode ?? 'replace',
    platforms,
    translateTweets: config.translateTweets && preferences.translateTweets !== false && platforms.includes('x'),
    translateInstagram: Boolean(config.translateInstagram && config.captionApiKey?.trim()) &&
      preferences.translateInstagram !== false && platforms.includes('instagram'),
    youtubeDisplay: preferences.youtubeDisplay ?? 'counts-and-comment',
  };
}

export const data = new SlashCommandBuilder()
  .setName('settings')
  .setDescription('View or change this server’s link preferences without enabling it.')
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption(option => option.setName('mode').setDescription('Replace the original message or keep it and reply.')
    .addChoices({ name: 'Replace', value: 'replace' }, { name: 'Reply', value: 'reply' }))
  .addBooleanOption(option => option.setName('instagram').setDescription('Fix Instagram links in this server.'))
  .addBooleanOption(option => option.setName('tiktok').setDescription('Fix TikTok links in this server.'))
  .addBooleanOption(option => option.setName('x').setDescription('Fix X links in this server.'))
  .addBooleanOption(option => option.setName('youtube').setDescription('Fix YouTube links when available from the bot operator.'))
  .addBooleanOption(option => option.setName('bluesky').setDescription('Fix Bluesky post previews in this server.'))
  .addBooleanOption(option => option.setName('reddit').setDescription('Fix Reddit post previews in this server.'))
  .addBooleanOption(option => option.setName('twitch').setDescription('Fix Twitch clip previews in this server.'))
  .addBooleanOption(option => option.setName('translate_tweets').setDescription('Translate non-English tweets when enabled by the bot operator.'))
  .addBooleanOption(option => option.setName('translate_instagram').setDescription('Translate non-English Instagram captions when enabled by the bot operator.'))
  .addStringOption(option => option.setName('youtube_display').setDescription('Choose the extra details shown with YouTube previews.')
    .addChoices({ name: 'Preview only', value: 'preview' }, { name: 'Counts only', value: 'counts' },
      { name: 'Counts and top comment', value: 'counts-and-comment' }));

export async function execute(interaction: ChatInputCommandInteraction, config: Config, servers: ServerSettings): Promise<void> {
  if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: 'Use /settings in a server where you have Manage Server permission.',
      flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] },
    });
    return;
  }
  const patch: ServerPreferences = {};
  const mode = interaction.options.getString('mode');
  if (mode !== null) patch.mode = mode as ServerPreferences['mode'];
  for (const platform of REWRITE_PLATFORMS) {
    const enabled = interaction.options.getBoolean(platform);
    if (enabled !== null) (patch.platforms ??= {})[platform] = enabled;
  }
  const translateTweets = interaction.options.getBoolean('translate_tweets');
  if (translateTweets !== null) patch.translateTweets = translateTweets;
  const translateInstagram = interaction.options.getBoolean('translate_instagram');
  if (translateInstagram !== null) patch.translateInstagram = translateInstagram;
  const youtubeDisplay = interaction.options.getString('youtube_display');
  if (youtubeDisplay !== null) patch.youtubeDisplay = youtubeDisplay as ServerPreferences['youtubeDisplay'];
  const changed = Object.keys(patch).length > 0;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (changed) {
    try {
      await servers.update(interaction.guildId, patch);
    } catch (err) {
      await interaction.editReply({
        content: 'Could not save these preferences. Linky’s previous configuration is unchanged. Try again or contact the bot operator.',
        allowedMentions: { parse: [] },
      });
      throw err;
    }
  }
  const preferences = servers.getPreferences(interaction.guildId);
  const effective = effectivePreferences(config, preferences);
  const scope = describeScope(evaluateScope({ guildId: interaction.guildId, channelId: interaction.channelId,
    threadParentId: interaction.channel?.isThread() ? interaction.channel.parentId : undefined,
    serverEnabled: servers.get(interaction.guildId), preferences,
    operatorChannelIds: config.channelIds, operatorServerIds: config.serverIds }));
  await interaction.editReply({
    content: [
      changed ? 'Server preferences saved. Enablement and channel scope are unchanged.' : 'Current server preferences:',
      scope,
      `Mode: ${effective.mode === 'reply' ? 'Reply (keep the original message).' : 'Replace (remove the original only after a replacement is sent).'}`,
      ...REWRITE_PLATFORMS.map(platform => `${PLATFORM_NAMES[platform]}: ${effective.platforms.includes(platform) ? 'On' :
        !config.rewritePlatforms.includes(platform) ? 'Off (disabled by the bot operator)' : 'Off'}.`),
      `English tweet translation: ${effective.translateTweets ? 'On when translation is available' :
        !config.translateTweets ? 'Off (disabled by the bot operator)' :
          !effective.platforms.includes('x') ? 'Off (X link fixing is disabled)' : 'Off'}.`,
      `English Instagram caption translation: ${effective.translateInstagram ? 'On when translation and media are available' :
        !config.translateInstagram || !config.captionApiKey?.trim() ? 'Off (unavailable from the bot operator)' :
          !effective.platforms.includes('instagram') ? 'Off (Instagram link fixing is disabled)' : 'Off'}.`,
      `YouTube display: ${effective.youtubeDisplay === 'preview' ? 'Preview only' :
        effective.youtubeDisplay === 'counts' ? 'Counts only' : 'Counts and top comment'}${effective.platforms.includes('youtube') ? '.' : ' (YouTube is currently off).'}`,
      'Use /setup to choose channels or change server enablement. Preview availability depends on the source and preview provider.',
    ].join('\n'),
    allowedMentions: { parse: [] },
  });
}
