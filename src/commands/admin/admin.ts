import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  EmbedBuilder,
} from 'discord.js';
import { getDb } from '../../db/connection';
import { getPlayer, getGuild, touchPlayer } from '../../services/PlayerService';
import { transfer, formatCents, dollarsToCents } from '../../services/BalanceService';
import { getBet, getParticipants, adminCancelBet, settleBet } from '../../services/BetService';
import { audit } from '../../services/AuditService';
import { client } from '../../index';
import { COLORS, errorEmbed } from '../../ui/embeds';

export const data = new SlashCommandBuilder()
  .setName('admin')
  .setDescription('Admin-only commands for managing the economy.')
  .addSubcommand((sub) =>
    sub
      .setName('grant')
      .setDescription('Grant funds from the bank to a player.')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('The player to grant funds to.').setRequired(true)
      )
      .addNumberOption((opt) =>
        opt.setName('amount').setDescription('Amount in dollars.').setRequired(true).setMinValue(0.01)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('seize')
      .setDescription('Seize funds from a player to the bank.')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('The player to seize from.').setRequired(true)
      )
      .addNumberOption((opt) =>
        opt.setName('amount').setDescription('Amount in dollars.').setRequired(true).setMinValue(0.01)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('resolve')
      .setDescription('Force-resolve a bet.')
      .addStringOption((opt) =>
        opt.setName('bet-id').setDescription('The bet ID.').setRequired(true).setAutocomplete(true)
      )
      .addStringOption((opt) =>
        opt
          .setName('outcome')
          .setDescription('The outcome.')
          .setRequired(true)
          .addChoices(
            { name: 'Side A wins', value: 'A' },
            { name: 'Side B wins', value: 'B' },
            { name: 'Neither (push)', value: 'neither' }
          )
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('cancel')
      .setDescription('Cancel a bet and refund stakes (fees retained by bank).')
      .addStringOption((opt) =>
        opt.setName('bet-id').setDescription('The bet ID.').setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('ban')
      .setDescription('Ban a player from the economy.')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('The player to ban.').setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('unban')
      .setDescription('Unban a player.')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('The player to unban.').setRequired(true)
      )
  );

function isAdmin(db: ReturnType<typeof getDb>, guildId: string, userId: string): boolean {
  const guild = getGuild(db, guildId);
  return guild?.current_admin_id === userId;
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const db = getDb();
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;
  const sub = interaction.options.getSubcommand(true);

  if (!isAdmin(db, guildId, userId)) {
    await interaction.editReply({
      embeds: [errorEmbed('You must be the elected admin to use admin commands.')],
    });
    return;
  }

  if (sub === 'grant') {
    const target = interaction.options.getUser('user', true);
    const amount = interaction.options.getNumber('amount', true);
    const amountCents = dollarsToCents(amount);

    const targetPlayer = getPlayer(db, guildId, target.id);
    if (!targetPlayer || targetPlayer.status !== 'active') {
      await interaction.editReply({
        embeds: [errorEmbed(`<@${target.id}> is not an active registered player.`)],
      });
      return;
    }

    const bankRow = db
      .prepare<[string], { balance: number }>('SELECT balance FROM bank WHERE guild_id=?')
      .get(guildId);
    if (!bankRow || bankRow.balance < amountCents) {
      await interaction.editReply({
        embeds: [errorEmbed(`Insufficient bank funds. Bank has ${formatCents(bankRow?.balance ?? 0)}.`)],
      });
      return;
    }

    const xfer = transfer(db, {
      guildId,
      fromBank: amountCents,
      toWallet: { userId: target.id, amount: amountCents },
    });

    if (!xfer.success) {
      await interaction.editReply({ embeds: [errorEmbed(xfer.error!)] });
      return;
    }

    const newBalance = getPlayer(db, guildId, target.id)?.balance ?? 0;

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.PURPLE)
          .setTitle('Grant Issued')
          .addFields(
            { name: 'Recipient', value: `<@${target.id}>`, inline: true },
            { name: 'Amount', value: formatCents(amountCents), inline: true },
            { name: 'New Balance', value: formatCents(newBalance), inline: true }
          )
          .setTimestamp(),
      ],
    });

    touchPlayer(db, guildId, userId);
    audit(db, {
      guildId,
      actorId: userId,
      actionType: 'ADMIN_GRANT',
      payload: { targetId: target.id, amountCents },
    });
    return;
  }

  if (sub === 'seize') {
    const target = interaction.options.getUser('user', true);
    const amount = interaction.options.getNumber('amount', true);
    const amountCents = dollarsToCents(amount);

    const targetPlayer = getPlayer(db, guildId, target.id);
    if (!targetPlayer) {
      await interaction.editReply({
        embeds: [errorEmbed(`<@${target.id}> is not registered.`)],
      });
      return;
    }
    if (targetPlayer.balance < amountCents) {
      await interaction.editReply({
        embeds: [errorEmbed(`Player only has ${formatCents(targetPlayer.balance)}.`)],
      });
      return;
    }

    const xfer = transfer(db, {
      guildId,
      fromWallet: { userId: target.id, amount: amountCents },
      toBank: amountCents,
    });

    if (!xfer.success) {
      await interaction.editReply({ embeds: [errorEmbed(xfer.error!)] });
      return;
    }

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.PURPLE)
          .setTitle('Funds Seized')
          .addFields(
            { name: 'From', value: `<@${target.id}>`, inline: true },
            { name: 'Amount', value: formatCents(amountCents), inline: true }
          )
          .setTimestamp(),
      ],
    });

    touchPlayer(db, guildId, userId);
    audit(db, {
      guildId,
      actorId: userId,
      actionType: 'ADMIN_SEIZE',
      payload: { targetId: target.id, amountCents },
    });
    return;
  }

  if (sub === 'resolve') {
    const betId = interaction.options.getString('bet-id', true).toUpperCase().trim();
    const outcome = interaction.options.getString('outcome', true) as 'A' | 'B' | 'neither';

    const bet = getBet(db, guildId, betId);
    if (!bet) {
      await interaction.editReply({ embeds: [errorEmbed(`Bet #${betId} not found.`)] });
      return;
    }
    if (['resolved', 'cancelled'].includes(bet.status)) {
      await interaction.editReply({
        embeds: [errorEmbed(`Bet #${betId} is already ${bet.status}.`)],
      });
      return;
    }

    // Re-verify admin inside transaction (race protection)
    const currentGuild = getGuild(db, guildId);
    if (currentGuild?.current_admin_id !== userId) {
      await interaction.editReply({
        embeds: [errorEmbed('You are no longer the admin.')],
      });
      return;
    }

    const settleResult = settleBet(db, guildId, betId, outcome, userId);
    if (!settleResult.success) {
      await interaction.editReply({ embeds: [errorEmbed(settleResult.error!)] });
      return;
    }

    const outcomeLabel =
      outcome === 'A' ? `Side A (${bet.side_a_label})`
      : outcome === 'B' ? `Side B (${bet.side_b_label})`
      : 'Neither (push)';

    const payoutLines = (settleResult.payouts ?? [])
      .map((p) => `<@${p.userId}>: +${formatCents(p.payout)}`)
      .join('\n');

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.PURPLE)
          .setTitle(`Admin Force-Resolved #${betId}`)
          .addFields(
            { name: 'Outcome', value: outcomeLabel, inline: true },
            { name: 'Resolved By', value: `<@${userId}>`, inline: true },
            { name: 'Payouts', value: payoutLines || 'None', inline: false }
          )
          .setTimestamp(),
      ],
    });

    touchPlayer(db, guildId, userId);
    audit(db, {
      guildId,
      actorId: userId,
      actionType: 'ADMIN_RESOLVE',
      payload: { betId, outcome, payouts: settleResult.payouts },
    });
    return;
  }

  if (sub === 'cancel') {
    const betId = interaction.options.getString('bet-id', true).toUpperCase().trim();

    const cancelResult = adminCancelBet(db, guildId, betId);
    if (!cancelResult.success) {
      await interaction.editReply({ embeds: [errorEmbed(cancelResult.error!)] });
      return;
    }

    const refundLines = (cancelResult.refunds ?? [])
      .map((r) => `<@${r.userId}>: +${formatCents(r.amount)} (stake only)`)
      .join('\n');

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.GRAY)
          .setTitle(`Bet Cancelled #${betId}`)
          .setDescription('Stakes refunded to participants. Fees retained by bank.')
          .addFields({ name: 'Refunds', value: refundLines || 'None' })
          .setTimestamp(),
      ],
    });

    const bet = getBet(db, guildId, betId);
    if (bet) {
      const participants = getParticipants(db, betId, guildId);
      for (const p of participants) {
        try {
          const user = await client.users.fetch(p.user_id);
          await user.send({
            embeds: [
              new EmbedBuilder()
                .setColor(COLORS.GRAY)
                .setTitle(`Bet Cancelled — #${betId}`)
                .setDescription(`Bet #${betId} has been admin-cancelled. Your stake (${formatCents(p.stake)}) has been refunded. Fees are not refunded.`)
                .setTimestamp(),
            ],
          });
        } catch {
          // DMs closed
        }
      }
    }

    touchPlayer(db, guildId, userId);
    audit(db, {
      guildId,
      actorId: userId,
      actionType: 'ADMIN_CANCEL',
      payload: { betId },
    });
    return;
  }

  if (sub === 'ban' || sub === 'unban') {
    const banning = sub === 'ban';
    const target = interaction.options.getUser('user', true);
    const targetPlayer = getPlayer(db, guildId, target.id);
    let error: string | undefined;
    if (banning && !targetPlayer) {
      error = 'is not registered.';
    } else if (banning && targetPlayer?.status === 'banned') {
      error = 'is already banned.';
    } else if (!banning && targetPlayer?.status !== 'banned') {
      error = 'is not banned.';
    }
    if (error) {
      await interaction.editReply({
        embeds: [errorEmbed(`<@${target.id}> ${error}`)],
      });
      return;
    }

    db.prepare<[string, string, string]>(
      'UPDATE players SET status=? WHERE guild_id=? AND user_id=?'
    ).run(banning ? 'banned' : 'active', guildId, target.id);

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(banning ? COLORS.RED : COLORS.GREEN)
          .setTitle(banning ? 'Player Banned' : 'Player Unbanned')
          .addFields({ name: 'Player', value: `<@${target.id}>`, inline: true })
          .setTimestamp(),
      ],
    });

    touchPlayer(db, guildId, userId);
    audit(db, {
      guildId,
      actorId: userId,
      actionType: banning ? 'ADMIN_BAN' : 'ADMIN_UNBAN',
      payload: { targetId: target.id },
    });
    return;
  }
}

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const db = getDb();
  const guildId = interaction.guildId!;
  const focused = interaction.options.getFocused().toUpperCase();
  const sub = interaction.options.getSubcommand(false);

  interface BetRow { bet_id: string; description: string }

  const statusFilter = sub === 'resolve'
    ? "status NOT IN ('resolved','cancelled')"
    : sub === 'cancel' ? "status IN ('open','locked','proposed','disputed')" : null;
  if (!statusFilter) {
    await interaction.respond([]);
    return;
  }

  const bets = db
    .prepare<[string], BetRow>(
      `SELECT bet_id, description FROM bets
       WHERE guild_id=? AND ${statusFilter}
       LIMIT 25`
    )
    .all(guildId);
  await interaction.respond(
    bets
      .filter((b) => b.bet_id.startsWith(focused))
      .map((b) => ({ name: `#${b.bet_id} — ${b.description.slice(0, 80)}`, value: b.bet_id }))
  );
}
