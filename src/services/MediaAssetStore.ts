import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, opendir, realpath, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const MAX_ASSET_BYTES = 24 * 1024 * 1024;
const MAX_METADATA_BYTES = 8192;
const MAX_DIRECTORY_ENTRIES = 16_384;
const ORPHAN_TTL_MS = 15 * 60_000;
const ID = /^[a-f0-9]{32}$/;
const MESSAGE_ID = /^[1-9]\d{16,19}$/;

export interface MediaAsset {
  id: string;
  size: number;
  sha256: string;
}

export interface MediaAssetStore {
  publish(bytes: Buffer): Promise<MediaAsset | null>;
  bind(id: string, discordMessageId: string): Promise<boolean>;
  release(discordMessageId: string): Promise<void>;
  get(id: string): Promise<(MediaAsset & { path: string }) | null>;
  close(): Promise<void>;
}

export interface MediaAssetStoreOptions {
  directory: string;
  maxBytes?: number;
  maxEntries?: number;
  clock?: () => number;
}

interface Record extends MediaAsset {
  version: 1;
  createdAt: number;
  messages: string[];
  deleting: boolean;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function inspect(path: string) {
  try { return await lstat(path); } catch (error) { if (missing(error)) return null; throw error; }
}

function parseRecord(value: unknown, id: string): Record | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record;
  if (Object.keys(record).sort().join(',') !== 'createdAt,deleting,id,messages,sha256,size,version' ||
      record.version !== 1 || record.id !== id || !ID.test(record.id) ||
      !Number.isSafeInteger(record.size) || record.size <= 0 || record.size > MAX_ASSET_BYTES ||
      typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256) ||
      !Number.isSafeInteger(record.createdAt) || record.createdAt < 0 ||
      typeof record.deleting !== 'boolean' || !Array.isArray(record.messages) || record.messages.length > 64 ||
      record.messages.some(message => typeof message !== 'string' || !MESSAGE_ID.test(message)) ||
      new Set(record.messages).size !== record.messages.length || (record.deleting && record.messages.length)) return null;
  return record;
}

/** Stores caller-validated complete MP4s. One store instance owns the dedicated directory. */
export async function createMediaAssetStore(options: MediaAssetStoreOptions): Promise<MediaAssetStore> {
  const directory = resolve(options.directory);
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024 * 1024;
  const maxEntries = options.maxEntries ?? 4096;
  const clock = options.clock ?? Date.now;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 ||
      !Number.isSafeInteger(maxEntries) || maxEntries <= 0 || maxEntries > 4096) throw Error('Invalid media store limits');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const initial = await lstat(directory);
  const canonical = await realpath(directory);
  const samePath = (left: string, right: string) => process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase() : left === right;
  if (!initial.isDirectory() || initial.isSymbolicLink() || !samePath(canonical, directory))
    throw Error('Unsafe media store directory');
  await chmod(directory, 0o700);

  const records = new Map<string, Record>();
  let admissionBlocked = false, mutationFailed = false, closed = false, usedBytes = 0, usedEntries = 0, sweepCursor = 0;
  let tail: Promise<void> = Promise.resolve();
  const mediaPath = (id: string) => join(directory, `${id}.mp4`);
  const metadataPath = (id: string) => join(directory, `${id}.json`);
  const publicAsset = ({ id, size, sha256 }: Record): MediaAsset => ({ id, size, sha256 });
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };

  async function safeDirectory(): Promise<boolean> {
    const info = await inspect(directory);
    return !!info && info.isDirectory() && !info.isSymbolicLink() &&
      info.dev === initial.dev && info.ino === initial.ino && samePath(await realpath(directory), canonical);
  }

  async function syncDirectory(): Promise<void> {
    // Windows does not support opening directories for fsync; production runs on Linux.
    if (process.platform === 'win32') return;
    const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }

  async function writeAtomic(path: string, bytes: Buffer | string): Promise<void> {
    const temporary = join(directory, `${randomBytes(16).toString('hex')}.tmp`);
    let created = false;
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, path);
      await syncDirectory();
    } finally {
      if (created) await unlink(temporary).catch(error => { if (!missing(error)) throw error; });
    }
  }

  async function persist(record: Record): Promise<void> {
    const content = JSON.stringify(record);
    if (Buffer.byteLength(content) > MAX_METADATA_BYTES) throw Error('Media metadata too large');
    await writeAtomic(metadataPath(record.id), content);
  }

  async function readRecord(id: string): Promise<Record | null> {
    const path = metadataPath(id), before = await inspect(path);
    if (!before?.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_METADATA_BYTES) return null;
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.dev !== before.dev || info.ino !== before.ino || info.size > MAX_METADATA_BYTES)
        return null;
      const bytes = Buffer.alloc(MAX_METADATA_BYTES + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_METADATA_BYTES) return null;
      return parseRecord(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')), id);
    } finally { await handle.close(); }
  }

  async function intact(record: Record): Promise<boolean> {
    const [media, metadata] = await Promise.all([inspect(mediaPath(record.id)), inspect(metadataPath(record.id))]);
    return !!media?.isFile() && !media.isSymbolicLink() && media.nlink === 1 && media.size === record.size &&
      !!metadata?.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1 && metadata.size <= MAX_METADATA_BYTES;
  }

  async function inventory(startup = false): Promise<void> {
    usedBytes = 0; usedEntries = 0;
    const entries = await opendir(directory);
    let count = 0;
    for await (const entry of entries) {
      if (++count > MAX_DIRECTORY_ENTRIES) { admissionBlocked = true; break; }
      const path = join(directory, entry.name), info = await inspect(path);
      if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1) { admissionBlocked = true; continue; }
      if (/^[a-f0-9]{32}\.tmp$/.test(entry.name) && startup) { await unlink(path); continue; }
      const match = /^([a-f0-9]{32})\.(mp4|json)$/.exec(entry.name);
      if (!match) { admissionBlocked = true; continue; }
      const [, id, extension] = match;
      if (extension === 'mp4') {
        usedBytes += info.size; usedEntries++;
        if (records.has(id) && records.get(id)!.size !== info.size) admissionBlocked = true;
        continue;
      }
      if (startup) {
        try {
          const record = await readRecord(id);
          if (record && records.size < 4096) records.set(id, record);
          else admissionBlocked = true;
        } catch { admissionBlocked = true; }
      } else if (!records.has(id) || info.size > MAX_METADATA_BYTES) admissionBlocked = true;
    }
  }

  async function erase(record: Record): Promise<void> {
    const media = await inspect(mediaPath(record.id)), metadata = await inspect(metadataPath(record.id));
    if ((media && (!media.isFile() || media.isSymbolicLink() || media.nlink !== 1 || media.size !== record.size)) ||
        !metadata?.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      admissionBlocked = true;
      return;
    }
    if (!record.deleting) {
      record = { ...record, messages: [], deleting: true };
      await persist(record);
      records.set(record.id, record);
    }
    if (media) await unlink(mediaPath(record.id));
    await unlink(metadataPath(record.id));
    await syncDirectory();
    records.delete(record.id);
  }

  async function sweep(limit = 32): Promise<void> {
    // A failed rename/fsync can have committed. Preserve files until recovery reloads durable state.
    if (mutationFailed) return;
    const values = [...records.values()];
    if (!values.length) return;
    const now = clock();
    for (let index = 0; index < Math.min(limit, values.length); index++) {
      const record = values[(sweepCursor + index) % values.length];
      if (record.deleting || (!record.messages.length && now - record.createdAt >= ORPHAN_TTL_MS)) await erase(record);
    }
    sweepCursor = (sweepCursor + Math.min(limit, values.length)) % values.length;
  }

  await inventory(true);
  for (const record of records.values()) {
    if (!record.deleting && !await intact(record)) admissionBlocked = true;
  }
  await sweep(4096);
  await inventory();
  const timer = setInterval(() => {
    void serial(async () => {
      if (!closed && await safeDirectory()) await sweep(128);
    }).catch(() => { admissionBlocked = mutationFailed = true; });
  }, 60_000);
  timer.unref();

  return {
    publish(bytes) {
      // Snapshot before the first await so callers cannot change bytes after validation/admission.
      if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_ASSET_BYTES || closed) return Promise.resolve(null);
      const content = Buffer.from(bytes);
      return serial(async () => {
        if (closed || mutationFailed || !await safeDirectory()) return null;
        try {
          await sweep();
          await inventory();
          if (admissionBlocked || usedEntries >= maxEntries || usedBytes + content.length > maxBytes) return null;
          let id: string;
          do { id = randomBytes(16).toString('hex'); }
          while (await inspect(mediaPath(id)) || await inspect(metadataPath(id)));
          const record: Record = { version: 1, id, size: content.length,
            sha256: createHash('sha256').update(content).digest('hex'), createdAt: clock(), messages: [], deleting: false };
          await writeAtomic(mediaPath(id), content);
          // A crash before metadata commits leaves an unindexed MP4 that remains quota-accounted.
          await persist(record);
          records.set(id, record);
          return publicAsset(record);
        } catch { admissionBlocked = mutationFailed = true; return null; }
      });
    },
    bind(id, discordMessageId) {
      return serial(async () => {
        if (closed || mutationFailed || !ID.test(id) || !MESSAGE_ID.test(discordMessageId) || !await safeDirectory()) return false;
        try {
          await sweep();
          const record = records.get(id);
          if (!record || record.deleting) return false;
          if (!await intact(record)) { admissionBlocked = true; return false; }
          if (!record.messages.length && clock() - record.createdAt >= ORPHAN_TTL_MS) { await erase(record); return false; }
          if (record.messages.includes(discordMessageId)) return true;
          if (record.messages.length === 64) return false;
          const updated = { ...record, messages: [...record.messages, discordMessageId] };
          await persist(updated);
          records.set(id, updated);
          return true;
        } catch { admissionBlocked = mutationFailed = true; return false; }
      });
    },
    release(discordMessageId) {
      return serial(async () => {
        if (closed || !MESSAGE_ID.test(discordMessageId)) return;
        if (mutationFailed) throw Error('Media store requires recovery after a write failure');
        if (!await safeDirectory()) throw Error('Unsafe media store directory');
        for (const record of records.values()) {
          if (!record.messages.includes(discordMessageId)) continue;
          if (!await intact(record)) throw Error('Unsafe media asset');
          const updated = { ...record, messages: record.messages.filter(message => message !== discordMessageId) };
          if (!updated.messages.length) await erase(updated);
          else { await persist(updated); records.set(record.id, updated); }
        }
        await sweep();
      }).catch(error => { admissionBlocked = mutationFailed = true; throw error; });
    },
    get(id) {
      return serial(async () => {
        if (closed || !ID.test(id) || !await safeDirectory()) return null;
        try {
          await sweep();
          const record = records.get(id);
          if (!record || record.deleting) return null;
          if (!await intact(record)) { admissionBlocked = true; return null; }
          if (!record.messages.length && clock() - record.createdAt >= ORPHAN_TTL_MS) {
            if (!mutationFailed) await erase(record);
            return null;
          }
          // Files are private to this process; get checks type/size without rehashing potentially 10 GiB on restart.
          return { ...publicAsset(record), path: mediaPath(id) };
        } catch { admissionBlocked = mutationFailed = true; return null; }
      });
    },
    async close() { closed = true; clearInterval(timer); await tail; },
  };
}
