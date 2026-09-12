import {
  ApplicationIntegrationType, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { Config } from '../config';
import type { ServerSettings } from '../services/ServerSettings';
import { describeScope, evaluateScope } from '../services/ServerScope';
import type { RewritePlatform } from '../services/SocialLinkService';
import { parseSocialUrl } from '../services/SocialProviders';
import { parseYouTubeUrl } from '../services/YouTube';
import { effectivePreferences, PLATFORM_NAMES } from './settings';

/** Returns known observations; diagnostics do not require an external network probe. */
export type ProviderDiagnostic = (link: string) => Promise<string>;

export const data = new SlashCommandBuilder()
  .setName('diagnose').setDescription('Privately check Linky’s scope, permissions and a supported link.')
  .setContexts(InteractionContextType.Guild).setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption(option => option.setName('link').setDescription('Optional HTTPS link to check without posting it.')
    .setMinLength(1).setMaxLength(2000));

function platformFor(link: string): RewritePlatform | undefined {
  try { if (new URL(link).protocol !== 'https:' || /\s/.test(link)) return undefined; }
  catch { return undefined; }
  if (parseYouTubeUrl(link)) return 'youtube';
  return parseSocialUrl(link)?.platform;
}

function plainObservation(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 450)
    .replace(/[\\`*_{}\[\]()<>~|#+\-]/g, '\\$&').replace(/@/g, '@\u200b');
}

export async function execute(interaction: ChatInputCommandInteraction, config: Config, servers: ServerSettings,
  providerDiagnostic?: ProviderDiagnostic): Promise<void> {
  if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: 'Use /diagnose in a server where you have Manage Server permission.',
      flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const preferences = servers.getPreferences(interaction.guildId);
  const effective = effectivePreferences(config, preferences);
  const channel = interaction.channel;
  const scope = evaluateScope({ guildId: interaction.guildId, channelId: interaction.channelId,
    threadParentId: channel?.isThread() ? channel.parentId : undefined,
    serverEnabled: servers.get(interaction.guildId), preferences,
    operatorChannelIds: config.channelIds, operatorServerIds: config.serverIds });
  const required = [
    ['View Channel', PermissionFlagsBits.ViewChannel],
    ['Read Message History', PermissionFlagsBits.ReadMessageHistory],
    ['Embed Links', PermissionFlagsBits.EmbedLinks],
    channel?.isThread() ? ['Send Messages in Threads', PermissionFlagsBits.SendMessagesInThreads] :
      ['Send Messages', PermissionFlagsBits.SendMessages],
    ...(effective.mode === 'replace' ? [['Manage Messages', PermissionFlagsBits.ManageMessages]] : []),
  ] as [string, bigint][];
  const member = interaction.guild?.members.me;
  const permissions = member && channel && 'permissionsFor' in channel ? channel.permissionsFor(member) : null;
  const missing = permissions ? required.filter(([, bit]) => !permissions.has(bit)).map(([name]) => name) : undefined;
  const lines = [
    '**Linky diagnostics**', describeScope(scope),
    `Mode: ${effective.mode === 'reply' ? 'Reply (keeps originals)' : 'Replace'}.`,
    `Platforms: ${effective.platforms.map(platform => PLATFORM_NAMES[platform]).join(', ') || 'none'}.`,
    channel?.isSendable() ? undefined : 'This channel cannot receive Linky messages. For a forum or media post, check inside its thread.',
    missing === undefined ? 'Channel permissions could not be checked. Check Linky’s role and channel overrides.' :
      missing.length ? `Missing channel permissions: ${missing.join(', ')}.` : 'Required permissions for a plain link are present.',
    permissions && !permissions.has(PermissionFlagsBits.AttachFiles)
      ? effective.mode === 'replace' ? 'Attach Files is also needed when copying attachments or sending a long translation file.'
        : 'Attach Files is needed only if a long translation requires a file. Original attachments stay on the source.' : undefined,
  ];
  const link = interaction.options.getString('link')?.trim();
  if (link) {
    const platform = platformFor(link);
    if (!platform) lines.push('Link format: unsupported. Use an HTTPS post link for a listed platform.');
    else {
      lines.push(`Link format: recognized ${PLATFORM_NAMES[platform]} URL.`);
      if (!effective.platforms.includes(platform)) lines.push(config.rewritePlatforms.includes(platform)
        ? 'This platform is disabled in this server’s preferences.' : 'This platform is unavailable from the bot operator.');
      else if (platform === 'youtube' && effective.youtubeDisplay === 'preview') {
        lines.push('YouTube display is preview only: Linky leaves the native video link without fetching counts or comments.');
      } else if (providerDiagnostic) {
        try { lines.push(`Provider observation: ${plainObservation(await providerDiagnostic(link))}`); }
        catch { lines.push('Provider status is unavailable. This check did not test a live preview.'); }
      } else lines.push('Provider status: no recent observation is available. This check did not test a live preview.');
    }
  } else lines.push('Add the optional link argument to check whether a URL format is supported.');
  lines.push('No message was posted or removed. Preview availability still depends on Discord and the provider.');
  await interaction.editReply({ content: lines.filter(Boolean).join('\n'), allowedMentions: { parse: [] } });
}
