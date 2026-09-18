import { ApplicationIntegrationType, InteractionContextType, MessageFlags, SlashCommandBuilder,
  type ChatInputCommandInteraction } from 'discord.js';
import type { PersonalPreferences } from '../services/PersonalPreferences';

export const data = new SlashCommandBuilder()
  .setName('autofix').setDescription('Privately view or change automatic fixing for your messages in this server.')
  .setContexts(InteractionContextType.Guild).setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .addBooleanOption(option => option.setName('enabled').setDescription('Off skips your messages here; on restores automatic fixing.'));

export async function execute(interaction: ChatInputCommandInteraction, preferences: PersonalPreferences,
  guildActive: (guildId: string) => boolean = () => true): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: 'Use /autofix in the server where you want to change your preference.',
      flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return;
  }
  const enabled = interaction.options.getBoolean('enabled');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  // A guild can depart while Discord acknowledges the command. The check and write enqueue are synchronous.
  if (!guildActive(interaction.guildId)) {
    await interaction.editReply({ content: 'Linky is no longer in this server. Your preference was not saved.',
      allowedMentions: { parse: [] } });
    return;
  }
  if (enabled !== null) {
    try { await preferences.setOptedOut(interaction.guildId, interaction.user.id, !enabled); }
    catch (err) {
      await interaction.editReply({ content: 'Could not save your preference. Your previous choice is unchanged. Try again later.',
        allowedMentions: { parse: [] } });
      throw err;
    }
  }
  const off = preferences.isOptedOut(interaction.guildId, interaction.user.id);
  await interaction.editReply({ content: [
    off ? 'Automatic fixing is off for your messages in this server. Use /autofix enabled:true to turn it back on.'
      : 'Automatic fixing is on for your messages wherever Linky is enabled in this server. Use /autofix enabled:false to turn it off.',
    'Your choice is private and applies only to you in this server. /fix and Fix with Linky remain available. Existing previews are unchanged.',
    off ? 'Linky stores only this server ID and your account ID while automatic fixing is off. Turning it on deletes that record; removing Linky from the server deletes its personal preferences.'
      : 'No personal opt-out record is retained for you in this server.',
  ].join('\n\n'), allowedMentions: { parse: [] } });
}
