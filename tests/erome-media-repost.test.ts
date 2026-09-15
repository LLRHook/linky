import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, Collection, ComponentType, Events, MessageFlags, MessageFlagsBitField, MessageType,
  PermissionsBitField, type Message, type MessageCreateOptions, type APIMessageTopLevelComponent } from 'discord.js';
import { createLinkRepostHandler } from '../src/services/SocialLinkService';
import type { EromeMedia } from '../src/services/EromeMedia';
import type { ServerPreferences } from '../src/services/ServerSettings';

const bot = '1491240385031311470', channelId = '123456789012345678';
const media: EromeMedia = { id: 'a'.repeat(32), size: 20, sha256: 'b'.repeat(64), videoCount: 1,
  url: `https://media.example.test/media/${'a'.repeat(32)}.mp4`,
  metadata: { width: 1280, height: 720, duration: 160, fps: 24 } };

function fixture(prepared = media, observed = { width: prepared.metadata.width, height: prepared.metadata.height }) {
  const client = new Client({ intents: [] }); Object.assign(client, { user: { id: bot } });
  const events: string[] = [], sends: MessageCreateOptions[] = [], errors: unknown[] = [];
  let preferences: ServerPreferences = { eromeChannels: 'all' };
  let components: APIMessageTopLevelComponent[] = [];
  const replacement = {
    id: '123456789012345680', channelId, author: { id: bot }, attachments: new Collection(), embeds: [],
    get components() { return components.map(component => ({ toJSON: () => component })); },
    fetch: async () => replacement,
    edit: async (payload: { components: APIMessageTopLevelComponent[] }) => { events.push('controls'); components = payload.components; return replacement; },
    delete: async () => { events.push('delete preview'); },
  };
  const source = {
    id: '123456789012345679', channelId, guildId: '987654321098765432', client,
    content: 'Music https://www.erome.com/a/9f9EJu3q', author: { id: '777777777777777777', bot: false },
    guild: { members: { me: { id: bot } }, premiumTier: 0 }, partial: false, webhookId: null,
    type: MessageType.Default, poll: null, pinned: false, hasThread: false, editedTimestamp: null,
    stickers: new Collection(), components: [], messageSnapshots: new Collection(),
    flags: new MessageFlagsBitField(), attachments: new Collection(), reference: null,
    inGuild: () => true, deletable: true,
    channel: { isSendable: () => true, isThread: () => false, nsfw: true,
      permissionsFor: () => new PermissionsBitField(PermissionsBitField.All),
      send: async (payload: MessageCreateOptions) => {
        events.push('send'); sends.push(payload);
        components = (payload.components ?? []).map(component => 'toJSON' in component ? component.toJSON() : component) as APIMessageTopLevelComponent[];
        const ready = components.map(component => component.type === ComponentType.MediaGallery ? {
          ...component, items: component.items.map(item => ({ ...item, media: { ...item.media,
            content_type: 'video/mp4', proxy_url: 'https://proxy.example/video', ...observed } })) } : component);
        client.emit(Events.Raw, { t: 'MESSAGE_UPDATE', d: { id: replacement.id, channel_id: channelId, author: { id: bot }, components: ready } });
        return replacement;
      },
    },
    fetch: async () => source,
    delete: async () => { events.push('delete original'); },
  };
  const options = {
    platforms: ['erome'] as const, serverPreferences: () => preferences,
    prepareErome: async () => { events.push('legacy'); return null; },
    prepareEromeMedia: async () => { events.push('prepare'); return prepared; },
    bindEromeMedia: async () => { events.push('bind'); return true; },
    releaseEromeMedia: async (id: string) => { assert.equal(id, replacement.id); events.push('release'); },
    rememberRepost: async () => { events.push('ownership'); return true; },
  };
  return { source, replacement, client, events, sends, errors, options,
    preferences: (value: ServerPreferences) => { preferences = value; },
    run: async (overrides: Partial<typeof options> = {}) => {
      const handler = createLinkRepostHandler([channelId], { info() {}, warn() {}, error: (value: unknown) => errors.push(value) },
        undefined, { ...options, ...overrides });
      try { await handler(source as unknown as Message); } finally { await client.destroy(); }
    },
  };
}

test('automatic original video captures early metadata, binds ownership and keeps gallery when adding Remove', async () => {
  const f = fixture(); await f.run();
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.events, ['prepare', 'send', 'bind', 'ownership', 'controls']);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].flags, MessageFlags.IsComponentsV2);
  assert.equal(f.sends[0].content, undefined); assert.equal(f.sends[0].files, undefined);
  assert.deepEqual(f.sends[0].allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
  assert.equal(f.sends[0].reply?.messageReference, f.source.id);
  const components = f.replacement.components.map(component => component.toJSON());
  assert(components.some(component => component.type === ComponentType.MediaGallery));
  assert(JSON.stringify(components).includes('linky:remove'));
  assert(!JSON.stringify(f.sends[0].components).includes('linky:remove'));
  assert.equal(f.client.listenerCount(Events.Raw), 0);
});

test('a slow automatic original uses one progress reply and converts that message into its gallery', async () => {
  const f = fixture(), edits: unknown[] = [], edit = f.replacement.edit;
  f.replacement.edit = async payload => {
    edits.push(payload);
    const result = await edit(payload);
    const components = f.replacement.components.map(component => component.toJSON()).map(component =>
      component.type === ComponentType.MediaGallery ? { ...component, items: component.items.map(item => ({ ...item,
        media: { ...item.media, content_type: 'video/mp4', proxy_url: 'https://proxy.example/video', width: 1280, height: 720 } })) }
        : component);
    f.client.emit(Events.Raw, { t: 'MESSAGE_UPDATE', d: { id: f.replacement.id, channel_id: channelId,
      author: { id: bot }, components } });
    return result;
  };
  await f.run({ prepareEromeMedia: async () => { await delay(1600); return media; } });
  assert.deepEqual(f.errors, []);
  assert.equal(f.sends.length, 1);
  assert.match(String(f.sends[0].content), /Preparing your Erome preview/);
  assert.equal(f.sends[0].reply?.messageReference, f.source.id);
  assert(edits.some(payload => (payload as { flags?: number }).flags === MessageFlags.IsComponentsV2 &&
    (payload as { content?: unknown }).content === null));
  assert(f.replacement.components.some(component => component.toJSON().type === ComponentType.MediaGallery));
  assert(!f.events.includes('delete original'));
});

test('failed media binding deletes only the new preview and releases its storage', async () => {
  const f = fixture(); await f.run({ bindEromeMedia: async () => false });
  assert.deepEqual(f.events, ['prepare', 'send', 'delete preview', 'release']);
  assert.equal(f.client.listenerCount(Events.Raw), 0);
});

test('automatic preview survives Discord rounding a 480×852 source to 479×852', async () => {
  const original = { ...media, metadata: { width: 480, height: 852, duration: 33.548, fps: 30 } };
  const f = fixture(original, { width: 479, height: 852 });
  await f.run();
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.events, ['prepare', 'send', 'bind', 'ownership', 'controls']);
  assert.equal(f.sends.length, 1);
  assert(f.replacement.components.some(component => component.toJSON().type === ComponentType.MediaGallery));
  assert.equal(f.client.listenerCount(Events.Raw), 0);
});

test('source edits or revoked scope during preparation never publish the old video', async () => {
  for (const change of ['content', 'scope']) {
    const f = fixture();
    await f.run({ prepareEromeMedia: async () => {
      if (change === 'content') f.source.content = 'Changed source';
      else f.preferences({ eromeChannels: 'all', platforms: { erome: false } });
      return media;
    } });
    assert.deepEqual(f.sends, []); assert(!f.events.includes('delete original'));
  }
});

test('failed ownership persistence rolls back the video without exposing Remove', async () => {
  const f = fixture(); await f.run({ rememberRepost: async () => false });
  assert.deepEqual(f.events, ['prepare', 'send', 'bind', 'delete preview', 'release']);
});

test('scope changes or failed final controls roll back the original video after ownership was saved', async () => {
  for (const failure of ['scope', 'edit', 'source']) {
    const f = fixture();
    const edit = f.replacement.edit;
    f.replacement.edit = async payload => {
      const result = await edit(payload);
      if (failure === 'edit') throw Error('Discord unavailable');
      if (failure === 'source') f.source.content = 'Edited during final controls';
      else f.preferences({ eromeChannels: 'all', platforms: { erome: false } });
      return result;
    };
    await f.run();
    assert.deepEqual(f.events, ['prepare', 'send', 'bind', 'ownership', 'controls', 'delete preview', 'release']);
    assert.equal(f.client.listenerCount(Events.Raw), 0);
  }
});

test('mixed URLs and unavailable regional media try attachment fallback then save an owner-bound retry notice', async () => {
  const mixed = fixture(); mixed.source.content += ' https://x.com/user/status/1'; await mixed.run();
  assert.deepEqual(mixed.events, ['legacy', 'send', 'ownership', 'controls']);
  assert(!mixed.events.includes('delete original'));
  assert(JSON.stringify(mixed.replacement.components).includes('linky:retry'));
  const unavailable = fixture();
  await unavailable.run({ prepareEromeMedia: async () => { throw Error('Worker unavailable'); } });
  assert.deepEqual(unavailable.events, ['legacy', 'send', 'ownership', 'controls']);
  assert(!unavailable.events.includes('delete original'));
  assert.match(String(unavailable.sends[0].content), /could not be prepared/);
});
