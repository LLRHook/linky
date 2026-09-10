import { createBot } from './bot';
import { config } from './config';
import { logger } from './logger';

const client = createBot(config, logger);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    logger.info({ signal }, 'Disconnecting from Discord');
    await client.destroy();
    process.exit(0);
  });
}

client.login(config.discordToken).catch((err) => {
  logger.error({ err }, 'Discord login failed');
  process.exit(1);
});
