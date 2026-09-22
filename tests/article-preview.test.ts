import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { RequestOptions } from 'node:https';
import { createArticleLookup, findArticleLinks, formatArticlePreview, parseArticleUrl,
  type ArticleLookupOptions } from '../src/services/ArticlePreview';

const source = 'https://publisher.com/news/story';
const html = (head = '<meta property="og:type" content="article"><meta property="og:title" content="A story">') =>
  `<!doctype html><html><head>${head}</head><body>Do not extract this article body.</body></html>`;
const response = (body = html(), headers: Record<string, string> = {}) => new Response(body, {
  headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
});
const fixture = (connect: NonNullable<ArticleLookupOptions['connect']> = async () => response(), options: ArticleLookupOptions = {}) => {
  const calls: RequestOptions[] = [];
  const lookup = createArticleLookup({ resolve4: async () => ['1.1.1.1'], ...options,
    connect: async (settings, signal) => { calls.push(settings); return connect(settings, signal); } });
  return { lookup, calls };
};

test('article candidates normalize only HTTPS host syntax and discard fragments', () => {
  assert.equal(parseArticleUrl('https://Publisher.COM/news/story?ref=one#section'), 'https://publisher.com/news/story?ref=one');
  assert.equal(parseArticleUrl('https://publisher.com'), 'https://publisher.com/');
  for (const value of [
    'http://publisher.com/a', 'https://user:pass@publisher.com/a', 'https://publisher.com:443/a', 'https://publisher.com:80/a',
    'https://127.0.0.1/a', 'https://2130706433/a', 'https://0x7f000001/a', 'https://[::1]/a', 'https://publisher.com./a',
    'https://localhost/a', 'https://metadata.google.internal/a', 'https://printer.local/a', 'https://server.lan/a',
    'https://publisher.com/a/../b', 'https://publisher.com/%2e%2e/a', 'https://publisher.com\\@evil.com/a',
    'https://publísher.com/a', 'https://publisher.com/a\n', 'https://publisher.com/' + 'a'.repeat(500),
    'https://publisher.com/api/article', 'https://publisher.com/wp-admin/edit', 'https://publisher.com/login',
  ]) assert.equal(parseArticleUrl(value), null, value);
});

test('social platforms and all provider aliases including arbitrary subdomains are excluded', () => {
  for (const host of ['x.com', 'twitter.com', 't.co', 'instagram.com', 'tiktok.com', 'bsky.app', 'reddit.com', 'redd.it',
    'youtube.com', 'youtu.be', 'twitch.tv', 'erome.com', 'discord.com', 'discord.gg', 'fixupx.com', 'vxtwitter.com', 'fixvx.com',
    'instagram7.com', 'oginstagram.com', 'tnktok.com', 'bskx.app', 'fxbsky.app', 'vxreddit.com', 'fxtwitch.seria.moe']) {
    assert.equal(parseArticleUrl(`https://${host}/article/news`), null, host);
    assert.equal(parseArticleUrl(`https://anything.${host}/article/news`), null, host);
  }
  assert.equal(parseArticleUrl('https://notyoutube.com/article/story'), 'https://notyoutube.com/article/story');
});

test('visible article links deduplicate with a bounded over-limit sentinel and honor opt-out', () => {
  assert.deepEqual(findArticleLinks(`**${source}#one** ${source}#two <https://hidden.com/a> ||https://spoiler.com/a|| \`https://code.com/a\``), [source]);
  assert.deepEqual(findArticleLinks(`${source} !nolinky`), []);
  const links = Array.from({ length: 7 }, (_, i) => `https://publisher.com/a${i}`);
  assert.deepEqual(findArticleLinks(links.join(' ')), links.slice(0, 3));
  assert.deepEqual(findArticleLinks(links.join(' '), 4), links.slice(0, 4));
  assert.deepEqual(findArticleLinks(links.join(' '), 99), links.slice(0, 4));
});

test('publisher metadata produces a compact attributed card without extracting body prose', async () => {
  const f = fixture(async () => response(html(`
    <meta property='og:type' content='article'>
    <meta content='Research &amp; evidence &#x1f4da;' property='og:title'>
    <meta name=description content='A public summary &hellip;'>
    <meta property='og:site_name' content='Publisher Institute'>
    <meta property='og:image' content='https://images.publisher.com/story.jpg'>
    <meta property='article:published_time' content='2025-10-23T11:00:53+00:00'>
    <link href='/news/canonical' rel='canonical'>`)));
  const article = await f.lookup(source + '#section');
  assert.deepEqual(article, { source, url: 'https://publisher.com/news/canonical', title: 'Research & evidence 📚',
    publisher: 'Publisher Institute', description: 'A public summary …', image: 'https://images.publisher.com/story.jpg',
    publishedAt: '2025-10-23T11:00:53.000Z' });
  assert.deepEqual(formatArticlePreview(article!), [{ title: 'Research & evidence 📚', url: article!.url,
    author: { name: 'Publisher: Publisher Institute', url: 'https://publisher.com' },
    footer: { text: 'publisher.com · Article metadata' }, description: 'A public summary …',
    image: { url: 'https://images.publisher.com/story.jpg' }, timestamp: '2025-10-23T11:00:53.000Z' }]);
  assert.ok(!JSON.stringify(article).includes('Do not extract'));
});

test('an actual Manhattan Institute head shape supports article identity, description, and external image', async () => {
  const mi = 'https://manhattan.institute/article/the-fiscal-impact-of-immigration-2025-update';
  const f = fixture(async () => response(html(`<meta property="og:type" content="article">
    <meta property="og:title" content="The Fiscal Impact of Immigration (2025 Update)">
    <meta property="og:site_name" content="Manhattan Institute">
    <meta property="og:description" content="Publisher-provided report description [&hellip;]">
    <meta property="og:url" content="${mi}"><link rel="canonical" href="${mi}">
    <meta property="og:image" content="https://media4.manhattan-institute.org/wp-content/uploads/the-fiscal-impact-of-immigration-2025-update.jpg">`)));
  const result = await f.lookup(mi);
  assert.equal(result?.url, mi); assert.equal(result?.source, mi);
  assert.equal(result?.publisher, 'Manhattan Institute'); assert.ok(result?.image?.endsWith('.jpg'));
});

test('generic websites, body metadata, malformed metadata and script/comment/template spoofing stay untouched', async () => {
  const fake = '<meta property="og:type" content="article"><meta property="og:title" content="Spoof">';
  for (const body of [
    html('<title>A site</title><meta property="og:type" content="website">'),
    `<html><head><title>A site</title></head><body>${fake}</body></html>`,
    html(`<!-- ${fake} --><title>A site</title>`),
    html(`<script>const fake = '${fake}'</script><title>A site</title>`),
    html(`<style>/* ${fake} */</style><title>A site</title>`),
    html(`<template>${fake}</template><title>A site</title>`),
    html(`<noscript>${fake}</noscript><title>A site</title>`),
    html('<meta property="og:type" content="article">'),
    html('<script type="application/ld+json">not json</script>'),
  ]) assert.equal(await fixture(async () => response(body)).lookup(source), null, body);
});

test('bounded JSON-LD article requires Schema.org context, headline and matching page identity', async () => {
  const article = { '@type': 'NewsArticle', headline: 'Structured story', url: source,
    publisher: { name: 'Publisher' }, description: 'Only metadata', image: { url: '/story.png' }, datePublished: '2026-01-02' };
  const render = (value: unknown) => html(`<script type="application/ld+json">${JSON.stringify(value)}</script>`);
  for (const value of [{ '@context': 'https://schema.org', ...article },
    { '@context': 'http://schema.org', '@graph': [article] }, [{ '@context': 'https://schema.org/', ...article }]]) {
    const result = await fixture(async () => response(render(value))).lookup(source);
    assert.equal(result?.title, 'Structured story'); assert.equal(result?.image, 'https://publisher.com/story.png');
    assert.equal(result?.publishedAt, '2026-01-02T00:00:00.000Z');
  }
  for (const value of [article, { '@context': 'https://evil.com', ...article },
    { '@context': 'https://schema.org', ...article, url: 'https://evil.com/news/story' },
    { '@context': 'https://schema.org', ...article, url: 'https://publisher.com/other' },
    { '@context': 'https://schema.org', ...article, '@type': 'WebPage' },
    { '@context': 'https://schema.org', ...article, headline: '' }]) {
    assert.equal(await fixture(async () => response(render(value))).lookup(source), null);
  }
});

test('canonical and image metadata cannot substitute foreign, private, credentialed or service URLs', async () => {
  for (const bad of ['https://evil.com/other', 'http://publisher.com/news/story', 'https://publisher.com:443/news/story',
    'https://user@publisher.com/news/story', 'https://127.0.0.1/a']) {
    const result = await fixture(async () => response(html(`<meta property="og:type" content="article">
      <meta property="og:title" content="Story"><link rel="canonical" href="${bad}">`))).lookup(source);
    assert.equal(result?.url, source);
  }
  for (const image of ['http://images.com/a.jpg', 'https://127.0.0.1/a.jpg', 'https://user@images.com/a.jpg',
    'https://images.com:443/a.jpg', 'https://images.local/a.jpg', 'https://images.com/api/a.jpg', 'https://images.com/redirect']) {
    const result = await fixture(async () => response(html(`<meta property="og:type" content="article">
      <meta property="og:title" content="Story"><meta property="og:image" content="${image}">`))).lookup(source);
    assert.equal(result?.image, undefined, image);
  }
});

test('an unsafe image DNS answer removes only the image and never fetches image bytes', async () => {
  let dns = 0;
  const f = fixture(async () => response(html('<meta property="og:type" content="article"><meta property="og:title" content="Story"><meta property="og:image" content="https://image.com/a.jpg">')),
    { resolve4: async host => { dns++; return host === 'image.com' ? ['127.0.0.1'] : ['1.1.1.1']; } });
  const result = await f.lookup(source);
  assert.equal(result?.title, 'Story'); assert.equal(result?.image, undefined); assert.equal(dns, 2); assert.equal(f.calls.length, 1);
});

test('every redirect hop pins a fresh public DNS answer with verified TLS and no credentials', async () => {
  let dns = 0;
  const f = fixture(async settings => {
    const address = dns === 1 ? '1.1.1.1' : '8.8.8.8';
    assert.equal(settings.servername, settings.hostname); assert.equal(settings.rejectUnauthorized, true);
    assert.equal(settings.agent, false); assert.equal(settings.family, 4); assert.equal(settings.maxHeaderSize, 8192);
    settings.lookup!(String(settings.hostname), {}, (error, actual, family) => {
      assert.equal(error, null); assert.equal(actual, address); assert.equal(family, 4);
    });
    settings.lookup!(String(settings.hostname), { all: true }, (error, actual) => {
      assert.equal(error, null); assert.deepEqual(actual, [{ address, family: 4 }]);
    });
    const headers = new Headers(settings.headers as Record<string, string>);
    assert.equal(headers.get('accept-encoding'), 'identity');
    for (const name of ['cookie', 'authorization', 'referer']) assert.equal(headers.has(name), false);
    return dns === 1 ? new Response(null, { status: 302, headers: { location: '/news/final', 'set-cookie': 'ignored=1' } }) : response();
  }, { resolve4: async () => [++dns === 1 ? '1.1.1.1' : '8.8.8.8'] });
  const result = await f.lookup(source);
  assert.equal(result?.source, source); assert.equal(result?.url, 'https://publisher.com/news/final');
  assert.equal(dns, 2); assert.equal(f.calls.length, 2);
});

test('empty, mixed, private and excessive DNS answers reject before any connection', async () => {
  for (const addresses of [[], ['1.1.1.1', '10.0.0.1'], ['127.0.0.1'], ['169.254.169.254'], ['192.168.1.1'],
    ['172.16.0.1'], ['100.64.0.1'], ['198.18.0.1'], ['::1'], Array(33).fill('1.1.1.1') as string[]]) {
    const f = fixture(async () => assert.fail('Unsafe DNS cannot connect'), { resolve4: async () => addresses });
    assert.equal(await f.lookup(source), null); assert.equal(f.calls.length, 0);
  }
});

test('same-host redirect DNS rebinding is rejected on its second fresh validation', async () => {
  let dns = 0;
  const f = fixture(async () => new Response(null, { status: 301, headers: { location: '/news/final' } }),
    { resolve4: async () => [++dns === 1 ? '1.1.1.1' : '127.0.0.1'] });
  assert.equal(await f.lookup(source), null); assert.equal(dns, 2); assert.equal(f.calls.length, 1);
});

test('redirects to excluded social domains, private hosts, HTTP, explicit ports and cycles are refused', async () => {
  for (const location of ['https://www.youtube.com/post/Ug1234567890', 'https://www.erome.com/a/abc',
    'https://g.fixupx.com/article/one', 'https://127.0.0.1/a', 'http://publisher.com/a',
    'https://publisher.com:443/a', 'https://user@publisher.com/a', source]) {
    const f = fixture(async () => new Response(null, { status: 302, headers: { location } }));
    assert.equal(await f.lookup(source), null, location); assert.equal(f.calls.length, 1);
  }
  const f = fixture(async () => new Response(null, { status: 302, headers: { location: `/news/${f.calls.length}` } }));
  assert.equal(await f.lookup(source), null); assert.equal(f.calls.length, 4);
});

test('only successful identity-encoded HTML is parsed, never binary, login failure or compressed bytes', async () => {
  for (const reply of [new Response(html(), { status: 403 }), response(html(), { 'content-type': 'application/json' }),
    response(html(), { 'content-encoding': 'gzip' }), response(html(), { 'content-encoding': 'br' })]) {
    assert.equal(await fixture(async () => reply).lookup(source), null);
    assert.equal(reply.body?.locked, false);
  }
});

test('head reads cancel the stream immediately and oversized metadata cannot escape the byte budget', async () => {
  let cancelled = 0, pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { pulls++; controller.enqueue(Buffer.from(pulls === 1 ? html() : 'x'.repeat(10000))); },
    cancel() { cancelled++; },
  });
  const f = fixture(async () => new Response(stream, { headers: { 'content-type': 'text/html', 'content-length': '9000000' } }));
  assert.equal((await f.lookup(source))?.title, 'A story'); assert.equal(cancelled, 1); assert.ok(pulls <= 2);
  const oversized = html('<meta property="og:type" content="article">' + 'x'.repeat(512 * 1024));
  assert.equal(await fixture(async () => response(oversized)).lookup(source), null);
});

test('malformed UTF-8 and incomplete raw scripts fail closed', async () => {
  const bad = new Response(Uint8Array.from([0xc3, 0x28]), { headers: { 'content-type': 'text/html' } });
  assert.equal(await fixture(async () => bad).lookup(source), null);
  assert.equal(await fixture(async () => response(html('<script><meta property="og:type" content="article"><meta property="og:title" content="Spoof">'))).lookup(source), null);
});

test('adversarial missing assignments and unterminated quoted tags cannot block the event loop', async () => {
  for (const head of ['<meta ' + 'a'.repeat(500_000) + '>', '<meta '.repeat(80_000), '<meta content="' + '<meta a="'.repeat(40_000),
    '<meta ' + 'a'.repeat(16_000) + '>', '<meta content=' + 'a'.repeat(500_000)]) {
    const start = performance.now();
    assert.equal(await fixture(async () => response(`<head>${head}</head>`), { timeoutMs: 1 }).lookup(source), null);
    // The old unanchored attribute regex took >500ms at just 40KiB, and many
    // seconds for these inputs; leave generous room for loaded CI runners.
    assert.ok(performance.now() - start < 1000, 'Malformed metadata exceeded the CPU safety budget');
  }
});

test('shared lookups and defensive cache copies expire at their documented positive and negative TTLs', async () => {
  let now = 0, resolve!: (value: Response) => void;
  const f = fixture(async () => new Promise<Response>(done => { resolve = done; }), { now: () => now });
  const one = f.lookup(source), two = f.lookup(source);
  await delay(0); assert.equal(f.calls.length, 1); resolve(response());
  const [first, second] = await Promise.all([one, two]);
  assert.notEqual(first, second); first!.title = 'Mutated';
  assert.equal((await f.lookup(source))?.title, 'A story'); assert.equal(f.calls.length, 1);
  now = 300001;
  const refresh = f.lookup(source); await delay(0); assert.equal(f.calls.length, 2); resolve(response()); await refresh;
  const negative = fixture(async () => response(html('<title>Not an article</title>')), { now: () => now });
  assert.equal(await negative.lookup(source), null); await negative.lookup(source); assert.equal(negative.calls.length, 1);
  now += 15001; await negative.lookup(source); assert.equal(negative.calls.length, 2);
});

test('one cancelled subscriber does not cancel another; all cancelled subscribers abort underlying transport', async () => {
  let resolve!: (value: Response) => void, transportSignal: AbortSignal | undefined;
  const f = fixture(async (_settings, signal) => { transportSignal = signal; return new Promise<Response>(done => { resolve = done; }); });
  const controller = new AbortController();
  const one = f.lookup(source, controller.signal), two = f.lookup(source);
  await delay(0); controller.abort(); assert.equal(await one, null); assert.equal(transportSignal?.aborted, false);
  resolve(response()); assert.equal((await two)?.title, 'A story');
  const abandoned = new AbortController(), next = f.lookup(source + '2', abandoned.signal);
  await delay(0); abandoned.abort(); assert.equal(await next, null); assert.equal(transportSignal?.aborted, true);
  let cancelled = false;
  resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/html' } }));
  await delay(0); assert.equal(cancelled, true);
});

test('timeouts bound stalled DNS and transport and late replies are cancelled without cache insertion', async () => {
  const dns = fixture(async () => assert.fail('DNS never resolves'), { resolve4: async () => new Promise<string[]>(() => undefined), timeoutMs: 15 });
  assert.equal(await dns.lookup(source), null); assert.equal(dns.calls.length, 0);
  let resolve!: (value: Response) => void;
  const f = fixture(async () => new Promise<Response>(done => { resolve = done; }), { timeoutMs: 15 });
  assert.equal(await f.lookup(source), null);
  let cancelled = false;
  resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/html' } }));
  await delay(0); assert.equal(cancelled, true);
  const retry = f.lookup(source); await delay(0); assert.equal(f.calls.length, 2); resolve(response());
  assert.equal((await retry)?.title, 'A story');
});

test('pre-aborted requests do no work and stalled body reads respect cancellation', async () => {
  const pre = new AbortController(); pre.abort();
  const f = fixture(async () => assert.fail('Pre-aborted request must not connect'));
  assert.equal(await f.lookup(source, pre.signal), null); assert.equal(f.calls.length, 0);
  let cancelled = false;
  const stalled = fixture(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }),
    { headers: { 'content-type': 'text/html' } }), { timeoutMs: 15 });
  assert.equal(await stalled.lookup(source), null); assert.equal(cancelled, true);
});

test('global lookup concurrency and per-minute request count are bounded', async () => {
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const f = fixture(async () => new Promise<Response>(() => undefined));
  const ongoing = controllers.map((controller, i) => f.lookup(source + i, controller.signal));
  await delay(0); assert.equal(f.calls.length, 4);
  assert.equal(await f.lookup(source + 'excess'), null); assert.equal(f.calls.length, 4);
  controllers.forEach(controller => controller.abort()); await Promise.all(ongoing);
  let now = 0;
  const limited = fixture(undefined, { now: () => now });
  for (let i = 0; i < 30; i++) assert.ok(await limited.lookup(source + i));
  assert.equal(await limited.lookup(source + 'excess'), null); assert.equal(limited.calls.length, 30);
  now = 60000; assert.ok(await limited.lookup(source + 'excess')); assert.equal(limited.calls.length, 31);
});

test('cache eviction bounds retained metadata to 100 source entries', async () => {
  let now = 0;
  const f = fixture(undefined, { now: () => now });
  for (let i = 0; i < 101; i++) {
    if (i && i % 30 === 0) now += 60000;
    assert.ok(await f.lookup(source + i));
  }
  assert.equal(f.calls.length, 101);
  await f.lookup(source + '100'); assert.equal(f.calls.length, 101);
  await f.lookup(source + '0'); assert.equal(f.calls.length, 102);
});

test('formatted metadata is literal, mentions cannot ping, and descriptions stay compact', () => {
  const [embed] = formatArticlePreview({ source, url: source, title: '**hello** @everyone', publisher: 'A [publisher](https://evil.com)',
    description: '<b>Title</b> @here ' + 'A'.repeat(600) });
  assert.equal(embed.title, '\\*\\*hello\\*\\* @\u200beveryone');
  assert.ok(embed.author?.name.includes('\\[')); assert.ok(!embed.author?.name.includes('https://evil.com'));
  assert.ok(embed.description!.length <= 300); assert.ok(embed.description?.endsWith('…'));
  assert.ok(embed.description?.includes('@\u200bhere')); assert.ok(!embed.description?.includes('<b>'));
  assert.deepEqual(formatArticlePreview({ source: 'https://x.com/a', url: source, title: 'Title', publisher: 'Publisher' }), []);
});
