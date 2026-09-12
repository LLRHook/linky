export type SocialPlatform = 'x' | 'instagram' | 'tiktok' | 'bluesky' | 'reddit' | 'twitch';

export interface SocialUrl {
  readonly platform: SocialPlatform;
  readonly sourceUrl: string;
  readonly path: string;
  readonly fragment: string;
  readonly statusId?: string;
  /** Stable post identity for non-X platforms; Bluesky includes the actor and record key. */
  readonly postId?: string;
}

/** Catalog order is the preferred delivery order, not a claim of current health. */
export const SOCIAL_PROVIDERS = [
  { id: 'fixupx', platform: 'x', label: 'FxEmbed', origin: 'https://fixupx.com', hosts: ['fixupx.com', 'fxtwitter.com', 'g.fixupx.com', 'g.fxtwitter.com'] },
  { id: 'fixvx', platform: 'x', label: 'vxTwitter', origin: 'https://vxtwitter.com', hosts: ['vxtwitter.com', 'fixvx.com'] },
  { id: 'instagram7', platform: 'instagram', label: 'Instagram7', origin: 'https://www.instagram7.com', hosts: ['www.instagram7.com', 'instagram7.com'] },
  // https://github.com/seirenkr/OGInstagram — gallery/direct modes share this service.
  { id: 'oginstagram', platform: 'instagram', label: 'OGInstagram', origin: 'https://oginstagram.com', hosts: ['oginstagram.com', 'www.oginstagram.com'] },
  { id: 'tnktok', platform: 'tiktok', label: 'fxTikTok', origin: 'https://tnktok.com', hosts: ['tnktok.com', 'www.tnktok.com'] },
  // URL forms below are documented by their maintainers.
  // https://github.com/Lexedia/VixBluesky and https://docs.fxembed.com/guide/getting-started/
  { id: 'vixbluesky', platform: 'bluesky', label: 'VixBluesky', origin: 'https://bskx.app', hosts: ['bskx.app'] },
  { id: 'fxbluesky', platform: 'bluesky', label: 'FxBluesky', origin: 'https://fxbsky.app', hosts: ['fxbsky.app'] },
  // https://github.com/dylanpdx/vxReddit — rxddit is omitted after failed live checks.
  { id: 'vxreddit', platform: 'reddit', label: 'vxReddit', origin: 'https://vxreddit.com', hosts: ['vxreddit.com'] },
  // https://github.com/seriaati/fxtwitch — this service is unrelated to fxtwitch.tv.
  { id: 'fxtwitch', platform: 'twitch', label: 'fxTwitch', origin: 'https://fxtwitch.seria.moe', hosts: ['fxtwitch.seria.moe'] },
] as const;
export type SocialProvider = typeof SOCIAL_PROVIDERS[number];
export interface ProviderCandidate { providerId: SocialProvider['id']; platform: SocialPlatform; url: string }

const X_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']);
const INSTAGRAM_HOSTS = new Set(['instagram.com', 'www.instagram.com', 'm.instagram.com', 'mobile.instagram.com']);
const TIKTOK_HOSTS = new Set(['tiktok.com', 'www.tiktok.com', 'm.tiktok.com']);
const TIKTOK_SHARE_HOSTS = new Set(['vm.tiktok.com', 'vt.tiktok.com']);
const REDDIT_HOSTS = new Set(['reddit.com', 'www.reddit.com', 'old.reddit.com']);
const TWITCH_HOSTS = new Set(['twitch.tv', 'www.twitch.tv', 'm.twitch.tv']);

// AT Protocol handle/record-key syntax; only handle and the supported DID forms are accepted.
const HANDLE = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
function blueskyActor(value: string): string | null {
  if (value.length <= 253 && HANDLE.test(value)) return value.toLowerCase();
  if (/^did:plc:[a-z2-7]{24}$/.test(value)) return value;
  const webDomain = value.startsWith('did:web:') ? value.slice(8) : '';
  return webDomain.length <= 253 && HANDLE.test(webDomain) ? value : null;
}

/** Parse a complete source URL; never follow redirects or extract a nested URL. */
export function parseSocialUrl(raw: string): SocialUrl | null {
  if (raw.length > 2048 || /[\\\s\u0000-\u001f\u007f]/.test(raw)) return null;
  const parts = /^https:\/\/([^/?#]+)([^?#]*)(?:\?[^#]*)?(#.*)?$/i.exec(raw);
  if (!parts) return null;
  try {
    const url = new URL(raw);
    // Comparing the raw authority also rejects explicit :443, credentials and
    // Unicode lookalikes that URL would otherwise normalize before inspection.
    if (parts[1].toLowerCase() !== url.hostname || parts[2] !== url.pathname) return null;
    let path = url.pathname;
    const fragment = url.hash;
    let platform: SocialPlatform, sourceHost: string, statusId: string | undefined, postId: string | undefined;
    if (X_HOSTS.has(url.hostname)) {
      const post = /^\/(?:[A-Za-z0-9_]{1,15}\/status|i\/web\/status)\/(\d{1,20})(?:\/(?:photo|video)\/[1-4])?\/?$/.exec(path);
      if (!post) return null;
      platform = 'x'; sourceHost = 'x.com'; statusId = post[1];
    } else if (INSTAGRAM_HOSTS.has(url.hostname)) {
      if (!/^\/(?:p|reels?|tv)\/[A-Za-z0-9_-]{1,64}\/?$/.test(path)) return null;
      platform = 'instagram'; sourceHost = 'www.instagram.com';
    } else if (TIKTOK_HOSTS.has(url.hostname)) {
      if (!/^\/(?:@[\w.-]{1,64}\/(?:video|photo)\/\d{1,20}|t\/[A-Za-z0-9_-]{1,64})\/?$/.test(path)) return null;
      platform = 'tiktok'; sourceHost = 'www.tiktok.com';
    } else if (TIKTOK_SHARE_HOSTS.has(url.hostname)) {
      if (!/^\/[A-Za-z0-9_-]{1,64}\/?$/.test(path)) return null;
      platform = 'tiktok'; sourceHost = url.hostname;
    } else if (url.hostname === 'bsky.app') {
      const post = /^\/profile\/([^/]+)\/post\/([A-Za-z0-9._:~-]{1,512})\/?$/.exec(path);
      const actor = post && blueskyActor(post[1]);
      if (!post || !actor || post[2] === '.' || post[2] === '..') return null;
      platform = 'bluesky'; sourceHost = 'bsky.app'; postId = `${actor}/${post[2]}`;
      path = `/profile/${actor}/post/${post[2]}`;
      // Preserve complete source links within Discord's original-post button limit.
      if (`https://${sourceHost}${path}`.length > 500) return null;
    } else if (REDDIT_HOSTS.has(url.hostname)) {
      const post = /^\/(?:(?:r\/[A-Za-z0-9_.]{1,64}|(?:u|user)\/[A-Za-z0-9_-]{1,64})\/)?comments\/([A-Za-z0-9]{1,13})(?:\/[A-Za-z0-9_~-]{1,300})?(?:\/[A-Za-z0-9]{1,13})?\/?$/.exec(path);
      if (!post) return null;
      platform = 'reddit'; sourceHost = 'www.reddit.com'; postId = post[1].toLowerCase();
    } else if (url.hostname === 'clips.twitch.tv' || TWITCH_HOSTS.has(url.hostname)) {
      const clip = url.hostname === 'clips.twitch.tv' ? /^\/([A-Za-z0-9_-]{1,100})\/?$/.exec(path)?.[1]
        : /^\/[A-Za-z0-9_]{1,25}\/clip\/([A-Za-z0-9_-]{1,100})\/?$/.exec(path)?.[1];
      if (!clip || clip === 'embed') return null;
      platform = 'twitch'; sourceHost = 'clips.twitch.tv'; postId = clip;
      path = `/${clip}`;
    } else return null;
    return { platform, sourceUrl: `https://${sourceHost}${path}${fragment}`, path, fragment,
      ...(statusId ? { statusId } : {}), ...(postId ? { postId } : {}) };
  } catch { return null; }
}

/** Build only vetted provider authorities from a freshly validated source URL. */
export function getProviderCandidates(source: string | SocialUrl): readonly ProviderCandidate[] {
  const parsed = parseSocialUrl(typeof source === 'string' ? source : source.sourceUrl);
  return parsed ? SOCIAL_PROVIDERS.filter(provider => provider.platform === parsed.platform).map(provider => ({
    providerId: provider.id, platform: parsed.platform,
    url: provider.origin + (parsed.platform === 'twitch' ? '/clip' : '') + parsed.path + parsed.fragment,
  })) : [];
}

/** Identify a provider's observed embed URL without accepting arbitrary mirrors. */
export function parseProviderUrl(raw: string): (SocialUrl & { providerId: SocialProvider['id'] }) | null {
  const authority = /^https:\/\/([^/?#]+)(\/.*)$/i.exec(raw);
  if (!authority) return null;
  const provider = SOCIAL_PROVIDERS.find(entry => (entry.hosts as readonly string[]).includes(authority[1].toLowerCase()));
  if (!provider) return null;
  let path = authority[2];
  if (provider.platform === 'twitch') {
    const clipPath = /^\/clip(?=\/)/.test(path);
    if (clipPath) path = path.slice('/clip'.length);
    const source = parseSocialUrl(`https://${clipPath ? 'clips.twitch.tv' : 'www.twitch.tv'}${path}`);
    return source ? { ...source, providerId: provider.id } : null;
  }
  const sourceHost = provider.platform === 'x' ? 'x.com' : provider.platform === 'instagram' ? 'www.instagram.com'
    : provider.platform === 'bluesky' ? 'bsky.app' : provider.platform === 'reddit' ? 'www.reddit.com'
    : /^\/[A-Za-z0-9_-]+\/?(?:[?#]|$)/.test(path) ? 'vm.tiktok.com' : 'www.tiktok.com';
  const source = parseSocialUrl(`https://${sourceHost}${path}`);
  return source ? { ...source, providerId: provider.id } : null;
}
