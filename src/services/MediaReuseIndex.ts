import { createHmac, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { atomicWrite } from './AtomicWrite';
import type { MediaMime } from './MediaAssetStore';

const TTL = 7 * 24 * 60 * 60_000, CAPACITY = 1024, MAX_BYTES = 2 * 1024 * 1024;
export type ReuseSource = { album: string; source: string; etag: string; bytes: number; mimeType: MediaMime };
export type ReuseValue = { id: string; size: number; sha256: string; mimeType: MediaMime;
  metadata: { width: number; height: number; duration?: number; fps?: number } };
type Entry = ReuseValue & { key: string; lastUsed: number };
export type MediaReuseIndex = {
  get(source: ReuseSource): Promise<ReuseValue | null>;
  remember(source: ReuseSource, value: ReuseValue): Promise<void>;
  invalidateAsset(id: string): Promise<void>;
  close(): Promise<void>;
};

function validEntry(value: unknown): value is Entry {
  if (!value || typeof value !== 'object') return false;
  const item = value as Entry, meta = item.metadata;
  return Object.keys(item).sort().join(',') === 'id,key,lastUsed,metadata,mimeType,sha256,size' &&
    /^[a-f0-9]{64}$/.test(item.key) && /^[a-f0-9]{32}$/.test(item.id) && /^[a-f0-9]{64}$/.test(item.sha256) &&
    ['video/mp4', 'image/jpeg', 'image/png'].includes(item.mimeType) &&
    Number.isSafeInteger(item.size) && item.size > 0 && item.size <= 24 * 1024 * 1024 &&
    (item.mimeType === 'video/mp4' || item.size <= 8 * 1024 * 1024) &&
    Number.isSafeInteger(item.lastUsed) && item.lastUsed >= 0 && !!meta && typeof meta === 'object' &&
    Object.keys(meta).every(key => ['width', 'height', 'duration', 'fps'].includes(key)) &&
    Number.isInteger(meta.width) && Number.isInteger(meta.height) && meta.width >= 2 && meta.height >= 2 &&
    meta.width <= 8192 && meta.height <= 8192 && meta.width * meta.height <= 33_554_432 &&
    (item.mimeType !== 'video/mp4' || Number.isFinite(meta.duration) && meta.duration! > 0 && meta.duration! <= 300 &&
      Number.isFinite(meta.fps) && meta.fps! > 0 && meta.fps! <= 60);
}

/** A disposable private index. Descriptors never hold media references or contain origin URLs. */
export async function createMediaReuseIndex({ directory, clock = Date.now, write = atomicWrite }: {
  directory: string; clock?: () => number; write?: typeof atomicWrite;
}): Promise<MediaReuseIndex> {
  const root = resolve(directory), path = join(root, 'index.json');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root), canonical = await realpath(root);
  const equal = process.platform === 'win32' ? canonical.toLowerCase() === root.toLowerCase() : canonical === root;
  if (!info.isDirectory() || info.isSymbolicLink() || !equal) throw Error('Unsafe reuse index directory');
  await chmod(root, 0o700);
  let secret = randomBytes(32).toString('hex'), disabled = false, closed = false, expiredAtStartup = false;
  const entries = new Map<string, Entry>();
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_BYTES) throw Error('Invalid reuse index');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await file.stat();
      if (opened.ino !== before.ino || opened.dev !== before.dev) throw Error('Changed reuse index');
      const bytes = Buffer.alloc(MAX_BYTES + 1), { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_BYTES) throw Error('Invalid reuse index');
      const state = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
      if (!state || Object.keys(state).sort().join(',') !== 'entries,secret,version' || state.version !== 1 ||
          !/^[a-f0-9]{64}$/.test(state.secret) || !Array.isArray(state.entries) || state.entries.length > CAPACITY ||
          !state.entries.every(validEntry)) throw Error('Invalid reuse index');
      secret = state.secret;
      for (const entry of state.entries) {
        if (entry.lastUsed <= clock() && clock() - entry.lastUsed < TTL) entries.set(entry.key, entry);
        else expiredAtStartup = true;
      }
    } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') disabled = true;
  }
  let tail: Promise<void> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work); tail = result.then(() => undefined, () => undefined); return result;
  };
  const keyFor = (value: ReuseSource) => createHmac('sha256', secret).update(JSON.stringify([
    'linky-original-inspection-v1', value.album, value.source, value.etag, value.bytes, value.mimeType,
  ])).digest('hex');
  const prune = () => {
    const before = entries.size;
    for (const [key, entry] of entries) if (entry.lastUsed > clock() || clock() - entry.lastUsed >= TTL) entries.delete(key);
    while (entries.size > CAPACITY) entries.delete(entries.keys().next().value!);
    return entries.size !== before;
  };
  const persist = async () => {
    try {
      const current = await lstat(root);
      if (current.ino !== info.ino || current.dev !== info.dev || current.isSymbolicLink()) throw Error('Changed reuse directory');
      const content = JSON.stringify({ version: 1, secret, entries: [...entries.values()] });
      if (Buffer.byteLength(content) > MAX_BYTES) throw Error('Reuse index too large');
      await write(path, content);
    } catch { disabled = true; entries.clear(); }
  };
  if (expiredAtStartup && !disabled) await persist();
  const timer = setInterval(() => {
    void serial(async () => { if (!disabled && !closed && prune()) await persist(); });
  }, 60_000);
  timer.unref();
  return {
    get(source) { return serial(async () => {
      if (disabled || closed) return null;
      const changed = prune(), key = keyFor(source), entry = entries.get(key);
      if (!entry) { if (changed) await persist(); return null; }
      entries.delete(key); entries.set(key, { ...entry, lastUsed: clock() }); await persist();
      if (disabled) return null;
      const { id, size, sha256, mimeType, metadata } = entry;
      return { id, size, sha256, mimeType, metadata: { ...metadata } };
    }); },
    remember(source, value) { return serial(async () => {
      if (disabled || closed) return;
      const key = keyFor(source), entry = { ...value, metadata: { ...value.metadata }, key, lastUsed: clock() };
      if (!validEntry(entry)) return;
      entries.delete(key); entries.set(key, entry); prune(); await persist();
    }); },
    invalidateAsset(id) { return serial(async () => {
      if (disabled || closed) return;
      let changed = false;
      for (const [key, entry] of entries) if (entry.id === id) { entries.delete(key); changed = true; }
      if (changed) await persist();
    }); },
    async close() {
      if (closed) { await tail; return; }
      closed = true; clearInterval(timer);
      await serial(async () => { if (!disabled && prune()) await persist(); });
    },
  };
}
