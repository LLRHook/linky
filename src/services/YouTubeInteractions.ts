import { MessageFlags, type ButtonInteraction } from 'discord.js';
import { formatYouTubeStatistics, type YouTubeStatistics } from './YouTube';
import { parseYouTubeControl, YOUTUBE_CONTROL_PREFIX } from './YouTubeControls';
import type { YouTubeStats } from './YouTubeStats';

interface Options {
  stats?: Pick<YouTubeStats, 'canView'>;
  lookup?: (ids: readonly string[]) => Promise<Map<string, YouTubeStatistics>>;
  enabled: (guildId: string, channelId: string, action: 'stats' | 'comment') => boolean;
}

const allowedMentions = { parse: [], users: [], roles: [], repliedUser: false };
const expired = 'This YouTube control is no longer available. Share the video again to get a fresh preview.';

/** YouTube controls disclose details only in a private reply to the person who clicked. */
export async function replyToYouTubeControl(interaction: ButtonInteraction, options: Options): Promise<boolean> {
  if (!interaction.customId.startsWith(YOUTUBE_CONTROL_PREFIX)) return false;
  const control = parseYouTubeControl(interaction.customId);
  const canView = () => Boolean(control && options.lookup && interaction.guildId && interaction.channelId &&
    (!interaction.message.guildId || interaction.message.guildId === interaction.guildId) &&
    interaction.message.channelId === interaction.channelId &&
    options.enabled(interaction.guildId, interaction.channelId, control.action) &&
    options.stats?.canView(interaction.message, control.videoId));
  if (!control || !canView()) {
    await interaction.reply({ content: expired, flags: MessageFlags.Ephemeral, allowedMentions });
    return true;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!canView()) {
    await interaction.editReply({ content: expired, embeds: [], allowedMentions });
    return true;
  }
  let statistics: YouTubeStatistics | undefined;
  try { statistics = (await options.lookup!([control.videoId])).get(control.videoId); }
  catch { /* API failures do not disclose provider errors or credentials. */ }
  if (!canView()) {
    await interaction.editReply({ content: expired, embeds: [], allowedMentions });
    return true;
  }
  const card = statistics && formatYouTubeStatistics(control.action === 'stats' ? {
    viewCount: statistics.viewCount, likeCount: statistics.likeCount, commentCount: statistics.commentCount,
  } : { topComment: statistics.topComment }, `https://www.youtube.com/watch?v=${control.videoId}`);
  if (!card) {
    await interaction.editReply({ content: control.action === 'comment'
      ? 'A top comment is not available for this video right now.'
      : 'YouTube statistics are not available for this video right now.', embeds: [], allowedMentions });
    return true;
  }
  const embed = control.action === 'comment' ? {
    title: 'Top YouTube comment', url: card.url, color: card.color, description: card.fields![0].value,
  } : card;
  await interaction.editReply({ content: '', embeds: [{ ...embed, footer: { text: 'Recent YouTube snapshot' } }], allowedMentions });
  return true;
}
