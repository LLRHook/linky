import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { atomicWrite } from './AtomicWrite';
import { DISCORD_ID } from './LinkConfiguration';

export const CATCH_UP_CHANNEL_LIMIT = 20;
export const CATCH_UP_MESSAGE_LIMIT = 50;
export const CATCH_UP_WINDOW_MS = 2 * 60_000;
/** Channels whose missed messages are delivered at the same time; each channel stays in order. */
export const CATCH_UP_CONCURRENCY = 4;
/** Allows for clock difference between this host and Discord's message timestamps. */
export const CATCH_UP_CLOCK_MARGIN_MS = 3_000;
export const CHECKPOINT_INTERVAL_MS = 30_000;
const MAX_FILE_BYTES = 16 * 1024;
const DISCORD_EPOCH = 1_420_070_400_000n;
const KEYS = new Set(['stoppedAt', 'aliveAt', 'channels']);

export interface CheckpointState {
  /** When the previous process stopped accepting messages. Absent after a crash. */
  stoppedAt?: number;
  /** The previous process's last periodic refresh while catch-up was enabled; covers a crash. */
  aliveAt?: number;
  /** Recently active served channel IDs, newest first. Empty unless catch-up is enabled. */
  channels: string[];
}

interface Options {
  path: string;
  trackChannels: boolean;
  now?: () => number;
  write?: typeof atomicWrite;
  onError?: () => void;
}

const validTime = (value: unknown) => value === undefined || Number.isSafeInteger(value) && (value as number) >= 0;

function readState(path: string): CheckpointState | undefined {
  try {
    if (statSync(path).size > MAX_FILE_BYTES) return undefined;
    const data = JSON.parse(readFileSync(path, 'utf8')) as Partial<CheckpointState> | null;
    if (!data || typeof data !== 'object' || Object.keys(data).some(key => !KEYS.has(key)) ||
      !validTime(data.stoppedAt) || !validTime(data.aliveAt) ||
      !Array.isArray(data.channels) || data.channels.length > CATCH_UP_CHANNEL_LIMIT ||
      !data.channels.every(id => typeof id === 'string' && DISCORD_ID.test(id)) ||
      new Set(data.channels).size !== data.channels.length) return undefined;
    return {
      ...(data.stoppedAt === undefined ? {} : { stoppedAt: data.stoppedAt }),
      ...(data.aliveAt === undefined ? {} : { aliveAt: data.aliveAt }),
      channels: [...data.channels],
    };
  } catch { return undefined; }
}

/**
 * Times and channel IDs that let the next process measure and recover the gap while
 * the bot was offline. Never stores message content. A missing or invalid file only
 * disables recovery for one restart.
 */
export class ServiceCheckpoint {
  /** What the previous process left behind, read once at construction. */
  readonly previous: CheckpointState | undefined;
  private channels: string[];
  private pending: Promise<boolean> = Promise.resolve(true);
  private timer?: ReturnType<typeof setInterval>;
  private started = false;
  private stopped = false;
  private readonly path: string;
  private readonly now: () => number;

  constructor(private readonly options: Options) {
    this.path = resolve(options.path);
    this.now = options.now ?? Date.now;
    this.previous = readState(this.path);
    this.channels = options.trackChannels ? [...this.previous?.channels ?? []] : [];
  }

  /** Remembers a served channel where a member posted, keeping the most recent ones. */
  observe(channelId: string): void {
    if (!this.options.trackChannels || this.stopped || this.channels[0] === channelId) return;
    const index = this.channels.indexOf(channelId);
    if (index >= 0) this.channels.splice(index, 1);
    this.channels.unshift(channelId);
    if (this.channels.length > CATCH_UP_CHANNEL_LIMIT) this.channels.pop();
  }

  private save(times: Pick<CheckpointState, 'stoppedAt' | 'aliveAt'>): Promise<boolean> {
    const state: CheckpointState = { ...times, channels: [...this.channels] };
    const operation = this.pending.then(async () => {
      try { await (this.options.write ?? atomicWrite)(this.path, JSON.stringify(state) + '\n'); return true; }
      catch {
        try { this.options.onError?.(); } catch { /* Reporting must not stop the checkpoint. */ }
        return false;
      }
    });
    this.pending = operation;
    return operation;
  }

  /**
   * Marks this process as serving, which clears the previous stop time so a later
   * crash is not mistaken for that clean stop. With channel tracking the alive time
   * is refreshed periodically so a crash still leaves a recent catch-up start.
   */
  start(): Promise<boolean> {
    if (this.started || this.stopped) return this.pending;
    this.started = true;
    if (!this.options.trackChannels) return this.save({});
    this.timer = setInterval(() => { void this.save({ aliveAt: this.now() }); }, CHECKPOINT_INTERVAL_MS);
    this.timer.unref?.();
    return this.save({ aliveAt: this.now() });
  }

  /** Records when this process stopped accepting messages. A process that never started leaves the previous record. */
  stop(stoppedAt: number): Promise<boolean> {
    clearInterval(this.timer);
    this.timer = undefined;
    if (this.stopped) return this.pending;
    this.stopped = true;
    return this.started ? this.save({ stoppedAt }) : this.pending;
  }
}

export interface CatchUpMessage { id: string; createdTimestamp: number }

export interface CatchUpOptions<T extends CatchUpMessage> {
  channels: readonly string[];
  /** When the previous process stopped accepting messages, or was last known alive. */
  since: number;
  /** When this session began receiving live messages. */
  until: number;
  now: number;
  /** Fetches up to `limit` messages created after the snowflake `after`, or null for an unavailable channel. */
  fetchAfter: (channelId: string, after: string, limit: number) => Promise<Iterable<T> | null>;
  handled: (messageId: string) => boolean;
  deliver: (message: T) => Promise<unknown>;
  stopped: () => boolean;
}

export interface CatchUpResult { channels: number; unavailable: number; delivered: number }

/** The smallest snowflake whose creation time is not before `timestamp`, minus one, for an exclusive `after` query. */
export function snowflakeBefore(timestamp: number): string {
  return String(((BigInt(Math.floor(timestamp)) - DISCORD_EPOCH) << 22n) - 1n);
}

/**
 * Delivers messages posted while the bot was offline: one bounded request per
 * remembered channel within the catch-up window, oldest first and one at a time per
 * channel, with a few channels in parallel.
 */
export async function catchUp<T extends CatchUpMessage>(options: CatchUpOptions<T>): Promise<CatchUpResult> {
  const result: CatchUpResult = { channels: 0, unavailable: 0, delivered: 0 };
  const start = Math.max(options.since - CATCH_UP_CLOCK_MARGIN_MS, options.now - CATCH_UP_WINDOW_MS);
  const until = options.until + CATCH_UP_CLOCK_MARGIN_MS;
  if (start >= until) return result;
  const after = snowflakeBefore(start);
  const queue = options.channels.slice(0, CATCH_UP_CHANNEL_LIMIT);
  const channel = async (channelId: string) => {
    let messages: Iterable<T> | null;
    try { messages = await options.fetchAfter(channelId, after, CATCH_UP_MESSAGE_LIMIT); }
    catch { messages = null; }
    if (!messages) { result.unavailable++; return; }
    result.channels++;
    const missed = [...messages]
      .filter(message => message.createdTimestamp >= start && message.createdTimestamp < until)
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
      .slice(0, CATCH_UP_MESSAGE_LIMIT);
    for (const message of missed) {
      if (options.stopped()) return;
      if (options.handled(message.id)) continue;
      result.delivered++;
      await options.deliver(message).catch(() => {});
    }
  };
  await Promise.all(Array.from({ length: Math.min(CATCH_UP_CONCURRENCY, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined && !options.stopped(); next = queue.shift()) await channel(next);
  }));
  return result;
}
