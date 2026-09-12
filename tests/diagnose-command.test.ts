import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplicationIntegrationType, InteractionContextType, MessageFlags, PermissionFlagsBits, PermissionsBitField,
  type ChatInputCommandInteraction } from 'discord.js';
import type { Config } from '../src/config';
import { ServerSettings } from '../src/services/ServerSettings';
import { data, execute } from '../src/commands/diagnose';

const directory = mkdtempSync(join(tmpdir(), 'linky-diagnose-'));
after(() => rmSync(directory, { recursive: true, force: true }));
const SERVER = '111111111111111111', CHANNEL = '222222222222222222';
let nextFile = 0;
const file = () => join(directory, `${nextFile++}.json`);
const config: Config = { discordToken: '', channelIds: [], serverIds: [], rewritePlatforms: ['instagram', 'x', 'youtube'],
  translateTweets: true, settingsPath: '', youtubeApiKey: 'test' };
const plain = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.EmbedLinks | PermissionFlagsBits.SendMessages;

function interaction(link: string | null = null, permissions = plain | PermissionFlagsBits.ManageMessages) {
  const events: { name: string; payload: any }[] = [];
  const input = {
    guildId: SERVER as string | null, channelId: CHANNEL,
    memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
    guild: { members: { me: { id: 'bot' } } },
    channel: { isThread: () => false, parentId: null as string | null, isSendable: () => true,
      permissionsFor: () => new PermissionsBitField(permissions),
      send: async () => assert.fail('Diagnostics must not send a channel message') },
    options: { getString: () => link },
    reply: async (payload: unknown) => { events.push({ name: 'reply', payload }); },
    deferReply: async (payload: unknown) => { events.push({ name: 'defer', payload }); },
    editReply: async (payload: unknown) => { events.push({ name: 'edit', payload }); },
  };
  return { input, events, command: input as unknown as ChatInputCommandInteraction };
}

test('diagnose is an optional-link guild command limited to Manage Server', () => {
  const command = data.toJSON();
  assert.deepEqual(command.contexts, [InteractionContextType.Guild]);
  assert.deepEqual(command.integration_types, [ApplicationIntegrationType.GuildInstall]);
  assert.equal(command.default_member_permissions, PermissionFlagsBits.ManageGuild.toString());
  assert.equal(command.options?.[0].name, 'link');
  assert.equal(command.options?.[0].required ?? false, false);
});

test('diagnose rejects DMs and non-admins privately before reading options or provider status', async () => {
  for (const dm of [true, false]) {
    const servers = new ServerSettings(file(), async () => assert.fail('Read-only command wrote'));
    const f = interaction();
    if (dm) f.input.guildId = null;
    else f.input.memberPermissions = new PermissionsBitField(0n);
    f.input.options.getString = () => assert.fail('Unauthorized option read');
    await execute(f.command, config, servers, async () => assert.fail('Unauthorized diagnostic'));
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0].payload.flags, MessageFlags.Ephemeral);
  }
});

test('diagnose reports disabled scope and exact missing permissions without mutating settings', async () => {
  const servers = new ServerSettings(file(), async () => assert.fail('Read-only command wrote'));
  const f = interaction(null, PermissionFlagsBits.ViewChannel);
  await execute(f.command, config, servers);
  assert.equal(f.events[0].payload.flags, MessageFlags.Ephemeral);
  const content = f.events[1].payload.content;
  assert.match(content, /Disabled in this channel/);
  assert.match(content, /Missing channel permissions: Read Message History, Embed Links, Send Messages, Manage Messages/);
  assert.match(content, /Attach Files is also needed when copying attachments/);
  assert.equal(servers.get(SERVER), undefined);
  assert.deepEqual(servers.getPreferences(SERVER), {});
});

test('reply diagnostics do not require Manage Messages or source attachment copying', async () => {
  const servers = new ServerSettings(file());
  await servers.update(SERVER, { mode: 'reply' });
  await servers.set(SERVER, true);
  const f = interaction(null, plain);
  await execute(f.command, config, servers);
  const content = f.events[1].payload.content;
  assert.match(content, /Required permissions for a plain link are present/);
  assert.doesNotMatch(content, /Manage Messages/);
  assert.match(content, /Original attachments stay on the source/);
});

test('thread diagnostics match selected parent scope and require thread sending', async () => {
  const servers = new ServerSettings(file());
  await servers.set(SERVER, true);
  await servers.update(SERVER, { channelIds: [CHANNEL] });
  const f = interaction();
  f.input.channelId = '333333333333333333';
  f.input.channel.isThread = () => true;
  f.input.channel.parentId = CHANNEL;
  await execute(f.command, config, servers);
  assert.match(f.events[1].payload.content, /Enabled in this channel/);
  assert.match(f.events[1].payload.content, /Missing channel permissions: Send Messages in Threads/);
});

test('unsupported and disabled links do not call the provider observation hook', async () => {
  const servers = new ServerSettings(file());
  for (const link of ['https://example.test/post', 'https://x.com.evil/status/123', 'hello https://x.com/u/status/123']) {
    const f = interaction(link);
    await execute(f.command, config, servers, async () => assert.fail('Unsupported lookup'));
    assert.match(f.events[1].payload.content, /Link format: unsupported/);
  }
  await servers.update(SERVER, { platforms: { x: false } });
  const f = interaction('https://x.com/u/status/123');
  await execute(f.command, config, servers, async () => assert.fail('Disabled lookup'));
  assert.match(f.events[1].payload.content, /disabled in this server/);
});

test('provider observations are bounded, escaped and explicitly do not guarantee previews', async () => {
  const servers = new ServerSettings(file(), async () => assert.fail('Read-only command wrote'));
  const f = interaction('https://x.com/u/status/123');
  await execute(f.command, config, servers, async link => {
    assert.equal(link, 'https://x.com/u/status/123');
    return '@everyone **timeout**\n' + 'x'.repeat(3000);
  });
  const content = f.events[1].payload.content;
  assert.match(content, /Provider observation:/);
  assert.doesNotMatch(content, /@everyone/);
  assert.ok(content.length < 2000);
  assert.match(content, /No message was posted or removed/);
  assert.deepEqual(f.events[1].payload.allowedMentions, { parse: [] });
});

test('preview-only YouTube and provider failures remain private read-only diagnostics', async () => {
  const servers = new ServerSettings(file());
  await servers.update(SERVER, { youtubeDisplay: 'preview' });
  const youtube = interaction('https://youtu.be/dQw4w9WgXcQ');
  await execute(youtube.command, config, servers, async () => assert.fail('Preview-only lookup'));
  assert.match(youtube.events[1].payload.content, /without fetching counts or comments/);
  const failed = interaction('https://x.com/u/status/123');
  await execute(failed.command, config, servers, async () => { throw new Error('unavailable'); });
  assert.match(failed.events[1].payload.content, /Provider status is unavailable/);
  assert.equal(servers.get(SERVER), undefined);
});
