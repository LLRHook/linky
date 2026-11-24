/** Small fail-closed guards for anonymous provider payloads. */
export const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
export const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const labelled = (value: unknown): boolean => value !== undefined && (!Array.isArray(value) || value.length > 0);
