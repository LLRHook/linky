export const REWRITE_PLATFORMS = ['x', 'instagram', 'tiktok', 'youtube', 'bluesky', 'reddit', 'twitch', 'erome'] as const;
export type RewritePlatform = typeof REWRITE_PLATFORMS[number];

const DISCORD_ID = /^[1-9]\d{16,19}$/;

/** Reject an unknown name instead of silently leaving that platform unrewritten. */
export function parseRewritePlatforms(value: string | undefined): readonly RewritePlatform[] {
  if (!value?.trim()) return REWRITE_PLATFORMS;
  const platforms = new Set<RewritePlatform>();
  for (const entry of value.split(',')) {
    const name = entry.trim();
    if (!(REWRITE_PLATFORMS as readonly string[]).includes(name)) {
      throw new Error(`REWRITE_PLATFORMS must be a comma-separated subset of ${REWRITE_PLATFORMS.join(', ')}, with no empty entries.`);
    }
    platforms.add(name as RewritePlatform);
  }
  return [...platforms];
}

/** Reject malformed scope instead of accidentally processing unrelated channels or servers. */
export function parseDiscordIds(value: string | undefined, label = 'Channel IDs'): string[] {
  if (!value?.trim()) return [];
  const ids = value.split(',').map(entry => entry.trim());
  if (ids.some(id => !DISCORD_ID.test(id))) {
    throw new Error(`${label} must be comma-separated Discord IDs (17-20 digits), with no empty entries.`);
  }
  return [...new Set(ids)];
}
