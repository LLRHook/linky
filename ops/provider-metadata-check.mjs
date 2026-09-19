import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Stage-one preview control: fetch each provider's HTML the way Discord's crawler would and decide
 * whether the returned metadata would satisfy Linky's own preview check. This isolates provider
 * metadata from Discord's embed generation and from client playback, which stay separate observations.
 */
const CRAWLER_UA = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)';
const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
export const EXPECTATIONS = ['video', 'image', 'text', 'unavailable'];

const decode = value => value.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, name) =>
  ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': '\'', '#x27': '\'' })[name]);

/** Read Open Graph and Twitter card tags in either attribute order; the first value of a name wins. */
export function readMetadata(html) {
  const tags = new Map();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (!name || content === undefined || tags.has(name)) continue;
    tags.set(name, decode(content));
  }
  return tags;
}

/** Shape provider metadata like the Discord embed Linky would inspect. Discord's own rules can still differ. */
export function embedFromMetadata(tags, fetchedUrl) {
  const pick = (...names) => names.map(name => tags.get(name)).find(value => value?.trim());
  const video = pick('og:video', 'og:video:url', 'og:video:secure_url', 'twitter:player:stream');
  const image = pick('og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image');
  return {
    url: pick('og:url') ?? fetchedUrl,
    ...(pick('og:title', 'twitter:title') ? { title: pick('og:title', 'twitter:title') } : {}),
    ...(pick('og:description', 'twitter:description') ? { description: pick('og:description', 'twitter:description') } : {}),
    ...(video ? { video: { url: video } } : {}),
    ...(image ? { thumbnail: { url: image } } : {}),
  };
}

async function fetchProvider(url, { fetch: fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetchImpl(current, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': CRAWLER_UA, accept: 'text/html' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get('location');
      if (!next || !/^https:\/\//i.test(next)) return { status: response.status, url: current, html: '', redirectRejected: true };
      current = next;
      continue;
    }
    const body = await response.arrayBuffer();
    return { status: response.status, url: current, html: Buffer.from(body.slice(0, MAX_BYTES)).toString('utf8'), truncated: body.byteLength > MAX_BYTES };
  }
  return { status: 0, url: current, html: '', redirectRejected: true };
}

/**
 * Check every catalog provider for one source link. `satisfied` means Linky's own matcher would accept the
 * metadata as this post's preview; `expectationMet` means the corpus author's media expectation also holds.
 */
export async function assessSource(entry, services, options = {}) {
  const { getProviderCandidates, expectedPreviews, inspectPreviews } = services;
  const candidates = getProviderCandidates(entry.source);
  const results = [];
  for (const candidate of candidates) {
    const expected = expectedPreviews(entry.source, candidate.url);
    const started = Date.now();
    let outcome;
    try {
      const response = await fetchProvider(candidate.url, options);
      const embed = embedFromMetadata(readMetadata(response.html), response.url);
      const inspection = inspectPreviews([embed], expected);
      const media = embed.video ? 'video' : embed.thumbnail ? 'image' : 'none';
      const expectationMet = entry.expect === 'unavailable' ? !inspection.ok
        : inspection.ok && (entry.expect === 'video' ? media === 'video' : entry.expect === 'image' ? media !== 'none' : true);
      outcome = { status: response.status, ms: Date.now() - started, recognized: expected.length === 1, satisfied: inspection.ok,
        media, embedUrl: embed.url, expectationMet, ...(response.redirectRejected ? { redirectRejected: true } : {}),
        ...(response.truncated ? { truncated: true } : {}) };
    } catch (error) {
      outcome = { status: 0, ms: Date.now() - started, recognized: expected.length === 1, satisfied: false, media: 'none',
        expectationMet: entry.expect === 'unavailable', error: error?.name === 'TimeoutError' ? 'timeout' : 'fetch_failed' };
    }
    results.push({ providerId: candidate.providerId, url: candidate.url, ...outcome });
  }
  return { source: entry.source, platform: candidates[0]?.platform ?? 'unrecognized', expect: entry.expect,
    ...(entry.note ? { note: entry.note } : {}), providers: results,
    ok: entry.expect === 'unavailable' ? results.every(result => !result.satisfied) : results.some(result => result.expectationMet) };
}

export function summarize(assessments, now = new Date()) {
  const platforms = {};
  for (const item of assessments) {
    const bucket = platforms[item.platform] ??= { sources: 0, ok: 0, providers: 0, satisfied: 0, expectationMet: 0, errors: 0, latenciesMs: [] };
    bucket.sources++; bucket.ok += Number(item.ok);
    for (const provider of item.providers) {
      bucket.providers++; bucket.satisfied += Number(provider.satisfied); bucket.expectationMet += Number(provider.expectationMet);
      bucket.errors += Number(Boolean(provider.error) || provider.status >= 400 || provider.status === 0);
      if (!provider.error) bucket.latenciesMs.push(provider.ms);
    }
  }
  for (const bucket of Object.values(platforms)) {
    const sorted = bucket.latenciesMs.sort((a, b) => a - b);
    bucket.medianMs = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
    bucket.maxMs = sorted.length ? sorted.at(-1) : null;
    delete bucket.latenciesMs;
  }
  return { checkedAt: now.toISOString(), scope: 'provider-metadata-only', platforms, sources: assessments,
    notes: ['A satisfied provider means its HTML metadata would pass Linky\'s preview matcher if Discord relayed it unchanged.',
      'This does not observe Discord\'s embed generation, its proxying of media, or playback on any client.',
      'Providers are fetched with Discord\'s crawler user agent from this machine; hosted results can differ by network.'] };
}

export function formatSummary(report) {
  const lines = [`Provider metadata check ${report.checkedAt} (metadata only; no Discord or playback observation)`];
  for (const [platform, bucket] of Object.entries(report.platforms)) {
    lines.push(`${platform}: ${bucket.ok}/${bucket.sources} sources met their expectation; ${bucket.satisfied}/${bucket.providers} provider responses satisfied Linky; ` +
      `${bucket.errors} errors; median ${bucket.medianMs ?? '-'} ms, max ${bucket.maxMs ?? '-'} ms.`);
  }
  for (const item of report.sources) {
    lines.push(`${item.ok ? 'ok  ' : 'FAIL'} ${item.platform} expect=${item.expect} ${item.source}${item.note ? ` (${item.note})` : ''}`);
    for (const provider of item.providers) {
      const detail = provider.error ?? `http ${provider.status}`;
      lines.push(`      ${provider.providerId}: ${detail}, ${provider.ms} ms, media=${provider.media}, satisfied=${provider.satisfied}` +
        `${provider.redirectRejected ? ', redirect rejected' : ''}${provider.embedUrl && provider.embedUrl !== provider.url ? `, og:url ${provider.embedUrl}` : ''}`);
    }
  }
  return lines.join('\n') + '\n';
}

export function parseCorpus(text) {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw Error('corpus_not_array');
  return parsed.map(entry => {
    if (typeof entry?.source !== 'string' || !EXPECTATIONS.includes(entry.expect)) throw Error('corpus_entry_invalid');
    return { source: entry.source, expect: entry.expect, ...(typeof entry.note === 'string' ? { note: entry.note } : {}) };
  });
}

export async function runProviderMetadataCheck(args, { write = text => process.stdout.write(text), services, fetch: fetchImpl } = {}) {
  try {
    let corpus = 'ops/preview-corpus.json', json = false, timeoutMs = 15_000;
    const links = [];
    for (let index = 0; index < args.length; index++) {
      const key = args[index];
      if (key === '--json') json = true;
      else if (key === '--corpus' || key === '--timeout') {
        const value = args[++index];
        if (!value || value.startsWith('--')) throw Error('invalid_args');
        if (key === '--corpus') corpus = value;
        else { if (!/^[1-9]\d{2,4}$/.test(value)) throw Error('invalid_args'); timeoutMs = Number(value); }
      } else if (/^https:\/\//.test(key)) links.push({ source: key, expect: 'text' });
      else throw Error('invalid_args');
    }
    const entries = links.length ? links : parseCorpus(await readFile(corpus, 'utf8'));
    const loaded = services ?? {
      ...(await import('../dist/services/SocialProviders.js')), ...(await import('../dist/services/PreviewRecovery.js')) };
    const assessments = [];
    for (const entry of entries) assessments.push(await assessSource(entry, loaded, { timeoutMs, ...(fetchImpl ? { fetch: fetchImpl } : {}) }));
    const report = summarize(assessments);
    write(json ? JSON.stringify(report) + '\n' : formatSummary(report));
    return assessments.every(item => item.ok) ? 0 : 1;
  } catch (error) {
    write(JSON.stringify({ error: 'provider_metadata_check_failed', reason: error?.message ?? 'unknown',
      usage: 'npm run check:providers -- [--corpus ops/preview-corpus.json] [--json] [--timeout MS] [https://... ...]; run npm run build first' }) + '\n');
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runProviderMetadataCheck(process.argv.slice(2));
}
