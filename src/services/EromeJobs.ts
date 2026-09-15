import { performance } from 'node:perf_hooks';
import type { DeliveryContext, DeliveryStage, DeliveryPath, DeliveryTrace, StageOutcome } from './DeliveryContext';

export const safely = (work: () => unknown): void => {
  try { void Promise.resolve(work()).catch(() => {}); } catch { /* Observers cannot interrupt delivery. */ }
};
export async function eromeStage<T>(context: DeliveryContext | undefined, stage: DeliveryStage, work: () => Promise<T>): Promise<T> {
  let finish: ((outcome?: StageOutcome) => void) | undefined;
  safely(() => { const span = context?.trace?.startStage(stage); finish = outcome => span?.finish(outcome); });
  safely(() => context?.progress?.({ stage, state: 'running' }));
  try {
    const value = await work(); safely(() => finish?.(value === null ? 'unavailable' : 'ok')); return value;
  } catch (error) { safely(() => finish?.(context?.signal?.aborted ? 'cancelled' : 'failed')); throw error; }
  finally { safely(() => context?.progress?.({ stage, state: 'done' })); }
}

/** Coalesced work has its own lifetime; one departing consumer cannot cancel another's preparation. */
export function createEromeJobs<T>(signal?: AbortSignal) {
  type Span = { stage: DeliveryStage; index?: number; children: Map<DeliveryContext, ReturnType<DeliveryTrace['startStage']>> };
  type Job = { controller: AbortController; contexts: Set<DeliveryContext>; spans: Set<Span>; path?: DeliveryPath;
    cache?: 'hit' | 'miss'; result: Promise<T | null> };
  const jobs = new Map<string, Job>(), running = new Set<Promise<T | null>>();
  return {
    async run(key: string, context: DeliveryContext = {}, work: (context: DeliveryContext) => Promise<T | null>): Promise<T | null> {
      if (context.signal?.aborted || signal?.aborted || context.deadlineAt !== undefined && context.deadlineAt <= performance.now()) return null;
      let job = jobs.get(key);
      if (!job) {
        if (jobs.size >= 16) return null;
        const controller = new AbortController(), contexts = new Set<DeliveryContext>(), spans = new Set<Span>();
        const sharedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        const created: Job = { controller, contexts, spans, result: Promise.resolve(null) };
        const trace: DeliveryTrace = { id: context.trace?.id ?? '',
          startStage(stage, index) {
            const span: Span = { stage, index, children: new Map() }; spans.add(span);
            for (const consumer of contexts) safely(() => {
              if (consumer.trace) span.children.set(consumer, consumer.trace.startStage(stage, index));
            });
            let finished = false;
            return { finish(outcome) {
              if (finished) return; finished = true; spans.delete(span);
              for (const child of span.children.values()) safely(() => child.finish(outcome));
              span.children.clear();
            } };
          },
          setPath(path) { created.path = path; for (const consumer of contexts) safely(() => consumer.trace?.setPath(path)); },
          setCache(cache) { created.cache = cache; for (const consumer of contexts) safely(() => consumer.trace?.setCache?.(cache)); },
          // Final delivery outcome belongs to each publisher, including possible attachment fallback.
          finish() {},
        };
        const shared: DeliveryContext = { ...context, signal: sharedSignal, deadlineAt: undefined, trace,
          progress: event => { for (const consumer of contexts) safely(() => consumer.progress?.(event)); } };
        const result = Promise.resolve().then(() => work(shared)).finally(() => { jobs.delete(key); running.delete(result); });
        created.result = result; job = created; jobs.set(key, job); running.add(result);
      }
      if (job.contexts.size >= 8) return null;
      // A distinct context object counts duplicate calls as separate consumers too.
      const consumer = { ...context }; job.contexts.add(consumer);
      if (job.path) safely(() => consumer.trace?.setPath(job.path!));
      if (job.cache) safely(() => consumer.trace?.setCache?.(job.cache!));
      for (const span of job.spans) safely(() => {
        if (consumer.trace) span.children.set(consumer, consumer.trace.startStage(span.stage, span.index));
      });
      const selected = job;
      let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
      try {
        return await new Promise<T | null>((resolve, reject) => {
          abort = () => resolve(null);
          context.signal?.addEventListener('abort', abort, { once: true });
          if (context.deadlineAt !== undefined) timer = setTimeout(abort, Math.max(0, context.deadlineAt - performance.now()));
          selected.result.then(resolve, reject);
          if (context.signal?.aborted) abort();
        });
      } finally {
        clearTimeout(timer); if (abort) context.signal?.removeEventListener('abort', abort);
        selected.contexts.delete(consumer);
        for (const span of selected.spans) {
          safely(() => span.children.get(consumer)?.finish('cancelled')); span.children.delete(consumer);
        }
        if (!selected.contexts.size) selected.controller.abort();
      }
    },
    async drain() { await Promise.allSettled([...running]); },
  };
}
