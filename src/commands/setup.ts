import { SlashCommandBuilder, MessageFlags, PermissionFlagsBits, InteractionContextType, ApplicationIntegrationType, type ChatInputCommandInteraction } from 'discord.js';
import type { ServerSettings } from '../services/ServerSettings';

export const data = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Enable or disable Linky throughout this server.')
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addBooleanOption(option => option.setName('enabled').setDescription('Fix links throughout this server.').setRequired(true));

export async function execute(interaction: ChatInputCommandInteraction, servers: ServerSettings): Promise<void> {
  if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: 'Use /setup in a server where you have Manage Server permission.',
      flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] },
    });
    return;
  }
  const enabled = interaction.options.getBoolean('enabled', true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    await servers.set(interaction.guildId, enabled);
  } catch (err) {
    await interaction.editReply({ content: 'Could not save this setting. Linky’s previous configuration is unchanged. Try again or contact the bot operator.', allowedMentions: { parse: [] } });
    throw err;
  }
  await interaction.editReply({
    content: enabled
      ? 'Linky is enabled throughout this server wherever it has channel permissions. New channels and threads are included. Use /help for details.'
      : 'Linky is disabled throughout this server. Use /setup enabled:true to enable it again.',
    allowedMentions: { parse: [] },
  });
}
