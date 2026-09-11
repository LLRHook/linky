import { readFileSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { REWRITE_PLATFORMS, type RewritePlatform } from './SocialLinkService';

export interface ServerPreferences {
  mode?: 'replace' | 'reply';
  platforms?: Partial<Record<RewritePlatform, boolean>>;
  translateTweets?: boolean;
}

type ServerRecord = ServerPreferences & { enabled?: boolean };
const DISCORD_ID = /^[1-9]\d{16,19}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function parseRecord(value: unknown, allowEnabled: boolean): ServerRecord {
  const fields = ['mode', 'platforms', 'translateTweets', ...(allowEnabled ? ['enabled'] : [])];
  if (!isRecord(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !fields.includes(key))) {
    throw new Error('Unknown server preference fields.');
  }
  const result: ServerRecord = {};
  if (Object.hasOwn(value, 'enabled')) {
    if (typeof value.enabled !== 'boolean') throw new Error('Server enablement must be a boolean.');
    result.enabled = value.enabled;
  }
  if (Object.hasOwn(value, 'mode')) {
    if (value.mode !== 'replace' && value.mode !== 'reply') throw new Error('Server mode must be replace or reply.');
    result.mode = value.mode;
  }
  if (Object.hasOwn(value, 'translateTweets')) {
    if (typeof value.translateTweets !== 'boolean') throw new Error('Tweet translation must be a boolean.');
    result.translateTweets = value.translateTweets;
  }
  if (Object.hasOwn(value, 'platforms')) {
    const platforms = value.platforms;
    if (!isRecord(platforms) || Reflect.ownKeys(platforms).some(key =>
      typeof key !== 'string' || !(REWRITE_PLATFORMS as readonly string[]).includes(key) || typeof platforms[key] !== 'boolean')) {
      throw new Error('Server platforms must contain known platform names and booleans.');
    }
    result.platforms = { ...platforms };
  }
  return result;
}

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
  private values = new Map<string, ServerRecord>();
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
    try {
      if (!isRecord(saved)) throw new Error('Expected a JSON object.');
      this.values = new Map(Object.entries(saved).map(([id, value]) => {
        if (!DISCORD_ID.test(id)) throw new Error('Invalid Discord server ID.');
        return [id, typeof value === 'boolean' ? { enabled: value } : parseRecord(value, true)];
      }));
    } catch (cause) {
      throw new Error(`Invalid server settings at ${this.path}: expected server IDs with booleans or preference records.`, { cause });
    }
  }

  get(serverId: string): boolean | undefined {
    return this.values.get(serverId)?.enabled;
  }

  getPreferences(serverId: string): ServerPreferences {
    const { enabled: _enabled, ...preferences } = this.values.get(serverId) ?? {};
    return { ...preferences, ...(preferences.platforms ? { platforms: { ...preferences.platforms } } : {}) };
  }

  set(serverId: string, enabled: boolean): Promise<void> {
    if (typeof serverId !== 'string' || !DISCORD_ID.test(serverId) || typeof enabled !== 'boolean') {
      return Promise.reject(new Error('Server settings require a Discord server ID and a boolean.'));
    }
    return this.change(serverId, previous => ({ ...previous, enabled }));
  }

  update(serverId: string, patch: ServerPreferences): Promise<void> {
    let preferences: ServerPreferences;
    try {
      if (typeof serverId !== 'string' || !DISCORD_ID.test(serverId)) throw new Error('Server settings require a Discord server ID.');
      preferences = parseRecord(patch, false);
    } catch (err) {
      return Promise.reject(err);
    }
    return this.change(serverId, previous => ({
      ...previous, ...preferences,
      ...(preferences.platforms ? { platforms: { ...previous.platforms, ...preferences.platforms } } : {}),
    }));
  }

  private change(serverId: string, update: (previous: ServerRecord) => ServerRecord): Promise<void> {
    const saved = this.pending.then(async () => {
      const next = new Map(this.values).set(serverId, update(this.values.get(serverId) ?? {}));
      const serializable = Object.fromEntries([...next].map(([id, record]) =>
        [id, Object.keys(record).length === 1 && record.enabled !== undefined ? record.enabled : record]));
      await this.write(this.path, `${JSON.stringify(serializable, null, 2)}\n`);
      this.values = next;
    });
    this.pending = saved.catch(() => {});
    return saved;
  }
}
