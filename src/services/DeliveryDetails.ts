import { ButtonBuilder, ButtonStyle, MessageFlags, type ButtonInteraction } from 'discord.js';
import type { DeliveryDiagnostics, DeliveryRecord } from './DeliveryDiagnostics';
import type { DeliveryStage, StageOutcome } from './DeliveryContext';

const PREFIX = 'linky:details:';
const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function deliveryDetailsButton(id: string): ButtonBuilder {
  if (!ATTEMPT_ID.test(id)) throw new Error('Invalid delivery attempt ID');
  return new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel('Details').setCustomId(`${PREFIX}${id}`);
}

const outcomeLabels: Record<NonNullable<DeliveryRecord['outcome']>, string> = {
  confirmed: 'The preview was delivered.', partial: 'A partial preview was delivered; the original message was kept.',
  unavailable: 'The preview could not be prepared.', permission: 'A required Discord permission was missing.',
  disabled: 'This feature was disabled for the channel.', busy: 'The media queue was full.',
  timeout: 'The preparation time limit was reached.', 'discord-failure': 'The Discord delivery could not be confirmed.',
  'metadata-unconfirmed': 'Discord preview metadata was not confirmed.', cancelled: 'The request was cancelled.',
  interrupted: 'The bot restarted before this attempt finished.', 'internal-failure': 'Preparation could not finish.',
};

export function formatDeliveryDetails(record: DeliveryRecord): string {
  const totals = new Map<DeliveryStage, { durationMs: number; issues: Map<Exclude<StageOutcome, 'ok'>, number> }>();
  for (const span of record.stages) {
    const total = totals.get(span.stage) ?? { durationMs: 0, issues: new Map<Exclude<StageOutcome, 'ok'>, number>() };
    total.durationMs += span.durationMs;
    if (span.outcome !== 'ok') total.issues.set(span.outcome, (total.issues.get(span.outcome) ?? 0) + 1);
    totals.set(span.stage, total);
  }
  const seconds = (ms: number) => `${(ms / 1_000).toFixed(1)} s`;
  return [
    '**Your Linky delivery**',
    record.outcome ? outcomeLabels[record.outcome] : 'This request is still being prepared.',
    `Platform: ${record.platform}${record.path ? ` · Delivery: ${record.path}` : ''}`,
    ...(record.cache ? [`Cache: ${record.cache === 'hit' ? 'reused a validated local preview' : 'no reusable local preview'}.`] : []),
    ...(record.durationMs !== undefined ? [`Elapsed: ${seconds(record.durationMs)}`] : []),
    ...[...totals].map(([stage, total]) => {
      const issues = [...total.issues].map(([outcome, count]) => `${outcome}${count > 1 ? ` × ${count}` : ''}`).join(', ');
      return `${stage}: ${seconds(total.durationMs)}${issues ? ` · ${issues}` : ''}`;
    }),
    'Stage timings can overlap. Discord metadata does not confirm playback on your device.',
    `-# Attempt ${record.id} · Private history is kept for up to seven days.`,
  ].join('\n');
}

/** Always private, read-only and bound to the real output message and original requester. */
export async function handleDeliveryDetails(interaction: ButtonInteraction, diagnostics: DeliveryDiagnostics): Promise<boolean> {
  if (!interaction.customId.startsWith(PREFIX)) return false;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const id = interaction.customId.slice(PREFIX.length);
  let record: DeliveryRecord | undefined;
  if (ATTEMPT_ID.test(id) && interaction.message.author.id === interaction.client.user.id) {
    record = await diagnostics.lookup(id, { requesterId: interaction.user.id, channelId: interaction.channelId,
      guildId: interaction.guildId ?? undefined, messageId: interaction.message.id }).catch(() => undefined);
  }
  await interaction.editReply({ content: record ? formatDeliveryDetails(record) :
    'These private details are unavailable or belong to another requester.', allowedMentions: { parse: [] } });
  return true;
}
