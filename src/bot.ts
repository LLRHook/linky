import { Client, Events, GatewayIntentBits } from 'discord.js';
import type { Config } from './config';
import type { logger } from './logger';
import { execute as help } from './commands/help';
import { createLinkRepostHandler } from './services/SocialLinkService';
import { fetchTweetTranslation } from './services/TweetTranslation';

export function createBot(settings: Config, log: Pick<typeof logger, 'info' | 'warn' | 'error'>): Client {
  const enabled = settings.channelIds.length > 0 || settings.serverIds.length > 0;
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      ...(enabled ? [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] : []),
    ],
  });

  if (enabled) {
    client.on(Events.MessageCreate, createLinkRepostHandler(settings.channelIds, log, undefined, {
      serverIds: settings.serverIds,
      platforms: settings.rewritePlatforms,
      translateTweet: settings.translateTweets ? fetchTweetTranslation : undefined,
    }));
    log.info({
      channelIds: settings.channelIds,
      serverIds: settings.serverIds,
      platforms: settings.rewritePlatforms,
      translateTweets: settings.translateTweets,
    }, 'Social link replacement enabled for configured scope');
  }

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'help') return;
    try {
      await help(interaction, settings);
    } catch (err) {
      log.error({ err, commandName: interaction.commandName }, 'Could not reply to command');
    }
  });

  // Readiness logs are also checked by the deployment script. Joining a guild sends nothing.
  client.once(Events.ClientReady, (readyClient) => {
    log.info(`Logged in as ${readyClient.user.tag}`);
    log.info(`Serving ${readyClient.guilds.cache.size} guild(s).`);
  });
  client.on(Events.Error, (err) => log.error({ err }, 'Discord client error'));
  return client;
}
