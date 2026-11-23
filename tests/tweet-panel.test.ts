import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, test } from 'node:test';
import { Client, ComponentType, Events, MessageFlags, PermissionFlagsBits, PermissionsBitField,
  type APIMessageTopLevelComponent, type ChatInputCommandInteraction, type Message, type MessageCreateOptions } from 'discord.js';
import { execute } from '../src/commands/fix';
import type { Config } from '../src/config';
import { createLinkRepostHandler } from '../src/services/SocialLinkService';
import { panelLead, tweetPanelComponents, tweetPanelMedia, tweetPanelReady } from '../src/services/TweetPanel';
import { translateRepost } from '../src/services/TweetPresentation';
import type { TweetMedia, TweetTranslation } from '../src/services/TweetTranslation';
import { botMessage, commandInteraction, createForbidden, repostSource, sendableChannel, type InteractionEvent } from './support/discord';

const BOT = '1491240385031311470', CHANNEL = '123456789012345678', SHARER = '777777777777777777';
const SOURCE = 'https://x.com/ArcoCunnivoro/status/2124451245704261749';
const VIDEO = 'https://video.twimg.com/amplify_video/2124369/vid/avc1/720x1280/clip.mp4?tag=14';
const PHOTO = 'https://pbs.twimg.com/media/GxPhoto.jpg';
const AVATAR = 'https://pbs.twimg.com/profile_images/1/avatar_normal.jpg';

// The reported shape: an English post without media quoting a Chinese post with a video and a photo.
const QUOTED: TweetTranslation = {
  text: 'The translated quote.', language: 'Chinese', url: 'https://x.com/pokgaii/status/2124369266476790267',
  author: { name: 'Pokgai', url: 'https://x.com/pokgaii', handle: 'pokgaii' }, photos: [PHOTO],
  media: [{ type: 'video', url: VIDEO, width: 720, height: 1280 }, { type: 'photo', url: PHOTO }],
  hasMedia: true, hasVideo: true,
};
const TWEET: TweetTranslation = {
  text: 'The outer post.', language: 'English', url: SOURCE,
  author: { name: 'Arco', url: 'https://x.com/ArcoCunnivoro', icon_url: AVATAR, handle: 'ArcoCunnivoro' },
  photos: [], media: [], hasMedia: false, hasVideo: false, quote: QUOTED,
};

const forbidden = createForbidden();
afterEach(() => forbidden.assertNone());

type Component = { type: number; content?: string; components?: Component[]; items?: { media: Record<string, unknown> }[];
  accessory?: { media: { url: string } }; accent_color?: number };

/** Gallery items as Discord reports them once fetched; `kind` overrides the content type of every item. */
function loaded(components: readonly unknown[], kind?: string): unknown[] {
  const fill = (component: Component): Component => component.type === ComponentType.MediaGallery
    ? { ...component, items: component.items!.map(item => ({ ...item, media: { ...item.media, proxy_url: 'https://media.discordapp.net/x',
      loading_state: 2, content_type: kind ?? (String(item.media.url).startsWith('https://video.') ? 'video/mp4' : 'image/jpeg') } })) }
    : component.type === ComponentType.Container ? { ...component, components: component.components!.map(fill) } : component;
  return (components as Component[]).map(fill);
}

const texts = (components: readonly unknown[]): string[] => (components as Component[]).flatMap(component =>
  component.type === ComponentType.TextDisplay ? [component.content!]
    : component.components ? texts(component.components) : []);

test('a quoted video post becomes one block with its author, translated text and every media item', () => {
  const block = tweetPanelComponents(TWEET, '> **Shared by <@1>**') as unknown as Component[];
  assert(block);
  assert.equal(block.length, 2);
  assert.deepEqual(block[0], { type: ComponentType.TextDisplay, content: '> **Shared by <@1>**' });
  const container = block[1];
  assert.equal(container.type, ComponentType.Container);
  assert.equal(container.accent_color, 0x637dff);
  const [section, quote, gallery] = container.components!;
  assert.equal(section.type, ComponentType.Section);
  assert.equal(section.accessory!.media.url, AVATAR);
  assert.equal(section.components![0].content, '**Arco** [@ArcoCunnivoro](<https://x.com/ArcoCunnivoro/status/2124451245704261749>)\nThe outer post.');
  assert.equal(quote.content, '> Quoting **Pokgai** [@pokgaii](<https://x.com/pokgaii/status/2124369266476790267>)\n' +
    '> The translated quote.\n> -# Translated from Chinese');
  assert.deepEqual(gallery, { type: ComponentType.MediaGallery, items: [
    { media: { url: VIDEO }, description: 'Video from the post.' }, { media: { url: PHOTO }, description: 'Photo from the post.' }] });
  // The block is the whole post: no rewritten link may unfurl a second card beside it.
  assert.doesNotMatch(JSON.stringify(block), /fixupx|vxtwitter|fxtwitter/);
});

test('the block escapes author Markdown, omits off-host avatars and has no lead without one', () => {
  const tweet = { ...TWEET, author: { name: 'A *bold* [name]', url: 'https://x.com/a_b', handle: 'a_b', icon_url: 'https://evil.example/a.jpg' } };
  const block = tweetPanelComponents(tweet, '') as unknown as Component[];
  assert.equal(block.length, 1);
  const [first] = block[0].components!;
  assert.equal(first.type, ComponentType.TextDisplay, 'an avatar outside pbs.twimg.com is not shown');
  assert.equal(first.content!.split('\n')[0], `**A \\*bold\\* \\[name\\]** [@a\\_b](<${SOURCE}>)`);
});

test('the block abstains when its text exceeds the 4000-character component limit', () => {
  const text = 'x'.repeat(3_800);
  assert(tweetPanelComponents({ ...TWEET, text: 'x'.repeat(3_000) }, ''));
  assert.equal(tweetPanelComponents({ ...TWEET, text }, 'y'.repeat(200)), null);
});

test('panel media uses only X media hosts, every media-bearing part and at most one gallery', () => {
  assert.deepEqual(tweetPanelMedia(TWEET)?.map(item => item.url), [VIDEO, PHOTO]);
  const swap = (media: TweetMedia[]) => ({ ...TWEET, quote: { ...QUOTED, media } });
  assert.equal(tweetPanelMedia(swap([{ type: 'video', url: 'https://video.example/clip.mp4' }])), null);
  assert.equal(tweetPanelMedia(swap([{ type: 'photo', url: VIDEO }])), null, 'a photo must come from pbs.twimg.com');
  assert.equal(tweetPanelMedia(swap([{ type: 'video', url: 'http://video.twimg.com/clip.mp4' }])), null);
  assert.equal(tweetPanelMedia(swap([{ type: 'video', url: 'https://video.twimg.com:8443/clip.mp4' }])), null);
  assert.equal(tweetPanelMedia({ ...TWEET, quote: { ...QUOTED, media: undefined } }), null, 'hand-built values without media keep the old path');
  assert.equal(tweetPanelMedia(swap(Array.from({ length: 11 }, (_, index) => ({ type: 'photo' as const, url: `https://pbs.twimg.com/media/${index}.jpg` })))), null);
  assert.deepEqual(tweetPanelMedia({ ...TWEET, media: [{ type: 'photo', url: PHOTO }], hasMedia: true })?.map(item => item.url), [PHOTO, VIDEO],
    'a photo repeated in the quote appears once');
});

test('panel readiness requires every item fetched as its kind, in a container or at the top level', () => {
  const block = tweetPanelComponents(TWEET, '')!;
  const media = tweetPanelMedia(TWEET)!;
  assert.equal(tweetPanelReady({ components: block }, media), false, 'unfetched items carry no proxy address');
  assert.equal(tweetPanelReady({ components: loaded(block) }, media), true);
  assert.equal(tweetPanelReady({ components: loaded(block, 'text/html') }, media), false);
  assert.equal(tweetPanelReady({ components: loaded(block, 'image/jpeg') }, media), false, 'a video must load as video');
  const loading = JSON.parse(JSON.stringify(loaded(block)).replace('"loading_state":2', '"loading_state":1'));
  assert.equal(tweetPanelReady({ components: loading }, media), false);
  const gallery = (loaded(block) as Component[])[0].components!.at(-1)!;
  assert.equal(tweetPanelReady({ components: [gallery] }, media), true);
  assert.equal(tweetPanelReady({ components: [{ ...gallery, items: gallery.items!.slice(1) }] }, media), false, 'every item is required');
  assert.equal(tweetPanelReady({ components: loaded(block) }, []), false);
});

test('the lead keeps the sharer words without the post link', () => {
  assert.equal(panelLead(SOURCE), '');
  assert.equal(panelLead(`Look ${SOURCE}`), 'Look');
  assert.equal(panelLead(`Look at ${SOURCE} wow`), 'Look at wow');
  assert.equal(panelLead(`${SOURCE}\n\n\n\nso good`), 'so good');
  assert.equal(panelLead(`See ${SOURCE}.`), 'See');
  assert.equal(panelLead(`Read [this](${SOURCE}) now`), 'Read now');
});

test('translation offers a block only for one video post whose media all comes from X', async () => {
  const lookup = (tweet: TweetTranslation) => async () => tweet;
  const offered = await translateRepost(`Look ${SOURCE}`, ['x'], lookup(TWEET), 2000);
  assert.deepEqual(offered?.panel, { tweet: TWEET, media: tweetPanelMedia(TWEET), source: SOURCE.replace('x.com', 'fixupx.com') });
  const photoOnly = { ...TWEET, quote: { ...QUOTED, hasVideo: false, media: [{ type: 'photo' as const, url: PHOTO }] } };
  assert.equal((await translateRepost(SOURCE, ['x'], lookup(photoOnly), 2000))?.panel, undefined, 'photo posts keep the translated card');
  assert.equal((await translateRepost(`${SOURCE} https://x.com/b/status/3`, ['x'], lookup(TWEET), 2000))?.panel, undefined);
  assert.equal((await translateRepost(SOURCE, ['x'], lookup({ ...TWEET, quote: { ...QUOTED, media: undefined } }), 2000))?.panel, undefined);
});

function automatic({ ready = true } = {}) {
  const client = new Client({ intents: [] }); Object.assign(client, { user: { id: BOT } });
  const events: string[] = [], sends: MessageCreateOptions[] = [], edits: { components?: unknown[] }[] = [], logs: unknown[][] = [];
  let components: APIMessageTopLevelComponent[] = [];
  const replacement = botMessage({
    id: '123456789012345680', channelId: CHANNEL, author: { id: BOT },
    get components() { return components.map(component => ({ toJSON: () => component })); },
    fetch: async () => replacement,
    edit: async (payload: { components: APIMessageTopLevelComponent[] }) => {
      events.push('controls'); edits.push(payload); components = payload.components; return replacement;
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
        else if (components.length) events.push('unconfirmed');
        return replacement;
      },
    }),
    delete: async () => { events.push('delete original'); },
  });
  const run = async () => {
    const handler = createLinkRepostHandler([CHANNEL], { info: (...args: unknown[]) => logs.push(args),
      warn: (...args: unknown[]) => logs.push(args), error: (...args: unknown[]) => logs.push(args) }, undefined, {
      platforms: ['x'], translateTweet: async () => TWEET, rememberRepost: async () => { events.push('ownership'); return true; },
      verifyPreview: forbidden.forbid('A block carries its own media; no native card is checked'),
    });
    try { await handler(source as unknown as Message); } finally { await client.destroy(); }
  };
  return { client, events, sends, edits, logs, replacement, run };
}

test('automatic repost of a translated video post sends one confirmed block and keeps it with Remove', async () => {
  const f = automatic();
  await f.run();
  assert.deepEqual(f.events, ['send', 'ownership', 'delete original', 'controls']);
  const [sent] = f.sends;
  assert.equal(sent.flags, MessageFlags.IsComponentsV2);
  assert.equal(sent.content, undefined);
  assert.equal(sent.embeds, undefined);
  const published = (sent.components ?? []).map(component => 'toJSON' in component ? component.toJSON() : component);
  const shown = texts(published);
  assert.equal(shown[0], `> **Shared by <@${SHARER}>**\nLook`);
  assert(shown.some(text => text.includes('The translated quote.')));
  assert.equal(published.filter(component => component.type === ComponentType.Container).length, 1, 'the post appears once');
  assert.doesNotMatch(JSON.stringify(published), /fixupx|vxtwitter|linky:remove"/);
  assert.match(JSON.stringify(published), /"url":"https:\/\/x\.com\/ArcoCunnivoro\/status\/2124451245704261749"/, 'Original post button');
  const final = f.edits.at(-1)!.components as Component[];
  assert(final.some(component => component.type === ComponentType.Container), 'the controls edit keeps the block');
  assert.match(JSON.stringify(final), /linky:remove/);
  assert(f.logs.some(entry => entry.includes('Translated post block media confirmed; client playback not checked')));
  assert.equal(f.client.listenerCount(Events.Raw), 0);
});

test('automatic repost keeps the original when Discord never loads the block media', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = automatic({ ready: false });
  const pending = f.run();
  for (let turn = 0; turn < 50 && !f.events.includes('unconfirmed'); turn++) await new Promise(resolve => setImmediate(resolve));
  for (let turn = 0; turn < 20; turn++) { t.mock.timers.tick(10_000); await new Promise(resolve => setImmediate(resolve)); }
  await pending;
  assert(f.events.includes('delete replacement'));
  assert(!f.events.includes('delete original'), 'the source stays when the block is unconfirmed');
  assert(f.logs.some(entry => entry.includes('Keeping original: no useful preview appeared')));
  assert.equal(f.client.listenerCount(Events.Raw), 0);
});

const config: Config = { discordToken: '', channelIds: [], serverIds: [], rewritePlatforms: ['x'],
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

test('/fix of a translated video post publishes one confirmed block with Original post and Remove', async () => {
  const f = manual(), outcomes: unknown[] = [];
  await execute(f.interaction, config, { translateTweet: async () => TWEET,
    verifyPreview: forbidden.forbid('A block carries its own media; no native card is checked'),
    observePreview: (_expected, result) => outcomes.push(result.ok) });
  const edits = f.events.filter(event => event.name === 'edit').map(event => event.payload!);
  const published = edits.find(edit => edit.flags === MessageFlags.IsComponentsV2)!;
  assert.equal(published.content, null);
  assert.deepEqual(published.embeds, []);
  assert.equal(published.components!.filter(component => component.type === ComponentType.Container).length, 1);
  assert(texts(published.components!).some(text => text.includes('The translated quote.')));
  assert.doesNotMatch(JSON.stringify(edits), /fixupx|vxtwitter/);
  const last = JSON.stringify(edits.at(-1));
  assert.match(last, /linky:remove-manual/);
  assert.match(last, /"type":17/, 'the final controls edit keeps the block');
  assert.deepEqual(outcomes, [true]);
  assert.equal(f.client.listenerCount(Events.Raw), 0);
});

test('/fix keeps the original available when the block media is never confirmed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = manual({ ready: false }), outcomes: unknown[] = [];
  const pending = execute(f.interaction, config, { translateTweet: async () => TWEET,
    verifyPreview: forbidden.forbid('A block carries its own media; no native card is checked'),
    observePreview: (_expected, result) => outcomes.push(result.ok) });
  for (let turn = 0; turn < 40; turn++) { t.mock.timers.tick(1_000); await new Promise(resolve => setImmediate(resolve)); }
  await pending;
  assert(f.events.some(event => event.name === 'fetch-reply'), 'the reply is read again after the Gateway wait');
  const last = f.events.filter(event => event.name === 'edit').at(-1)!.payload!;
  assert.match(String(last.components?.[0] && 'content' in last.components[0] ? last.components[0].content : ''), /could not be confirmed/);
  assert.match(JSON.stringify(last), /"url":"https:\/\/x\.com\/ArcoCunnivoro\/status\/2124451245704261749"/);
  assert.deepEqual(outcomes, [false]);
  assert.equal(f.client.listenerCount(Events.Raw), 0);
});
