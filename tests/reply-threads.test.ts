import { ReplyCreationHistory } from '../src/services/ReplyCreationHistory';
import { atomicWrite } from '../src/services/AtomicWrite';
import { createBlueskyReplies } from '../src/services/BlueskyReplies';
import { sanitizeReplyText } from '../src/services/ReplyText';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelType, Collection, DiscordAPIError, MessageFlags, MessageType, type ButtonInteraction, type ThreadChannel } from 'discord.js';
import { createXReplies, parseXReplies } from '../src/services/XReplies';
import { ReplyLookupError, ReplyThreads, replyThreadPayloads, xRepliesButton } from '../src/services/ReplyThreads';
import { ReplyCleanupJournal } from '../src/services/ReplyCleanupJournal';
import { removeManual } from '../src/commands/fix';
import { RepostRegistry } from '../src/services/RepostRegistry';
import type { TweetTranslation } from '../src/services/TweetTranslation';
import fixture from './fixtures/x-conversation.json';

const ID = fixture.status.id;
const page = () => parseXReplies(fixture, ID, 1795500000000)!;
const failure = (code: number) => Object.assign(new Error('Discord failure'), { code });
function harness(lookup?: () => Promise<ReturnType<typeof page> | null>, expectedName = 'Replies to @NASA', historyPath?: string, onHistoryWarning?: (reason: string) => void, history?: ReplyCreationHistory) {
  let createError: Error | undefined;
  let tracked = true, enabled = true, permission = true, createCode = 0, fetchCode = 0, calls = 0, creates = 0;
  const sent: ReturnType<typeof replyThreadPayloads>[number][] = [], answers: string[] = [], deleted: string[] = [];
  const own = { type: MessageType.Default, components: replyThreadPayloads(page())[0].components, id: '31', author: { id: 'bot' }, createdTimestamp: Date.now(), delete: async () => { deleted.push('31'); } };
  const member = { type: MessageType.Default, components: [] as ReturnType<typeof replyThreadPayloads>[number]['components'], id: '32', author: { id: 'member' }, createdTimestamp: Date.now(), delete: async () => { deleted.push('32'); } };
  const thread = { id: '100', guildId: 'guild', parentId: 'channel', ownerId: 'bot', messageCount: 0, archived: false, locked: false, url: 'https://discord.com/channels/guild/100', name: '',
    send: async (payload: ReturnType<typeof replyThreadPayloads>[number]) => { sent.push(payload); thread.messageCount++; },
    messages: { fetch: async () => new Collection([['31', own], ['32', member]]) },
    permissionsFor: () => ({ has: () => false }), bulkDelete: async () => {},
    setName: async (name: string) => { thread.name = name; }, setArchived: async (value: boolean) => { thread.archived = value; } };
  const message = { id: historyPath ? '333333333333333333' : '100', guildId: 'guild', channelId: 'channel', author: { id: 'bot' }, hasThread: false,
    channel: { type: ChannelType.GuildText, permissionsFor: () => ({ has: () => permission }) },
    fetch: async () => message, startThread: async (options: { name: string; autoArchiveDuration: number }) => {
      creates++; assert.equal(options.autoArchiveDuration, 1440); assert.equal(options.name, expectedName);
      if (createError) throw createError;
      if (createCode) throw failure(createCode); message.hasThread = true; return thread;
    } };
  const managerOptions = { history, historyPath, onHistoryWarning, botUserId: () => 'bot', enabled: () => enabled, tracked: () => tracked,
    lookup: async () => { calls++; return lookup ? lookup() : page(); }, fetchThread: async () => { if (fetchCode) throw failure(fetchCode); return thread as unknown as ThreadChannel; } };
  const manager = new ReplyThreads(managerOptions);
  const click = (userId = 'user') => {
    const interaction = { customId: `linky:replies:x:${ID}:NASA`, message, guildId: 'guild', user: { id: userId },
      guild: { members: { me: {} } }, deferred: false,
      reply: async (payload: { content: string }) => { answers.push(payload.content); },
      deferReply: async (payload: { flags: number }) => { assert.equal(payload.flags, MessageFlags.Ephemeral); interaction.deferred = true; },
      editReply: async (payload: { content: string; allowedMentions: { parse: string[] } }) => { assert.deepEqual(payload.allowedMentions, { parse: [] }); answers.push(payload.content); } };
    return manager.handle(interaction as unknown as ButtonInteraction);
  };
  return { manager, message, thread, sent, answers, deleted, click,
    get calls() { return calls; }, get creates() { return creates; },
    set createError(value: Error | undefined) { createError = value; },
    set enabled(value: boolean) { enabled = value; }, set tracked(value: boolean) { tracked = value; },
    set permission(value: boolean) { permission = value; }, set createCode(value: number) { createCode = value; }, set fetchCode(value: number) { fetchCode = value; } };
}

test('recorded public conversation parses; sorting and once-only filtering preserve r/m/N', () => {
  const body = structuredClone(fixture);
  body.replies.reverse();
  body.replies.push(Object.assign({ ...body.replies[0], replying_to: { ...body.replies[0].replying_to, status: '999' } }, { possibly_sensitive: true }));
  const parsed = parseXReplies(body, ID, 1000)!;
  assert.equal(parsed.N, 47); assert.equal(parsed.r, 4); assert.equal(parsed.m, 1);
  assert.deepEqual(parsed.replies.map(reply => reply.likes), [...parsed.replies.map(reply => reply.likes)].sort((a,b) => b-a));
  assert.equal(parseXReplies(body, '999', 0), null); assert.equal(parseXReplies({}, ID, 0), null);
});
test('sensitive true dropped; absent sensitive retained; likes tie uses newest', () => {
  const body = structuredClone(fixture);
  Object.assign(body.replies[0], { possibly_sensitive: true });
  body.replies[1].likes = body.replies[2].likes = 10;
  body.replies[1].created_timestamp = 1; body.replies[2].created_timestamp = 2;
  const parsed = parseXReplies(body, ID, 0)!;
  assert.equal(parsed.m, 1); assert.equal(parsed.replies.length, 2); assert.equal(parsed.replies[0].timestamp, 2);
});
test('fixed-host lookup refuses redirects, caps bytes and coalesces; success/failure TTLs', async () => {
  let calls = 0, now = 0, fail = false;
  const lookup = createXReplies(async (url, options) => {
    calls++; assert.equal(url, `https://api.fxtwitter.com/2/conversation/${ID}`);
    assert.equal(options?.redirect, 'error'); assert.equal(options?.credentials, 'omit'); assert.ok(options?.signal);
    return new Response(JSON.stringify(fail ? { ...fixture, padding: 'x'.repeat(256 * 1024) } : fixture));
  }, () => now);
  await Promise.all([lookup(ID), lookup(ID)]); assert.equal(calls, 1);
  now = 299999; assert.ok(await lookup(ID)); assert.equal(calls, 1);
  fail = true; now = 300001; assert.equal(await lookup(ID), null); assert.equal(calls, 2);
  now += 29999; await lookup(ID); assert.equal(calls, 2);
  now += 2; await lookup(ID); assert.equal(calls, 3);
  assert.equal(await lookup('https://evil.test'), null);
});
test('greedy packing, inert mentions/links, counts, flags on every payload', () => {
  const value = page();
  value.replies = Array.from({ length: 10 }, (_, index) => ({ ...value.replies[0], text: '@everyone **bad** https://bad.test ' + 'x'.repeat(500), likes: index }));
  const payloads = replyThreadPayloads(value);
  assert.ok(payloads.length > 1);
  assert.ok(JSON.stringify(payloads).includes('Showing 10 of 47 replies from X'));
  for (const payload of payloads) {
    assert.equal(payload.flags, 36868); assert.deepEqual(payload.allowedMentions, { parse: [] });
    const texts = payload.components.flatMap(component => component.components.map(display => 'content' in display ? display.content : ''));
    assert.ok(texts.join('').length <= 3800); assert.ok(!texts.join('').includes('https://bad.test'));
  }
  assert.ok(JSON.stringify(payloads).includes('@\u200beveryone'));
});
test('button eligibility excludes all unsupported channel types and unknown/zero count', () => {
  const tweet = { url: `https://x.com/NASA/status/${ID}`, author: { handle: 'NASA' }, replies: 47 } as TweetTranslation;
  assert.match(JSON.stringify(xRepliesButton(tweet, ChannelType.GuildText, true)), /Replies \(47\)/);
  assert.ok(xRepliesButton(tweet, ChannelType.GuildAnnouncement, true));
  for (const type of [ChannelType.DM, ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.GuildForum, ChannelType.GuildMedia, ChannelType.PublicThread]) assert.equal(xRepliesButton(tweet, type, true), undefined);
  assert.equal(xRepliesButton(tweet, ChannelType.GuildText, false), undefined);
  assert.equal(xRepliesButton({ ...tweet, replies: 0 }, ChannelType.GuildText, true), undefined);
  assert.equal(xRepliesButton({ ...tweet, replies: undefined }, ChannelType.GuildText, true), undefined);
});
test('single-flight creates once; later click links without another lookup', async () => {
  const h = harness(); await Promise.all([h.click(), h.click('other')]);
  assert.equal(h.creates, 1); assert.equal(h.calls, 1); assert.equal(h.answers.length, 2);
  await h.click(); assert.equal(h.creates, 1); assert.equal(h.calls, 1);
  for (const payload of h.sent) { assert.equal(payload.flags, 36868); assert.deepEqual(payload.allowedMentions, { parse: [] }); }
});
test('off, untracked and missing local permissions make no lookup or thread call', async () => {
  for (const mode of ['enabled', 'tracked', 'permission'] as const) {
    const h = harness(); h[mode] = false; await h.click(); assert.equal(h.creates, 0); assert.equal(h.calls, 0);
    if (mode === 'permission') assert.match(h.answers[0], /Create Public Threads, Send Messages in Threads/);
  }
});
test('restart empty owned thread fills once; archived or locked thread links only', async () => {
  const h = harness(); h.message.hasThread = true; await Promise.all([h.click(), h.click('other')]);
  assert.equal(h.creates, 0); assert.equal(h.calls, 1);
  for (const key of ['archived', 'locked'] as const) {
    const other = harness(); other.message.hasThread = true; other.thread[key] = true; await other.click(); assert.equal(other.calls, 0);
  }
});
for (const [code, text] of [[160007, /active thread limit/], [160006, /active thread limit/], [50013, /denied permission/]] as const) test(`Discord ${code} is private and mapped`, async () => {
  const h = harness(); h.createCode = code; await h.click(); assert.match(h.answers[0], text);
});
test('160004 fetches existing; 10003 never recreates moderator-deleted thread', async () => {
  const h = harness(); h.createCode = 160004; h.thread.messageCount = 1; await h.click(); assert.equal(h.sent.length, 0); assert.match(h.answers[0], /discord.com/);
  const removed = harness(); removed.message.hasThread = true; removed.fetchCode = 10003; await removed.click(); assert.equal(removed.creates, 0); assert.match(removed.answers[0], /removed/);
});
test('cleanup keeps members and renames/archives; 10003 is done', async () => {
  const h = harness(); await h.manager.cleanup({ guildId: 'guild', channelId: 'channel', threadId: '100' });
  assert.deepEqual(h.deleted, ['31']); assert.equal(h.thread.name, 'Replies removed'); assert.equal(h.thread.archived, true);
  h.fetchCode = 10003; await h.manager.cleanup({ guildId: 'guild', channelId: 'channel', threadId: '100' });
});
test('manual Remove cleans its thread; failed journal survives restart; registry sweep leaves manual output alone', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'F2-replies-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const target = { guildId: '111111111111111111', channelId: '222222222222222222', threadId: '333333333333333333' };
  const path = join(dir, 'cleanup.json'); let fail = true, attempts = 0;
  const clean = async () => { attempts++; if (fail) throw Error('transient'); };
  const journal = new ReplyCleanupJournal(path, clean, () => {});
  let removed = false;
  const interaction = { customId: 'linky:remove-manual', guildId: target.guildId, channelId: target.channelId,
    applicationId: 'bot', client: { user: { id: 'bot' } }, user: { id: 'owner' },
    message: { id: target.threadId, author: { id: 'bot' }, webhookId: 'bot', interactionMetadata: { user: { id: 'owner' } } },
    deferUpdate: async () => {}, followUp: async (value: { flags: number; content: string }) => { assert.equal(value.flags, 64); assert.match(value.content, /Could not remove/); }, deleteReply: async () => { removed = true; } };
  await removeManual(interaction as unknown as ButtonInteraction, undefined, entry => journal.enqueue(entry));
  assert.ok(removed); assert.equal(attempts, 1); assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), [target]);
  fail = false; const restarted = new ReplyCleanupJournal(path, clean, () => {}); await restarted.sweep();
  assert.equal(attempts, 2); assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), []);
  const registry = new RepostRegistry({ path: join(dir, 'reposts.json'), botUserId: '444444444444444444', canRetry: async () => false, fetchMessage: async () => { throw Error('Manual output must not be fetched'); } });
  await registry.sweep(); assert.equal(registry.findByReplacement(target.threadId), undefined);
});


test('empty page and lookup failure create no thread', async () => {
  for (const value of [null, { ...page(), replies: [] }]) {
    const h = harness(async () => value); await h.click();
    assert.equal(h.creates, 0); assert.equal(h.answers[0], 'No replies Linky can show for this post');
  }
});
test('user and channel cooldowns prevent additional upstream requests', async () => {
  const h = harness(); await h.click('first');
  h.message.id = '101'; h.message.hasThread = false; await h.click('first');
  assert.equal(h.calls, 1); assert.equal(h.answers.at(-1), 'Try again in a minute');
  await h.click('second'); h.message.id = '102'; h.message.hasThread = false; await h.click('third');
  h.message.id = '103'; h.message.hasThread = false; await h.click('fourth');
  assert.equal(h.calls, 3); assert.equal(h.answers.at(-1), 'Try again in a minute');
});
test('Remove racing provider lookup waits; creation rechecks removing state', async () => {
  let release!: (value: ReturnType<typeof page>) => void;
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const lookup = new Promise<ReturnType<typeof page>>(resolve => { release = resolve; });
  const h = harness(async () => { began(); return lookup; });
  const click = h.click(); await started;
  const cleanup = h.manager.cleanup({ guildId: 'guild', channelId: 'channel', threadId: '100' });
  release(page()); await Promise.all([click, cleanup]);
  assert.equal(h.creates, 0); assert.match(h.answers[0], /removed/); assert.equal(h.thread.archived, true);
});
test('eight lookups in flight and 100-entry cache are bounded', async () => {
  const pending: (() => void)[] = []; let calls = 0;
  const lookup = createXReplies(async () => { calls++; await new Promise<void>(resolve => pending.push(resolve)); return new Response('{}'); });
  const requests = Array.from({ length: 8 }, (_, index) => lookup(String(index + 1)));
  assert.equal(await lookup('9'), null); assert.equal(calls, 8);
  pending.forEach(resolve => resolve()); await Promise.all(requests);
  let total = 0;
  const cached = createXReplies(async () => { total++; return new Response('{}'); });
  for (let index = 1; index <= 101; index++) await cached(String(index));
  await cached('1'); assert.equal(total, 102);
});
test('unknown thread and lost access clear the durable manual cleanup journal', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'F2-journal-')); t.after(() => rm(dir, { recursive: true, force: true }));
  for (const error of [10003, 50001, 50013]) {
    const h = harness(); h.fetchCode = error;
    const path = join(dir, `${error}.json`);
    const journal = new ReplyCleanupJournal(path, entry => h.manager.cleanup(entry), () => assert.fail('terminal cleanup must succeed'));
    await journal.enqueue({ guildId: '111111111111111111', channelId: '222222222222222222', threadId: '333333333333333333' });
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), []);
  }
});


test('short replies pack ten in one message rather than fixed groups of five', () => {
  const value = page(); value.replies = Array.from({ length: 10 }, () => ({ ...value.replies[0], text: 'short' }));
  assert.equal(replyThreadPayloads(value).length, 1);
});


test('a mismatched parent alone drops the entry', () => {
  const body = structuredClone(fixture); body.replies[0].replying_to.status = '999';
  const parsed = parseXReplies(body, ID, 0)!; assert.equal(parsed.m, 1); assert.equal(parsed.replies.length, 2);
});


test('cleanup waits for an in-flight thread send before deleting copied replies', async () => {
  const h = harness(); let began!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const send = h.thread.send;
  const pages = await h.thread.messages.fetch();
  h.thread.messages.fetch = async () => h.sent.length ? pages : new Collection();
  h.thread.send = async payload => { began(); await wait; await send(payload); };
  const click = h.click(); await started;
  const cleanup = h.manager.cleanup({ guildId: 'guild', channelId: 'channel', threadId: '100' });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(h.thread.name, '', 'cleanup must still wait while the page send is pending'); assert.deepEqual(h.deleted, []);
  release(); await Promise.all([click, cleanup]);
  assert.equal(h.creates, 1); assert.deepEqual(h.deleted, ['31']); assert.equal(h.thread.archived, true);
});


test('10008 on one copied message still deletes the rest and archives', async () => {
  const h = harness(); const messages = await h.thread.messages.fetch();
  messages.get('31')!.delete = async () => { throw failure(10008); };
  messages.set('33', { ...messages.get('31')!, id: '33', delete: async () => { h.deleted.push('33'); } });
  h.thread.messages.fetch = async () => messages;
  await h.manager.cleanup({ guildId: 'guild', channelId: 'channel', threadId: '100' });
  assert.deepEqual(h.deleted, ['33']); assert.equal(h.thread.name, 'Replies removed'); assert.equal(h.thread.archived, true);
});
test('manual removal reserves intent first; write failure preserves parent; crash after reserve recovers', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'F2-manual-reserve-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const target = { guildId: '111111111111111111', channelId: '222222222222222222', threadId: '333333333333333333' };
  let deleted = false, cleaned = false;
  const interaction = { customId: 'linky:remove-manual', guildId: target.guildId, channelId: target.channelId,
    applicationId: 'bot', client: { user: { id: 'bot' } }, user: { id: 'owner' },
    message: { id: target.threadId, author: { id: 'bot' }, webhookId: 'bot', interactionMetadata: { user: { id: 'owner' } } },
    deferUpdate: async () => {}, followUp: async (value: { flags: number; content: string }) => { assert.equal(value.flags, 64); assert.match(value.content, /Could not remove/); }, deleteReply: async () => { deleted = true; } } as unknown as ButtonInteraction;
  await removeManual(interaction, undefined, undefined, async () => { throw Error('disk full'); });
  assert.equal(deleted, false);
  const path = join(dir, 'journal.json'); const journal = new ReplyCleanupJournal(path, async () => { cleaned = true; }, () => {});
  await removeManual(interaction, undefined, async () => { throw Error('crash before drain'); }, entry => journal.reserve(entry));
  assert.equal(deleted, true); assert.equal(cleaned, false);
  await new ReplyCleanupJournal(path, async () => { cleaned = true; }, () => {}).sweep();
  assert.equal(cleaned, true); assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), []);
});


test('sanitized text stays within 500 serialized characters without cutting escapes or mention guards', () => {
  const text = sanitizeReplyText('*@'.repeat(500), 500, true);
  assert.ok(text.length <= 500); assert.ok(!text.endsWith('\\')); assert.doesNotMatch(text, /@(?!\u200b)/);
});


test('periodic sweep preserves a reservation while parent deletion is pending, blocks a racing click and recovers after restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'F2-reservation-race-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'cleanup.json'), target = { guildId: '111111111111111111', channelId: '222222222222222222', threadId: '333333333333333333' };
  let cleanups = 0;
  const journal = new ReplyCleanupJournal(path, async () => { cleanups++; }, () => {});
  let deleting!: () => void, releaseDelete!: () => void;
  const deletionStarted = new Promise<void>(resolve => { deleting = resolve; });
  const deletion = new Promise<void>(resolve => { releaseDelete = resolve; });
  const interaction = { customId: 'linky:remove-manual', guildId: target.guildId, channelId: target.channelId,
    applicationId: 'bot', client: { user: { id: 'bot' } }, user: { id: 'owner' },
    message: { id: target.threadId, author: { id: 'bot' }, webhookId: 'bot', interactionMetadata: { user: { id: 'owner' } } },
    deferUpdate: async () => {}, followUp: async (value: { flags: number; content: string }) => { assert.equal(value.flags, 64); assert.match(value.content, /Could not remove/); }, deleteReply: async () => { deleting(); await deletion; } } as unknown as ButtonInteraction;
  const removal = removeManual(interaction, undefined, async () => { throw Error('crash before enqueue'); }, entry => journal.reserve(entry));
  await deletionStarted; await journal.sweep();
  assert.equal(cleanups, 0); assert.equal(journal.has(target.threadId), true);
  const h = harness(); h.tracked = !journal.has(target.threadId); await h.click();
  assert.equal(h.creates, 0); assert.equal(h.calls, 0);
  releaseDelete(); await removal;
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), [target]);
  const restarted = new ReplyCleanupJournal(path, async () => { cleanups++; }, () => {});
  await restarted.sweep(); assert.equal(cleanups, 1); assert.equal(restarted.has(target.threadId), false);
});


test('160005 links an existing thread and 160004 followed by 10003 never recreates', async () => {
  const existing = harness(); existing.createCode = 160005; existing.thread.messageCount = 1;
  await existing.click(); assert.equal(existing.sent.length, 0); assert.equal(existing.answers[0], existing.thread.url);
  const gone = harness(); gone.createCode = 160004; gone.fetchCode = 10003;
  await gone.click(); assert.equal(gone.creates, 1); assert.equal(gone.answers[0], 'The replies thread for this post was removed');
});
test('10008 fetching the parent is privately reported as removed', async () => {
  const h = harness(); h.message.fetch = async () => { throw failure(10008); };
  await h.click(); assert.equal(h.answers[0], 'The replies thread for this post was removed'); assert.equal(h.creates, 0);
});

test('cleanup refuses a member-owned thread without mutating it', async () => {
  const h = harness(); h.thread.ownerId = 'member';
  await h.manager.cleanup({ guildId: 'guild', channelId: 'channel', threadId: '100' });
  assert.deepEqual(h.deleted, []); assert.equal(h.thread.name, ''); assert.equal(h.thread.archived, false);
});
test('cleanup reopens a 24-hour auto-archived thread before deleting pages', async () => {
  const h = harness(); h.thread.archived = true; const events: string[] = [];
  const fetch = h.thread.messages.fetch;
  h.thread.messages.fetch = async () => { assert.equal(h.thread.archived, false, 'archived threads must be reopened'); events.push('fetch'); return fetch(); };
  h.thread.setArchived = async value => { events.push(`archive:${value}`); h.thread.archived = value; };
  await h.manager.cleanup({ guildId: 'guild', channelId: 'channel', threadId: '100' });
  assert.deepEqual(events, ['archive:false', 'fetch', 'archive:true']); assert.deepEqual(h.deleted, ['31']);
});
for (const failureCode of [0, 50034]) test(`cleanup pages oldest first, splits fourteen-day messages and exercises bulk deletion (${failureCode})`, async () => {
  const h = harness(); const sample = (await h.thread.messages.fetch()).get('31')!;
  const all = new Collection<string, typeof sample>();
  const old = Date.now() - 15 * 86400_000;
  for (let index = 101; index <= 305; index++) {
    const id = String(index); all.set(id, { ...sample, id, author: { id: index <= 104 ? 'bot' : 'member' },
      createdTimestamp: index === 101 ? old : Date.now(), delete: async () => { h.deleted.push(id); } });
  }
  const cursors: string[] = [], batches: string[][] = [];
  h.thread.permissionsFor = () => ({ has: () => true });
  h.thread.messages.fetch = (async (options: { after: string; before?: string }) => {
    assert.equal(options.before, undefined); cursors.push(options.after);
    return new Collection([...all].filter(([id]) => BigInt(id) > BigInt(options.after)).slice(0, 100).reverse());
  }) as typeof h.thread.messages.fetch;
  h.thread.bulkDelete = (async (messages: typeof sample[]) => {
    batches.push(messages.map(value => value.id));
    assert.ok(messages.every(value => value.createdTimestamp > Date.now() - 14 * 86400_000));
    if (failureCode) throw failure(failureCode);
  }) as typeof h.thread.bulkDelete;
  if (failureCode) {
    await assert.rejects(h.manager.cleanup({ guildId: 'guild', channelId: 'channel', threadId: '100' }), { code: 50034 });
    assert.equal(h.thread.archived, false);
  } else {
    await h.manager.cleanup({ guildId: 'guild', channelId: 'channel', threadId: '100' });
    assert.deepEqual(cursors, ['100', '200', '300']);
    assert.deepEqual(batches, [['104', '103', '102']]); assert.deepEqual(h.deleted, ['101']);
    assert.equal(h.thread.archived, true);
  }
});
test('manual removal deletion rejection sends a private failure notice and releases held intent', async () => {
  let released = false; const notices: unknown[] = [];
  const interaction = { customId: 'linky:remove-manual', guildId: 'guild', channelId: 'channel', applicationId: 'bot',
    client: { user: { id: 'bot' } }, user: { id: 'owner' }, message: { id: '100', author: { id: 'bot' }, webhookId: 'bot', interactionMetadata: { user: { id: 'owner' } } },
    deferUpdate: async () => {}, deleteReply: async () => { throw Error('delete failed'); }, followUp: async (payload: unknown) => { notices.push(payload); } };
  assert.equal(await removeManual(interaction as unknown as ButtonInteraction, undefined, undefined, async () => {}, async () => { released = true; }), true);
  assert.equal(released, true); assert.deepEqual(notices, [{ content: 'Could not remove this preview. Try again.', flags: 64, allowedMentions: { parse: [] } }]);
});

test('MG turning replies off during lookup creates no thread', async () => {
  let began!: () => void, release!: (value: ReturnType<typeof page>) => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const pending = new Promise<ReturnType<typeof page>>(resolve => { release = resolve; });
  const h = harness(async () => { began(); return pending; });
  const click = h.click(); await started; h.enabled = false; release(page()); await click;
  assert.equal(h.calls, 1); assert.equal(h.creates, 0); assert.equal(h.sent.length, 0); assert.match(h.answers[0], /removed/);
});

test('oversize optional provider response gives the private too-many-replies message', async () => {
  const h = harness(async () => { throw new ReplyLookupError('This post has too many replies for Linky to load'); });
  await h.click(); assert.equal(h.creates, 0); assert.equal(h.answers[0], 'This post has too many replies for Linky to load');
});

test('thread name keeps exactly 100 characters and truncates 101 to 99 plus ellipsis', async () => {
  for (const length of [88, 89]) {
    const value = page(); value.threadHandle = 'a'.repeat(length);
    const expected = length === 88 ? 'Replies to @' + 'a'.repeat(88) : 'Replies to @' + 'a'.repeat(87) + '\u2026';
    assert.equal(expected.length, 100);
    const h = harness(async () => value, expected); await h.click();
    assert.equal(h.creates, 1); assert.ok(h.sent.length, JSON.stringify(h.answers));
  }
});

test('oversize Content-Length from Bluesky reaches the private too-many-replies response', async () => {
  const lookup = createBlueskyReplies(async () => new Response('{}', { headers: { 'content-length': '1048577' } }));
  const h = harness(async () => lookup('anchor.example.test/r'));
  await h.click(); assert.equal(h.creates, 0);
  assert.equal(h.answers[0], 'This post has too many replies for Linky to load');
});

const historyId = '333333333333333333';
test('F6 cleared HasThread after moderator deletion never recreates or looks up replies', async () => {
  const h = harness(); await h.click();
  h.message.hasThread = false; h.fetchCode = 10003;
  await h.click('another');
  assert.equal(h.creates, 1); assert.equal(h.calls, 1);
  assert.equal(h.answers.at(-1), 'The replies thread for this post was removed');
});
test('F6 durable history prevents recreation after restart with cleared HasThread', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'F6-history-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'history.json');
  const first = harness(undefined, undefined, path); first.message.id = historyId;
  await first.click(); assert.equal(first.creates, 1);
  const restarted = harness(undefined, undefined, path); restarted.message.id = historyId; restarted.fetchCode = 10003;
  await restarted.click(); assert.equal(restarted.creates, 0); assert.equal(restarted.calls, 0);
  assert.equal(restarted.answers.at(-1), 'The replies thread for this post was removed');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), [historyId]);
});
test('F6 never-created parent creates and archived remembered thread links without lookup', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'F6-archived-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'history.json');
  const h = harness(undefined, undefined, path); h.message.id = historyId;
  await h.click(); assert.equal(h.creates, 1);
  const restarted = harness(undefined, undefined, path); restarted.message.id = historyId;
  restarted.thread.archived = true; // No HasThread flag; durable identity still links it.
  await restarted.click(); assert.equal(restarted.creates, 0); assert.equal(restarted.calls, 0);
  assert.equal(restarted.answers[0], restarted.thread.url);
});
test('F6 capacity evicts oldest snowflake rather than insertion order and keeps file bounded', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'F6-capacity-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'history.json');
  const oldest = 100000000000000000n;
  const ids = Array.from({ length: 100000 }, (_, index) => String(oldest + BigInt(99999 - index)));
  await writeFile(path, JSON.stringify(ids));
  const h = harness(undefined, undefined, path); h.message.id = historyId;
  await h.click(); assert.equal(h.creates, 1);
  const saved = await readFile(path, 'utf8'); const entries = JSON.parse(saved) as string[];
  assert.equal(entries.length, 100000); assert.ok(Buffer.byteLength(saved) <= 2400002);
  assert.ok(!entries.includes(String(oldest))); assert.ok(entries.includes(ids[0])); assert.ok(entries.includes(historyId));
});
test('F6 corrupt history quarantines with operator warning then persists restart protection', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'F6-corrupt-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'history.json'); await writeFile(path, '{broken'); const warnings: string[] = [];
  const h = harness(undefined, undefined, path, reason => warnings.push(reason)); h.message.id = historyId;
  await h.click(); assert.equal(h.creates, 1); assert.equal(warnings.length, 1); assert.match(warnings[0], /quarantined/);
  assert.ok((await readdir(dir)).some(name => name.startsWith('history.json.corrupt-')));
  const restarted = harness(undefined, undefined, path); restarted.message.id = historyId; restarted.fetchCode = 10003;
  await restarted.click(); assert.equal(restarted.creates, 0);
});

test('F6 definitive API failure clears intent; write failure refuses Discord creation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'F6-failures-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'history.json'); const h = harness(undefined, undefined, path);
  h.message.id = '333333333333333333'; h.createError = refusal(50013, 403); await h.click();
  assert.equal(h.creates, 1); assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), []);
  const restarted = harness(undefined, undefined, path); restarted.message.id = h.message.id;
  await restarted.click(); assert.equal(restarted.creates, 1); assert.equal(restarted.answers[0], restarted.thread.url);
  const unwritable = join(dir, 'blocked'); const warnings: string[] = [];
  const blocked = harness(undefined, undefined, unwritable, reason => warnings.push(reason));
  await mkdir(unwritable); await blocked.click(); assert.equal(blocked.creates, 0); assert.equal(warnings.length, 1);
});
test('F6 concurrent parent reservations survive restart without lost IDs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'F6-concurrent-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'history.json'); let began!: () => void, release!: () => void, writes = 0;
  const started = new Promise<void>(resolve => { began = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const history = new ReplyCreationHistory(path, () => {}, { write: async (file, data) => {
    if (++writes === 1) { began(); await pending; } await atomicWrite(file, data);
  } });
  const first = history.reserve('333333333333333333'); await started;
  const second = history.reserve('444444444444444444'); release(); await Promise.all([first, second]);
  const restarted = new ReplyCreationHistory(path);
  assert.ok(restarted.has('333333333333333333')); assert.ok(restarted.has('444444444444444444')); assert.equal(writes, 2);
});

const refusal = (code: number, status = 403) => new DiscordAPIError({ message: 'Discord refusal', code }, code, status,
  'POST', 'https://discord.com/api/v10/channels/333333333333333333/threads', {});
for (const code of [50013, 160006]) test(`F6 definitive ${code} refusal clears persisted intent and restart can create`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'F6-refusal-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'history.json'); const h = harness(undefined, undefined, path); h.createError = refusal(code);
  await h.click(); assert.equal(h.creates, 1); assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), []);
  const restarted = harness(undefined, undefined, path); await restarted.click();
  assert.equal(restarted.creates, 1); assert.equal(restarted.answers[0], restarted.thread.url);
});
for (const kind of ['timeout', '5xx']) test(`F6 ambiguous ${kind} retains persisted intent and refuses recreation`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'F6-ambiguous-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'history.json'); const h = harness(undefined, undefined, path);
  h.createError = kind === 'timeout' ? Error('Timeout') : refusal(0, 503); await h.click();
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), [h.message.id]);
  const restarted = harness(undefined, undefined, path); restarted.fetchCode = 10003; await restarted.click();
  assert.equal(restarted.creates, 0); assert.equal(restarted.calls, 0); assert.match(restarted.answers[0], /removed/);
});
test('F6 failed definitive-refusal clear drops memory intent and retries after backoff', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'F6-clear-fail-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'history.json'); const warnings: string[] = []; let writes = 0, now = 0;
  const history = new ReplyCreationHistory(path, reason => warnings.push(reason), { now: () => now, write: async (file, data) => {
    if (++writes === 2) throw Error('disk unavailable'); await atomicWrite(file, data);
  } });
  const h = harness(undefined, undefined, path, undefined, history); h.createError = refusal(50013); await h.click();
  assert.equal(h.creates, 1); assert.equal(warnings.length, 1); assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), [h.message.id]);
  assert.equal(history.has(h.message.id), false);
  const restarted = harness(undefined, undefined, path); restarted.fetchCode = 10003; await restarted.click(); assert.equal(restarted.creates, 0);
  now = 60000; h.createError = undefined; await h.click('other');
  assert.equal(h.creates, 2); assert.equal(h.answers.at(-1), h.thread.url);
});
test('F6 invalid histories quarantine for size, capacity and schema; invalid saved ID is refused', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'F6-invalid-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const bodies = [' '.repeat(2400003) + '[]', JSON.stringify(Array(100001).fill('333333333333333333')), '["bad"]'];
  for (const [index, body] of bodies.entries()) {
    const path = join(dir, `history-${index}.json`); await writeFile(path, body); const warnings: string[] = [];
    const history = new ReplyCreationHistory(path, reason => warnings.push(reason));
    assert.equal(warnings.length, 1); assert.match(warnings[0], /quarantined/); assert.ok(history.canCreate());
    await assert.rejects(history.reserve('bad'), /Invalid reply parent ID/);
    await history.reserve('333333333333333333'); assert.ok(new ReplyCreationHistory(path).has('333333333333333333'));
  }
});
test('F6 failed quarantine blocks new lookup but existing thread links and restart recovers', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'F6-quarantine-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'history.json'); await writeFile(path, '{broken'); const warnings: string[] = [];
  const history = new ReplyCreationHistory(path, reason => warnings.push(reason), { rename: () => { throw Error('locked'); } });
  const h = harness(undefined, undefined, path, undefined, history); await h.click();
  assert.equal(h.creates, 0); assert.equal(h.calls, 0); assert.equal(warnings.length, 1); assert.match(warnings[0], /process run/);
  await assert.rejects(history.reserve(h.message.id), /unavailable/);
  h.message.hasThread = true; h.thread.messageCount = 1; await h.click(); assert.equal(h.answers[1], h.thread.url);
  const restarted = harness(undefined, undefined, path); await restarted.click(); assert.equal(restarted.creates, 1);
});
test('F6 existing thread write failure links and backs off repeated writes and warnings', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'F6-backoff-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const warnings: string[] = []; let writes = 0, now = 0;
  const history = new ReplyCreationHistory(join(dir, 'history.json'), reason => warnings.push(reason), {
    write: async () => { writes++; throw Error('disk unavailable'); }, now: () => now,
  });
  const h = harness(undefined, undefined, undefined, undefined, history); h.message.id = '333333333333333333';
  h.message.hasThread = true; h.thread.messageCount = 1; await h.click(); await h.click();
  assert.deepEqual(h.answers, [h.thread.url, h.thread.url]); assert.equal(writes, 1); assert.equal(warnings.length, 1);
  now = 60000; await h.click(); assert.equal(writes, 2);
});
test('F6 self-evicted oldest parent never rewrites full history on existing-thread clicks', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'F6-self-evict-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'history.json'); await writeFile(path, JSON.stringify(Array.from({ length: 100000 }, (_, i) => String(200000000000000000n + BigInt(i)))));
  let writes = 0; const history = new ReplyCreationHistory(path, () => {}, { write: async () => { writes++; } });
  const h = harness(undefined, undefined, undefined, undefined, history); h.message.id = '100000000000000000';
  h.message.hasThread = true; h.thread.messageCount = 1; await h.click(); await h.click();
  assert.equal(writes, 0); assert.deepEqual(h.answers, [h.thread.url, h.thread.url]);
});
test('F6 removal during history write refuses startThread after disk completes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'F6-removal-write-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let began!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; }); const pending = new Promise<void>(resolve => { release = resolve; });
  const history = new ReplyCreationHistory(join(dir, 'history.json'), () => {}, { write: async (file, data) => {
    began(); await pending; await atomicWrite(file, data);
  } });
  const h = harness(undefined, undefined, undefined, undefined, history); h.message.id = '333333333333333333';
  const click = h.click(); await started;
  const cleanup = h.manager.cleanup({ guildId: 'guild', channelId: 'channel', threadId: h.message.id });
  release(); await Promise.all([click, cleanup]); assert.equal(h.creates, 0); assert.match(h.answers[0], /removed/);
});

test('R11 member-owned thread is not remembered and its deletion permits Linky creation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'F6-R11-member-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'history.json'); const h = harness(undefined, undefined, path);
  h.message.hasThread = true; h.thread.ownerId = 'member'; await h.click();
  assert.equal(h.answers[0], h.thread.url); assert.equal(h.creates, 0);
  h.message.hasThread = false; h.thread.ownerId = 'bot'; await h.click();
  assert.equal(h.creates, 1); assert.equal(h.answers.at(-1), h.thread.url);
});
test('R11 replies disabled during save forgets unattempted intent and re-enabled click creates', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'F6-R11-off-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'history.json'); let h!: ReturnType<typeof harness>, writes = 0;
  const history = new ReplyCreationHistory(path, () => {}, { write: async (file, data) => {
    await atomicWrite(file, data); if (++writes === 1) h.enabled = false;
  } });
  h = harness(undefined, undefined, path, undefined, history); await h.click();
  assert.equal(h.creates, 0); assert.match(h.answers[0], /removed/);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), []);
  h.enabled = true; await h.click('other'); assert.equal(h.creates, 1);
});
test('R11 mixed-length snowflakes evict the numerically oldest parent', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'F6-R11-lengths-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'history.json'); const oldest = '999999999999999999';
  const newer = Array.from({ length: 99999 }, (_, i) => String(1000000000000000000n + BigInt(i)));
  await writeFile(path, JSON.stringify([...newer, oldest])); const history = new ReplyCreationHistory(path);
  await history.reserve('2000000000000000000'); const restored = new ReplyCreationHistory(path);
  assert.equal(restored.has(oldest), false); assert.equal(restored.has(newer[0]), true);
});
for (const code of [160004, 160005]) test(`R11 existing-thread conflict ${code} keeps durable intent`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'F6-R11-conflict-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'history.json'); const h = harness(undefined, undefined, path);
  h.createError = refusal(code, 400); h.thread.messageCount = 1; await h.click();
  assert.equal(h.creates, 1); assert.equal(h.answers[0], h.thread.url);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), [h.message.id]);
  const restarted = harness(undefined, undefined, path); restarted.fetchCode = 10003; await restarted.click();
  assert.equal(restarted.creates, 0); assert.match(restarted.answers[0], /removed/);
});
