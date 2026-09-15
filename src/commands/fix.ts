import { ActionRowBuilder, ApplicationCommandType, ApplicationIntegrationType, ButtonBuilder, ButtonStyle, ComponentType,
  ContextMenuCommandBuilder, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder,
  type ButtonInteraction, type ChatInputCommandInteraction, type Message, type MessageContextMenuCommandInteraction } from 'discord.js';
import type { Config } from '../config';
import { mapLinks, visibleLink } from '../services/LinkTokens';
import { getProviderCandidates, parseSocialUrl } from '../services/SocialProviders';
import { parseYouTubeUrl } from '../services/YouTube';
import { originalPostUrl } from '../services/RepostPresentation';
import { expectedPreviews, nextProviderContent, waitForPreviews, type ExpectedPreview, type PreviewResult } from '../services/PreviewRecovery';
import { parseEromeUrl } from '../services/Erome';
import { eromeNotice, findEromeLinks, canPreviewErome, verifyEromeAttachment, type EromePreparer, type EromeProgress } from '../services/EromeDelivery';
import type { ServerPreferences } from '../services/ServerSettings';
import { attachmentBudget, fitsAttachmentBudget } from '../services/AttachmentLimits';
import { eromeMediaComponents, messageHasEromeMedia, onlyEromeLinks, sendEromeMedia, watchEromeMedia,
  type EromeMedia, type EromeMediaBinding, type EromeMediaPreparer } from '../services/EromeMedia';
import { createDeliveryProgress } from '../services/DeliveryProgress';
import { createDeliveryAttempt, deliveryPlatform } from '../services/DeliveryAttempt';
import type { DeliveryDiagnostics } from '../services/DeliveryDiagnostics';
import type { PreviewWatcher, PreviewWatch } from '../services/PreviewWatcher';
import type { ProviderHealth, ProviderAttempt } from '../services/ProviderHealth';
import type { EromeAlbumSessions } from '../services/EromeAlbumSessions';

const installs = [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall];
const contexts = [InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel];
export const data = new SlashCommandBuilder().setName('fix').setDescription('Make a link preview on request, without enabling automatic fixing.')
  .setIntegrationTypes(...installs).setContexts(...contexts)
  .addStringOption(option => option.setName('link').setDescription('A supported social post, clip or Erome album URL.').setRequired(true).setMaxLength(1500));
export const contextData = new ContextMenuCommandBuilder().setName('Fix with Linky').setType(ApplicationCommandType.Message)
  .setIntegrationTypes(...installs).setContexts(...contexts);

/** Only URL tokens supplied by this explicit interaction are used; nothing is fetched from chat history. */
export function manualLinks(content: string, config: Pick<Config, 'rewritePlatforms'>): { source: string; fixed: string }[] {
  const links = new Map<string, { source: string; fixed: string }>();
  let eromeAdded = false;
  mapLinks(content, (url, position) => {
    if (!visibleLink(content, position)) return url;
    const social = parseSocialUrl(url);
    const youtube = parseYouTubeUrl(url);
    const erome = parseEromeUrl(url);
    if (social && config.rewritePlatforms.includes(social.platform)) {
      const fixed = getProviderCandidates(social)[0]?.url;
      if (fixed) links.set(social.sourceUrl, { source: originalPostUrl(social.sourceUrl), fixed: originalPostUrl(fixed) });
    } else if (erome && config.rewritePlatforms.includes('erome') && !eromeAdded) {
      links.set(erome.url, { source: erome.url, fixed: `<${erome.url}>` });
      eromeAdded = true;
    } else if (youtube) {
      // Native video links do not need an API key, statistics, or a cleanup journal.
      links.set(youtube.url, { source: youtube.url, fixed: youtube.url });
    }
    return url;
  });
  return [...links.values()].slice(0, 3);
}

export async function execute(interaction: ChatInputCommandInteraction | MessageContextMenuCommandInteraction,
  config: Config, { verifyPreview = waitForPreviews, observePreview, prepareErome, verifyErome = verifyEromeAttachment,
    prepareEromeMedia, bindEromeMedia, releaseEromeMedia, cancelMediaReservation, serverPreferences,
    diagnostics, armPreview, providerHealth, albums, signal }: {
    verifyPreview?: typeof waitForPreviews;
    observePreview?: (expected: readonly ExpectedPreview[], result: PreviewResult) => void;
    prepareErome?: EromePreparer;
    prepareEromeMedia?: EromeMediaPreparer;
    bindEromeMedia?: EromeMediaBinding;
    releaseEromeMedia?: (messageId: string) => Promise<void>;
    cancelMediaReservation?: (reservation: string) => Promise<void>;
    verifyErome?: typeof verifyEromeAttachment;
    serverPreferences?: (guildId: string) => ServerPreferences;
    diagnostics?: DeliveryDiagnostics;
    armPreview?: PreviewWatcher['arm'];
    providerHealth?: ProviderHealth;
    albums?: EromeAlbumSessions;
    signal?: AbortSignal;
  } = {}): Promise<void> {
  const content = interaction.isChatInputCommand() ? interaction.options.getString('link', true) : interaction.targetMessage.content;
  const eromeAllowed = () => interaction.inGuild() && canPreviewErome(interaction.channel,
    interaction.guildId ? serverPreferences?.(interaction.guildId)?.eromeChannels : undefined);
  if (findEromeLinks(content).length && !eromeAllowed()) {
    await interaction.reply({ content: 'Erome requires a server channel allowed by its settings. Use an age-restricted channel, or ask a server admin to set /settings erome_channels:all.',
      flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return;
  }
  const links = manualLinks(content, config);
  if (!links.length) {
    await interaction.reply({ content: 'No supported post link found. Choose an Instagram, TikTok, X/Twitter, YouTube, Bluesky or Reddit post, a Twitch clip, or an Erome album in an allowed server channel. Links inside <angle brackets>, spoilers or code are skipped.',
      flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return;
  }
  const eromeSource = links.find(link => parseEromeUrl(link.source))?.source;
  if (eromeSource && !interaction.appPermissions?.has(PermissionFlagsBits.AttachFiles)) {
    await interaction.reply({ content: 'Linky needs Attach Files permission to post an Erome video preview.',
      flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return;
  }
  const eromeBudget = attachmentBudget(interaction.attachmentSizeLimit);
  if (eromeSource && !eromeBudget) {
    await interaction.reply({ content: 'Discord has not provided a usable file upload limit for this preview. The album is unchanged.',
      flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return;
  }
  const sendPermission = interaction.channel?.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
  const privateResponse = interaction.inGuild() && !interaction.memberPermissions?.has(sendPermission);
  await interaction.deferReply(privateResponse ? { flags: MessageFlags.Ephemeral } : {});
  const progress = createDeliveryProgress(text => interaction.editReply({ content: text, allowedMentions: { parse: [] } }), { delayMs: 500 });
  const attempt = createDeliveryAttempt({ requesterId: interaction.user.id, channelId: interaction.channelId,
    guildId: interaction.guildId ?? undefined, mode: 'manual', platform: deliveryPlatform(content) }, diagnostics, progress.update, signal);
  const context = attempt.context;
  const providerAttempts: ProviderAttempt[] = [];
  let previewWatch: PreviewWatch | undefined;
  let media: EromeMedia | null = null;
  try {
    const buttons = links.map((link, index) => new ButtonBuilder().setStyle(ButtonStyle.Link)
      .setLabel(index ? `Original post ${index + 1}` : 'Original post').setURL(link.source));
    buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel('Remove').setCustomId('linky:remove-manual'));
    if (eromeSource) progress.update({ stage: 'resolve', state: 'running' });
    media = eromeSource && links.length === 1 && findEromeLinks(content).length === 1 && onlyEromeLinks(content) &&
      prepareEromeMedia && bindEromeMedia && releaseEromeMedia
      ? await prepareEromeMedia(eromeSource, { context }).catch(() => null) : null;
    if (signal?.aborted) return;
    if (media) {
      const preparedMedia = media;
      context.trace?.setPath('hosted-original');
      await progress.stop();
      const initialControls = [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(0, -1)).toJSON()];
      if (context.signal?.aborted) {
        attempt.finish('timeout');
        await interaction.editReply({ content: 'This preparation reached its time limit. The album is unchanged; try again later.',
          components: initialControls, allowedMentions: { parse: [] } });
        return;
      }
      if (!eromeAllowed()) {
        attempt.finish('disabled');
        await interaction.editReply({ content: 'Erome previews are no longer allowed here. The album is unchanged.',
          components: initialControls, allowedMentions: { parse: [] } });
        return;
      }
      const watcher = watchEromeMedia(interaction.client, interaction.channelId, preparedMedia);
      let published: Message | undefined, rollbackAttempted = false;
      const rollback = async () => {
        rollbackAttempted = true;
        attempt.finish(context.signal?.aborted ? 'timeout' : eromeAllowed() ? 'metadata-unconfirmed' : 'disabled');
        const details = published ? await attempt.controls(published.id) : [];
        // V2 is sticky. Release media only once Discord confirms the gallery was removed.
        await interaction.editReply({ flags: MessageFlags.IsComponentsV2, content: null, components: [
          { type: ComponentType.TextDisplay, content: `<${eromeSource}>\n-# The media preview could not be confirmed or is no longer allowed here. The album is unchanged.` },
          ...initialControls, ...details.map(row => row.toJSON()),
        ], allowedMentions: { parse: [] } });
        if (published) await releaseEromeMedia!(published.id);
      };
      try {
        const publishStage = context.trace?.startStage('publish');
        published = await sendEromeMedia(() => interaction.editReply({ flags: MessageFlags.IsComponentsV2, content: null,
          components: eromeMediaComponents(preparedMedia, links[0].fixed, initialControls), allowedMentions: { parse: [] } }), async () => {
          const existing = await interaction.fetchReply();
          return messageHasEromeMedia(existing, preparedMedia.url) ? existing : null;
        });
        publishStage?.finish();
        const ownershipStage = context.trace?.startStage('ownership');
        const bound = await bindEromeMedia!(preparedMedia.id, published.id, preparedMedia.reservation).catch(() => false);
        ownershipStage?.finish(bound ? 'ok' : 'failed');
        if (!bound || context.signal?.aborted || !eromeAllowed()) {
          if (context.signal?.aborted) attempt.finish('timeout');
          await rollback(); return;
        }
        const previewStage = context.trace?.startStage('preview');
        const verified = await watcher.verify(published).catch(() => false);
        previewStage?.finish(verified ? 'ok' : 'unavailable');
        if (!verified || context.signal?.aborted || !eromeAllowed()) {
          if (context.signal?.aborted) attempt.finish('timeout');
          attempt.finish(verified ? 'disabled' : 'metadata-unconfirmed');
          observePreview?.([], { ok: false, missing: [], videoMetadata: false });
          await rollback();
          return;
        }
        const albumControl = !privateResponse && interaction.guildId ? albums?.register({ media: preparedMedia, source: eromeSource!,
          requesterId: interaction.user.id, channelId: interaction.channelId, guildId: interaction.guildId,
          messageId: published.id, mode: 'manual',
          ...!interaction.isChatInputCommand() ? { sourceMessageId: interaction.targetMessage.id } : {} }) : undefined;
        const details = await attempt.controls(published.id);
        await interaction.editReply({ components: eromeMediaComponents(preparedMedia, links[0].fixed,
          [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons).toJSON(), ...details.map(row => row.toJSON()),
            ...albumControl ? [albumControl] : []]), allowedMentions: { parse: [] } });
        if (context.signal?.aborted || !eromeAllowed()) { await rollback(); return; }
        observePreview?.([], { ok: true, missing: [], videoMetadata: preparedMedia.kind !== 'image' });
        attempt.finish('confirmed');
      } catch (error) {
        if (rollbackAttempted) throw error;
        await rollback();
      } finally { watcher.close(); }
      return;
    }
    const onStage: EromeProgress = stage => {
      progress.update({ stage: stage === 'queued' ? 'queue' : stage === 'downloading' ? 'download' : 'convert',
        state: 'running', ...(stage === 'cached' ? { cache: 'hit' as const } : {}) });
    };
    if (eromeSource) context.trace?.setPath('attachment');
    const erome = eromeSource && prepareErome && !context.signal?.aborted
      ? await prepareErome(eromeSource, onStage, { maxBytes: eromeBudget, context }).catch(() => null) : null;
    await progress.stop();
    if (signal?.aborted) return;
    if (context.signal?.aborted || eromeSource && (!erome || !eromeAllowed() || !fitsAttachmentBudget(erome.file, eromeBudget))) {
      attempt.finish(context.signal?.aborted ? 'timeout' : 'unavailable');
      const notice = await interaction.editReply({ content: context.signal?.aborted
        ? 'This preview reached its time limit. The original post is unchanged; try again later.'
        : 'The Erome preview could not be prepared within its limits. The album is unchanged. Retry later if the source is busy or unavailable.',
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)], allowedMentions: { parse: [] } });
      const details = await attempt.controls(notice.id);
      if (details.length) await interaction.editReply({ components: [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons), ...details] });
      return;
    }
    let rendered = links.map(link => link.fixed).join('\n');
    rendered = providerHealth?.preferContent(rendered) ?? rendered;
    if (erome) rendered += eromeNotice(erome.videoCount, erome.kind);
    const original = links.map(link => link.source).join('\n');
    let expected = expectedPreviews(original, rendered);
    previewWatch = expected.length ? armPreview?.(interaction.channelId, expected, context) : undefined;
    const publishStage = context.trace?.startStage('publish');
    let message = await interaction.editReply({ content: rendered,
      ...(erome ? { files: [erome.file] } : {}),
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)], allowedMentions: { parse: [] } });
    publishStage?.finish();
    const attempted = new Set<string>();
    const eromeVerified = erome && !context.signal?.aborted ? await verifyErome(message, erome.file) : false;
    const verify = async (): Promise<PreviewResult> => {
      if (context.signal?.aborted) return { ok: false, missing: [...expected], videoMetadata: false };
      const stage = context.trace?.startStage('preview');
      const result = expected.length ? await (previewWatch?.verify(message) ?? verifyPreview(message, expected))
        : { ok: eromeVerified, missing: [], videoMetadata: false };
      stage?.finish(context.signal?.aborted ? 'timeout' : result.ok ? 'ok' : 'unavailable');
      return { ...result, ok: !context.signal?.aborted && result.ok && (!erome || eromeVerified), videoMetadata: result.videoMetadata || eromeVerified && erome?.kind !== 'image' };
    };
    let preview = await verify();
    providerAttempts.push({ expected, result: preview });
    observePreview?.(expected, preview);
    for (let attempt = 0; !preview.ok && attempt < 2 && !context.signal?.aborted; attempt++) {
      const recovered = nextProviderContent(rendered, preview.missing, attempted,
        providerHealth ? (candidates, item) => providerHealth.order(candidates, item) : undefined);
      if (recovered === rendered) break;
      rendered = recovered;
      expected = expectedPreviews(original, rendered);
      previewWatch?.close();
      previewWatch = armPreview?.(interaction.channelId, expected, context);
      message = await interaction.editReply({ content: rendered, embeds: [], allowedMentions: { parse: [] } });
      preview = await verify();
      providerAttempts.push({ expected, result: preview });
      observePreview?.(expected, preview);
    }
    if (!preview.ok || context.signal?.aborted) await interaction.editReply({ content: rendered + (context.signal?.aborted
      ? '\n-# This preview reached its time limit. The original post link is available below; try again later.'
      : '\n-# A useful preview could not be confirmed. The original post link is available below.'),
      ...(erome && !eromeVerified ? { attachments: [] } : {}), allowedMentions: { parse: [] } });
    const details = await attempt.controls(message.id);
    if (details.length) await interaction.editReply({ components: [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons), ...details] });
    attempt.finish(context.signal?.aborted ? 'timeout' : preview.ok ? 'confirmed' : 'metadata-unconfirmed');
  } catch (error) {
    attempt.finish(context.signal?.aborted ? 'timeout' : 'discord-failure');
    throw error;
  } finally {
    await progress.stop();
    previewWatch?.close();
    providerHealth?.recordRecovery(providerAttempts);
    if (media?.reservation) await cancelMediaReservation?.(media.reservation).catch(() => {});
    attempt.close();
  }
}

export async function removeManual(interaction: ButtonInteraction, releaseEromeMedia?: (messageId: string) => Promise<void>): Promise<boolean> {
  if (interaction.customId !== 'linky:remove-manual') return false;
  const message = interaction.message;
  // Discord supplies this metadata; a custom ID or display name is never authority.
  const owner = message.interactionMetadata?.user.id;
  if (message.author.id !== interaction.client.user.id || message.webhookId !== interaction.applicationId ||
      !owner || interaction.user.id !== owner) {
    await interaction.reply({ content: 'Only the person who requested this preview can remove it.',
      flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return true;
  }
  await interaction.deferUpdate();
  await interaction.deleteReply();
  await releaseEromeMedia?.(message.id);
  return true;
}
