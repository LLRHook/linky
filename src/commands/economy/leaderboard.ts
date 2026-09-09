import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from 'discord.js';
import { getDb } from '../../db/connection';
import { buildLeaderboardTable, COLORS, LeaderboardRow } from '../../ui/embeds';

interface LeaderboardQueryRow {
  user_id: string;
  balance: number;
  wins: number;
  losses: number;
}

export const data = new SlashCommandBuilder()
  .setName('leaderboard')
  .setDescription('View the top 10 players by balance.');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const db = getDb();
  const guildId = interaction.guildId!;

  const rows = db
    .prepare<[string], LeaderboardQueryRow>(
      `SELECT p.user_id, p.balance,
              COUNT(CASE WHEN bp.side = b.resolved_outcome THEN 1 END) AS wins,
              COUNT(CASE WHEN bp.side != b.resolved_outcome AND b.resolved_outcome IS NOT NULL AND b.resolved_outcome != 'neither' THEN 1 END) AS losses
       FROM players p
       LEFT JOIN bet_participants bp ON bp.user_id = p.user_id AND bp.guild_id = p.guild_id
       LEFT JOIN bets b ON b.bet_id = bp.bet_id AND b.guild_id = bp.guild_id AND b.status = 'resolved'
       WHERE p.guild_id = ? AND p.status = 'active'
       GROUP BY p.user_id
       ORDER BY p.balance DESC
       LIMIT 10`
    )
    .all(guildId);

  if (rows.length === 0) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.BLUE)
          .setTitle('Leaderboard — Top 10')
          .setDescription('No registered players yet. Use `/register` to join!')
          .setTimestamp(),
      ],
    });
    return;
  }

  const guild = interaction.guild!;
  const tableRows: LeaderboardRow[] = await Promise.all(
    rows.map(async (row, index) => {
      let username = `User ${row.user_id.slice(-4)}`;
      try {
        const member = await guild.members.fetch(row.user_id);
        username = member.displayName.slice(0, 20);
      } catch {
        // Member may have left the server
      }
      return {
        rank: index + 1,
        username,
        balanceCents: row.balance,
        wins: row.wins,
        losses: row.losses,
      };
    })
  );

  const table = buildLeaderboardTable(tableRows);

  const medalLines: string[] = [];
  if (tableRows[0]) medalLines.push(`🥇 <@${rows[0]!.user_id}>`);
  if (tableRows[1]) medalLines.push(`🥈 <@${rows[1]!.user_id}>`);
  if (tableRows[2]) medalLines.push(`🥉 <@${rows[2]!.user_id}>`);

  const embed = new EmbedBuilder()
    .setColor(COLORS.GOLD)
    .setTitle('Leaderboard — Top 10')
    .setDescription(medalLines.join('  ') + '\n' + table)
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
