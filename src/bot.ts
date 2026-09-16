import { Client, Events, GatewayIntentBits, Partials, PermissionFlagsBits, type Message } from 'discord.js';
import { dirname, join } from 'node:path';
import type { Config } from './config';
import type { logger } from './logger';
import { execute as help } from './commands/help';
import { execute as setup } from './commands/setup';
import { execute as preferences } from './commands/settings';
import { execute as diagnose } from './commands/diagnose';
import { execute as fix, removeManual } from './commands/fix';
import { execute as prompt, handleStatus as promptStatus } from './commands/prompt';
import { handleSetupComponent } from './commands/setupPanel';
import { commandDefinitions } from './commands/register';
import { ServerSettings } from './services/ServerSettings';
import { createLinkRepostHandler } from './services/SocialLinkService';
import { fetchTweetTranslation } from './services/TweetTranslation';
import { createCaptionTranslator } from './services/CaptionTranslation';
import { createInstagramLookup } from './services/InstagramTranslation';
import { TranslationBudget } from './services/TranslationBudget';
import { createYouTubeLookup } from './services/YouTube';
import { YouTubeStats } from './services/YouTubeStats';
import { RepostRegistry } from './services/RepostRegistry';
import { PreviewHealth } from './services/PreviewRecovery';
import { replyToYouTubeControl } from './services/YouTubeInteractions';
import { evaluateScope } from './services/ServerScope';
import { PromptService } from './services/PromptService';
import { createEromePreparer } from './services/Erome';
import { createEromeMediaRuntime } from './services/EromeMediaRuntime';
import { createEromeWorkScheduler } from './services/EromeWorkScheduler';
import { DeliveryDiagnostics } from './services/DeliveryDiagnostics';
import { handleDeliveryDetails } from './services/DeliveryDetails';
import { PreviewWatcher } from './services/PreviewWatcher';
import { ProviderHealth } from './services/ProviderHealth';
import { EromeAlbumSessions } from './services/EromeAlbumSessions';
import { createEromeAlbumPolicy } from './services/EromeAlbumPolicy';
import type { EromeMediaPreparer } from './services/EromeMedia';
import { bindDeliveryDetails } from './services/DeliveryAttempt';

export function createBot(settings: Config, log: Pick<typeof logger, 'info' | 'warn' | 'error'>,
  servers = new ServerSettings(settings.settingsPath),
  startMedia = createEromeMediaRuntime): Client {
  const client = new Client({
    partials: [Partials.Message],
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
    ],
  });
  let youtubeStats: YouTubeStats | undefined;
  let registry: RepostRegistry | undefined;
  let prompts: PromptService | undefined;
  const shutdown = new AbortController();
  let closing: Promise<void> | undefined;
  if (settings.prompt) {
    try { prompts = new PromptService(settings.prompt, join(dirname(settings.settingsPath), 'prompt-jobs.json')); }
    catch { log.warn('Coding requests are unavailable because their job history could not be loaded'); }
  }
  const lookupYouTube = settings.youtubeApiKey ? createYouTubeLookup(settings.youtubeApiKey) : undefined;
  let translateInstagram: ReturnType<typeof createInstagramLookup> | undefined;
  if (settings.translateInstagram && settings.captionApiKey) {
    try {
      const budget = new TranslationBudget(join(dirname(settings.settingsPath), 'translation-usage.json'));
      translateInstagram = createInstagramLookup(createCaptionTranslator(settings.captionApiKey, {
        reserve: characters => budget.reserve(characters),
      }));
    } catch {
      log.warn('Instagram translation is unavailable because its usage budget could not be loaded');
    }
  }
  const health = new PreviewHealth();
  const providerHealth = new ProviderHealth();
  const previews = new PreviewWatcher(client);
  const diagnostics = new DeliveryDiagnostics({ path: join(dirname(settings.settingsPath), 'delivery-diagnostics.json') });
  const scheduler = createEromeWorkScheduler({ observe: event => {
    if (event.kind === 'finished' || event.kind === 'rejected' || event.kind === 'quarantined')
      log.info({ ...event, rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024) }, 'Media preparation resources');
  } });
  const prepareErome = createEromePreparer({ scheduler });
  const mediaReady = settings.eromeMedia ? startMedia(settings.eromeMedia, { scheduler }).catch(() => {
    log.warn('Original video hosting is unavailable; using the attachment fallback');
    return undefined;
  }) : Promise.resolve(undefined);
  let albums: EromeAlbumSessions | undefined;
  const releaseEromeMedia = async (messageId: string) => {
    albums?.remove(messageId);
    const media = await mediaReady;
    if (settings.eromeMedia && !media) throw Error('Video storage unavailable');
    await media?.release(messageId);
  };
  const mediaOptions = settings.eromeMedia ? {
    prepareEromeMedia: async (source: string, options?: Parameters<EromeMediaPreparer>[1]) => (await mediaReady)?.prepare(source, options) ?? null,
    bindEromeMedia: async (id: string, messageId: string, reservation?: string) => (await mediaReady)?.bind(id, messageId, reservation) ?? false,
    cancelMediaReservation: async (reservation: string) => { await (await mediaReady)?.cancelReservation?.(reservation); },
    releaseEromeMedia,
  } : {};
  const retrying = new Set<string>();
  const retries = new Map<string, number>();
  const fetchMessage = async (channelId: string, messageId: string) => {
    const channel = await client.channels.fetch(channelId);
    return channel && 'messages' in channel ? channel.messages.fetch({ message: messageId, force: true }) : null;
  };
  if (settings.eromeMedia) albums = new EromeAlbumSessions({
    prepare: mediaOptions.prepareEromeMedia!, bind: mediaOptions.bindEromeMedia!,
    cancelReservation: mediaOptions.cancelMediaReservation!,
    unbind: async (id, messageId) => { await (await mediaReady)?.unbind?.(id, messageId); },
    context: (owner, actorId) => ({ trace: diagnostics.begin({ requesterId: actorId, channelId: owner.channelId,
      guildId: owner.guildId, mode: owner.mode, platform: 'erome' }) }),
    details: async (id, messageId) => (await bindDeliveryDetails(diagnostics, id, messageId)).map(row => row.toJSON()),
    allowed: createEromeAlbumPolicy({ settings, servers, fetchMessage, signal: shutdown.signal }),
  });
  const deliveryOptions = { diagnostics, armPreview: previews.arm.bind(previews), providerHealth, albums, signal: shutdown.signal };
  const destroy = client.destroy.bind(client);
  client.destroy = () => {
    if (closing) return closing;
    shutdown.abort();
    registry?.stop(); youtubeStats?.stop();
    albums?.close(); previews.close();
    closing = (async () => {
      try {
        const results = await Promise.allSettled([scheduler.close(), mediaReady.then(media => media?.close()), diagnostics.close()]);
        if (results.some(result => result.status === 'rejected')) log.warn('Some shutdown cleanup could not be confirmed');
      } finally { await destroy(); }
    })();
    return closing;
  };

  const repost = createLinkRepostHandler(settings.channelIds, log, undefined, {
    serverEnabled: id => servers.get(id),
    serverPreferences: id => servers.getPreferences(id),
    serverIds: settings.serverIds,
    platforms: settings.rewritePlatforms,
    translateTweet: settings.translateTweets ? fetchTweetTranslation : undefined,
    translateInstagram,
    lookupYouTube,
    prepareErome,
    ...mediaOptions,
    ...deliveryOptions,
    observePreview: (expected, result) => health.record(expected, result),
    rememberRepost: record => registry?.remember(record) ?? Promise.resolve(false),
    findRepost: id => registry?.findByReplacement(id),
    publishYouTube: (message, embeds) => youtubeStats?.publish(message, embeds) ?? Promise.resolve(null),
  });
  client.on(Events.MessageCreate, message => { if (!shutdown.signal.aborted) void repost(message); });
  client.on(Events.MessageDelete, message => {
    void releaseEromeMedia(message.id).catch(() => log.warn('Video storage cleanup failed'));
    void registry?.handleSourceDelete(message).catch(() => log.warn('Source deletion cleanup will be retried'));
    void registry?.handleReplacementDelete(message).catch(() => log.warn('Preview deletion cleanup will be retried'));
  });
  client.on(Events.MessageBulkDelete, messages => {
    for (const message of messages.values()) {
      void releaseEromeMedia(message.id).catch(() => log.warn('Video storage cleanup failed'));
      void registry?.handleSourceDelete(message).catch(() => log.warn('Bulk source deletion cleanup will be retried'));
      void registry?.handleReplacementDelete(message).catch(() => log.warn('Bulk preview deletion cleanup will be retried'));
    }
  });
  client.on(Events.MessageUpdate, (before, after) => {
    if (shutdown.signal.aborted) return;
    void registry?.handleSourceUpdate(before, after, source => repost(source as Message, { refresh: true, forceReply: true }))
      .catch(() => log.warn('Source edit synchronization will be retried'));
  });
  log.info({
    channelIds: settings.channelIds,
    serverIds: settings.serverIds,
    platforms: settings.rewritePlatforms,
    translateTweets: settings.translateTweets,
    translateInstagram: Boolean(translateInstagram),
  }, 'Social link replacement ready for configured and opted-in servers');

  client.on(Events.InteractionCreate, async (interaction) => {
    if (shutdown.signal.aborted) return;
    try {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'help') await help(interaction, settings, servers);
        else if (interaction.commandName === 'setup') await setup(interaction, servers, settings);
        else if (interaction.commandName === 'settings') await preferences(interaction, settings, servers);
        else if (interaction.commandName === 'diagnose') await diagnose(interaction, settings, servers, async link => health.describe(link));
        else if (interaction.commandName === 'fix') await fix(interaction, settings, { prepareErome, ...mediaOptions, ...deliveryOptions,
          serverPreferences: id => servers.getPreferences(id), observePreview: (expected, result) => health.record(expected, result) });
        else if (interaction.commandName === 'prompt') await prompt(interaction, prompts);
      } else if (interaction.isMessageContextMenuCommand()) {
        if (interaction.commandName === 'Fix with Linky') await fix(interaction, settings, { prepareErome, ...mediaOptions, ...deliveryOptions,
          serverPreferences: id => servers.getPreferences(id), observePreview: (expected, result) => health.record(expected, result) });
      } else if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isChannelSelectMenu()) {
        if (interaction.isButton() && await handleDeliveryDetails(interaction, diagnostics)) return;
        if (interaction.isButton() && await albums?.handle(interaction)) return;
        if (interaction.isButton() && await promptStatus(interaction, prompts)) return;
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
        if (await removeManual(interaction, releaseEromeMedia) || await registry?.handleRemove(interaction)) return;
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
      await mediaReady;
      await diagnostics.ready;
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
        afterReplacementRemoved: record => releaseEromeMedia(record.replacementId),
        regenerate: source => repost(source as Message, { refresh: true, forceReply: true }),
        canRetry: async (record, userId) => {
          const guild = await client.guilds.fetch(record.guildId);
          if (guild.id !== record.guildId) return false;
          const member = await guild.members.fetch({ user: userId, force: true });
          const channel = await guild.channels.fetch(record.channelId, { force: true });
          if (member.id !== userId || !channel || channel.id !== record.channelId || channel.guildId !== record.guildId ||
            (member.communicationDisabledUntilTimestamp ?? 0) > Date.now()) return false;
          const send = channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
          return Boolean(channel.permissionsFor(member)?.has([PermissionFlagsBits.ViewChannel, send]));
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
