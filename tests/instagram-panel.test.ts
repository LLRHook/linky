import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, test } from 'node:test';
import { Client, ComponentType, Events, MessageFlags, PermissionFlagsBits, PermissionsBitField,
  type APIMessageTopLevelComponent, type ChatInputCommandInteraction, type Message, type MessageCreateOptions } from 'discord.js';
import { execute } from '../src/commands/fix';
import type { Config } from '../src/config';
import { addInstagramCaptions, instagramPanelComponents, type InstagramPanel } from '../src/services/InstagramPresentation';
import type { InstagramTranslation } from '../src/services/InstagramTranslation';
import type { RepostRecord } from '../src/services/RepostRegistry';
import { createLinkRepostHandler } from '../src/services/SocialLinkService';
import { panelMediaReady } from '../src/services/TweetPanel';
import { botMessage, commandInteraction, createForbidden, repostSource, sendableChannel, type InteractionEvent } from './support/discord';

const BOT = '1491240385031311470', CHANNEL = '123456789012345678', SHARER = '777777777777777777';
// The reported post: a Japanese caption over one video.
const CODE = 'DgFdAX5zFPq';
const SOURCE = `https://www.instagram.com/p/${CODE}/`;
const VIDEO = `https://oginstagram.com/offload/${CODE}/1?v=2&kid=vultr1&exp=1798041600&sig=XCHldYu82E`;
const PHOTO = `https://oginstagram.com/offload/${CODE}/2?v=2&kid=vultr1&exp=1798041600&sig=Photo`;
const POST: InstagramTranslation = { sourceUrl: SOURCE, shortcode: CODE, username: 'clip.fun0007',
  text: "Since his debut in 1962, Victor von Doom has reigned as Marvel's most powerful villain!",
  languages: ['ja'], mediaOnlyUrl: `https://g.oginstagram.com/p/${CODE}/`, mediaTypes: ['GraphVideo'],
  media: [{ type: 'video', url: VIDEO, width: 720, height: 1280 }] };
const PANEL: InstagramPanel = { post: POST, media: POST.media!, captionLimit: 300 };

const forbidden = createForbidden();
afterEach(() => forbidden.assertNone());

type Component = { type: number; content?: string; components?: Component[]; items?: { media: Record<string, unknown> }[];
  accent_color?: number };

/** Gallery items as Discord reports them once fetched. */
function loaded(components: readonly unknown[]): unknown[] {
  const fill = (component: Component): Component => component.type === ComponentType.MediaGallery
    ? { ...component, items: component.items!.map(item => ({ ...item, media: { ...item.media, proxy_url: 'https://media.discordapp.net/x',
      loading_state: 2, content_type: String(item.media.url).includes('/1?') ? 'video/mp4' : 'image/jpeg' } })) }
    : component.type === ComponentType.Container ? { ...component, components: component.components!.map(fill) } : component;
  return (components as Component[]).map(fill);
}

const texts = (components: readonly unknown[]): string[] => (components as Component[]).flatMap(component =>
  component.type === ComponentType.TextDisplay ? [component.content!]
    : component.components ? texts(component.components) : []);
const galleries = (components: readonly unknown[]): Component[] => (components as Component[]).flatMap(component =>
  component.type === ComponentType.MediaGallery ? [component] : component.components ? galleries(component.components) : []);

test('a translated post becomes one block with its author, English caption, language label and media', () => {
  const block = instagramPanelComponents({ ...PANEL, media: [...PANEL.media, { type: 'photo', url: PHOTO }] },
    '> **Shared by <@1>**') as unknown as Component[];
  assert.equal(block.length, 2);
  assert.deepEqual(block[0], { type: ComponentType.TextDisplay, content: '> **Shared by <@1>**' });
  const [container] = block.slice(1);
  assert.equal(container.type, ComponentType.Container);
  const [text, gallery] = container.components!;
  assert.equal(text.content, '**[@clip.fun0007](<https://www.instagram.com/clip.fun0007/>)**\n' +
    "Since his debut in 1962, Victor von Doom has reigned as Marvel's most powerful villain!\n-# Translated from Japanese");
  assert.deepEqual(gallery, { type: ComponentType.MediaGallery, items: [
    { media: { url: VIDEO }, description: 'Video from the post.' }, { media: { url: PHOTO }, description: 'Photo from the post.' }] });
  // The block is the whole post: no provider link may unfurl a second card beside it.
  assert.doesNotMatch(JSON.stringify(block), /g\.oginstagram\.com\/p\//);
});

test('the block escapes the username, applies the caption limit and abstains when the gallery cannot fit', () => {
  const block = instagramPanelComponents({ ...PANEL, post: { ...POST, username: 'a_b_c', text: 'x '.repeat(400) }, captionLimit: 120 }, '');
  assert.equal(block!.length, 1, 'no lead without one');
  const [text] = texts(block!);
  assert.match(text, /^\*\*\[@a\\_b\\_c\]\(<https:\/\/www\.instagram\.com\/a_b_c\/>\)\*\*\n/);
  assert(text.split('\n')[1].length <= 120);
  assert.equal(instagramPanelComponents({ ...PANEL, media: [] }, ''), null);
  assert.equal(instagramPanelComponents({ ...PANEL, media: Array.from({ length: 11 }, () => PANEL.media[0]) }, ''), null);
  assert.equal(instagramPanelComponents(PANEL, 'y'.repeat(4000)), null);
});

test('without its media the block keeps the caption and states that the original stays', () => {
  const block = instagramPanelComponents(PANEL, 'lead', { unavailable: 'Media unavailable.' })!;
  assert.equal(galleries(block).length, 0);
  assert.match(texts(block)[1], /Victor von Doom[^]*\n-# Translated from Japanese\n-# Media unavailable\.$/);
});

test('captions offer a block only for one linked post whose every item has a provider address', async () => {
  const lookup = (post: InstagramTranslation) => async () => post;
  const fixed = `https://oginstagram.com/p/${CODE}/`;
  assert.deepEqual((await addInstagramCaptions(SOURCE, { content: fixed }, lookup(POST), 1900)).instagramPanel, PANEL);
  assert.equal((await addInstagramCaptions(SOURCE, { content: fixed }, lookup(POST), 1900, 'compact')).instagramPanel?.captionLimit, 120);
  // The caption path remains complete beside the block offer.
  assert.match((await addInstagramCaptions(SOURCE, { content: fixed }, lookup(POST), 1900)).content, /^https:\/\/g\.oginstagram\.com\/p\/DgFdAX5zFPq\/\n\n/);
  const { media: _media, ...unaddressed } = POST;
  assert.equal((await addInstagramCaptions(SOURCE, { content: fixed }, lookup(unaddressed), 1900)).instagramPanel, undefined);
  assert.equal((await addInstagramCaptions(`${SOURCE} https://x.com/a/status/1`, { content: `${fixed} https://fixupx.com/a/status/1` },
    lookup(POST), 1900)).instagramPanel, undefined, 'another link keeps the caption path');
  const eleven = { ...POST, media: Array.from({ length: 11 }, () => POST.media![0]) };
  assert.equal((await addInstagramCaptions(SOURCE, { content: fixed }, lookup(eleven), 1900)).instagramPanel, undefined);
  assert.equal((await addInstagramCaptions(SOURCE, { content: fixed }, async () => assert.fail('Media-first has no caption lookup'),
    1900, 'media-first')).instagramPanel, undefined);
});

test('panel readiness accepts Instagram media only once Discord fetched each item as its kind', () => {
  const block = instagramPanelComponents(PANEL, '')!;
  assert.equal(panelMediaReady({ components: block }, PANEL.media), false);
  assert.equal(panelMediaReady({ components: loaded(block) }, PANEL.media), true);
});

function automatic({ ready = true } = {}) {
  const client = new Client({ intents: [] }); Object.assign(client, { user: { id: BOT } });
  const events: string[] = [], sends: MessageCreateOptions[] = [], edits: { components?: unknown[] }[] = [], logs: unknown[][] = [];
  const records: RepostRecord[] = [];
  let components: APIMessageTopLevelComponent[] = [];
  const replacement = botMessage({
    id: '123456789012345680', channelId: CHANNEL, author: { id: BOT },
    get components() { return components.map(component => ({ toJSON: () => component })); },
    fetch: async () => replacement,
    edit: async (payload: { components: APIMessageTopLevelComponent[] }) => {
      events.push('edit'); edits.push(payload); components = payload.components; return replacement;
    },
    delete: async () => { events.push('delete replacement'); },
  });
  const source = repostSource({
    id: '123456789012345679', channelId: CHANNEL, guildId: '987654321098765432', client,
    content: `Look ${SOURCE}`, author: { id: SHARER, bot: false },
    guild: { members: { me: { id: BOT } }, premiumTier: 0 },
    fetchReference: forbidden.forbid('A source without a reply reference must not look one up'),
    channel: sendableChannel({
      send: async (payload: MessageCreateOptions) => {
        events.push('send'); sends.push(payload);
        components = (payload.components ?? []).map(component => 'toJSON' in component ? component.toJSON() : component) as APIMessageTopLevelComponent[];
        if (ready) client.emit(Events.Raw, { t: 'MESSAGE_UPDATE', d: { id: replacement.id, channel_id: CHANNEL, author: { id: BOT }, components: loaded(components) } });
        else events.push('unconfirmed');
        return replacement;
      },
    }),
    delete: async () => { events.push('delete original'); },
  });
  const run = async () => {
    const handler = createLinkRepostHandler([CHANNEL], { info: (...args: unknown[]) => logs.push(args),
      warn: (...args: unknown[]) => logs.push(args), error: (...args: unknown[]) => logs.push(args) }, undefined, {
      platforms: ['instagram'], translateInstagram: async () => POST,
      rememberRepost: async record => { events.push('ownership'); records.push(record); return true; },
      verifyPreview: forbidden.forbid('A block carries its own media; no native card is checked'),
    });
    try { await handler(source as unknown as Message); } finally { await client.destroy(); }
  };
  return { client, events, sends, edits, logs, records, run };
}

test('automatic repost of a translated Instagram post sends one confirmed block and keeps it with Remove', async () => {
  const f = automatic();
  await f.run();
  assert.deepEqual(f.events, ['send', 'ownership', 'delete original', 'edit']);
  const [sent] = f.sends;
  assert.equal(sent.flags, MessageFlags.IsComponentsV2);
  assert.equal(sent.content, undefined);
  assert.equal(sent.embeds, undefined);
  const published = (sent.components ?? []).map(component => 'toJSON' in component ? component.toJSON() : component);
  const shown = texts(published);
  assert.equal(shown[0], `> **Shared by <@${SHARER}>**\nLook`);
  assert.equal(shown.filter(text => text.includes('@clip.fun0007')).length, 1, 'the author appears once');
  assert.equal(published.filter(component => component.type === ComponentType.Container).length, 1, 'the post appears once');
  assert.deepEqual(galleries(published)[0].items!.map(item => item.media.url), [VIDEO]);
  assert.doesNotMatch(JSON.stringify(published), /g\.oginstagram\.com\/p\/|linky:remove"/);
  assert.match(JSON.stringify(published), /"url":"https:\/\/www\.instagram\.com\/p\/DgFdAX5zFPq\/"/, 'Original post button');
  const final = f.edits.at(-1)!.components as Component[];
  assert.equal(galleries(final).length, 1, 'the controls edit keeps the block');
  assert.match(JSON.stringify(final), /linky:remove/);
  assert.equal(f.records[0].mode, 'replace');
  assert(f.logs.some(entry => entry.includes('Translated post block media confirmed; client playback not checked')));
  assert.equal(f.client.listenerCount(Events.Raw), 0);
});

test('automatic repost keeps the original and a tracked English caption when Discord never loads the media', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = automatic({ ready: false });
  const pending = f.run();
  for (let turn = 0; turn < 50 && !f.events.includes('unconfirmed'); turn++) await new Promise(resolve => setImmediate(resolve));
  for (let turn = 0; turn < 20; turn++) { t.mock.timers.tick(10_000); await new Promise(resolve => setImmediate(resolve)); }
  await pending;
  assert(!f.events.includes('delete original'), 'the source stays when the media is unconfirmed');
  assert(!f.events.includes('delete replacement'), 'the English caption stays');
  assert.equal(f.records[0].mode, 'reply');
  const [fallback, final] = f.edits.map(edit => edit.components!);
  for (const components of [fallback, final]) {
    assert.equal(galleries(components).length, 0, 'no gallery is left without its media');
    assert(texts(components).some(text => text.includes('Victor von Doom') &&
      text.endsWith('-# Instagram preview could not be verified; the original post is still here.')));
  }
  assert.match(JSON.stringify(final), /linky:remove/);
  assert(f.logs.some(entry => entry.includes('Translated Instagram caption delivered; kept original because preview could not be verified')));
  assert.equal(f.client.listenerCount(Events.Raw), 0);
});

const config: Config = { discordToken: '', channelIds: [], serverIds: [], rewritePlatforms: ['instagram'],
  translateTweets: true, settingsPath: 'unused' };
type Payload = { flags?: number; content?: string | null; components?: APIMessageTopLevelComponent[]; embeds?: unknown[] };

function manual({ ready = true } = {}) {
  const events: InteractionEvent<Payload>[] = [];
  const client = Object.assign(new EventEmitter(), { user: { id: BOT } });
  const response = { id: '333333333333333333', channelId: 'channel', author: { id: BOT },
    components: [] as { toJSON(): unknown }[], fetch: async () => response as unknown as Message };
  const input = commandInteraction(events, {
    isChatInputCommand: () => true, guildId: 'guild', channelId: 'channel', user: { id: SHARER }, client,
    channel: { isThread: () => false, messages: { fetch: forbidden.forbid('Explicit fixing must not fetch chat history') } },
    appPermissions: new PermissionsBitField(PermissionFlagsBits.AttachFiles),
    memberPermissions: new PermissionsBitField(PermissionFlagsBits.SendMessages), attachmentSizeLimit: 10 * 1024 * 1024,
    options: { getString: () => SOURCE },
    editReply: async (payload: Payload) => {
      events.push({ name: 'edit', payload });
      if (payload.components) {
        response.components = payload.components.map(component => ({ toJSON: () => component }));
        if (ready && payload.flags === MessageFlags.IsComponentsV2) client.emit(Events.Raw, { t: 'MESSAGE_UPDATE',
          d: { id: response.id, channel_id: 'channel', author: { id: BOT }, components: loaded(payload.components) } });
      }
      return response as unknown as Message;
    },
    fetchReply: async () => { events.push({ name: 'fetch-reply' }); return response as unknown as Message; },
  });
  return { events, client, interaction: input as unknown as ChatInputCommandInteraction };
}

test('/fix of a translated Instagram post publishes one confirmed block with Original post and Remove', async () => {
  const f = manual(), outcomes: unknown[] = [];
  await execute(f.interaction, config, { translateInstagram: async () => POST,
    verifyPreview: forbidden.forbid('A block carries its own media; no native card is checked'),
    observePreview: (_expected, result) => outcomes.push(result.ok) });
  const edits = f.events.filter(event => event.name === 'edit').map(event => event.payload!);
  const published = edits.find(edit => edit.flags === MessageFlags.IsComponentsV2)!;
  assert.equal(published.content, null);
  assert.deepEqual(published.embeds, []);
  assert.equal(published.components!.filter(component => component.type === ComponentType.Container).length, 1);
  assert(texts(published.components!).some(text => text.includes('Victor von Doom') && text.includes('Translated from Japanese')));
  assert.doesNotMatch(JSON.stringify(edits), /g\.oginstagram\.com\/p\//);
  const last = JSON.stringify(edits.at(-1));
  assert.match(last, /linky:remove-manual/);
  assert.match(last, /"type":17/, 'the final controls edit keeps the block');
  assert.deepEqual(outcomes, [true]);
  assert.equal(f.client.listenerCount(Events.Raw), 0);
});

test('/fix keeps the original available when the Instagram media is never confirmed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = manual({ ready: false }), outcomes: unknown[] = [];
  const pending = execute(f.interaction, config, { translateInstagram: async () => POST,
    verifyPreview: forbidden.forbid('A block carries its own media; no native card is checked'),
    observePreview: (_expected, result) => outcomes.push(result.ok) });
  for (let turn = 0; turn < 40; turn++) { t.mock.timers.tick(1_000); await new Promise(resolve => setImmediate(resolve)); }
  await pending;
  assert(f.events.some(event => event.name === 'fetch-reply'), 'the reply is read again after the Gateway wait');
  const last = f.events.filter(event => event.name === 'edit').at(-1)!.payload!;
  assert.match(String(last.components?.[0] && 'content' in last.components[0] ? last.components[0].content : ''), /could not be confirmed/);
  assert.match(JSON.stringify(last), /"url":"https:\/\/www\.instagram\.com\/p\/DgFdAX5zFPq\/"/);
  assert.deepEqual(outcomes, [false]);
  assert.equal(f.client.listenerCount(Events.Raw), 0);
});
