import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from 'discord.js';
import { getDb } from '../../db/connection';
import { getPlayer, ensureGuild, touchPlayer } from '../../services/PlayerService';
import { createBet } from '../../services/BetService';
import { audit } from '../../services/AuditService';
import { COLORS, errorEmbed } from '../../ui/embeds';
import { formatCents, dollarsToCents } from '../../services/BalanceService';

export const data = new SlashCommandBuilder()
  .setName('wanna-bet')
  .setDescription('Create a new bet.')
  .addStringOption((opt) =>
    opt.setName('description').setDescription('What the bet is about.').setRequired(true)
  )
  .addNumberOption((opt) =>
    opt
      .setName('amount')
      .setDescription('Your wager in dollars (min $5).')
      .setRequired(true)
      .setMinValue(5)
  )
  .addStringOption((opt) =>
    opt
      .setName('my-side')
      .setDescription('Which side are you betting on?')
      .setRequired(true)
      .addChoices({ name: 'Side A', value: 'A' }, { name: 'Side B', value: 'B' })
  )
  .addStringOption((opt) =>
    opt.setName('side-a-label').setDescription('Label for Side A.').setRequired(true)
  )
  .addStringOption((opt) =>
    opt.setName('side-b-label').setDescription('Label for Side B.').setRequired(true)
  )
  .addUserOption((opt) =>
    opt
      .setName('opponent')
      .setDescription('Direct 1v1 opponent (leave blank for open/lobby).')
      .setRequired(false)
  )
  .addIntegerOption((opt) =>
    opt
      .setName('window-minutes')
      .setDescription('Minutes to accept the bet (default 10, max 1440).')
      .setRequired(false)
      .setMinValue(1)
      .setMaxValue(1440)
  )
  .addBooleanOption((opt) =>
    opt
      .setName('lobby')
      .setDescription('Open to all registered players with the gambler role.')
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const db = getDb();
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;

  ensureGuild(db, guildId);

  const player = getPlayer(db, guildId, userId);
  if (!player || player.status !== 'active') {
    await interaction.editReply({
      embeds: [errorEmbed('You must be registered and active to create a bet.')],
    });
    return;
  }

  const description = interaction.options.getString('description', true);
  const amountDollars = interaction.options.getNumber('amount', true);
  const mySide = interaction.options.getString('my-side', true) as 'A' | 'B';
  const sideALabel = interaction.options.getString('side-a-label', true);
  const sideBLabel = interaction.options.getString('side-b-label', true);
  const opponent = interaction.options.getUser('opponent');
  const windowMinutes = interaction.options.getInteger('window-minutes') ?? 10;
  const isLobby = interaction.options.getBoolean('lobby') ?? false;

  if (opponent && isLobby) {
    await interaction.editReply({
      embeds: [errorEmbed('Cannot specify both an opponent and lobby mode.')],
    });
    return;
  }

  if (opponent) {
    const oppPlayer = getPlayer(db, guildId, opponent.id);
    if (!oppPlayer || oppPlayer.status !== 'active') {
      await interaction.editReply({
        embeds: [errorEmbed(`<@${opponent.id}> is not registered and active.`)],
      });
      return;
    }
  }

  const wagerCents = dollarsToCents(amountDollars);
  if (player.balance < wagerCents) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          `Insufficient balance. You need ${formatCents(wagerCents)} but have ${formatCents(player.balance)}.`
        ),
      ],
    });
    return;
  }

  const result = createBet(db, {
    guildId,
    channelId: interaction.channelId,
    creatorId: userId,
    description,
    sideALabel,
    sideBLabel,
    initiatorSide: mySide,
    wagerDollars: amountDollars,
    opponentId: opponent?.id,
    isLobby,
    windowMinutes,
  });

  if (!result.success || !result.bet) {
    await interaction.editReply({
      embeds: [errorEmbed(result.error ?? 'Failed to create bet.')],
    });
    return;
  }

  const bet = result.bet;
  const fee = result.fee!;
  const netStake = result.netStake!;
  const windowTs = Math.floor(bet.window_closes_at / 1000);

  const embed = new EmbedBuilder()
    .setColor(COLORS.GOLD)
    .setTitle(`Bet Created — #${bet.bet_id}`)
    .addFields(
      { name: 'Description', value: description, inline: false },
      {
        name: `Side A${mySide === 'A' ? ' ← (You)' : ''}`,
        value: sideALabel,
        inline: true,
      },
      {
        name: `Side B${mySide === 'B' ? ' ← (You)' : ''}`,
        value: sideBLabel,
        inline: true,
      },
      { name: '\u200b', value: '\u200b', inline: true },
      { name: 'Your Wager', value: formatCents(wagerCents), inline: true },
      { name: 'Fee', value: formatCents(fee), inline: true },
      { name: 'Net Stake', value: formatCents(netStake), inline: true },
      { name: 'Window Closes', value: `<t:${windowTs}:R>`, inline: true },
      { name: 'Initiator', value: `<@${userId}>`, inline: true }
    )
    .setFooter({ text: `Bet #${bet.bet_id} • ${new Date().toISOString()}` });

  if (opponent) {
    embed.addFields({ name: 'Invited Opponent', value: `<@${opponent.id}>`, inline: true });
  }
  if (isLobby) {
    embed.addFields({
      name: 'Type',
      value: 'Lobby — open to registered players with the gambler role',
      inline: false,
    });
  }

  await interaction.editReply({ embeds: [embed] });

  if (opponent) {
    try {
      await opponent.send({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.GOLD)
            .setTitle(`You've been challenged! — Bet #${bet.bet_id}`)
            .setDescription(
              `<@${userId}> has invited you to a bet in **${interaction.guild?.name ?? 'the server'}**.\n\n` +
              `Use \`/accept bet-id:${bet.bet_id}\` to accept or \`/decline bet-id:${bet.bet_id}\` to decline.`
            )
            .addFields(
              { name: 'Description', value: description },
              { name: 'Their Side', value: `${mySide} (${mySide === 'A' ? sideALabel : sideBLabel})` },
              { name: 'Your Side', value: `${mySide === 'A' ? 'B' : 'A'} (${mySide === 'A' ? sideBLabel : sideALabel})` },
              { name: 'Window Closes', value: `<t:${windowTs}:R>` }
            ),
        ],
      });
    } catch {
      // DMs closed — mention in channel
      await interaction.followUp({
        content: `<@${opponent.id}> You've been invited to bet #${bet.bet_id}! Use \`/accept bet-id:${bet.bet_id}\` or \`/decline bet-id:${bet.bet_id}\`.`,
      });
    }
  }

  touchPlayer(db, guildId, userId);

  audit(db, {
    guildId,
    actorId: userId,
    actionType: 'BET_CREATED',
    payload: {
      betId: bet.bet_id,
      description,
      wagerCents,
      fee,
      isLobby,
      opponentId: opponent?.id,
    },
  });
}
