import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, test, type TestContext } from 'node:test';
import { Client, ComponentType, Events, MessageFlags, PermissionFlagsBits, PermissionsBitField,
  type APIMessageTopLevelComponent, type ChatInputCommandInteraction, type Message, type MessageCreateOptions } from 'discord.js';
import { execute } from '../src/commands/fix';
import type { Config } from '../src/config';
import { createLinkRepostHandler } from '../src/services/SocialLinkService';
import { panelLead, tweetPanelComponents, tweetPanelMedia, panelMediaReady } from '../src/services/TweetPanel';
import type { ExpectedPreview, PreviewResult } from '../src/services/PreviewRecovery';
import { tweetPostPanel } from '../src/services/TweetPresentation';
import type { TweetLookup, TweetMedia, TweetTranslation } from '../src/services/TweetTranslation';
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
  assert.equal(tweetPanelMedia(swap([{ type: 'video', url: 'https://video.twimg.com/amplify_video/1/pl/playlist.m3u8?tag=14' }])), null,
    'an HLS playlist is not a file the gallery can play');
  assert.equal(tweetPanelMedia(swap([{ type: 'gif', url: 'https://video.twimg.com/tweet_video/clip.m3u8' }])), null);
  assert.deepEqual(tweetPanelMedia(swap([{ type: 'gif', url: 'https://video.twimg.com/tweet_video/clip.mp4' }]))?.map(item => item.type), ['gif']);
  assert.equal(tweetPanelMedia({ ...TWEET, quote: { ...QUOTED, media: undefined } }), null, 'hand-built values without media keep the old path');
  assert.equal(tweetPanelMedia(swap(Array.from({ length: 11 }, (_, index) => ({ type: 'photo' as const, url: `https://pbs.twimg.com/media/${index}.jpg` })))), null);
  assert.deepEqual(tweetPanelMedia({ ...TWEET, media: [{ type: 'photo', url: PHOTO }], hasMedia: true })?.map(item => item.url), [PHOTO, VIDEO],
    'a photo repeated in the quote appears once');
});

test('panel readiness requires every item fetched as its kind, in a container or at the top level', () => {
  const block = tweetPanelComponents(TWEET, '')!;
  const media = tweetPanelMedia(TWEET)!;
  assert.equal(panelMediaReady({ components: block }, media), false, 'unfetched items carry no proxy address');
  assert.equal(panelMediaReady({ components: loaded(block) }, media), true);
  assert.equal(panelMediaReady({ components: loaded(block, 'text/html') }, media), false);
  assert.equal(panelMediaReady({ components: loaded(block, 'image/jpeg') }, media), false, 'a video must load as video');
  const loading = JSON.parse(JSON.stringify(loaded(block)).replace('"loading_state":2', '"loading_state":1'));
  assert.equal(panelMediaReady({ components: loading }, media), false);
  const gallery = (loaded(block) as Component[])[0].components!.at(-1)!;
  assert.equal(panelMediaReady({ components: [gallery] }, media), true);
  assert.equal(panelMediaReady({ components: [{ ...gallery, items: gallery.items!.slice(1) }] }, media), false, 'every item is required');
  assert.equal(panelMediaReady({ components: loaded(block) }, []), false);
});

test('the lead keeps the sharer words without the post link', () => {
  assert.equal(panelLead(SOURCE), '');
  assert.equal(panelLead(`Look ${SOURCE}`), 'Look');
  assert.equal(panelLead(`Look at ${SOURCE} wow`), 'Look at wow');
  assert.equal(panelLead(`${SOURCE}\n\n\n\nso good`), 'so good');
  assert.equal(panelLead(`See ${SOURCE}.`), 'See');
  assert.equal(panelLead(`Read [this](${SOURCE}) now`), 'Read now');
});


// An English post with one photo of its own: the commonest shape, which used to keep the native fixupx card.
const PHOTO_POST: TweetTranslation = {
  text: 'An English photo post.', language: null, url: SOURCE,
  author: { name: 'Arco', url: 'https://x.com/ArcoCunnivoro', icon_url: AVATAR, handle: 'ArcoCunnivoro' },
  photos: [PHOTO], media: [{ type: 'photo', url: PHOTO }], hasMedia: true, hasVideo: false,
};
const TRANSLATED_PHOTO: TweetTranslation = { ...PHOTO_POST, text: 'The translated photo post.', language: 'Japanese' };

test('a lone X post with X-hosted media offers a block in any language; other messages keep today\'s path', async () => {
  const calls: { id: string; translate: boolean }[] = [];
  const lookup = (tweet: TweetTranslation | null): TweetLookup => async (id, { translate }) => { calls.push({ id, translate }); return tweet; };
  const fixed = SOURCE.replace('x.com', 'fixupx.com');
  assert.deepEqual(await tweetPostPanel(`Look ${SOURCE}`, ['x'], lookup(TWEET), true),
    { tweet: TWEET, media: tweetPanelMedia(TWEET), source: fixed });
  assert.deepEqual(await tweetPostPanel(SOURCE, ['x'], lookup(PHOTO_POST), false),
    { tweet: PHOTO_POST, media: [{ type: 'photo', url: PHOTO }], source: fixed }, 'a photo post without a video is one block too');
  assert.deepEqual(calls, [{ id: '2124451245704261749', translate: true }, { id: '2124451245704261749', translate: false }],
    'the translation setting is passed through; it never decides whether the post is looked up');
  calls.length = 0;
  const textOnly = { ...PHOTO_POST, photos: [], media: [], hasMedia: false };
  assert.equal(await tweetPostPanel(SOURCE, ['x'], lookup(textOnly), true), undefined, 'a text-only post keeps the native card');
  assert.equal(await tweetPostPanel(SOURCE, ['x'], lookup(null), true), undefined, 'a refused or failed lookup keeps the native card');
  assert.equal(await tweetPostPanel(SOURCE, ['x'], async () => { throw new Error('offline'); }, true), undefined);
  assert.equal(await tweetPostPanel(SOURCE, ['x'], lookup({ ...TWEET, quote: { ...QUOTED, media: undefined } }), true), undefined);
  calls.length = 0;
  assert.equal(await tweetPostPanel(`${SOURCE} https://x.com/b/status/3`, ['x'], lookup(TWEET), true), undefined);
  assert.equal(await tweetPostPanel(`${SOURCE} https://example.com/page`, ['x'], lookup(TWEET), true), undefined);
  assert.equal(await tweetPostPanel(`<${SOURCE}>`, ['x'], lookup(TWEET), true), undefined, 'a suppressed link stays a link');
  assert.equal(await tweetPostPanel(SOURCE, ['instagram'], lookup(TWEET), true), undefined, 'X disabled for this server');
  assert.deepEqual(calls, [], 'several links, a hidden link or a disabled platform send no lookup');
});

function automatic({ ready = true, translate = true, mode = 'replace' as 'replace' | 'reply', lookup = async () => TWEET as TweetTranslation | null,
  verifyPreview = forbidden.forbid('A block carries its own media; no native card is checked') as
    (message: Message, expected: readonly ExpectedPreview[]) => Promise<PreviewResult> } = {}) {
  const client = new Client({ intents: [] }); Object.assign(client, { user: { id: BOT } });
  const events: string[] = [], sends: MessageCreateOptions[] = [], edits: { components?: unknown[] }[] = [], logs: unknown[][] = [];
  const lookups: { id: string; translate: boolean }[] = [];
  let components: APIMessageTopLevelComponent[] = [];
  const replacement = botMessage({
    id: '123456789012345680', channelId: CHANNEL, author: { id: BOT },
    get components() { return components.map(component => ({ toJSON: () => component })); },
    fetch: async () => replacement,
    edit: async (payload: { components: APIMessageTopLevelComponent[] }) => {
      events.push('controls'); edits.push(payload); components = payload.components; return replacement;
    },
    delete: async () => { events.push('delete block'); },
  });
  // The native card that replaces an unconfirmed block is a separate message.
  const card = botMessage({
    id: '123456789012345681', channelId: CHANNEL, author: { id: BOT },
    fetch: async () => card,
    edit: async (payload: { components?: unknown[] }) => { events.push('card edit'); edits.push(payload); return card; },
    delete: async () => { events.push('delete card'); },
  });
  const source = repostSource({
    id: '123456789012345679', channelId: CHANNEL, guildId: '987654321098765432', client,
    content: `Look ${SOURCE}`, author: { id: SHARER, bot: false },
    guild: { members: { me: { id: BOT } }, premiumTier: 0 },
    fetchReference: forbidden.forbid('A source without a reply reference must not look one up'),
    channel: sendableChannel({
      send: async (payload: MessageCreateOptions) => {
        sends.push(payload);
        if (!(Number(payload.flags ?? 0) & MessageFlags.IsComponentsV2)) { events.push('send card'); return card; }
        events.push('send block');
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
      platforms: ['x'], ...(translate ? { translateTweet: async () => TWEET } : {}),
      lookupTweet: async (id, options) => { lookups.push({ id, ...options }); return lookup(); },
      rememberRepost: async () => { events.push('ownership'); return true; }, verifyPreview,
      ...(mode === 'reply' ? { serverPreferences: () => ({ mode }) } : {}),
    });
    try { await handler(source as unknown as Message); } finally { await client.destroy(); }
  };
  return { client, events, sends, edits, logs, lookups, replacement, source, run };
}

/** Let an unconfirmed block's 10 s media wait expire under mocked timers. */
async function expireBlockWait(t: TestContext, events: readonly string[], pending: Promise<unknown>) {
  for (let turn = 0; turn < 50 && !events.includes('unconfirmed'); turn++) await new Promise(resolve => setImmediate(resolve));
  for (let turn = 0; turn < 40; turn++) { t.mock.timers.tick(10_000); await new Promise(resolve => setImmediate(resolve)); }
  await pending;
}

const published = (payload: MessageCreateOptions) =>
  (payload.components ?? []).map(component => 'toJSON' in component ? component.toJSON() : component) as unknown[];

test('automatic repost of a translated video post sends one confirmed block and keeps it with Remove', async () => {
  const f = automatic();
  await f.run();
  assert.deepEqual(f.events, ['send block', 'ownership', 'delete original', 'controls']);
  assert.deepEqual(f.lookups, [{ id: '2124451245704261749', translate: true }]);
  const [sent] = f.sends;
  assert.equal(sent.flags, MessageFlags.IsComponentsV2);
  assert.equal(sent.content, undefined);
  assert.equal(sent.embeds, undefined);
  const shown = texts(published(sent));
  assert.equal(shown[0], `> **Shared by <@${SHARER}>**\nLook`);
  assert(shown.some(text => text.includes('The translated quote.')));
  assert.equal((published(sent) as Component[]).filter(component => component.type === ComponentType.Container).length, 1, 'the post appears once');
  assert.doesNotMatch(JSON.stringify(published(sent)), /fixupx|vxtwitter|linky:remove"/);
  assert.match(JSON.stringify(published(sent)), /"url":"https:\/\/x\.com\/ArcoCunnivoro\/status\/2124451245704261749"/, 'Original post button');
  const final = f.edits.at(-1)!.components as Component[];
  assert(final.some(component => component.type === ComponentType.Container), 'the controls edit keeps the block');
  assert.match(JSON.stringify(final), /linky:remove/);
  assert(f.logs.some(entry => entry.includes('Post block media confirmed; client playback not checked')));
  assert.equal(f.client.listenerCount(Events.Raw), 0);
});

test('an English photo post is one block with its own words when tweet translation is off', async () => {
  const f = automatic({ translate: false, lookup: async () => PHOTO_POST });
  await f.run();
  assert.deepEqual(f.lookups, [{ id: '2124451245704261749', translate: false }], 'the X platform alone enables the lookup');
  assert.deepEqual(f.events, ['send block', 'ownership', 'delete original', 'controls']);
  const [sent] = f.sends;
  assert.equal(sent.flags, MessageFlags.IsComponentsV2);
  assert.equal(f.sends.length, 1, 'no native card is sent beside the block');
  const shown = texts(published(sent)).join('\n');
  assert.match(shown, /An English photo post\./);
  assert.doesNotMatch(shown, /Translated from/);
  assert.match(JSON.stringify(published(sent)), /"media":\{"url":"https:\/\/pbs\.twimg\.com\/media\/GxPhoto\.jpg"\},"description":"Photo from the post\."/);
  assert.doesNotMatch(JSON.stringify(f.sends), /fixupx|vxtwitter/);
});

test('with tweet translation on, a non-English photo post shows the translation and its label in the block', async () => {
  const f = automatic({ lookup: async () => TRANSLATED_PHOTO });
  await f.run();
  assert.deepEqual(f.lookups, [{ id: '2124451245704261749', translate: true }]);
  assert.equal(f.sends.length, 1);
  const shown = texts(published(f.sends[0])).join('\n');
  assert.match(shown, /The translated photo post\.\n-# Translated from Japanese/);
  assert.doesNotMatch(JSON.stringify(f.sends), /fixupx|"embeds"/, 'the translated photo card is not sent beside the block');
});

test('text-only posts and failed lookups keep the native card', async () => {
  for (const lookup of [async () => ({ ...PHOTO_POST, photos: [], media: [], hasMedia: false }), async () => null]) {
    const f = automatic({ translate: false, lookup, verifyPreview: async (_message, expected) => ({ ok: true, missing: [], videoMetadata: false, attributed: [...expected] }) });
    await f.run();
    assert.deepEqual(f.events.slice(0, 1), ['send card']);
    assert.equal(f.sends[0].flags, undefined);
    assert.match(String(f.sends[0].content), /https:\/\/fixupx\.com\/ArcoCunnivoro\/status\/2124451245704261749/);
  }
});

test('a source with suppressed embeds is neither looked up nor shown as a block', async () => {
  const f = automatic({ translate: false, lookup: async () => PHOTO_POST });
  f.source.flags.add(MessageFlags.SuppressEmbeds);
  await f.run();
  assert.deepEqual(f.lookups, [], 'no FxTwitter request for a suppressed source');
  assert.deepEqual(f.sends, [], 'the sharer\'s suppression stands');
});

test('an unconfirmed automatic block is replaced by the native card, which is checked and kept', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const checked: string[] = [];
  const f = automatic({ ready: false, translate: false, lookup: async () => PHOTO_POST,
    verifyPreview: async (message, expected) => { checked.push(message.id); return { ok: true, missing: [], videoMetadata: false, attributed: [...expected] }; } });
  await expireBlockWait(t, f.events, f.run());
  assert.deepEqual(f.events, ['send block', 'unconfirmed', 'delete block', 'send card', 'ownership', 'delete original', 'card edit'],
    'the block is deleted before the card is sent; the two never coexist');
  const [block, card] = f.sends;
  assert.equal(card.flags, undefined, 'the card is an ordinary message, not Components V2');
  assert.equal(card.content, `> **Shared by <@${SHARER}>**\n> Look\nhttps://fixupx.com/ArcoCunnivoro/status/2124451245704261749`,
    'today\'s card: the credit, the sharer words and the fixer link');
  assert.notEqual(card.nonce, block.nonce, 'a fresh nonce: Discord would otherwise return the deleted block');
  assert.equal(card.enforceNonce, true);
  assert.deepEqual(card.allowedMentions?.users, [SHARER], 'the surviving message carries the sharer mention');
  assert.doesNotMatch(JSON.stringify(published(card)), /"type":17/);
  assert.deepEqual(checked, ['123456789012345681'], 'the card itself is verified');
  assert.doesNotMatch(JSON.stringify(f.edits.at(-1)), /"type":17/, 'the final controls are the card controls');
  assert.match(JSON.stringify(f.edits.at(-1)), /linky:remove/);
  assert(f.logs.some(entry => entry.includes('Post block media unconfirmed; published the native card instead')));
  assert(f.logs.some(entry => entry.includes('Useful Discord preview observed')));
  assert.equal(f.client.listenerCount(Events.Raw), 0);
});

test('in Reply mode an unconfirmed block is replaced by a native reply card and the original stays', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = automatic({ ready: false, translate: false, mode: 'reply', lookup: async () => PHOTO_POST,
    verifyPreview: async (_message, expected) => ({ ok: true, missing: [], videoMetadata: false, attributed: [...expected] }) });
  await expireBlockWait(t, f.events, f.run());
  assert.deepEqual(f.events.slice(0, 4), ['send block', 'unconfirmed', 'delete block', 'send card']);
  assert(!f.events.includes('delete original'), 'Reply mode never deletes the source');
  const [block, card] = f.sends;
  assert.equal(block.reply?.messageReference, '123456789012345679', 'the block replies to the source');
  assert.equal(card.reply?.messageReference, '123456789012345679', 'the card replies to the source too');
  assert.equal(card.reply?.failIfNotExists, true);
  assert.equal(card.flags, undefined);
  assert.match(String(card.content), /https:\/\/fixupx\.com\/ArcoCunnivoro\/status\/2124451245704261749/);
  assert.equal(f.sends.length, 2, 'one block, then one card; nothing else is published');
});

test('when neither the block nor the native card is confirmed, the original stays with the Retry notice', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = automatic({ ready: false, translate: false, lookup: async () => PHOTO_POST,
    verifyPreview: async (_message, expected) => ({ ok: false, missing: [...expected], videoMetadata: false }) });
  await expireBlockWait(t, f.events, f.run());
  assert(f.events.includes('delete block'));
  assert(f.events.includes('delete card'));
  assert(!f.events.includes('delete original'), 'the source stays when no preview is confirmed');
  assert(f.logs.some(entry => entry.includes('Keeping original: no useful preview appeared')));
  assert.match(String(f.sends.at(-1)?.content), /could not confirm a preview/);
  assert.equal(f.client.listenerCount(Events.Raw), 0);
});

const config: Config = { discordToken: '', channelIds: [], serverIds: [], rewritePlatforms: ['x'],
  translateTweets: true, settingsPath: 'unused' };
type Payload = { flags?: number; content?: string | null; components?: APIMessageTopLevelComponent[]; embeds?: unknown[]; message?: string };
const FOLLOW_UP = '444444444444444444';

function manual({ ready = true, send = true } = {}) {
  const events: InteractionEvent<Payload>[] = [];
  const client = Object.assign(new EventEmitter(), { user: { id: BOT } });
  const response = { id: '333333333333333333', channelId: 'channel', author: { id: BOT },
    components: [] as { toJSON(): unknown }[], embeds: [] as unknown[], fetch: async () => response as unknown as Message };
  const followUp = { ...response, id: FOLLOW_UP, fetch: async () => followUp as unknown as Message };
  const input = commandInteraction(events, {
    isChatInputCommand: () => true, guildId: 'guild', channelId: 'channel', user: { id: SHARER }, client,
    channel: { isThread: () => false, messages: { fetch: forbidden.forbid('Explicit fixing must not fetch chat history') } },
    appPermissions: new PermissionsBitField(PermissionFlagsBits.AttachFiles),
    memberPermissions: new PermissionsBitField(send ? PermissionFlagsBits.SendMessages : 0n), attachmentSizeLimit: 10 * 1024 * 1024,
    options: { getString: () => SOURCE },
    editReply: async (payload: Payload) => {
      events.push({ name: 'edit', payload });
      if (payload.message === FOLLOW_UP) return followUp as unknown as Message;
      if (payload.components) {
        response.components = payload.components.map(component => ({ toJSON: () => component }));
        if (ready && payload.flags === MessageFlags.IsComponentsV2) client.emit(Events.Raw, { t: 'MESSAGE_UPDATE',
          d: { id: response.id, channel_id: 'channel', author: { id: BOT }, components: loaded(payload.components) } });
      }
      return response as unknown as Message;
    },
    fetchReply: async (id?: string) => { events.push({ name: 'fetch-reply', payload: { message: id } }); return (id === FOLLOW_UP ? followUp : response) as unknown as Message; },
    followUp: async (payload: Payload) => { events.push({ name: 'follow-up', payload }); return followUp as unknown as Message; },
    deleteReply: async (id?: string) => { events.push({ name: 'delete', payload: { message: id } }); },
  });
  return { events, client, interaction: input as unknown as ChatInputCommandInteraction };
}

test('/fix of a translated video post publishes one confirmed block with Original post and Remove', async () => {
  const f = manual(), outcomes: unknown[] = [];
  await execute(f.interaction, config, { translateTweet: async () => TWEET, lookupTweet: async () => TWEET,
    verifyPreview: forbidden.forbid('A block carries its own media; no native card is checked'),
    observePreview: (_expected, result) => outcomes.push(result.ok) });
  const edits = f.events.filter(event => event.name === 'edit').map(event => event.payload!);
  const block = edits.find(edit => edit.flags === MessageFlags.IsComponentsV2)!;
  assert.equal(block.content, null);
  assert.deepEqual(block.embeds, []);
  assert.equal(block.components!.filter(component => component.type === ComponentType.Container).length, 1);
  assert(texts(block.components!).some(text => text.includes('The translated quote.')));
  assert.doesNotMatch(JSON.stringify(edits), /fixupx|vxtwitter/);
  const last = JSON.stringify(edits.at(-1));
  assert.match(last, /linky:remove-manual/);
  assert.match(last, /"type":17/, 'the final controls edit keeps the block');
  assert(!f.events.some(event => event.name === 'follow-up' || event.name === 'delete'));
  assert.deepEqual(outcomes, [true]);
  assert.equal(f.client.listenerCount(Events.Raw), 0);
});

test('/fix shows an English photo post as one block when tweet translation is off', async () => {
  const f = manual(), lookups: unknown[] = [];
  await execute(f.interaction, { ...config, translateTweets: false }, {
    lookupTweet: async (id, options) => { lookups.push({ id, ...options }); return PHOTO_POST; },
    verifyPreview: forbidden.forbid('A block carries its own media; no native card is checked') });
  assert.deepEqual(lookups, [{ id: '2124451245704261749', translate: false }]);
  const edits = f.events.filter(event => event.name === 'edit').map(event => event.payload!);
  const block = edits.find(edit => edit.flags === MessageFlags.IsComponentsV2)!;
  assert.match(texts(block.components!).join('\n'), /An English photo post\./);
  assert.doesNotMatch(JSON.stringify(edits), /fixupx|Translated from/);
});

for (const send of [true, false]) {
  test(`/fix replaces an unconfirmed block with the native card as a ${send ? 'public' : 'private'} follow-up`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = manual({ ready: false, send }), outcomes: unknown[] = [];
    let checks = 0;
    const pending = execute(f.interaction, config, { lookupTweet: async () => PHOTO_POST,
      verifyPreview: async (_message, expected) => ++checks === 1
        ? { ok: false, missing: [...expected], videoMetadata: false } : { ok: true, missing: [], videoMetadata: false, attributed: [...expected] },
      observePreview: (_expected, result) => outcomes.push(result.ok) });
    for (let turn = 0; turn < 40; turn++) { t.mock.timers.tick(1_000); await new Promise(resolve => setImmediate(resolve)); }
    await pending;
    const names = f.events.map(event => event.name);
    const followUp = names.indexOf('follow-up'), deleted = names.indexOf('delete');
    assert(followUp > 0 && deleted === followUp + 1, 'the card is sent first, then the block is deleted');
    assert.equal(f.events[deleted].payload?.message, undefined, 'the deleted reply is the original block');
    const card = f.events[followUp].payload!;
    assert.equal(card.flags, send ? undefined : MessageFlags.Ephemeral, 'a private request keeps a private card');
    assert.match(String(card.content), /^https:\/\/fixupx\.com\/ArcoCunnivoro\/status\/2124451245704261749/);
    assert.doesNotMatch(JSON.stringify(card), /"type":17/);
    assert.match(JSON.stringify(card), /linky:remove-manual/);
    assert.match(JSON.stringify(card), /"url":"https:\/\/x\.com\/ArcoCunnivoro\/status\/2124451245704261749"/);
    const later = f.events.slice(deleted + 1).filter(event => event.name === 'edit');
    assert(later.length > 0, 'the provider recovery edit runs');
    assert(later.every(event => event.payload?.message === FOLLOW_UP), 'every later edit targets the card, not the deleted block');
    assert.match(String(later[0].payload?.content), /vxtwitter\.com/);
    assert(f.events.slice(deleted + 1).filter(event => event.name === 'fetch-reply').every(event => event.payload?.message === FOLLOW_UP));
    assert.deepEqual(outcomes, [false, true]);
    assert.equal(f.client.listenerCount(Events.Raw), 0);
  });
}

test('/fix keeps the block notice when the block is unconfirmed and settings change before the card', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = manual({ ready: false });
  let platforms: Record<string, boolean> = {};
  const pending = execute(f.interaction, config, { lookupTweet: async () => PHOTO_POST,
    serverPreferences: () => ({ platforms }),
    verifyPreview: forbidden.forbid('No card is checked after the settings changed') });
  const blockShown = () => f.events.some(event => event.name === 'edit' && event.payload?.flags === MessageFlags.IsComponentsV2);
  for (let turn = 0; turn < 50 && !blockShown(); turn++) await new Promise(resolve => setImmediate(resolve));
  assert(blockShown());
  platforms = { x: false };
  for (let turn = 0; turn < 40; turn++) { t.mock.timers.tick(1_000); await new Promise(resolve => setImmediate(resolve)); }
  await pending;
  assert(!f.events.some(event => event.name === 'follow-up'), 'no card is published once X is turned off');
  const last = f.events.filter(event => event.name === 'edit').at(-1)!.payload!;
  assert.match(String(last.components?.[0] && 'content' in last.components[0] ? last.components[0].content : ''), /could not be confirmed/);
});
