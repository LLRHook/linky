import type { APIEmbed, Client, Message } from 'discord.js';
import { inspectPreviews, type ExpectedPreview, type PreviewResult } from './PreviewRecovery';

type PreviewMessage = Pick<Message, 'id' | 'channelId' | 'author' | 'embeds' | 'fetch'>;
export interface PreviewWatch {
  verify(message: PreviewMessage): Promise<PreviewResult>;
  close(): void;
}
export interface PreviewWatcherOptions {
  gatewayWaitMs?: number;
  reconcileTimeoutMs?: number;
  maxActive?: number;
}

/** One client listener, bounded subscriptions. Each attempt must be armed before publishing or editing. */
export class PreviewWatcher {
  private watches = new Set<(data: Record<string, unknown>) => void>();
  private disposers = new Set<() => void>();
  private closed = false;
  private readonly onRaw = (packet: { t?: string; d?: unknown }) => {
    if ((packet.t !== 'MESSAGE_CREATE' && packet.t !== 'MESSAGE_UPDATE') || !packet.d || typeof packet.d !== 'object') return;
    for (const watch of this.watches) watch(packet.d as Record<string, unknown>);
  };

  constructor(private client: Client, private options: PreviewWatcherOptions = {}) {
    client.on('raw', this.onRaw);
  }

  arm(channelId: string, expected: readonly ExpectedPreview[], { signal }: { signal?: AbortSignal } = {}): PreviewWatch {
    let latest = inspectPreviews([], expected);
    let targetId: string | undefined;
    let stopped = this.closed || Boolean(signal?.aborted);
    let verified = false;
    let wake: (() => void) | undefined;
    let lifetime: NodeJS.Timeout | undefined;
    const pending = new Map<string, PreviewResult>();
    const accept = (result: PreviewResult) => { if (!latest.ok || result.ok) latest = result; if (result.ok) wake?.(); };
    const receive = (data: Record<string, unknown>) => {
      if (stopped || data.channel_id !== channelId || typeof data.id !== 'string' ||
        (targetId !== undefined && data.id !== targetId) || !Array.isArray(data.embeds)) return;
      if (data.author && typeof data.author === 'object' && 'id' in data.author && data.author.id !== this.client.user?.id) return;
      const embeds = data.embeds.slice(0, 10).filter((embed): embed is APIEmbed => Boolean(embed && typeof embed === 'object' &&
        typeof embed.url === 'string' && (embed.title === undefined || typeof embed.title === 'string') &&
        (embed.description === undefined || typeof embed.description === 'string')));
      let result: PreviewResult;
      try { result = inspectPreviews(embeds, expected); } catch { return; }
      if (targetId) accept(result);
      else if (result.ok) {
        // Discord can emit MESSAGE_CREATE before the REST send resolves. Never accumulate channel history.
        pending.set(data.id, result);
        if (pending.size > 16) pending.delete(pending.keys().next().value!);
      }
    };
    const close = () => {
      stopped = true;
      clearTimeout(lifetime);
      this.watches.delete(receive); this.disposers.delete(close); pending.clear();
      signal?.removeEventListener('abort', close);
      wake?.();
    };
    const subscribed = !stopped && this.watches.size < Math.max(1, Math.min(128, this.options.maxActive ?? 128));
    if (subscribed) { this.watches.add(receive); this.disposers.add(close); }
    signal?.addEventListener('abort', close, { once: true });
    // A failed send whose caller forgets cleanup cannot retain a subscription forever.
    if (!stopped) { lifetime = setTimeout(close, 30_000); lifetime.unref(); }
    return { close, verify: async message => {
      if (verified) return latest;
      verified = true;
      if (stopped || message.channelId !== channelId || !this.client.user || message.author.id !== this.client.user.id) {
        close(); return latest;
      }
      targetId = message.id;
      const cached = pending.get(targetId);
      pending.clear();
      accept(cached?.ok ? cached : inspectPreviews(message.embeds.map(embed => embed.toJSON()), expected));
      try {
        if (!latest.ok && subscribed) {
          await new Promise<void>(resolve => {
            // Cold Instagram media has arrived after 7.5s in live checks; useful updates still wake immediately.
            const gatewayWaitMs = expected.some(item => item.platform === 'instagram') ? 8_000 : 4_000;
            const timer = setTimeout(resolve, Math.max(0, Math.min(8_000, this.options.gatewayWaitMs ?? gatewayWaitMs)));
            wake = () => { clearTimeout(timer); resolve(); };
            if (latest.ok || stopped) wake();
          });
          wake = undefined;
        }
        if (!latest.ok && !stopped) {
          // A reconnect can miss the update. Reconcile once, never start a polling loop.
          let timer: NodeJS.Timeout | undefined;
          const timeout = new Promise<undefined>(resolve => {
            timer = setTimeout(() => resolve(undefined), Math.max(1, Math.min(5_000, this.options.reconcileTimeoutMs ?? 2_000)));
            wake = () => { clearTimeout(timer); resolve(undefined); };
          });
          try {
            const reconciled = await Promise.race([message.fetch(true), timeout]);
            if (reconciled && !stopped) accept(inspectPreviews(reconciled.embeds.map(embed => embed.toJSON()), expected));
          } catch (error) {
            if (!latest.ok && !stopped) throw error;
          } finally { clearTimeout(timer); wake = undefined; }
        }
        return latest;
      } finally { close(); }
    } };
  }

  close(): void {
    this.closed = true;
    this.client.off('raw', this.onRaw);
    for (const close of this.disposers) close();
  }
}
