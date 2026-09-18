import 'dotenv/config';
import { dirname, join } from 'node:path';
import { parseDiscordIds, parseRewritePlatforms, type RewritePlatform } from './services/LinkConfiguration';
import type { EromeMediaSettings } from './services/EromeMediaRuntime';
import { parseEromeGuildIds } from './services/EromeAvailability';

export interface Config {
  discordToken: string;
  channelIds: readonly string[];
  serverIds: readonly string[];
  rewritePlatforms: readonly RewritePlatform[];
  translateTweets: boolean;
  translateInstagram?: boolean;
  captionApiKey?: string;
  settingsPath: string;
  youtubeApiKey?: string;
  prompt?: { token: string; guildIds: readonly string[] };
  eromeMedia?: EromeMediaSettings;
  eromeGuildIds?: readonly string[];
  deliveryLogRetentionDays?: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const youtubeApiKey = process.env['YOUTUBE_API_KEY']?.trim() || undefined;
const captionApiKey = process.env['GOOGLE_TRANSLATE_API_KEY']?.trim() || undefined;
const promptToken = process.env['PROMPT_GITHUB_TOKEN']?.trim();
const settingsPath = process.env['LINK_SETTINGS_PATH']?.trim() || 'data/servers.json';
const retentionDays = process.env['DELIVERY_LOG_RETENTION_DAYS']?.trim() ?? '30';
if (!/^[1-9]\d?$/.test(retentionDays) || Number(retentionDays) > 90) {
  throw Error('DELIVERY_LOG_RETENTION_DAYS must be an integer from 1 to 90.');
}

export const config: Config = {
  discordToken: requireEnv('DISCORD_TOKEN'),
  channelIds: parseDiscordIds(process.env['LINK_CHANNEL_IDS']),
  serverIds: parseDiscordIds(process.env['LINK_SERVER_IDS'], 'Server IDs'),
  rewritePlatforms: parseRewritePlatforms(process.env['REWRITE_PLATFORMS']),
  translateTweets: process.env['TRANSLATE_TWEETS']?.toLowerCase() === 'true',
  translateInstagram: process.env['TRANSLATE_INSTAGRAM']?.toLowerCase() === 'true' && Boolean(captionApiKey),
  captionApiKey,
  settingsPath,
  eromeGuildIds: parseEromeGuildIds(process.env['EROME_GUILD_IDS']),
  deliveryLogRetentionDays: Number(retentionDays),
  youtubeApiKey,
  prompt: process.env['PROMPT_ENABLED']?.toLowerCase() === 'true' && promptToken ? {
    token: promptToken, guildIds: parseDiscordIds(process.env['PROMPT_GUILD_IDS'], 'Coding server IDs'),
  } : undefined,
  eromeMedia: process.env['EROME_MEDIA_ENABLED']?.toLowerCase() === 'true' ? {
    key: requireEnv('EROME_WORKER_KEY'),
    workerBaseUrl: requireEnv('EROME_WORKER_BASE_URL'),
    publicBaseUrl: requireEnv('EROME_MEDIA_BASE_URL'),
    directory: process.env['EROME_MEDIA_PATH']?.trim() || join(dirname(settingsPath), 'media'),
    port: Number(process.env['EROME_MEDIA_PORT'] || 8092),
  } : undefined,
};
