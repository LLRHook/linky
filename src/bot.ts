import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import type { Config } from './config';
import type { logger } from './logger';
import { execute as help } from './commands/help';
import { createLinkRepostHandler } from './services/SocialLinkService';
import { fetchTweetTranslation } from './services/TweetTranslation';

export function createBot(settings: Config, log: Pick<typeof logger, 'info' | 'warn' | 'error'>): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      ...(settings.channelIds.length ? [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] : []),
    ],
  });

  if (settings.channelIds.length) {
    client.on(Events.MessageCreate, createLinkRepostHandler(settings.channelIds, log, undefined, {
      platforms: settings.rewritePlatforms,
      translateTweet: settings.translateTweets ? fetchTweetTranslation : undefined,
    }));
    log.info({
      channelIds: settings.channelIds,
      platforms: settings.rewritePlatforms,
      translateTweets: settings.translateTweets,
    }, 'Social link replacement enabled for configured channels');
  }

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      if (interaction.commandName === 'help') {
        await help(interaction, settings);
      } else {
        await interaction.reply({ content: 'This command has been retired. Use /help for link fixing.', flags: MessageFlags.Ephemeral });
      }
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
