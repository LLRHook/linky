import { readFileSync, renameSync } from 'node:fs';
import { atomicWrite } from './AtomicWrite';
import { DISCORD_ID } from './LinkConfiguration';
import type { ReplyCleanupTarget } from './ReplyThreads';

/** Retry manual reply cleanup without storing provider content or touching the repost registry. */
export class ReplyCleanupJournal {
  private entries: ReplyCleanupTarget[] = [];
  private held = new Set<string>();
  private completed = new Map<string, number>();
  private cursor = 0;
  private pending = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly path: string, private readonly cleanup: (entry: ReplyCleanupTarget) => Promise<void>,
    private readonly onError: (reason?: string) => void, private readonly write = atomicWrite) {
    try {
      const saved: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!Array.isArray(saved) || saved.length > 10_000 || saved.some(entry => !entry ||
          Object.keys(entry).length !== 3 || !['guildId', 'channelId', 'threadId'].every(key => typeof entry[key] === 'string' && DISCORD_ID.test(entry[key])))) {
        throw new Error('Invalid replies cleanup journal');
      }
      this.entries = saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        try {
          renameSync(path, `${path}.corrupt-${Date.now()}`);
          this.onError('Invalid replies cleanup journal quarantined; starting with empty cleanup intent');
        }
        catch { this.onError('Could not quarantine replies cleanup journal; starting with empty cleanup intent'); }
      }
    }
  }
  private serialize(run: () => Promise<void>): Promise<void> {
    const result = this.pending.then(run); this.pending = result.catch(() => {}); return result;
  }
  private async save(entries: ReplyCleanupTarget[]) {
    await this.write(this.path, JSON.stringify(entries) + '\n'); this.entries = entries;
  }
  /** Reserved or queued parents cannot start related resources while removal is pending. */
  has(threadId: string): boolean { return this.entries.some(entry => entry.threadId === threadId); }
  private async store(entry: ReplyCleanupTarget) {
    if (this.has(entry.threadId)) return true;
    if (this.entries.length >= 10_000) { this.onError('Replies cleanup journal is full; new cleanup was dropped'); return false; }
    await this.save([...this.entries, { ...entry }]);
    return true;
  }
  /** Persist intent before deletion and hold it until deletion is confirmed by enqueue. */
  reserve(entry: ReplyCleanupTarget): Promise<void> {
    return this.serialize(async () => {
      if (this.wasCompleted(entry.threadId) || !await this.store(entry)) return;
      this.held.add(entry.threadId);
    });
  }
  /** A settled parent deletion can be reconciled by the next sweep, even if its request rejected. */
  release(threadId: string): Promise<void> {
    return this.serialize(async () => { this.held.delete(threadId); });
  }
  /** Transfer failed registry cleanup durably without waiting for another Discord attempt. */
  defer(entry: ReplyCleanupTarget): Promise<void> {
    return this.serialize(async () => {
      if (!this.wasCompleted(entry.threadId) && !await this.store(entry)) throw new Error('Replies cleanup transfer refused');
    });
  }
  enqueue(entry: ReplyCleanupTarget): Promise<void> {
    return this.serialize(async () => {
      if (this.wasCompleted(entry.threadId) || !await this.store(entry)) return;
      this.held.delete(entry.threadId);
      await this.drain([entry]);
    });
  }
  private wasCompleted(id: string): boolean {
    const completedAt = this.completed.get(id);
    return completedAt !== undefined && completedAt > Date.now() - 600_000;
  }
  private async drain(entries: ReplyCleanupTarget[]) {
    for (const entry of entries) {
      if (this.held.has(entry.threadId)) continue;
      try {
        await this.cleanup(entry);
        await this.save(this.entries.filter(value => value.threadId !== entry.threadId));
        if (this.completed.size >= 10_000) this.completed.delete(this.completed.keys().next().value!);
        this.completed.set(entry.threadId, Date.now());
      } catch { this.onError(); }
    }
  }
  sweep(): Promise<void> {
    return this.serialize(async () => {
      const entries = Array.from({ length: Math.min(50, this.entries.length) }, (_, index) => this.entries[(this.cursor + index) % this.entries.length]);
      const nextId = this.entries[(this.cursor + entries.length) % this.entries.length]?.threadId;
      await this.drain(entries);
      this.cursor = nextId ? Math.max(0, this.entries.findIndex(entry => entry.threadId === nextId)) : 0;
    });
  }
  start(): void {
    void this.sweep().catch(() => this.onError());
    this.timer ??= setInterval(() => { void this.sweep().catch(() => this.onError()); }, 60_000);
    this.timer.unref();
  }
  stop(): void { clearInterval(this.timer); this.timer = undefined; }
}
