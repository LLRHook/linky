/** Registers slash commands globally; run npm run register-commands with DISCORD_TOKEN set. */
import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { config } from '../config';
import { commands } from './index';

async function registerCommands(): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(config.discordToken);

  const commandData = commands.map((cmd) => cmd.data.toJSON());
  const applicationId = Buffer.from(config.discordToken.split('.')[0]!, 'base64').toString('utf-8');

  console.log(`Registering ${commandData.length} global slash commands for application ${applicationId}...`);
  console.log('Commands:', commandData.map((c) => c.name).join(', '));

  try {
    const result = await rest.put(
      Routes.applicationCommands(applicationId),
      { body: commandData }
    );

    const registered = result as unknown[];
    console.log(`Successfully registered ${registered.length} global slash commands.`);
    console.log('Note: Global commands may take up to 1 hour to appear in all guilds on first registration.');
  } catch (err) {
    console.error('Failed to register commands:', err);
    process.exit(1);
  }
}

registerCommands().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
