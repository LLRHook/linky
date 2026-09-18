import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, ContainerBuilder,
  MessageFlags, PermissionFlagsBits, SeparatorBuilder, StringSelectMenuBuilder, TextDisplayBuilder,
  type ButtonInteraction, type ChannelSelectMenuInteraction, type StringSelectMenuInteraction,
  type ChatInputCommandInteraction, type PermissionsBitField,
} from 'discord.js';
import type { Config } from '../config';
import type { ServerSettings } from '../services/ServerSettings';
import { REWRITE_PLATFORMS } from '../services/LinkConfiguration';
import { evaluateScope } from '../services/ServerScope';
import { effectivePreferences, PLATFORM_NAMES } from './settings';
import { EROME_UNAVAILABLE, isEromeAvailable } from '../services/EromeAvailability';

const PREFIX = 'linky:setup:';
export const SETUP_ACTIONS = {
  mode: PREFIX + 'mode', platforms: PREFIX + 'platforms', channels: PREFIX + 'channels',
  enable: PREFIX + 'enable', disable: PREFIX + 'disable', allChannels: PREFIX + 'all-channels',
  test: PREFIX + 'test',
} as const;
const CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum,
  ChannelType.GuildMedia, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread];
type SetupComponent = ButtonInteraction | ChannelSelectMenuInteraction | StringSelectMenuInteraction;
interface PanelContext {
  guildId: string; channelId: string; threadParentId?: string | null;
  permissions?: Readonly<PermissionsBitField> | null; canSend?: boolean; isThread?: boolean;
}
export type SetupTest = (interaction: ButtonInteraction) => Promise<string>;

export function setupContext(interaction: SetupComponent | ChatInputCommandInteraction): PanelContext {
  const channel = interaction.channel, member = interaction.guild?.members.me;
  return { guildId: interaction.guildId!, channelId: interaction.channelId,
    threadParentId: channel?.isThread() ? channel.parentId : undefined,
    isThread: channel?.isThread(), canSend: channel?.isSendable(),
    permissions: member && channel && 'permissionsFor' in channel ? channel.permissionsFor(member) : null };
}

/** Share the current-channel check with the explicit test; a saved enable flag alone is not readiness. */
export function setupReadiness(context: PanelContext, config: Config, servers: ServerSettings) {
  const preferences = servers.getPreferences(context.guildId);
  const effective = effectivePreferences(config, preferences, context.guildId);
  const scope = evaluateScope({ ...context, preferences, serverEnabled: servers.get(context.guildId),
    operatorChannelIds: config.channelIds, operatorServerIds: config.serverIds });
  const required: [string, bigint][] = [
    ['View Channel', PermissionFlagsBits.ViewChannel], ['Read Message History', PermissionFlagsBits.ReadMessageHistory],
    ['Embed Links', PermissionFlagsBits.EmbedLinks],
    context.isThread ? ['Send Messages in Threads', PermissionFlagsBits.SendMessagesInThreads] : ['Send Messages', PermissionFlagsBits.SendMessages],
    ...(effective.mode === 'replace' ? [['Manage Messages', PermissionFlagsBits.ManageMessages] as [string, bigint]] : []),
  ];
  const missing = context.permissions ? required.filter(([, bit]) => !context.permissions!.has(bit)).map(([name]) => name) : undefined;
  const summary = !scope.enabled ? 'Not ready: Linky is disabled in this channel.' : !effective.platforms.length
    ? 'Not ready: no platforms are enabled.' : context.canSend === false
      ? 'Not ready: this channel cannot receive messages. Open a forum or media post to test inside its thread.' : missing === undefined
        ? 'Permissions could not be checked. Open /setup in the target channel again.' : missing.length
          ? `Missing permissions: ${missing.join(', ')}.` : 'Ready for a plain link: required channel permissions are present.';
  return { ready: scope.enabled && effective.platforms.length > 0 && context.canSend === true && missing?.length === 0, summary };
}

export function isSetupComponent(interaction: { customId: string }): boolean {
  return Object.values(SETUP_ACTIONS).includes(interaction.customId);
}

export function buildSetupPanel(context: PanelContext, config: Config, servers: ServerSettings, notice?: string) {
  const preferences = servers.getPreferences(context.guildId);
  const effective = effectivePreferences(config, preferences, context.guildId);
  const eromeAvailable = isEromeAvailable(config, context.guildId);
  const choices = REWRITE_PLATFORMS.filter(platform => platform !== 'erome' || eromeAvailable);
  const enabled = servers.get(context.guildId);
  const scope = evaluateScope({ ...context, serverEnabled: enabled, preferences,
    operatorChannelIds: config.channelIds, operatorServerIds: config.serverIds });
  const channels = preferences.channelIds;
  const mode = new StringSelectMenuBuilder().setCustomId(SETUP_ACTIONS.mode).setPlaceholder('Choose how Linky posts')
    .addOptions({ label: 'Replace', value: 'replace', description: 'Replace the original after its new preview is checked.', default: effective.mode === 'replace' },
      { label: 'Reply', value: 'reply', description: 'Keep the original and add a reply.', default: effective.mode === 'reply' });
  const platforms = new StringSelectMenuBuilder().setCustomId(SETUP_ACTIONS.platforms)
    .setPlaceholder('Select platforms; clear to turn all off').setMinValues(0).setMaxValues(choices.length)
    .addOptions(choices.map(platform => ({ label: PLATFORM_NAMES[platform], value: platform,
      description: config.rewritePlatforms.includes(platform) ? `Fix ${PLATFORM_NAMES[platform]} links.` : 'Unavailable on this bot.',
      default: effective.platforms.includes(platform) })));
  const channelSelect = new ChannelSelectMenuBuilder().setCustomId(SETUP_ACTIONS.channels)
    .setPlaceholder('Choose up to 25 channels; clear for none').setMinValues(0).setMaxValues(25)
    .addChannelTypes(CHANNEL_TYPES);
  if (channels?.length) channelSelect.setDefaultChannels(channels);
  const status = scope.enabled ? '**Active in this channel**' :
    scope.reason === 'server-disabled' ? '**Server disabled**' :
      scope.reason === 'channel-excluded' ? '**Not active in this channel**' : '**Not enabled in this channel**';
  const access = scope.source === 'operator-channel' ? 'Access is limited to the bot’s configured channels.' :
    scope.reason === 'channel-excluded' ? 'This channel is outside your selection.' :
      scope.enabled ? 'Linky fixes links wherever your selection and permissions allow.' :
        'Enable the server to start in your chosen channels.';
  const channelSummary = channels === undefined ? 'All allowed channels' :
    channels.length ? `${channels.length} selected` : 'None selected · Linky will stay inactive';
  const savedChannels = channels?.length ? `Saved selection: ${channels.map(id => `<#${id}>`).join(', ')}.` :
    channels === undefined ? 'Saved selection: inherit allowed channels.' : 'Saved selection: no channels.';
  const effectiveChannels = enabled === false ? 'Effective scope: server disabled; selections retained.' :
    enabled === true || config.serverIds.includes(context.guildId) ? channels === undefined
      ? 'Effective scope: all accessible server channels.' : 'Effective scope: selected channels and their accessible threads.'
      : 'Effective scope: operator-configured channels only, further restricted by your selection.';
  const readiness = setupReadiness(context, config, servers);
  const threadHint = enabled === true || config.serverIds.includes(context.guildId)
    ? 'Selected parent channels include their accessible threads.' : 'Existing channel access still applies.';
  const text = (content: string) => new TextDisplayBuilder().setContent(content);
  const card = new ContainerBuilder().setAccentColor(scope.enabled ? 0x24c8d5 : 0x747f8d)
    .addTextDisplayComponents(text(`## Linky setup\n${status}\n-# ${access}`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(text('**Posting mode**\n' +
      '**Reply example:** your original link stays; Linky adds an attributed reply with the available preview.\n' +
      '**Replace example:** Linky posts an attributed replacement, checks the preview, then removes your original. If it cannot verify delivery, your original stays.\n' +
      '-# Examples only. Original post opens the source; Remove stays with the original sharer.'))
    .addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(mode))
    .addTextDisplayComponents(text(`**Platforms** · ${effective.platforms.length} enabled`))
    .addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(platforms))
    .addTextDisplayComponents(text(`**Channels** · ${channelSummary}\n${savedChannels}\n${effectiveChannels}\n-# ${threadHint}`))
    .addActionRowComponents(new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(channelSelect))
    .addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(SETUP_ACTIONS.enable).setLabel('Enable server').setStyle(ButtonStyle.Primary).setDisabled(enabled === true),
      new ButtonBuilder().setCustomId(SETUP_ACTIONS.disable).setLabel('Disable server').setStyle(ButtonStyle.Secondary).setDisabled(enabled === false),
      new ButtonBuilder().setCustomId(SETUP_ACTIONS.allChannels).setLabel('All channels').setStyle(ButtonStyle.Secondary).setDisabled(channels === undefined),
      new ButtonBuilder().setCustomId(SETUP_ACTIONS.test).setLabel('Test here').setStyle(ButtonStyle.Secondary),
    ))
    .addTextDisplayComponents(text([
      notice && `-# ${notice}`,
      `**Readiness in this channel:** ${readiness.summary}`,
      '-# Attach Files may also be needed for media uploads or long translations. Provider delivery is checked only by an explicit test or a posted link.',
      '-# Test here sends one harmless sample to this channel. Opening setup and saving choices never posts a sample.',
      !eromeAvailable && `-# ${EROME_UNAVAILABLE}`,
      '-# Selections save automatically. They never enable the server.',
      '-# /settings · Translation & YouTube   /diagnose · Channel check',
    ].filter(Boolean).join('\n')));
  return {
    // Clear legacy panel text when an existing pre-V2 message is updated.
    content: null,
    embeds: [],
    flags: MessageFlags.IsComponentsV2 as const,
    components: [card],
    allowedMentions: { parse: [] as [] },
  };
}

/** Stateless panels survive restart; each click checks the current member permissions again. */
export async function handleSetupComponent(interaction: SetupComponent, config: Config, servers: ServerSettings, testHere?: SetupTest): Promise<boolean> {
  if (!isSetupComponent(interaction)) return false;
  if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: 'Use Linky setup in a server where you have Manage Server permission.',
      flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return true;
  }
  const id = interaction.customId;
  const context = setupContext(interaction);
  if (id === SETUP_ACTIONS.test && interaction.isButton()) {
    const readiness = setupReadiness(context, config, servers);
    if (!readiness.ready || !testHere) {
      await interaction.reply({ content: !readiness.ready ? `${readiness.summary} No sample was posted.`
        : 'The sample test is unavailable on this bot. No sample was posted.', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return true;
    }
    await interaction.deferUpdate();
    const current = setupReadiness(setupContext(interaction), config, servers);
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) || !current.ready) {
      await interaction.editReply(buildSetupPanel(setupContext(interaction), config, servers, 'Setup access or readiness changed. No sample was posted.'));
      return true;
    }
    try {
      const notice = await testHere(interaction);
      await interaction.editReply(buildSetupPanel(setupContext(interaction), config, servers, notice));
    } catch (err) {
      await interaction.editReply(buildSetupPanel(setupContext(interaction), config, servers, 'The sample test could not finish. Check /diagnose before trying again.'));
      throw err;
    }
    return true;
  }
  let change: () => Promise<void>;
  let notice = 'Saved.';
  if (id === SETUP_ACTIONS.mode && interaction.isStringSelectMenu() && interaction.values.length === 1 &&
      (interaction.values[0] === 'replace' || interaction.values[0] === 'reply')) {
    const mode = interaction.values[0];
    change = () => servers.update(interaction.guildId!, { mode });
  } else if (id === SETUP_ACTIONS.platforms && interaction.isStringSelectMenu() &&
      new Set(interaction.values).size === interaction.values.length &&
      interaction.values.every(value => (REWRITE_PLATFORMS as readonly string[]).includes(value))) {
    const eromeAvailable = isEromeAvailable(config, interaction.guildId);
    if (interaction.values.includes('erome') && !eromeAvailable) {
      await interaction.reply({ content: EROME_UNAVAILABLE, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return true;
    }
    const platforms = Object.fromEntries(REWRITE_PLATFORMS.filter(platform => platform !== 'erome' || eromeAvailable)
      .map(platform => [platform, interaction.values.includes(platform)]));
    change = () => servers.update(interaction.guildId!, { platforms });
  } else if (id === SETUP_ACTIONS.channels && interaction.isChannelSelectMenu() &&
      interaction.values.every(value => {
        const channel = interaction.channels.get(value);
        return channel && CHANNEL_TYPES.includes(channel.type) &&
          (!('guildId' in channel) || channel.guildId === interaction.guildId);
      })) {
    const channelIds = [...interaction.values];
    change = () => servers.update(interaction.guildId!, { channelIds });
  } else if (interaction.isButton() && id === SETUP_ACTIONS.enable) {
    change = () => servers.set(interaction.guildId!, true);
    notice = 'Server enabled. Channel selection kept.';
  } else if (interaction.isButton() && id === SETUP_ACTIONS.disable) {
    change = () => servers.set(interaction.guildId!, false);
    notice = 'Server disabled. Your choices are saved.';
  } else if (interaction.isButton() && id === SETUP_ACTIONS.allChannels) {
    change = () => servers.resetChannelScope(interaction.guildId!);
    notice = 'All allowed channels selected.';
  } else {
    await interaction.reply({ content: 'This setup selection is invalid. Run /setup to open a new panel.',
      flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return true;
  }
  await interaction.deferUpdate();
  try { await change(); }
  catch (err) {
    await interaction.editReply(buildSetupPanel(context, config, servers,
      'Could not save this change. Linky’s previous configuration is unchanged. Try again or contact the bot operator.'));
    throw err;
  }
  await interaction.editReply(buildSetupPanel(context, config, servers, notice));
  return true;
}
