import { ActionRowBuilder, ApplicationCommandType, ApplicationIntegrationType, ButtonBuilder, ButtonStyle, ComponentType,
  ContextMenuCommandBuilder, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder,
  type ButtonInteraction, type ChatInputCommandInteraction, type Message, type MessageContextMenuCommandInteraction } from 'discord.js';
import type { Config } from '../config';
import { mapLinks, visibleLink } from '../services/LinkTokens';
import { getProviderCandidates, parseSocialUrl } from '../services/SocialProviders';
import { parseYouTubeUrl } from '../services/YouTube';
import { COMMUNITY_MIXED_GUIDANCE, hasMixedYouTubeCommunityLinks, communityEmbedBudget, findYouTubeCommunityLinks, parseYouTubeCommunityUrl, prepareYouTubeCommunityPosts,
  type YouTubeCommunityLookup } from '../services/YouTubeCommunity';
import { originalPostUrl } from '../services/RepostPresentation';
import { expectedPreviews, inspectPreviews, nextProviderContent, waitForPreviews, type ExpectedPreview, type PreviewResult } from '../services/PreviewRecovery';
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
import { EROME_UNAVAILABLE, isEromeAvailable } from '../services/EromeAvailability';
import { hasMobileShareLinks, type MobileShareLinkNormalizer } from '../services/MobileShareLinks';
import { addInstagramCaptions } from '../services/InstagramPresentation';
import { parseInstagramUrl, type InstagramTranslation } from '../services/InstagramTranslation';

const installs = [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall];
const contexts = [InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel];
export const data = new SlashCommandBuilder().setName('fix').setDescription('Make a link preview on request, without enabling automatic fixing.')
  .setIntegrationTypes(...installs).setContexts(...contexts)
  .addStringOption(option => option.setName('link').setDescription('A supported social post, video or clip URL.').setRequired(true).setMaxLength(1500));
export const contextData = new ContextMenuCommandBuilder().setName('Fix with Linky').setType(ApplicationCommandType.Message)
  .setIntegrationTypes(...installs).setContexts(...contexts);

/** Only URL tokens supplied by this explicit interaction are used; nothing is fetched from chat history. */
export function manualLinks(content: string, config: Pick<Config, 'rewritePlatforms' | 'eromeGuildIds'>,
  guildId?: string | null, limit = 3): { source: string; fixed: string }[] {
  const links = new Map<string, { source: string; fixed: string }>();
  let eromeAdded = false;
  mapLinks(content, (url, position) => {
    if (!visibleLink(content, position)) return url;
    const social = parseSocialUrl(url);
    const youtube = parseYouTubeUrl(url);
    const community = parseYouTubeCommunityUrl(url);
    const erome = parseEromeUrl(url);
    if (social && config.rewritePlatforms.includes(social.platform)) {
      const fixed = getProviderCandidates(social)[0]?.url;
      if (fixed) links.set(social.sourceUrl, { source: originalPostUrl(social.sourceUrl), fixed: originalPostUrl(fixed) });
    } else if (erome && isEromeAvailable(config, guildId) && !eromeAdded) {
      links.set(erome.url, { source: erome.url, fixed: `<${erome.url}>` });
      eromeAdded = true;
    } else if (youtube) {
      // Native video links do not need an API key, statistics, or a cleanup journal.
      links.set(youtube.url, { source: youtube.url, fixed: youtube.url });
    } else if (community && config.rewritePlatforms.includes('youtube')) {
      links.set(community.url, { source: community.url, fixed: `<${community.url}>` });
    }
    return url;
  });
  return [...links.values()].slice(0, Math.max(1, Math.min(6, limit)));
}

export async function execute(interaction: ChatInputCommandInteraction | MessageContextMenuCommandInteraction,
  config: Config, { verifyPreview = waitForPreviews, observePreview, prepareErome, verifyErome = verifyEromeAttachment,
    prepareEromeMedia, bindEromeMedia, releaseEromeMedia, cancelMediaReservation, serverPreferences,
    diagnostics, armPreview, providerHealth, albums, normalizeMobileLinks, translateInstagram, lookupYouTubeCommunity, signal }: {
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
    normalizeMobileLinks?: MobileShareLinkNormalizer;
    translateInstagram?: (sourceUrl: string) => Promise<InstagramTranslation | null>;
    lookupYouTubeCommunity?: YouTubeCommunityLookup;
    signal?: AbortSignal;
  } = {}): Promise<void> {
  let content = interaction.isChatInputCommand() ? interaction.options.getString('link', true) : interaction.targetMessage.content;
  const sourceContent = content;
  const sourceEditedAt = interaction.isChatInputCommand() ? undefined : interaction.targetMessage.editedTimestamp;
  const preferences = interaction.guildId ? serverPreferences?.(interaction.guildId) ?? {} : {};
  const preferenceVersion = JSON.stringify(preferences);
  const preferencesCurrent = () => !interaction.guildId ||
    JSON.stringify(serverPreferences?.(interaction.guildId) ?? {}) === preferenceVersion;
  const activeConfig = { ...config,
    rewritePlatforms: config.rewritePlatforms.filter(platform => preferences.platforms?.[platform] !== false) };
  const sendPermission = interaction.channel?.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
  const privateResponse = interaction.inGuild() && !interaction.memberPermissions?.has(sendPermission);
  let deferred = false;
  const defer = async () => {
    if (!deferred) {
      await interaction.deferReply(privateResponse ? { flags: MessageFlags.Ephemeral } : {});
      deferred = true;
    }
  };
  const reject = async (content: string) => {
    if (deferred) await interaction.editReply({ content, allowedMentions: { parse: [] } });
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  };
  if (hasMixedYouTubeCommunityLinks(content, activeConfig.rewritePlatforms.filter(platform =>
    platform !== 'erome' || isEromeAvailable(config, interaction.guildId)))) {
    const attempt = createDeliveryAttempt({ requesterId: interaction.user.id, channelId: interaction.channelId,
      guildId: interaction.guildId ?? undefined, mode: 'manual', platform: deliveryPlatform(content) }, diagnostics, undefined, signal);
    try {
      attempt.context.trace?.setPath('explicit');
      attempt.finish('unsupported');
      await reject(COMMUNITY_MIXED_GUIDANCE);
    } finally { attempt.close(); }
    return;
  }
  if (normalizeMobileLinks && hasMobileShareLinks(content, activeConfig.rewritePlatforms)) {
    // Share redirects can exceed Discord's acknowledgement window.
    await defer();
    try { content = (await normalizeMobileLinks(content, activeConfig.rewritePlatforms, signal)).content; }
    catch { /* Keep the caller's original links if resolution is unavailable. */ }
    if (signal?.aborted || !preferencesCurrent()) {
      await reject('Link settings changed or preparation was cancelled. The original post is unchanged; try again.');
      return;
    }
  }
  const eromeAllowed = () => interaction.inGuild() && isEromeAvailable(config, interaction.guildId) && canPreviewErome(interaction.channel,
    interaction.guildId ? serverPreferences?.(interaction.guildId)?.eromeChannels : undefined);
  const communityLinks = activeConfig.rewritePlatforms.includes('youtube') ? findYouTubeCommunityLinks(content, 6) : [];
  const links = manualLinks(content, activeConfig, interaction.guildId, communityLinks.length ? 6 : 3)
    .filter(link => !parseYouTubeUrl(link.source) || preferences.platforms?.youtube !== false);
  if (communityLinks.length && (communityLinks.length > 5 || links.length > 5)) {
    await reject('Choose at most five posts for one community preview. The original message is unchanged.');
    return;
  }
  if (findEromeLinks(content).length && !isEromeAvailable(config, interaction.guildId) && !links.length) {
    await reject(EROME_UNAVAILABLE);
    return;
  }
  if (links.some(link => parseEromeUrl(link.source)) && !eromeAllowed()) {
    await reject('Erome requires a server channel allowed by its settings. Use an age-restricted channel, or ask a server admin to set /settings erome_channels:all.');
    return;
  }
  if (!links.length) {
    await reject('No supported post link found. Choose an Instagram, TikTok, X/Twitter, YouTube, Bluesky or Reddit post, or a Twitch clip.' +
      (isEromeAvailable(config, interaction.guildId) ? ' Erome albums also work in allowed server channels.' : '') +
      ' Links inside <angle brackets>, spoilers or code are skipped.');
    return;
  }
  const eromeSource = links.find(link => parseEromeUrl(link.source))?.source;
  if (eromeSource && !interaction.appPermissions?.has(PermissionFlagsBits.AttachFiles)) {
    await reject('Linky needs Attach Files permission to post an Erome video preview.');
    return;
  }
  const eromeBudget = attachmentBudget(interaction.attachmentSizeLimit);
  if (eromeSource && !eromeBudget) {
    await reject('Discord has not provided a usable file upload limit for this preview. The album is unchanged.');
    return;
  }
  await defer();
  const progress = createDeliveryProgress(text => interaction.editReply({ content: text, allowedMentions: { parse: [] } }), { delayMs: 500 });
  const attempt = createDeliveryAttempt({ requesterId: interaction.user.id, channelId: interaction.channelId,
    guildId: interaction.guildId ?? undefined, mode: 'manual', platform: deliveryPlatform(links.map(link => link.source).join('\n')) },
    diagnostics, progress.update, signal);
  const context = attempt.context;
  const providerAttempts: ProviderAttempt[] = [];
  let previewWatch: PreviewWatch | undefined;
  let media: EromeMedia | null = null;
  try {
    const buttons = links.map((link, index) => new ButtonBuilder().setStyle(ButtonStyle.Link)
      .setLabel(index ? `Original post ${index + 1}` : 'Original post').setURL(link.source));
    buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel('Remove').setCustomId('linky:remove-manual'));
    const buttonRows = () => [0, 5].filter(start => buttons.length > start)
      .map(start => new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(start, start + 5)));
    const stopChangedPreferences = async () => {
      if (preferencesCurrent()) return false;
      attempt.finish('disabled');
      const eromeRevoked = eromeSource && (!eromeAllowed() ||
        interaction.guildId && serverPreferences?.(interaction.guildId)?.platforms?.erome === false);
      await interaction.editReply({ content: eromeRevoked
        ? 'Erome previews are no longer allowed here. The album is unchanged and available below.'
        : 'Link settings changed while the preview was being prepared. The original post is unchanged and available below.',
        embeds: [], attachments: [], flags: MessageFlags.SuppressEmbeds, components: buttonRows(), allowedMentions: { parse: [] } });
      return true;
    };
    const sourceCurrent = async () => {
      if (context.signal?.aborted || !preferencesCurrent()) return false;
      if (interaction.isChatInputCommand()) return true;
      try {
        const source = interaction.targetMessage;
        const current = typeof source.fetch === 'function' ? await source.fetch(true) : source;
        return !context.signal?.aborted && preferencesCurrent() && current.content === sourceContent && current.editedTimestamp === sourceEditedAt;
      } catch { return false; }
    };
    const community = communityLinks.length
      ? await prepareYouTubeCommunityPosts(communityLinks, lookupYouTubeCommunity, context.signal) : [];
    if (await stopChangedPreferences()) return;
    if (community === null || community.length && !await sourceCurrent()) {
      await progress.stop();
      attempt.finish(context.signal?.aborted ? 'cancelled' : 'unavailable');
      await interaction.editReply({ content: 'The community preview could not be verified, or its source changed. The original is unchanged.',
        components: buttonRows(), allowedMentions: { parse: [] } });
      return;
    }
    if (community.length) context.trace?.setPath('explicit');
    const stopChangedSource = async () => {
      if (!community.length || await sourceCurrent()) return false;
      if (await stopChangedPreferences()) return true;
      attempt.finish(context.signal?.aborted ? 'cancelled' : 'unavailable');
      await interaction.editReply({ content: 'The source changed or became unavailable. The community preview was removed; the original is unchanged.',
        embeds: [], attachments: [], components: buttonRows(), allowedMentions: { parse: [] } });
      return true;
    };
    if (eromeSource) progress.update({ stage: 'resolve', state: 'running' });
    media = eromeSource && eromeAllowed() && links.length === 1 && findEromeLinks(content).length === 1 && onlyEromeLinks(content) &&
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
        const albumControl = !privateResponse && interaction.guildId ? albums?.register({ media: preparedMedia, source: eromeSource!,
          requesterId: interaction.user.id, channelId: interaction.channelId, guildId: interaction.guildId,
          messageId: published.id, mode: 'manual',
          ...!interaction.isChatInputCommand() ? { sourceMessageId: interaction.targetMessage.id } : {} }) : undefined;
        const details = await attempt.controls(published.id);
        if (context.signal?.aborted || !eromeAllowed() || !preferencesCurrent()) { await rollback(); return; }
        await interaction.editReply({ components: eromeMediaComponents(preparedMedia, links[0].fixed,
          [...buttonRows().map(row => row.toJSON()), ...details.map(row => row.toJSON()),
            ...albumControl ? [albumControl] : []]), allowedMentions: { parse: [] } });
        if (context.signal?.aborted || !eromeAllowed() || !preferencesCurrent()) { await rollback(); return; }
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
    const erome = eromeSource && eromeAllowed() && prepareErome && !context.signal?.aborted
      ? await prepareErome(eromeSource, onStage, { maxBytes: eromeBudget, context }).catch(() => null) : null;
    await progress.stop();
    if (signal?.aborted) return;
    if (await stopChangedPreferences()) return;
    if (context.signal?.aborted || eromeSource && (!erome || !eromeAllowed() || !fitsAttachmentBudget(erome.file, eromeBudget))) {
      attempt.finish(context.signal?.aborted ? 'timeout' : eromeSource && !eromeAllowed() ? 'disabled' : 'unavailable');
      const notice = await interaction.editReply({ content: context.signal?.aborted
        ? 'This preview reached its time limit. The original post is unchanged; try again later.'
        : !eromeAllowed() ? 'Erome previews are no longer allowed here. The album is unchanged.'
          : 'The Erome preview could not be prepared within its limits. The album is unchanged. Retry later if the source is busy or unavailable.',
        components: buttonRows(), allowedMentions: { parse: [] } });
      const details = await attempt.controls(notice.id);
      if (details.length) await interaction.editReply({ components: [...buttonRows(), ...details] });
      return;
    }
    let rendered = links.map(link => link.fixed).join('\n');
    const original = links.map(link => link.source).join('\n');
    const presentation = await addInstagramCaptions(original, { content: rendered },
      preferences.translateInstagram !== false ? translateInstagram : undefined, 1800, preferences.instagramPresentation);
    if (context.signal?.aborted || !preferencesCurrent()) {
      attempt.finish(context.signal?.aborted ? 'timeout' : 'disabled');
      await reject('Link settings changed or preparation was cancelled. The original post is unchanged; try again.');
      return;
    }
    rendered = providerHealth?.preferContent(presentation.content) ?? presentation.content;
    if (erome) rendered += eromeNotice(erome.videoCount, erome.kind);
    const instagramIds = new Set((presentation.instagramSources ?? []).map(url => parseInstagramUrl(url)?.shortcode));
    const instagramVideos = new Set((presentation.instagramVideos ?? []).map(url => parseInstagramUrl(url)?.shortcode));
    const expectations = () => expectedPreviews(original, rendered, community).map(item => {
      const id = parseInstagramUrl(item.source)?.shortcode;
      return { ...item, ...(id && instagramIds.has(id) ? { captionFree: true } : {}),
        ...(id && instagramVideos.has(id) ? { requireVideo: true } : {}) };
    });
    let expected = expectations();
    const embeds = community.flatMap(post => post.embeds);
    if (community.length && (!communityEmbedBudget(embeds, expected.filter(item => !item.explicitEmbeds).length) || !await sourceCurrent())) {
      attempt.finish(context.signal?.aborted ? 'cancelled' : 'unavailable');
      await interaction.editReply({ content: 'The complete community preview exceeds the message limits, or its source changed. Share fewer posts; the original is unchanged.',
        components: buttonRows(), allowedMentions: { parse: [] } });
      return;
    }
    const nativeExpected = expected.filter(item => !item.explicitEmbeds);
    previewWatch = nativeExpected.length ? armPreview?.(interaction.channelId, nativeExpected, context) : undefined;
    const publishStage = context.trace?.startStage('publish');
    if (await stopChangedPreferences()) return;
    let message = await interaction.editReply({ content: rendered,
      ...(embeds.length ? { embeds } : {}),
      ...(erome ? { files: [erome.file] } : {}),
      components: buttonRows(), allowedMentions: { parse: [] } });
    publishStage?.finish();
    const attempted = new Set<string>();
    const eromeVerified = erome && !context.signal?.aborted ? await verifyErome(message, erome.file) : false;
    const verify = async (): Promise<PreviewResult> => {
      if (context.signal?.aborted || eromeSource && !eromeAllowed()) return { ok: false, missing: [...expected], videoMetadata: false };
      const stage = context.trace?.startStage('preview');
      const native = expected.filter(item => !item.explicitEmbeds), explicit = expected.filter(item => item.explicitEmbeds);
      const observed = native.length ? await (previewWatch?.verify(message) ?? verifyPreview(message, native))
        : { ok: explicit.length > 0 || eromeVerified, missing: [], videoMetadata: false };
      const latest = explicit.length && native.length ? await message.fetch(true).catch(() => null) : message;
      const cards = explicit.length ? inspectPreviews(latest?.embeds.map(embed => embed.toJSON()) ?? [], explicit)
        : { ok: true, missing: [], videoMetadata: false };
      const result = { ...observed, ok: observed.ok && cards.ok, missing: [...observed.missing, ...cards.missing] };
      stage?.finish(context.signal?.aborted ? 'timeout' : result.ok ? 'ok' : 'unavailable');
      return { ...result, ok: !context.signal?.aborted && result.ok && (!erome || eromeVerified), videoMetadata: result.videoMetadata || eromeVerified && erome?.kind !== 'image' };
    };
    let preview = await verify();
    if (await stopChangedPreferences()) return;
    providerAttempts.push({ expected, result: preview });
    observePreview?.(expected, preview);
    for (let attempt = 0; !preview.ok && attempt < 2 && !context.signal?.aborted && (!eromeSource || eromeAllowed()); attempt++) {
      if (await stopChangedPreferences()) return;
      const recovered = nextProviderContent(rendered, preview.missing, attempted,
        providerHealth ? (candidates, item) => providerHealth.order(candidates, item) : undefined);
      if (recovered === rendered) break;
      rendered = recovered;
      expected = expectations();
      previewWatch?.close();
      const native = expected.filter(item => !item.explicitEmbeds);
      previewWatch = native.length ? armPreview?.(interaction.channelId, native, context) : undefined;
      message = await interaction.editReply({ content: rendered, embeds, allowedMentions: { parse: [] } });
      preview = await verify();
      if (await stopChangedPreferences()) return;
      providerAttempts.push({ expected, result: preview });
      observePreview?.(expected, preview);
    }
    if (community.length && !await sourceCurrent()) {
      if (await stopChangedPreferences()) return;
      attempt.finish(context.signal?.aborted ? 'cancelled' : 'unavailable');
      await interaction.editReply({ content: 'The source changed or became unavailable. The community preview was removed; the original is unchanged.',
        embeds: [], attachments: [], components: buttonRows(), allowedMentions: { parse: [] } });
      return;
    }
    if (eromeSource && !eromeAllowed()) {
      attempt.finish('disabled');
      await interaction.editReply({ content: 'Erome previews are no longer allowed here. The album is unchanged.',
        attachments: [], embeds: [], allowedMentions: { parse: [] } });
      return;
    }
    if (await stopChangedPreferences()) return;
    if (!preview.ok || context.signal?.aborted) await interaction.editReply({ content: rendered + (context.signal?.aborted
      ? '\n-# This preview reached its time limit. The original post link is available below; try again later.'
      : '\n-# A useful preview could not be confirmed. The original post link is available below.'),
      ...(erome && !eromeVerified ? { attachments: [] } : {}), allowedMentions: { parse: [] } });
    const details = await attempt.controls(message.id);
    if (await stopChangedPreferences()) return;
    if (await stopChangedSource()) return;
    if (details.length) await interaction.editReply({ components: [...buttonRows(), ...details] });
    if (await stopChangedPreferences()) return;
    if (await stopChangedSource()) return;
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
