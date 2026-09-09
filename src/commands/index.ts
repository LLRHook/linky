import { ChatInputCommandInteraction } from 'discord.js';
import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';

export interface CommandModule {
  data: { name: string; toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody };
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
  autocomplete?: (interaction: import('discord.js').AutocompleteInteraction) => Promise<void>;
}

import * as register from './economy/register';
import * as unregister from './economy/unregister';
import * as balance from './economy/balance';
import * as daily from './economy/daily';
import * as bank from './economy/bank';
import * as leaderboard from './economy/leaderboard';
import * as stats from './economy/stats';
import * as history from './economy/history';
import * as wannaBet from './bets/wannaBet';
import * as accept from './bets/accept';
import * as decline from './bets/decline';
import * as resolve from './bets/resolve';
import * as bets from './bets/bets';
import * as admin from './admin/admin';
import * as setup from './admin/setup';
import * as voteAdmin from './election/voteAdmin';
import * as help from './help';

export const commands: CommandModule[] = [
  register,
  unregister,
  balance,
  daily,
  bank,
  leaderboard,
  stats,
  history,
  wannaBet,
  accept,
  decline,
  resolve,
  bets,
  admin,
  setup,
  voteAdmin,
  help,
];

export const commandMap = new Map<string, CommandModule>(
  commands.map((cmd) => [cmd.data.name, cmd])
);
