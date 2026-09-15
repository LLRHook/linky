import { createHmac, randomBytes } from 'node:crypto';
import { mapLinks, visibleLink } from './LinkTokens';
import { getProviderCandidates, parseProviderUrl, type ProviderCandidate } from './SocialProviders';
import { previewIdentity, type ExpectedPreview, type PreviewResult } from './PreviewRecovery';

export interface ProviderAttempt { expected: readonly ExpectedPreview[]; result: PreviewResult }
export interface ProviderMode { captionFree?: boolean; requireVideo?: boolean }
interface ProviderState { losses: Map<string, number>; cooldownUntil: number; probeAfter: number }

/** Route only on repeated, paired evidence: this provider missed a post an alternate actually previewed. */
export class ProviderHealth {
  private states = new Map<string, ProviderState>();
  private readonly salt = randomBytes(32);
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;
  private readonly probeMs: number;
  private readonly threshold: number;

  constructor(options: { now?: () => number; windowMs?: number; cooldownMs?: number; probeMs?: number; threshold?: number } = {}) {
    this.now = options.now ?? (() => performance.now());
    this.windowMs = Math.max(1, Math.min(60 * 60_000, options.windowMs ?? 15 * 60_000));
    this.cooldownMs = Math.max(1, Math.min(15 * 60_000, options.cooldownMs ?? 2 * 60_000));
    this.probeMs = Math.max(1, Math.min(5 * 60_000, options.probeMs ?? 30_000));
    this.threshold = Math.max(2, Math.min(20, options.threshold ?? 3));
  }

  order(candidates: readonly ProviderCandidate[], mode: ProviderMode = {}): ProviderCandidate[] {
    if (candidates.length < 2) return [...candidates];
    const now = this.now();
    const deferred = new Set<string>();
    for (const candidate of candidates) {
      const state = this.states.get(this.key(candidate.providerId, mode));
      if (!state) continue;
      this.prune(state, now);
      if (!state.cooldownUntil) continue;
      if (state.cooldownUntil <= now && state.probeAfter <= now) {
        // At most one new request per probe interval tries the catalog preference again.
        state.probeAfter = now + this.probeMs;
      } else deferred.add(candidate.providerId);
    }
    // Stable sort keeps the configured provider order within each health group. Never remove a fallback.
    return [...candidates].sort((a, b) => Number(deferred.has(a.providerId)) - Number(deferred.has(b.providerId)));
  }

  /** Call once with the ordered attempts for a single message, after its recovery completes. */
  recordRecovery(attempts: readonly ProviderAttempt[]): void {
    const now = this.now();
    for (let index = 0; index < Math.min(4, attempts.length); index++) {
      const attempt = attempts[index];
      for (const success of (attempt.result.attributed ?? []).slice(0, 10)) {
        if (!attempt.expected.some(item => this.same(item, success)) ||
          attempt.result.missing.some(item => item.source === success.source) || !this.valid(success)) continue;
        // A confirmed probe closes the degraded state for this capability mode.
        this.states.delete(this.key(success.providerId, success));
        for (const previous of attempts.slice(0, index)) {
          const failure = previous.expected.find(item => item.source === success.source && item.providerId !== success.providerId &&
            Boolean(item.captionFree) === Boolean(success.captionFree) && Boolean(item.requireVideo) === Boolean(success.requireVideo));
          if (!failure || !this.valid(failure) || !previous.result.missing.some(item => this.same(item, failure))) continue;
          const key = this.key(failure.providerId, failure);
          const state = this.states.get(key) ?? { losses: new Map<string, number>(), cooldownUntil: 0, probeAfter: 0 };
          this.prune(state, now);
          const fingerprint = createHmac('sha256', this.salt).update(previewIdentity(failure.source)!).digest('hex');
          // Repeated retries for one post count once. Memory never contains its URL or caption.
          state.losses.set(fingerprint, now);
          if (state.losses.size > 128) state.losses.delete(state.losses.keys().next().value!);
          if (state.losses.size >= this.threshold) {
            state.cooldownUntil = now + this.cooldownMs;
            state.probeAfter = state.cooldownUntil;
          }
          this.states.set(key, state);
        }
      }
    }
  }

  /** Apply policy to visible catalog URLs; preserve gallery capability and every unrelated token. */
  preferContent(content: string, { captionFree = false, requireVideo = false }: ProviderMode = {}): string {
    return mapLinks(content, (url, position) => {
      if (!visibleLink(content, position)) return url;
      const parsed = parseProviderUrl(url);
      if (!parsed) return url;
      // A gallery URL is its own capability requirement even if the caller omitted the option.
      const gallery = captionFree || new URL(url).hostname.startsWith('g.');
      const candidates = getProviderCandidates(parsed, { captionFree: gallery });
      const selected = this.order(candidates, { captionFree: gallery, requireVideo })[0];
      return selected && selected.providerId !== parsed.providerId ? selected.url : url;
    });
  }

  private key(provider: string, mode: ProviderMode): string {
    return `${provider}:${Boolean(mode.captionFree)}:${Boolean(mode.requireVideo)}`;
  }
  private same(a: ExpectedPreview, b: ExpectedPreview): boolean {
    return a.source === b.source && a.providerId === b.providerId && a.url === b.url;
  }
  private valid(item: ExpectedPreview): boolean {
    const parsed = parseProviderUrl(item.url);
    return parsed?.providerId === item.providerId && previewIdentity(item.url) === previewIdentity(item.source) &&
      getProviderCandidates(item.source, { captionFree: item.captionFree })
      .some(candidate => candidate.providerId === item.providerId);
  }
  private prune(state: ProviderState, now: number): void {
    for (const [post, at] of state.losses) if (now - at >= this.windowMs) state.losses.delete(post);
    // Expired evidence must not leave a provider permanently deprioritized after an abandoned probe.
    if (!state.losses.size) { state.cooldownUntil = 0; state.probeAfter = 0; }
  }
}
