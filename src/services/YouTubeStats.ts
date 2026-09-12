import { readFileSync } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import type { APIActionRowComponent, APIComponentInMessageActionRow, APIEmbed, APIMessageTopLevelComponent, MessageEditOptions } from 'discord.js';
import { controlsForYouTube, mergeYouTubeControls, removeYouTubeControls } from './YouTubeControls';

export const YOUTUBE_STATS_TTL = 24 * 60 * 60_000;
const MARKER = /^-# \[YouTube\]\(<https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}(?:&t=\d+)?>\) · /;
const DISCORD_ID = /^[1-9]\d{16,19}$/;
interface LegacyRecord { channelId: string; messageId: string; expiresAt: number; baseLength: number; suffixLength: number; kind?: never }
interface CardRecord { kind: 'card'; channelId: string; messageId: string; expiresAt: number; baseMessageId?: string }
interface ControlsRecord { kind: 'controls'; channelId: string; messageId: string; expiresAt: number; videoIds: string[] }
type ExpiryRecord = LegacyRecord | CardRecord | ControlsRecord;
export interface StatsPublication {
  remove(): Promise<void>;
  controls?: APIActionRowComponent<APIComponentInMessageActionRow>[];
}
export interface StatsMessage {
  id: string;
  channelId: string;
  author: { id: string };
  content: string;
  components?: readonly { toJSON(): APIMessageTopLevelComponent }[];
  edit(options: MessageEditOptions): Promise<unknown>;
  delete(): Promise<unknown>;
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
        !(entry.kind === 'controls' ? ['kind', 'channelId', 'messageId', 'expiresAt', 'videoIds'] :
          entry.kind === 'card' ? ['kind', 'channelId', 'messageId', 'expiresAt', 'baseMessageId'] :
          ['channelId', 'messageId', 'expiresAt', 'baseLength', 'suffixLength']).includes(key)) ||
        typeof entry.channelId !== 'string' || typeof entry.messageId !== 'string' ||
        !DISCORD_ID.test(entry.channelId) || !DISCORD_ID.test(entry.messageId) ||
        !Number.isSafeInteger(entry.expiresAt) || entry.expiresAt < 0 ||
        (entry.kind === 'card' && entry.baseMessageId !== undefined &&
          (typeof entry.baseMessageId !== 'string' || !DISCORD_ID.test(entry.baseMessageId) || entry.baseMessageId === entry.messageId)) ||
        (entry.kind === 'controls' && (!Array.isArray(entry.videoIds) || entry.videoIds.length < 1 || entry.videoIds.length > 3 ||
          entry.videoIds.some((id: unknown) => typeof id !== 'string' || !/^[\w-]{11}$/.test(id)) ||
          new Set(entry.videoIds).size !== entry.videoIds.length)) ||
        (entry.kind !== 'card' && entry.kind !== 'controls' && (!Number.isSafeInteger(entry.baseLength) || entry.baseLength < 0 ||
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

  private publication(entry: ControlsRecord, controls: NonNullable<StatsPublication['controls']>): StatsPublication {
    return { controls, remove: () => this.serialize(() => this.removeEntry(entry).catch(() => this.report())) };
  }

  canView(message: Pick<StatsMessage, 'id' | 'channelId' | 'author'>, videoId: string): boolean {
    const entry = this.values.get(message.id);
    return message.author.id === this.options.botUserId && entry?.kind === 'controls' &&
      entry.channelId === message.channelId && entry.expiresAt > this.now() && entry.videoIds.includes(videoId);
  }

  removeForMessage(baseMessageId: string): Promise<void> {
    return this.serialize(async () => {
      for (const entry of this.values.values()) {
        if (entry.kind === 'card' ? entry.baseMessageId === baseMessageId : entry.messageId === baseMessageId) {
          await this.removeEntry(entry).catch(() => this.report());
        }
      }
    });
  }

  private async removeEntry(entry: ExpiryRecord): Promise<void> {
    const current = this.values.get(entry.messageId);
    if (!current) return;
    const expired = { ...current, expiresAt: Math.min(current.expiresAt, this.now()) };
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
        else if (entry.kind === 'controls') {
          const before = message.components?.map(component => component.toJSON()) ?? [];
          const components = removeYouTubeControls(before);
          if (JSON.stringify(before) !== JSON.stringify(components)) {
            await message.edit({ components, allowedMentions: { parse: [], users: [], roles: [], repliedUser: false } });
          }
        }
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

  publish(message: StatsMessage, embeds: APIEmbed[]): Promise<StatsPublication | null> {
    return this.serialize(async () => {
      if (message.author.id !== this.options.botUserId || !DISCORD_ID.test(message.channelId) ||
          !DISCORD_ID.test(message.id)) return null;
      const existing = this.values.get(message.id);
      if ((!existing && this.values.size >= 10_000) || (existing && existing.kind !== 'controls')) return null;
      if (existing && existing.expiresAt <= this.now()) {
        await this.removeEntry(existing).catch(() => this.report());
        return null;
      }
      const presentation = controlsForYouTube(embeds);
      if (!presentation || !mergeYouTubeControls(message.components?.map(component => component.toJSON()) ?? [], presentation.controls)) return null;
      const entry: ControlsRecord = { kind: 'controls', channelId: message.channelId, messageId: message.id,
        expiresAt: existing?.expiresAt ?? this.now() + YOUTUBE_STATS_TTL, videoIds: presentation.videoIds };
      try { await this.save(new Map(this.values).set(message.id, entry)); }
      catch { this.report(); return null; }
      try {
        // Re-read SDK components after the disk write so concurrent unrelated controls survive.
        const components = mergeYouTubeControls(message.components?.map(component => component.toJSON()) ?? [], presentation.controls);
        if (!components) throw new Error('No space for YouTube controls.');
        await message.edit({ components, allowedMentions: { parse: [], users: [], roles: [], repliedUser: false } });
        return this.publication(entry, presentation.controls);
      } catch {
        this.report();
        await this.removeEntry(entry).catch(() => this.report());
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
