export interface CleanupFailure extends Error { code?: number; status?: number }

/** Copy only numeric error metadata; never forward SDK errors, message text or identity fields. */
export function cleanupFailure(message: string, error?: unknown): CleanupFailure {
  const result: CleanupFailure = new Error(message);
  if (error && typeof error === 'object') {
    for (const key of ['code', 'status'] as const) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    }
  }
  return result;
}

export function logCleanupFailure(log: { warn(fields: { code?: number; status?: number }, message: string): void }, error: CleanupFailure): void {
  log.warn({ code: error.code, status: error.status }, error.message);
}
