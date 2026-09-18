export const DELIVERY_STAGES = ['queue', 'resolve', 'download', 'inspect', 'convert', 'store', 'publish', 'preview', 'ownership'] as const;
export type DeliveryStage = typeof DELIVERY_STAGES[number];
export const DELIVERY_PATHS = ['native', 'explicit', 'hosted-original', 'attachment', 'album'] as const;
export type DeliveryPath = typeof DELIVERY_PATHS[number];
export const DELIVERY_OUTCOMES = ['confirmed', 'partial', 'unsupported', 'unavailable', 'permission', 'disabled', 'busy', 'timeout',
  'discord-failure', 'metadata-unconfirmed', 'cancelled', 'interrupted', 'internal-failure'] as const;
export type DeliveryOutcome = typeof DELIVERY_OUTCOMES[number];
export type StageOutcome = 'ok' | 'unavailable' | 'busy' | 'timeout' | 'cancelled' | 'failed';

export interface DeliveryProgress {
  stage: DeliveryStage;
  state: 'waiting' | 'running' | 'done';
  itemIndex?: number;
  itemCount?: number;
  cache?: 'hit' | 'miss';
}

export interface DeliveryTrace {
  readonly id: string;
  /** Spans can overlap. Durations use a monotonic clock and finishing twice has no effect. */
  startStage(stage: DeliveryStage, itemIndex?: number): { finish(outcome?: StageOutcome): void };
  setPath(path: DeliveryPath): void;
  setCache?(cache: 'hit' | 'miss'): void;
  finish(outcome: DeliveryOutcome): void;
}

/** Optional preparation context. Sinks must never throw or decide whether delivery is allowed. */
export interface DeliveryContext {
  signal?: AbortSignal;
  /** Absolute performance.now() cutoff; applies to the complete attempt, including queue time. */
  deadlineAt?: number;
  /** An opaque scheduling key, normally supplied from a trusted server or requester ID. */
  fairnessKey?: string;
  trace?: DeliveryTrace;
  progress?: (event: DeliveryProgress) => void;
}
