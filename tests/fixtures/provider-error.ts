import { EmbedType, type APIEmbed } from 'discord.js';

// Sanitized embed fields from .vv/live-fixture-analysis.json: knownErrorCard.
// Discord message/reference IDs and all other message fields are deliberately excluded.
export const capturedProviderError: APIEmbed = {
  type: EmbedType.Link,
  url: 'https://vxtwitter.com/LinkyVVDeleted/status/999999999999999999',
  title: 'vxTwitter / fixvx',
  description: "Failed to scan your link! This may be due to an incorrect link, private/suspended account, deleted tweet, or recent changes to Twitter's API (Thanks, Elon!).",
};
export const capturedErrorSource = 'https://x.com/LinkyVVDeleted/status/999999999999999999';

/** Synthetic fixupx card uses the existing generic-error rules; vxTwitter retains captured card fields. */
export function xProviderError(url: string): APIEmbed {
  return new URL(url).hostname === 'fixupx.com'
    ? { url, title: 'Error', description: 'Try again later' }
    : { ...capturedProviderError, url };
}
