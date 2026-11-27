import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelType, Collection, ComponentType, Events, MessageFlags, MessageFlagsBitField, MessageType, type Client, type Interaction, type ThreadChannel } from 'discord.js';
import { createBot } from '../src/bot';
import { ServerSettings } from '../src/services/ServerSettings';
import { RepostRegistry } from '../src/services/RepostRegistry';
import { ReplyCleanupJournal } from '../src/services/ReplyCleanupJournal';
import { ReplyThreads, replyThreadPayloads, REPLY_PAGE_MARKER, type ReplyPage } from '../src/services/ReplyThreads';
import { createXReplies } from '../src/services/XReplies';
import { sanitizeReplyText } from '../src/services/ReplyText';
import { formatYouTubeStatistics } from '../src/services/YouTube';

const GUILD = '111111111111111111', CHANNEL = '222222222222222222', BOT = '444444444444444444', OWNER = '555555555555555555';
const ID = String(BigInt(Date.now() - 1_420_070_400_000) << 22n), SOURCE = String(BigInt(ID) + 1n);
const error = (code: number) => Object.assign(new Error('Discord error'), { code });
const page: ReplyPage = { N: 30, r: 5, m: 3, countTime: 1700000000000, source: 'X', orderLabel: 'most liked first',
  replies: [{ name: 'Display *name*', handle: 'foo', profileUrl: 'https://x.com/foo', url: 'https://x.com/foo/status/21',
    text: 'hi @everyone https://example.test', likes: 7, timestamp: 1700000000, hasMedia: true },
  { name: 'Second', handle: 'bar', profileUrl: 'https://x.com/bar', url: 'https://x.com/bar/status/22',
    text: 'second reply', likes: 2, timestamp: 1700000001, hasMedia: false }] };
const marker = replyThreadPayloads(page)[0].components;
const predicates = { isChatInputCommand: () => false, isMessageContextMenuCommand: () => false, isButton: () => false,
  isStringSelectMenu: () => false, isChannelSelectMenu: () => false };
async function dispatch(client: Client, input: Record<string, unknown>) {
  for (const listener of client.listeners(Events.InteractionCreate)) await listener({ ...predicates, ...input } as unknown as Interaction);
}

async function fixture(t: TestContext, { enabled = true, registered = false, cap = false, pending = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'F2-cleanup-')); const settingsPath = join(directory, 'servers.json'), journalPath = join(directory, 'reply-cleanup.json');
  const servers = new ServerSettings(settingsPath); if (enabled) await servers.update(GUILD, { replies: true });
  if (cap) writeFileSync(journalPath, JSON.stringify(Array.from({ length: 10_000 }, (_, index) => ({ guildId: GUILD, channelId: CHANNEL, threadId: String(800000000000000000n + BigInt(index)) }))));
  if (pending) writeFileSync(journalPath, JSON.stringify([{ guildId: GUILD, channelId: CHANNEL, threadId: ID }]));
  const events: string[] = [], warnings: unknown[] = []; let calls = 0, threadCode = 0, parentExists = true, parentCode = 0, archiveFailures = 0;
  type Stored = { id: string; type: MessageType; author: { id: string }; components: typeof marker; createdTimestamp: number; delete(): Promise<void> };
  const messages = new Collection<string, Stored>();
  const add = (label: string, authorId = BOT, type = MessageType.Default, marked = false, deletionCode = 0) => {
    messages.set(label, { id: label, author: { id: authorId }, type, components: marked ? marker : [], createdTimestamp: Date.now(), delete: async () => {
      events.push(`delete:${label}`); if (deletionCode) throw error(deletionCode); messages.delete(label);
    } });
  };
  add('page', BOT, MessageType.Default, true); add('member', OWNER, MessageType.Default, true); add('member-repost'); add('manual-output');
  for (const label of ['member-repost', 'manual-output']) messages.get(label)!.components = [{ type: ComponentType.Container, id: 1, components: [{ type: ComponentType.TextDisplay, content: 'Member content preserved by Linky' }] }];
  add('rename-system', BOT, MessageType.ChannelNameChange, true, 50021); add('starter', BOT, MessageType.ThreadStarterMessage, true, 50021);
  const thread = { id: ID, guildId: GUILD, parentId: CHANNEL, ownerId: BOT, name: 'Replies to @foo', archived: false, locked: false,
    renameCode: 0, archiveCode: 0, isThread: () => true,
    messages: { fetch: async () => { calls++; return new Collection(messages); } }, permissionsFor: () => ({ has: () => false }),
    bulkDelete: async () => {}, setName: async (value: string) => {
      events.push('rename'); if (thread.renameCode) throw error(thread.renameCode); thread.name = value; add('new-rename-system', BOT, MessageType.ChannelNameChange, false, 50021);
    }, setArchived: async (value: boolean) => {
      events.push(`archive:${value}`); if (thread.archiveCode) throw error(thread.archiveCode);
      if (archiveFailures-- > 0) throw Object.assign(new Error('Temporary'), { status: 503 }); thread.archived = value;
    } };
  const channel = { threads: { cache: new Map([[ID, thread]]) }, type: 0 };
  const parent = { id: ID, guildId: GUILD, channelId: CHANNEL, author: { id: BOT }, webhookId: BOT, interactionMetadata: { user: { id: OWNER } },
    type: MessageType.Default, partial: false, hasThread: true, flags: new MessageFlagsBitField(), channel,
    delete: async () => { events.push('parent-delete'); parentExists = false; } };
  const source = { id: SOURCE, guildId: GUILD, channelId: CHANNEL, author: { id: OWNER }, content: 'https://x.com/foo/status/20', editedTimestamp: null };
  const record = { guildId: GUILD, channelId: CHANNEL, sourceId: SOURCE, replacementId: ID, authorId: OWNER, mode: 'reply' as const };
  if (registered) {
    const saved = new RepostRegistry({ path: join(directory, 'reposts.json'), botUserId: BOT, canRetry: async () => true, fetchMessage: async () => null });
    assert.equal(await saved.remember(record), true);
  }
  let journal: ReplyCleanupJournal | undefined, registry: RepostRegistry | undefined;
  const reserve = ReplyCleanupJournal.prototype.reserve;
  const enqueue = ReplyCleanupJournal.prototype.enqueue; let gatewayJob: Promise<void> | undefined;
  t.mock.method(ReplyCleanupJournal.prototype, 'enqueue', function (this: ReplyCleanupJournal, entry: Parameters<typeof enqueue>[0]) { journal = this; gatewayJob = enqueue.call(this, entry); return gatewayJob; });
  t.mock.method(ReplyCleanupJournal.prototype, 'reserve', async function (this: ReplyCleanupJournal, entry: Parameters<typeof reserve>[0]) { journal = this; await reserve.call(this, entry); });
  t.mock.method(RepostRegistry.prototype, 'start', function (this: RepostRegistry) { registry = this; });
  const client = createBot({ discordToken: 'unused', settingsPath, channelIds: [], serverIds: [], rewritePlatforms: ['x'], translateTweets: false },
    { info: () => {}, warn: (...args: unknown[]) => warnings.push(args), error: () => {} } as never, servers);
  Object.assign(client, { user: { id: BOT }, application: { id: BOT } });
  t.after(async () => { await client.destroy(); rmSync(directory, { recursive: true, force: true }); });
  t.mock.method(client.channels, 'fetch', async (id: string) => {
    calls++;
    if (id === ID) { if (registered) assert.equal(parentExists, false, 'owned parent deletion precedes thread discovery'); if (threadCode) throw Object.assign(Error("thread unavailable"), { status: threadCode }); return thread as never; }
    assert.equal(id, CHANNEL);
    return { messages: { fetch: async ({ message }: { message: string }) => {
      calls++; if (parentCode) throw error(parentCode); if (message === SOURCE) return source;
      assert.equal(message, ID); if (!parentExists) throw error(10008); return parent;
    } } } as never;
  });
  if (registered) for (const listener of client.listeners(Events.ClientReady)) await listener({ application: { commands: { set: async () => {} } }, user: { id: BOT, tag: 'Linky' }, guilds: { cache: new Map() } } as unknown as Client<true>);
  const manualRemove = async (gateway = false) => dispatch(client, { isButton: () => true, customId: 'linky:remove-manual', guildId: GUILD, channelId: CHANNEL,
    applicationId: BOT, client, user: { id: OWNER }, message: parent, deferUpdate: async () => {}, followUp: async (payload: unknown) => { warnings.push(payload); },
    deleteReply: async () => { events.push('manual-parent-delete'); parentExists = false; if (gateway) Reflect.apply(client.emit, client, [Events.MessageDelete, parent]); } });
  return { client, parent, source, record, messages, add, thread, events, warnings, journalPath, manualRemove, servers,
    get journal() { assert.ok(journal); return journal; }, get registry() { assert.ok(registry); return registry; },
    get gatewayJob() { assert.ok(gatewayJob); return gatewayJob; },
    get queuedGateway() { return gatewayJob; },
    get calls() { return calls; }, set threadCode(value: number) { threadCode = value; }, set parentCode(value: number) { parentCode = value; }, set archiveFailures(value: number) { archiveFailures = value; },
    get parentExists() { return parentExists; }, set parentExists(value: boolean) { parentExists = value; } };
}

for (const code of [10003, 10008, 50001, 50013]) test(`real manual-journal callback retires terminal ${code}`, async t => {
  const f = await fixture(t); f.parentCode = code; await f.manualRemove();
  assert.deepEqual(JSON.parse(readFileSync(f.journalPath, 'utf8')), []);
  const calls = f.calls; await f.journal.sweep(); assert.equal(f.calls, calls);
  if (code === 10008) assert.deepEqual(f.events.filter(value => value.startsWith('delete:')), ['delete:page']);
});

for (const path of ['Remove', 'Retry', 'source deletion'] as const) test(`real bot registry ${path} wiring deletes only marked reply pages`, async t => {
  const f = await fixture(t, { registered: true });
  if (path === 'Remove') assert.equal(await f.registry.remove(f.record), true);
  else if (path === 'Retry') assert.equal(await f.registry.retry(f.record, async () => undefined), true);
  else await f.registry.handleSourceDelete(f.source);
  assert.equal(f.parentExists, false);
  assert.deepEqual(f.events.filter(value => value.startsWith('delete:')), ['delete:page']);
  assert.ok(f.messages.has('member-repost')); assert.ok(f.messages.has('manual-output'));
  assert.ok(f.messages.has('starter')); assert.ok(f.messages.has('rename-system')); assert.ok(f.messages.has('member'));
  assert.equal(f.thread.archived, true);
  Reflect.apply(f.client.emit, f.client, [Events.MessageDelete, f.parent]);
  assert.equal(existsSync(f.journalPath), false, 'completed automatic cleanup must not be journaled again');
});

test('manual gateway plus explicit enqueue deduplicate and a second cleanup is a no-op', async t => {
  const f = await fixture(t); await f.manualRemove(true); await f.journal.sweep();
  assert.equal(f.events.filter(value => value === 'rename').length, 1); assert.equal(f.thread.archived, true);
  const before = [...f.events], calls = f.calls;
  await f.journal.enqueue({ guildId: GUILD, channelId: CHANNEL, threadId: ID }); assert.deepEqual(f.events, before); assert.equal(f.calls, calls);
  const manager = new ReplyThreads({ botUserId: () => BOT, enabled: () => true, tracked: () => true, lookup: async () => null, fetchThread: async () => f.thread as unknown as ThreadChannel });
  await manager.cleanup({ guildId: GUILD, channelId: CHANNEL, threadId: ID }); assert.deepEqual(f.events, before);
});
test('transient archive failure retains intent, then retry completes without touching system messages', async t => {
  const f = await fixture(t); f.archiveFailures = 1; await f.manualRemove();
  assert.equal(JSON.parse(readFileSync(f.journalPath, 'utf8')).length, 1);
  await f.journal.sweep(); assert.deepEqual(JSON.parse(readFileSync(f.journalPath, 'utf8')), []); assert.equal(f.thread.archived, true);
  assert.deepEqual(f.events.filter(value => value.startsWith('delete:')), ['delete:page']);
});
for (const archived of [false, true]) for (const code of [50083, 160005, 50001, 50013]) test(`locked ${archived ? 'archived' : 'active'} thread ${code} never blocks the parent`, async t => {
  const f = await fixture(t, { registered: true }); f.thread.locked = true; f.thread.archived = archived; f.thread.renameCode = code; f.thread.archiveCode = code;
  assert.equal(await f.registry.remove(f.record), true); assert.equal(f.parentExists, false); assert.ok(!f.messages.has('page'));
  assert.ok(!f.events.includes('archive:false'));
});
test('50021 skips a non-deletable marked Default page and still removes other pages', async t => {
  const f = await fixture(t); f.add('gone-system', BOT, MessageType.Default, true, 50021); f.add('second-page', BOT, MessageType.Reply, true);
  await f.manualRemove(); assert.ok(!f.messages.has('second-page')); assert.equal(f.thread.archived, true); assert.deepEqual(JSON.parse(readFileSync(f.journalPath, 'utf8')), []);
});

test('off-server deletes and uncached on-server deletes do no journal write and no REST', async t => {
  const f = await fixture(t, { enabled: false }); f.parent.hasThread = false; f.parent.channel.threads.cache.clear();
  Reflect.apply(f.client.emit, f.client, [Events.MessageDelete, f.parent]); await f.queuedGateway;
  assert.equal(f.calls, 0); assert.equal(existsSync(f.journalPath), false);
  await f.servers.update(GUILD, { replies: true });
  for (let index = 0; index < 100; index++) Reflect.apply(f.client.emit, f.client, [Events.MessageDelete, { ...f.parent, id: String(700000000000000000n + BigInt(index)), partial: true, author: null, interactionMetadata: null, channel: { type: 0 } }]);
  assert.equal(f.calls, 0); assert.equal(existsSync(f.journalPath), false);
});
test('journal cap logs a refusal without breaking manual Remove', async t => {
  const f = await fixture(t, { cap: true }); const before = readFileSync(f.journalPath, 'utf8');
  await f.manualRemove(); assert.equal(f.parentExists, false); assert.ok(f.warnings.some(warning => JSON.stringify(warning).includes('full')));
  assert.equal(f.calls, 0); assert.equal(readFileSync(f.journalPath, 'utf8'), before);
});

test('full header and every entry field use the contract and every page has its controlled marker', () => {
  const payloads = replyThreadPayloads(page); assert.equal(payloads.length, 1);
  assert.equal(payloads[0].components[0].id, REPLY_PAGE_MARKER);
  assert.equal(payloads[0].components[0].type, ComponentType.Container);
  assert.deepEqual(payloads[0].components[0].components.map(value => 'content' in value ? value.content : undefined), [
    'Showing 2 of 30 replies from X, most liked first (X returned 5; Linky hid 3). Count as of <t:1700000000:f>.',
    '**Display \\*name\\*** \u00b7 @foo\n-# 7 likes \u00b7 <t:1700000000:R> \u00b7 [Open reply](<https://x.com/foo/status/21>) \u00b7 [Profile](<https://x.com/foo>)\nhi @\u200beveryone \\[link\\]\n-# media not shown \u00b7 [Open reply](<https://x.com/foo/status/21>)',
    undefined,
    '**Second** \u00b7 @bar\n-# 2 likes \u00b7 <t:1700000001:R> \u00b7 [Open reply](<https://x.com/bar/status/22>) \u00b7 [Profile](<https://x.com/bar>)\nsecond reply',
  ]);
});
test('a redirected successful-looking response is refused before parsing', async () => {
  const response = new Response(JSON.stringify({ status: { id: '20', replies: 30 }, replies: [] }));
  Object.defineProperty(response, 'redirected', { value: true });
  assert.equal(await createXReplies(async () => response)('20'), null);
});
test('five-second deadline aborts a stalled fetch under fake timers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let deadline: number | undefined;
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    deadline = milliseconds; const controller = new AbortController(); setTimeout(() => controller.abort(), milliseconds); return controller.signal;
  });
  let finished = false;
  const lookup = createXReplies(async (_url, options) => new Promise<Response>((_resolve, reject) => {
    options!.signal!.addEventListener('abort', () => reject(new Error('deadline')), { once: true });
  }));
  const result = lookup('20').then(value => { finished = true; return value; });
  t.mock.timers.tick(4999); await Promise.resolve(); assert.equal(finished, false);
  t.mock.timers.tick(1); assert.equal(await result, null); assert.equal(finished, true); assert.equal(deadline, 5000);
});
test('YouTube source-length truncation stays byte-for-byte compatible with main', () => {
  const original = (value: string, limit: number) => {
    const clean = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g, ' ')
      .replace(/(?:https?:\/\/|www\.|\bdiscord\.gg\/|\bdiscord(?:app)?\.com\/invite\/)\S+/gi, '[link]').replace(/\s+/g, ' ').trim();
    const shortened = clean.length > limit ? clean.slice(0, limit - 1).trimEnd() + '\u2026' : clean;
    return shortened.replace(/[\\`*_{}\[\]()<>~|#+\-]/g, '\\$&').replace(/@/g, '@\u200b');
  };
  for (const text of ['a-b '.repeat(50), '*@'.repeat(200), '\u{1f600}'.repeat(150), 'short https://example.test @name']) {
    assert.equal(sanitizeReplyText(text, 240), original(text, 240));
    const embed = formatYouTubeStatistics({ commentCount: '2', topComment: { text, author: 'A-B_C', likes: 3 } } as never, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal(embed!.fields!.find(value => value.name === 'Top comment')!.value, `${original(text, 240)}\n\nBy ${original('A-B_C', 50)}`);
  }
});


test('online moderator deletion of a cached manual parent cleans its pages through the gateway', async t => {
  const f = await fixture(t); f.parentExists = false;
  Reflect.apply(f.client.emit, f.client, [Events.MessageDelete, f.parent]); await f.gatewayJob;
  assert.ok(!f.messages.has('page')); assert.equal(f.thread.archived, true); assert.deepEqual(JSON.parse(readFileSync(f.journalPath, 'utf8')), []);
});
test('an uncached parent with an owned thread in cache is eligible for bounded cleanup', async t => {
  const f = await fixture(t); f.parentExists = false;
  Reflect.apply(f.client.emit, f.client, [Events.MessageDelete, { ...f.parent, partial: true, author: null, interactionMetadata: null }]); await f.gatewayJob;
  assert.ok(!f.messages.has('page')); assert.equal(f.thread.archived, true);
});


test('enqueue attempts only its new transient job and minute sweeps are bounded to fifty', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'F2-bounded-drain-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  let attempts = 0;
  const journal = new ReplyCleanupJournal(join(directory, 'cleanup.json'), async () => { attempts++; throw Error('transient'); }, () => {});
  for (let index = 0; index < 100; index++) await journal.enqueue({ guildId: GUILD, channelId: CHANNEL, threadId: String(600000000000000000n + BigInt(index)) });
  assert.equal(attempts, 100); await journal.sweep(); assert.equal(attempts, 150);
});


for (const type of [ChannelType.PublicThread, ChannelType.GuildVoice, ChannelType.GuildForum]) test(`ineligible channel ${type} deletion causes no reply-cleanup work`, async t => {
  const f = await fixture(t); f.parent.channel.type = type; f.parent.hasThread = false; f.parent.channel.threads.cache.clear();
  Reflect.apply(f.client.emit, f.client, [Events.MessageDelete, f.parent]); await f.queuedGateway;
  assert.equal(f.calls, 0); assert.equal(existsSync(f.journalPath), false);
});
test('private manual parent deletion causes no reply-cleanup work', async t => {
  const f = await fixture(t); f.parent.flags.add(MessageFlags.Ephemeral); f.parent.hasThread = false; f.parent.channel.threads.cache.clear();
  Reflect.apply(f.client.emit, f.client, [Events.MessageDelete, f.parent]); await f.queuedGateway;
  assert.equal(f.calls, 0); assert.equal(existsSync(f.journalPath), false);
});


for (const path of ['Remove', 'Retry', 'source deletion', 'manual Remove', 'gateway deletion'] as const) test(`existing threads clean after replies are disabled: ${path}`, async t => {
  const registered = ['Remove', 'Retry', 'source deletion'].includes(path);
  const f = await fixture(t, { registered });
  // The fixture contains the marked pages created while replies were on.
  await f.servers.update(GUILD, { replies: false });
  if (path === 'Remove') assert.equal(await f.registry.remove(f.record), true);
  else if (path === 'Retry') assert.equal(await f.registry.retry(f.record, async () => undefined), true);
  else if (path === 'source deletion') await f.registry.handleSourceDelete(f.source);
  else if (path === 'manual Remove') await f.manualRemove();
  else { f.parentExists = false; Reflect.apply(f.client.emit, f.client, [Events.MessageDelete, f.parent]); await f.gatewayJob; }
  assert.equal(f.parentExists, false); assert.equal(f.messages.has('page'), false); assert.equal(f.thread.archived, true);
  assert.deepEqual(f.events.filter(value => value.startsWith('delete:')), ['delete:page']);
});
test('an existing manual journal entry permits cleanup when replies are off and flags are missing', async t => {
  const f = await fixture(t, { enabled: false, pending: true }); f.parent.hasThread = false; f.parent.channel.threads.cache.clear();
  await f.manualRemove(); assert.equal(f.messages.has('page'), false); assert.deepEqual(JSON.parse(readFileSync(f.journalPath, 'utf8')), []);
});
test('unknown missing registry parent makes one bounded thread lookup even with replies off', async t => {
  const f = await fixture(t, { registered: true }); await f.servers.update(GUILD, { replies: false }); f.parentExists = false;
  const before = f.calls; assert.equal(await f.registry.remove(f.record), true);
  assert.equal(f.messages.has('page'), false);
  // Parent fetch(2), direct thread fetch(1), message list(1); no discovery refetch of the parent.
  assert.equal(f.calls - before, 4);
});
test('sweep cursor advances to the next surviving job after successful removals', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'F2-fair-sweep-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'cleanup.json');
  const entries = Array.from({ length: 150 }, (_, index) => ({ guildId: GUILD, channelId: CHANNEL, threadId: String(600000000000000000n + BigInt(index)) }));
  writeFileSync(path, JSON.stringify(entries)); const order: string[] = [];
  const journal = new ReplyCleanupJournal(path, async entry => { order.push(entry.threadId); }, () => assert.fail('cleanup failed'));
  await journal.sweep(); await journal.sweep(); assert.deepEqual(order, entries.slice(0, 100).map(entry => entry.threadId));
  await journal.sweep(); assert.deepEqual(order, entries.map(entry => entry.threadId));
});


for (const enabled of [false, true]) for (const author of [OWNER, '666666666666666666']) test(`member-owned thread on another author ${author} with replies ${enabled} makes zero cleanup work`, async t => {
  const f = await fixture(t, { enabled }); f.thread.ownerId = OWNER; f.parentExists = false;
  const message = { ...f.parent, author: { id: author }, webhookId: null, interactionMetadata: null, hasThread: true };
  Reflect.apply(f.client.emit, f.client, [Events.MessageDelete, message]); await f.queuedGateway;
  assert.equal(f.calls, 0); assert.equal(existsSync(f.journalPath), false);
});
test('off manual removal with no thread evidence deletes directly without journal or REST', async t => {
  const f = await fixture(t, { enabled: false }); f.parent.hasThread = false; f.parent.channel.threads.cache.clear();
  await f.manualRemove(); assert.equal(f.parentExists, false);
  assert.equal(f.calls, 0); assert.equal(existsSync(f.journalPath), false);
});

for (const enabled of [false, true]) test(`cached member owner overrides Linky parent flag with setting ${enabled}`, async t => {
  const f = await fixture(t, { enabled }); f.thread.ownerId = OWNER; f.parentExists = false;
  const message = { ...f.parent, webhookId: null, interactionMetadata: null };
  Reflect.apply(f.client.emit, f.client, [Events.MessageDelete, message]); await f.queuedGateway;
  assert.equal(f.calls, 0); assert.equal(existsSync(f.journalPath), false);
});
for (const ownApp of [false, true]) test(`application identity branch accepts only own interaction output: ${ownApp}`, async t => {
  const f = await fixture(t); f.parentExists = false; f.parent.channel.threads.cache.clear();
  const app = ownApp ? BOT : '666666666666666666';
  const message = { ...f.parent, author: { id: '777777777777777777' }, webhookId: app, applicationId: app };
  Reflect.apply(f.client.emit, f.client, [Events.MessageDelete, message]); await f.queuedGateway;
  assert.equal(f.calls, ownApp ? 4 : 0); assert.equal(existsSync(f.journalPath), ownApp);
});
for (const retry of [false, true]) test(`off/no-thread registry removal skips failed thread discovery: retry ${retry}`, async t => {
  const f = await fixture(t, { enabled: false, registered: true }); f.parent.hasThread = false; f.threadCode = 503;
  let regenerations = 0;
  assert.equal(await (retry ? f.registry.retry(f.record, async () => { regenerations++; }) : f.registry.remove(f.record)), true);
  assert.equal(f.parentExists, false); assert.equal(f.calls, retry ? 6 : 2);
  assert.equal(regenerations, retry ? 1 : 0); assert.equal(existsSync(f.journalPath), false);
});
test('transient thread discovery never prevents owned parent deletion and has a durable retry', async t => {
  const f = await fixture(t, { registered: true }); f.threadCode = 503;
  assert.equal(await f.registry.remove(f.record), true); assert.equal(f.parentExists, false);
  assert.deepEqual(JSON.parse(readFileSync(f.journalPath, 'utf8')), [{ guildId: GUILD, channelId: CHANNEL, threadId: ID }]);
  f.threadCode = 0;
  const restored = new ReplyCleanupJournal(f.journalPath, async target => {
    const manager = new ReplyThreads({ botUserId: () => BOT, enabled: () => true, tracked: () => false, lookup: async () => null, fetchThread: async () => f.thread as never });
    await manager.cleanup(target);
  }, () => assert.fail('retry failed'));
  await restored.sweep(); assert.equal(f.messages.has('page'), false); assert.equal(restored.has(ID), false);
});
test('absent replies setting denies the actual bot click before any thread or provider request', async t => {
  const f = await fixture(t, { enabled: false });
  Object.assign(f.parent, { fetch: async () => f.parent });
  let answer = '';
  await dispatch(f.client, { isButton: () => true, customId: 'linky:replies:x:20:foo', guildId: GUILD,
    message: f.parent, user: { id: OWNER }, reply: async (value: { content: string }) => { answer = value.content; } });
  assert.match(answer, /unavailable/); assert.equal(f.calls, 0);
});
test('corrupt cleanup journal is quarantined and bot startup continues', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'F2-corrupt-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'reply-cleanup.json'); writeFileSync(file, '{bad json'); const warnings: unknown[] = [];
  const client = createBot({ discordToken: 'unused', settingsPath: join(dir, 'servers.json'), channelIds: [], serverIds: [], rewritePlatforms: ['x'], translateTweets: false },
    { info: () => {}, warn: (...args: unknown[]) => warnings.push(args), error: () => {} } as never);
  await client.destroy();
  assert.equal(existsSync(file), false);
  const quarantined = readdirSync(dir).find(name => name.startsWith('reply-cleanup.json.corrupt-'));
  assert.ok(quarantined); assert.equal(readFileSync(join(dir, quarantined), 'utf8'), '{bad json');
  assert.match(JSON.stringify(warnings), /quarantined/);
});

for (const step of ['rename', 'archive'] as const) test(`unlocked thread ${step} permission denial retires after copied pages are deleted`, async t => {
  const f = await fixture(t, { registered: true });
  if (step === 'rename') f.thread.renameCode = 50013; else f.thread.archiveCode = 50013;
  assert.equal(await f.registry.remove(f.record), true); assert.equal(f.parentExists, false); assert.equal(f.messages.has('page'), false);
  assert.equal(existsSync(f.journalPath), false);
});

for (const path of ['Remove', 'Retry', 'source deletion', 'block fallback'] as const) for (const refusal of ['capacity', 'write'] as const)
test(`full durable journal preserves registry intent: ${path}, ${refusal}`, async t => {
  const f = await fixture(t, { registered: true, cap: refusal === 'capacity' }); f.threadCode = 503;
  if (refusal === 'write') t.mock.method(ReplyCleanupJournal.prototype as unknown as { save(entries: unknown[]): Promise<void> }, 'save', async () => { throw Error('disk full'); });
  if (path === 'Remove') assert.equal(await f.registry.remove(f.record), false);
  else if (path === 'Retry') assert.equal(await f.registry.retry(f.record, async () => assert.fail('must retain pending refresh')), false);
  else if (path === 'source deletion') await f.registry.handleSourceDelete(f.source);
  else assert.equal(await f.registry.queueRemoval(f.record), false);
  assert.equal(f.parentExists, false); assert.equal(f.messages.has('page'), true);
  const saved = JSON.parse(readFileSync(join(f.journalPath, '..', 'reposts.json'), 'utf8'));
  assert.ok(saved.remove.includes(ID)); assert.ok(saved.records.some((record: { replacementId: string }) => record.replacementId === ID));
  if (path === 'Retry') assert.ok(saved.refresh.includes(ID));
  assert.ok(f.registry.findByReplacement(ID), 'failed cleanup must have a durable owner after journal refuses transfer');
  f.threadCode = 0;
  if (path === 'Retry') assert.equal(await f.registry.retry(f.record, async () => undefined), true);
  else await f.registry.sweep();
  assert.equal(f.messages.has('page'), false); assert.equal(f.registry.findByReplacement(ID), undefined);
});

for (const path of ['Remove', 'Retry', 'source deletion', 'block fallback'] as const)
test(`under-capacity failed cleanup transfers from registry: ${path}`, async t => {
  const f = await fixture(t, { registered: true }); f.threadCode = 503;
  if (path === 'Remove') assert.equal(await f.registry.remove(f.record), true);
  else if (path === 'Retry') assert.equal(await f.registry.retry(f.record, async () => undefined), true);
  else if (path === 'source deletion') await f.registry.handleSourceDelete(f.source);
  else assert.equal(await f.registry.queueRemoval(f.record), true);
  assert.equal(f.parentExists, false); assert.equal(f.messages.has('page'), true);
  assert.equal(f.registry.findByReplacement(ID), undefined);
  assert.deepEqual(JSON.parse(readFileSync(f.journalPath, 'utf8')), [{ guildId: GUILD, channelId: CHANNEL, threadId: ID }]);
});
test('refused cleanup transfer uses the existing could-not-remove-yet response', async t => {
  const f = await fixture(t, { registered: true, cap: true }); f.threadCode = 503; const replies: string[] = [];
  assert.equal(await f.registry.handleRemove({ customId: 'linky:remove', guildId: GUILD, channelId: CHANNEL, user: { id: OWNER }, message: f.parent,
    deferred: true, deferReply: async () => {}, reply: async value => { replies.push(String(value.content)); }, editReply: async value => { replies.push(String(value.content)); } }), true);
  assert.deepEqual(replies, ['Could not remove the repost yet. Linky will retry.']);
  assert.equal(f.parentExists, false); assert.ok(f.registry.findByReplacement(ID));
});
