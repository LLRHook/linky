import { Client, Events, GatewayIntentBits, Partials, PermissionFlagsBits, type Message } from 'discord.js';
import { dirname, join } from 'node:path';
import type { Config } from './config';
import type { logger } from './logger';
import { execute as help } from './commands/help';
import { execute as setup } from './commands/setup';
import { execute as preferences } from './commands/settings';
import { execute as diagnose } from './commands/diagnose';
import { execute as fix, removeManual } from './commands/fix';
import { handleSetupComponent } from './commands/setupPanel';
import { commandDefinitions } from './commands/register';
import { ServerSettings } from './services/ServerSettings';
import { createLinkRepostHandler } from './services/SocialLinkService';
import { fetchTweetTranslation } from './services/TweetTranslation';
import { createYouTubeLookup } from './services/YouTube';
import { YouTubeStats } from './services/YouTubeStats';
import { RepostRegistry } from './services/RepostRegistry';
import { PreviewHealth } from './services/PreviewRecovery';
import { replyToYouTubeControl } from './services/YouTubeInteractions';
import { evaluateScope } from './services/ServerScope';

export function createBot(settings: Config, log: Pick<typeof logger, 'info' | 'warn' | 'error'>,
  servers = new ServerSettings(settings.settingsPath)): Client {
  const client = new Client({
    partials: [Partials.Message],
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
    ],
  });
  let youtubeStats: YouTubeStats | undefined;
  let registry: RepostRegistry | undefined;
  const lookupYouTube = settings.youtubeApiKey ? createYouTubeLookup(settings.youtubeApiKey) : undefined;
  const health = new PreviewHealth();
  const retrying = new Set<string>();
  const retries = new Map<string, number>();
  const fetchMessage = async (channelId: string, messageId: string) => {
    const channel = await client.channels.fetch(channelId);
    return channel && 'messages' in channel ? channel.messages.fetch({ message: messageId, force: true }) : null;
  };
  const destroy = client.destroy.bind(client);
  client.destroy = async () => { registry?.stop(); youtubeStats?.stop(); await destroy(); };

  const repost = createLinkRepostHandler(settings.channelIds, log, undefined, {
    serverEnabled: id => servers.get(id),
    serverPreferences: id => servers.getPreferences(id),
    serverIds: settings.serverIds,
    platforms: settings.rewritePlatforms,
    translateTweet: settings.translateTweets ? fetchTweetTranslation : undefined,
    lookupYouTube,
    observePreview: (expected, result) => health.record(expected, result),
    rememberRepost: record => registry?.remember(record) ?? Promise.resolve(false),
    findRepost: id => registry?.findByReplacement(id),
    publishYouTube: (message, embeds) => youtubeStats?.publish(message, embeds) ?? Promise.resolve(null),
  });
  client.on(Events.MessageCreate, message => { void repost(message); });
  client.on(Events.MessageDelete, message => {
    void registry?.handleSourceDelete(message).catch(() => log.warn('Source deletion cleanup will be retried'));
    void registry?.handleReplacementDelete(message).catch(() => log.warn('Preview deletion cleanup will be retried'));
  });
  client.on(Events.MessageBulkDelete, messages => {
    for (const message of messages.values()) {
      void registry?.handleSourceDelete(message).catch(() => log.warn('Bulk source deletion cleanup will be retried'));
      void registry?.handleReplacementDelete(message).catch(() => log.warn('Bulk preview deletion cleanup will be retried'));
    }
  });
  client.on(Events.MessageUpdate, (before, after) => {
    void registry?.handleSourceUpdate(before, after, source => repost(source as Message, { refresh: true, forceReply: true }))
      .catch(() => log.warn('Source edit synchronization will be retried'));
  });
  log.info({
    channelIds: settings.channelIds,
    serverIds: settings.serverIds,
    platforms: settings.rewritePlatforms,
    translateTweets: settings.translateTweets,
  }, 'Social link replacement ready for configured and opted-in servers');

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'help') await help(interaction, settings, servers);
        else if (interaction.commandName === 'setup') await setup(interaction, servers, settings);
        else if (interaction.commandName === 'settings') await preferences(interaction, settings, servers);
        else if (interaction.commandName === 'diagnose') await diagnose(interaction, settings, servers, async link => health.describe(link));
        else if (interaction.commandName === 'fix') await fix(interaction, settings, { observePreview: (expected, result) => health.record(expected, result) });
      } else if (interaction.isMessageContextMenuCommand()) {
        if (interaction.commandName === 'Fix with Linky') await fix(interaction, settings, { observePreview: (expected, result) => health.record(expected, result) });
      } else if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isChannelSelectMenu()) {
        if (interaction.isButton() && await replyToYouTubeControl(interaction, {
          stats: youtubeStats, lookup: lookupYouTube,
          enabled: (guildId, channelId, action) => {
            const preferences = servers.getPreferences(guildId);
            const display = preferences.youtubeDisplay ?? 'counts-and-comment';
            return settings.rewritePlatforms.includes('youtube') && preferences.platforms?.youtube !== false &&
              display !== 'preview' && (action !== 'comment' || display === 'counts-and-comment') &&
              evaluateScope({ guildId, channelId,
                threadParentId: interaction.channel?.isThread() ? interaction.channel.parentId : undefined,
                serverEnabled: servers.get(guildId), preferences,
                operatorChannelIds: settings.channelIds, operatorServerIds: settings.serverIds }).enabled;
          },
        })) return;
        if (await handleSetupComponent(interaction, settings, servers)) return;
        if (!interaction.isButton()) return;
        if (await removeManual(interaction) || await registry?.handleRemove(interaction)) return;
        if (interaction.customId !== 'linky:retry' || !registry) return;
        const record = await registry.authorize(interaction);
        if (!record) return;
        if (retrying.has(record.sourceId) || Date.now() - (retries.get(record.sourceId) ?? 0) < 30_000) {
          await interaction.editReply({ content: 'A retry is already running or just finished. Wait 30 seconds before trying again.' });
          return;
        }
        retrying.add(record.sourceId);
        retries.set(record.sourceId, Date.now());
        if (retries.size > 1000) retries.delete(retries.keys().next().value!);
        try {
          const complete = await registry.retry(record, source => repost(source as Message, { refresh: true, forceReply: true }));
          await interaction.editReply({ content: complete
            ? 'Retry finished. If a preview was unavailable, the original message was kept.'
            : 'The retry could not finish. The original was kept; any saved cleanup will be retried.' });
        } finally { retrying.delete(record.sourceId); }
      }
    } catch (err) {
      const failure = err as { code?: unknown; status?: unknown } | null;
      log.error({
        ...(typeof failure?.code === 'number' ? { errorCode: failure.code } : {}),
        ...(typeof failure?.status === 'number' ? { status: failure.status } : {}),
      }, 'Could not complete Linky interaction');
    }
  });

  // Readiness logs are also checked by the deployment script. Joining a guild sends nothing.
  client.once(Events.ClientReady, async (readyClient) => {
    try {
      await readyClient.application.commands.set(commandDefinitions);
      // Cleanup continues even if the API key or YouTube support is later disabled.
      youtubeStats = new YouTubeStats({
        path: join(dirname(settings.settingsPath), 'youtube-stats.json'),
        botUserId: readyClient.user.id,
        fetchMessage,
        onError: () => log.warn('YouTube statistics cleanup failed; retained records will be retried'),
      });
      youtubeStats.start();
      registry = new RepostRegistry({
        path: join(dirname(settings.settingsPath), 'reposts.json'), botUserId: readyClient.user.id, fetchMessage,
        removeRelated: record => youtubeStats!.removeForMessage(record.replacementId),
        regenerate: source => repost(source as Message, { refresh: true, forceReply: true }),
        canManageMessages: async (record, userId) => {
          const guild = await client.guilds.fetch(record.guildId);
          const member = await guild.members.fetch({ user: userId, force: true });
          const channel = await guild.channels.fetch(record.channelId, { force: true });
          return Boolean(channel?.permissionsFor(member)?.has(PermissionFlagsBits.ManageMessages));
        },
        onError: () => log.warn('Repost ownership cleanup will be retried'),
      });
      registry.start();
      log.info(`Logged in as ${readyClient.user.tag}`);
      log.info(`Serving ${readyClient.guilds.cache.size} guild(s).`);
    } catch (err) {
      log.error({ err }, 'Command registration failed; disconnecting');
      await client.destroy();
    }
  });
  client.on(Events.Error, (err) => log.error({ err }, 'Discord client error'));
  return client;
}
