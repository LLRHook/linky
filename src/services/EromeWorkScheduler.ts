import { performance } from 'node:perf_hooks';
import type { DeliveryContext, StageOutcome } from './DeliveryContext';

export type EromeWorkProfile = 'original' | 'attachment';
export type EromeAdmissionFailure = 'queue_full' | 'deadline' | 'cancelled' | 'closed' | 'cleanup_failed';
export class EromeAdmissionError extends Error {
  constructor(readonly reason: EromeAdmissionFailure) { super(`erome_${reason}`); this.name = 'EromeAdmissionError'; }
}
/** A producer could not remove its private temporary files; capacity must not be reused. */
export class EromeCleanupError extends Error {
  constructor() { super('erome_cleanup_failed'); this.name = 'EromeCleanupError'; }
}

const MiB = 1024 * 1024;
const SCRATCH = { original: 24 * MiB, attachment: 128 * MiB } as const;
const MAX_SCRATCH = 192 * MiB, MAX_PENDING = 8, MAX_GUILD_PENDING = 2;
const DEADLINE_MS = 300_000, CLOSE_TIMEOUT_MS = 5_000;
export type EromeSchedulerEvent = {
  kind: 'queued' | 'started' | 'finished' | 'rejected' | 'quarantined';
  profile: EromeWorkProfile; pending: number; active: number; scratchBytes: number; quarantinedBytes: number;
  queueMs: number; runMs?: number; reason?: EromeAdmissionFailure;
};
type Context = DeliveryContext & { deadlineAt?: number };
export type EromeWorkScheduler = {
  run<T>(context: Context | undefined, profile: EromeWorkProfile, work: (signal: AbortSignal) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};
type Entry = {
  guild: string; profile: EromeWorkProfile; context: Context; controller: AbortController; queuedAt: number;
  startedAt?: number; timer?: ReturnType<typeof setTimeout>; settled: boolean; quarantined?: boolean;
  resolve(value: unknown): void; reject(error: unknown): void; work(signal: AbortSignal): Promise<unknown>;
  abort(): void; queueDone(outcome: StageOutcome): void;
};
function safely(work: () => unknown): void {
  try { void Promise.resolve(work()).catch(() => undefined); } catch { /* Observers do not control work. */ }
}

/** Atomic profiles keep one collector/probe and one encoder/stream independent, without nested leases. */
export function createEromeWorkScheduler({ clock = () => performance.now(), observe }: {
  clock?: () => number; observe?: (event: EromeSchedulerEvent) => void;
} = {}): EromeWorkScheduler {
  const queues = new Map<string, Entry[]>(), order: string[] = [];
  const active = new Set<Entry>(), running = new Set<Promise<void>>();
  let pending = 0, scratch = 0, quarantined = 0, closed = false, poisoned = false;
  let closing: Promise<void> | undefined;
  const emit = (entry: Entry, kind: EromeSchedulerEvent['kind'], reason?: EromeAdmissionFailure) => safely(() => observe?.({
    kind, profile: entry.profile, pending, active: active.size, scratchBytes: scratch, quarantinedBytes: quarantined,
    queueMs: Math.max(0, (entry.startedAt ?? clock()) - entry.queuedAt),
    ...(entry.startedAt === undefined ? {} : { runMs: Math.max(0, clock() - entry.startedAt) }),
    ...(reason ? { reason } : {}),
  }));
  function cleanup(entry: Entry): void {
    clearTimeout(entry.timer); entry.context.signal?.removeEventListener('abort', entry.abort);
  }
  function remove(entry: Entry): void {
    const queue = queues.get(entry.guild), index = queue?.indexOf(entry) ?? -1;
    if (queue && index >= 0) {
      queue.splice(index, 1); pending--;
      if (!queue.length) { queues.delete(entry.guild); order.splice(order.indexOf(entry.guild), 1); }
    }
  }
  function reject(entry: Entry, reason: EromeAdmissionFailure): void {
    if (entry.settled) return;
    entry.settled = true; cleanup(entry); entry.controller.abort();
    if (entry.startedAt === undefined) { remove(entry); entry.queueDone(reason === 'deadline' ? 'timeout' : 'cancelled'); }
    entry.reject(new EromeAdmissionError(reason)); emit(entry, 'rejected', reason);
  }
  function fits(entry: Entry): boolean {
    return scratch + SCRATCH[entry.profile] <= MAX_SCRATCH &&
      ![...active].some(item => item.guild === entry.guild || item.profile === entry.profile);
  }
  function pump(): void {
    if (closed || poisoned) return;
    let admitted = true;
    while (admitted) {
      admitted = false;
      for (let index = 0; index < order.length; index++) {
        const guild = order[index], queue = queues.get(guild)!, entry = queue[0];
        if (!fits(entry)) continue;
        queue.shift(); pending--;
        if (!queue.length) { order.splice(index, 1); queues.delete(guild); }
        active.add(entry); scratch += SCRATCH[entry.profile]; entry.startedAt = clock();
        entry.queueDone('ok'); emit(entry, 'started');
        const task = Promise.resolve().then(() => {
          entry.controller.signal.throwIfAborted();
          return entry.work(entry.controller.signal);
        }).then(value => {
          if (!entry.settled) { entry.settled = true; entry.resolve(value); }
        }, error => {
          if (error instanceof EromeCleanupError) {
            entry.quarantined = true; quarantined += SCRATCH[entry.profile]; poisoned = true;
            emit(entry, 'quarantined', 'cleanup_failed');
            for (const waiting of [...queues.values()].flat()) reject(waiting, 'cleanup_failed');
          }
          if (!entry.settled) { entry.settled = true; entry.reject(error); }
        }).finally(() => {
          cleanup(entry); active.delete(entry);
          if (!entry.quarantined) scratch -= SCRATCH[entry.profile];
          // Quarantined capacity remains charged until this scheduler is replaced after cleanup.
          const next = order.indexOf(entry.guild);
          if (next >= 0) order.push(...order.splice(next, 1));
          running.delete(task); emit(entry, 'finished'); pump();
        });
        running.add(task); admitted = true; break;
      }
    }
  }
  return {
    run<T>(context: Context = {}, profile: EromeWorkProfile, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (!Object.hasOwn(SCRATCH, profile)) return Promise.reject(new TypeError('Invalid Erome work profile'));
      const early = (reason: EromeAdmissionFailure): Promise<T> => {
        safely(() => context.trace?.startStage('queue').finish(reason === 'queue_full' ? 'busy'
          : reason === 'deadline' ? 'timeout' : reason === 'cleanup_failed' ? 'failed' : 'cancelled'));
        return Promise.reject(new EromeAdmissionError(reason));
      };
      const guild = typeof context.fairnessKey === 'string' && context.fairnessKey.length > 0 && context.fairnessKey.length <= 128
        ? context.fairnessKey : 'legacy';
      const reason = closed ? 'closed' : poisoned ? 'cleanup_failed' : context.signal?.aborted ? 'cancelled'
        : pending >= MAX_PENDING || (queues.get(guild)?.length ?? 0) >= MAX_GUILD_PENDING ? 'queue_full' : undefined;
      if (reason) return early(reason);
      const started = clock(), deadline = Math.min(started + DEADLINE_MS,
        Number.isFinite(context.deadlineAt) ? context.deadlineAt! : Infinity);
      if (deadline <= started) return early('deadline');
      return new Promise<T>((resolve, fail) => {
        let span: ReturnType<NonNullable<DeliveryContext['trace']>['startStage']> | undefined;
        safely(() => { span = context.trace?.startStage('queue'); });
        let queueFinished = false;
        const entry: Entry = { guild, profile, context, work, controller: new AbortController(), queuedAt: started,
          settled: false, resolve: value => resolve(value as T), reject: fail,
          abort() { reject(entry, 'cancelled'); pump(); },
          queueDone(outcome) {
            if (queueFinished) return; queueFinished = true;
            safely(() => span?.finish(outcome));
            safely(() => context.progress?.({ stage: 'queue', state: 'done' }));
          },
        };
        entry.timer = setTimeout(() => { reject(entry, 'deadline'); pump(); }, deadline - started);
        context.signal?.addEventListener('abort', entry.abort, { once: true });
        let queue = queues.get(guild);
        if (!queue) { queue = []; queues.set(guild, queue); order.push(guild); }
        queue.push(entry); pending++;
        safely(() => context.progress?.({ stage: 'queue', state: 'waiting' }));
        emit(entry, 'queued');
        if (context.signal?.aborted) entry.abort(); else pump();
      });
    },
    close() {
      if (closing) return closing;
      closed = true;
      for (const entry of [...queues.values()].flat()) reject(entry, 'closed');
      for (const entry of active) reject(entry, 'closed');
      closing = new Promise<void>((resolve, rejectClose) => {
        const timer = setTimeout(() => rejectClose(new EromeAdmissionError('deadline')), CLOSE_TIMEOUT_MS);
        Promise.allSettled([...running]).then(() => { clearTimeout(timer); resolve(); });
      });
      return closing;
    },
  };
}
