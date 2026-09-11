import { Client, Events, GatewayIntentBits } from 'discord.js';
import type { Config } from './config';
import type { logger } from './logger';
import { execute as help, data as helpData } from './commands/help';
import { execute as setup, data as setupData } from './commands/setup';
import { ServerSettings } from './services/ServerSettings';
import { createLinkRepostHandler } from './services/SocialLinkService';
import { fetchTweetTranslation } from './services/TweetTranslation';

export function createBot(settings: Config, log: Pick<typeof logger, 'info' | 'warn' | 'error'>,
  servers = new ServerSettings(settings.settingsPath)): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
    ],
  });

  client.on(Events.MessageCreate, createLinkRepostHandler(settings.channelIds, log, undefined, {
    serverEnabled: id => servers.get(id),
    serverIds: settings.serverIds,
    platforms: settings.rewritePlatforms,
    translateTweet: settings.translateTweets ? fetchTweetTranslation : undefined,
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
    } catch (err) {
      log.error({ err, commandName: interaction.commandName }, 'Could not reply to command');
    }
  });

  // Readiness logs are also checked by the deployment script. Joining a guild sends nothing.
  client.once(Events.ClientReady, async (readyClient) => {
    try {
      await readyClient.application.commands.set([helpData.toJSON(), setupData.toJSON()]);
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
