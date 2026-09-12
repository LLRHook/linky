import { readFileSync } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { MessageFlags, type InteractionDeferReplyOptions, type InteractionEditReplyOptions, type InteractionReplyOptions } from 'discord.js';

export const REMOVE_REPOST_CUSTOM_ID = 'linky:remove';
export const REPOST_RETENTION_MS = 30 * 24 * 60 * 60_000;
const ID = /^[1-9]\d{16,19}$/;
const CAPACITY = 10_000;
const FIELDS = ['guildId', 'channelId', 'sourceId', 'replacementId', 'authorId', 'mode'];

export interface RepostRecord {
  guildId: string;
  channelId: string;
  sourceId: string;
  replacementId: string;
  authorId: string;
  mode: 'reply' | 'replace';
}

export interface SourceMessage {
  id: string;
  channelId: string;
  guildId: string | null;
  author?: { id: string; bot?: boolean } | null;
  content?: string | null;
  partial?: boolean;
  editedTimestamp?: number | null;
  flags?: { bitfield: number };
  attachments?: { values(): IterableIterator<{ id: string; name?: string | null; size?: number; description?: string | null; spoiler?: boolean }> };
}

export interface RepostMessage extends SourceMessage {
  author: { id: string; bot?: boolean };
  delete(): Promise<unknown>;
}

/** A changed source cancels this delivery while retaining its durable refresh job. */
export type RepostRefreshResult = void | 'retry';
type Regenerate = (source: RepostMessage) => Promise<RepostRefreshResult>;

export interface RepostInteraction {
  customId: string;
  guildId: string | null;
  channelId: string | null;
  user: { id: string };
  message: { id: string; author: { id: string } };
  deferred?: boolean;
  replied?: boolean;
  deferReply(options: InteractionDeferReplyOptions): Promise<unknown>;
  reply(options: InteractionReplyOptions): Promise<unknown>;
  editReply(options: InteractionEditReplyOptions): Promise<unknown>;
}

interface Options {
  path: string;
  botUserId: string;
  /** Fetch from Discord, without accepting a message/channel ID from a button payload. */
  fetchMessage(channelId: string, messageId: string): Promise<RepostMessage | null>;
  /** Fetch the member and channel permissions fresh; never use cached interaction permissions. */
  canManageMessages(record: RepostRecord, userId: string): Promise<boolean>;
  removeRelated?: (record: RepostRecord) => Promise<void>;
  regenerate?: Regenerate;
  now?: () => number;
  write?: (path: string, value: string) => Promise<void>;
  onError?: (error: Error) => void;
}

interface Journal { records: RepostRecord[]; remove: string[]; refresh: string[] }
const createdAt = (id: string) => Number(BigInt(id) >> 22n) + 1_420_070_400_000;
const missing = (error: unknown) => {
  const failure = error as { code?: number; status?: number } | null;
  return [10003, 10008].includes(failure?.code ?? 0) || failure?.status === 404;
};
const sameSource = (record: RepostRecord, source: SourceMessage) =>
  record.sourceId === source.id && record.guildId === source.guildId && record.channelId === source.channelId;

function validRecord(value: unknown): value is RepostRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === FIELDS.length && Object.keys(record).every(key => FIELDS.includes(key)) &&
    FIELDS.slice(0, 5).every(key => typeof record[key] === 'string' && ID.test(record[key])) &&
    record.sourceId !== record.replacementId && (record.mode === 'reply' || record.mode === 'replace');
}

async function atomicWrite(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await unlink(temporary).catch(() => {}); }
}

function changed(before: SourceMessage, after: SourceMessage, record: RepostRecord): boolean {
  if (before.partial || typeof before.content !== 'string') {
    return (after.editedTimestamp ?? 0) > createdAt(record.replacementId);
  }
  // A queued older edit can arrive after regeneration already copied a newer source.
  if (before.content !== after.content && after.editedTimestamp != null && after.editedTimestamp <= createdAt(record.replacementId)) return false;
  const version = (message: SourceMessage) => JSON.stringify({
    content: message.content,
    flags: (message.flags?.bitfield ?? 0) & ~MessageFlags.ShouldShowLinkNotDiscordWarning,
    attachments: [...(message.attachments?.values() ?? [])].map(a => [a.id, a.name, a.size, a.description, a.spoiler]),
  });
  return version(before) !== version(after);
}

/** Durable ownership and retry intents; never stores message text or API data. */
export class RepostRegistry {
  private journal: Journal = { records: [], remove: [], refresh: [] };
  private pending: Promise<unknown> = Promise.resolve();
  private sources = new Map<string, Promise<unknown>>();
  private timer?: ReturnType<typeof setInterval>;
  private sweepPending?: Promise<void>;
  private cursor = 0;
  private pendingCursor = 0;
  private readonly path: string;
  private readonly now: () => number;

  constructor(private readonly options: Options) {
    if (!ID.test(options.botUserId)) throw new Error('Repost ownership requires a Discord bot ID.');
    this.path = resolve(options.path);
    this.now = options.now ?? Date.now;
    let saved: unknown;
    try { saved = JSON.parse(readFileSync(this.path, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error('Could not load repost ownership records.');
    }
    const data = saved as Journal;
    if (!data || typeof data !== 'object' || Object.keys(data).sort().join(',') !== 'records,refresh,remove' ||
      !Array.isArray(data.records) || data.records.length > CAPACITY || !data.records.every(validRecord) ||
      !Array.isArray(data.remove) || !Array.isArray(data.refresh) ||
      new Set(data.records.map(r => r.replacementId)).size !== data.records.length ||
      new Set(data.records.map(r => r.sourceId)).size !== data.records.length ||
      [data.remove, data.refresh].some(ids => ids.length > CAPACITY || new Set(ids).size !== ids.length ||
        ids.some(id => !data.records.some(r => r.replacementId === id))) ||
      data.refresh.some(id => data.records.find(r => r.replacementId === id)?.mode !== 'reply')) {
      throw new Error('Invalid repost ownership records.');
    }
    this.journal = data;
  }

  private async change<T>(update: (next: Journal) => T): Promise<T> {
    const operation = this.pending.then(async () => {
      const next: Journal = { records: this.journal.records.map(r => ({ ...r })), remove: [...this.journal.remove], refresh: [...this.journal.refresh] };
      const result = update(next);
      if (JSON.stringify(next) !== JSON.stringify(this.journal)) {
        await (this.options.write ?? atomicWrite)(this.path, JSON.stringify(next) + '\n');
        this.journal = next;
      }
      return result;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }

  private async forSource<T>(sourceId: string, operation: () => Promise<T>): Promise<T> {
    const task = (this.sources.get(sourceId) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.sources.set(sourceId, task);
    try { return await task; }
    finally { if (this.sources.get(sourceId) === task) this.sources.delete(sourceId); }
  }

  private report(): void {
    try { this.options.onError?.(new Error('Repost ownership or cleanup failed; pending work will be retried.')); }
    catch { /* Reporting must not interrupt durable cleanup. */ }
  }

  private drop(next: Journal, id: string): void {
    next.records = next.records.filter(r => r.replacementId !== id);
    next.remove = next.remove.filter(value => value !== id);
    next.refresh = next.refresh.filter(value => value !== id);
  }

  private prune(next: Journal): void {
    for (const record of next.records) {
      if (createdAt(record.replacementId) + REPOST_RETENTION_MS <= this.now() &&
        !next.remove.includes(record.replacementId) && !next.refresh.includes(record.replacementId)) this.drop(next, record.replacementId);
    }
  }

  findBySource(sourceId: string): RepostRecord | undefined {
    const record = this.journal.records.find(r => r.sourceId === sourceId);
    return record && { ...record };
  }

  findByReplacement(replacementId: string): RepostRecord | undefined {
    const record = this.journal.records.find(r => r.replacementId === replacementId);
    return record && { ...record };
  }

  async remember(record: RepostRecord): Promise<boolean> {
    if (!validRecord(record) || record.authorId === this.options.botUserId) return false;
    const copy = { ...record };
    try {
      return await this.change(next => {
        this.prune(next);
        const existing = next.records.find(r => r.sourceId === copy.sourceId || r.replacementId === copy.replacementId);
        if (existing) {
          if (FIELDS.every(key => existing[key as keyof RepostRecord] === copy[key as keyof RepostRecord])) return true;
          if (existing.sourceId !== copy.sourceId || existing.replacementId === copy.replacementId ||
            existing.guildId !== copy.guildId || existing.channelId !== copy.channelId || existing.authorId !== copy.authorId ||
            copy.mode !== 'reply' || !next.refresh.includes(existing.replacementId) || next.remove.includes(existing.replacementId)) return false;
          this.drop(next, existing.replacementId);
          // Keep recovery durable until the handler confirms this new reply is current.
          next.refresh.push(copy.replacementId);
          next.remove.push(copy.replacementId);
        }
        if (next.records.length >= CAPACITY) return false;
        next.records.push(copy);
        return true;
      });
    } catch { this.report(); return false; }
  }

  forget(replacementId: string): Promise<void> {
    return this.change(next => {
      // Discord emits MessageDelete for our own stale-reply cleanup too. Keep its regeneration intent.
      if (next.refresh.includes(replacementId)) next.remove = next.remove.filter(id => id !== replacementId);
      else this.drop(next, replacementId);
    });
  }

  private async reply(interaction: RepostInteraction, content: string): Promise<void> {
    const options = { content, allowedMentions: { parse: [] as never[] } };
    if (interaction.deferred || interaction.replied) await interaction.editReply(options);
    else await interaction.reply({ ...options, flags: MessageFlags.Ephemeral });
  }

  /** Also shared by Retry. Recognized interactions are deferred privately before network checks. */
  async authorize(interaction: RepostInteraction): Promise<RepostRecord | null> {
    const record = this.findByReplacement(interaction.message.id);
    if (!record || !['linky:remove', 'linky:retry'].includes(interaction.customId) ||
      record.guildId !== interaction.guildId || record.channelId !== interaction.channelId ||
      interaction.message.author.id !== this.options.botUserId || !ID.test(interaction.user.id)) {
      await this.reply(interaction, 'This is not a registered Linky repost.');
      return null;
    }
    if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      if (interaction.user.id !== record.authorId && !await this.options.canManageMessages(record, interaction.user.id)) {
        await this.reply(interaction, 'Only the original author or someone with Manage Messages here can do that.');
        return null;
      }
      const message = await this.options.fetchMessage(record.channelId, record.replacementId);
      if (!message || !this.owned(message, record)) {
        await this.reply(interaction, 'This Linky repost is no longer available.');
        return null;
      }
      return record;
    } catch {
      await this.reply(interaction, 'Could not verify this repost or your permissions. Try again.');
      return null;
    }
  }

  private owned(message: RepostMessage, record: RepostRecord): boolean {
    return message.id === record.replacementId && message.channelId === record.channelId &&
      message.guildId === record.guildId && message.author.id === this.options.botUserId;
  }

  private schedule(record: RepostRecord, refresh: boolean): Promise<void> {
    return this.change(next => {
      if (!next.records.some(r => r.replacementId === record.replacementId)) return;
      if (!next.remove.includes(record.replacementId)) next.remove.push(record.replacementId);
      if (refresh && !next.refresh.includes(record.replacementId)) next.refresh.push(record.replacementId);
      if (!refresh) next.refresh = next.refresh.filter(id => id !== record.replacementId);
    });
  }

  private async process(sourceId: string, regenerate = this.options.regenerate): Promise<boolean> {
    const record = this.findBySource(sourceId);
    if (!record) return true;
    const id = record.replacementId;
    if (this.journal.remove.includes(id)) {
      let message: RepostMessage | null;
      try {
        message = await this.options.fetchMessage(record.channelId, id);
      } catch (error) { if (missing(error)) message = null; else { this.report(); return false; } }
      if (message && !this.owned(message, record)) { this.report(); return false; }
      try { await this.options.removeRelated?.({ ...record }); }
      catch { this.report(); return false; }
      try { if (message) await message.delete(); }
      catch (error) { if (!missing(error)) { this.report(); return false; } }
      await this.change(next => {
        next.remove = next.remove.filter(value => value !== id);
        if (!next.refresh.includes(id)) this.drop(next, id);
      });
    }
    if (this.journal.refresh.includes(id)) {
      if (!regenerate) { this.report(); return false; }
      try {
        const source = await this.options.fetchMessage(record.channelId, record.sourceId);
        if (source && sameSource(record, source) && source.author.id === record.authorId && typeof source.content === 'string') {
          if (await regenerate(source) === 'retry') return false;
        }
        else if (source) { this.report(); return false; }
      } catch (error) { if (!missing(error)) { this.report(); return false; } }
      await this.change(next => {
        const current = next.records.find(entry => entry.sourceId === sourceId);
        if (current && current.replacementId !== id && next.refresh.includes(current.replacementId)) {
          next.refresh = next.refresh.filter(value => value !== current.replacementId);
          next.remove = next.remove.filter(value => value !== current.replacementId);
        }
        this.drop(next, id);
      });
    }
    return true;
  }

  async handleRemove(interaction: RepostInteraction): Promise<boolean> {
    if (interaction.customId !== REMOVE_REPOST_CUSTOM_ID) return false;
    const record = await this.authorize(interaction);
    if (!record) return true;
    try {
      const removed = await this.forSource(record.sourceId, async () => {
        const current = this.findByReplacement(record.replacementId);
        if (!current) return true;
        await this.schedule(current, false);
        return this.process(current.sourceId);
      });
      await this.reply(interaction, removed ? 'Removed Linky’s repost.' :
        'Could not remove the repost yet. Linky will retry.');
    } catch { this.report(); await this.reply(interaction, 'Could not save this removal. Try again.'); }
    return true;
  }

  /** The caller must authorize the button first. Recheck ownership after taking the source lock. */
  async retry(record: RepostRecord, regenerate: Regenerate): Promise<boolean> {
    if (!validRecord(record) || record.mode !== 'reply') return false;
    const authorized = { ...record };
    return this.forSource(record.sourceId, async () => {
      const current = this.findByReplacement(authorized.replacementId);
      if (!current || !FIELDS.every(key => current[key as keyof RepostRecord] === authorized[key as keyof RepostRecord])) return false;
      try {
        // Keep the existing notice when the source cannot be fetched or no longer matches.
        const source = await this.options.fetchMessage(current.channelId, current.sourceId);
        if (!source || !sameSource(current, source) || source.author.id !== current.authorId || typeof source.content !== 'string') return false;
        await this.schedule(current, true);
        return await this.process(current.sourceId, regenerate);
      } catch { this.report(); return false; }
    });
  }

  handleReplacementDelete(message: SourceMessage): Promise<void> {
    const record = this.findByReplacement(message.id);
    if (!record || record.channelId !== message.channelId || record.guildId !== message.guildId ||
      (message.author && message.author.id !== this.options.botUserId)) return Promise.resolve();
    return this.forSource(record.sourceId, async () => {
      const current = this.findByReplacement(message.id);
      if (!current) return;
      // Self-generated deletion events must leave an existing regeneration job intact.
      await this.schedule(current, this.journal.refresh.includes(current.replacementId));
      await this.process(current.sourceId);
    });
  }

  handleSourceDelete(source: SourceMessage): Promise<void> {
    return this.forSource(source.id, async () => {
      const record = this.findBySource(source.id);
      if (!record || record.mode !== 'reply' || !sameSource(record, source)) return;
      await this.schedule(record, false);
      await this.process(source.id);
    });
  }

  handleSourceUpdate(before: SourceMessage, after: SourceMessage, regenerate: Regenerate): Promise<void> {
    return this.forSource(after.id, async () => {
      const record = this.findBySource(after.id);
      if (!record || record.mode !== 'reply' || !sameSource(record, before) || !sameSource(record, after) ||
        after.author?.id !== record.authorId || (!this.journal.refresh.includes(record.replacementId) && !changed(before, after, record))) return;
      await this.schedule(record, true);
      await this.process(after.id, regenerate);
    });
  }

  sweep(): Promise<void> {
    if (this.sweepPending) return this.sweepPending;
    const operation = (async () => {
      await this.change(next => this.prune(next));
      const records = this.journal.records;
      const pending = records.filter(r => this.journal.remove.includes(r.replacementId) || this.journal.refresh.includes(r.replacementId));
      const ordinary = records.filter(r => r.mode === 'reply' && !pending.includes(r));
      const take = (entries: RepostRecord[], offset: number, count: number) =>
        Array.from({ length: Math.min(entries.length, count) }, (_, i) => entries[(offset + i) % entries.length]);
      const retries = take(pending, this.pendingCursor, ordinary.length ? 50 : 100);
      const checks = take(ordinary, this.cursor, 100 - retries.length);
      this.pendingCursor = (this.pendingCursor + retries.length) % Math.max(1, pending.length);
      this.cursor = (this.cursor + checks.length) % Math.max(1, ordinary.length);
      const selected = [...retries, ...checks];
      for (const record of selected) await this.forSource(record.sourceId, async () => {
        const current = this.findByReplacement(record.replacementId);
        if (!current) return;
        try {
          if (!this.journal.remove.includes(current.replacementId) && !this.journal.refresh.includes(current.replacementId)) {
            let source: RepostMessage | null;
            try { source = await this.options.fetchMessage(current.channelId, current.sourceId); }
            catch (error) { if (missing(error)) source = null; else throw error; }
            if (!source) await this.schedule(current, false);
            else if (sameSource(current, source) && source.author.id === current.authorId &&
              (source.editedTimestamp ?? 0) > createdAt(current.replacementId)) await this.schedule(current, true);
          }
          await this.process(current.sourceId);
        } catch { this.report(); }
      });
    })();
    this.sweepPending = operation.finally(() => { this.sweepPending = undefined; });
    return this.sweepPending;
  }

  start(): void {
    if (this.timer) return;
    void this.sweep().catch(() => this.report());
    this.timer = setInterval(() => { void this.sweep().catch(() => this.report()); }, 5 * 60_000);
    this.timer.unref();
  }

  stop(): void { clearInterval(this.timer); this.timer = undefined; }
}
