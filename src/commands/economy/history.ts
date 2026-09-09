import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ButtonInteraction,
  ComponentType,
} from 'discord.js';
import { getDb } from '../../db/connection';
import { getPlayer } from '../../services/PlayerService';
import { formatCents } from '../../services/BalanceService';
import { COLORS, errorEmbed, paginationButtons } from '../../ui/embeds';

const PAGE_SIZE = 5;

interface HistoryRow {
  bet_id: string;
  description: string;
  side_a_label: string;
  side_b_label: string;
  resolved_outcome: string | null;
  resolved_at: number | null;
  status: string;
  side: string;
  stake: number;
  fee_paid: number;
}

function buildHistoryEmbed(
  targetDisplayName: string,
  targetAvatarUrl: string,
  rows: HistoryRow[],
  page: number,
  totalPages: number
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(COLORS.BLUE)
    .setTitle(`${targetDisplayName}'s Bet History`)
    .setThumbnail(targetAvatarUrl)
    .setFooter({ text: `Page ${page + 1} of ${Math.max(totalPages, 1)}` })
    .setTimestamp();

  if (rows.length === 0) {
    embed.setDescription('No bets found.');
    return embed;
  }

  for (const bet of rows) {
    const wager = bet.stake + bet.fee_paid;
    let resultStr = 'Pending';
    let plStr = '';

    if (bet.status === 'resolved' && bet.resolved_outcome != null) {
      if (bet.resolved_outcome === 'neither') {
        resultStr = 'Neither';
        plStr = `P/L: ${formatCents(bet.stake - wager)}`; // -fee_paid
      } else if (bet.side === bet.resolved_outcome) {
        resultStr = 'WIN';
        plStr = `P/L: approx. +${formatCents(bet.stake)}`;
      } else {
        resultStr = 'LOSS';
        plStr = `P/L: -${formatCents(wager)}`;
      }
    } else if (bet.status === 'cancelled') {
      resultStr = 'Cancelled';
    }

    const sideLabel = bet.side === 'A' ? bet.side_a_label : bet.side_b_label;

    embed.addFields({
      name: `#${bet.bet_id} — ${bet.description.slice(0, 60)}`,
      value: [
        `**Side:** ${bet.side} (${sideLabel})`,
        `**Wager:** ${formatCents(wager)} | **Fee:** ${formatCents(bet.fee_paid)}`,
        `**Result:** ${resultStr}${plStr ? ' | ' + plStr : ''}`,
        bet.resolved_at ? `**Resolved:** <t:${Math.floor(bet.resolved_at / 1000)}:R>` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      inline: false,
    });
  }

  return embed;
}

export const data = new SlashCommandBuilder()
  .setName('history')
  .setDescription("View bet history for yourself or another player.")
  .addUserOption((opt) =>
    opt
      .setName('user')
      .setDescription('The player to view history for (defaults to yourself).')
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const db = getDb();
  const guildId = interaction.guildId!;
  const targetUser = interaction.options.getUser('user') ?? interaction.user;
  const targetId = targetUser.id;

  // Any guild member can look up history — no registration gate on lookup
  const player = getPlayer(db, guildId, targetId);
  if (!player) {
    await interaction.editReply({
      embeds: [errorEmbed(`<@${targetId}> is not registered in this guild's economy.`)],
    });
    return;
  }

  const totalCount = db
    .prepare<[string, string], { count: number }>(
      `SELECT COUNT(*) as count
       FROM bet_participants bp
       JOIN bets b ON b.bet_id = bp.bet_id AND b.guild_id = bp.guild_id
       WHERE bp.guild_id = ? AND bp.user_id = ?`
    )
    .get(guildId, targetId);

  const total = totalCount?.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const getPageRows = (p: number): HistoryRow[] =>
    db
      .prepare<[string, string, number, number], HistoryRow>(
        `SELECT b.bet_id, b.description, b.side_a_label, b.side_b_label,
                b.resolved_outcome, b.resolved_at, b.status,
                bp.side, bp.stake, bp.fee_paid
         FROM bet_participants bp
         JOIN bets b ON b.bet_id = bp.bet_id AND b.guild_id = bp.guild_id
         WHERE bp.guild_id = ? AND bp.user_id = ?
         ORDER BY b.created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(guildId, targetId, PAGE_SIZE, p * PAGE_SIZE);

  const prefix = `history:${targetId}`;
  const pageReply = (page: number) => {
    const rows = getPageRows(page);
    const embed = buildHistoryEmbed(
      targetUser.displayName,
      targetUser.displayAvatarURL(),
      rows,
      page,
      totalPages
    );
    return {
      embeds: [embed],
      components: totalPages > 1 ? [paginationButtons(page, totalPages, prefix)] : [],
    };
  };
  const message = await interaction.editReply(pageReply(0));

  if (totalPages <= 1) return;

  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 5 * 60 * 1000, // 5 minutes
    filter: (i) => i.user.id === interaction.user.id,
  });

  collector.on('collect', async (btnInteraction: ButtonInteraction) => {
    const [, , action, currentPageStr] = btnInteraction.customId.split(':');
    const currentPage = parseInt(currentPageStr ?? '0', 10);
    const requestedPage = action === 'next' ? currentPage + 1 : currentPage - 1;
    const page = Math.max(0, Math.min(requestedPage, totalPages - 1));
    await btnInteraction.update(pageReply(page));
  });

  collector.on('end', async () => {
    try {
      await message.edit({ components: [] });
    } catch {
      // Message may have been deleted
    }
  });
}
