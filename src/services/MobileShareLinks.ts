import { resolve4 } from 'node:dns/promises';
import type { request, RequestOptions } from 'node:https';
import { mapLinks, visibleLink } from './LinkTokens';
import { cancelRegionalResponse, connectHttps, isPublicIpv4, regionalAbortable } from './RegionalHttp';
import { parseSocialUrl } from './SocialProviders';

type MobilePlatform = 'instagram' | 'reddit';
export interface NormalizedMobileLinks {
  content: string;
  /** Canonical source URL to the first original share token that fits a link button. */
  originals: ReadonlyMap<string, string>;
}
export type MobileShareLinkNormalizer = (
  content: string, enabledPlatforms: readonly string[], signal?: AbortSignal,
) => Promise<NormalizedMobileLinks>;
export interface MobileShareLinkDependencies {
  resolve4?: (hostname: string) => Promise<string[]>;
  connect?: (options: RequestOptions, signal: AbortSignal) => Promise<Response>;
  request?: typeof request;
  timeoutMs?: number;
}

const INSTAGRAM_HOSTS = new Set(['instagram.com', 'www.instagram.com', 'm.instagram.com', 'mobile.instagram.com']);
const REDDIT_HOSTS = new Set(['reddit.com', 'www.reddit.com', 'old.reddit.com', 'm.reddit.com']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_LINKS = 5;
const MAX_HOPS = 4;
const MAX_ACTIVE_RESOLUTIONS = 8;
const MAX_TIMEOUT_MS = 4_000;

/** Inspect raw authority/path before URL can normalize credentials, ports or dot segments away. */
function strictUrl(raw: string): URL | null {
  if (raw.length > 2048 || /[\\\s\u0000-\u001f\u007f]/.test(raw)) return null;
  const parts = /^https:\/\/([^/?#]+)([^?#]*)(?:\?[^#]*)?(#.*)?$/i.exec(raw);
  if (!parts) return null;
  try {
    const url = new URL(raw);
    return parts[1].toLowerCase() === url.hostname && parts[2] === url.pathname ? url : null;
  } catch { return null; }
}

function sharePlatform(url: URL): MobilePlatform | null {
  if (INSTAGRAM_HOSTS.has(url.hostname) && /^\/share\/(?:(?:p|reel)\/)?[A-Za-z0-9_-]{1,64}\/?$/.test(url.pathname)) {
    return 'instagram';
  }
  if (REDDIT_HOSTS.has(url.hostname) &&
      /^\/(?:r\/[A-Za-z0-9_]{1,64}|(?:u|user)\/[A-Za-z0-9_-]{1,64})\/s\/[A-Za-z0-9_-]{1,64}\/?$/.test(url.pathname)) {
    return 'reddit';
  }
  return null;
}

/** These forms already contain the post identity and need no network lookup. */
function redditAlias(url: URL): string | null {
  const short = url.hostname === 'redd.it' && /^\/([A-Za-z0-9]{1,13})\/?$/.exec(url.pathname);
  if (short) return `https://www.reddit.com/comments/${short[1]}${url.search}${url.hash}`;
  if (url.hostname === 'm.reddit.com') {
    const canonical = `https://www.reddit.com${url.pathname}${url.search}${url.hash}`;
    if (parseSocialUrl(canonical)?.platform === 'reddit') return canonical;
  }
  return null;
}

function redirectUrl(location: string, current: URL): URL | null {
  // Resolve only explicit HTTPS authorities and root-relative paths. In particular,
  // do not let URL silently repair malformed slashes or normalize ../ segments.
  const absolute = location.startsWith('//') ? `https:${location}`
    : location.startsWith('/') ? `${current.origin}${location}` : location;
  const next = strictUrl(absolute);
  if (next && !location.includes('#')) next.hash = current.hash;
  return next;
}

function canonicalDestination(url: URL, platform: MobilePlatform): string | null {
  const raw = platform === 'reddit' ? redditAlias(url) ?? url.href : url.href;
  const canonical = parseSocialUrl(raw);
  if (canonical?.platform !== platform) return null;
  return canonical.sourceUrl;
}

/** Synchronous eligibility lets interactions acknowledge before any resolver network work. */
export function hasMobileShareLinks(content: string, enabledPlatforms: readonly string[]): boolean {
  if (/(?:^|\s)!nolinky(?=\s|$)/i.test(content)) return false;
  let found = false;
  mapLinks(content, (raw, position) => {
    const url = visibleLink(content, position) && strictUrl(raw);
    const platform = url && (redditAlias(url) ? 'reddit' : sharePlatform(url));
    if (platform && enabledPlatforms.includes(platform)) found = true;
    return raw;
  });
  return found;
}

/** Resolve only first-party HTTP redirects; never download HTML or use a session cookie. */
async function resolveShare(url: URL, platform: MobilePlatform, signal: AbortSignal,
  dependencies: MobileShareLinkDependencies): Promise<string | null> {
  const seen = new Set<string>();
  let current = url;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (signal.aborted || seen.has(current.href) || sharePlatform(current) !== platform) return null;
    seen.add(current.href);
    const addresses = await regionalAbortable((dependencies.resolve4 ?? resolve4)(current.hostname), signal);
    // Only IPv4 is used. Reject mixed answers as well as entirely private answers;
    // the lookup callback below pins the checked address for the TLS connection.
    if (!addresses.length || addresses.length > 32 || !addresses.every(isPublicIpv4) || signal.aborted) return null;
    const address = addresses[0];
    const connect = dependencies.connect ?? ((options: RequestOptions, abort: AbortSignal) =>
      connectHttps(options, abort, dependencies.request));
    const response = await regionalAbortable(connect({
      protocol: 'https:', hostname: current.hostname, servername: current.hostname, port: 443,
      path: current.pathname + current.search, method: 'GET', agent: false, family: 4,
      rejectUnauthorized: true, maxHeaderSize: 8192,
      headers: { accept: 'text/html', 'accept-encoding': 'identity', 'user-agent': 'Mozilla/5.0 (compatible; Linky/1.0)' },
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address, family: 4 }]);
        else callback(null, address, 4);
      },
    }, signal), signal, cancelRegionalResponse);
    // The consumed response-body limit is zero, including on failures, compressed
    // responses and login pages. Set-Cookie is discarded and never replayed.
    cancelRegionalResponse(response);
    if (signal.aborted || !REDIRECT_STATUSES.has(response.status)) return null;
    const location = response.headers.get('location');
    const next = location && redirectUrl(location, current);
    if (!next) return null;
    const canonical = canonicalDestination(next, platform);
    if (canonical) return canonical;
    current = next;
  }
  return null;
}

/** Failed, hidden, disabled and over-budget links retain their exact original text. */
export function createMobileShareLinkNormalizer(dependencies: MobileShareLinkDependencies = {}): MobileShareLinkNormalizer {
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1, dependencies.timeoutMs ?? MAX_TIMEOUT_MS));
  let active = 0;
  return async (content, enabledPlatforms, signal) => {
    const originals = new Map<string, string>();
    if (signal?.aborted || /(?:^|\s)!nolinky(?=\s|$)/i.test(content)) return { content, originals };
    const pending = new Map<string, { url: URL; platform: MobilePlatform; direct?: string }>();
    mapLinks(content, (raw, position) => {
      if (pending.size >= MAX_LINKS || !visibleLink(content, position)) return raw;
      const url = strictUrl(raw);
      if (!url) return raw;
      const direct = redditAlias(url);
      const platform = direct ? 'reddit' : sharePlatform(url);
      if (platform && enabledPlatforms.includes(platform)) pending.set(raw, { url, platform, ...(direct ? { direct } : {}) });
      return raw;
    });
    if (!pending.size) return { content, originals };
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(abort, timeoutMs);
    const replacements = new Map<string, string>();
    try {
      for (const [raw, candidate] of pending) {
        if (controller.signal.aborted) break;
        let canonical = candidate.direct ? parseSocialUrl(candidate.direct)?.sourceUrl : undefined;
        if (!canonical && active < MAX_ACTIVE_RESOLUTIONS) {
          active++;
          try { canonical = await resolveShare(candidate.url, candidate.platform, controller.signal, dependencies) ?? undefined; }
          catch { /* Network failures leave this link alone. */ }
          finally { active--; }
        }
        if (canonical && !controller.signal.aborted) {
          replacements.set(raw, canonical);
          const source = parseSocialUrl(canonical)!.sourceUrl;
          if (raw.length <= 500 && !originals.has(source)) originals.set(source, raw);
        }
      }
      // A caller cancellation invalidates the operation, even if earlier links resolved.
      if (signal?.aborted) return { content, originals: new Map() };
      return { content: mapLinks(content, (raw, position) =>
        visibleLink(content, position) ? replacements.get(raw) ?? raw : raw), originals };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };
}
