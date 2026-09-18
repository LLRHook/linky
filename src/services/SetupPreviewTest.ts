import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionFlagsBits,
  type ButtonInteraction } from 'discord.js';
import type { Config } from '../config';
import { setupReadiness, type SetupTest } from '../commands/setupPanel';
import { effectivePreferences } from '../commands/settings';
import type { ServerSettings } from './ServerSettings';
import type { PreviewWatcher, PreviewWatch } from './PreviewWatcher';
import { expectedPreviews } from './PreviewRecovery';
import { getProviderCandidates } from './SocialProviders';

const COOLDOWN_MS = 30_000, MAX_TRACKED_CHANNELS = 64, ACCESS_TIMEOUT_MS = 5_000;
// Fixed public samples only. NASA/JPL identifies this YouTube video on its own page:
// https://sealevel.nasa.gov/resources/71/video-nasas-earth-minute-scale-in-the-sky/
const SAMPLES = [
  { platform: 'x', name: 'X text post', source: 'https://x.com/jack/status/20' },
  { platform: 'youtube', name: 'NASA/JPL Earth Minute video', source: 'https://www.youtube.com/watch?v=ecBgUrGlKps' },
] as const;

async function currentAccess(interaction: ButtonInteraction) {
  const guildId = interaction.guildId, botId = interaction.client.user.id;
  if (!guildId || !botId) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const guild = await interaction.client.guilds.fetch(guildId);
        if (guild.id !== guildId) return null;
        const [actor, bot, channel] = await Promise.all([
          guild.members.fetch({ user: interaction.user.id, force: true }),
          guild.members.fetch({ user: botId, force: true }),
          guild.channels.fetch(interaction.channelId, { force: true }),
        ]);
        if (actor.id !== interaction.user.id || bot.id !== botId || !channel ||
            channel.id !== interaction.channelId || channel.guildId !== guildId || !channel.isSendable()) return null;
        const send = channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
        if (!actor.permissions.has(PermissionFlagsBits.ManageGuild) ||
            (actor.communicationDisabledUntilTimestamp ?? 0) > Date.now() ||
            !channel.permissionsFor(actor)?.has([PermissionFlagsBits.ViewChannel, send])) return null;
        return { guildId, channelId: channel.id, isThread: channel.isThread(), canSend: true,
          threadParentId: channel.isThread() ? channel.parentId : undefined, permissions: channel.permissionsFor(bot) };
      })().catch(() => null),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ACCESS_TIMEOUT_MS); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Called only by the explicit setup button. Follow-up metadata preserves requester-only Remove. */
export function createSetupPreviewTest(config: Config, servers: ServerSettings,
  { armPreview, signal, now = Date.now }: { armPreview: PreviewWatcher['arm']; signal?: AbortSignal; now?: () => number }): SetupTest {
  const attempts = new Map<string, { running: boolean; expiresAt: number }>();
  return async interaction => {
    if (!interaction.guildId || signal?.aborted) return 'The sample test is unavailable. No sample was posted.';
    for (const [key, entry] of attempts) if (!entry.running && entry.expiresAt <= now()) attempts.delete(key);
    const key = `${interaction.guildId}:${interaction.channelId}`;
    if (attempts.has(key)) return 'A sample test is running or just finished here. Wait 30 seconds before trying again.';
    if (attempts.size >= MAX_TRACKED_CHANNELS) return 'Sample tests are busy. Try again shortly. No sample was posted.';
    const entry = { running: true, expiresAt: 0 };
    attempts.set(key, entry);
    let publicAttempt = false;
    let watch: PreviewWatch | undefined;
    try {
      const access = await currentAccess(interaction);
      if (!access || signal?.aborted) return 'Current channel permissions could not be confirmed. No sample was posted.';
      const readiness = setupReadiness(access, config, servers);
      if (!readiness.ready) return `${readiness.summary} No sample was posted.`;
      const effective = effectivePreferences(config, servers.getPreferences(access.guildId), access.guildId);
      const sample = SAMPLES.find(candidate => effective.platforms.includes(candidate.platform));
      if (!sample) return 'No safe sample is configured for the enabled platforms. Enable X or YouTube to use Test here, or post your own supported link.';
      const fixed = sample.platform === 'youtube' ? sample.source : getProviderCandidates(sample.source)[0]?.url;
      if (!fixed) return 'The sample provider is unavailable. No sample was posted.';
      const expected = expectedPreviews(sample.source, fixed);
      if (!expected.length) return 'The sample could not be prepared. No sample was posted.';
      watch = armPreview(access.channelId, expected, { signal });
      // Read current durable choices immediately before publication, after access checks and preparation.
      if (signal?.aborted || !setupReadiness(access, config, servers).ready ||
          !effectivePreferences(config, servers.getPreferences(access.guildId), access.guildId).platforms.includes(sample.platform)) {
        return 'Setup choices changed. No sample was posted.';
      }
      publicAttempt = true;
      const message = await interaction.followUp({
        content: `**Linky setup test** · requested by <@${interaction.user.id}>\n${sample.name}\n${fixed}\n` +
          '-# This sample checks preview delivery. It does not test Replace removal or confirm video playback.',
        flags: MessageFlags.SuppressNotifications, allowedMentions: { parse: [], repliedUser: false },
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Original post').setURL(sample.source),
          new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel('Remove').setCustomId('linky:remove-manual'),
        )],
      });
      try {
        const result = await watch.verify(message);
        return result.ok ? `${sample.name}: Discord supplied a matching preview. The sample is kept; you can Remove it. This does not test Replace removal or confirm playback.`
          : `${sample.name}: a usable preview could not be verified. The sample and source link are kept; you can Remove it. Use /diagnose to check the channel.`;
      } catch {
        return 'The sample was posted, but its preview could not be checked. The sample and source link are kept; you can Remove it.';
      }
    } catch {
      return publicAttempt ? 'The sample send could not be confirmed. Check the channel before trying again.'
        : 'The sample test could not be prepared. No sample was posted.';
    } finally {
      watch?.close();
      if (publicAttempt) { entry.running = false; entry.expiresAt = now() + COOLDOWN_MS; }
      else attempts.delete(key);
    }
  };
}
