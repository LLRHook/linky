import 'dotenv/config';
import { parseDiscordIds, parseRewritePlatforms, type RewritePlatform } from './services/SocialLinkService';

export interface Config {
  discordToken: string;
  channelIds: readonly string[];
  serverIds: readonly string[];
  rewritePlatforms: readonly RewritePlatform[];
  translateTweets: boolean;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config: Config = {
  discordToken: requireEnv('DISCORD_TOKEN'),
  channelIds: parseDiscordIds(process.env['LINK_CHANNEL_IDS']),
  serverIds: parseDiscordIds(process.env['LINK_SERVER_IDS'], 'Server IDs'),
  rewritePlatforms: parseRewritePlatforms(process.env['REWRITE_PLATFORMS']),
  translateTweets: process.env['TRANSLATE_TWEETS']?.toLowerCase() === 'true',
};
