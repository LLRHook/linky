import { readFileSync } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { MessageFlags, type APIEmbed, type MessageCreateOptions, type MessageEditOptions } from 'discord.js';

export const YOUTUBE_STATS_TTL = 24 * 60 * 60_000;
const MARKER = /^-# \[YouTube\]\(<https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}(?:&t=\d+)?>\) · /;
const DISCORD_ID = /^[1-9]\d{16,19}$/;
interface LegacyRecord { channelId: string; messageId: string; expiresAt: number; baseLength: number; suffixLength: number; kind?: never }
interface CardRecord { kind: 'card'; channelId: string; messageId: string; expiresAt: number; baseMessageId?: string }
type ExpiryRecord = LegacyRecord | CardRecord;
export interface StatsPublication { remove(): Promise<void> }
export interface StatsMessage {
  id: string;
  channelId: string;
  author: { id: string };
  content: string;
  edit(options: MessageEditOptions): Promise<unknown>;
  delete(): Promise<unknown>;
}
type VideoMessage = Pick<StatsMessage, 'id' | 'channelId' | 'author'> & {
  channel: { send(options: MessageCreateOptions): Promise<StatsMessage> };
};
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

function validCards(embeds: readonly APIEmbed[]): boolean {
  let length = 0;
  return embeds.length > 0 && embeds.length <= 3 && embeds.every(embed => {
    const parts: [string | undefined, number][] = [[embed.title, 256], [embed.description, 4096],
      [embed.footer?.text, 2048], [embed.author?.name, 256]];
    if ((embed.fields?.length ?? 0) > 25) return false;
    for (const field of embed.fields ?? []) parts.push([field.name, 256], [field.value, 1024]);
    if (!parts.some(([text]) => text?.length)) return false;
    return parts.every(([text, limit]) => {
      length += text?.length ?? 0;
      return (text?.length ?? 0) <= limit && length <= 6000;
    });
  });
}

function missing(error: unknown): boolean {
  const failure = error as { code?: number; status?: number } | null;
  return [10003, 10008].includes(failure?.code ?? 0) || failure?.status === 404;
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
        !(entry.kind === 'card' ? ['kind', 'channelId', 'messageId', 'expiresAt', 'baseMessageId'] :
          ['channelId', 'messageId', 'expiresAt', 'baseLength', 'suffixLength']).includes(key)) ||
        typeof entry.channelId !== 'string' || typeof entry.messageId !== 'string' ||
        !DISCORD_ID.test(entry.channelId) || !DISCORD_ID.test(entry.messageId) ||
        !Number.isSafeInteger(entry.expiresAt) || entry.expiresAt < 0 ||
        (entry.kind === 'card' && entry.baseMessageId !== undefined &&
          (typeof entry.baseMessageId !== 'string' || !DISCORD_ID.test(entry.baseMessageId) || entry.baseMessageId === entry.messageId)) ||
        (entry.kind !== 'card' && (!Number.isSafeInteger(entry.baseLength) || entry.baseLength < 0 ||
          !Number.isSafeInteger(entry.suffixLength) || entry.suffixLength < 4 ||
          entry.baseLength + entry.suffixLength > 2000)) || this.values.has(entry.messageId)) {
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

  private publication(entry: CardRecord): StatsPublication {
    return { remove: () => this.serialize(() => this.removeCard(entry).catch(() => this.report())) };
  }

  removeForMessage(baseMessageId: string): Promise<void> {
    return this.serialize(async () => {
      for (const entry of this.values.values()) {
        if (entry.kind === 'card' && entry.baseMessageId === baseMessageId) {
          await this.removeCard(entry).catch(() => this.report());
        }
      }
    });
  }

  private async removeCard(entry: CardRecord): Promise<void> {
    if (!this.values.has(entry.messageId)) return;
    const expired = { ...entry, expiresAt: Math.min(entry.expiresAt, this.now()) };
    try { await this.save(new Map(this.values).set(entry.messageId, expired)); }
    catch { this.values.set(entry.messageId, expired); this.report(); }
    if (await this.clean(expired)) {
      const next = new Map(this.values);
      next.delete(entry.messageId);
      await this.save(next);
    }
  }

  private async clean(entry: ExpiryRecord): Promise<boolean> {
    try {
      const message = await this.options.fetchMessage(entry.channelId, entry.messageId);
      if (message && (message.id !== entry.messageId || message.channelId !== entry.channelId)) {
        this.report(); return false;
      }
      if (message?.author.id === this.options.botUserId) {
        if (entry.kind === 'card') await message.delete();
        else {
          const tail = message.content.slice(entry.baseLength);
          if (message.content.length === entry.baseLength + entry.suffixLength && tail.startsWith('\n\n') && MARKER.test(tail.slice(2))) {
            await message.edit({ content: message.content.slice(0, entry.baseLength), allowedMentions: { parse: [], repliedUser: false } });
          } else if (message.content.length !== entry.baseLength && message.content.split('\n').some(line => MARKER.test(line))) {
            this.report(); return false;
          }
        }
      }
    } catch (error) {
      if (!missing(error)) { this.report(); return false; }
    }
    return true;
  }

  publish(message: VideoMessage, embeds: APIEmbed[]): Promise<StatsPublication | null> {
    return this.serialize(async () => {
      if (message.author.id !== this.options.botUserId || !DISCORD_ID.test(message.channelId) ||
          !DISCORD_ID.test(message.id) || !validCards(embeds) || this.values.size >= 10_000) return null;
      let card: StatsMessage;
      try {
        card = await message.channel.send({ content: 'YouTube details', flags: MessageFlags.SuppressNotifications,
          allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
          nonce: `yt:${message.id}`, enforceNonce: true });
      } catch { this.report(); return null; }
      if (card.author.id !== this.options.botUserId || card.channelId !== message.channelId ||
          !DISCORD_ID.test(card.id) || card.id === message.id) { this.report(); return null; }
      const existing = this.values.get(card.id);
      if (existing?.kind === 'card' && existing.baseMessageId && existing.baseMessageId !== message.id) {
        this.report(); return null;
      }
      if (existing && (existing.kind !== 'card' || existing.expiresAt <= this.now())) {
        if (existing.kind === 'card') await this.removeCard(existing).catch(() => this.report());
        return null;
      }
      const entry: CardRecord = existing ?? { kind: 'card', channelId: card.channelId, messageId: card.id,
        baseMessageId: message.id, expiresAt: this.now() + YOUTUBE_STATS_TTL };
      try { if (!existing) await this.save(new Map(this.values).set(card.id, entry)); }
      catch {
        try { await card.delete(); } catch { /* The placeholder contains no API data. */ }
        this.report(); return null;
      }
      try {
        await card.edit({ content: '', embeds, allowedMentions: { parse: [], users: [], roles: [], repliedUser: false } });
        return this.publication(entry);
      } catch {
        this.report();
        await this.removeCard(entry).catch(() => this.report());
        return null;
      }
    });
  }

  sweep(): Promise<void> {
    return this.serialize(async () => {
      const next = new Map(this.values);
      for (const entry of this.values.values()) {
        if (entry.expiresAt > this.now()) continue;
        if (await this.clean(entry)) next.delete(entry.messageId);
      }
      if (next.size !== this.values.size) await this.save(next);
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
