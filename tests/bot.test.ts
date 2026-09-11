import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Collection, Events, GatewayIntentBits, MessageFlags, PermissionFlagsBits, PermissionsBitField, Routes, type Interaction, type Guild, type Message, type InteractionReplyOptions } from 'discord.js';
import { createBot } from '../src/bot';
import type { Config } from '../src/config';
import { data } from '../src/commands/help';
import { data as setupData } from '../src/commands/setup';
import { registerCommands } from '../src/commands/register';
import { ServerSettings } from '../src/services/ServerSettings';

const directory = mkdtempSync(join(tmpdir(), 'linky-bot-tests-'));
after(() => rmSync(directory, { recursive: true, force: true }));

const settings: Config = {
  discordToken: 'unused', channelIds: ['configured-channel'], serverIds: [],
  rewritePlatforms: ['x', 'instagram', 'tiktok'], translateTweets: true,
  settingsPath: join(directory, 'unused.json'),
};
const clients: Client[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.destroy())); });

function fixture(overrides: Partial<Config> = {}, servers = new ServerSettings(settings.settingsPath)) {
  const logs: unknown[] = [];
  const errors: unknown[] = [];
  const client = createBot({ ...settings, ...overrides }, {
    info: (...args: unknown[]) => logs.push(args), warn() {}, error: (...args: unknown[]) => errors.push(args),
  } as Parameters<typeof createBot>[1], servers);
  clients.push(client);
  return { client, logs, errors };
}

async function command(client: Client, name: string, channelId = 'configured-channel', guildId: string | null = 'configured-server') {
  const replies: InteractionReplyOptions[] = [];
  client.emit(Events.InteractionCreate, {
    isChatInputCommand: () => true, commandName: name, channelId, guildId,
    reply: async (payload: InteractionReplyOptions) => { replies.push(payload); },
  } as unknown as Interaction);
  await new Promise<void>(resolve => setImmediate(resolve));
  return replies;
}

test('link bot requests message access without privileged member access', () => {
  const { client } = fixture();
  assert.deepEqual(client.options.intents.toArray().sort(), ['Guilds', 'GuildMessages', 'MessageContent'].sort());
  assert.equal(client.options.intents.has(GatewayIntentBits.GuildMembers), false);
  assert.equal(client.listenerCount(Events.MessageCreate), 1);
});

test('an unconfigured bot listens for messages so setup can activate it without restarting', () => {
  const { client } = fixture({ channelIds: [] });
  assert.deepEqual(client.options.intents.toArray().sort(), ['Guilds', 'GuildMessages', 'MessageContent'].sort());
  assert.equal(client.listenerCount(Events.MessageCreate), 1);
});

for (const hasSystemChannel of [true, false]) {
  test(`joining a server sends nothing (${hasSystemChannel ? 'with' : 'without'} a system channel)`, async () => {
    const { client, logs } = fixture();
    let sends = 0;
    const channel = { send: async () => { sends++; } };
    const guild = { id: 'new-guild', systemChannel: hasSystemChannel ? channel : null, channels: { cache: new Map([['general', channel]]) } };
    client.emit(Events.GuildCreate, guild as unknown as Guild);
    client.emit(Events.ClientReady, { user: { tag: 'Linky#0805' }, guilds: { cache: new Map([['new-guild', guild]]) },
      application: { commands: { set: async () => [] } },
    } as unknown as Client<true>);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(sends, 0);
    assert.ok(logs.some(entry => JSON.stringify(entry).includes('Logged in as Linky#0805')));
    assert.ok(logs.some(entry => JSON.stringify(entry).includes('Serving 1 guild(s).')));
  });
}

test('/help describes the active link features privately and without mentions', async () => {
  const { client } = fixture();
  const replies = await command(client, 'help');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].flags, MessageFlags.Ephemeral);
  assert.deepEqual(replies[0].allowedMentions, { parse: [] });
  assert.match(replies[0].content!, /enabled in this channel/);
  assert.match(replies[0].content!, /X, Instagram, TikTok/);
  assert.match(replies[0].content!, /English with a small source-language label/);
});

test('/help accurately shows channel scope, disabled platforms and translation settings', async () => {
  const { client } = fixture({ rewritePlatforms: ['instagram'], translateTweets: false });
  const replies = await command(client, 'help', 'unconfigured-channel');
  assert.match(replies[0].content!, /disabled in this channel/);
  assert.match(replies[0].content!, /Supported platforms: Instagram\./);
  assert.match(replies[0].content!, /English translation is currently disabled/);
});

test('/help reports when all platforms are disabled', async () => {
  const { client } = fixture({ rewritePlatforms: [] });
  assert.match((await command(client, 'help'))[0].content!, /All platforms are currently disabled/);
});

test('unknown commands do not trigger replies', async () => {
  const { client } = fixture();
  assert.deepEqual(await command(client, 'unknown'), []);
});

test('non-command interactions do not trigger replies', () => {
  const { client } = fixture();
  client.emit(Events.InteractionCreate, {
    isChatInputCommand: () => false,
    reply: () => { assert.fail('Unexpected interaction reply'); },
  } as unknown as Interaction);
});

test('expired command replies are logged without sending another reply', async () => {
  const { client, errors } = fixture();
  let attempts = 0;
  client.emit(Events.InteractionCreate, {
    isChatInputCommand: () => true, commandName: 'help', channelId: 'configured-channel',
    reply: async () => { attempts++; throw new Error('Unknown interaction'); },
  } as unknown as Interaction);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(attempts, 1);
  assert.equal(errors.length, 1);
});

test('registration replaces the entire global command list with /help and /setup', async () => {
  const calls: unknown[] = [];
  await registerCommands({
    get: async route => { calls.push(route); return { id: 'application-id' }; },
    put: async (route, options) => { calls.push([route, options]); return []; },
  });
  assert.deepEqual(calls, [Routes.oauth2CurrentApplication(), [Routes.applicationCommands('application-id'), { body: [data.toJSON(), setupData.toJSON()] }]]);
  assert.equal(data.toJSON().name, 'help');
});

test('failed application authentication leaves registered commands untouched', async () => {
  await assert.rejects(registerCommands({
    get: async () => { throw new Error('Unauthorized'); },
    put: async () => { assert.fail('Cannot replace commands without an authenticated application'); },
  }), /Unauthorized/);
});

test('startup installs both commands before reporting readiness', async () => {
  const { client, logs } = fixture();
  const calls: unknown[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const application = { commands: { set: async (definitions: unknown) => { calls.push(definitions); await gate; } } };
  assert.deepEqual(calls, []);
  client.emit(Events.ClientReady, { application, user: { tag: 'Linky' }, guilds: { cache: new Map() } } as unknown as Client<true>);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [[data.toJSON(), setupData.toJSON()]]);
  assert.equal(logs.some(entry => JSON.stringify(entry).includes('Logged in as')), false);
  release();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(logs.some(entry => JSON.stringify(entry).includes('Logged in as Linky')));
});

test('failed startup registration disconnects without reporting readiness', async () => {
  const { client, logs, errors } = fixture();
  let destroyed = false;
  const destroy = client.destroy.bind(client);
  client.destroy = async () => { destroyed = true; await destroy(); };
  client.emit(Events.ClientReady, {
    application: { commands: { set: async () => { throw new Error('Registration unavailable'); } } },
  } as unknown as Client<true>);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(destroyed, true);
  assert.equal(errors.length, 1);
  assert.equal(logs.some(entry => /Logged in as|Serving /.test(JSON.stringify(entry))), false);
});

test('/help reflects persisted choices before and after restarting', async () => {
  const path = join(directory, 'help.json');
  const guildId = '111111111111111111';
  const servers = new ServerSettings(path);
  const { client } = fixture({ serverIds: [guildId] }, servers);
  await servers.set(guildId, false);
  assert.match((await command(client, 'help', 'configured-channel', guildId))[0].content!, /disabled in this channel/);
  await servers.set(guildId, true);
  const restarted = fixture({ channelIds: [] }, new ServerSettings(path));
  const reply = (await command(restarted.client, 'help', 'new-channel', guildId))[0];
  assert.match(reply.content!, /enabled throughout this server/);
  assert.match(reply.content!, /\/setup enabled:true/);
});

test('the running bot routes setup to persistence and immediately updates help', { timeout: 3000 }, async () => {
  const path = join(directory, 'setup.json');
  const guildId = '222222222222222222';
  const servers = new ServerSettings(path);
  const { client } = fixture({ channelIds: [], serverIds: [] }, servers);
  assert.match((await command(client, 'help', 'new-channel', guildId))[0].content!, /disabled in this channel/);
  await new Promise<void>((resolve) => {
    client.emit(Events.InteractionCreate, {
      isChatInputCommand: () => true, commandName: 'setup', guildId,
      memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
      options: { getBoolean: () => true },
      deferReply: async () => {},
      editReply: async () => { resolve(); },
    } as unknown as Interaction);
  });
  assert.equal(new ServerSettings(path).get(guildId), true);
  assert.match((await command(client, 'help', 'new-channel', guildId))[0].content!, /enabled throughout this server/);
});


test('server-only configuration registers message handling and preserves permission checks', async () => {
  const { client } = fixture({ channelIds: [], serverIds: ['whole-server'] });
  assert.equal(client.listenerCount(Events.MessageCreate), 1);
  assert.deepEqual(client.options.intents.toArray().sort(), ['Guilds', 'GuildMessages', 'MessageContent'].sort());
  let checked = 0;
  client.emit(Events.MessageCreate, {
    id: 'new-message', channelId: 'new-channel', guildId: 'whole-server', content: 'https://x.com/user/status/1',
    author: { bot: false }, inGuild: () => true, type: 0,
    stickers: new Collection(), components: [], messageSnapshots: new Collection(), attachments: new Collection(),
    flags: { has: () => false }, guild: { members: { me: {} } }, deletable: true,
    channel: { isSendable: () => true, isThread: () => false, permissionsFor: () => {
      checked++; return { has: () => false };
    }, send: () => assert.fail('Missing permissions must preserve the original') },
  } as unknown as Message<true>);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(checked, 1);
});

test('/help distinguishes whole-server scope from unconfigured servers and DMs', async () => {
  const { client } = fixture({ channelIds: [], serverIds: ['whole-server'] });
  const active = (await command(client, 'help', 'new-channel', 'whole-server'))[0];
  assert.match(active.content!, /enabled throughout this server/);
  assert.equal(active.flags, MessageFlags.Ephemeral);
  for (const guildId of ['other-server', null]) {
    assert.match((await command(client, 'help', 'new-channel', guildId))[0].content!, /disabled in this channel/);
  }
});
