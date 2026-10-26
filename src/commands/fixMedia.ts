import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags,
  type ChatInputCommandInteraction, type Message, type MessageContextMenuCommandInteraction } from 'discord.js';
import type { createDeliveryAttempt } from '../services/DeliveryAttempt';
import type { createDeliveryProgress } from '../services/DeliveryProgress';
import type { EromeAlbumSessions } from '../services/EromeAlbumSessions';
import { eromeMediaComponents, messageHasEromeMedia, sendEromeMedia, watchEromeMedia,
  type EromeMedia, type EromeMediaBinding } from '../services/EromeMedia';
import type { ExpectedPreview, PreviewResult } from '../services/PreviewRecovery';

/** Original-post link buttons (two rows of five at most) followed by the requester's Remove button. */
export function manualButtons(links: readonly { source: string }[]): {
  buttons: ButtonBuilder[]; rows: () => ActionRowBuilder<ButtonBuilder>[];
} {
  const buttons = links.map((link, index) => new ButtonBuilder().setStyle(ButtonStyle.Link)
    .setLabel(index ? `Original post ${index + 1}` : 'Original post').setURL(link.source));
  buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel('Remove').setCustomId('linky:remove-manual'));
  const rows = () => [0, 5].filter(start => buttons.length > start)
    .map(start => new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(start, start + 5)));
  return { buttons, rows };
}

export interface HostedEromeDelivery {
  interaction: ChatInputCommandInteraction | MessageContextMenuCommandInteraction;
  attempt: ReturnType<typeof createDeliveryAttempt>;
  progress: ReturnType<typeof createDeliveryProgress>;
  media: EromeMedia;
  source: string;
  fixed: string;
  buttons: readonly ButtonBuilder[];
  buttonRows: () => ActionRowBuilder<ButtonBuilder>[];
  eromeAllowed: () => boolean;
  preferencesCurrent: () => boolean;
  privateResponse: boolean;
  bindEromeMedia: EromeMediaBinding;
  releaseEromeMedia: (messageId: string) => Promise<void>;
  albums?: EromeAlbumSessions;
  observePreview?: (expected: readonly ExpectedPreview[], result: PreviewResult) => void;
}

/** Publish a prepared hosted-original Erome gallery as the interaction reply, rolling back on any unconfirmed step. */
export async function publishHostedErome({ interaction, attempt, progress, media: preparedMedia, source: eromeSource, fixed,
  buttons, buttonRows, eromeAllowed, preferencesCurrent, privateResponse, bindEromeMedia, releaseEromeMedia, albums,
  observePreview }: HostedEromeDelivery): Promise<void> {
  const context = attempt.context;
  context.trace?.setPath('hosted-original');
  await progress.stop();
  const initialControls = [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(0, -1)).toJSON()];
  if (context.signal?.aborted) {
    attempt.finish('timeout');
    await interaction.editReply({ content: 'This preparation reached its time limit. The album is unchanged; try again later.',
      components: initialControls, allowedMentions: { parse: [] } });
    return;
  }
  if (!eromeAllowed() || !preferencesCurrent()) {
    attempt.finish('disabled');
    await interaction.editReply({ content: 'Erome previews are no longer allowed here. The album is unchanged.',
      components: initialControls, allowedMentions: { parse: [] } });
    return;
  }
  const watcher = watchEromeMedia(interaction.client, interaction.channelId, preparedMedia);
  let published: Message | undefined, rollbackAttempted = false;
  const rollback = async () => {
    rollbackAttempted = true;
    attempt.finish(context.signal?.aborted ? 'timeout' : eromeAllowed() && preferencesCurrent() ? 'metadata-unconfirmed' : 'disabled');
    const details = published ? await attempt.controls(published.id) : [];
    // V2 is sticky. Release media only once Discord confirms the gallery was removed.
    await interaction.editReply({ flags: MessageFlags.IsComponentsV2, content: null, components: [
      { type: ComponentType.TextDisplay, content: `<${eromeSource}>\n-# The media preview could not be confirmed or is no longer allowed here. The album is unchanged.` },
      ...initialControls, ...details.map(row => row.toJSON()),
    ], allowedMentions: { parse: [] } });
    if (published) await releaseEromeMedia(published.id);
  };
  try {
    const publishStage = context.trace?.startStage('publish');
    published = await sendEromeMedia(() => interaction.editReply({ flags: MessageFlags.IsComponentsV2, content: null,
      components: eromeMediaComponents(preparedMedia, fixed, initialControls), allowedMentions: { parse: [] } }), async () => {
      const existing = await interaction.fetchReply();
      return messageHasEromeMedia(existing, preparedMedia.url) ? existing : null;
    });
    publishStage?.finish();
    const ownershipStage = context.trace?.startStage('ownership');
    const bound = await bindEromeMedia(preparedMedia.id, published.id, preparedMedia.reservation).catch(() => false);
    ownershipStage?.finish(bound ? 'ok' : 'failed');
    if (!bound || context.signal?.aborted || !eromeAllowed() || !preferencesCurrent()) {
      if (context.signal?.aborted) attempt.finish('timeout');
      await rollback(); return;
    }
    const previewStage = context.trace?.startStage('preview');
    const verified = await watcher.verify(published).catch(() => false);
    previewStage?.finish(verified ? 'ok' : 'unavailable');
    if (!verified || context.signal?.aborted || !eromeAllowed() || !preferencesCurrent()) {
      if (context.signal?.aborted) attempt.finish('timeout');
      attempt.finish(verified ? 'disabled' : 'metadata-unconfirmed');
      observePreview?.([], { ok: false, missing: [], videoMetadata: false });
      await rollback();
      return;
    }
    const albumControl = !privateResponse && interaction.guildId ? albums?.register({ media: preparedMedia, source: eromeSource,
      requesterId: interaction.user.id, channelId: interaction.channelId, guildId: interaction.guildId,
      messageId: published.id, mode: 'manual',
      ...!interaction.isChatInputCommand() ? { sourceMessageId: interaction.targetMessage.id } : {} }) : undefined;
    const details = await attempt.controls(published.id);
    if (context.signal?.aborted || !eromeAllowed() || !preferencesCurrent()) { await rollback(); return; }
    await interaction.editReply({ components: eromeMediaComponents(preparedMedia, fixed,
      [...buttonRows().map(row => row.toJSON()), ...details.map(row => row.toJSON()),
        ...albumControl ? [albumControl] : []]), allowedMentions: { parse: [] } });
    if (context.signal?.aborted || !eromeAllowed() || !preferencesCurrent()) { await rollback(); return; }
    observePreview?.([], { ok: true, missing: [], videoMetadata: preparedMedia.kind !== 'image' });
    attempt.finish('confirmed');
  } catch (error) {
    if (rollbackAttempted) throw error;
    await rollback();
  } finally { watcher.close(); }
}
