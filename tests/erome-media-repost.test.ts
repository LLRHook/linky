import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, Collection, ComponentType, Events, MessageFlags, MessageFlagsBitField, MessageType, PermissionFlagsBits,
  PermissionsBitField, type Message, type MessageCreateOptions, type APIMessageTopLevelComponent } from 'discord.js';
import { createLinkRepostHandler } from '../src/services/SocialLinkService';
import type { EromeMedia } from '../src/services/EromeMedia';
import type { ServerPreferences } from '../src/services/ServerSettings';
import type { AlbumRegistration, EromeAlbumSessions } from '../src/services/EromeAlbumSessions';

type AutoOptions = NonNullable<Parameters<typeof createLinkRepostHandler>[3]>;

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
    run: async (overrides: AutoOptions = {}) => {
      const handler = createLinkRepostHandler([channelId], { info() {}, warn() {}, error: (value: unknown) => errors.push(value) },
        undefined, { ...options, ...overrides });
      try { await handler(source as unknown as Message); } finally { await client.destroy(); }
    },
  };
}

test('automatic original video captures early metadata, binds ownership and keeps gallery when adding Remove', async () => {
  const f = fixture(); await f.run();
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.events, ['prepare', 'send', 'bind', 'ownership', 'delete original', 'controls']);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].flags, MessageFlags.IsComponentsV2);
  assert.equal(f.sends[0].content, undefined); assert.equal(f.sends[0].files, undefined);
  assert.deepEqual(f.sends[0].allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
  assert.equal(f.sends[0].reply, undefined);
  const components = f.replacement.components.map(component => component.toJSON());
  assert(components.some(component => component.type === ComponentType.MediaGallery));
  assert(JSON.stringify(components).includes('linky:remove'));
  assert(!JSON.stringify(f.sends[0].components).includes('linky:remove'));
  assert.equal(f.client.listenerCount(Events.Raw), 0);
});

test('Replace mode removes the source after confirming and retaining its hosted Erome preview', async () => {
  const f = fixture();
  f.preferences({ mode: 'replace', eromeChannels: 'all' });
  f.source.fetch = async () => {
    if (f.events.includes('delete original')) throw Object.assign(Error('Unknown message'), { code: 10008 });
    return f.source;
  };
  await f.run();
  assert.deepEqual(f.errors, []);
  assert(f.events.includes('delete original'), 'successful Erome delivery must respect Replace mode');
  assert(!f.events.includes('delete preview'));
  assert(JSON.stringify(f.replacement.components).includes('https://www.erome.com/a/9f9EJu3q'));
});

test('a slow automatic Replace converts one standalone progress message into its gallery', async () => {
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
  assert.equal(f.sends[0].reply, undefined);
  assert(edits.some(payload => (payload as { flags?: number }).flags === MessageFlags.IsComponentsV2 &&
    (payload as { content?: unknown }).content === null));
  assert(f.replacement.components.some(component => component.toJSON().type === ComponentType.MediaGallery));
  assert(f.events.includes('delete original'));
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
  assert.deepEqual(f.events, ['prepare', 'send', 'bind', 'ownership', 'delete original', 'controls']);
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
    f.preferences({ mode: 'reply', eromeChannels: 'all' });
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

test('hosted Erome Reply retains its source dependency while Replace preserves the caption and every album URL', async () => {
  for (const mode of ['reply', 'replace'] as const) {
    const f = fixture(), registrations: AlbumRegistration[] = [];
    f.preferences({ mode, eromeChannels: 'all' });
    f.source.content += ' https://www.erome.com/a/SecondAlbum';
    await f.run({ albums: { register: (record: AlbumRegistration) => { registrations.push(record); } } as unknown as EromeAlbumSessions });
    assert.deepEqual(f.errors, []);
    assert.equal(f.events.includes('delete original'), mode === 'replace');
    assert.equal(f.sends[0].reply?.messageReference, mode === 'reply' ? f.source.id : undefined);
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].sourceMessageId, mode === 'reply' ? f.source.id : undefined);
    const text = JSON.stringify(f.replacement.components);
    assert(text.includes('Music') && text.includes('https://www.erome.com/a/9f9EJu3q') &&
      text.includes('https://www.erome.com/a/SecondAlbum'));
  }
});

test('a tagged slow Replace sends its gallery separately from quiet progress and cleans progress up', async () => {
  const f = fixture(), target = '444444444444444444', send = f.source.channel.send;
  const mentions = { parse: [], users: [target], roles: [], repliedUser: false };
  f.source.content = `<@${target}> ${f.source.content}`;
  Object.assign(f.source, { mentions: { users: new Collection([[target, { id: target }]]) } });
  f.source.flags.add(MessageFlags.SuppressNotifications);
  let progressDeleted = false;
  f.source.channel.send = async payload => {
    if (payload.content?.startsWith('Preparing')) {
      f.sends.push(payload);
      return { ...f.replacement, id: '123456789012345681',
        edit: async () => assert.fail('A tagged final gallery must use a new send'),
        delete: async () => { progressDeleted = true; } };
    }
    return send(payload);
  };
  await f.run({ prepareEromeMedia: async () => { await delay(1600); return media; } });
  assert.deepEqual(f.errors, []);
  assert.equal(f.sends.length, 2);
  assert.deepEqual(f.sends[0].allowedMentions, { parse: [], repliedUser: false });
  assert.notEqual(f.sends[0].nonce, f.sends[1].nonce);
  assert.equal(f.sends[1].nonce, f.source.id);
  assert.deepEqual(f.sends[1].allowedMentions, mentions);
  assert.equal(f.sends[1].flags, MessageFlags.IsComponentsV2 | MessageFlags.SuppressNotifications);
  assert(f.events.includes('delete original'));
  assert(progressDeleted);
  assert(!f.events.includes('delete preview'));
});

test('hosted Replace requires Manage Messages before preparation while Reply does not', async () => {
  for (const mode of ['reply', 'replace'] as const) {
    const f = fixture();
    f.preferences({ mode, eromeChannels: 'all' });
    f.source.channel.permissionsFor = () => new PermissionsBitField(PermissionsBitField.All &
      ~PermissionFlagsBits.Administrator & ~PermissionFlagsBits.ManageMessages);
    await f.run();
    assert.deepEqual(f.errors, []);
    assert.equal(f.sends.length, mode === 'reply' ? 1 : 0);
    assert(!f.events.includes('delete original'));
  }
});

test('a failed final control edit after Replace keeps the sole gallery and its asset binding', async () => {
  const f = fixture();
  f.replacement.edit = async () => { throw Error('Lost edit response'); };
  await f.run();
  assert(f.events.includes('delete original'));
  assert(!f.events.includes('delete preview') && !f.events.includes('release'));
});

test('a lost hosted Replace send response reconciles the exact nonce without a reply reference', async () => {
  const f = fixture(), send = f.source.channel.send;
  Object.assign(f.source.channel, { messages: { fetch: async () => new Collection([
    ['unrelated', { ...f.replacement, id: 'unrelated', nonce: 'another-source' } as unknown as Message],
    [f.replacement.id, Object.assign(f.replacement, { nonce: f.source.id }) as unknown as Message],
  ]) } });
  f.source.channel.send = async payload => {
    await send(payload);
    throw Error('Response lost after Discord accepted the message');
  };
  await f.run();
  assert.deepEqual(f.errors, []);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].reply, undefined);
  assert(f.events.includes('bind') && f.events.includes('delete original'));
  assert(!f.events.includes('delete preview'));
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
