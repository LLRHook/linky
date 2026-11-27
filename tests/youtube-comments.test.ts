import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelType, Collection, MessageType, type ButtonInteraction, type ThreadChannel } from 'discord.js';
import { createYouTubeLookup, formatYouTubeStatistics } from '../src/services/YouTube';
import { createYouTubeComments, parseYouTubeComments } from '../src/services/YouTubeComments';
import { controlsForYouTube } from '../src/services/YouTubeControls';
import { youtubeCommentsEnabled, youtubeCommentsScopeEnabled, youtubeReplyTarget } from '../src/services/YouTubeReplyTarget';
import { ReplyThreads, replyThreadPayloads } from '../src/services/ReplyThreads';
import { YouTubeStats, type StatsMessage } from '../src/services/YouTubeStats';
const ID = 'dQw4w9WgXcQ', BOT = '1491240385031311470', MID = '1491240385031311471', CHANNEL = '373953687812440066';
const body = (id = ID, n = 25) => ({ items: Array.from({ length: n }, (_, i) => ({ id: `thread${i}`, snippet: { videoId: id, topLevelComment: { id: `comment${i}`, snippet: { textDisplay: '@everyone **text** https://evil.test ' + 'x'.repeat(500), authorDisplayName: `Author ${i}`, authorChannelUrl: 'https://evil.test', likeCount: i, publishedAt: '2026-11-24T00:00:00Z' } } } })) });
const cards = (count = '99') => [formatYouTubeStatistics({ commentCount: count }, `https://www.youtube.com/watch?v=${ID}`)!];

test('YouTube exact parameters cost one request, bounded cache TTL and per-call cap', async () => {
  let now = 0, calls = 0, oversized = false, expectedId = ID;
  const lookup = createYouTubeLookup('operator-key', { now: () => now, fetch: async (input, init) => {
    calls++; const url = new URL(String(input));
    assert.equal(url.origin + url.pathname, 'https://www.googleapis.com/youtube/v3/commentThreads');
    assert.deepEqual(Object.fromEntries(url.searchParams), { part: 'snippet', videoId: calls <= 2 ? 'dQw4w9WgXcQ' : expectedId, order: 'relevance', maxResults: '25', textFormat: 'plainText', fields: 'items(id,snippet(videoId,topLevelComment(id,snippet(textDisplay,authorDisplayName,authorChannelUrl,authorProfileImageUrl,likeCount,publishedAt))))' });
    assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit'); assert.ok(init?.signal);
    assert.deepEqual(init?.headers, { 'X-Goog-Api-Key': 'operator-key' });
    return new Response(JSON.stringify({ ...body(url.searchParams.get('videoId')!), padding: 'x'.repeat(oversized ? 262144 : 130000) }));
  } });
  const [a, b] = await Promise.all([lookup.comments(ID, '99', 1000), lookup.comments(ID, '99', 1000)]);
  assert.equal(calls, 1); assert.equal(a?.replies.length, 25); assert.deepEqual(a, b);
  now = 299999; assert.equal((await lookup.comments(ID, '100', 2000))?.N, '100'); assert.equal(calls, 1);
  now = 300000; oversized = true; assert.equal(await lookup.comments(ID, '99', 0), null); assert.equal(calls, 2);
  now += 60000; oversized = false;
  for (let i = 0; i < 100; i++) { now += 60000; expectedId = `V${String(i).padStart(10, '0')}`; await lookup.comments(expectedId, '99', 0); }
  expectedId = ID; const before = calls; await lookup.comments(ID, '99', 0); assert.equal(calls, before + 1);
});

test('YouTube no key makes zero calls; disabled comments, quota, 400, empty and failure abstain', async () => {
  let calls = 0;
  assert.equal(await createYouTubeLookup('', { fetch: async () => { calls++; throw Error(); } }).comments(ID, '1', 0), null); assert.equal(calls, 0);
  for (const [status, reason] of [[403, 'commentsDisabled'], [403, 'quotaExceeded'], [400, 'badRequest'], [500, 'backendError']] as const) {
    let now = 0, count = 0;
    const lookup = createYouTubeLookup('key', { now: () => now, fetch: async () => { count++; return new Response(JSON.stringify({ error: { errors: [{ reason }] } }), { status }); } });
    assert.equal(await lookup.comments(ID, '1', 0), null);
    await lookup(['abcdefghijk'], 'counts');
    assert.equal(count, reason === 'commentsDisabled' ? 2 : 1);
    if (status === 400 || reason === 'quotaExceeded') { now = 3599999; await lookup(['0123456789_'], 'counts'); assert.equal(count, 1); now = 3600001; await lookup(['0123456789_'], 'counts'); assert.equal(count, 2); }
  }
  const lookup = createYouTubeLookup('key', { fetch: async () => new Response('{"items":[]}') });
  assert.equal((await lookup.comments(ID, '99', 0))?.replies.length, 0);
});

test('YouTube preserves relevance, top-level identity and 25 cap, exact flags and attribution', () => {
  const data = body(ID, 27); data.items[1].snippet.videoId = 'abcdefghijk';
  const page = parseYouTubeComments(data, ID)!; page.N = '99'; page.countTime = 1000;
  assert.equal(page.m, 1); assert.equal(page.replies.length, 25); assert.deepEqual(page.replies.slice(0, 2).map(reply => reply.likes), [0, 2]);
  const payloads = replyThreadPayloads(page); const text = JSON.stringify(payloads);
  assert.match(text, /Showing 25 of 99 comments from YouTube, in YouTube's relevance order/); assert.match(text, /Count as of <t:1:f>/);
  assert(!text.includes('evil.test')); assert(text.includes('@\u200beveryone')); assert(!text.includes('&lc='));
  for (const payload of payloads) { assert.equal(payload.flags, 36868); assert.deepEqual(payload.allowedMentions, { parse: [] }); assert(payload.components[0].components.reduce((sum, display) => sum + ('content' in display ? display.content.length : 0), 0) <= 3800); }
});

test('YouTube button eligibility and longest stable control ID', () => {
  const count = '99999999999999999999';
  const control = controlsForYouTube(cards(count), true)!;
  const button = control.controls[0].components.find(b => b.custom_id.startsWith('linky:yt:replies:'))!;
  assert.equal(button.label, `Comments (${count})`); assert.equal(button.custom_id, 'linky:yt:replies:dQw4w9WgXcQ'); assert(button.custom_id.length <= 100);
  for (const value of [controlsForYouTube(cards(), false), controlsForYouTube(cards('0'), true), controlsForYouTube(cards().concat([{ ...cards()[0], url: 'https://youtu.be/abcdefghijk' }]), true)]) assert(!JSON.stringify(value).includes('linky:yt:replies:'));
  for (const [replies, display, key, channel] of [[false, 'counts-and-comment', true, ChannelType.GuildText], [true, 'counts', true, ChannelType.GuildText], [true, 'counts-and-comment', false, ChannelType.GuildText], [true, 'counts-and-comment', true, ChannelType.PublicThread]] as const) assert.equal(youtubeCommentsEnabled(replies, display, key, channel), false);
  assert(youtubeCommentsEnabled(true, 'counts-and-comment', true, ChannelType.GuildText));
});

test('YouTube creation, canView gates, restart and durable expiry retry remove only copied pages', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'F4-youtube-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let now = 0, enabled = true, fail = false, lookups = 0, fetches = 0;
  let components: any[] = [], copied: any[] = []; const answers: string[] = [];
  const thread = { guildId: 'guild', parentId: CHANNEL, ownerId: BOT, messageCount: 0, archived: false, locked: false, name: 'YouTube comments', url: 'https://discord.com/channels/guild/thread',
    send: async (payload: any) => { copied.push({ id: String(BigInt(MID) + BigInt(copied.length + 1)), author: { id: BOT }, type: MessageType.Default, components: payload.components, createdTimestamp: Date.now(), delete: async () => { if (fail) throw Error('transient'); copied.shift(); } }); thread.messageCount++; },
    messages: { fetch: async () => new Collection(copied.map(m => [m.id, m])) }, permissionsFor: () => ({ has: () => false }), setName: async (name: string) => { thread.name = name; }, setArchived: async (v: boolean) => { thread.archived = v; } };
  const message = { id: MID, channelId: CHANNEL, guildId: 'guild', author: { id: BOT }, content: '', createdTimestamp: 1000, hasThread: false,
    channel: { type: ChannelType.GuildText, permissionsFor: () => ({ has: () => true }) }, get components() { return components; },
    edit: async (options: any) => { components = options.components.map((row: any) => ({ ...row, components: row.components.map((b: any) => ({ ...b, customId: b.custom_id })), toJSON: () => row })); }, delete: async () => {}, fetch: async () => message,
    startThread: async () => { message.hasThread = true; return thread; } };
  let manager: ReplyThreads;
  const statsOptions = { path: join(dir, 'expiry.json'), botUserId: BOT, now: () => now, fetchMessage: async () => message as StatsMessage,
    commentsEnabled: () => enabled, cleanupComments: async () => manager.cleanup({ guildId: 'guild', channelId: CHANNEL, threadId: MID }) };
  let stats = new YouTubeStats(statsOptions);
  const makeManager = () => new ReplyThreads({ botUserId: () => BOT, enabled: () => enabled, tracked: () => false, lookup: async () => null, fetchThread: async () => { fetches++; return thread as unknown as ThreadChannel; },
    resolveTarget: i => youtubeReplyTarget(i, { enabled: () => enabled, canView: (m, id) => stats.canView(m, id), lookup: async (_id, count, time) => { lookups++; return { ...parseYouTubeComments(body(ID, 2), ID)!, N: count, countTime: time }; } }) });
  manager = makeManager(); await stats.publish(message as StatsMessage, cards());
  const click = async () => { const i: any = { customId: `linky:yt:replies:${ID}`, message, guildId: 'guild', user: { id: 'user' }, guild: { members: { me: {} } }, deferred: false, reply: async (p: any) => answers.push(p.content), deferReply: async () => { i.deferred = true; }, editReply: async (p: any) => answers.push(p.content) }; await manager.handle(i as ButtonInteraction); };
  enabled = false; await click(); assert.equal(lookups, 0); assert.equal(fetches, 0);
  enabled = true; await click(); assert.equal(lookups, 1); assert(copied.length > 0);
  await click(); assert.equal(lookups, 1);
  manager = makeManager(); stats = new YouTubeStats(statsOptions); now = 86400000;
  await click(); assert.equal(lookups, 1); assert.equal(answers.at(-1), 'Comments are unavailable for this post');
  fail = true; await stats.sweep(); assert.equal(JSON.parse(await readFile(statsOptions.path, 'utf8')).length, 1);
  fail = false; await stats.sweep(); assert.equal(copied.length, 0); assert.equal(thread.name, 'Replies removed'); assert.equal(thread.archived, true); assert.equal(JSON.parse(await readFile(statsOptions.path, 'utf8')).length, 0);
});

test('YouTube ordinary expiry with no thread evidence does no replies cleanup or extra write', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'F4-off-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let now = 0, cleanup = 0, writes = 0;
  const message: StatsMessage = { id: MID, channelId: CHANNEL, author: { id: BOT }, content: '', hasThread: false, components: [], edit: async () => {}, delete: async () => {} };
  const stats = new YouTubeStats({ path: join(dir, 'expiry.json'), botUserId: BOT, now: () => now, fetchMessage: async () => message, write: async () => { writes++; }, cleanupComments: async () => { cleanup++; } });
  await stats.publish(message, cards()); assert.equal(writes, 1);
  now = 86400000; await stats.sweep(); assert.equal(cleanup, 0); assert.equal(writes, 2);
});

test('YouTube existing top-comment and statistics presentation remains byte identical', () => {
  const result = formatYouTubeStatistics({ viewCount: '12345', likeCount: '0', commentCount: '20', topComment: { text: 'A useful comment', author: 'Viewer' } }, `https://www.youtube.com/watch?v=${ID}`);
  assert.equal(JSON.stringify(result), '{"title":"YouTube stats","url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","color":16711680,"fields":[{"name":"Views","value":"**12,345**","inline":true},{"name":"Likes","value":"**0**","inline":true},{"name":"Comments","value":"**20**","inline":true},{"name":"Top comment","value":"A useful comment\\n\\nBy Viewer","inline":false}],"footer":{"text":"Snapshot when shared"}}');
});

test('YouTube comments request times out and does not start an unbounded second flight', async () => {
  let aborted = false;
  const lookup = createYouTubeLookup('key', { timeoutMs: 5, fetch: async (_url, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => { aborted = true; reject(Error('aborted')); }); }) });
  assert.equal(await lookup.comments(ID, '1', 0), null); assert(aborted);
});


test('YouTube comments cache holds at most 100 videos separately from statistics', async () => {
  let calls = 0;
  const lookup = createYouTubeComments('key', async parameters => { calls++; return body(parameters.videoId, 1); }, () => 0);
  await lookup(ID, '1', 0);
  for (let i = 0; i < 100; i++) await lookup(`V${String(i).padStart(10, '0')}`, '1', 0);
  assert.equal(calls, 101); await lookup(ID, '1', 0); assert.equal(calls, 102);
});

test('shared renderer matches the authored X presentation snapshot', async () => {
  const { parseXReplies } = await import('../src/services/XReplies');
  const fixture = (await import('./fixtures/x-conversation.json')).default;
  const golden = (await import('./fixtures/x-reply-payloads.json')).default;
  assert.equal(JSON.stringify(replyThreadPayloads(parseXReplies(fixture, fixture.status.id, 1795500000000)!)), JSON.stringify(golden));
});

test('YouTube parser refuses invalid comment fields and counts each discarded entry once', () => {
  const patches = [
    (x: any) => { x.snippet.videoId = 'abcdefghijk'; },
    (x: any) => { x.snippet.topLevelComment.id = ''; },
    (x: any) => { x.snippet.topLevelComment.snippet.textDisplay = ''; },
    (x: any) => { x.snippet.topLevelComment.snippet.textDisplay = 'x'.repeat(100001); },
    (x: any) => { x.snippet.topLevelComment.snippet.authorDisplayName = ''; },
    (x: any) => { x.snippet.topLevelComment.snippet.likeCount = -1; },
    (x: any) => { x.snippet.topLevelComment.snippet.likeCount = 1.5; },
    (x: any) => { x.snippet.topLevelComment.snippet.publishedAt = 'invalid'; },
    (x: any) => { x.snippet.topLevelComment.snippet.publishedAt = '1960-01-01T00:00:00Z'; },
  ];
  const data = body(ID, patches.length + 1); patches.forEach((patch, index) => patch(data.items[index]));
  const page = parseYouTubeComments(data, ID)!; assert.equal(page.m, 9); assert.equal(page.r, 10); assert.equal(page.replies.length, 1);
  assert.equal(parseYouTubeComments({}, ID), null);
});

test('YouTube comments bound concurrent work and reject invalid IDs without requests', async () => {
  let calls = 0, block = false; const resolves: ((value: any) => void)[] = [];
  const lookup = createYouTubeComments('key', async () => { calls++; return block ? new Promise(resolve => resolves.push(resolve)) : { items: [] }; }, () => 0);
  assert.equal(await lookup('invalid', '1', 0), null); assert.equal(calls, 0);
  block = true;
  const pending = Array.from({ length: 8 }, (_, i) => lookup(`V${String(i).padStart(10, '0')}`, '1', 0));
  const result = await Promise.race([lookup(ID, '1', 0), Promise.resolve('unexpected request')]);
  resolves.forEach(resolve => resolve({ items: [] })); await Promise.all(pending);
  assert.equal(result, null); assert.equal(calls, 8);
});


test('partial multi-video publication excludes Comments even when one card succeeds', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'F4-multi-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let components: unknown;
  const stats = new YouTubeStats({ path: join(dir, 'expiry.json'), botUserId: BOT, fetchMessage: async () => null, commentsEnabled: () => true });
  const message: StatsMessage = { id: MID, channelId: CHANNEL, author: { id: BOT }, content: '', edit: async options => { components = options.components; }, delete: async () => {} };
  await stats.publish(message, cards(), false); assert(!JSON.stringify(components).includes('linky:yt:replies:'));
});


test('YouTube current operator, server, channel and platform restrictions deny existing controls before REST', async () => {
  const message: any = { id: MID, guildId: 'guild', channelId: CHANNEL, author: { id: BOT }, channel: { type: ChannelType.GuildText },
    components: [{ type: 1, components: [{ customId: `linky:yt:replies:${ID}`, label: 'Comments (99)' }] }] };
  let calls = 0;
  for (const [input, operator] of [
    [{ guildId: 'guild', channelId: CHANNEL, serverEnabled: true }, false],
    [{ guildId: 'guild', channelId: CHANNEL, serverEnabled: false }, true],
    [{ guildId: 'guild', channelId: CHANNEL, serverEnabled: true, preferences: { channelIds: ['other'] } }, true],
    [{ guildId: 'guild', channelId: CHANNEL, serverEnabled: true, preferences: { platforms: { youtube: false } } }, true],
    [{ guildId: 'guild', channelId: CHANNEL, operatorServerIds: ['other'] }, true],
  ] as [Parameters<typeof youtubeCommentsScopeEnabled>[0], boolean][]) {
    assert.equal(youtubeCommentsScopeEnabled(input, operator), false);
    const interaction: any = { customId: `linky:yt:replies:${ID}`, message, guildId: 'guild', reply: async () => {} };
    const manager = new ReplyThreads({ botUserId: () => BOT, enabled: () => true, tracked: () => false, lookup: async () => { calls++; return null; }, fetchThread: async () => { calls++; return null; },
      resolveTarget: i => youtubeReplyTarget(i, { enabled: () => youtubeCommentsScopeEnabled(input, operator), canView: () => true, lookup: async () => { calls++; return null; } }) });
    await manager.handle(interaction); assert.equal(calls, 0);
  }
  assert(youtubeCommentsScopeEnabled({ guildId: 'guild', channelId: CHANNEL, serverEnabled: true }, true));
});

test('YouTube failure cache lasts exactly 30 seconds and request cap is literally 262144', async () => {
  let now = 0, calls = 0;
  const lookup = createYouTubeComments('key', async (parameters, comment, byteCap) => {
    calls++; assert.equal(parameters.videoId, 'dQw4w9WgXcQ'); assert.equal(comment, true); assert.equal(byteCap, 262144); return null;
  }, () => now);
  assert.equal(await lookup(ID, '1', 0), null); assert.equal(calls, 1);
  now = 29999; assert.equal(await lookup(ID, '1', 0), null); assert.equal(calls, 1);
  now = 30000; assert.equal(await lookup(ID, '1', 0), null); assert.equal(calls, 2);
});

test('YouTube target refuses zero labels and suffixes even on an exactly matching button', () => {
  const target = (customId: string, count: string) => youtubeReplyTarget({ customId,
    message: { components: [{ type: 1, components: [{ customId, label: `Comments (${count})` }]}], createdTimestamp: 0 } } as any,
    { enabled: () => true, canView: () => true, lookup: async () => null });
  for (const count of ['0', '00']) assert.equal(target(`linky:yt:replies:${ID}`, count)?.valid({} as any), false);
  assert.equal(target(`linky:yt:replies:${ID}/suffix`, '1'), undefined);
  assert.equal(target(`prefix:linky:yt:replies:${ID}`, '1'), undefined);
  assert.equal(target(`linky:yt:replies:${ID}`, '1')?.valid({} as any), true);
});

test('YouTube renderer independently caps externally supplied pages at 25 and labels video links', () => {
  const page = parseYouTubeComments(body(ID, 1), ID)!; page.replies = Array.from({length: 30}, () => page.replies[0]);
  const output = JSON.stringify(replyThreadPayloads(page));
  assert.equal((output.match(/\[Open video\]/g) ?? []).length, 25); assert(!output.includes('Open comment'));
});
