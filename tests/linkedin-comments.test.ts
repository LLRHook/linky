import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChannelType, type Message, type ButtonInteraction, type ThreadChannel } from 'discord.js';
import { createArticleLookup } from '../src/services/ArticlePreview';
import { formatLinkedInPost, parseLinkedInPost } from '../src/services/LinkedIn';
import { linkedInCommentsButton, parseLinkedInComments } from '../src/services/LinkedInComments';
import { ReplyThreads, replyThreadPayloads } from '../src/services/ReplyThreads';
import { createReplyLookup } from '../src/bot';
import { createLinkRepostHandler } from '../src/services/SocialLinkService';
import { botMessage, repostSource, sendableChannel, TEST_CHANNEL_ID } from './support/discord';
import golden from './fixtures/linkedin-comments-golden.json';

const url = golden.ld['@id'], id = '7500000000000000000';
const comment = (extra = {}) => ({ '@type': 'Comment', author: { '@type': 'Person', name: 'Sample Member' },
  text: 'Synthetic comment', datePublished: '2026-11-01T12:00:00Z',
  interactionStatistic: { interactionType: 'https://schema.org/LikeAction', userInteractionCount: 2 }, ...extra });
const ld = (comments: unknown[] = [comment()]) => ({ ...golden.ld, comment: comments });
const html = (value: unknown = ld(), og = url) => `<html><head><meta property="og:url" content="${og}"><script type="application/ld+json">${JSON.stringify(value)}</script></head><body>ignored</body></html>`;
const response = (body = html()) => new Response(body, { headers: { 'content-type': 'text/html' } });

test('12be141 golden preserves LinkedIn cards and X/Bluesky reply payload bytes', async () => {
  assert.deepEqual(formatLinkedInPost(parseLinkedInPost([ld()], url)!), golden.card);
  for (const { input, output } of golden.pages) assert.equal(JSON.stringify(replyThreadPayloads(input)), JSON.stringify(output));
  const lookup = createArticleLookup({ resolve4: async () => ['1.1.1.1'], connect: async () => response() });
  const card = await lookup(url);
  assert.equal('linkedInComments' in card!, false, 'off retains no comments');
  assert.deepEqual(formatLinkedInPost(card!.linkedIn!), golden.card);
});

test('six and nine comments keep page order; each invalid entry counted once; ten retained', () => {
  for (const length of [6, 9, 10, 11]) {
    const page = parseLinkedInComments([ld(Array.from({ length }, (_, i) => comment({ text: `comment ${i}` })))], url, 1000)!;
    assert.equal(page.r, length); assert.equal(page.m, 0); assert.equal(page.replies.length, Math.min(length, 10));
    assert.equal(page.replies[0].text, 'comment 0');
  }
  const invalid = [{ author: { '@type': 'Person', name: '' } }, { '@type': 'Person' }, { author: {} }, { text: '' }, { text: 'a'.repeat(3001) },
    { author: { '@type': 'Person', name: 'a'.repeat(301) } }, { datePublished: 'November 1' },
    { interactionStatistic: {} }, { text: '', author: {}, datePublished: false }];
  const page = parseLinkedInComments([ld([comment({ text: 'a'.repeat(3000), author: { '@type': 'Person', name: 'n'.repeat(300) } }), ...invalid.map(comment)])], url, 1000)!;
  assert.equal(page.r, 10); assert.equal(page.m, 9); assert.equal(page.replies.length, 1);
  assert.equal(page.replies[0].name.length, 300);
  for (const data of [ld([]), ld([comment({ author: {} })]), { ...ld(), '@id': url.replace(id, '7500000000000000001') }])
    assert.equal(parseLinkedInComments([data], url, 1000), null);
  assert.equal(parseLinkedInPost([{ ...ld(), '@id': url.replace(id, '7500000000000000001') }], url), null);
});

test('comment payload header, 500 serialized characters, plain authors, flags and mentions', () => {
  for (const length of [500, 501]) {
    const page = parseLinkedInComments([ld([comment({ text: 'a'.repeat(length) })])], url, 1000)!;
    const payload = replyThreadPayloads(page)[0];
    assert.equal(payload.flags, 36868); assert.deepEqual(payload.allowedMentions, { parse: [] });
    const [header, body] = payload.components[0].components as { content: string }[];
    assert.equal(header.content, `Showing 1 of 12 comments from LinkedIn's public page, in LinkedIn's order (LinkedIn returned 1; Linky hid 0). Count as of <t:1:f>. [Open post](<${url}>)`);
    assert.equal(body.content.split('\n')[2].length, 500);
    assert.equal(body.content.includes('Open reply'), false);
  }
  const page = parseLinkedInComments([ld([comment({ text: '@everyone *bold* https://example.test discord.gg/test' })])], url, 0)!;
  const text = JSON.stringify(replyThreadPayloads(page));
  assert.ok(!text.includes('@everyone')); assert.ok(!text.includes('https://example.test')); assert.ok(!text.includes('discord.gg'));
});

test('existing article cache reuses opt-in page for 300000 ms; miss coalesces one canonical pinned GET', async () => {
  let calls = 0, now = 0;
  const lookup = createArticleLookup({ now: () => now, resolve4: async host => { assert.equal(host, 'www.linkedin.com'); return ['1.1.1.1']; },
    connect: async (options, signal) => {
      calls++; assert.equal(options.hostname, 'www.linkedin.com'); assert.equal(options.path, new URL(url).pathname);
      assert.equal(options.method, 'GET'); assert.equal(options.agent, false); assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.maxHeaderSize, 8192); assert.equal(options.port, 443); assert.equal(options.family, 4);
      assert.equal(options.headers && 'cookie' in options.headers, false); assert.ok(signal);
      return response();
    } });
  await lookup(url, undefined, true); assert.equal(calls, 1);
  now = 299999; assert.ok(await lookup.comments(url)); assert.equal(calls, 1);
  now = 300000; await Promise.all([lookup.comments(url), lookup.comments(url)]); assert.equal(calls, 2);
  assert.equal(await lookup.comments('https://evil.test'), null); assert.equal(calls, 2);
});

test('512 KiB accepted, one byte over refused; redirects, wrong identity and failures abstain', async () => {
  for (const size of [524288, 524289]) {
    const body = html().padEnd(size, ' ');
    const lookup = createArticleLookup({ resolve4: async () => ['1.1.1.1'], connect: async () => response(body) });
    assert.equal(Boolean(await lookup.comments(url)), size === 524288);
  }
  for (const answer of [() => new Response(null, { status: 302, headers: { location: url.replace(id, '7500000000000000001') } }),
    () => response(html({ ...ld(), '@id': url.replace(id, '7500000000000000001') })),
    () => response(html(ld(), url.replace(id, '7500000000000000001'))),
    () => response(html(ld([]))), () => new Response(null, { status: 403 })]) {
    let calls = 0;
    const lookup = createArticleLookup({ resolve4: async () => ['1.1.1.1'], connect: async () => { calls++; return answer(); } });
    assert.equal(await lookup.comments(url), null); assert.equal(calls, 1);
  }
});

test('five second timer reaches pinned fetch and aborts held body end to end', { timeout: 1000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | undefined, cancelled = false, reading = false;
  const lookup = createArticleLookup({ resolve4: async () => ['1.1.1.1'], connect: async (_options, incoming) => {
    signal = incoming;
    return new Response(new ReadableStream({ pull() { reading = true; }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/html' } });
  } });
  const result = lookup.comments(url);
  for (let i = 0; i < 20 && !reading; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(reading, true); t.mock.timers.tick(4999); assert.equal(signal!.aborted, false);
  t.mock.timers.tick(1); assert.equal(await result, null); assert.equal(signal!.aborted, true); assert.equal(cancelled, true);
});

for (const [enabled, count, type, expected] of [[true, 12, ChannelType.GuildText, true], [false, 12, ChannelType.GuildText, false],
  [true, 0, ChannelType.GuildText, false], [true, undefined, ChannelType.GuildText, false], [true, 12, ChannelType.PublicThread, false]] as const)
test(`production automatic publish gate ${enabled}/${count}/${type}`, async () => {
  const edits: unknown[] = [], logs: unknown[] = [], flags: unknown[] = [];
  const post = parseLinkedInPost([ld()], url)!;
  if (count === undefined) delete post.counts; else post.counts!.comments = count;
  const card = botMessage({ embeds: formatLinkedInPost(post).map(e => ({ ...e, toJSON: () => e })), edit: async (payload: unknown) => { edits.push(payload); return card; } });
  const source = repostSource({ content: url, channel: sendableChannel({ type, send: async () => card }) });
  const handler = createLinkRepostHandler([TEST_CHANNEL_ID], { info(...v: unknown[]) { logs.push(v); }, warn(...v: unknown[]) { logs.push(v); }, error(...v: unknown[]) { logs.push(v); } }, undefined, {
    platforms: ['articles'], serverPreferences: () => ({ replies: enabled }), rememberRepost: async () => true,
    lookupArticle: async (raw, _signal, comments) => { flags.push(comments); return { source: raw, url, title: 'LinkedIn post', publisher: 'LinkedIn', linkedIn: post, linkedInComments: parseLinkedInComments([ld()], url, 0) }; },
    verifyPreview: async (_m, expected) => ({ ok: true, missing: [], videoMetadata: false, attributed: [...expected] }) });
  await handler(source as unknown as Message);
  assert.deepEqual(flags, [enabled]);
  assert.equal(JSON.stringify(edits).includes('Comments ('), expected, JSON.stringify({ edits, logs }));
});

test('button identity bounded; production click router binds canonical card and abstains mismatch', async () => {
  const button = linkedInCommentsButton(golden.card, ChannelType.GuildText, true, parseLinkedInComments([ld()], url, 0))!.toJSON() as { custom_id: string };
  assert.equal(button.custom_id, `linky:replies:linkedin:${id}`); assert.ok(button.custom_id!.length <= 100);
  let calls = 0, creates = 0;
  const answers: string[] = [];
  const page = parseLinkedInComments([ld()], url, 0)!;
  const route = createReplyLookup(async () => assert.fail('X'), async () => assert.fail('Bluesky'), async address => { assert.equal(address, url); calls++; return page; });
  const thread = { url: 'thread', send: async () => {} } as unknown as ThreadChannel;
  const message = { id: '1', guildId: 'guild', author: { id: 'bot' }, embeds: golden.card, channel: { type: ChannelType.GuildText, permissionsFor: () => ({ has: () => true }) },
    fetch: async () => message, startThread: async () => { creates++; return thread; } };
  const manager = new ReplyThreads({ botUserId: () => 'bot', enabled: () => true, tracked: () => true, lookup: route, fetchThread: async () => null });
  const click = (customId: string) => manager.handle({ customId, message, guildId: 'guild', guild: { members: { me: {} } }, user: { id: 'user' },
    deferReply: async () => {}, editReply: async () => {}, reply: async (p: { content: string }) => { answers.push(p.content); } } as unknown as ButtonInteraction);
  await click(`linky:replies:linkedin:7500000000000000001`); assert.equal(calls, 0); assert.equal(creates, 0);
  assert.equal(answers[0], 'No comments Linky can show for this post');
  await Promise.all([click(button.custom_id!), click(button.custom_id!)]); assert.equal(calls, 1); assert.equal(creates, 1);
  assert.equal(await click(button.custom_id! + 'x'), false);
});


test('comment-only refresh preserves cached full cards and never substitutes a minimal preview', async () => {
  let calls = 0;
  const lookup = createArticleLookup({ resolve4: async () => ['1.1.1.1'], connect: async () => { calls++; return response(); } });
  const original = await lookup(url);
  await lookup.comments(url);
  const refreshed = await lookup(url);
  assert.deepEqual(refreshed!.linkedIn, original!.linkedIn); assert.equal(calls, 2);
  const fresh = createArticleLookup({ resolve4: async () => ['1.1.1.1'], connect: async () => { calls++; return response(); } });
  await fresh.comments(url); const after = calls;
  await fresh(url); assert.equal(calls, after + 1, 'ordinary card still gets its full preparation');
});


for (const commentsFirst of [true, false]) test(`overlapping full video and comments preparation, comments first=${commentsFirst}`, async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let pages = 0;
  const movie = 'https://dms.licdn.com/playlist/vid/sample?e=2147483647&v=beta&t=abcdefgh';
  const video = { ...ld([comment({ author: undefined, creator: { '@type': 'Person', name: 'Sample Member' } })]), '@type': 'VideoObject', creator: { name: 'Sample Author' }, description: 'Synthetic video', contentUrl: movie };
  const lookup = createArticleLookup({ resolve4: async () => ['1.1.1.1'], connect: async options => {
    if (options.hostname === 'dms.licdn.com') {
      const bytes = new Uint8Array(64); bytes.set(new TextEncoder().encode('ftypisom'), 4);
      return new Response(bytes, { headers: { 'content-type': 'video/mp4' } });
    }
    pages++; if (pages === 1) await gate;
    return response(html(video));
  } });
  const first = commentsFirst ? lookup.comments(url) : lookup(url);
  for (let i = 0; i < 20 && !pages; i++) await new Promise(resolve => setImmediate(resolve));
  const second = commentsFirst ? lookup(url) : lookup.comments(url);
  release();
  const [a, b] = await Promise.all([first, second]);
  const card = (commentsFirst ? b : a) as Awaited<ReturnType<typeof lookup>>;
  const comments = (commentsFirst ? a : b) as ReturnType<typeof parseLinkedInComments>;
  assert.equal(card!.linkedIn!.files!.length, 1); assert.equal(comments!.replies.length, 1); assert.equal(pages, 2);
});

test('failed comments refresh preserves full card and original expiry', async () => {
  let calls = 0, now = 0;
  const lookup = createArticleLookup({ now: () => now, resolve4: async () => ['1.1.1.1'], connect: async () => ++calls === 1 ? response() : new Response(null, { status: 403 }) });
  const original = await lookup(url); now = 1000;
  assert.equal(await lookup.comments(url), null);
  assert.deepEqual((await lookup(url))!.linkedIn, original!.linkedIn); assert.equal(calls, 2);
  now = 299999; assert.ok(await lookup(url)); assert.equal(calls, 2);
  now = 300000; assert.equal(await lookup(url), null); assert.equal(calls, 3);
});

test('comment-only request rejects PDF before reading or parsing it', async t => {
  let reads = 0, cancelled = false;
  const pdf = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/pdf' } });
  t.mock.method(pdf.body!, 'getReader', () => { reads++; throw Error('PDF must not be read'); });
  const lookup = createArticleLookup({ resolve4: async () => ['1.1.1.1'], connect: async () => pdf });
  assert.equal(await lookup.comments(url), null); assert.equal(reads, 0); assert.equal(cancelled, true);
});


test('late full preparation preserves earlier comments and their original five-minute deadline', async () => {
  let release!: () => void, pages = 0, now = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const lookup = createArticleLookup({ now: () => now, resolve4: async () => ['1.1.1.1'], connect: async () => {
    pages++; if (pages === 1) await gate;
    return response();
  } });
  const full = lookup(url);
  for (let i = 0; i < 20 && !pages; i++) await new Promise(resolve => setImmediate(resolve));
  await lookup.comments(url); now = 1000; release(); await full;
  now = 299999; assert.ok(await lookup.comments(url)); assert.equal(pages, 2);
  now = 300000; assert.ok(await lookup.comments(url)); assert.equal(pages, 3);
});


test('malformed comment counter cannot fail an opted-in ordinary card', async () => {
  const broken = ld([comment({ interactionStatistic: { interactionType: { toString: null, valueOf: null }, userInteractionCount: 1 } })]);
  const lookup = createArticleLookup({ resolve4: async () => ['1.1.1.1'], connect: async () => response(html(broken)) });
  const card = await lookup(url, undefined, true);
  assert.deepEqual(formatLinkedInPost(card!.linkedIn!), golden.card);
  assert.equal(card!.linkedInComments, null);
});

const videoLd = (comments: unknown[]) => ({ ...ld(comments), '@type': 'VideoObject',
  creator: { name: 'Synthetic Publisher' }, description: 'Synthetic video',
  contentUrl: 'https://dms.licdn.com/playlist/vid/sample?e=2147483647&v=beta&t=abcdefgh' });

test('video creator comments preserve equivalent text replies, nine likes, names and times', () => {
  const likes = [12, 15, 2, 2, 6, 6, 6, 6, 4];
  const comments = likes.map((n, i) => comment({ author: { '@type': 'Person', name: `Synthetic Member ${i}` },
    text: `Synthetic reply ${i}`, datePublished: `2026-03-03T20:48:0${i}.696Z`,
    interactionStatistic: { '@type': 'InteractionCounter', interactionType: 'http://schema.org/LikeAction', userInteractionCount: n } }));
  const video = parseLinkedInComments([videoLd(comments.map(({ author, ...c }) => ({ ...c, creator: author })))], url, 1000)!;
  const text = parseLinkedInComments([ld(comments)], url, 1000)!;
  assert.deepEqual(video.replies, text.replies);
  assert.deepEqual(video.replies.map(r => r.likes), likes);
  assert.equal(video.r, 9); assert.equal(video.m, 0);
});

test('mixed fields follow parent type without fallback and retain invalid-entry accounting', () => {
  const person = { '@type': 'Person', name: 'Video Member' };
  const both = comment({ creator: person });
  const wrong = comment();
  const malformed = comment({ creator: { '@type': 'Organization', name: 'Synthetic Org' } });
  const page = parseLinkedInComments([videoLd([both, wrong, malformed])], url, 0)!;
  assert.deepEqual(page.replies.map(r => r.name), ['Video Member']);
  assert.equal(page.r, 3); assert.equal(page.m, 2);
  const text = parseLinkedInComments([ld([both, comment({ author: undefined, creator: person })])], url, 0)!;
  assert.deepEqual(text.replies.map(r => r.name), ['Sample Member']); assert.equal(text.m, 1);
});

test('video author names remain inert through the existing downstream sanitizer', () => {
  const page = parseLinkedInComments([videoLd([comment({ author: undefined,
    creator: { '@type': 'Person', name: '@everyone **Name** https://example.test discord.gg/test' } })])], url, 0)!;
  const payload = replyThreadPayloads(page)[0];
  const output = JSON.stringify(payload);
  assert.ok(!output.includes('@everyone')); assert.ok(!output.includes('https://example.test')); assert.ok(!output.includes('discord.gg'));
  assert.ok(output.includes('Name')); assert.deepEqual(payload.allowedMentions, { parse: [] });
});

for (const usable of [true, false]) test(`publish gate uses already parsed comments, usable=${usable}`, async () => {
  let calls = 0;
  const lookup = createArticleLookup({ resolve4: async () => ['1.1.1.1'], connect: async () => {
    calls++; return response(html(ld(usable ? [comment()] : [comment({ author: {} })])));
  } });
  const edits: unknown[] = [];
  const card = botMessage({ embeds: golden.card.map(e => ({ ...e, toJSON: () => e })), edit: async (p: unknown) => { edits.push(p); return card; } });
  const source = repostSource({ content: url, channel: sendableChannel({ type: ChannelType.GuildText, send: async () => card }) });
  const handler = createLinkRepostHandler([TEST_CHANNEL_ID], { info() {}, warn() {}, error() {} }, undefined, {
    platforms: ['articles'], serverPreferences: () => ({ replies: true }), rememberRepost: async () => true,
    lookupArticle: lookup, verifyPreview: async (_m, expected) => ({ ok: true, missing: [], videoMetadata: false, attributed: [...expected] }) });
  await handler(source as unknown as Message);
  assert.equal(JSON.stringify(edits).includes('Comments ('), usable);
  assert.equal(calls, 1, 'gate does not fetch a second page');
  const page = parseLinkedInComments([ld()], url, 0)!;
  assert.equal(linkedInCommentsButton(golden.card, ChannelType.GuildText, true), undefined);
  assert.equal(linkedInCommentsButton(golden.card, ChannelType.GuildText, true, { ...page, commentsUrl: url.replace(id, '7500000000000000001') }), undefined);
});
