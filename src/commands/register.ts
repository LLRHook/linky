/** Replace the global command list with the link-fixing help command. */
import 'dotenv/config';
import { REST, Routes, type RESTGetAPIOAuth2CurrentApplicationResult } from 'discord.js';
import { data } from './help';

export async function registerCommands(rest: Pick<REST, 'get' | 'put'>): Promise<void> {
  const application = await rest.get(Routes.oauth2CurrentApplication()) as RESTGetAPIOAuth2CurrentApplicationResult;
  await rest.put(Routes.applicationCommands(application.id), { body: [data.toJSON()] });
  console.log('Registered /help.');
}

if (require.main === module) {
  const token = process.env['DISCORD_TOKEN'];
  if (!token) throw new Error('Missing required environment variable: DISCORD_TOKEN');
  registerCommands(new REST({ version: '10' }).setToken(token)).catch((err) => {
    console.error('Command registration failed:', err);
    process.exit(1);
  });
}
