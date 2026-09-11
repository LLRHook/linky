import 'dotenv/config';
import { parseChannelIds, parseRewritePlatforms, type RewritePlatform } from './services/SocialLinkService';

export interface Config {
  discordToken: string;
  channelIds: readonly string[];
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
  channelIds: parseChannelIds(process.env['LINK_CHANNEL_IDS']),
  rewritePlatforms: parseRewritePlatforms(process.env['REWRITE_PLATFORMS']),
  translateTweets: process.env['TRANSLATE_TWEETS']?.toLowerCase() === 'true',
};
