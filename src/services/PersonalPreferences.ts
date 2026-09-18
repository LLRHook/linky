import { closeSync, openSync, readSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

const DISCORD_ID = /^[1-9]\d{16,19}$/;
export const PERSONAL_PREFERENCE_LIMIT = 10_000;
const MAX_FILE_BYTES = 1024 * 1024;

function readPreferences(path: string): unknown {
  const file = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    for (;;) {
      const count = readSync(file, buffer, length, buffer.length - length, null);
      length += count;
      if (length > MAX_FILE_BYTES) throw new Error('Personal preference file exceeds the size limit.');
      if (!count) break;
    }
    return JSON.parse(buffer.subarray(0, length).toString('utf8')) as unknown;
  } finally { closeSync(file); }
}

function checkCapacity(values: Map<string, Set<string>>): void {
  let records = 0;
  for (const users of values.values()) records += users.size;
  if (records > PERSONAL_PREFERENCE_LIMIT) throw new Error('Personal preference record limit reached; existing choices were retained.');
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

/** Only opted-out server/account IDs are retained. Re-enabling or removing the bot deletes them. */
export class PersonalPreferences {
  private values = new Map<string, Set<string>>();
  private pending = Promise.resolve();
  private readonly path: string;

  constructor(path: string, private readonly write = atomicWrite) {
    this.path = resolve(path);
    let saved: unknown;
    try { saved = readPreferences(this.path); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error('Could not load personal auto-fix preferences.', { cause });
    }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Invalid personal auto-fix preferences.');
    for (const [guildId, users] of Object.entries(saved)) {
      if (!DISCORD_ID.test(guildId) || !Array.isArray(users) || !users.length ||
          users.some(id => typeof id !== 'string' || !DISCORD_ID.test(id)) || new Set(users).size !== users.length) {
        throw new Error('Invalid personal auto-fix preferences.');
      }
      this.values.set(guildId, new Set(users));
    }
    checkCapacity(this.values);
  }

  /** Read current durable state again before publishing or removing an automatic replacement. */
  isOptedOut(guildId: string, userId: string): boolean {
    return this.values.get(guildId)?.has(userId) ?? false;
  }

  setOptedOut(guildId: string, userId: string, optedOut: boolean): Promise<void> {
    if (typeof guildId !== 'string' || !DISCORD_ID.test(guildId) || typeof userId !== 'string' ||
        !DISCORD_ID.test(userId) || typeof optedOut !== 'boolean') {
      return Promise.reject(new Error('Personal preferences require Discord server/account IDs and a boolean.'));
    }
    return this.change(next => {
      if ((next.get(guildId)?.has(userId) ?? false) === optedOut) return false;
      const users = new Set(next.get(guildId));
      if (optedOut) users.add(userId); else users.delete(userId);
      if (users.size) next.set(guildId, users); else next.delete(guildId);
      return true;
    });
  }

  removeGuild(guildId: string): Promise<void> {
    if (typeof guildId !== 'string' || !DISCORD_ID.test(guildId)) return Promise.reject(new Error('Invalid Discord server ID.'));
    return this.change(next => next.delete(guildId));
  }

  /** Remove records for guilds the bot left while offline, using the complete ready-time guild list. */
  retainGuilds(guildIds: Iterable<string>): Promise<void> {
    const retained = new Set(guildIds);
    if ([...retained].some(id => typeof id !== 'string' || !DISCORD_ID.test(id))) {
      return Promise.reject(new Error('Invalid Discord server IDs.'));
    }
    return this.change(next => {
      let changed = false;
      for (const guildId of next.keys()) if (!retained.has(guildId)) { next.delete(guildId); changed = true; }
      return changed;
    });
  }

  /** Wait for already queued writes before shutdown. Individual failures are reported to their callers. */
  flush(): Promise<void> { return this.pending; }

  private change(update: (next: Map<string, Set<string>>) => boolean): Promise<void> {
    const saved = this.pending.then(async () => {
      const next = new Map(this.values);
      if (!update(next)) return;
      checkCapacity(next);
      const content = `${JSON.stringify(Object.fromEntries([...next].map(([guild, users]) => [guild, [...users]])), null, 2)}\n`;
      if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('Personal preference file exceeds the size limit.');
      await this.write(this.path, content);
      this.values = next;
    });
    this.pending = saved.catch(() => {});
    return saved;
  }
}
