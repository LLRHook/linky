import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { atomicWrite } from './AtomicWrite';
import { DELIVERY_OUTCOMES, DELIVERY_PATHS, DELIVERY_STAGES, type DeliveryOutcome, type DeliveryPath,
  type DeliveryStage, type DeliveryTrace, type StageOutcome } from './DeliveryContext';

const PLATFORMS = ['x', 'instagram', 'tiktok', 'bluesky', 'reddit', 'twitch', 'youtube', 'erome', 'mixed'] as const;
const STAGE_OUTCOMES: readonly StageOutcome[] = ['ok', 'unavailable', 'busy', 'timeout', 'cancelled', 'failed'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DISCORD_ID = /^\d{17,20}$/;
const MAX_STAGES = 96;
const MAX_DURATION = 24 * 60 * 60_000;

export interface DeliveryRequest {
  requesterId: string;
  channelId: string;
  guildId?: string;
  mode: 'automatic' | 'manual';
  platform: typeof PLATFORMS[number];
}
export interface DeliveryStageRecord { stage: DeliveryStage; durationMs: number; outcome: StageOutcome; itemIndex?: number }
export interface DeliveryRecord extends DeliveryRequest {
  id: string;
  startedAt: number;
  messageId?: string;
  path?: DeliveryPath;
  cache?: 'hit' | 'miss';
  outcome?: DeliveryOutcome;
  durationMs?: number;
  stages: DeliveryStageRecord[];
}
export interface DeliveryReader {
  requesterId: string; channelId: string; guildId?: string; messageId: string;
  /** Only set after validating a public server-message interaction. Private replies stay requester-bound. */
  sharedMessage?: boolean;
}
export interface DeliveryDiagnosticsOptions {
  path: string;
  maxAttempts?: number;
  maxBytes?: number;
  retentionMs?: number;
  operationTimeoutMs?: number;
  wallNow?: () => number;
  monotonicNow?: () => number;
  write?: (path: string, value: string) => Promise<void>;
}

function finiteDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_DURATION;
}
function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(min, Math.min(max, Math.floor(value)));
}
function validRequest(value: DeliveryRequest): boolean {
  return DISCORD_ID.test(value.requesterId) && DISCORD_ID.test(value.channelId) &&
    (value.guildId === undefined || DISCORD_ID.test(value.guildId)) &&
    ['automatic', 'manual'].includes(value.mode) && PLATFORMS.includes(value.platform);
}
function restore(value: unknown): DeliveryRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as DeliveryRecord;
  if (!UUID.test(record.id) || !validRequest(record) || !Number.isSafeInteger(record.startedAt) || record.startedAt < 0 ||
    (record.messageId !== undefined && !DISCORD_ID.test(record.messageId)) ||
    (record.path !== undefined && !DELIVERY_PATHS.includes(record.path)) ||
    (record.cache !== undefined && record.cache !== 'hit' && record.cache !== 'miss') ||
    (record.outcome !== undefined && !DELIVERY_OUTCOMES.includes(record.outcome)) ||
    (record.durationMs !== undefined && !finiteDuration(record.durationMs)) || !Array.isArray(record.stages) || record.stages.length > MAX_STAGES) return undefined;
  const stages: DeliveryStageRecord[] = [];
  for (const span of record.stages) {
    if (!span || !DELIVERY_STAGES.includes(span.stage) || !finiteDuration(span.durationMs) || !STAGE_OUTCOMES.includes(span.outcome) ||
      (span.itemIndex !== undefined && (!Number.isInteger(span.itemIndex) || span.itemIndex < 0 || span.itemIndex > 100))) return undefined;
    stages.push({ stage: span.stage, durationMs: span.durationMs, outcome: span.outcome,
      ...(span.itemIndex !== undefined ? { itemIndex: span.itemIndex } : {}) });
  }
  // Copy only the schema: an old or tampered file cannot restore arbitrary text into private details.
  return { id: record.id, requesterId: record.requesterId, channelId: record.channelId, guildId: record.guildId,
    mode: record.mode, platform: record.platform, startedAt: record.startedAt, messageId: record.messageId,
    path: record.path, cache: record.cache, outcome: record.outcome ?? 'interrupted', durationMs: record.durationMs, stages };
}

/** Private, bounded local history. Diagnostic I/O is deliberately independent of delivery success. */
export class DeliveryDiagnostics {
  readonly ready: Promise<void>;
  private records = new Map<string, DeliveryRecord>();
  private persistedBindings = new Map<string, string>();
  private tail: Promise<boolean> = Promise.resolve(true);
  private dirty = false;
  private scheduled = false;
  private readonly maxAttempts: number;
  private readonly maxBytes: number;
  private readonly retentionMs: number;
  private readonly operationTimeoutMs: number;
  private readonly wallNow: () => number;
  private readonly monotonicNow: () => number;
  private readonly write: (path: string, value: string) => Promise<void>;
  private readonly maintenance: NodeJS.Timeout;

  constructor(private options: DeliveryDiagnosticsOptions) {
    this.maxAttempts = bounded(options.maxAttempts, 4_096, 1, 4_096);
    this.maxBytes = bounded(options.maxBytes, 4 * 1_024 * 1_024, 128, 4 * 1_024 * 1_024);
    this.retentionMs = bounded(options.retentionMs, 7 * 24 * 60 * 60_000, 1, 7 * 24 * 60 * 60_000);
    this.operationTimeoutMs = bounded(options.operationTimeoutMs, 1_000, 1, 2_000);
    this.wallNow = options.wallNow ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.write = options.write ?? atomicWrite;
    this.ready = this.load();
    this.maintenance = setInterval(() => { this.prune(); if (this.dirty) void this.flush(); }, Math.min(this.retentionMs, 60 * 60_000));
    this.maintenance.unref();
  }

  begin(request: DeliveryRequest): DeliveryTrace {
    const id = randomUUID();
    const start = this.monotonicNow();
    if (validRequest(request)) {
      this.records.set(id, { id, requesterId: request.requesterId, channelId: request.channelId, guildId: request.guildId,
        mode: request.mode, platform: request.platform, startedAt: this.wallNow(), stages: [] });
      this.changed();
    }
    const duration = (from: number) => Math.round(Math.min(MAX_DURATION, Math.max(0, this.monotonicNow() - from)));
    const openSpans = new Set<(outcome?: StageOutcome) => void>();
    return { id,
      startStage: (stage, itemIndex) => {
        const stageStart = this.monotonicNow();
        const record = this.records.get(id);
        const accepted = Boolean(record && !record.outcome && record.stages.length + openSpans.size < MAX_STAGES &&
          DELIVERY_STAGES.includes(stage) && (itemIndex === undefined || (Number.isInteger(itemIndex) && itemIndex >= 0 && itemIndex <= 100)));
        let finished = false;
        const finish = (outcome: StageOutcome = 'ok') => {
          if (finished || !accepted) return;
          finished = true; openSpans.delete(finish);
          const current = this.records.get(id);
          if (!current || current.outcome || !STAGE_OUTCOMES.includes(outcome)) return;
          current.stages.push({ stage, durationMs: duration(stageStart), outcome, ...(itemIndex !== undefined ? { itemIndex } : {}) });
          this.changed();
        };
        if (accepted) openSpans.add(finish);
        return { finish };
      },
      setPath: path => {
        const record = this.records.get(id);
        if (record && !record.outcome && DELIVERY_PATHS.includes(path)) { record.path = path; this.changed(); }
      },
      setCache: cache => {
        const record = this.records.get(id);
        if (record && !record.outcome && (cache === 'hit' || cache === 'miss')) { record.cache = cache; this.changed(); }
      },
      finish: outcome => {
        const record = this.records.get(id);
        if (record && !record.outcome && DELIVERY_OUTCOMES.includes(outcome)) {
          const stageOutcome: StageOutcome = outcome === 'confirmed' ? 'ok' : outcome === 'busy' ? 'busy'
            : outcome === 'timeout' ? 'timeout' : ['cancelled', 'interrupted', 'disabled'].includes(outcome) ? 'cancelled'
              : ['partial', 'unavailable', 'metadata-unconfirmed'].includes(outcome) ? 'unavailable' : 'failed';
          for (const finish of openSpans) finish(stageOutcome);
          record.outcome = outcome; record.durationMs = duration(start); this.changed();
        }
      },
    };
  }

  /** Returns true only once the requester/message binding is durable. Never expose Details before this. */
  bind(id: string, messageId: string): Promise<boolean> {
    return this.within((async () => {
      await this.ready;
      const record = this.records.get(id);
      if (!record || !DISCORD_ID.test(messageId) || (record.messageId !== undefined && record.messageId !== messageId)) return false;
      record.messageId = messageId;
      this.dirty = true;
      return await this.flush() && this.persistedBindings.get(id) === messageId;
    })(), false);
  }

  lookup(id: string, reader: DeliveryReader): Promise<DeliveryRecord | undefined> {
    return this.within((async () => {
      await this.ready;
      this.prune();
      const record = this.records.get(id);
      if (!record || !DISCORD_ID.test(reader.requesterId) || this.persistedBindings.get(id) !== reader.messageId ||
        record.messageId !== reader.messageId || record.channelId !== reader.channelId || record.guildId !== reader.guildId ||
        record.requesterId !== reader.requesterId && !(reader.sharedMessage && record.guildId)) return undefined;
      return structuredClone(record);
    })(), undefined);
  }

  async flush(): Promise<boolean> {
    this.tail = this.tail.then(async () => {
      await this.ready;
      if (!this.dirty) return true;
      this.prune();
      const encoded = [...this.records.values()].sort((a, b) => a.startedAt - b.startedAt).map(record => {
        const json = JSON.stringify(record);
        return { id: record.id, messageId: record.messageId, json, bytes: Buffer.byteLength(json) };
      });
      let size = Buffer.byteLength('{"version":1,"attempts":[]}') +
        encoded.reduce((total, entry) => total + entry.bytes, 0) + Math.max(0, encoded.length - 1);
      let dropped = 0;
      while (size > this.maxBytes && dropped < encoded.length) {
        const entry = encoded[dropped++];
        size -= entry.bytes + Number(dropped < encoded.length);
        this.remove(entry.id);
      }
      encoded.splice(0, dropped);
      const content = `{"version":1,"attempts":[${encoded.map(entry => entry.json).join(',')}]}`;
      this.dirty = false;
      const bindings = new Map(encoded.filter(entry => entry.messageId).map(entry => [entry.id, entry.messageId!]));
      try {
        await this.write(this.options.path, content);
        this.persistedBindings = bindings;
        return true;
      } catch { this.dirty = true; return false; }
    }).catch(() => false);
    return this.tail;
  }

  async close(): Promise<boolean> { clearInterval(this.maintenance); return this.flush(); }

  private async within<T>(work: Promise<T>, fallback: T): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([work.catch(() => fallback), new Promise<T>(resolve => {
        timer = setTimeout(() => resolve(fallback), this.operationTimeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }

  private changed(): void {
    this.dirty = true;
    this.prune();
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; void this.flush(); });
  }

  private remove(id: string): void { this.records.delete(id); this.persistedBindings.delete(id); this.dirty = true; }

  private prune(): void {
    const now = this.wallNow();
    for (const record of this.records.values()) {
      if (now - record.startedAt >= this.retentionMs || record.startedAt > now + 60_000) this.remove(record.id);
    }
    if (this.records.size > this.maxAttempts) {
      const ordered = [...this.records.values()].sort((a, b) => a.startedAt - b.startedAt);
      for (const record of ordered.slice(0, ordered.length - this.maxAttempts)) this.remove(record.id);
    }
  }

  private async load(): Promise<void> {
    try {
      const file = await open(this.options.path, 'r');
      let content: string;
      try {
        const metadata = await file.stat();
        if (!metadata.isFile()) return;
        if (metadata.size > this.maxBytes) { this.changed(); return; }
        // Read a hard cap through the same descriptor; a growing file cannot bypass the stat check.
        const buffer = Buffer.alloc(this.maxBytes + 1);
        let bytes = 0;
        while (bytes < buffer.length) {
          const result = await file.read(buffer, bytes, buffer.length - bytes, null);
          if (!result.bytesRead) break;
          bytes += result.bytesRead;
        }
        if (bytes > this.maxBytes) { this.changed(); return; }
        content = buffer.subarray(0, bytes).toString('utf8');
      } finally { await file.close(); }
      const parsed: unknown = JSON.parse(content);
      if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || parsed.version !== 1 ||
        !('attempts' in parsed) || !Array.isArray(parsed.attempts) || parsed.attempts.length > this.maxAttempts) return;
      for (const item of parsed.attempts) {
        const record = restore(item);
        if (record && !this.records.has(record.id)) {
          this.records.set(record.id, record);
          if (record.messageId) this.persistedBindings.set(record.id, record.messageId);
          if (record.outcome === 'interrupted') this.changed();
        }
      }
      this.prune();
    } catch { /* Missing, malformed or unreadable diagnostics never prevent startup. */ }
  }
}
