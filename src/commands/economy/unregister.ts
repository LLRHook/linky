import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from 'discord.js';
import { getDb } from '../../db/connection';
import { unregisterPlayer, getGuild, getPlayer } from '../../services/PlayerService';
import { revokeAdmin } from '../../services/ElectionService';
import { audit } from '../../services/AuditService';
import { errorEmbed, unregisterEmbed } from '../../ui/embeds';

export const data = new SlashCommandBuilder()
  .setName('unregister')
  .setDescription('Deactivate your account. Your balance is preserved for re-registration.');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const db = getDb();
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;

  const player = getPlayer(db, guildId, userId);
  if (!player || player.status !== 'active') {
    await interaction.editReply({
      embeds: [errorEmbed('You must be a registered active player to unregister.')],
    });
    return;
  }

  const guild = getGuild(db, guildId);
  const isAdmin = guild?.current_admin_id === userId;

  const result = unregisterPlayer(db, guildId, userId);

  if (!result.success) {
    await interaction.editReply({
      embeds: [errorEmbed(result.error!)],
    });
    return;
  }

  if (isAdmin) {
    revokeAdmin(db, guildId, userId);
    audit(db, {
      guildId,
      actorId: userId,
      actionType: 'ADMIN_REVOKED',
      payload: { reason: 'player_unregistered' },
    });
  }

  await interaction.editReply({
    embeds: [unregisterEmbed(interaction.user, result.finalBalance ?? 0)],
  });

  audit(db, {
    guildId,
    actorId: userId,
    actionType: 'PLAYER_UNREGISTER',
    payload: { finalBalance: result.finalBalance },
  });
}
