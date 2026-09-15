import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { ComponentType, Events, MessageFlags, PermissionFlagsBits, PermissionsBitField,
  type APIMessageTopLevelComponent, type ButtonInteraction, type ChatInputCommandInteraction,
  type Message, type MessageContextMenuCommandInteraction } from 'discord.js';
import { execute, removeManual } from '../src/commands/fix';
import type { Config } from '../src/config';
import type { EromeMedia } from '../src/services/EromeMedia';

const BOT = '1491240385031311470', OWNER = '111111111111111111', MESSAGE = '333333333333333333';
const album = 'https://www.erome.com/a/Album123';
const config: Config = { discordToken: '', channelIds: [], serverIds: [], rewritePlatforms: ['erome', 'x'],
  translateTweets: false, settingsPath: 'unused' };
const media: EromeMedia = {
  id: '0123456789abcdef0123456789abcdef', size: 25_026_293, sha256: '0'.repeat(64),
  url: 'https://media.example.com/media/0123456789abcdef0123456789abcdef.mp4', videoCount: 2,
  metadata: { width: 1280, height: 720, duration: 160, fps: 30 },
};
type Payload = { flags?: number; content?: string | null; components?: APIMessageTopLevelComponent[];
  allowedMentions?: unknown; files?: unknown };

function fixture(content = album, context = false) {
  const events: { name: string; payload?: Payload }[] = [];
  const client = Object.assign(new EventEmitter(), { user: { id: BOT } });
  const state = {
    metadata: true, gateway: false, failFirstEdit: false, wrongReconciliation: false,
    bound: true, afterPrepare: () => {}, afterBind: () => {}, afterVerify: () => {}, afterControls: () => {},
  };
  const response = {
    id: MESSAGE, channelId: 'channel', author: { id: BOT }, components: [] as { toJSON(): APIMessageTopLevelComponent }[],
    fetch: async () => { events.push({ name: 'fetch-message' }); state.afterVerify(); return response as unknown as Message; },
  };
  let edits = 0;
  const input = {
    isChatInputCommand: () => !context, inGuild: () => true,
    guildId: 'guild', channelId: 'channel', user: { id: OWNER }, client,
    channel: { isThread: () => false, nsfw: true },
    appPermissions: new PermissionsBitField(PermissionFlagsBits.AttachFiles),
    memberPermissions: new PermissionsBitField(PermissionFlagsBits.SendMessages), attachmentSizeLimit: 10 * 1024 * 1024,
    options: { getString: () => content },
    targetMessage: { content, delete: () => assert.fail('The original must remain'), edit: () => assert.fail('The original must remain') },
    reply: async (payload: Payload) => { events.push({ name: 'reply', payload }); },
    deferReply: async (payload: Payload) => { events.push({ name: 'defer', payload }); },
    editReply: async (payload: Payload) => {
      events.push({ name: 'edit', payload });
      edits++;
      if (payload.components) response.components = payload.components.map(component => ({ toJSON: () => {
        if (component.type !== ComponentType.MediaGallery || !state.metadata) return component;
        return { ...component, items: component.items.map(item => ({ ...item, media: {
          ...item.media, content_type: 'video/mp4', proxy_url: 'https://discord.example/proxy', width: 1280, height: 720,
        } })) };
      } }));
      if (state.gateway && payload.components?.some(component => component.type === ComponentType.MediaGallery)) {
        assert.equal(client.listenerCount(Events.Raw), 1, 'watcher is registered before publication');
        client.emit(Events.Raw, { t: 'MESSAGE_UPDATE', d: { id: MESSAGE, channel_id: input.channelId,
          components: [{ type: ComponentType.MediaGallery, items: [{ media: { url: media.url,
            content_type: 'video/mp4', proxy_url: 'https://discord.example/proxy', width: 1280, height: 720 } }] }] } });
      }
      if (state.failFirstEdit && edits === 1) throw new Error('uncertain REST edit');
      if (edits === 2) state.afterControls();
      return response as unknown as Message;
    },
    fetchReply: async () => {
      events.push({ name: 'fetch-reply' });
      if (state.wrongReconciliation) return { ...response, components: [{ toJSON: () => ({ type: ComponentType.MediaGallery,
        items: [{ media: { url: 'https://media.example.com/media/unrelated.mp4' } }] }) }] } as unknown as Message;
      return response as unknown as Message;
    },
  };
  const dependencies: NonNullable<Parameters<typeof execute>[2]> = {
    prepareEromeMedia: async source => { assert.equal(source, album); events.push({ name: 'prepare' }); state.afterPrepare(); return media; },
    bindEromeMedia: async (id, messageId) => { assert.equal(id, media.id); assert.equal(messageId, MESSAGE);
      events.push({ name: 'bind' }); state.afterBind(); return state.bound; },
    releaseEromeMedia: async id => { assert.equal(id, MESSAGE); events.push({ name: 'release' }); },
    prepareErome: async () => { events.push({ name: 'legacy' }); return null; },
    verifyErome: async () => assert.fail('URL media must not run attachment verification'),
  };
  return { input, events, state, response, client, dependencies,
    interaction: input as unknown as ChatInputCommandInteraction | MessageContextMenuCommandInteraction };
}

function controls(payload: Payload): { custom_id?: string; url?: string }[] {
  return payload.components?.flatMap(component => component.type === ComponentType.ActionRow ? component.components : [])
    .map(component => ({ ...'custom_id' in component ? { custom_id: component.custom_id } : {},
      ...'url' in component ? { url: component.url } : {} })) ?? [];
}
function gallery(payload: Payload): boolean { return payload.components?.some(component => component.type === ComponentType.MediaGallery) ?? false; }
async function advance(t: TestContext, ms: number): Promise<void> { await nextTurn(); t.mock.timers.tick(ms); await nextTurn(); }

for (const context of [false, true]) {
  test(`${context ? 'context menu' : 'slash fix'} publishes complete media, binds before verification and adds owner-only removal last`, async () => {
    const f = fixture(album, context);
    f.state.metadata = false; f.state.gateway = true;
    await execute(f.interaction, config, f.dependencies);
    assert.deepEqual(f.events.map(event => event.name), ['defer', 'prepare', 'edit', 'bind', 'edit']);
    const edits = f.events.filter(event => event.name === 'edit').map(event => event.payload!);
    assert.equal(edits[0].flags, MessageFlags.IsComponentsV2);
    assert.equal(gallery(edits[0]), true);
    assert.equal(controls(edits[0]).some(button => button.custom_id === 'linky:remove-manual'), false);
    assert.equal(controls(edits[1]).at(-1)?.custom_id, 'linky:remove-manual');
    assert.equal(controls(edits[0])[0].url, album);
    assert(edits.every(edit => edit.content === undefined && edit.files === undefined));
    assert(edits.every(edit => JSON.stringify(edit.allowedMentions) === '{"parse":[]}'));
    assert.equal(f.client.listenerCount(Events.Raw), 0);
    assert.equal(f.input.targetMessage.content, album);
  });
}

test('requesters without send permission keep their prepared-media reply private', async () => {
  const f = fixture(); f.input.memberPermissions = new PermissionsBitField(0n);
  await execute(f.interaction, config, f.dependencies);
  assert.equal(f.events[0].payload?.flags, MessageFlags.Ephemeral);
  assert.equal(f.events.filter(event => event.name === 'edit').length, 2);
});

test('permission and Erome scope checks happen before preparation', async () => {
  for (const missing of ['scope', 'permission', 'guild']) {
    const f = fixture();
    if (missing === 'scope') f.input.channel.nsfw = false;
    if (missing === 'permission') f.input.appPermissions = new PermissionsBitField(0n);
    if (missing === 'guild') f.input.inGuild = () => false;
    await execute(f.interaction, config, f.dependencies);
    assert.deepEqual(f.events.map(event => event.name), ['reply']);
    assert.equal(f.events[0].payload?.flags, MessageFlags.Ephemeral);
  }
});

test('multiple albums, other visible URLs and missing lifecycle dependencies use the existing path', async () => {
  for (const content of [`${album} https://www.erome.com/a/OtherAlbum`, `${album} https://x.com/jack/status/20`,
    `${album} https://example.com/unrelated`]) {
    const f = fixture(content);
    await execute(f.interaction, config, f.dependencies);
    assert.equal(f.events.some(event => event.name === 'prepare'), false);
    assert.equal(f.events.some(event => event.name === 'legacy'), true);
  }
  const f = fixture(); delete f.dependencies.releaseEromeMedia;
  await execute(f.interaction, config, f.dependencies);
  assert.equal(f.events.some(event => event.name === 'prepare'), false);
});

test('unavailable regional preparation falls back before any V2 edit', async () => {
  const f = fixture(); f.dependencies.prepareEromeMedia = async () => null;
  await execute(f.interaction, config, f.dependencies);
  assert.equal(f.events.some(event => event.name === 'legacy'), true);
  assert.equal(f.events.some(event => event.payload?.flags === MessageFlags.IsComponentsV2), false);
});

test('scope revocation during preparation keeps the reply informative without publishing a gallery', async () => {
  const f = fixture(); f.state.afterPrepare = () => { f.input.channel.nsfw = false; };
  await execute(f.interaction, config, f.dependencies);
  assert.deepEqual(f.events.map(event => event.name), ['defer', 'prepare', 'edit']);
  assert.equal(gallery(f.events.at(-1)!.payload!), false);
  assert.match(f.events.at(-1)!.payload!.content!, /no longer allowed/);
  assert.equal(f.client.listenerCount(Events.Raw), 0);
});

test('failed binding or revoked scope removes the V2 gallery and then releases its message binding', async () => {
  for (const reason of ['binding', 'scope']) {
    const f = fixture();
    if (reason === 'binding') f.state.bound = false;
    else f.state.afterBind = () => { f.input.channel.nsfw = false; };
    await execute(f.interaction, config, f.dependencies);
    assert.deepEqual(f.events.map(event => event.name), ['defer', 'prepare', 'edit', 'bind', 'edit', 'release']);
    const rollback = f.events.at(-2)!.payload!;
    assert.equal(rollback.flags, MessageFlags.IsComponentsV2);
    assert.equal(rollback.content, undefined);
    assert.equal(gallery(rollback), false);
    assert.equal(controls(rollback).some(button => button.custom_id), false);
    assert.equal(f.client.listenerCount(Events.Raw), 0);
  }
});

test('unconfirmed Discord metadata rolls back without exposing Remove or invoking attachment fallback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); f.state.metadata = false;
  const pending = execute(f.interaction, config, f.dependencies);
  await advance(t, 6000);
  await pending;
  assert.deepEqual(f.events.map(event => event.name), ['defer', 'prepare', 'edit', 'bind', 'fetch-message', 'edit', 'release']);
  assert.equal(gallery(f.events.at(-2)!.payload!), false);
  assert.equal(f.client.listenerCount(Events.Raw), 0);
});

test('scope revoked while metadata is arriving cannot retain a verified gallery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); f.state.metadata = false;
  f.state.afterVerify = () => { f.state.metadata = true; f.input.channel.nsfw = false; };
  const pending = execute(f.interaction, config, f.dependencies);
  await advance(t, 6000);
  await pending;
  assert.deepEqual(f.events.map(event => event.name), ['defer', 'prepare', 'edit', 'bind', 'fetch-message', 'edit', 'release']);
  assert.equal(gallery(f.events.at(-2)!.payload!), false);
  assert.equal(f.client.listenerCount(Events.Raw), 0);
});

test('scope revocation or a failed final controls edit rolls back with V2 components and releases the binding', async () => {
  for (const reason of ['scope', 'edit']) {
    const f = fixture();
    f.state.afterControls = () => {
      if (reason === 'scope') f.input.channel.nsfw = false;
      else throw new Error('final edit uncertain');
    };
    await execute(f.interaction, config, f.dependencies);
    assert.deepEqual(f.events.map(event => event.name), ['defer', 'prepare', 'edit', 'bind', 'edit', 'edit', 'release']);
    const rollback = f.events.at(-2)!.payload!;
    assert.equal(gallery(rollback), false);
    assert.equal(rollback.content, undefined);
    assert.equal(rollback.flags, MessageFlags.IsComponentsV2);
    assert.equal(f.client.listenerCount(Events.Raw), 0);
  }
});

test('an uncertain edit reconciles once by the exact gallery URL before binding', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); f.state.failFirstEdit = true;
  const pending = execute(f.interaction, config, f.dependencies);
  await advance(t, 10_000);
  await pending;
  assert.deepEqual(f.events.map(event => event.name), ['defer', 'prepare', 'edit', 'fetch-reply', 'bind', 'edit']);
  assert.equal(f.events.filter(event => gallery(event.payload ?? {})).length, 2, 'initial gallery and final controls only');
  assert.equal(f.client.listenerCount(Events.Raw), 0);
});

test('an uncertain edit with an unrelated gallery never binds or retries media publication', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); f.state.failFirstEdit = true; f.state.wrongReconciliation = true;
  const pending = execute(f.interaction, config, f.dependencies);
  await advance(t, 10_000);
  await pending;
  assert.deepEqual(f.events.map(event => event.name), ['defer', 'prepare', 'edit', 'fetch-reply', 'edit']);
  assert.equal(gallery(f.events.at(-1)!.payload!), false);
  assert.equal(f.client.listenerCount(Events.Raw), 0);
});

test('manual removal releases only after an authorized successful deletion', async () => {
  for (const scenario of ['success', 'unauthorized', 'delete-failure', 'unrelated']) {
    const events: string[] = [];
    const input = {
      customId: scenario === 'unrelated' ? 'another-button' : 'linky:remove-manual',
      user: { id: scenario === 'unauthorized' ? '222222222222222222' : OWNER }, client: { user: { id: BOT } }, applicationId: BOT,
      message: { id: MESSAGE, author: { id: BOT }, webhookId: BOT, interactionMetadata: { user: { id: OWNER } } },
      reply: async () => { events.push('deny'); }, deferUpdate: async () => { events.push('defer'); },
      deleteReply: async () => { events.push('delete'); if (scenario === 'delete-failure') throw new Error('not deleted'); },
    };
    const result = removeManual(input as unknown as ButtonInteraction, async id => { assert.equal(id, MESSAGE); events.push('release'); });
    if (scenario === 'delete-failure') { await assert.rejects(result, /not deleted/); assert.deepEqual(events, ['defer', 'delete']); }
    else if (scenario === 'unauthorized') { assert.equal(await result, true); assert.deepEqual(events, ['deny']); }
    else if (scenario === 'unrelated') { assert.equal(await result, false); assert.deepEqual(events, []); }
    else { assert.equal(await result, true); assert.deepEqual(events, ['defer', 'delete', 'release']); }
  }
});
