import { ActionRowBuilder, ApplicationCommandType, ApplicationIntegrationType, ButtonBuilder, ButtonStyle,
  ContextMenuCommandBuilder, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder,
  type ButtonInteraction, type ChatInputCommandInteraction, type MessageContextMenuCommandInteraction } from 'discord.js';
import type { Config } from '../config';
import { mapLinks, visibleLink } from '../services/LinkTokens';
import { getProviderCandidates, parseSocialUrl } from '../services/SocialProviders';
import { parseYouTubeUrl } from '../services/YouTube';
import { originalPostUrl } from '../services/SocialLinkService';
import { expectedPreviews, nextProviderContent, waitForPreviews, type ExpectedPreview, type PreviewResult } from '../services/PreviewRecovery';

const installs = [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall];
const contexts = [InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel];
export const data = new SlashCommandBuilder().setName('fix').setDescription('Make a link preview on request, without enabling automatic fixing.')
  .setIntegrationTypes(...installs).setContexts(...contexts)
  .addStringOption(option => option.setName('link').setDescription('An Instagram, TikTok, X, YouTube, Bluesky, Reddit post or Twitch clip URL.').setRequired(true).setMaxLength(1500));
export const contextData = new ContextMenuCommandBuilder().setName('Fix with Linky').setType(ApplicationCommandType.Message)
  .setIntegrationTypes(...installs).setContexts(...contexts);

/** Only URL tokens supplied by this explicit interaction are used; nothing is fetched from chat history. */
export function manualLinks(content: string, config: Pick<Config, 'rewritePlatforms'>): { source: string; fixed: string }[] {
  const links = new Map<string, { source: string; fixed: string }>();
  mapLinks(content, (url, position) => {
    if (!visibleLink(content, position)) return url;
    const social = parseSocialUrl(url);
    const youtube = parseYouTubeUrl(url);
    if (social && config.rewritePlatforms.includes(social.platform)) {
      const fixed = getProviderCandidates(social)[0]?.url;
      if (fixed) links.set(social.sourceUrl, { source: originalPostUrl(social.sourceUrl), fixed: originalPostUrl(fixed) });
    } else if (youtube) {
      // Native video links do not need an API key, statistics, or a cleanup journal.
      links.set(youtube.url, { source: youtube.url, fixed: youtube.url });
    }
    return url;
  });
  return [...links.values()].slice(0, 3);
}

export async function execute(interaction: ChatInputCommandInteraction | MessageContextMenuCommandInteraction,
  config: Config, { verifyPreview = waitForPreviews, observePreview }: {
    verifyPreview?: typeof waitForPreviews;
    observePreview?: (expected: readonly ExpectedPreview[], result: PreviewResult) => void;
  } = {}): Promise<void> {
  const content = interaction.isChatInputCommand() ? interaction.options.getString('link', true) : interaction.targetMessage.content;
  const links = manualLinks(content, config);
  if (!links.length) {
    await interaction.reply({ content: 'No supported post link found. Choose an Instagram, TikTok, X/Twitter, YouTube, Bluesky or Reddit post, or a Twitch clip. Links inside <angle brackets>, spoilers or code are skipped.',
      flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return;
  }
  const sendPermission = interaction.channel?.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
  const privateResponse = interaction.inGuild() && !interaction.memberPermissions?.has(sendPermission);
  await interaction.deferReply(privateResponse ? { flags: MessageFlags.Ephemeral } : {});
  const buttons = links.map((link, index) => new ButtonBuilder().setStyle(ButtonStyle.Link)
    .setLabel(index ? `Original post ${index + 1}` : 'Original post').setURL(link.source));
  buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel('Remove').setCustomId('linky:remove-manual'));
  let rendered = links.map(link => link.fixed).join('\n');
  let message = await interaction.editReply({ content: rendered,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)], allowedMentions: { parse: [] } });
  const original = links.map(link => link.source).join('\n');
  const attempted = new Set<string>();
  let expected = expectedPreviews(original, rendered);
  let preview = await verifyPreview(message, expected);
  observePreview?.(expected, preview);
  for (let attempt = 0; !preview.ok && attempt < 2; attempt++) {
    const recovered = nextProviderContent(rendered, preview.missing, attempted);
    if (recovered === rendered) break;
    rendered = recovered;
    message = await interaction.editReply({ content: rendered, embeds: [], allowedMentions: { parse: [] } });
    expected = expectedPreviews(original, rendered);
    preview = await verifyPreview(message, expected);
    observePreview?.(expected, preview);
  }
  if (!preview.ok) await interaction.editReply({ content: rendered + '\n-# A useful preview could not be confirmed. The original post link is available below.', allowedMentions: { parse: [] } });
}

export async function removeManual(interaction: ButtonInteraction): Promise<boolean> {
  if (interaction.customId !== 'linky:remove-manual') return false;
  const message = interaction.message;
  // Discord supplies this metadata; a custom ID or display name is never authority.
  const owner = message.interactionMetadata?.user.id;
  const moderator = interaction.inGuild() && interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages);
  if (message.author.id !== interaction.client.user.id || message.webhookId !== interaction.applicationId ||
      !owner || (interaction.user.id !== owner && !moderator)) {
    await interaction.reply({ content: 'Only the person who requested this preview or a channel moderator can remove it.',
      flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return true;
  }
  await interaction.deferUpdate();
  await interaction.deleteReply();
  return true;
}
