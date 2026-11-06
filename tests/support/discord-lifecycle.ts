import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ChannelType, ClientUser, Events, Guild, Message, PermissionsBitField, TextChannel,
  type APIEmbed, type APIMessage, type Client, type GuildMember, type Interaction } from 'discord.js';
import { createBot } from '../../src/bot';
import { ServerSettings } from '../../src/services/ServerSettings';
import { InFlightWork } from '../../src/services/InFlightWork';

export const BOT = '1491240385031311470', OWNER = '777777777777777777', MEMBER = '666666666666666666';
export const GUILD = '987654321098765432', CHANNEL = '123456789012345678';
const user = (id: string) => ({ id, username: id === BOT ? 'Linky fixture' : 'Synthetic member', discriminator: '0', avatar: null,
  global_name: null, bot: id === BOT });
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Real discord.js messages, payload serialization, caches and Gateway actions; only the REST transport is replaced.
 * Delayed component loss replays the observed server state, without asserting which external writer caused it.
 * No token, connection, HTTP request or real Discord content is used.
 */
export async function discordLifecycle(t: TestContext, mode: 'reply' | 'replace' = 'replace') {
  const directory = await mkdtemp(join(tmpdir(), 'linky-sdk-lifecycle-'));
  const tasks = new Set<Promise<unknown>>(), clients: Client[] = [], errors: unknown[] = [];
  const originalTrack = InFlightWork.prototype.track;
  t.mock.method(InFlightWork.prototype, 'track', function<T>(this: InFlightWork, task: Promise<T>): Promise<T> {
    tasks.add(task);
    void task.finally(() => tasks.delete(task)).catch(() => {});
    return originalTrack.call(this, task) as Promise<T>;
  });
  async function drain() {
    while (tasks.size) await Promise.all([...tasks]);
    assert.deepEqual(errors, [], 'production handlers must not swallow a fixture or product failure');
  }
  t.after(async () => {
    for (const client of clients) await client.destroy();
    await rm(directory, { recursive: true, force: true });
  });
  const state = new Map<string, APIMessage>();
  const requests: { method: string; id: string; body?: Record<string, unknown> }[] = [];
  const initialControls = new Map<string, APIMessage['components']>();
  let serial = (BigInt(Date.now() - 1_420_070_400_000) << 22n) + 100n;
  let render: (content: string) => APIEmbed[] = content => {
    const url = /https:\/\/[^\s<>]+/.exec(content)?.[0];
    return url ? [{ url, title: 'Synthetic author', description: 'Public fixture post',
      video: { url: 'https://media.example/fixture.mp4' } }] : [];
  };
  let frames: ((content: string) => APIEmbed[][]) | undefined;
  let observation: 'gateway' | 'rest' = 'gateway';
  let client: Client, channel: TextChannel;
  const handlerRoot = join(dirname(require.resolve('discord.js')), 'client/websocket/handlers');
  const handlers = {
    MESSAGE_CREATE: require(join(handlerRoot, 'MESSAGE_CREATE.js')) as (client: Client, packet: unknown) => void,
    MESSAGE_UPDATE: require(join(handlerRoot, 'MESSAGE_UPDATE.js')) as (client: Client, packet: unknown) => void,
  };
  function gateway(type: keyof typeof handlers, data: Record<string, unknown>) {
    const packet = { t: type, d: wire(data) };
    client.emit('raw', packet as never);
    handlers[type](client, packet);
  }
  function update(id: string, data: Partial<APIMessage>) {
    const current = state.get(id); assert(current, 'update requires an existing server message');
    Object.assign(current, wire(data));
    gateway('MESSAGE_UPDATE', { id, channel_id: CHANNEL, guild_id: GUILD, ...data });
  }
  function makeMessage(content: string, authorId: string): APIMessage {
    return { id: String(serial++), channel_id: CHANNEL, guild_id: GUILD, author: user(authorId), content,
      timestamp: new Date().toISOString(), edited_timestamp: null, type: 0, tts: false,
      pinned: false, mention_everyone: false, mentions: [], mention_roles: [], attachments: [], embeds: [], components: [] } as APIMessage;
  }
  const servers = new ServerSettings(join(directory, 'servers.json'));
  await servers.update(GUILD, { mode });
  async function boot() {
    client = createBot({ discordToken: 'unused-synthetic-fixture', channelIds: [CHANNEL], serverIds: [],
      rewritePlatforms: ['x', 'tiktok', 'bluesky', 'reddit'], translateTweets: false,
      settingsPath: join(directory, 'servers.json') }, { info() {}, warn() {}, error: (...args: unknown[]) => { errors.push(args); } }, servers);
    clients.push(client);
    Object.defineProperty(client, 'user', { value: Reflect.construct(ClientUser, [client, user(BOT)]) });
    Object.defineProperty(client, 'application', { value: { commands: { set: async () => [] } } });
    const guild = Reflect.construct(Guild, [client, { id: GUILD, name: 'Synthetic guild', premium_tier: 0, roles: [] }]) as Guild;
    client.guilds.cache.set(GUILD, guild);
    Object.defineProperty(guild.members, 'me', { value: { id: BOT } });
    channel = Reflect.construct(TextChannel, [guild, { id: CHANNEL, guild_id: GUILD, type: ChannelType.GuildText,
      name: 'synthetic-fixtures', permission_overwrites: [] }, client]) as TextChannel;
    client.channels.cache.set(CHANNEL, channel); guild.channels.cache.set(CHANNEL, channel);
    t.mock.method(channel, 'permissionsFor', () => new PermissionsBitField(PermissionsBitField.All));
    t.mock.method(guild.members, 'fetch', async (options: { user: string }) => ({ id: options.user,
      communicationDisabledUntilTimestamp: null }) as GuildMember);
    t.mock.method(guild.channels, 'fetch', async () => channel);
    const idFrom = (route: string) => {
      assert.match(route, new RegExp(`^/channels/${CHANNEL}/messages(?:/\\d+)?$`), 'unexpected REST endpoint');
      return route.split('/').at(-1)!;
    };
    t.mock.method(client.rest, 'get', async (route: string) => {
      const id = idFrom(route); requests.push({ method: 'GET', id });
      const message = state.get(id); if (!message) throw { code: 10008, status: 404 };
      return wire(message);
    });
    t.mock.method(client.rest, 'post', async (route: string, options: { body: Record<string, unknown>; files: unknown[] }) => {
      assert.equal(idFrom(route), 'messages'); assert.equal(options.files.length, 0);
      const body = wire(options.body), message = Object.assign(makeMessage('', BOT), body);
      requests.push({ method: 'POST', id: message.id, body });
      initialControls.set(message.id, wire(message.components)); state.set(message.id, message);
      // Both events may precede the REST send response, as in discord.js's actual send/cache boundary.
      gateway('MESSAGE_CREATE', message as unknown as Record<string, unknown>);
      for (const embeds of frames?.(message.content) ?? [render(message.content)]) {
        if (observation === 'gateway') update(message.id, { embeds });
        else message.embeds = wire(embeds);
      }
      return wire(message);
    });
    t.mock.method(client.rest, 'patch', async (route: string, options: { body: Record<string, unknown>; files: unknown[] }) => {
      const id = idFrom(route), current = state.get(id); if (!current) throw { code: 10008, status: 404 };
      const body = wire(options.body); requests.push({ method: 'PATCH', id, body }); Object.assign(current, body);
      if ('content' in body) for (const embeds of frames?.(current.content) ?? [render(current.content)]) {
        if (observation === 'gateway') update(id, { embeds });
        else current.embeds = wire(embeds);
      }
      // Return a wire snapshot. MessageManager.edit itself clones the cached Message and patches the clone.
      // A later Gateway update, rather than this response, changes the original cached SDK handle.
      return wire(current);
    });
    t.mock.method(client.rest, 'delete', async (route: string) => {
      const id = idFrom(route); requests.push({ method: 'DELETE', id });
      if (!state.delete(id)) throw { code: 10008, status: 404 };
    });
    for (const ready of client.listeners(Events.ClientReady)) await ready(client as never);
  }
  await boot();
  return {
    directory, state, requests, initialControls, drain, update,
    get client() { return client; }, get channel() { return channel; },
    render: (value: typeof render) => { render = value; },
    frames: (value: NonNullable<typeof frames>) => { frames = value; },
    observation: (value: typeof observation) => { observation = value; },
    async restart() { await client.destroy(); await boot(); },
    async post(content: string) {
      const data = makeMessage(content, OWNER); state.set(data.id, data);
      gateway('MESSAGE_CREATE', data as unknown as Record<string, unknown>); await drain(); return data.id;
    },
    async click(id: string, customId: string, actor = OWNER) {
      const data = state.get(id); assert(data);
      const replies: { content?: string; flags?: number }[] = [];
      const message = Reflect.construct(Message, [client, wire(data)]) as Message;
      const interaction = { customId, channelId: CHANNEL, guildId: GUILD, user: { id: actor }, client,
        applicationId: BOT, message, deferred: false, replied: false,
        isButton: () => true, isChatInputCommand: () => false, isMessageContextMenuCommand: () => false,
        isStringSelectMenu: () => false, isChannelSelectMenu: () => false,
        deferReply: async (payload: { flags?: number }) => { replies.push(payload); interaction.deferred = true; },
        reply: async (payload: { content?: string; flags?: number }) => { replies.push(payload); },
        editReply: async (payload: { content?: string }) => { replies.push(payload); },
      };
      client.emit(Events.InteractionCreate, interaction as unknown as Interaction); await drain(); return replies;
    },
  };
}
