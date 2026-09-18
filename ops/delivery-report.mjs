import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 4 * 1024 * 1024, MAX_ATTEMPTS = 4096, MAX_DURATION = 86_400_000;
const PLATFORMS = ['x', 'instagram', 'tiktok', 'bluesky', 'reddit', 'twitch', 'youtube', 'erome', 'mixed'];
const PATHS = ['native', 'explicit', 'hosted-original', 'attachment', 'album'];
const OUTCOMES = ['confirmed', 'partial', 'unsupported', 'unavailable', 'permission', 'disabled', 'busy', 'timeout',
  'discord-failure', 'metadata-unconfirmed', 'cancelled', 'interrupted', 'internal-failure'];
const STAGES = ['queue', 'resolve', 'download', 'inspect', 'convert', 'store', 'publish', 'preview', 'ownership'];
const STAGE_OUTCOMES = ['ok', 'unavailable', 'busy', 'timeout', 'cancelled', 'failed'];
const CACHE = ['hit', 'miss'];
const ID = /^\d{17,20}$/, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROOT_FIELDS = ['version', 'attempts'];
const FIELDS = ['id', 'requesterId', 'channelId', 'guildId', 'mode', 'platform', 'startedAt',
  'messageId', 'path', 'outcome', 'durationMs', 'stages', 'cache'];
const SPAN_FIELDS = ['stage', 'durationMs', 'outcome', 'itemIndex'];
class ReportError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new ReportError(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const finiteDuration = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_DURATION;
const optional = (value, test) => value === undefined || test(value);
const oneOf = allowed => value => typeof value === 'string' && allowed.includes(value);
const id = value => typeof value === 'string' && ID.test(value);

/** Strictly validate the local schema, then discard all identity fields before aggregation. */
function decode(content) {
  let data;
  try { data = JSON.parse(content); } catch { fail('invalid_json'); }
  if (!fields(data, ROOT_FIELDS) || data.version !== 1 || !Array.isArray(data.attempts) || data.attempts.length > MAX_ATTEMPTS) fail('invalid_schema');
  const seen = new Set();
  return data.attempts.map(record => {
    if (!fields(record, FIELDS) || typeof record.id !== 'string' || !UUID.test(record.id) || seen.has(record.id) ||
        !id(record.requesterId) || !id(record.channelId) || !optional(record.guildId, id) || !optional(record.messageId, id) ||
        !['automatic', 'manual'].includes(record.mode) || !oneOf(PLATFORMS)(record.platform) ||
        !Number.isSafeInteger(record.startedAt) || record.startedAt < 0 || record.startedAt > 8_640_000_000_000_000 ||
        !optional(record.path, oneOf(PATHS)) || !optional(record.outcome, oneOf(OUTCOMES)) ||
        !optional(record.cache, oneOf(CACHE)) || !optional(record.durationMs, finiteDuration) ||
        !Array.isArray(record.stages) || record.stages.length > 96) fail('invalid_schema');
    seen.add(record.id);
    const stages = record.stages.map(span => {
      if (!fields(span, SPAN_FIELDS) || !oneOf(STAGES)(span.stage) || !oneOf(STAGE_OUTCOMES)(span.outcome) ||
          !finiteDuration(span.durationMs) || !optional(span.itemIndex, value => Number.isInteger(value) && value >= 0 && value <= 100)) fail('invalid_schema');
      return { stage: span.stage, durationMs: span.durationMs, outcome: span.outcome };
    });
    return { platform: record.platform, path: record.path ?? 'unknown', outcome: record.outcome ?? 'pending',
      cache: record.cache ?? 'unknown', startedAt: record.startedAt, durationMs: record.durationMs, stages };
  });
}

export async function readDeliveryHistory(path) {
  let handle;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail('invalid_file');
    if (before.size > MAX_BYTES) fail('too_large');
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.dev !== before.dev || info.ino !== before.ino) fail('invalid_file');
    if (info.size > MAX_BYTES) fail('too_large');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > MAX_BYTES) fail('too_large');
    return decode(buffer.subarray(0, total).toString('utf8'));
  } catch (error) {
    throw error instanceof ReportError ? error : new ReportError('read_failed');
  } finally { await handle?.close().catch(() => {}); }
}

const count = (rows, field, values) => Object.fromEntries(values.map(value => [value, rows.filter(row => row[field] === value).length]));
function statistics(values) {
  const ordered = [...values].sort((a, b) => a - b), size = ordered.length;
  return { samples: size, medianMs: size ? (ordered[Math.floor((size - 1) / 2)] + ordered[Math.floor(size / 2)]) / 2 : null,
    p95Ms: size ? ordered[Math.ceil(size * 0.95) - 1] : null };
}
const completed = row => row.outcome !== 'pending' && row.outcome !== 'interrupted' && finiteDuration(row.durationMs);

export function createDeliveryReport(rows, options = {}) {
  const selected = rows.filter(row => (options.since === undefined || row.startedAt >= options.since) &&
    (!options.platform || row.platform === options.platform) && (!options.path || row.path === options.path) &&
    (!options.cache || row.cache === options.cache));
  const done = selected.filter(completed);
  const requirements = (options.require ?? []).map(item => {
    const observed = selected.filter(row => row.platform === item.platform && row.outcome === item.outcome &&
      (row.outcome === 'interrupted' || completed(row))).length;
    return { platform: item.platform, outcome: item.outcome, minimum: item.minimum, observed, met: observed >= item.minimum };
  });
  const rejected = (options.reject ?? []).map(outcome => {
    const observed = selected.filter(row => row.outcome === outcome).length;
    return { outcome, observed, met: observed === 0 };
  });
  const minimum = options.minCompleted ?? 0;
  const requested = minimum > 0 || requirements.length > 0 || rejected.length > 0;
  const passed = done.length >= minimum && requirements.every(item => item.met) && rejected.every(item => item.met);
  return { version: 1, scope: 'selected-local-history', playbackVerified: false,
    samples: { available: rows.length, selected: selected.length, completed: done.length,
      pending: selected.filter(row => row.outcome === 'pending').length, interrupted: selected.filter(row => row.outcome === 'interrupted').length },
    counts: { platform: count(selected, 'platform', PLATFORMS), path: count(selected, 'path', [...PATHS, 'unknown']),
      outcome: count(selected, 'outcome', [...OUTCOMES, 'pending']), cache: count(selected, 'cache', [...CACHE, 'unknown']) },
    latency: { allCompleted: statistics(done.map(row => row.durationMs)),
      confirmed: statistics(done.filter(row => row.outcome === 'confirmed').map(row => row.durationMs)) },
    stages: Object.fromEntries(STAGES.map(stage => {
      const values = done.flatMap(row => {
        const matching = row.stages.filter(span => span.stage === stage);
        return matching.length ? [matching.reduce((sum, span) => sum + span.durationMs, 0)] : [];
      });
      return [stage, { ...statistics(values), outcomes: count(done.flatMap(row => row.stages.filter(span => span.stage === stage)), 'outcome', STAGE_OUTCOMES) }];
    })),
    checks: { requested, passed: requested ? passed : null,
      minimumCompleted: { required: minimum, observed: done.length, met: done.length >= minimum }, requirements, rejected },
    notes: ['Descriptive statistics of this selected local sample, not representative production percentiles. Small-sample p95 may equal the maximum.',
      'p95 uses nearest rank. Stage durations sum same-named spans per completed attempt; different stages can overlap.',
      'Confirmed records the delivery check for that path, such as preview metadata or delivered text. Playback needs a separate client check.'] };
}

function argumentsFor(args) {
  const options = { file: 'data/delivery-diagnostics.json', require: [], reject: [] }, singles = new Set();
  const known = ['--file', '--since', '--min-completed', '--platform', '--path', '--cache', '--require', '--reject-outcome'];
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!known.includes(flag) || typeof value !== 'string' || !value || value.startsWith('--')) fail('invalid_args');
    if (!['--require', '--reject-outcome'].includes(flag)) {
      if (singles.has(flag)) fail('invalid_args'); singles.add(flag);
    }
    if (flag === '--file') options.file = value;
    else if (flag === '--since') {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) fail('invalid_args');
      const [year, month, day, hour, minute, second] = value.slice(0, 19).split(/\D/).map(Number);
      const calendar = new Date(0); calendar.setUTCFullYear(year, month - 1, day); calendar.setUTCHours(hour, minute, second, 0);
      if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day ||
          hour > 23 || minute > 59 || second > 59) fail('invalid_args');
      options.since = Date.parse(value);
      if (!Number.isSafeInteger(options.since) || options.since < 0) fail('invalid_args');
    } else if (flag === '--min-completed') {
      if (!/^(?:0|[1-9]\d{0,3})$/.test(value) || Number(value) > MAX_ATTEMPTS) fail('invalid_args');
      options.minCompleted = Number(value);
    } else if (flag === '--require') {
      const [platform, outcome, minimum = '1', extra] = value.split(':');
      if (extra !== undefined || !PLATFORMS.includes(platform) || !OUTCOMES.includes(outcome) ||
          !/^[1-9]\d{0,3}$/.test(minimum) || Number(minimum) > MAX_ATTEMPTS || options.require.length >= 32) fail('invalid_args');
      options.require.push({ platform, outcome, minimum: Number(minimum) });
    } else if (flag === '--reject-outcome') {
      if (![...OUTCOMES, 'pending'].includes(value) || options.reject.includes(value)) fail('invalid_args');
      options.reject.push(value);
    } else {
      const field = flag.slice(2), allowed = { platform: PLATFORMS, path: PATHS, cache: [...CACHE, 'unknown'] }[field];
      if (!allowed.includes(value)) fail('invalid_args'); options[field] = value;
    }
  }
  return options;
}

export async function runDeliveryReport(args, write = line => process.stdout.write(line)) {
  try {
    const options = argumentsFor(args), rows = await readDeliveryHistory(options.file), report = createDeliveryReport(rows, options);
    write(JSON.stringify(report) + '\n');
    return report.checks.passed === false ? 1 : 0;
  } catch (error) {
    write(JSON.stringify({ error: error instanceof ReportError ? error.code : 'report_failed' }) + '\n'); return 2;
  }
}

if (process.argv[1] === '-' || process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runDeliveryReport(process.argv.slice(2));
}
