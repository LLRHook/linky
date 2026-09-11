import { readFileSync } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import type { MessageEditOptions } from 'discord.js';

export const YOUTUBE_STATS_TTL = 24 * 60 * 60_000;
const MARKER = /^-# \[YouTube\]\(<https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}(?:&t=\d+)?>\) · /;
const DISCORD_ID = /^[1-9]\d{16,19}$/;
interface ExpiryRecord { channelId: string; messageId: string; expiresAt: number; baseLength: number; suffixLength: number }
export interface StatsMessage {
  id: string;
  channelId: string;
  author: { id: string };
  content: string;
  edit(options: MessageEditOptions): Promise<unknown>;
}
interface Options {
  path: string;
  botUserId: string;
  fetchMessage(channelId: string, messageId: string): Promise<StatsMessage | null>;
  now?: () => number;
  write?: (path: string, content: string) => Promise<void>;
  onError?: (error: Error) => void;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    // Persist the rename on hosts that support opening directories (the bot runs on Linux).
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await unlink(temporary).catch(() => {}); }
}

/** Track cleanup before publishing API data; the journal never contains API data or message text. */
export class YouTubeStats {
  private values = new Map<string, ExpiryRecord>();
  private pending: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private readonly path: string;
  private readonly now: () => number;
  private readonly write: NonNullable<Options['write']>;

  constructor(private readonly options: Options) {
    this.path = resolve(options.path);
    this.now = options.now ?? Date.now;
    this.write = options.write ?? atomicWrite;
    if (!DISCORD_ID.test(options.botUserId)) throw new Error('YouTube cleanup requires a Discord bot ID.');
    let saved: unknown;
    try { saved = JSON.parse(readFileSync(this.path, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error('Could not load YouTube cleanup records.');
    }
    if (!Array.isArray(saved) || saved.length > 10_000) throw new Error('Invalid YouTube cleanup records.');
    for (const entry of saved) {
      if (!entry || typeof entry !== 'object' || Object.keys(entry).some(key =>
        !['channelId', 'messageId', 'expiresAt', 'baseLength', 'suffixLength'].includes(key)) ||
        typeof entry.channelId !== 'string' || typeof entry.messageId !== 'string' ||
        !DISCORD_ID.test(entry.channelId) || !DISCORD_ID.test(entry.messageId) ||
        !Number.isSafeInteger(entry.expiresAt) || entry.expiresAt < 0 ||
        !Number.isSafeInteger(entry.baseLength) || entry.baseLength < 0 ||
        !Number.isSafeInteger(entry.suffixLength) || entry.suffixLength < 4 ||
        entry.baseLength + entry.suffixLength > 2000 || this.values.has(entry.messageId)) {
        throw new Error('Invalid YouTube cleanup records.');
      }
      this.values.set(entry.messageId, entry);
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation);
    this.pending = next.catch(() => {});
    return next;
  }

  private async save(values: Map<string, ExpiryRecord>): Promise<void> {
    await this.write(this.path, JSON.stringify([...values.values()]) + '\n');
    this.values = values;
  }

  private report(): void {
    try { this.options.onError?.(new Error('YouTube statistics could not be published or cleaned up; retained cleanup records will be retried.')); }
    catch { /* Logging must not break the cleanup queue. */ }
  }

  publish(message: StatsMessage, statsSuffix: string): Promise<boolean> {
    return this.serialize(async () => {
      const suffix = '\n\n' + statsSuffix.trim();
      if (message.author.id !== this.options.botUserId || !DISCORD_ID.test(message.channelId) ||
          !DISCORD_ID.test(message.id) || !MARKER.test(suffix.slice(2)) ||
          message.content.length + suffix.length > 2000 || this.values.has(message.id) || this.values.size >= 10_000) return false;
      const entry: ExpiryRecord = { channelId: message.channelId, messageId: message.id,
        expiresAt: this.now() + YOUTUBE_STATS_TTL, baseLength: message.content.length, suffixLength: suffix.length };
      try { await this.save(new Map(this.values).set(message.id, entry)); }
      catch { this.report(); return false; }
      try {
        await message.edit({ content: message.content + suffix, allowedMentions: { parse: [], repliedUser: false } });
        return true;
      } catch { this.report(); return false; }
    });
  }

  sweep(): Promise<void> {
    return this.serialize(async () => {
      const next = new Map(this.values);
      let failed = false;
      for (const [id, entry] of this.values) {
        if (entry.expiresAt > this.now()) continue;
        try {
          const message = await this.options.fetchMessage(entry.channelId, id);
          if (message && (message.id !== id || message.channelId !== entry.channelId)) { failed = true; continue; }
          if (message && message.author.id === this.options.botUserId) {
            const tail = message.content.slice(entry.baseLength);
            if (message.content.length === entry.baseLength + entry.suffixLength && tail.startsWith('\n\n') && MARKER.test(tail.slice(2))) {
              await message.edit({ content: message.content.slice(0, entry.baseLength), allowedMentions: { parse: [], repliedUser: false } });
            } else if (message.content.length !== entry.baseLength && message.content.split('\n').some(line => MARKER.test(line))) {
              failed = true;
              continue;
            }
          }
          next.delete(id);
        } catch (error) {
          const failure = error as { code?: number; status?: number };
          if ([10003, 10008].includes(failure.code ?? 0) || failure.status === 404) next.delete(id);
          else failed = true;
        }
      }
      if (next.size !== this.values.size) await this.save(next);
      if (failed) this.report();
    });
  }

  start(): void {
    if (this.timer) return;
    void this.sweep().catch(() => this.report());
    this.timer = setInterval(() => { void this.sweep().catch(() => this.report()); }, 60 * 60_000);
    this.timer.unref();
  }

  stop(): void { clearInterval(this.timer); this.timer = undefined; }
}
