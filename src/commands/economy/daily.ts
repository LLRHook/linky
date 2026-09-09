import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from 'discord.js';
import { getDb } from '../../db/connection';
import { claimDaily, touchPlayer } from '../../services/PlayerService';
import { audit } from '../../services/AuditService';
import { dailyEmbed, errorEmbed } from '../../ui/embeds';

export const data = new SlashCommandBuilder()
  .setName('daily')
  .setDescription('Claim your daily $5.00 bonus. Resets at UTC midnight.');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const db = getDb();
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;

  const result = claimDaily(db, guildId, userId);

  if (!result.success) {
    await interaction.editReply({
      embeds: [errorEmbed(result.error!)],
    });
    return;
  }

  await interaction.editReply({
    embeds: [dailyEmbed(interaction.user, result.newBalance!)],
  });

  touchPlayer(db, guildId, userId);

  audit(db, {
    guildId,
    actorId: userId,
    actionType: 'DAILY_CLAIM',
    payload: { newBalance: result.newBalance },
  });
}
