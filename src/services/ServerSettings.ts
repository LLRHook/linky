import { readFileSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

async function atomicWrite(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

/** Explicit server choices override the operator's channel/server allowlists. */
export class ServerSettings {
  private values = new Map<string, boolean>();
  private pending = Promise.resolve();
  private readonly path: string;

  constructor(path: string, private readonly write = atomicWrite) {
    this.path = resolve(path);
    let saved: unknown;
    try {
      saved = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error(`Could not load server settings at ${this.path}`, { cause: err });
    }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved) ||
        Object.entries(saved).some(([id, enabled]) => !/^[1-9]\d{16,19}$/.test(id) || typeof enabled !== 'boolean')) {
      throw new Error(`Invalid server settings at ${this.path}: expected a JSON object of server IDs and booleans.`);
    }
    this.values = new Map(Object.entries(saved));
  }

  get(serverId: string): boolean | undefined {
    return this.values.get(serverId);
  }

  set(serverId: string, enabled: boolean): Promise<void> {
    if (!/^[1-9]\d{16,19}$/.test(serverId) || typeof enabled !== 'boolean') {
      return Promise.reject(new Error('Server settings require a Discord server ID and a boolean.'));
    }
    const saved = this.pending.then(async () => {
      const next = new Map(this.values).set(serverId, enabled);
      await this.write(this.path, `${JSON.stringify(Object.fromEntries(next), null, 2)}\n`);
      this.values = next;
    });
    this.pending = saved.catch(() => {});
    return saved;
  }
}
