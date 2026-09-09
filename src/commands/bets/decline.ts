import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  EmbedBuilder,
} from 'discord.js';
import { getDb } from '../../db/connection';
import { getPlayer, touchPlayer } from '../../services/PlayerService';
import { declineBet, getBet } from '../../services/BetService';
import { audit } from '../../services/AuditService';
import { client } from '../../index';
import { COLORS, errorEmbed } from '../../ui/embeds';

export const data = new SlashCommandBuilder()
  .setName('decline')
  .setDescription('Decline a direct bet invitation.')
  .addStringOption((opt) =>
    opt
      .setName('bet-id')
      .setDescription('The bet ID to decline.')
      .setRequired(true)
      .setAutocomplete(true)
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const db = getDb();
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;

  const player = getPlayer(db, guildId, userId);
  if (!player) {
    await interaction.editReply({
      embeds: [errorEmbed('You must be registered to decline a bet.')],
    });
    return;
  }

  const betId = interaction.options.getString('bet-id', true).toUpperCase().trim();

  const bet = getBet(db, guildId, betId);
  if (!bet || bet.direct_opponent_id !== userId) {
    await interaction.editReply({
      embeds: [errorEmbed(`Bet #${betId} not found or you are not the invited opponent.`)],
    });
    return;
  }

  const result = declineBet(db, guildId, betId, userId);

  if (!result.success) {
    await interaction.editReply({ embeds: [errorEmbed(result.error!)] });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(COLORS.GRAY)
    .setTitle(`Bet Declined — #${betId}`)
    .setDescription(`You declined bet #${betId}. The creator's wager (including fee) has been refunded.`)
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });

  try {
    const creator = await client.users.fetch(bet.creator_id);
    await creator.send({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.GRAY)
          .setTitle(`Bet Declined — #${betId}`)
          .setDescription(
            `<@${userId}> declined your bet invitation for #${betId}. Your wager and fee have been refunded.`
          )
          .addFields({ name: 'Description', value: bet.description })
          .setTimestamp(),
      ],
    });
  } catch {
    // DMs closed
  }

  touchPlayer(db, guildId, userId);

  audit(db, {
    guildId,
    actorId: userId,
    actionType: 'BET_DECLINED',
    payload: { betId },
  });
}

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const db = getDb();
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;
  const focused = interaction.options.getFocused().toUpperCase();

  interface DirectBetRow { bet_id: string; description: string }

  const bets = db
    .prepare<[string, string, string, string], DirectBetRow>(
      `SELECT bet_id, description FROM bets
       WHERE guild_id=? AND status='open' AND direct_opponent_id=?
         AND bet_id NOT IN (
           SELECT bet_id FROM bet_participants WHERE guild_id=? AND user_id=?
         )
       LIMIT 25`
    )
    .all(guildId, userId, guildId, userId);

  await interaction.respond(
    bets
      .filter((b) => b.bet_id.startsWith(focused))
      .map((b) => ({
        name: `#${b.bet_id} — ${b.description.slice(0, 80)}`,
        value: b.bet_id,
      }))
  );
}
