import { readFileSync, renameSync, statSync } from 'node:fs';
import { atomicWrite } from './AtomicWrite';
import { DISCORD_ID } from './LinkConfiguration';

// 100 days at 1,000 new parent IDs/day across the bot. Eviction is by message age.
const CAPACITY = 100_000;
const MAX_BYTES = 2_400_002;

/** IDs only: reserve durably before Discord creation, retaining moderator decisions across restart. */
export class ReplyCreationHistory {
  private ids = new Set<string>();
  private blocked = false;
  private retryAt = 0;
  private pending = Promise.resolve();
  constructor(private readonly path?: string, private readonly warn: (reason: string) => void = () => {},
    private readonly io: { rename?: typeof renameSync; write?: typeof atomicWrite; now?: () => number } = {}) {
    if (!path) return;
    try {
      if (statSync(path).size > MAX_BYTES) throw Error('History exceeds byte limit');
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!Array.isArray(value) || value.length > CAPACITY || value.some(id => typeof id !== 'string' || !DISCORD_ID.test(id)))
        throw Error('Invalid reply creation history');
      this.ids = new Set(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      // Same corrupt-state recovery as ReplyCleanupJournal: quarantine, warn, start empty.
      try {
        (io.rename ?? renameSync)(path, `${path}.corrupt-${Date.now()}`);
        this.warn('Invalid reply creation history quarantined; older moderator deletions may no longer be remembered');
      } catch {
        this.blocked = true;
        this.warn('Could not quarantine reply creation history; new reply creation disabled for this process run');
      }
    }
  }
  has(id: string): boolean { return this.ids.has(id); }
  canCreate(): boolean { return !this.blocked && (this.io.now ?? Date.now)() >= this.retryAt; }
  private async save(next: Set<string>): Promise<void> {
    if (this.path) {
      try { await (this.io.write ?? atomicWrite)(this.path, JSON.stringify([...next]) + '\n'); }
      catch {
        this.retryAt = (this.io.now ?? Date.now)() + 60_000;
        this.warn('Reply creation history could not be saved; pausing new creation for one minute');
        throw Error('Reply creation history unavailable');
      }
    }
    this.ids = next;
  }
  forget(id: string): Promise<void> {
    const result = this.pending.then(async () => {
      const next = new Set(this.ids); next.delete(id);
      // No creation was possible: recover in this process even if the old disk snapshot remains.
      try { await this.save(next); } finally { this.ids = next; }
    });
    this.pending = result.catch(() => {}); return result;
  }
  reserve(id: string): Promise<void> {
    const result = this.pending.then(async () => {
      if (this.path && !DISCORD_ID.test(id)) throw Error('Invalid reply parent ID');
      if (this.ids.has(id)) return;
      if (!this.canCreate()) throw Error('Reply creation history unavailable');
      const next = new Set(this.ids);
      next.add(id);
      if (next.size > CAPACITY) {
        // Snowflakes have equal-width numeric ordering after comparing their lengths.
        let oldest = id;
        for (const entry of next)
          if (entry.length < oldest.length || entry.length === oldest.length && entry < oldest) oldest = entry;
        if (oldest === id) return;
        next.delete(oldest);
        // An already evicted old post may create again, but never displaces newer decisions.
      }
      await this.save(next);
    });
    this.pending = result.catch(() => {});
    return result;
  }
}
