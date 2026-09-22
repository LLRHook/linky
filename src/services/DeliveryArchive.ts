import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from './AtomicWrite';
import { DELIVERY_OUTCOMES, DELIVERY_PATHS, DELIVERY_STAGES, type DeliveryOutcome, type DeliveryPath, type StageOutcome } from './DeliveryContext';
import type { DeliveryStageRecord } from './DeliveryDiagnostics';

const DAY = 86_400_000;
const MAX_BYTES = 64 * 1_024 * 1_024;
const HEALTH_RESERVE = 64 * 1_024; // Includes the temporary file used for an atomic health update.
const MAX_LINE = 16 * 1_024;
const PLATFORMS = ['x', 'instagram', 'tiktok', 'bluesky', 'reddit', 'twitch', 'youtube', 'articles', 'erome', 'mixed'] as const;
const STAGE_OUTCOMES: readonly StageOutcome[] = ['ok', 'unavailable', 'busy', 'timeout', 'cancelled', 'failed'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const COUNTERS = ['written', 'duplicates', 'queueDrops', 'invalidDrops', 'expiredDrops', 'closedDrops',
  'writeErrors', 'capacityFiles', 'invalidLines', 'readErrors', 'closeTimeouts'] as const;
export type DeliveryArchiveWarning = 'queue_full' | 'invalid_record' | 'write_failed' | 'capacity_eviction' | 'read_failed' | 'close_incomplete';
export interface ArchivedDelivery {
  id: string; startedAt: number; platform: typeof PLATFORMS[number]; mode: 'automatic' | 'manual';
  outcome: DeliveryOutcome; path?: DeliveryPath; cache?: 'hit' | 'miss'; durationMs?: number; stages: DeliveryStageRecord[];
}
export interface ArchiveHealth {
  version: 1; firstStartedAt: number; updatedAt: number; retentionDays: number; maxBytes: number;
  counters: Record<typeof COUNTERS[number], number>;
  observedDays: { day: string; firstSeenAt: number; lastSeenAt: number }[];
}
export interface DeliveryArchiveOptions {
  directory: string; retentionDays?: number; maxBytes?: number; maxQueue?: number; maxQueueBytes?: number;
  retryMs?: number; closeTimeoutMs?: number; now?: () => number;
  onWarning?: (warning: DeliveryArchiveWarning) => void;
  /** Test seam; production appends and fsyncs a single private regular file. */
  append?: (path: string, line: string) => Promise<void>;
  writeHealth?: (path: string, content: string) => Promise<void>;
}
const bounded = (value: number | undefined, fallback: number, min: number, max: number) =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.max(min, Math.min(max, Math.floor(value)));
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < 8_640_000_000_000_000;
const duration = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= DAY;
const utcDay = (value: number) => new Date(value).toISOString().slice(0, 10);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** A fresh allowlisted copy is the privacy boundary. Input identities and arbitrary properties are never serialized. */
export function archiveDelivery(value: unknown): ArchivedDelivery | undefined {
  if (!object(value) || typeof value.id !== 'string' || !UUID.test(value.id) || !timestamp(value.startedAt) ||
    !PLATFORMS.includes(value.platform as never) || !['automatic', 'manual'].includes(value.mode as string) ||
    !DELIVERY_OUTCOMES.includes(value.outcome as never) ||
    (value.path !== undefined && !DELIVERY_PATHS.includes(value.path as never)) ||
    (value.cache !== undefined && value.cache !== 'hit' && value.cache !== 'miss') ||
    (value.durationMs !== undefined && !duration(value.durationMs)) || !Array.isArray(value.stages) || value.stages.length > 96) return;
  const stages: DeliveryStageRecord[] = [];
  for (const span of value.stages) {
    if (!object(span) || !DELIVERY_STAGES.includes(span.stage as never) || !STAGE_OUTCOMES.includes(span.outcome as never) ||
      !duration(span.durationMs) || (span.itemIndex !== undefined && (!Number.isInteger(span.itemIndex) ||
        (span.itemIndex as number) < 0 || (span.itemIndex as number) > 100))) return;
    stages.push({ stage: span.stage as DeliveryStageRecord['stage'], outcome: span.outcome as StageOutcome, durationMs: span.durationMs,
      ...(span.itemIndex !== undefined ? { itemIndex: span.itemIndex as number } : {}) });
  }
  return { id: value.id, startedAt: value.startedAt, platform: value.platform as ArchivedDelivery['platform'],
    mode: value.mode as ArchivedDelivery['mode'], outcome: value.outcome as DeliveryOutcome, stages,
    ...(value.path !== undefined ? { path: value.path as DeliveryPath } : {}),
    ...(value.cache !== undefined ? { cache: value.cache as 'hit' | 'miss' } : {}),
    ...(value.durationMs !== undefined ? { durationMs: value.durationMs as number } : {}) };
}

async function readPrivateFile(path: string, maximum: number): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) throw Error('invalid_file');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.nlink !== 1 || current.dev !== before.dev || current.ino !== before.ino || current.size > maximum) throw Error('invalid_file');
    // Take a bounded initial-size snapshot; an ordinary concurrent append must not hide the whole day.
    const buffer = Buffer.alloc(current.size);
    let total = 0;
    while (total < buffer.length) {
      const result = await handle.read(buffer, total, buffer.length - total, null);
      if (!result.bytesRead) break;
      total += result.bytesRead;
    }
    if (total !== current.size) throw Error('truncated_file');
    return buffer.subarray(0, total);
  } finally { await handle.close(); }
}

function restoreHealth(value: unknown): ArchiveHealth | undefined {
  if (!object(value) || value.version !== 1 || !timestamp(value.firstStartedAt) || !timestamp(value.updatedAt) ||
    !Number.isInteger(value.retentionDays) || (value.retentionDays as number) < 1 || (value.retentionDays as number) > 90 ||
    !Number.isInteger(value.maxBytes) || (value.maxBytes as number) < 2 * HEALTH_RESERVE || (value.maxBytes as number) > MAX_BYTES ||
    !object(value.counters) || !Array.isArray(value.observedDays) || value.observedDays.length > 91) return;
  const counters = {} as ArchiveHealth['counters'];
  for (const key of COUNTERS) {
    const count = value.counters[key];
    if (!Number.isSafeInteger(count) || (count as number) < 0) return;
    counters[key] = count as number;
  }
  const observedDays: ArchiveHealth['observedDays'] = [];
  for (const day of value.observedDays) {
    if (!object(day) || typeof day.day !== 'string' || !timestamp(day.firstSeenAt) || !timestamp(day.lastSeenAt) ||
      day.firstSeenAt > day.lastSeenAt || utcDay(day.firstSeenAt) !== day.day || utcDay(day.lastSeenAt) !== day.day) return;
    observedDays.push({ day: day.day, firstSeenAt: day.firstSeenAt, lastSeenAt: day.lastSeenAt });
  }
  return { version: 1, firstStartedAt: value.firstStartedAt, updatedAt: value.updatedAt,
    retentionDays: value.retentionDays as number, maxBytes: value.maxBytes as number, counters, observedDays };
}

/** Read-only, bounded input for operator reports. No identity-bearing Details file is needed. */
export async function readDeliveryArchive(directory: string, maximum = MAX_BYTES) {
  const limit = bounded(maximum, MAX_BYTES, 2 * HEALTH_RESERVE, MAX_BYTES);
  const rows: ArchivedDelivery[] = [], files: { day: string; bytes: number }[] = [];
  let health: ArchiveHealth | undefined, readErrors = 0, invalidLines = 0, scanLimited = false;
  let names: string[];
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error('invalid_directory');
    names = await readdir(directory);
  } catch { return { rows, files, health, readErrors: 1, invalidLines, scanLimited }; }
  try { health = restoreHealth(JSON.parse((await readPrivateFile(join(directory, 'health.json'), HEALTH_RESERVE / 2)).toString('utf8'))); }
  catch { /* First startup can precede its first health snapshot. Coverage remains explicitly unknown. */ }
  const daily = names.filter(name => FILE.test(name)).sort().reverse();
  if (daily.length > 91) scanLimited = true;
  let consumed = 0;
  for (const name of daily.slice(0, 91)) {
    try {
      const content = await readPrivateFile(join(directory, name), limit - consumed);
      consumed += content.length;
      files.push({ day: name.slice(0, 10), bytes: content.length });
      for (const line of content.toString('utf8').split('\n')) {
        if (!line) continue;
        if (Buffer.byteLength(line) > MAX_LINE) { invalidLines++; continue; }
        let value: ArchivedDelivery | undefined;
        try { value = archiveDelivery(JSON.parse(line)); } catch { /* Count malformed lines without copying them. */ }
        if (!value || utcDay(value.startedAt) !== name.slice(0, 10)) invalidLines++;
        else rows.push(value);
      }
    } catch { readErrors++; scanLimited = true; }
  }
  return { rows, files, health, readErrors, invalidLines, scanLimited };
}

/** One process owns this directory. Delivery never awaits filesystem work or an archive retry. */
export class DeliveryArchive {
  readonly ready: Promise<void>;
  private readonly now: () => number;
  private readonly retentionDays: number;
  private readonly maxBytes: number;
  private readonly maxQueue: number;
  private readonly maxQueueBytes: number;
  private readonly retryMs: number;
  private readonly closeTimeoutMs: number;
  private readonly health: ArchiveHealth;
  private readonly queue: { record: ArchivedDelivery; line: string; bytes: number }[] = [];
  private readonly seen = new Map<string, string>();
  private readonly files = new Map<string, number>();
  private readonly warnings = new Map<DeliveryArchiveWarning, number>();
  private queueBytes = 0;
  private closed = false;
  private running?: Promise<boolean>;
  private retry?: NodeJS.Timeout;
  private readonly heartbeat: NodeJS.Timeout;

  constructor(private readonly options: DeliveryArchiveOptions) {
    this.now = options.now ?? Date.now;
    this.retentionDays = bounded(options.retentionDays, 30, 1, 90);
    this.maxBytes = bounded(options.maxBytes, MAX_BYTES, 2 * HEALTH_RESERVE, MAX_BYTES);
    this.maxQueue = bounded(options.maxQueue, 4_096, 1, 4_096);
    this.maxQueueBytes = bounded(options.maxQueueBytes, 4 * 1_024 * 1_024, MAX_LINE, 4 * 1_024 * 1_024);
    this.retryMs = bounded(options.retryMs, 5_000, 10, 60_000);
    this.closeTimeoutMs = bounded(options.closeTimeoutMs, 2_000, 1, 5_000);
    this.health = { version: 1, firstStartedAt: this.now(), updatedAt: this.now(), retentionDays: this.retentionDays,
      maxBytes: this.maxBytes, counters: Object.fromEntries(COUNTERS.map(key => [key, 0])) as ArchiveHealth['counters'], observedDays: [] };
    this.ready = this.load();
    this.heartbeat = setInterval(() => { void this.flush(); }, 60_000);
    this.heartbeat.unref();
    void this.flush();
  }

  record(value: unknown): boolean {
    const record = archiveDelivery(value);
    if (!record) { this.count('invalidDrops'); this.warn('invalid_record'); return false; }
    if (this.closed) { this.count('closedDrops'); return false; }
    if (utcDay(record.startedAt) <= utcDay(this.now() - this.retentionDays * DAY) || record.startedAt > this.now() + 60_000) {
      this.count('expiredDrops'); return false;
    }
    const line = `${JSON.stringify(record)}\n`, bytes = Buffer.byteLength(line);
    if (this.queue.length >= this.maxQueue || this.queueBytes + bytes > this.maxQueueBytes) {
      this.count('queueDrops'); this.warn('queue_full'); return false;
    }
    this.queue.push({ record, line, bytes }); this.queueBytes += bytes;
    void this.flush();
    return true;
  }

  snapshot(): ArchiveHealth & { queued: number; queueBytes: number } {
    return { ...structuredClone(this.health), queued: this.queue.length, queueBytes: this.queueBytes };
  }

  flush(): Promise<boolean> {
    if (this.running) return this.running;
    clearTimeout(this.retry);
    this.running = (async () => {
      await this.ready;
      try {
        await this.ensureDirectory();
        await this.prune();
        await this.makeRoom(0, utcDay(this.now()));
        this.observeDay();
        while (this.queue.length) {
          const item = this.queue[0], day = utcDay(item.record.startedAt);
          if (day <= utcDay(this.now() - this.retentionDays * DAY)) this.count('expiredDrops');
          else if (this.seen.has(item.record.id)) this.count('duplicates');
          else {
            await this.makeRoom(item.bytes, day);
            const path = join(this.options.directory, `${day}.jsonl`);
            if (this.options.append) await this.options.append(path, item.line);
            else await this.append(path, item.line);
            this.files.set(day, (this.files.get(day) ?? 0) + item.bytes);
            this.seen.set(item.record.id, day); this.count('written');
          }
          this.queue.shift(); this.queueBytes -= item.bytes;
        }
        await (this.options.writeHealth ?? atomicWrite)(join(this.options.directory, 'health.json'), JSON.stringify(this.health));
        return true;
      } catch {
        this.count('writeErrors'); this.warn('write_failed'); return false;
      }
    })().finally(() => {
      this.running = undefined;
      if (!this.closed && this.queue.length) {
        this.retry = setTimeout(() => { void this.flush(); }, this.retryMs); this.retry.unref();
      }
    });
    return this.running;
  }

  async close(): Promise<boolean> {
    this.closed = true; clearInterval(this.heartbeat); clearTimeout(this.retry);
    let timer: NodeJS.Timeout | undefined;
    try {
      const drain = async () => {
        do { if (!await this.flush()) return false; } while (this.queue.length);
        return true;
      };
      const flushed = await Promise.race([drain(), new Promise<false>(resolve => {
        timer = setTimeout(() => resolve(false), this.closeTimeoutMs);
      })]);
      if (!flushed || this.queue.length) { this.count('closeTimeouts'); this.warn('close_incomplete'); return false; }
      return true;
    } finally { clearTimeout(timer); }
  }

  private count(key: typeof COUNTERS[number], amount = 1): void {
    this.health.counters[key] = Math.min(Number.MAX_SAFE_INTEGER, this.health.counters[key] + amount);
  }
  private warn(code: DeliveryArchiveWarning): void {
    const now = this.now(), previous = this.warnings.get(code);
    if (previous !== undefined && now - previous < 60_000) return;
    this.warnings.set(code, now);
    try { this.options.onWarning?.(code); } catch { /* Reporting cannot affect a delivery. */ }
  }
  private observeDay(): void {
    const now = this.now(), day = utcDay(now);
    this.health.updatedAt = now;
    const existing = this.health.observedDays.find(entry => entry.day === day);
    if (existing) existing.lastSeenAt = now;
    else this.health.observedDays.push({ day, firstSeenAt: now, lastSeenAt: now });
    this.health.observedDays = this.health.observedDays.filter(entry => entry.day >= utcDay(now - this.retentionDays * DAY)).slice(-91);
  }
  private async load(): Promise<void> {
    try {
      await this.ensureDirectory();
      // Only clean exact temporary names created by our atomic health writer, never arbitrary directory contents.
      for (const name of await readdir(this.options.directory)) {
        const temporaryId = name.startsWith('health.json.') && name.endsWith('.tmp') ? name.slice(12, -4) : '';
        if (!UUID.test(temporaryId)) continue;
        const path = join(this.options.directory, name), info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw Error('invalid_temporary_file');
        await unlink(path);
      }
      const loaded = await readDeliveryArchive(this.options.directory, this.maxBytes);
      if (loaded.health) {
        const pending = this.health.counters;
        Object.assign(this.health, loaded.health, { retentionDays: this.retentionDays, maxBytes: this.maxBytes });
        for (const key of COUNTERS) this.count(key, pending[key]);
      }
      // Inventory even corrupt/oversized managed files, so recovery cannot bypass the disk cap.
      for (const name of (await readdir(this.options.directory)).filter(name => FILE.test(name))) {
        const info = await lstat(join(this.options.directory, name));
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw Error('invalid_file');
        this.files.set(name.slice(0, 10), info.size);
      }
      for (const row of loaded.rows) this.seen.set(row.id, utcDay(row.startedAt));
      this.count('invalidLines', loaded.invalidLines); this.count('readErrors', loaded.readErrors);
      if (loaded.readErrors || loaded.invalidLines) this.warn('read_failed');
    } catch { this.count('readErrors'); this.warn('read_failed'); }
  }
  private async ensureDirectory(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.options.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error('invalid_directory');
    await chmod(this.options.directory, 0o700);
  }
  private async removeDay(day: string): Promise<void> {
    await unlink(join(this.options.directory, `${day}.jsonl`)); this.files.delete(day);
    for (const [id, fileDay] of this.seen) if (fileDay === day) this.seen.delete(id);
  }
  private async prune(): Promise<void> {
    const cutoff = utcDay(this.now() - this.retentionDays * DAY);
    for (const day of this.files.keys()) if (day <= cutoff) await this.removeDay(day);
  }
  private async makeRoom(bytes: number, incomingDay: string): Promise<void> {
    let total = [...this.files.values()].reduce((sum, size) => sum + size, 0);
    for (const day of [...this.files.keys()].sort()) {
      if (total + bytes <= this.maxBytes - HEALTH_RESERVE) break;
      const size = this.files.get(day)!;
      await this.removeDay(day); total -= size; this.count('capacityFiles'); this.warn('capacity_eviction');
    }
    if (total + bytes > this.maxBytes - HEALTH_RESERVE || incomingDay > utcDay(this.now() + 60_000)) throw Error('capacity');
  }
  private async append(path: string, line: string): Promise<void> {
    const handle = await open(path, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), 0o600);
    let start: number | undefined;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1) throw Error('invalid_file');
      if (info.size !== (this.files.get(utcDay(this.queue[0].record.startedAt)) ?? 0)) throw Error('changed_file');
      start = info.size;
      await handle.chmod(0o600);
      const buffer = Buffer.from(line); let written = 0;
      while (written < buffer.length) {
        const result = await handle.write(buffer, written, buffer.length - written, start + written);
        if (!result.bytesWritten) throw Error('short_write');
        written += result.bytesWritten;
      }
      await handle.sync();
    } catch (error) {
      if (start !== undefined) await handle.truncate(start).catch(() => {});
      throw error;
    } finally { await handle.close(); }
  }
}
