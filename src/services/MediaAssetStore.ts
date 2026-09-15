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

export type MediaMime = 'video/mp4' | 'image/jpeg' | 'image/png';
export const mediaExtension = (mime: MediaMime = 'video/mp4'): 'mp4' | 'jpg' | 'png' =>
  mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : 'mp4';
export interface MediaAsset {
  id: string;
  size: number;
  sha256: string;
  mimeType?: MediaMime;
}

export interface MediaAssetStore {
  publish(bytes: Buffer, options?: { mimeType?: MediaMime }): Promise<MediaAsset | null>;
  reserve(id: string): Promise<string | null>;
  cancelReservation(token: string): void;
  bind(id: string, discordMessageId: string, reservation?: string): Promise<boolean>;
  unbind(id: string, discordMessageId: string): Promise<void>;
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
  version: 1 | 2;
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
  if (Object.keys(record).sort().join(',') !== (record.version === 2 ? 'createdAt,deleting,id,messages,mimeType,sha256,size,version' : 'createdAt,deleting,id,messages,sha256,size,version') ||
      ![1, 2].includes(record.version) || record.version === 2 && !['video/mp4', 'image/jpeg', 'image/png'].includes(record.mimeType ?? '') ||
      record.id !== id || !ID.test(record.id) ||
      !Number.isSafeInteger(record.size) || record.size <= 0 || record.size > MAX_ASSET_BYTES ||
      record.version === 2 && record.mimeType !== 'video/mp4' && record.size > 8 * 1024 * 1024 ||
      typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256) ||
      !Number.isSafeInteger(record.createdAt) || record.createdAt < 0 ||
      typeof record.deleting !== 'boolean' || !Array.isArray(record.messages) || record.messages.length > 64 ||
      record.messages.some(message => typeof message !== 'string' || !MESSAGE_ID.test(message)) ||
      new Set(record.messages).size !== record.messages.length || (record.deleting && record.messages.length)) return null;
  return record;
}

/** Stores caller-validated complete media. One store instance owns the dedicated directory. */
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
  const reservations = new Map<string, { id: string; expiresAt: number }>();
  const purgeReservations = () => { for (const [token, value] of reservations) if (value.expiresAt <= clock()) reservations.delete(token); };
  const reserved = (id: string) => [...reservations.values()].filter(value => value.id === id).length;
  let admissionBlocked = false, mutationFailed = false, closed = false, usedBytes = 0, usedEntries = 0, sweepCursor = 0;
  let tail: Promise<void> = Promise.resolve();
  const mediaPath = (id: string, mime = records.get(id)?.mimeType) => join(directory, `${id}.${mediaExtension(mime)}`);
  const metadataPath = (id: string) => join(directory, `${id}.json`);
  const publicAsset = ({ id, size, sha256, mimeType }: Record): MediaAsset => ({ id, size, sha256, ...(mimeType ? { mimeType } : {}) });
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
      const match = /^([a-f0-9]{32})\.(mp4|jpg|png|json)$/.exec(entry.name);
      if (!match) { admissionBlocked = true; continue; }
      const [, id, extension] = match;
      if (extension !== 'json') {
        usedBytes += info.size; usedEntries++;
        const record = records.get(id);
        if (record && (record.size !== info.size || extension !== mediaExtension(record.mimeType))) admissionBlocked = true;
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
    for (const [token, value] of reservations) if (value.id === record.id) reservations.delete(token);
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
    purgeReservations();
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
    publish(bytes, { mimeType = 'video/mp4' } = {}) {
      // Snapshot before the first await so callers cannot change bytes after validation/admission.
      if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_ASSET_BYTES || closed ||
          !['video/mp4', 'image/jpeg', 'image/png'].includes(mimeType) ||
          mimeType !== 'video/mp4' && bytes.length > 8 * 1024 * 1024) return Promise.resolve(null);
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
          const record: Record = { version: 2, mimeType, id, size: content.length,
            sha256: createHash('sha256').update(content).digest('hex'), createdAt: clock(), messages: [], deleting: false };
          await writeAtomic(mediaPath(id, mimeType), content);
          // A crash before metadata commits leaves an unindexed MP4 that remains quota-accounted.
          await persist(record);
          records.set(id, record);
          return publicAsset(record);
        } catch { admissionBlocked = mutationFailed = true; return null; }
      });
    },
    reserve(id) {
      return serial(async () => {
        purgeReservations();
        if (closed || mutationFailed || !ID.test(id) || reservations.size >= 128 || !await safeDirectory()) return null;
        await sweep();
        const record = records.get(id);
        if (!record || record.deleting || !await intact(record) || record.messages.length + reserved(id) >= 64) return null;
        const token = randomBytes(16).toString('hex');
        reservations.set(token, { id, expiresAt: clock() + 60_000 });
        return token;
      }).catch(() => null);
    },
    cancelReservation(token) { reservations.delete(token); },
    bind(id, discordMessageId, reservation) {
      return serial(async () => {
        if (closed || mutationFailed || !ID.test(id) || !MESSAGE_ID.test(discordMessageId) || !await safeDirectory()) return false;
        try {
          await sweep();
          const record = records.get(id);
          if (!record || record.deleting) return false;
          const lease = reservation ? reservations.get(reservation) : undefined;
          if (!await intact(record)) { admissionBlocked = true; return false; }
          if (!record.messages.length && clock() - record.createdAt >= ORPHAN_TTL_MS) { await erase(record); return false; }
          if (record.messages.includes(discordMessageId)) {
            if (reservation && lease?.id === id) reservations.delete(reservation);
            return true;
          }
          if (reservation && (!lease || lease.id !== id)) return false;
          if (record.messages.length + reserved(id) - (lease ? 1 : 0) >= 64) return false;
          const updated = { ...record, messages: [...record.messages, discordMessageId] };
          await persist(updated);
          records.set(id, updated);
          if (reservation) reservations.delete(reservation);
          return true;
        } catch { admissionBlocked = mutationFailed = true; return false; }
      });
    },
    unbind(id, discordMessageId) {
      return serial(async () => {
        if (closed || !ID.test(id) || !MESSAGE_ID.test(discordMessageId)) return;
        if (mutationFailed || !await safeDirectory()) throw Error('Media store requires recovery');
        const record = records.get(id);
        if (!record || !record.messages.includes(discordMessageId)) return;
        if (!await intact(record)) throw Error('Unsafe media asset');
        const updated = { ...record, messages: record.messages.filter(message => message !== discordMessageId) };
        if (!updated.messages.length) await erase(updated);
        else { await persist(updated); records.set(id, updated); }
      }).catch(error => { admissionBlocked = mutationFailed = true; throw error; });
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
    async close() { closed = true; reservations.clear(); clearInterval(timer); await tail; },
  };
}
