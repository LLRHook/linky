import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import 'dotenv/config';
import { createDeliveryReport } from './delivery-report.mjs';

const DAY = 86_400_000;
const day = value => new Date(value).toISOString().slice(0, 10);

/** The existing statistics engine is shared with the seven-day Details report; its gates are unchanged. */
export function createArchiveReport(input, options = {}) {
  const now = options.now ?? Date.now(), days = options.days ?? 7, since = now - days * DAY;
  const unique = new Map(); let duplicates = 0, conflictingDuplicates = 0;
  for (const row of input.rows) {
    if (row.startedAt < since || row.startedAt > now) continue;
    const previous = unique.get(row.id);
    if (previous) {
      duplicates++;
      if (JSON.stringify(previous) !== JSON.stringify(row)) conflictingDuplicates++;
    } else unique.set(row.id, row);
  }
  const rows = [...unique.values()].map(row => ({ ...row, path: row.path ?? 'unknown', cache: row.cache ?? 'unknown' }));
  const base = createDeliveryReport(rows);
  const grouped = field => Object.fromEntries([...new Set(rows.map(row => row[field]))].sort().map(value => {
    const selected = rows.filter(row => row[field] === value), report = createDeliveryReport(selected);
    return [value, { attempts: selected.length, outcomes: report.counts.outcome, latency: report.latency,
      confirmation: confirmation(selected) }];
  }));
  const expectedDays = [];
  for (let date = Date.parse(`${day(since)}T00:00:00Z`); date <= now; date += DAY) expectedDays.push(day(date));
  const observed = input.health?.observedDays ?? [];
  const missingDays = expectedDays.filter(value => !observed.some(entry => entry.day === value));
  const counters = input.health?.counters ?? null;
  const retentionBoundary = input.health ? Date.parse(`${day(now - input.health.retentionDays * DAY)}T00:00:00Z`) + DAY : null;
  const warnings = [];
  if (!input.health) warnings.push('coverage_unknown');
  if (missingDays.length) warnings.push('missing_observed_days');
  if (input.scanLimited) warnings.push('scan_limited');
  if (input.readErrors || input.invalidLines) warnings.push('unreadable_or_invalid_records');
  if (conflictingDuplicates) warnings.push('conflicting_duplicate_attempts');
  if (counters?.capacityFiles) warnings.push('capacity_evictions_recorded');
  if (counters && (counters.queueDrops || counters.invalidDrops || counters.closedDrops || counters.writeErrors ||
    counters.readErrors || counters.invalidLines || counters.closeTimeouts)) warnings.push('archive_loss_or_io_errors_recorded');
  if (input.health && input.health.firstStartedAt > since) warnings.push('archive_started_inside_window');
  if (input.health && input.health.updatedAt < now - 5 * 60_000) warnings.push('archive_heartbeat_stale');
  if (retentionBoundary !== null && since < retentionBoundary) warnings.push('requested_window_exceeds_retention');
  return { ...base, scope: 'operator-local-archive', confirmation: confirmation(rows),
    byPlatform: grouped('platform'), byPath: grouped('path'),
    coverage: { requestedDays: days, since: new Date(since).toISOString(), until: new Date(now).toISOString(),
      firstAttemptAt: rows.length ? new Date(rows.reduce((min, row) => Math.min(min, row.startedAt), Infinity)).toISOString() : null,
      lastAttemptAt: rows.length ? new Date(rows.reduce((max, row) => Math.max(max, row.startedAt), 0)).toISOString() : null,
      observedDays: observed.filter(entry => expectedDays.includes(entry.day)), missingDays,
      duplicatesIgnored: duplicates, conflictingDuplicates, readErrors: input.readErrors, invalidLines: input.invalidLines,
      archiveRetentionDays: input.health?.retentionDays ?? null, archiveMaxBytes: input.health?.maxBytes ?? null,
      retentionBoundaryAt: retentionBoundary === null ? null : new Date(retentionBoundary).toISOString(),
      lifetimeHealth: counters, warnings },
    notes: [...base.notes,
      'Confirmation is confirmed attempts divided by all recorded finalized attempts in this window, including partial, disabled, cancelled and interrupted outcomes. It is not a playback success rate.',
      'Only instrumented attempts are counted. Ignored messages and uninstrumented paths are absent; this is not a count of all links posted.',
      'Observed days mean an archive heartbeat was recorded on that UTC day, not uninterrupted coverage. Missing days can mean downtime, expiry or unavailable health history.',
      'Health counters cover the archive lifetime, not just this report window. Capacity eviction can shorten retention; nonzero loss counters make totals a lower bound.',
      'Stage latency uses the sum of same-named spans per completed attempt. Stage outcome counts include all archived spans, including interrupted attempts.'],
    stages: Object.fromEntries(Object.entries(base.stages).map(([stage, value]) => {
      const spans = rows.flatMap(row => row.stages.filter(span => span.stage === stage));
      return [stage, { ...value, spanSamples: spans.length,
        outcomes: Object.fromEntries(['ok', 'unavailable', 'busy', 'timeout', 'cancelled', 'failed'].map(outcome =>
          [outcome, spans.filter(span => span.outcome === outcome).length])) }];
    })),
  };
}

function confirmation(rows) {
  const confirmed = rows.filter(row => row.outcome === 'confirmed').length;
  return { confirmed, denominator: rows.length, rate: rows.length ? confirmed / rows.length : null,
    denominatorDefinition: 'all recorded finalized attempts in the selected time window', playbackVerified: false };
}

export function formatArchiveReport(report) {
  const latency = value => `n=${value.samples}, median=${value.medianMs ?? 'n/a'} ms, p95=${value.p95Ms ?? 'n/a'} ms`;
  const c = report.confirmation;
  const lines = [`Linky delivery report: ${report.coverage.since} to ${report.coverage.until}`,
    `Recorded finalized attempts: ${c.denominator}. Confirmed previews: ${c.confirmed}/${c.denominator}${c.rate === null ? '' : ` (${(100 * c.rate).toFixed(1)}%)`}.`,
    `Elapsed (completed attempts): ${latency(report.latency.allCompleted)}`,
    `Elapsed (confirmed attempts): ${latency(report.latency.confirmed)}`,
    `Cache observations: hit=${report.counts.cache.hit}, miss=${report.counts.cache.miss}, unknown=${report.counts.cache.unknown}.`,
    'Outcomes: ' + Object.entries(report.counts.outcome).filter(([, count]) => count).map(([key, count]) => `${key}=${count}`).join(', '),
    ...['byPlatform', 'byPath'].flatMap(field => Object.entries(report[field]).map(([key, value]) =>
      `${field === 'byPlatform' ? 'Platform' : 'Path'} ${key}: ${value.confirmation.confirmed}/${value.attempts} confirmed; ${latency(value.latency.allCompleted)}; ` +
      Object.entries(value.outcomes).filter(([, count]) => count).map(([outcome, count]) => `${outcome}=${count}`).join(', '))),
    ...Object.entries(report.stages).filter(([, value]) => value.spanSamples).map(([key, value]) =>
      `Stage ${key}: ${latency(value)}; spans=${value.spanSamples}; ` +
      Object.entries(value.outcomes).filter(([outcome, count]) => outcome !== 'ok' && count).map(([outcome, count]) => `${outcome}=${count}`).join(', ')),
    `Missing UTC day markers: ${report.coverage.missingDays.join(', ') || 'none'}. Duplicate UUIDs ignored: ${report.coverage.duplicatesIgnored}.`,
    `Coverage warnings: ${report.coverage.warnings.join(', ') || 'none detected'}.`,
    ...report.notes,
  ];
  return lines.join('\n') + '\n';
}

export async function runArchiveReport(args, write = value => process.stdout.write(value), read) {
  try {
    let days = 7, json = false;
    let directory = join(dirname(process.env.LINK_SETTINGS_PATH?.trim() || 'data/servers.json'), 'delivery-logs');
    const seen = new Set();
    for (let index = 0; index < args.length; index++) {
      const key = args[index];
      if (!['--days', '--json', '--directory'].includes(key) || seen.has(key)) throw Error('invalid_args');
      seen.add(key);
      if (key === '--json') json = true;
      else {
        const value = args[++index];
        if (!value || value.startsWith('--')) throw Error('invalid_args');
        if (key === '--directory') directory = value;
        else {
          if (!/^[1-9]\d?$/.test(value) || Number(value) > 90) throw Error('invalid_args');
          days = Number(value);
        }
      }
    }
    const reader = read ?? (await import('../dist/services/DeliveryArchive.js')).readDeliveryArchive;
    const report = createArchiveReport(await reader(directory), { days });
    write(json ? JSON.stringify(report) + '\n' : formatArchiveReport(report));
    return report.coverage.readErrors || report.coverage.invalidLines || report.coverage.warnings.includes('scan_limited') ? 1 : 0;
  } catch {
    write(JSON.stringify({ error: 'archive_report_failed', usage: 'npm run report:deliveries -- --days 7 [--json] [--directory PATH]; run npm run build first' }) + '\n');
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runArchiveReport(process.argv.slice(2));
}
