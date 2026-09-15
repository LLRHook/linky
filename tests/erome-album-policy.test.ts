import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageFlags, PermissionFlagsBits as P, PermissionsBitField, type ButtonInteraction } from 'discord.js';
import type { AlbumOwner } from '../src/services/EromeAlbumSessions';
import { createEromeAlbumPolicy, type EromeAlbumPolicyOptions } from '../src/services/EromeAlbumPolicy';
import type { ServerPreferences } from '../src/services/ServerSettings';

const owner: AlbumOwner = { requesterId: '100000000000000001', channelId: '100000000000000002',
  guildId: '100000000000000003', messageId: '100000000000000004', sourceMessageId: '100000000000000005',
  source: 'https://www.erome.com/a/SyntheticAlbum', mode: 'automatic' };
const botId = '100000000000000006', parentId = '100000000000000007';
function fixture() {
  let preferences: ServerPreferences = { eromeChannels: 'all' };
  let enabled: boolean | undefined = true;
  let requesterPermissions = new PermissionsBitField([P.ViewChannel, P.SendMessages]);
  let botPermissions = new PermissionsBitField([P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles]);
  let thread = false, sourceDeleted = false, suppressed = false;
  let afterChannel: (() => Promise<void>) | undefined;
  let afterMember: (() => Promise<void>) | undefined;
  let afterSource: (() => Promise<void>) | undefined;
  const reads: string[] = [];
  const requester = { id: owner.requesterId, communicationDisabledUntilTimestamp: null as number | null };
  const source = { id: owner.sourceMessageId!, channelId: owner.channelId, content: owner.source,
    author: { id: owner.requesterId, bot: false }, webhookId: null as string | null,
    flags: { has: (flag: unknown) => flag === MessageFlags.SuppressEmbeds && suppressed } };
  const channel = { id: owner.channelId, guildId: owner.guildId, nsfw: false, parentId, parent: { nsfw: false },
    isThread: () => thread,
    permissionsFor: (member: { id: string }) => member.id === botId ? botPermissions : requesterPermissions };
  const guild = { id: owner.guildId, channels: { fetch: async () => { reads.push('channel'); await afterChannel?.(); return channel; } },
    members: { me: { id: botId }, fetch: async () => { reads.push('member'); await afterMember?.(); return requester; } } };
  const interaction = { user: { id: owner.requesterId }, guild, guildId: owner.guildId, channelId: owner.channelId } as unknown as ButtonInteraction;
  const controller = new AbortController();
  const options: EromeAlbumPolicyOptions = { settings: { rewritePlatforms: ['erome'], channelIds: [], serverIds: [] },
    servers: { get: () => enabled, getPreferences: () => preferences }, signal: controller.signal,
    fetchMessage: async () => { reads.push('source'); await afterSource?.(); return sourceDeleted ? null : source as never; } };
  const allowed = createEromeAlbumPolicy(options);
  return { allowed, options, interaction, requester, source, channel, controller, reads,
    setPreferences: (value: ServerPreferences) => { preferences = value; },
    setEnabled: (value: boolean | undefined) => { enabled = value; },
    setRequester: (...flags: bigint[]) => { requesterPermissions = new PermissionsBitField(flags); },
    setBot: (...flags: bigint[]) => { botPermissions = new PermissionsBitField(flags); },
    setThread: () => { thread = true; }, deleteSource: () => { sourceDeleted = true; }, suppress: () => { suppressed = true; },
    afterChannel: (hook: typeof afterChannel) => { afterChannel = hook; },
    afterMember: (hook: typeof afterMember) => { afterMember = hook; },
    afterSource: (hook: typeof afterSource) => { afterSource = hook; } };
}

test('album policy requires exact interaction identity and current requester and bot permissions', async () => {
  const f = fixture();
  assert.equal(await f.allowed(owner, f.interaction), true);
  for (const changes of [{ guildId: null }, { channelId: 'wrong' }, { user: { id: 'wrong' } }, { guild: null }]) {
    assert.equal(await f.allowed(owner, { ...f.interaction, ...changes } as ButtonInteraction), false);
  }
  f.setRequester(P.ViewChannel);
  assert.equal(await f.allowed(owner, f.interaction), false);
  f.setRequester(P.SendMessages);
  assert.equal(await f.allowed(owner, f.interaction), false);
  f.setRequester(P.ViewChannel, P.SendMessages);
  f.setBot(P.ViewChannel, P.SendMessages, P.EmbedLinks);
  assert.equal(await f.allowed(owner, f.interaction), false);
});

test('threads require SendMessagesInThreads and inherit their parent channel scope and age policy', async () => {
  const f = fixture();
  f.setThread();
  f.setPreferences({ channelIds: [parentId], eromeChannels: 'age-restricted' });
  f.channel.parent.nsfw = true;
  assert.equal(await f.allowed(owner, f.interaction), false, 'SendMessages is not a thread send permission');
  f.setRequester(P.ViewChannel, P.SendMessagesInThreads);
  f.setBot(P.ViewChannel, P.SendMessagesInThreads, P.EmbedLinks, P.AttachFiles);
  assert.equal(await f.allowed(owner, f.interaction), true);
  f.channel.parent.nsfw = false;
  assert.equal(await f.allowed(owner, f.interaction), false);
});

test('a Discord timeout blocks public album append even when role Send permission remains set', async () => {
  const f = fixture();
  f.requester.communicationDisabledUntilTimestamp = Date.now() + 60_000;
  assert.equal(await f.allowed(owner, f.interaction), false);
  f.requester.communicationDisabledUntilTimestamp = Date.now() - 1;
  assert.equal(await f.allowed(owner, f.interaction), true);
  f.afterSource(async () => { f.requester.communicationDisabledUntilTimestamp = Date.now() + 60_000; });
  assert.equal(await f.allowed(owner, f.interaction), false);
});

test('manual album pages preserve explicit-fix semantics while operator and channel policy still apply', async () => {
  const f = fixture();
  f.setEnabled(false);
  f.setPreferences({ eromeChannels: 'all', platforms: { erome: false }, channelIds: [] });
  f.source.author.bot = true; f.source.webhookId = botId; f.suppress(); f.source.content = `${owner.source} !nolinky`;
  assert.equal(await f.allowed(owner, f.interaction), false);
  assert.equal(await f.allowed({ ...owner, mode: 'manual' }, f.interaction), true);
  f.options.settings.rewritePlatforms = [];
  assert.equal(await f.allowed({ ...owner, mode: 'manual' }, f.interaction), false);
  f.options.settings.rewritePlatforms = ['erome'];
  f.setPreferences({ eromeChannels: 'age-restricted' });
  assert.equal(await f.allowed({ ...owner, mode: 'manual' }, f.interaction), false);
});

test('automatic pages require current scope and respect source edits, deletion, suppression and bypass', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => f.setEnabled(false),
    (f: ReturnType<typeof fixture>) => f.setPreferences({ eromeChannels: 'all', channelIds: [] }),
    (f: ReturnType<typeof fixture>) => f.setPreferences({ eromeChannels: 'all', platforms: { erome: false } }),
    (f: ReturnType<typeof fixture>) => { f.source.content = 'The link was removed'; },
    (f: ReturnType<typeof fixture>) => f.deleteSource(),
    (f: ReturnType<typeof fixture>) => f.suppress(),
    (f: ReturnType<typeof fixture>) => { f.source.content += ' !nolinky'; },
    (f: ReturnType<typeof fixture>) => { f.source.author.bot = true; },
    (f: ReturnType<typeof fixture>) => { f.source.author.id = botId; },
  ]) {
    const f = fixture(); change(f);
    assert.equal(await f.allowed(owner, f.interaction), false);
  }
});

test('manual slash sessions need no original-message fetch but context actions keep tracking their source', async () => {
  const f = fixture();
  f.deleteSource();
  assert.equal(await f.allowed({ ...owner, mode: 'manual' }, f.interaction), false);
  f.reads.length = 0;
  assert.equal(await f.allowed({ ...owner, sourceMessageId: undefined, mode: 'manual' }, f.interaction), true);
  assert.deepEqual(f.reads, ['channel', 'member']);
});

test('cancellation and policy or requester revocation during awaited reads cannot return an old permission decision', async () => {
  for (const point of ['afterChannel', 'afterMember', 'afterSource'] as const) {
    for (const change of [
      (f: ReturnType<typeof fixture>) => f.controller.abort(),
      (f: ReturnType<typeof fixture>) => f.setEnabled(false),
      (f: ReturnType<typeof fixture>) => f.setRequester(P.ViewChannel),
      (f: ReturnType<typeof fixture>) => f.setPreferences({ eromeChannels: 'age-restricted' }),
    ]) {
      const f = fixture();
      f[point](async () => { await Promise.resolve(); change(f); });
      assert.equal(await f.allowed(owner, f.interaction), false, point);
    }
  }
});

test('Discord lookup failures and mismatched fetched message identities fail closed', async () => {
  for (const point of ['afterChannel', 'afterMember', 'afterSource'] as const) {
    const f = fixture();
    f[point](async () => { throw Error('Discord unavailable'); });
    assert.equal(await f.allowed(owner, f.interaction), false);
  }
  for (const property of ['id', 'channelId'] as const) {
    const f = fixture(); f.source[property] = 'wrong';
    assert.equal(await f.allowed(owner, f.interaction), false);
  }
});
