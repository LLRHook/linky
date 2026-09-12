import 'dotenv/config';
import { parseDiscordIds, parseRewritePlatforms, type RewritePlatform } from './services/SocialLinkService';

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
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const youtubeApiKey = process.env['YOUTUBE_API_KEY']?.trim() || undefined;
const captionApiKey = process.env['GOOGLE_TRANSLATE_API_KEY']?.trim() || undefined;

export const config: Config = {
  discordToken: requireEnv('DISCORD_TOKEN'),
  channelIds: parseDiscordIds(process.env['LINK_CHANNEL_IDS']),
  serverIds: parseDiscordIds(process.env['LINK_SERVER_IDS'], 'Server IDs'),
  rewritePlatforms: parseRewritePlatforms(process.env['REWRITE_PLATFORMS'])
    .filter(platform => platform !== 'youtube' || youtubeApiKey !== undefined),
  translateTweets: process.env['TRANSLATE_TWEETS']?.toLowerCase() === 'true',
  translateInstagram: process.env['TRANSLATE_INSTAGRAM']?.toLowerCase() === 'true' && Boolean(captionApiKey),
  captionApiKey,
  settingsPath: process.env['LINK_SETTINGS_PATH']?.trim() || 'data/servers.json',
  youtubeApiKey,
};
