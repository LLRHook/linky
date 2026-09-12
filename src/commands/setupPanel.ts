import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType,
  MessageFlags, PermissionFlagsBits, StringSelectMenuBuilder,
  type ButtonInteraction, type ChannelSelectMenuInteraction, type StringSelectMenuInteraction,
} from 'discord.js';
import type { Config } from '../config';
import type { ServerSettings } from '../services/ServerSettings';
import { REWRITE_PLATFORMS } from '../services/SocialLinkService';
import { describeScope, evaluateScope } from '../services/ServerScope';
import { effectivePreferences, PLATFORM_NAMES } from './settings';

const PREFIX = 'linky:setup:';
export const SETUP_ACTIONS = {
  mode: PREFIX + 'mode', platforms: PREFIX + 'platforms', channels: PREFIX + 'channels',
  enable: PREFIX + 'enable', disable: PREFIX + 'disable', allChannels: PREFIX + 'all-channels',
} as const;
const CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum,
  ChannelType.GuildMedia, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread];
type SetupComponent = ButtonInteraction | ChannelSelectMenuInteraction | StringSelectMenuInteraction;
interface PanelContext { guildId: string; channelId: string; threadParentId?: string | null }

export function isSetupComponent(interaction: { customId: string }): boolean {
  return Object.values(SETUP_ACTIONS).includes(interaction.customId);
}

export function buildSetupPanel(context: PanelContext, config: Config, servers: ServerSettings, notice?: string) {
  const preferences = servers.getPreferences(context.guildId);
  const effective = effectivePreferences(config, preferences);
  const enabled = servers.get(context.guildId);
  const scope = evaluateScope({ ...context, serverEnabled: enabled, preferences,
    operatorChannelIds: config.channelIds, operatorServerIds: config.serverIds });
  const channels = preferences.channelIds;
  const mode = new StringSelectMenuBuilder().setCustomId(SETUP_ACTIONS.mode).setPlaceholder('Choose Replace or Reply')
    .addOptions({ label: 'Replace', value: 'replace', description: 'Replace the source after the replacement is checked.', default: effective.mode === 'replace' },
      { label: 'Reply', value: 'reply', description: 'Keep the original and add a reply.', default: effective.mode === 'reply' });
  const platforms = new StringSelectMenuBuilder().setCustomId(SETUP_ACTIONS.platforms)
    .setPlaceholder('Choose platforms; clear to turn all off').setMinValues(0).setMaxValues(REWRITE_PLATFORMS.length)
    .addOptions(REWRITE_PLATFORMS.map(platform => ({ label: PLATFORM_NAMES[platform], value: platform,
      description: config.rewritePlatforms.includes(platform) ? `Process ${PLATFORM_NAMES[platform]} links.` : 'Currently unavailable from the bot operator.',
      default: effective.platforms.includes(platform) })));
  const channelSelect = new ChannelSelectMenuBuilder().setCustomId(SETUP_ACTIONS.channels)
    .setPlaceholder('Choose up to 25 channels; clear for none').setMinValues(0).setMaxValues(25)
    .addChannelTypes(CHANNEL_TYPES);
  if (channels?.length) channelSelect.setDefaultChannels(channels);
  return {
    content: [
      notice, '**Linky setup**',
      enabled === true ? 'Server enabled.' : enabled === false ? 'Server disabled.' : 'No saved enablement; existing operator scope applies.',
      describeScope(scope),
      channels === undefined ? 'Channel preference: all channels allowed by the current enablement.' :
        channels.length ? `Selected channels: ${channels.map(id => `<#${id}>`).join(', ')}.` : 'Channel preference: none.',
      'Selecting a parent channel includes its accessible threads. Existing operator-only channel scope remains exact until you explicitly enable the server.',
      `Mode: ${effective.mode === 'reply' ? 'Reply' : 'Replace'}. Platforms: ${effective.platforms.map(platform => PLATFORM_NAMES[platform]).join(', ') || 'none'}.`,
      'Menu changes save immediately without enabling Linky. Enable server keeps your channel selection; Disable server stops all processing.',
      'Use /settings for translation and YouTube details, or /diagnose to check this channel. Preview availability depends on Discord and the provider.',
    ].filter(Boolean).join('\n'),
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(mode),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(platforms),
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(channelSelect),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(SETUP_ACTIONS.enable).setLabel('Enable server').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(SETUP_ACTIONS.disable).setLabel('Disable server').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(SETUP_ACTIONS.allChannels).setLabel('All channels').setStyle(ButtonStyle.Secondary),
      ),
    ],
    allowedMentions: { parse: [] as [] },
  };
}

/** Stateless panels survive restart; each click checks the current member permissions again. */
export async function handleSetupComponent(interaction: SetupComponent, config: Config, servers: ServerSettings): Promise<boolean> {
  if (!isSetupComponent(interaction)) return false;
  if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: 'Use Linky setup in a server where you have Manage Server permission.',
      flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return true;
  }
  const id = interaction.customId;
  const context = { guildId: interaction.guildId, channelId: interaction.channelId,
    threadParentId: interaction.channel?.isThread() ? interaction.channel.parentId : undefined };
  let change: () => Promise<void>;
  let notice = 'Preferences saved. Server enablement is unchanged.';
  if (id === SETUP_ACTIONS.mode && interaction.isStringSelectMenu() && interaction.values.length === 1 &&
      (interaction.values[0] === 'replace' || interaction.values[0] === 'reply')) {
    const mode = interaction.values[0];
    change = () => servers.update(interaction.guildId!, { mode });
  } else if (id === SETUP_ACTIONS.platforms && interaction.isStringSelectMenu() &&
      new Set(interaction.values).size === interaction.values.length &&
      interaction.values.every(value => (REWRITE_PLATFORMS as readonly string[]).includes(value))) {
    const platforms = Object.fromEntries(REWRITE_PLATFORMS.map(platform => [platform, interaction.values.includes(platform)]));
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
    notice = 'Server enabled. Your selected channel restriction still applies.';
  } else if (interaction.isButton() && id === SETUP_ACTIONS.disable) {
    change = () => servers.set(interaction.guildId!, false);
    notice = 'Server disabled. Your preferences are saved for later.';
  } else if (interaction.isButton() && id === SETUP_ACTIONS.allChannels) {
    change = () => servers.resetChannelScope(interaction.guildId!);
    notice = 'Channel restriction cleared. Saved enablement and operator scope are unchanged.';
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
