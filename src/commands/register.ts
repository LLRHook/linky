/** Replace the global command list with Linky's help and setup commands. */
import 'dotenv/config';
import { REST, Routes, type RESTGetAPIOAuth2CurrentApplicationResult } from 'discord.js';
import { data as help } from './help';
import { data as setup } from './setup';

export async function registerCommands(rest: Pick<REST, 'get' | 'put'>): Promise<void> {
  const application = await rest.get(Routes.oauth2CurrentApplication()) as RESTGetAPIOAuth2CurrentApplicationResult;
  await rest.put(Routes.applicationCommands(application.id), { body: [help.toJSON(), setup.toJSON()] });
  console.log('Registered /help and /setup.');
}

if (require.main === module) {
  const token = process.env['DISCORD_TOKEN'];
  if (!token) throw new Error('Missing required environment variable: DISCORD_TOKEN');
  registerCommands(new REST({ version: '10' }).setToken(token)).catch((err) => {
    console.error('Command registration failed:', err);
    process.exit(1);
  });
}
