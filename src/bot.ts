import { Client, Events, GatewayIntentBits } from 'discord.js';
import { dirname, join } from 'node:path';
import type { Config } from './config';
import type { logger } from './logger';
import { execute as help, data as helpData } from './commands/help';
import { execute as setup, data as setupData } from './commands/setup';
import { execute as preferences, data as preferencesData } from './commands/settings';
import { ServerSettings } from './services/ServerSettings';
import { createLinkRepostHandler } from './services/SocialLinkService';
import { fetchTweetTranslation } from './services/TweetTranslation';
import { createYouTubeLookup } from './services/YouTube';
import { YouTubeStats } from './services/YouTubeStats';

export function createBot(settings: Config, log: Pick<typeof logger, 'info' | 'warn' | 'error'>,
  servers = new ServerSettings(settings.settingsPath)): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
    ],
  });
  let youtubeStats: YouTubeStats | undefined;
  const destroy = client.destroy.bind(client);
  client.destroy = async () => { youtubeStats?.stop(); await destroy(); };

  client.on(Events.MessageCreate, createLinkRepostHandler(settings.channelIds, log, undefined, {
    serverEnabled: id => servers.get(id),
    serverPreferences: id => servers.getPreferences(id),
    serverIds: settings.serverIds,
    platforms: settings.rewritePlatforms,
    translateTweet: settings.translateTweets ? fetchTweetTranslation : undefined,
    lookupYouTube: settings.youtubeApiKey ? createYouTubeLookup(settings.youtubeApiKey) : undefined,
    publishYouTube: (message, suffix) => youtubeStats?.publish(message, suffix) ?? Promise.resolve(false),
  }));
  log.info({
    channelIds: settings.channelIds,
    serverIds: settings.serverIds,
    platforms: settings.rewritePlatforms,
    translateTweets: settings.translateTweets,
  }, 'Social link replacement ready for configured and opted-in servers');

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      if (interaction.commandName === 'help') await help(interaction, settings, servers);
      else if (interaction.commandName === 'setup') await setup(interaction, servers);
      else if (interaction.commandName === 'settings') await preferences(interaction, settings, servers);
    } catch (err) {
      log.error({ err, commandName: interaction.commandName }, 'Could not reply to command');
    }
  });

  // Readiness logs are also checked by the deployment script. Joining a guild sends nothing.
  client.once(Events.ClientReady, async (readyClient) => {
    try {
      await readyClient.application.commands.set([helpData.toJSON(), setupData.toJSON(), preferencesData.toJSON()]);
      // Cleanup continues even if the API key or YouTube support is later disabled.
      youtubeStats = new YouTubeStats({
        path: join(dirname(settings.settingsPath), 'youtube-stats.json'),
        botUserId: readyClient.user.id,
        fetchMessage: async (channelId, messageId) => {
          const channel = await client.channels.fetch(channelId);
          return channel && 'messages' in channel ? channel.messages.fetch(messageId) : null;
        },
        onError: () => log.warn('YouTube statistics cleanup failed; retained records will be retried'),
      });
      youtubeStats.start();
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
