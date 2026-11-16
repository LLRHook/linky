import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { atomicWrite } from './AtomicWrite';
import { cleanupFailure, type CleanupFailure } from './CleanupFailure';
import { DISCORD_ID } from './LinkConfiguration';
import type { APIActionRowComponent, APIComponentInMessageActionRow, APIEmbed, APIMessageTopLevelComponent, MessageEditOptions } from 'discord.js';
import { controlsForYouTube, mergeYouTubeControls, removeYouTubeControls } from './YouTubeControls';

export const YOUTUBE_STATS_TTL = 24 * 60 * 60_000;
const CLEANUP_RETRY_MS = 7 * 24 * 60 * 60_000;
const MARKER = /^-# \[YouTube\]\(<https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}(?:&t=\d+)?>\) · /;
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
  onError?: (error: CleanupFailure) => void;
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

  private report(error?: unknown, terminal = false): void {
    try { this.options.onError?.(cleanupFailure(terminal
      ? 'YouTube statistics cleanup still failed more than seven days after expiry; cleanup record removed.'
      : 'YouTube statistics could not be published or cleaned up; retained cleanup records will be retried.', error)); }
    catch { /* Logging must not break the cleanup queue. */ }
  }

  private publication(entry: ControlsRecord, controls: NonNullable<StatsPublication['controls']>): StatsPublication {
    return { controls, remove: () => this.serialize(() => this.removeEntry(entry).catch(error => this.report(error))) };
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
          await this.removeEntry(entry).catch(error => this.report(error));
        }
      }
    });
  }

  private async removeEntry(entry: ExpiryRecord): Promise<void> {
    const current = this.values.get(entry.messageId);
    if (!current) return;
    const expired = { ...current, expiresAt: Math.min(current.expiresAt, this.now()) };
    try { await this.save(new Map(this.values).set(entry.messageId, expired)); }
    catch (error) { this.values.set(entry.messageId, expired); this.report(error); }
    if (await this.clean(expired)) {
      const next = new Map(this.values);
      next.delete(entry.messageId);
      await this.save(next);
    }
  }

  private async clean(entry: ExpiryRecord, report: (error?: unknown) => void = error => this.report(error)): Promise<boolean> {
    try {
      const message = await this.options.fetchMessage(entry.channelId, entry.messageId);
      if (message && (message.id !== entry.messageId || message.channelId !== entry.channelId)) {
        report(); return false;
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
            report(); return false;
          }
        }
      }
    } catch (error) {
      if (!missing(error)) { report(error); return false; }
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
        await this.removeEntry(existing).catch(error => this.report(error));
        return null;
      }
      const presentation = controlsForYouTube(embeds);
      if (!presentation || !mergeYouTubeControls(message.components?.map(component => component.toJSON()) ?? [], presentation.controls)) return null;
      const entry: ControlsRecord = { kind: 'controls', channelId: message.channelId, messageId: message.id,
        expiresAt: existing?.expiresAt ?? this.now() + YOUTUBE_STATS_TTL, videoIds: presentation.videoIds };
      try { await this.save(new Map(this.values).set(message.id, entry)); }
      catch (error) { this.report(error); return null; }
      try {
        // Re-read SDK components after the disk write so concurrent unrelated controls survive.
        const components = mergeYouTubeControls(message.components?.map(component => component.toJSON()) ?? [], presentation.controls);
        if (!components) throw new Error('No space for YouTube controls.');
        await message.edit({ components, allowedMentions: { parse: [], users: [], roles: [], repliedUser: false } });
        return this.publication(entry, presentation.controls);
      } catch (error) {
        this.report(error);
        await this.removeEntry(entry).catch(error => this.report(error));
        return null;
      }
    });
  }

  sweep(): Promise<void> {
    return this.serialize(async () => {
      const next = new Map(this.values);
      const failures: { entry: ExpiryRecord; error: unknown; terminal: boolean }[] = [];
      for (const entry of this.values.values()) {
        if (entry.expiresAt > this.now()) continue;
        let error: unknown;
        if (await this.clean(entry, failure => { error = failure; })) next.delete(entry.messageId);
        else {
          const terminal = this.now() - entry.expiresAt > CLEANUP_RETRY_MS;
          if (terminal) next.delete(entry.messageId);
          failures.push({ entry, error, terminal });
        }
      }
      try { if (next.size !== this.values.size) await this.save(next); }
      finally {
        // A failed journal write retains retry state; never claim durable retirement before saving it.
        for (const failure of failures) this.report(failure.error, failure.terminal && !this.values.has(failure.entry.messageId));
      }
    });
  }

  start(): void {
    if (this.timer) return;
    void this.sweep().catch(error => this.report(error));
    this.timer = setInterval(() => { void this.sweep().catch(error => this.report(error)); }, 60 * 60_000);
    this.timer.unref();
  }

  stop(): void { clearInterval(this.timer); this.timer = undefined; }
}
