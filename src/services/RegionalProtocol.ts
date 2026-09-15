import { createHmac, timingSafeEqual } from 'node:crypto';

export const REGIONAL_PROTOCOL_VERSION = 3;
export const REGIONAL_REGIONS = ['iad1', 'fra1', 'lhr1', 'cle1', 'sfo1', 'cdg1', 'dub1', 'pdx1', 'yul1', 'local'] as const;
export const REGIONAL_ROUTES = ['/api/iad', '/api/fra', '/api/lhr', '/api/cle', '/api/sfo', '/api/cdg', '/api/dub', '/api/pdx', '/api/yul'] as const;
export const REGIONAL_CLAIM_PATH = '/internal/regional/claim';
export const REGIONAL_SIGNATURE_HEADER = 'x-linky-signature';
export const MAX_REGIONAL_BYTES = 24 * 1024 * 1024;
export const MAX_REGIONAL_PART_BYTES = 4 * 1024 * 1024;
export const REGIONAL_DEADLINE_MS = 8_000;
export const REGIONAL_JOB_TTL_MS = 30_000;
export const REGIONAL_CLOCK_SKEW_MS = 5_000;
export const MAX_REGIONAL_JOB_BYTES = 4096;

export type RegionalJob = {
  v: typeof REGIONAL_PROTOCOL_VERSION; id: string; part: number; source: string; album: string; etag: string;
  bytes: number; issuedAt: number; expiresAt: number;
};
export type RegionalRange = { start: number; end: number; length: number };

export function isEromeMediaUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2048 &&
    /^https:\/\/v[0-9]{1,4}\.erome\.com\/(?:[A-Za-z0-9_-]{1,128}\/){0,5}[A-Za-z0-9_-]{1,128}\.mp4$/.test(value);
}

export function isCanonicalEromeAlbum(value: unknown): value is string {
  return typeof value === 'string' && /^https:\/\/www\.erome\.com\/a\/[A-Za-z0-9_]{1,64}$/.test(value);
}

export function isStrongEtag(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 512 && /^"[\x21\x23-\x7e]*"$/.test(value);
}

export function regionalRange(bytes: number, part: number): RegionalRange | null {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_REGIONAL_BYTES ||
      !Number.isInteger(part) || part < 0 || part >= REGIONAL_REGIONS.length) return null;
  const width = Math.ceil(bytes / REGIONAL_REGIONS.length), start = part * width;
  if (start >= bytes) return null;
  const end = Math.min(start + width, bytes) - 1;
  return { start, end, length: end - start + 1 };
}

export function serializeRegionalJob(job: RegionalJob): string {
  const { v, id, part, source, album, etag, bytes, issuedAt, expiresAt } = job;
  return JSON.stringify({ v, id, part, source, album, etag, bytes, issuedAt, expiresAt });
}

export function parseRegionalJob(raw: string, now = Date.now()): RegionalJob | null {
  if (Buffer.byteLength(raw) > MAX_REGIONAL_JOB_BYTES) return null;
  let job: RegionalJob;
  try { job = JSON.parse(raw) as RegionalJob; } catch { return null; }
  if (!job || typeof job !== 'object' || Array.isArray(job) ||
      Object.keys(job).sort().join(',') !== 'album,bytes,etag,expiresAt,id,issuedAt,part,source,v' ||
      job.v !== REGIONAL_PROTOCOL_VERSION || typeof job.id !== 'string' || !/^[a-f0-9]{32}$/.test(job.id) ||
      !isEromeMediaUrl(job.source) || !isCanonicalEromeAlbum(job.album) || !isStrongEtag(job.etag) ||
      !regionalRange(job.bytes, job.part) || !Number.isSafeInteger(job.issuedAt) || !Number.isSafeInteger(job.expiresAt) ||
      job.issuedAt < now - REGIONAL_JOB_TTL_MS || job.issuedAt > now + REGIONAL_CLOCK_SKEW_MS ||
      job.expiresAt <= now || job.expiresAt <= job.issuedAt || job.expiresAt - job.issuedAt > REGIONAL_JOB_TTL_MS ||
      serializeRegionalJob(job) !== raw) return null;
  return job;
}

export function validRegionalKey(key: unknown): key is string {
  return typeof key === 'string' && /^[\x21-\x7e]{32,512}$/.test(key);
}

function mac(raw: string, route: string, key: string, purpose: 'job' | 'claim'): string {
  if (!validRegionalKey(key)) throw new Error('regional_configuration');
  return createHmac('sha256', key).update(`linky-regional-${purpose}-v${REGIONAL_PROTOCOL_VERSION}\nPOST\n${route}\n`).update(raw).digest('hex');
}

export function signRegionalJob(raw: string, route: string, key: string): string {
  return mac(raw, route, key, 'job');
}

export function signRegionalClaim(raw: string, key: string): string {
  return mac(raw, REGIONAL_CLAIM_PATH, key, 'claim');
}

function matches(expected: string, supplied: string | null): boolean {
  return typeof supplied === 'string' && /^[a-f0-9]{64}$/.test(supplied) &&
    timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(supplied, 'hex'));
}

export function verifyRegionalJob(raw: string, route: string, signature: string | null, key: string): boolean {
  return validRegionalKey(key) && matches(signRegionalJob(raw, route, key), signature);
}

export function verifyRegionalClaim(raw: string, signature: string | null, key: string): boolean {
  return validRegionalKey(key) && matches(signRegionalClaim(raw, key), signature);
}
