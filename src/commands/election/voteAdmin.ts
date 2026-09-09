import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from 'discord.js';
import { getDb } from '../../db/connection';
import { getPlayer, ensureGuild, touchPlayer } from '../../services/PlayerService';
import {
  startElection,
  nominateCandidate,
  castVote,
  getElectionStatus,
  scheduleElectionFinalization,
} from '../../services/ElectionService';
import { audit } from '../../services/AuditService';
import { client } from '../../index';
import { COLORS, errorEmbed } from '../../ui/embeds';

export const data = new SlashCommandBuilder()
  .setName('vote-admin')
  .setDescription('Manage admin elections.')
  .addSubcommand((sub) =>
    sub.setName('start').setDescription('Start an admin election (1 hour window).')
  )
  .addSubcommand((sub) =>
    sub.setName('nominate').setDescription('Nominate yourself as a candidate.')
  )
  .addSubcommand((sub) =>
    sub
      .setName('cast')
      .setDescription('Cast your vote for a candidate.')
      .addUserOption((opt) =>
        opt.setName('candidate').setDescription('The player to vote for.').setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub.setName('status').setDescription('View the current election status.')
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const db = getDb();
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;
  const sub = interaction.options.getSubcommand(true);

  ensureGuild(db, guildId);

  if (sub === 'start') {
    const player = getPlayer(db, guildId, userId);
    if (!player || player.status !== 'active') {
      await interaction.editReply({
        embeds: [errorEmbed('You must be registered and active to start an election.')],
      });
      return;
    }

    const result = startElection(db, guildId);

    if (!result.success || !result.election) {
      await interaction.editReply({ embeds: [errorEmbed(result.error!)] });
      return;
    }

    const endsTs = Math.floor(result.election.ends_at / 1000);

    const embed = new EmbedBuilder()
      .setColor(COLORS.PURPLE)
      .setTitle('Admin Election Started!')
      .addFields(
        { name: 'Ends At', value: `<t:${endsTs}:F> (<t:${endsTs}:R>)`, inline: false },
        { name: 'How to Nominate', value: 'Use `/vote-admin nominate` to nominate yourself.', inline: false },
        { name: 'How to Vote', value: 'Use `/vote-admin cast @candidate` to vote.', inline: false },
        { name: 'View Status', value: 'Use `/vote-admin status` to track the election.', inline: false }
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });

    scheduleElectionFinalization(db, client, guildId, result.election);

    touchPlayer(db, guildId, userId);

    audit(db, {
      guildId,
      actorId: userId,
      actionType: 'ELECTION_STARTED',
      payload: { electionId: result.election.id },
    });
    return;
  }

  if (sub === 'nominate') {
    const player = getPlayer(db, guildId, userId);
    if (!player || player.status !== 'active') {
      await interaction.editReply({
        embeds: [errorEmbed('You must be registered and active to nominate yourself.')],
      });
      return;
    }

    const result = nominateCandidate(db, guildId, userId);

    if (!result.success) {
      await interaction.editReply({ embeds: [errorEmbed(result.error!)] });
      return;
    }

    const endsTs = Math.floor(result.election!.ends_at / 1000);

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.PURPLE)
          .setTitle('Nominated!')
          .addFields(
            { name: 'Candidate', value: `<@${userId}>`, inline: true },
            { name: 'Election Ends', value: `<t:${endsTs}:R>`, inline: true }
          )
          .setTimestamp(),
      ],
    });

    touchPlayer(db, guildId, userId);
    return;
  }

  if (sub === 'cast') {
    const player = getPlayer(db, guildId, userId);
    if (!player || player.status !== 'active') {
      await interaction.editReply({
        embeds: [errorEmbed('You must be registered and active to vote.')],
      });
      return;
    }

    const candidate = interaction.options.getUser('candidate', true);

    const result = castVote(db, guildId, userId, candidate.id);

    if (!result.success) {
      await interaction.editReply({ embeds: [errorEmbed(result.error!)] });
      return;
    }

    const status = getElectionStatus(db, guildId);
    const endsTs = status.election ? Math.floor(status.election.ends_at / 1000) : 0;

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.PURPLE)
          .setTitle('Vote Cast!')
          .addFields(
            { name: 'Voted For', value: `<@${candidate.id}>`, inline: true },
            { name: 'Election Ends', value: endsTs ? `<t:${endsTs}:R>` : 'N/A', inline: true }
          )
          .setTimestamp(),
      ],
    });

    touchPlayer(db, guildId, userId);
    return;
  }

  if (sub === 'status') {
    const status = getElectionStatus(db, guildId);

    if (!status.election) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.PURPLE)
            .setTitle('Election Status')
            .setDescription('No election is currently in progress.')
            .addFields({
              name: 'Registered Players',
              value: String(status.registeredCount),
              inline: true,
            })
            .setTimestamp(),
        ],
      });
      return;
    }

    const endsTs = Math.floor(status.election.ends_at / 1000);
    const isOpen = status.election.status === 'open' && Date.now() < status.election.ends_at;

    const tallyLines =
      status.tallies.length > 0
        ? status.tallies.map((t) => `<@${t.candidateId}>: ${t.count} vote(s)`).join('\n')
        : 'No votes yet.';

    const embed = new EmbedBuilder()
      .setColor(COLORS.PURPLE)
      .setTitle('Election Status')
      .addFields(
        { name: 'Status', value: isOpen ? 'OPEN' : status.election.status.toUpperCase(), inline: true },
        { name: 'Ends At', value: `<t:${endsTs}:R>`, inline: true },
        { name: 'Registered Players', value: String(status.registeredCount), inline: true },
        {
          name: 'Votes Cast',
          value: `${status.voteCount} / ${status.quorumThreshold} required (quorum)`,
          inline: true,
        },
        { name: 'Nominees', value: String(status.nomineeCount), inline: true },
        { name: 'Vote Tallies', value: tallyLines, inline: false }
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }
}
