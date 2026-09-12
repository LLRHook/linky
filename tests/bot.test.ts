import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Collection, Events, GatewayIntentBits, MessageFlags, Partials, PermissionFlagsBits, PermissionsBitField, Routes, type ClientEvents, type Interaction, type Guild, type Message, type InteractionReplyOptions } from 'discord.js';
import { createBot } from '../src/bot';
import type { Config } from '../src/config';
import { data } from '../src/commands/help';
import { commandDefinitions, registerCommands } from '../src/commands/register';
import { ServerSettings, type ServerPreferences } from '../src/services/ServerSettings';

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

const predicates = {
  isChatInputCommand: () => false, isMessageContextMenuCommand: () => false,
  isButton: () => false, isStringSelectMenu: () => false, isChannelSelectMenu: () => false,
};

async function dispatch(client: Client, input: Record<string, unknown>): Promise<void> {
  for (const listener of client.listeners(Events.InteractionCreate)) {
    await listener({ ...predicates, ...input } as unknown as Interaction);
  }
}

async function command(client: Client, name: string, channelId = 'configured-channel', guildId: string | null = 'configured-server') {
  const replies: InteractionReplyOptions[] = [];
  await dispatch(client, {
    isChatInputCommand: () => true, commandName: name, channelId, guildId,
    reply: async (payload: InteractionReplyOptions) => { replies.push(payload); },
  });
  return replies;
}

test('link bot requests message access without privileged member access', () => {
  const { client } = fixture();
  assert.deepEqual(client.options.intents.toArray().sort(), ['Guilds', 'GuildMessages', 'MessageContent'].sort());
  assert.equal(client.options.intents.has(GatewayIntentBits.GuildMembers), false);
  assert.equal(client.options.intents.has(GatewayIntentBits.DirectMessages), false);
  assert.deepEqual(client.options.partials, [Partials.Message]);
  assert.equal(client.listenerCount(Events.MessageCreate), 1);
  for (const event of [Events.MessageUpdate, Events.MessageDelete, Events.MessageBulkDelete]) {
    assert.equal(client.listenerCount(event), 1);
  }
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
    client.emit(Events.ClientReady, { user: { id: '1491240385031311470', tag: 'Linky#0805' }, guilds: { cache: new Map([['new-guild', guild]]) },
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

test('non-command interactions do not trigger replies or dispatch errors', async () => {
  const { client, errors } = fixture();
  await dispatch(client, {
    reply: () => { assert.fail('Unexpected interaction reply'); },
  });
  assert.deepEqual(errors, []);
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

test('registration installs the public slash commands and message context action', async () => {
  const calls: unknown[] = [];
  await registerCommands({
    get: async route => { calls.push(route); return { id: 'application-id' }; },
    put: async (route, options) => { calls.push([route, options]); return []; },
  });
  assert.deepEqual(calls, [Routes.oauth2CurrentApplication(), [Routes.applicationCommands('application-id'), { body: commandDefinitions }]]);
  assert.deepEqual(commandDefinitions.map(command => command.name), ['help', 'setup', 'settings', 'diagnose', 'fix', 'Fix with Linky']);
  assert.equal(data.toJSON().name, 'help');
});

test('failed application authentication leaves registered commands untouched', async () => {
  await assert.rejects(registerCommands({
    get: async () => { throw new Error('Unauthorized'); },
    put: async () => { assert.fail('Cannot replace commands without an authenticated application'); },
  }), /Unauthorized/);
});

test('startup installs all commands before reporting readiness', async () => {
  const { client, logs } = fixture();
  const calls: unknown[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const application = { commands: { set: async (definitions: unknown) => { calls.push(definitions); await gate; } } };
  assert.deepEqual(calls, []);
  client.emit(Events.ClientReady, { application, user: { id: '1491240385031311470', tag: 'Linky' }, guilds: { cache: new Map() } } as unknown as Client<true>);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [commandDefinitions]);
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
  assert.match(reply.content!, /open \/setup for channels, mode and platforms/);
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

test('/help respects selected channel restrictions instead of reporting an excluded channel active', async () => {
  const path = join(directory, 'help-channel-scope.json');
  const guildId = '333333333333333333';
  const servers = new ServerSettings(path);
  await servers.set(guildId, true);
  await servers.update(guildId, { channelIds: [] });
  const { client, errors } = fixture({}, servers);
  const reply = (await command(client, 'help', 'unselected-channel', guildId))[0];
  assert.match(reply.content!, /disabled in this channel/i);
  assert.doesNotMatch(reply.content!, /enabled throughout this server/i);
  assert.deepEqual(errors, []);
});

test('explicit slash and context-menu fixes dispatch without changing automatic server enablement', async () => {
  const servers = new ServerSettings(join(directory, 'manual-dispatch.json'), async () => assert.fail('Manual fixing must not write server settings'));
  const { client, errors } = fixture({}, servers);
  for (const contextMenu of [false, true]) {
    const events: any[] = [];
    const response = {
      content: '',
      embeds: [{ toJSON: () => ({ url: 'https://fixupx.com/jack/status/20', title: 'Jack', description: 'The requested post.' }) }],
      fetch: async () => response,
    };
    await dispatch(client, {
      isChatInputCommand: () => !contextMenu, isMessageContextMenuCommand: () => contextMenu,
      commandName: contextMenu ? 'Fix with Linky' : 'fix', inGuild: () => true,
      guildId: '444444444444444444', channelId: 'channel',
      memberPermissions: new PermissionsBitField(PermissionFlagsBits.SendMessages),
      channel: { isThread: () => false },
      options: { getString: () => 'https://twitter.com/jack/status/20' },
      targetMessage: { content: 'https://twitter.com/jack/status/20', delete: () => assert.fail('Context action must not delete source'),
        edit: () => assert.fail('Context action must not edit source') },
      deferReply: async (payload: unknown) => { events.push(['defer', payload]); },
      editReply: async (payload: any) => { events.push(['edit', payload]); response.content = payload.content; return response; },
    });
    assert.equal(events.length, 2);
    assert.equal(events[1][1].content, 'https://fixupx.com/jack/status/20');
    assert.equal(response.content, events[1][1].content);
    assert.equal(servers.get('444444444444444444'), undefined);
    assert.deepEqual(errors, [], 'default manual preview verification must complete without a caught dispatch error');
  }
  assert.deepEqual(errors, []);
});

test('setup component and diagnose dispatch retain private admin checks', async () => {
  const servers = new ServerSettings(join(directory, 'private-dispatch.json'), async () => assert.fail('Unauthorized write'));
  const { client, errors } = fixture({}, servers);
  for (const button of [true, false]) {
    const replies: InteractionReplyOptions[] = [];
    await dispatch(client, {
      isChatInputCommand: () => !button, isButton: () => button,
      commandName: 'diagnose', customId: 'linky:setup:enable',
      guildId: '555555555555555555', channelId: 'channel', memberPermissions: new PermissionsBitField(0n),
      reply: async (payload: InteractionReplyOptions) => { replies.push(payload); },
    });
    assert.equal(replies.length, 1);
    assert.equal(replies[0].flags, MessageFlags.Ephemeral);
    assert.match(replies[0].content!, /Manage Server/);
  }
  assert.deepEqual(errors, []);
});

test('manual Remove button dispatch validates ownership and does not fall through to other handlers', async () => {
  const { client, errors } = fixture();
  const events: string[] = [];
  const botId = '1491240385031311470', ownerId = '666666666666666666';
  await dispatch(client, {
    isButton: () => true, customId: 'linky:remove-manual', inGuild: () => false,
    client: { user: { id: botId } }, applicationId: botId, user: { id: ownerId },
    memberPermissions: new PermissionsBitField(0n),
    message: { author: { id: botId }, webhookId: botId, interactionMetadata: { user: { id: ownerId } } },
    deferUpdate: async () => { events.push('defer'); }, deleteReply: async () => { events.push('delete'); },
  });
  assert.deepEqual(events, ['defer', 'delete']);
  assert.deepEqual(errors, []);
});

test('unknown buttons and context menus are ignored without command errors', async () => {
  const { client, errors } = fixture();
  for (const input of [
    { isButton: () => true, customId: 'unknown:button' },
    { isMessageContextMenuCommand: () => true, commandName: 'Unknown action' },
    { isStringSelectMenu: () => true, customId: 'unknown:menu' },
  ]) {
    await dispatch(client, { ...input, reply: () => assert.fail('Unknown interaction reply') });
  }
  assert.deepEqual(errors, []);
});

test('a direct-message event never starts passive link processing', async () => {
  const { client, errors } = fixture();
  client.emit(Events.MessageCreate, {
    inGuild: () => false,
    get content() { return assert.fail('A private message must not be read by automatic fixing'); },
    get channel() { return assert.fail('A private channel must not be accessed by automatic fixing'); },
  } as unknown as ClientEvents[Events.MessageCreate][0]);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(errors, []);
});

test('YouTube controls obey current server scope, thread inheritance, operator limits and display preferences', async t => {
  const guildId = '1491242184391917590', channelId = '1491242185331576884';
  const parentId = '1491242185331576890', messageId = '1491242185331576885', botId = '1491240385031311470';
  const videoId = 'dQw4w9WgXcQ';
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input)); requests.push(url.pathname);
    assert.equal(url.origin, 'https://www.googleapis.com');
    return new Response(JSON.stringify({ items: url.pathname.endsWith('/videos') ? [{
      id: videoId, status: { privacyStatus: 'public', embeddable: true }, statistics: { viewCount: '42' },
    }] : [{ snippet: { videoId, topLevelComment: { snippet: { textDisplay: 'A useful video', authorDisplayName: 'Viewer' } } } }] }),
    { status: 200 });
  });
  const scenarios: { name: string; enabled?: boolean; preferences?: ServerPreferences; action?: 'stats' | 'comment';
    operator?: 'server' | 'parent'; thread?: boolean; key?: boolean; platform?: boolean; allowed: boolean }[] = [
    { name: 'enabled counts', enabled: true, preferences: { youtubeDisplay: 'counts' }, allowed: true },
    { name: 'enabled comment', enabled: true, action: 'comment', allowed: true },
    { name: 'operator enabled', operator: 'server', allowed: true },
    { name: 'unconfigured server', allowed: false },
    { name: 'explicit disable overrides operator', enabled: false, operator: 'server', allowed: false },
    { name: 'selected parent includes thread', enabled: true, preferences: { channelIds: [parentId] }, thread: true, allowed: true },
    { name: 'legacy parent scope stays exact', operator: 'parent', thread: true, allowed: false },
    { name: 'empty selection excludes channel', enabled: true, preferences: { channelIds: [] }, allowed: false },
    { name: 'server platform disabled', enabled: true, preferences: { platforms: { youtube: false } }, allowed: false },
    { name: 'operator platform disabled', enabled: true, platform: false, allowed: false },
    { name: 'operator key absent', enabled: true, key: false, allowed: false },
    { name: 'preview disables stats', enabled: true, preferences: { youtubeDisplay: 'preview' }, allowed: false },
    { name: 'preview disables comments', enabled: true, preferences: { youtubeDisplay: 'preview' }, action: 'comment', allowed: false },
    { name: 'counts disables comments', enabled: true, preferences: { youtubeDisplay: 'counts' }, action: 'comment', allowed: false },
  ];
  for (const scenario of scenarios) {
    const caseDirectory = mkdtempSync(join(directory, 'youtube-dispatch-'));
    const settingsPath = join(caseDirectory, 'servers.json');
    writeFileSync(join(caseDirectory, 'youtube-stats.json'), JSON.stringify([{ kind: 'controls', channelId,
      messageId, expiresAt: Date.now() + 60_000, videoIds: [videoId] }]));
    const servers = new ServerSettings(settingsPath);
    if (scenario.enabled !== undefined) await servers.set(guildId, scenario.enabled);
    if (scenario.preferences) await servers.update(guildId, scenario.preferences);
    const { client, errors } = fixture({ settingsPath, channelIds: scenario.operator === 'parent' ? [parentId] : [],
      serverIds: scenario.operator === 'server' ? [guildId] : [], rewritePlatforms: scenario.platform === false ? [] : ['youtube'],
      youtubeApiKey: scenario.key === false ? undefined : 'unit-test-key' }, servers);
    for (const listener of client.listeners(Events.ClientReady)) await listener({
      application: { commands: { set: async () => {} } }, user: { id: botId, tag: 'Linky' }, guilds: { cache: new Map() },
    } as unknown as Client<true>);
    requests.length = 0;
    const events: { name: string; payload: any }[] = [];
    await dispatch(client, {
      isButton: () => true, customId: `linky:yt:${scenario.action ?? 'stats'}:${videoId}`, guildId, channelId,
      channel: { isThread: () => scenario.thread ?? false, parentId },
      message: { id: messageId, guildId, channelId, author: { id: botId } },
      reply: async (payload: unknown) => { events.push({ name: 'reply', payload }); },
      deferReply: async (payload: unknown) => { events.push({ name: 'defer', payload }); },
      editReply: async (payload: unknown) => { events.push({ name: 'edit', payload }); },
    });
    assert.deepEqual(errors, [], scenario.name);
    assert.deepEqual(events.map(event => event.name), scenario.allowed ? ['defer', 'edit'] : ['reply'], scenario.name);
    assert.equal(events[0].payload.flags, MessageFlags.Ephemeral, scenario.name);
    assert.deepEqual(requests, scenario.allowed ? ['/youtube/v3/videos',
      ...(scenario.action === 'comment' ? ['/youtube/v3/commentThreads'] : [])] : [], scenario.name);
    for (const event of events.filter(event => event.name !== 'defer')) assert.deepEqual(event.payload.allowedMentions,
      { parse: [], users: [], roles: [], repliedUser: false }, scenario.name);
  }
});

test('failed YouTube interactions do not log private response bodies or raw provider errors', async () => {
  const { client, errors } = fixture();
  await dispatch(client, {
    isButton: () => true, customId: 'linky:yt:stats:dQw4w9WgXcQ',
    guildId: null, channelId: null, message: { id: 'untracked', channelId: null, author: { id: 'untracked' } },
    reply: async () => { throw Object.assign(new Error('secret-comment-and-key'), { code: 10062,
      requestBody: { json: { content: 'secret-comment-and-key' } } }); },
  });
  assert.equal(errors.length, 1);
  assert(!JSON.stringify(errors).includes('secret-comment-and-key'));
  assert(JSON.stringify(errors).includes('10062'));
});
