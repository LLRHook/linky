import { ActionRowBuilder, ApplicationCommandType, ApplicationIntegrationType, ButtonBuilder, ButtonStyle,
  ContextMenuCommandBuilder, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder,
  type ButtonInteraction, type ChatInputCommandInteraction, type MessageContextMenuCommandInteraction } from 'discord.js';
import type { Config } from '../config';
import { mapLinks, visibleLink } from '../services/LinkTokens';
import { getProviderCandidates, parseSocialUrl } from '../services/SocialProviders';
import { parseYouTubeUrl } from '../services/YouTube';
import { originalPostUrl } from '../services/SocialLinkService';
import { expectedPreviews, nextProviderContent, waitForPreviews, type ExpectedPreview, type PreviewResult } from '../services/PreviewRecovery';
import { parseEromeUrl } from '../services/Erome';
import { eromeNotice, findEromeLinks, canPreviewErome, verifyEromeAttachment, type EromePreparer, type EromeProgress, type EromeStage } from '../services/EromeDelivery';
import type { ServerPreferences } from '../services/ServerSettings';
import { attachmentBudget, fitsAttachmentBudget } from '../services/AttachmentLimits';

const installs = [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall];
const contexts = [InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel];
const eromeProgress: Record<EromeStage, string> = {
  queued: 'Your video is queued. Linky is preparing another video first.',
  downloading: 'Downloading the first video from the album...',
  preparing: 'Preparing the video for Discord...',
  cached: 'Using a recent preview. Uploading it to Discord...',
};
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
  config: Config, { verifyPreview = waitForPreviews, observePreview, prepareErome, verifyErome = verifyEromeAttachment, serverPreferences }: {
    verifyPreview?: typeof waitForPreviews;
    observePreview?: (expected: readonly ExpectedPreview[], result: PreviewResult) => void;
    prepareErome?: EromePreparer;
    verifyErome?: typeof verifyEromeAttachment;
    serverPreferences?: (guildId: string) => ServerPreferences;
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
  const buttons = links.map((link, index) => new ButtonBuilder().setStyle(ButtonStyle.Link)
    .setLabel(index ? `Original post ${index + 1}` : 'Original post').setURL(link.source));
  buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel('Remove').setCustomId('linky:remove-manual'));
  let progress = Promise.resolve(), acceptingProgress = true;
  const onStage: EromeProgress = stage => {
    if (!acceptingProgress) return;
    progress = progress.then(async () => {
      await interaction.editReply({ content: eromeProgress[stage], allowedMentions: { parse: [] } });
    }).catch(() => {});
    return progress;
  };
  const erome = eromeSource && prepareErome ? await prepareErome(eromeSource, onStage, { maxBytes: eromeBudget }).catch(() => null) : null;
  acceptingProgress = false;
  // Discord REST bounds each request; drain accepted edits so none can overwrite the final reply.
  await progress;
  if (eromeSource && (!erome || !eromeAllowed() || !fitsAttachmentBudget(erome.file, eromeBudget))) {
    await interaction.editReply({ content: 'The Erome video could not be prepared. The album is unchanged. Limits: 64 MiB input and 5 minutes; unavailable, protected or busy media is skipped.',
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)], allowedMentions: { parse: [] } });
    return;
  }
  let rendered = links.map(link => link.fixed).join('\n');
  if (erome) rendered += eromeNotice(erome.videoCount);
  let message = await interaction.editReply({ content: rendered,
    ...(erome ? { files: [erome.file] } : {}),
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)], allowedMentions: { parse: [] } });
  const original = links.map(link => link.source).join('\n');
  const attempted = new Set<string>();
  let expected = expectedPreviews(original, rendered);
  const eromeVerified = erome ? await verifyErome(message, erome.file) : false;
  const verify = async (): Promise<PreviewResult> => {
    const result = expected.length ? await verifyPreview(message, expected) : { ok: eromeVerified, missing: [], videoMetadata: false };
    return { ...result, ok: result.ok && (!erome || eromeVerified), videoMetadata: result.videoMetadata || eromeVerified };
  };
  let preview = await verify();
  observePreview?.(expected, preview);
  for (let attempt = 0; !preview.ok && attempt < 2; attempt++) {
    const recovered = nextProviderContent(rendered, preview.missing, attempted);
    if (recovered === rendered) break;
    rendered = recovered;
    message = await interaction.editReply({ content: rendered, embeds: [], allowedMentions: { parse: [] } });
    expected = expectedPreviews(original, rendered);
    preview = await verify();
    observePreview?.(expected, preview);
  }
  if (!preview.ok) await interaction.editReply({ content: rendered + '\n-# A useful preview could not be confirmed. The original post link is available below.',
    ...(erome && !eromeVerified ? { attachments: [] } : {}), allowedMentions: { parse: [] } });
}

export async function removeManual(interaction: ButtonInteraction): Promise<boolean> {
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
  return true;
}
