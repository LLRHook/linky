import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Client, Events, GatewayIntentBits, MessageFlags, Routes, type Interaction, type Guild, type InteractionReplyOptions } from 'discord.js';
import { createBot } from '../src/bot';
import type { Config } from '../src/config';
import { data } from '../src/commands/help';
import { registerCommands } from '../src/commands/register';

const settings: Config = {
  discordToken: 'unused', channelIds: ['configured-channel'],
  rewritePlatforms: ['x', 'instagram', 'tiktok'], translateTweets: true,
};
const clients: Client[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.destroy())); });

function fixture(overrides: Partial<Config> = {}) {
  const logs: unknown[] = [];
  const errors: unknown[] = [];
  const client = createBot({ ...settings, ...overrides }, {
    info: (...args: unknown[]) => logs.push(args), warn() {}, error: (...args: unknown[]) => errors.push(args),
  } as Parameters<typeof createBot>[1]);
  clients.push(client);
  return { client, logs, errors };
}

async function command(client: Client, name: string, channelId = 'configured-channel') {
  const replies: InteractionReplyOptions[] = [];
  client.emit(Events.InteractionCreate, {
    isChatInputCommand: () => true, commandName: name, channelId,
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

test('an unconfigured bot does not request or process message content', () => {
  const { client } = fixture({ channelIds: [] });
  assert.deepEqual(client.options.intents.toArray(), ['Guilds']);
  assert.equal(client.listenerCount(Events.MessageCreate), 0);
});

for (const hasSystemChannel of [true, false]) {
  test(`joining a server sends nothing (${hasSystemChannel ? 'with' : 'without'} a system channel)`, async () => {
    const { client, logs } = fixture();
    let sends = 0;
    const channel = { send: async () => { sends++; } };
    const guild = { id: 'new-guild', systemChannel: hasSystemChannel ? channel : null, channels: { cache: new Map([['general', channel]]) } };
    client.emit(Events.GuildCreate, guild as unknown as Guild);
    client.emit(Events.ClientReady, { user: { tag: 'Linky#0805' }, guilds: { cache: new Map([['new-guild', guild]]) } } as unknown as Client<true>);
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

test('cached gambling commands receive only a private retirement notice', async () => {
  const { client } = fixture();
  for (const name of ['wanna-bet', 'balance', 'daily', 'admin', 'vote-admin']) {
    const replies = await command(client, name);
    assert.deepEqual(replies, [{ content: 'This command has been retired. Use /help for link fixing.', flags: MessageFlags.Ephemeral }]);
  }
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

test('registration replaces the entire global command list with /help', async () => {
  const calls: unknown[] = [];
  await registerCommands({
    get: async route => { calls.push(route); return { id: 'application-id' }; },
    put: async (route, options) => { calls.push([route, options]); return []; },
  });
  assert.deepEqual(calls, [Routes.oauth2CurrentApplication(), [Routes.applicationCommands('application-id'), { body: [data.toJSON()] }]]);
  assert.equal(data.toJSON().name, 'help');
});

test('failed application authentication leaves registered commands untouched', async () => {
  await assert.rejects(registerCommands({
    get: async () => { throw new Error('Unauthorized'); },
    put: async () => { assert.fail('Cannot replace commands without an authenticated application'); },
  }), /Unauthorized/);
});
