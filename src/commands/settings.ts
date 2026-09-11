import { SlashCommandBuilder, MessageFlags, PermissionFlagsBits, InteractionContextType, ApplicationIntegrationType, type ChatInputCommandInteraction } from 'discord.js';
import type { Config } from '../config';
import type { ServerPreferences, ServerSettings } from '../services/ServerSettings';
import { REWRITE_PLATFORMS } from '../services/SocialLinkService';

export const PLATFORM_NAMES = { x: 'X', instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube' };

export function effectivePreferences(config: Config, preferences: ServerPreferences) {
  const platforms = config.rewritePlatforms.filter(platform => preferences.platforms?.[platform] !== false);
  return {
    mode: preferences.mode ?? 'replace',
    platforms,
    translateTweets: config.translateTweets && preferences.translateTweets !== false && platforms.includes('x'),
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
  .addBooleanOption(option => option.setName('translate_tweets').setDescription('Translate non-English tweets when enabled by the bot operator.'));

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
  const override = servers.get(interaction.guildId);
  const scope = override === true ? 'Enabled throughout this server where Linky has channel permissions.' :
    override === false ? 'Disabled throughout this server.' :
      config.serverIds.includes(interaction.guildId) ? 'Enabled throughout this server by the bot operator, subject to channel permissions.' :
        config.channelIds.includes(interaction.channelId) ? 'Enabled in this channel by the bot operator; other channels follow the operator’s configuration.' :
          'Disabled in this channel; any operator-configured channels keep their existing scope.';
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
      'Use /setup enabled:true or /setup enabled:false to change server enablement. Preview availability depends on the source and preview provider.',
    ].join('\n'),
    allowedMentions: { parse: [] },
  });
}
