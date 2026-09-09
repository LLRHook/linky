import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from 'discord.js';
import { getDb } from '../../db/connection';
import { registerPlayer, touchPlayer } from '../../services/PlayerService';
import { audit } from '../../services/AuditService';
import { errorEmbed, registerEmbed } from '../../ui/embeds';

export const data = new SlashCommandBuilder()
  .setName('register')
  .setDescription('Register in the guild economy and receive your starting balance.');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const db = getDb();
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;

  const result = registerPlayer(db, guildId, userId);

  if (!result.success) {
    await interaction.editReply({
      embeds: [errorEmbed(result.error!)],
    });
    return;
  }

  const balance = result.player?.balance ?? 0;
  await interaction.editReply({
    embeds: [registerEmbed(interaction.user, balance, result.isReactivation)],
  });

  touchPlayer(db, guildId, userId);

  audit(db, {
    guildId,
    actorId: userId,
    actionType: 'PLAYER_REGISTER',
    payload: { isReactivation: result.isReactivation, balance },
  });
}
