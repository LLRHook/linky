import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Collection, MessageFlagsBitField, MessageType, PermissionsBitField,
  type Attachment, type Message, type MessageCreateOptions, type MessageEditOptions } from 'discord.js';
import { RepostRegistry, type RepostMessage, type RepostRecord } from '../src/services/RepostRegistry';
import { createLinkRepostHandler } from '../src/services/SocialLinkService';
import { inspectPreviews } from '../src/services/PreviewRecovery';

const NOW = Date.UTC(2026, 8, 12);
const id = (offset: number) => String(BigInt(NOW + offset - 1_420_070_400_000) << 22n);
const GUILD = id(-10_000), CHANNEL = id(-9_000), AUTHOR = id(-8_000), BOT = id(-7_000), SOURCE = id(-6_000);
const LINK = 'https://x.com/jack/status/20';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'linky-sync-'));
  const path = join(directory, 'reposts.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const messages = new Map<string, Message>(), deleted: string[] = [];
  let content = `Initial ${LINK}`, editedTimestamp: number | null = null, nextId = 200;
  const hooks = { preview: async () => {}, remembered: async () => {} };
  const channel = {
    id: CHANNEL, isThread: () => false, isSendable: () => true,
    permissionsFor: () => new PermissionsBitField(PermissionsBitField.All),
    send: async (options: MessageCreateOptions) => {
      const message = { id: id(nextId++), channelId: CHANNEL, guildId: GUILD,
        author: { id: BOT, bot: true }, content: options.content ?? '',
        attachments: new Collection<string, Attachment>(), embeds: [],
        delete: async () => { deleted.push(message.id); messages.delete(message.id); },
        edit: async (edit: MessageEditOptions) => { if (typeof edit.content === 'string') message.content = edit.content; return message; },
      } as unknown as Message;
      messages.set(message.id, message); return message;
    },
  };
  const source = () => ({ id: SOURCE, channelId: CHANNEL, guildId: GUILD, content, editedTimestamp,
    author: { id: AUTHOR, bot: false }, guild: { members: { me: { id: BOT } } }, channel,
    partial: false, webhookId: null, type: MessageType.Default, poll: null, pinned: false, hasThread: false,
    stickers: new Collection(), components: [], messageSnapshots: new Collection(),
    attachments: new Collection<string, Attachment>(), flags: new MessageFlagsBitField(), reference: null,
    deletable: true, inGuild: () => true, delete: async () => { assert.fail('Reply refresh must keep its source'); },
    fetch: async () => source(),
  } as unknown as Message);
  let registry: RepostRegistry;
  const handler = createLinkRepostHandler([CHANNEL], { info() {}, warn() {}, error() {} }, undefined, {
    platforms: ['x'], serverPreferences: () => ({ mode: 'reply' }),
    verifyPreview: async (_message, expected) => {
      await hooks.preview();
      return inspectPreviews(expected.map(item => ({ url: item.url, title: 'Jack', description: 'Public post' })), expected);
    },
    rememberRepost: async record => { const saved = await registry.remember(record); await hooks.remembered(); return saved; },
  });
  const regenerate = (message: RepostMessage) => handler(message as Message, { refresh: true, forceReply: true });
  const options = { path, botUserId: BOT, now: () => NOW,
    fetchMessage: async (_channelId: string, messageId: string): Promise<RepostMessage | null> =>
      messageId === SOURCE ? source() : messages.get(messageId) ?? null,
    canManageMessages: async () => false, regenerate };
  registry = new RepostRegistry(options);
  const old = await channel.send({ content: `Old output ${LINK}` });
  const record: RepostRecord = { guildId: GUILD, channelId: CHANNEL, authorId: AUTHOR,
    sourceId: SOURCE, replacementId: old.id, mode: 'reply' };
  await registry.remember(record);
  return { hooks, messages, deleted, record, source, regenerate, get registry() { return registry; },
    edit: (text: string, timestamp: number) => { content = `${text} ${LINK}`; editedTimestamp = timestamp; return source(); },
    restart: () => { registry = new RepostRegistry(options); return registry; },
    saved: async () => JSON.parse(await readFile(path, 'utf8')) as { records: RepostRecord[]; refresh: string[]; remove: string[] },
  };
}

for (const phase of ['preview', 'remembered'] as const) test(`a second edit during ${phase} leaves exactly one current reply`, async t => {
  const f = await fixture(t), before = f.source();
  const first = f.edit('First edit', NOW + 1_000);
  let queued: Promise<void> | undefined;
  f.hooks[phase] = async () => {
    f.hooks[phase] = async () => {};
    const latest = f.edit('Latest edit', NOW + 2_000);
    queued = f.registry.handleSourceUpdate(first, latest, f.regenerate);
  };
  await f.registry.handleSourceUpdate(before, first, f.regenerate);
  await queued;
  const current = f.registry.findBySource(SOURCE);
  assert(current, 'latest edit must retain registered output');
  assert.equal(f.messages.size, 1);
  assert.match(f.messages.get(current.replacementId)!.content, /Latest edit/);
  assert.doesNotMatch(f.messages.get(current.replacementId)!.content, /First edit/);
  assert.deepEqual((await f.saved()).refresh, []);
  assert.deepEqual((await f.saved()).remove, []);
});

for (const phase of ['preview', 'remembered'] as const) test(`cancellation during ${phase} survives restart without a second gateway event`, async t => {
  const f = await fixture(t), before = f.source();
  const first = f.edit('First edit', NOW + 1_000);
  f.hooks[phase] = async () => { f.hooks[phase] = async () => {}; f.edit('Latest edit', NOW + 2_000); };
  await f.registry.handleSourceUpdate(before, first, f.regenerate);
  assert.equal((await f.saved()).refresh.length, 1, 'cancellation must leave a durable refresh');
  await f.restart().sweep();
  const current = f.registry.findBySource(SOURCE);
  assert(current);
  assert.equal(f.messages.size, 1);
  assert.match(f.messages.get(current.replacementId)!.content, /Latest edit/);
  assert.deepEqual((await f.saved()).refresh, []);
});

test('an intentionally bypassed edit removes the old reply and completes its refresh', async t => {
  const f = await fixture(t), before = f.source();
  await f.registry.handleSourceUpdate(before, f.edit('!nolinky Latest edit', NOW + 1_000), f.regenerate);
  assert.equal(f.messages.size, 0);
  assert.deepEqual(await f.saved(), { records: [], remove: [], refresh: [] });
});
