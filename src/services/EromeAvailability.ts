import type { Config } from '../config';
import { parseDiscordIds } from './LinkConfiguration';

type EromeAvailability = Pick<Config, 'rewritePlatforms' | 'eromeGuildIds'>;

export const EROME_UNAVAILABLE = 'Erome is unavailable on this bot in this server or private conversation. Server settings cannot enable it. To run your own Linky with Erome support, see https://linkybot.dev/self-host.';

/** Unset preserves self-hosted availability; an explicit restriction must parse without ambiguity. */
export function parseEromeGuildIds(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === 'none') return [];
  if (!value.trim()) throw Error('EROME_GUILD_IDS must be none or comma-separated Discord IDs; omit it for unrestricted self-hosting.');
  return parseDiscordIds(value, 'EROME_GUILD_IDS');
}

/** Operator policy can only narrow platform availability; DMs never permit Erome preparation. */
export function isEromeAvailable(config: EromeAvailability, guildId: string | null | undefined): boolean {
  return Boolean(guildId && config.rewritePlatforms.includes('erome') &&
    (config.eromeGuildIds === undefined || config.eromeGuildIds.includes(guildId)));
}
