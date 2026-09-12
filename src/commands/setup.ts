import { SlashCommandBuilder, MessageFlags, PermissionFlagsBits, InteractionContextType, ApplicationIntegrationType, type ChatInputCommandInteraction } from 'discord.js';
import type { ServerSettings } from '../services/ServerSettings';
import type { Config } from '../config';
import { REWRITE_PLATFORMS } from '../services/SocialLinkService';
import { buildSetupPanel } from './setupPanel';

export const data = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Open Linky’s private setup panel or enable or disable this server.')
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addBooleanOption(option => option.setName('enabled').setDescription('Enable or disable Linky, keeping selected channel restrictions.'));

export async function execute(interaction: ChatInputCommandInteraction, servers: ServerSettings,
  config: Config = { discordToken: '', channelIds: [], serverIds: [], rewritePlatforms: REWRITE_PLATFORMS,
    translateTweets: false, settingsPath: '' }): Promise<void> {
  if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: 'Use /setup in a server where you have Manage Server permission.',
      flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] },
    });
    return;
  }
  const enabled = interaction.options.getBoolean('enabled');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    if (enabled !== null) await servers.set(interaction.guildId, enabled);
  } catch (err) {
    await interaction.editReply({ content: 'Could not save this setting. Linky’s previous configuration is unchanged. Try again or contact the bot operator.', allowedMentions: { parse: [] } });
    throw err;
  }
  const notice = enabled === null ? undefined : enabled
    ? 'Server enabled. Channel selection kept.'
    : 'Server disabled. Your choices are saved.';
  await interaction.editReply(buildSetupPanel({ guildId: interaction.guildId, channelId: interaction.channelId,
    threadParentId: interaction.channel?.isThread() ? interaction.channel.parentId : undefined }, config, servers, notice));
}
