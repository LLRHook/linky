import 'dotenv/config';
import { parseFixupXChannelIds, parseRewritePlatforms, type RewritePlatform } from './services/XLinkService';

/**
 * Typed configuration object loaded from environment variables.
 * Throws at startup if required variables are missing.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export interface Config {
  /** Discord bot token */
  discordToken: string;
  /** Node environment */
  nodeEnv: string;
  /** Exact channels for social link replacement; an empty list disables the feature. */
  fixupXChannelIds: readonly string[];
  /** Platforms whose links are rewritten; defaults to all of them. */
  rewritePlatforms: readonly RewritePlatform[];
  /** Append fxtwitter.com's translate modifier to non-English reposted tweets. */
  translateTweets: boolean;
}

export const config: Config = {
  discordToken: requireEnv('DISCORD_TOKEN'),
  nodeEnv: process.env['NODE_ENV'] ?? 'development',
  fixupXChannelIds: parseFixupXChannelIds(process.env['FIXUPX_CHANNEL_IDS'], process.env['FIXUPX_CHANNEL_ID']),
  rewritePlatforms: parseRewritePlatforms(process.env['REWRITE_PLATFORMS']),
  translateTweets: process.env['TRANSLATE_TWEETS']?.toLowerCase() === 'true',
};
