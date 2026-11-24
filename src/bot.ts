import { createBlueskyReplies } from './services/BlueskyReplies';
import type { PartialMessage } from 'discord.js';
import { ReplyThreads, repliesChannel, type ReplyPage } from './services/ReplyThreads';
import { ReplyCleanupJournal } from './services/ReplyCleanupJournal';
import { createXReplies } from './services/XReplies';
import { Client, Events, GatewayIntentBits, MessageFlags, Partials, PermissionFlagsBits, type Interaction, type Message } from 'discord.js';
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
import { PersonalPreferences } from './services/PersonalPreferences';
import { execute as autofix } from './commands/autofix';
import { createMobileShareLinkNormalizer } from './services/MobileShareLinks';
import { createLinkRepostHandler } from './services/SocialLinkService';
import { createTweetLookup } from './services/TweetTranslation';
import { createInstagramLookup } from './services/InstagramPost';
import { createBlueskyLookup } from './services/BlueskyPost';
import { createYouTubeLookup } from './services/YouTube';
import { createYouTubeCommunityLookup } from './services/YouTubeCommunity';
import { createArticleLookup } from './services/ArticlePreview';
import { YouTubeStats } from './services/YouTubeStats';
import { RepostRegistry } from './services/RepostRegistry';
import { logCleanupFailure } from './services/CleanupFailure';
import { PreviewHealth } from './services/PreviewRecovery';
import { replyToYouTubeControl } from './services/YouTubeInteractions';
import { evaluateScope } from './services/ServerScope';
import { PromptService } from './services/PromptService';
import { createEromePreparer } from './services/Erome';
import { createEromeMediaRuntime } from './services/EromeMediaRuntime';
import { createEromeWorkScheduler } from './services/EromeWorkScheduler';
import { DeliveryDiagnostics } from './services/DeliveryDiagnostics';
import { DeliveryArchive } from './services/DeliveryArchive';
import { handleDeliveryDetails } from './services/DeliveryDetails';
import { PreviewWatcher } from './services/PreviewWatcher';
import { createSetupPreviewTest } from './services/SetupPreviewTest';
import { ProviderHealth } from './services/ProviderHealth';
import { EromeAlbumSessions } from './services/EromeAlbumSessions';
import { createEromeAlbumPolicy } from './services/EromeAlbumPolicy';
import { EROME_UNAVAILABLE, isEromeAvailable } from './services/EromeAvailability';
import { findEromeLinks } from './services/EromeDelivery';
import type { EromeMediaPreparer } from './services/EromeMedia';
import { bindDeliveryDetails } from './services/DeliveryAttempt';
import { InFlightWork } from './services/InFlightWork';
import { catchUp, ServiceCheckpoint } from './services/ServiceCheckpoint';

/** Route only the selected platform's optional reply lookup. */
export function createReplyLookup(xReplies: (id: string) => Promise<ReplyPage | null>,
  blueskyReplies: (id: string) => Promise<ReplyPage | null>) {
  return (id: string, platform?: 'x' | 'bsky') => platform === 'bsky' ? blueskyReplies(id) : xReplies(id);
}

/** Running deliveries get this long to finish when the bot stops; Compose `stop_grace_period` must exceed it. */
export const SHUTDOWN_DRAIN_MS = 20_000;
export const RESTARTING_REPLY = 'Linky is restarting. Try again in a few seconds.';

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
  const personal = new PersonalPreferences(join(dirname(settings.settingsPath), 'personal-preferences.json'));
  const normalizeMobileLinks = createMobileShareLinkNormalizer();
  let registry: RepostRegistry | undefined;
  let prompts: PromptService | undefined;
  const shutdown = new AbortController();
  let closing: Promise<void> | undefined;
  // Shutdown stops accepting new work first, then lets running work finish before aborting `shutdown`.
  let accepting = true;
  const work = new InFlightWork(() => log.error('Link handling stopped unexpectedly'));
  const checkpoint = new ServiceCheckpoint({ path: join(dirname(settings.settingsPath), 'service-checkpoint.json'),
    trackChannels: Boolean(settings.catchUp), onError: () => log.warn('Restart checkpoint could not be saved') });
  // Messages the live session received while catch-up runs, so catch-up does not deliver them twice.
  let seenLive: Set<string> | undefined;
  if (settings.prompt) {
    try { prompts = new PromptService(settings.prompt, join(dirname(settings.settingsPath), 'prompt-jobs.json')); }
    catch { log.warn('Coding requests are unavailable because their job history could not be loaded'); }
  }
  const lookupYouTube = settings.youtubeApiKey ? createYouTubeLookup(settings.youtubeApiKey) : undefined;
  const lookupYouTubeCommunity = createYouTubeCommunityLookup();
  const lookupArticle = createArticleLookup(settings.truthSocialRelay ? { truthSocialRelay: settings.truthSocialRelay } : {});
  const lookupInstagram = createInstagramLookup();
  // Lone Bluesky image posts are read from the public AppView; only the post's actor and record key are sent.
  const lookupBluesky = createBlueskyLookup();
  // One status cache serves translation and one-post blocks, so a post is fetched once per mode.
  const tweets = createTweetLookup();
  const health = new PreviewHealth();
  const providerHealth = new ProviderHealth();
  const previews = new PreviewWatcher(client);
  const testSetupHere = createSetupPreviewTest(settings, servers, { armPreview: previews.arm.bind(previews), signal: shutdown.signal });
  const archive = new DeliveryArchive({ directory: join(dirname(settings.settingsPath), 'delivery-logs'),
    retentionDays: settings.deliveryLogRetentionDays,
    onWarning: code => log.warn({ code }, 'Delivery archive needs attention') });
  const diagnostics = new DeliveryDiagnostics({ path: join(dirname(settings.settingsPath), 'delivery-diagnostics.json'), archive });
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
  const xReplies = createXReplies(), blueskyReplies = createBlueskyReplies();
  const replyThreads = new ReplyThreads({
    botUserId: () => client.user?.id ?? '',
    enabled: guildId => servers.getPreferences(guildId).replies === true,
    tracked: message => !replyCleanup.has(message.id) && Boolean(registry?.isActive(message.id) ||
      message.interactionMetadata?.user.id && message.webhookId === client.application?.id && !message.flags.has(MessageFlags.Ephemeral)),
    lookup: createReplyLookup(xReplies, blueskyReplies),
    fetchThread: async id => {
      const channel = await client.channels.fetch(id, { force: true });
      return channel?.isThread() ? channel : null;
    },
  });
  const replyCleanup = new ReplyCleanupJournal(join(dirname(settings.settingsPath), 'reply-cleanup.json'),
    async target => {
      try {
        const parent = await fetchMessage(target.channelId, target.threadId);
        if (parent) {
          const record = registry?.findByReplacement(target.threadId);
          const registered = record && record.guildId === target.guildId && record.channelId === target.channelId;
          if (parent.id !== target.threadId || parent.guildId !== target.guildId || parent.channelId !== target.channelId ||
              parent.author.id !== client.user?.id || !registered && (parent.webhookId !== client.application?.id || !parent.interactionMetadata)) {
            throw new Error('Manual cleanup parent ownership mismatch');
          }
          await parent.delete();
        }
      } catch (error) {
        const code = (error as { code?: number }).code;
        if ([10003, 50001, 50013].includes(code ?? 0)) return;
        if (code !== 10008) throw error;
      }
      await replyThreads.cleanup(target);
    }, reason => log.warn(reason ?? 'Replies cleanup will be retried'));
  const deliveryOptions = { diagnostics, armPreview: previews.arm.bind(previews), providerHealth, albums,
    normalizeMobileLinks,
    translateTweet: settings.translateTweets ? async (id: string) => (await tweets(id, { translate: true })).translation : undefined,
    lookupTweet: async (id: string, options: { translate: boolean }) => (await tweets(id, options)).post,
    lookupInstagram, lookupBluesky, lookupYouTubeCommunity, lookupArticle, probeMedia: fetch, signal: shutdown.signal };
  const destroy = client.destroy.bind(client);
  client.destroy = () => {
    if (closing) return closing;
    accepting = false;
    const stoppedAt = Date.now();
    registry?.stop(); youtubeStats?.stop(); replyCleanup.stop();
    closing = (async () => {
      try {
        const saved = checkpoint.stop(stoppedAt);
        if (!await work.settle(settings.shutdownDrainMs ?? SHUTDOWN_DRAIN_MS))
          log.warn({ unfinished: work.size }, 'Shutdown cancelled deliveries that did not finish in time');
        shutdown.abort();
        albums?.close(); previews.close();
        const results = await Promise.allSettled([scheduler.close(), mediaReady.then(media => media?.close()), personal.flush(), saved]);
        const historySaved = await diagnostics.close();
        const archiveSaved = await archive.close();
        if (!historySaved || !archiveSaved) log.warn('Delivery history shutdown could not be confirmed');
        if (results.some(result => result.status === 'rejected')) log.warn('Some shutdown cleanup could not be confirmed');
      } finally { await destroy(); }
    })();
    return closing;
  };

  const repost = createLinkRepostHandler(settings.channelIds, log, undefined, {
    isOptedOut: (guildId, userId) => personal.isOptedOut(guildId, userId),
    serverEnabled: id => servers.get(id),
    serverPreferences: id => servers.getPreferences(id),
    serverIds: settings.serverIds,
    platforms: settings.rewritePlatforms,
    eromeAvailable: guildId => isEromeAvailable(settings, guildId),
    lookupYouTube,
    prepareErome,
    ...mediaOptions,
    ...deliveryOptions,
    observePreview: (expected, result) => health.record(expected, result),
    rememberRepost: record => registry?.remember(record) ?? Promise.resolve(false),
    findRepost: id => registry?.findByReplacement(id),
    removeRepost: record => registry?.queueRemoval(record) ?? Promise.resolve(false),
    publishYouTube: (message, embeds) => youtubeStats?.publish(message, embeds) ?? Promise.resolve(null),
  });
  client.on(Events.MessageCreate, message => {
    if (!accepting) return;
    if (message.inGuild() && !message.author.bot) {
      seenLive?.add(message.id);
      // Catch-up only revisits channels where Linky could act on a link.
      if (settings.catchUp && /https?:\/\//i.test(message.content) && evaluateScope({
        guildId: message.guildId, channelId: message.channelId,
        threadParentId: message.channel.isThread() ? message.channel.parentId : undefined,
        serverEnabled: servers.get(message.guildId), preferences: servers.getPreferences(message.guildId),
        operatorChannelIds: settings.channelIds, operatorServerIds: settings.serverIds,
      }).enabled) checkpoint.observe(message.channelId);
    }
    void work.track(repost(message));
  });
  client.on(Events.GuildDelete, guild => {
    void personal.removeGuild(guild.id).catch(() => log.warn('Could not remove departed server personal preferences'));
  });
  const cachedReplyThread = (message: Message | PartialMessage) =>
    message.channel && 'threads' in message.channel ? message.channel.threads?.cache.get(message.id) : undefined;
  const knownReplyThread = (message: Message | PartialMessage) => {
    const thread = cachedReplyThread(message);
    const botId = client.user?.id, applicationId = client.application?.id;
    const authoredByLinky = Boolean(botId && message.author?.id === botId) || Boolean(applicationId &&
      (message.webhookId === applicationId || message.applicationId === applicationId) && message.interactionMetadata);
    return Boolean(authoredByLinky && message.hasThread && (!thread || thread.ownerId === botId) || botId && thread?.ownerId === botId);
  };
  const cleanupDeletedManual = (message: Message | PartialMessage) => {
    if (!message.guildId || registry?.findByReplacement(message.id)) return;
    const cachedThread = cachedReplyThread(message);
    if (cachedThread && cachedThread.name === 'Replies removed' && cachedThread.archived) return;
    const manual = message.author?.id === client.user?.id && message.webhookId === client.application?.id && message.interactionMetadata;
    const speculative = servers.getPreferences(message.guildId).replies === true &&
      repliesChannel(message.channel?.type) && !message.flags?.has(MessageFlags.Ephemeral) && manual;
    // Settings gate speculation, while local evidence always permits cleanup of existing threads.
    if (!knownReplyThread(message) && !speculative) return;
    void replyCleanup.enqueue({ guildId: message.guildId, channelId: message.channelId, threadId: message.id })
      .catch(() => log.warn('Deleted preview replies cleanup could not be queued'));
  };
  client.on(Events.MessageDelete, message => {
    cleanupDeletedManual(message);
    void releaseEromeMedia(message.id).catch(() => log.warn('Video storage cleanup failed'));
    void registry?.handleSourceDelete(message).catch(() => log.warn('Source deletion cleanup will be retried'));
    void registry?.handleReplacementDelete(message).catch(() => log.warn('Preview deletion cleanup will be retried'));
  });
  client.on(Events.MessageBulkDelete, messages => {
    for (const message of messages.values()) {
      cleanupDeletedManual(message);
      void releaseEromeMedia(message.id).catch(() => log.warn('Video storage cleanup failed'));
      void registry?.handleSourceDelete(message).catch(() => log.warn('Bulk source deletion cleanup will be retried'));
      void registry?.handleReplacementDelete(message).catch(() => log.warn('Bulk preview deletion cleanup will be retried'));
    }
  });
  client.on(Events.MessageUpdate, (before, after) => {
    if (!accepting || !registry) return;
    void work.track(registry.handleSourceUpdate(before, after, source => repost(source as Message, { refresh: true, forceReply: true }))
      .catch(() => log.warn('Source edit synchronization will be retried')));
  });
  log.info({
    channelIds: settings.channelIds,
    serverIds: settings.serverIds,
    platforms: settings.rewritePlatforms,
    translateTweets: settings.translateTweets,
    truthSocialRelay: Boolean(settings.truthSocialRelay),
  }, 'Social link replacement ready for configured and opted-in servers');

  client.on(Events.InteractionCreate, interaction => accepting ? work.track(interact(interaction)) : restarting(interaction));
  const restarting = async (interaction: Interaction) => {
    try {
      if (interaction.isRepliable()) await interaction.reply({ content: RESTARTING_REPLY, flags: MessageFlags.Ephemeral });
    } catch { /* The interaction may already have expired. */ }
  };
  const interact = async (interaction: Interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'help') await help(interaction, settings, servers);
        else if (interaction.commandName === 'setup') await setup(interaction, servers, settings);
        else if (interaction.commandName === 'settings') await preferences(interaction, settings, servers);
        else if (interaction.commandName === 'autofix') await autofix(interaction, personal, guildId => client.guilds.cache.has(guildId));
        else if (interaction.commandName === 'diagnose') await diagnose(interaction, settings, servers, async link => health.describe(link));
        else if (interaction.commandName === 'fix') await fix(interaction, settings, { prepareErome, ...mediaOptions, ...deliveryOptions,
          serverPreferences: id => servers.getPreferences(id), observePreview: (expected, result) => health.record(expected, result) });
        else if (interaction.commandName === 'prompt') await prompt(interaction, prompts);
      } else if (interaction.isMessageContextMenuCommand()) {
        if (interaction.commandName === 'Fix with Linky') await fix(interaction, settings, { prepareErome, ...mediaOptions, ...deliveryOptions,
          serverPreferences: id => servers.getPreferences(id), observePreview: (expected, result) => health.record(expected, result) });
      } else if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isChannelSelectMenu()) {
        if (interaction.isButton() && await handleDeliveryDetails(interaction, diagnostics)) return;
        if (interaction.isButton() && await replyThreads.handle(interaction)) return;
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
        if (await handleSetupComponent(interaction, settings, servers, testSetupHere)) return;
        if (!interaction.isButton()) return;
        // Only a replies-off parent without a thread flag or local creation can bypass cleanup.
        const cleanupManualReplies = Boolean(interaction.guildId && (replyCleanup.has(interaction.message.id) ||
          replyThreads.needsCleanup(interaction.guildId, interaction.message.id, interaction.message)));
        if (await removeManual(interaction, releaseEromeMedia,
          cleanupManualReplies ? target => replyCleanup.enqueue(target) : undefined,
          cleanupManualReplies ? target => replyCleanup.reserve(target) : undefined,
          cleanupManualReplies ? id => replyCleanup.release(id) : undefined) || await registry?.handleRemove(interaction)) return;
        if (interaction.customId !== 'linky:retry' || !registry) return;
        const record = await registry.authorize(interaction);
        if (!record) return;
        if (!isEromeAvailable(settings, record.guildId)) {
          const source = await fetchMessage(record.channelId, record.sourceId).catch(() => null);
          if (!source || findEromeLinks(source.content).length) {
            await interaction.editReply({ content: source ? EROME_UNAVAILABLE :
              'The original message is unavailable. This preview was kept.', allowedMentions: { parse: [] } });
            return;
          }
        }
        if (retrying.has(record.sourceId) || Date.now() - (retries.get(record.sourceId) ?? 0) < 30_000) {
          await interaction.editReply({ content: 'A retry is already running or just finished. Wait 30 seconds before trying again.' });
          return;
        }
        retrying.add(record.sourceId);
        retries.set(record.sourceId, Date.now());
        if (retries.size > 1000) retries.delete(retries.keys().next().value!);
        try {
          const complete = await registry.retry(record, source => repost(source as Message, { refresh: true, forceReply: true, manualRetry: true }));
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
  };

  // Readiness logs are also checked by the deployment script. Joining a guild sends nothing.
  client.once(Events.ClientReady, async (readyClient) => {
    const readyAt = Date.now();
    const previous = checkpoint.previous;
    const since = previous?.stoppedAt ?? previous?.aliveAt;
    if (settings.catchUp && since !== undefined) seenLive = new Set();
    try {
      await readyClient.application.commands.set(commandDefinitions);
      await personal.retainGuilds(readyClient.guilds.cache.keys());
      await mediaReady;
      await diagnostics.ready;
      // Cleanup continues even if the API key or YouTube support is later disabled.
      youtubeStats = new YouTubeStats({
        path: join(dirname(settings.settingsPath), 'youtube-stats.json'),
        botUserId: readyClient.user.id,
        fetchMessage,
        onError: error => logCleanupFailure(log, error),
      });
      youtubeStats.start();
      registry = new RepostRegistry({
        path: join(dirname(settings.settingsPath), 'reposts.json'), botUserId: readyClient.user.id, fetchMessage,
        removeRelated: record => youtubeStats!.removeForMessage(record.replacementId),
        afterReplacementRemoved: async (record, parent) => {
          await releaseEromeMedia(record.replacementId);
          if (replyThreads.needsCleanup(record.guildId, record.replacementId, parent)) {
            try { await replyThreads.cleanup({ guildId: record.guildId, channelId: record.channelId, threadId: record.replacementId }); }
            catch {
              // Parent is already deleted. Transfer only failed cleanup; registry intent remains if this write fails.
              await replyCleanup.defer({ guildId: record.guildId, channelId: record.channelId, threadId: record.replacementId });
              log.warn('Repost replies cleanup deferred');
            }
          }
        },
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
        onError: error => logCleanupFailure(log, error),
      });
      registry.start();
      replyCleanup.start();
      await checkpoint.start();
      // Only a clean stop is reported; after a crash the time it stopped is unknown.
      if (previous?.stoppedAt !== undefined) {
        const offlineMs = Math.max(0, readyAt - previous.stoppedAt);
        log.info({ offlineMs }, `Back online after ${(offlineMs / 1000).toFixed(1)} s offline`);
      }
      log.info(`Logged in as ${readyClient.user.tag}`);
      log.info(`Serving ${readyClient.guilds.cache.size} guild(s).`);
      if (seenLive && previous && since !== undefined) {
        const reposts = registry;
        void work.track(catchUp<Message>({
          channels: previous.channels, since, until: readyAt, now: Date.now(),
          fetchAfter: async (channelId, after, limit) => {
            const channel = await client.channels.fetch(channelId);
            // Without Read Message History Discord returns an empty list rather than an error.
            if (!channel || !('messages' in channel) || channel.isDMBased() || !channel.permissionsFor(readyClient.user)
              ?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) return null;
            return (await channel.messages.fetch({ after, limit })).values();
          },
          handled: id => Boolean(seenLive?.has(id) || reposts.findBySource(id)),
          deliver: message => work.track(repost(message)),
          stopped: () => !accepting,
        }).then(result => log.info(result, 'Checked for messages posted while offline'))
          .finally(() => { seenLive = undefined; }));
      }
    } catch (err) {
      log.error({ err }, 'Command registration failed; disconnecting');
      await client.destroy();
    }
  });
  client.on(Events.Error, (err) => log.error({ err }, 'Discord client error'));
  return client;
}
