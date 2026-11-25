import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { ChannelType, PermissionsBitField, PermissionFlagsBits, type ButtonInteraction, type ChatInputCommandInteraction, type Message, type ThreadChannel } from 'discord.js';
import { createArticleLookup } from '../src/services/ArticlePreview';
import { createBotReplyLookup } from '../src/bot';
import { execute } from '../src/commands/fix';
import { formatLinkedInPost, parseLinkedInPost } from '../src/services/LinkedIn';
import { linkedInCommentsButton, linkedInCommentsUrl, parseLinkedInComments } from '../src/services/LinkedInComments';
import { ReplyThreads, replyThreadPayloads } from '../src/services/ReplyThreads';
import { commandInteraction, type InteractionEvent } from './support/discord';
import golden from './fixtures/linkedin-comments-golden.json';

const url = golden.ld['@id'], id = '7500000000000000000';
const other = (n: number) => url.replace(id, String(BigInt(id) + BigInt(n)));
const comment = (extra = {}) => ({ '@type': 'Comment', author: { '@type': 'Person', name: 'Synthetic Member' }, text: 'Synthetic text',
  datePublished: '2026-11-01T12:00:00Z', interactionStatistic: { interactionType: 'https://schema.org/LikeAction', userInteractionCount: 2 }, ...extra });
const ld = (address = url, comments = [comment()]) => ({ ...golden.ld, '@id': address, comment: comments });
const html = (data: unknown = ld(), address = url) => `<html><head><meta property="og:url" content="${address}"><script type="application/ld+json">${JSON.stringify(data)}</script></head><body></body></html>`;
const response = (data: unknown = ld(), address = url) => new Response(html(data, address), { headers: { 'content-type': 'text/html' } });
const tick = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

test('production bot adapter composition calls the article comments lookup', async () => {
  const calls: string[] = [], page = parseLinkedInComments([ld()], url, 0)!;
  const lookup = createBotReplyLookup({ comments: async address => { calls.push(address); return page; } }, async () => assert.fail('X'), async () => assert.fail('Bluesky'));
  assert.equal(await lookup(url, 'linkedin'), page); assert.deepEqual(calls, [url]);
});

for (const [enabled, video, usable] of [[true, false, true], [false, false, true], [true, true, true], [true, true, false], [false, true, true]]) test(`/fix LinkedIn production button and comments preparation opt-in ${enabled}, video=${video}, usable=${usable}`, async () => {
  const events: InteractionEvent[] = [], flags: unknown[] = [];
  const movie = 'https://dms.licdn.com/playlist/vid/sample?e=2147483647&v=beta&t=abcdefgh';
  const data = video ? { ...ld(url, usable ? [comment({ author: undefined, creator: { '@type': 'Person', name: 'Synthetic Member' } })] : []),
    '@type': 'VideoObject', creator: { name: 'Synthetic Publisher' }, description: 'Video', contentUrl: movie } : ld();
  const post = parseLinkedInPost([data], url)!;
  if (video) post.files = [{ name: `linkedin-${id}.mp4`, url: movie, data: new Uint8Array([1]) }];
  const embeds = formatLinkedInPost(post);
  const card = { id: '333333333333333333', channelId: 'channel', author: { id: 'bot' }, components: [], embeds: embeds.map(e => ({ ...e, toJSON: () => e })), fetch: async () => card };
  const input = commandInteraction(events, {
    isChatInputCommand: () => true, guildId: 'guild', channelId: 'channel', client: Object.assign(new EventEmitter(), { user: { id: 'bot' } }),
    authorizingIntegrationOwners: { 0: 'guild' }, guild: { members: { me: { id: 'bot' } } },
    channel: { type: ChannelType.GuildText, isThread: () => false },
    appPermissions: new PermissionsBitField(PermissionFlagsBits.AttachFiles), memberPermissions: new PermissionsBitField(PermissionFlagsBits.SendMessages),
    attachmentSizeLimit: 10 * 1024 * 1024, options: { getString: () => url },
    editReply: async (payload: unknown) => { events.push({ name: 'edit', payload }); Object.assign(card, { components: ((payload as { components?: { toJSON?: () => unknown }[] }).components ?? []).map(c => ({ toJSON: () => c.toJSON ? c.toJSON() : c })) }); return card as unknown as Message; },
    fetchReply: async () => card as unknown as Message,
  });
  await execute(input as unknown as ChatInputCommandInteraction,
    { discordToken: '', channelIds: [], serverIds: [], rewritePlatforms: ['articles'], translateTweets: false, settingsPath: 'unused' }, {
      serverPreferences: () => ({ replies: enabled }),
      lookupArticle: async (source, _signal, comments) => { flags.push(comments); return { source, url, title: 'LinkedIn post', publisher: 'LinkedIn', linkedIn: post, linkedInComments: parseLinkedInComments([data], url, 0) }; },
      verifyPreview: async (_message, expected) => ({ ok: true, missing: [], videoMetadata: false, attributed: [...expected] }),
    });
  assert.deepEqual(flags, [enabled]);
  assert.equal(JSON.stringify(events).includes('Comments (12)'), enabled && usable, JSON.stringify(events));
});

test('comment admission has two flights and ten per minute without using ordinary card slots or requests', async () => {
  let release!: () => void, now = 0, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const lookup = createArticleLookup({ now: () => now, resolve4: async () => ['1.1.1.1'], connect: async options => {
    calls++; const address = `https://www.linkedin.com${options.path}`;
    if (address === other(1) || address === other(2)) await gate;
    return response(ld(address), address);
  } });
  const a = lookup.comments(other(1)), b = lookup.comments(other(2)); await tick();
  assert.equal(await lookup.comments(other(3)), null); assert.equal(calls, 2);
  assert.ok(await lookup(url)); assert.equal(calls, 3);
  release(); await Promise.all([a, b]);
  for (let n = 3; n <= 10; n++) assert.ok(await lookup.comments(other(n)));
  assert.equal(await lookup.comments(other(11)), null);
  assert.ok(await lookup(other(12)), 'ordinary requests still admitted after ten comment refreshes');
  now = 60000; assert.ok(await lookup.comments(other(11)));
});

test('p3: click at zero cannot shorten a replies-off card fetched at 299 seconds', async () => {
  let now = 0, calls = 0;
  const lookup = createArticleLookup({ now: () => now, resolve4: async () => ['1.1.1.1'], connect: async () => { calls++; return response(); } });
  await lookup.comments(url); now = 299000; const first = await lookup(url);
  now = 300001; assert.deepEqual(await lookup(url), first); assert.equal(calls, 2);
  now = 598999; assert.ok(await lookup(url)); assert.equal(calls, 2);
  now = 599000; await lookup(url); assert.equal(calls, 3);
});

test('comment cache expires successes at five minutes and failures at fifteen seconds independently of cards', async () => {
  let now = 0, calls = 0, fail = true;
  const lookup = createArticleLookup({ now: () => now, resolve4: async () => ['1.1.1.1'], connect: async () => { calls++; return fail ? new Response(null, { status: 503 }) : response(); } });
  fail = false; const card = await lookup(url); fail = true; calls = 0;
  assert.equal(await lookup.comments(url), null); now = 14999; assert.equal(await lookup.comments(url), null); assert.equal(calls, 1);
  fail = false; now = 15000; assert.ok(await lookup.comments(url)); assert.equal(calls, 2);
  assert.deepEqual(await lookup(url), card); assert.equal(calls, 2);
  now = 314999; assert.ok(await lookup.comments(url)); assert.equal(calls, 2);
  now = 315000; assert.ok(await lookup.comments(url)); assert.equal(calls, 3);
});

test('a failed held refresh never overwrites good comments concurrently cached by an opted-in card', async () => {
  let release!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const lookup = createArticleLookup({ resolve4: async () => ['1.1.1.1'], connect: async () => {
    if (++calls === 1) { await gate; return new Response(null, { status: 503 }); }
    return response();
  } });
  const refresh = lookup.comments(url); await tick(); await lookup(url, undefined, true); release();
  assert.ok(await refresh); assert.ok(await lookup.comments(url)); assert.equal(calls, 2);
});

test('twenty comment entries neither evict ordinary cards nor leave an unbounded comment cache', async () => {
  let now = 0, calls = 0;
  const lookup = createArticleLookup({ now: () => now, resolve4: async () => ['1.1.1.1'], connect: async options => {
    calls++; const address = `https://www.linkedin.com${options.path}`; return response(ld(address), address);
  } });
  for (let n = 0; n < 100; n++) { now = Math.floor(n / 30) * 60000; assert.ok(await lookup(other(n))); }
  const before = calls; await lookup.comments(other(100)); await lookup(url); assert.equal(calls, before + 1);
  for (let n = 101; n <= 120; n++) { if (n === 110 || n === 120) now += 60000; await lookup.comments(other(n)); }
  const full = calls; await lookup.comments(other(100)); assert.equal(calls, full + 1, 'oldest comment page evicted at twenty entries');
});

test('tracked share cache reuse returns only the comment page, without cloning cached media bytes', async t => {
  assert.equal(linkedInCommentsButton([...golden.card, ...golden.card], ChannelType.GuildText, true), undefined);
  let calls = 0;
  const lookup = createArticleLookup({ resolve4: async () => ['1.1.1.1'], connect: async () => { calls++; return response(); } });
  await lookup(`${url}?utm_source=share`, undefined, true);
  const clone = structuredClone, copied: unknown[] = [];
  t.mock.method(globalThis, 'structuredClone', (value: unknown) => { copied.push(value); return clone(value); });
  const page = await lookup.comments(url); assert.ok(page); assert.equal(calls, 1);
  assert.deepEqual(copied, [page]); assert.equal('linkedIn' in (copied[0] as object), false);
});

test('refresh refuses a different post even when its og:url and @id agree', async () => {
  const lookup = createArticleLookup({ resolve4: async () => ['1.1.1.1'], connect: async () => response(ld(other(1)), other(1)) });
  assert.equal(await lookup.comments(url), null);
});

test('multi-item JSON-LD selects comments from the matching post only', () => {
  const page = parseLinkedInComments([ld(other(1), [comment({ author: { '@type': 'Person', name: 'Wrong' } })]), ld()], url, 0)!;
  assert.equal(page.replies[0].name, 'Synthetic Member');
});

test('video comments refresh never downloads media or extends the five-second window', { timeout: 1000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls: string[] = [], signals: AbortSignal[] = [];
  const video = { ...ld(url, [comment({ author: undefined, creator: { '@type': 'Person', name: 'Synthetic Member' } })]), '@type': 'VideoObject', creator: { name: 'Sample' }, description: 'Video', contentUrl: 'https://dms.licdn.com/playlist/vid/sample?e=2147483647&v=beta&t=abcdefgh' };
  const lookup = createArticleLookup({ resolve4: async () => ['1.1.1.1'], connect: async (options, signal) => {
    calls.push(String(options.hostname)); signals.push(signal); return response(video);
  } });
  assert.ok(await lookup.comments(url)); assert.deepEqual(calls, ['www.linkedin.com']);
  // A held body on the same VideoObject still belongs to the five-second metadata request.
  let reading = false;
  const held = createArticleLookup({ resolve4: async () => ['1.1.1.1'], connect: async (_options, signal) => {
    signals.push(signal); return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(html(video).split('</script>')[0])); }, pull() { reading = true; } }), { headers: { 'content-type': 'text/html' } });
  } });
  const waiting = held.comments(url); await tick(); assert.equal(reading, true);
  t.mock.timers.tick(4999); assert.equal(signals.at(-1)!.aborted, false);
  t.mock.timers.tick(1); assert.equal(await waiting, null); assert.equal(signals.at(-1)!.aborted, true);
});

function clickHarness(page: ReturnType<typeof parseLinkedInComments>) {
  const answers: { content: string; flags?: number }[] = [], names: string[] = [];
  const thread = { url: 'thread', send: async () => {} } as unknown as ThreadChannel;
  const message = { id: 'parent', guildId: 'guild', channelId: 'channel', author: { id: 'bot' }, embeds: golden.card,
    channel: { type: ChannelType.GuildText, permissionsFor: () => ({ has: () => true }) }, fetch: async () => message,
    startThread: async (settings: { name: string }) => { names.push(settings.name); return thread; } };
  const manager = new ReplyThreads({ botUserId: () => 'bot', enabled: () => true, tracked: () => true, lookup: async () => page, fetchThread: async () => null });
  const input = { customId: `linky:replies:linkedin:${id}`, message, guildId: 'guild', guild: { members: { me: {} } }, user: { id: 'member' }, deferred: false,
    deferReply: async (p: { flags: number }) => { assert.equal(p.flags, 64); input.deferred = true; },
    reply: async (p: { content: string }) => { answers.push(p); }, editReply: async (p: { content: string }) => { answers.push(p); } };
  return { click: () => manager.handle(input as unknown as ButtonInteraction), answers, names };
}

test('failed lookup has LinkedIn private abstention and no thread', async () => {
  const h = clickHarness(null); await h.click(); assert.equal(h.answers[0].content, 'No comments Linky can show for this post'); assert.deepEqual(h.names, []);
});
for (const length of [88, 89]) test(`LinkedIn thread title at name boundary ${length}`, async () => {
  const page = parseLinkedInComments([ld()], url, 0)!; page.threadHandle = 'a'.repeat(length);
  const h = clickHarness(page); await h.click(); assert.deepEqual(h.names, [length === 88 ? 'Comments on ' + 'a'.repeat(88) : 'Comments on ' + 'a'.repeat(87) + '…']); assert.equal(h.names[0].length, 100);
});

test('hostile comment author names remain inert in the shared renderer', () => {
  const page = parseLinkedInComments([ld(url, [comment({ author: { '@type': 'Person', name: '@everyone [Click](https://example.test) **x**' } })])], url, 0)!;
  const content = (replyThreadPayloads(page)[0].components[0].components[1] as { content: string }).content;
  assert.equal(content.split('\n')[0], '**@\u200beveryone \\[Click\\]\\(\\[link\\] \\*\\*x\\*\\***');
  const longPage = parseLinkedInComments([ld(url, [comment({ author: { '@type': 'Person', name: 'N'.repeat(300) } })])], url, 0)!;
  const line = (replyThreadPayloads(longPage)[0].components[0].components[1] as { content: string }).content;
  assert.equal(line, `**${'N'.repeat(300)}**\n-# 2 likes \u00b7 <t:1793534400:R>\nSynthetic text`);

});

test('click resolves the authored canonical card despite a pasted slug alias', () => {
  const pasted = url.replace('sample_topic', 'different_slug');
  const controls = { type: 1, components: [{ type: 2, url: pasted }] };
  assert.equal(linkedInCommentsUrl({ embeds: golden.card, components: [controls] }, id), url);
  assert.equal(linkedInCommentsUrl({ components: [{ type: 10, content: `Shared by member\n### [Pasted alias](${pasted})` }, { type: 17, components: [{ type: 10, content: `-# Author\n### [LinkedIn post](${url})\ntext` }] }, controls] }, id), url);
  assert.equal(linkedInCommentsUrl({ embeds: [{ url }, { url: pasted }] }, id), null);
});


test('strict comment inputs reject non-person, negative likes, pre-epoch dates and zero counts', () => {
  for (const bad of [comment({ author: { '@type': 'Organization', name: 'Sample' } }),
    comment({ interactionStatistic: { interactionType: 'https://schema.org/LikeAction', userInteractionCount: -1 } }),
    comment({ datePublished: '1960-11-01T12:00:00Z' })]) assert.equal(parseLinkedInComments([ld(url, [bad])], url, 0), null);
  const zero = structuredClone(ld()); zero.interactionStatistic[1].userInteractionCount = 0;
  assert.equal(parseLinkedInComments([zero], url, 0), null);
});

test('noncanonical comments input and multiple cards have no usable control', async () => {
  assert.equal(linkedInCommentsButton([...golden.card, ...golden.card], ChannelType.GuildText, true), undefined);
  let calls = 0;
  const lookup = createArticleLookup({ resolve4: async () => ['1.1.1.1'], connect: async () => { calls++; return response(); } });
  assert.equal(await lookup.comments(url + '?utm_source=share'), null); assert.equal(calls, 0);
});

test('missing matching JSON-LD stops comments refresh before generic image DNS lookup', async () => {
  const hosts: string[] = [];
  const lookup = createArticleLookup({ resolve4: async host => { hosts.push(host); return ['1.1.1.1']; }, connect: async () =>
    new Response(`<html><head><meta property="og:type" content="article"><meta property="og:title" content="Synthetic"><meta property="og:image" content="https://example.com/image.jpg"></head></html>`, { headers: { 'content-type': 'text/html' } }) });
  assert.equal(await lookup.comments(url), null); assert.deepEqual(hosts, ['www.linkedin.com']);
});


test('ordinary budget is unchanged after ten comment refreshes, and comment admission ignores four held cards', async () => {
  let calls = 0;
  const fixture = (connect: Parameters<typeof createArticleLookup>[0] = {}) => createArticleLookup({ resolve4: async () => ['1.1.1.1'], ...connect });
  const lookup = fixture({ connect: async options => { calls++; const address = `https://www.linkedin.com${options.path}`; return response(ld(address), address); } });
  for (let n = 0; n < 10; n++) assert.ok(await lookup.comments(other(n)));
  for (let n = 10; n < 40; n++) assert.ok(await lookup(other(n)));
  assert.equal(calls, 40); assert.equal(await lookup(other(40)), null);
  let release!: () => void, started = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = fixture({ connect: async options => { const address = `https://www.linkedin.com${options.path}`;
    if (address !== url) { started++; await gate; } return response(ld(address), address); } });
  const cards = [1, 2, 3, 4].map(n => held(other(n))); await tick(); assert.equal(started, 4);
  assert.ok(await held.comments(url)); release(); assert.ok((await Promise.all(cards)).every(Boolean));
});


test('opted-in card null comments remain authoritative at one and sixteen seconds', async () => {
  let now = 0, calls = 0;
  const lookup = createArticleLookup({ now: () => now, resolve4: async () => ['1.1.1.1'], connect: async () => {
    calls++; return response(ld(url, []));
  } });
  assert.equal((await lookup(url, undefined, true))!.linkedInComments, null);
  now = 1000; assert.equal(await lookup.comments(url), null);
  now = 16000; assert.equal(await lookup.comments(url), null);
  assert.equal(calls, 1);
});

test('replies-off page does not enter the comments parser; opt-in positive control does', async t => {
  let reads = 0;
  const parse = JSON.parse;
  t.mock.method(JSON, 'parse', (text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    const value = parse(text, reviver);
    if (value?.['@id'] === url && Array.isArray(value.comment)) {
      const comments = value.comment;
      Object.defineProperty(value, 'comment', { get() { reads++; return comments; } });
    }
    return value;
  });
  const options = { resolve4: async () => ['1.1.1.1'], connect: async () => response() };
  assert.ok(await createArticleLookup(options)(url, undefined, false)); assert.equal(reads, 0);
  assert.ok((await createArticleLookup(options)(url, undefined, true))!.linkedInComments); assert.ok(reads > 0);
});
