import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, test, type TestContext } from 'node:test';
import { Client, ComponentType, Events, MessageFlags, PermissionFlagsBits, PermissionsBitField,
  type APIMessageTopLevelComponent, type ChatInputCommandInteraction, type Message, type MessageCreateOptions } from 'discord.js';
import { execute } from '../src/commands/fix';
import type { Config } from '../src/config';
import { blueskyPanelComponents, blueskyPanelMedia, blueskyPostPanel } from '../src/services/BlueskyPanel';
import type { BlueskyLookup, BlueskyPost } from '../src/services/BlueskyPost';
import type { ExpectedPreview, PreviewResult } from '../src/services/PreviewRecovery';
import { createLinkRepostHandler } from '../src/services/SocialLinkService';
import { panelMediaReady } from '../src/services/TweetPanel';
import { botMessage, commandInteraction, createForbidden, repostSource, sendableChannel, type InteractionEvent } from './support/discord';

const BOT = '1491240385031311470', CHANNEL = '123456789012345678', SHARER = '777777777777777777';
const DID = 'did:plc:abcdefghijklmnopqrstuvwx', HANDLE = 'linky-test.bsky.social', RKEY = '3n2m24be4e223';
const SOURCE = `https://bsky.app/profile/${HANDLE}/post/${RKEY}`;
const FIXED = `https://bskx.app/profile/${HANDLE}/post/${RKEY}`;
const IMAGE = `https://cdn.bsky.app/img/feed_fullsize/plain/${DID}/bafkreiimage0@jpeg`;
const AVATAR = `https://cdn.bsky.app/img/avatar/plain/${DID}/bafkreiavatar@jpeg`;

const POST: BlueskyPost = {
  url: SOURCE, author: { did: DID, handle: HANDLE, name: 'Linky *Test*', avatar: AVATAR },
  text: 'Hello from Bluesky', images: [{ type: 'photo', url: IMAGE, alt: 'A test photo' }],
};
const QUOTED: BlueskyPost = { ...POST, images: [], quote: {
  url: 'https://bsky.app/profile/quoted.bsky.social/post/3mquotedpost2',
  author: { did: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb', handle: 'quoted.bsky.social', name: '' },
  text: 'The quoted words', images: [{ type: 'photo', url: 'https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:bbbbbbbbbbbbbbbbbbbbbbbb/q@jpeg', alt: '' }],
} };

const forbidden = createForbidden();
afterEach(() => forbidden.assertNone());

type Component = { type: number; content?: string; components?: Component[]; items?: { media: Record<string, unknown>; description?: string }[];
  accessory?: { media: { url: string } }; accent_color?: number };

/** Gallery items as Discord reports them once fetched: Bluesky's CDN serves WebP. */
function loaded(components: readonly unknown[]): unknown[] {
  const fill = (component: Component): Component => component.type === ComponentType.MediaGallery
    ? { ...component, items: component.items!.map(item => ({ ...item, media: { ...item.media,
      proxy_url: 'https://media.discordapp.net/x', loading_state: 2, content_type: 'image/webp' } })) }
    : component.type === ComponentType.Container ? { ...component, components: component.components!.map(fill) } : component;
  return (components as Component[]).map(fill);
}
const texts = (components: readonly unknown[]): string[] => (components as Component[]).flatMap(component =>
  component.type === ComponentType.TextDisplay ? [component.content!] : component.components ? texts(component.components) : []);

test('a lone visible Bluesky post with images offers a block; other messages keep the native card', async () => {
  const calls: string[] = [];
  const lookup = (post: BlueskyPost | null): BlueskyLookup => async id => { calls.push(id); return post; };
  assert.deepEqual(await blueskyPostPanel(`Look ${SOURCE}`, ['bluesky'], lookup(POST)),
    { post: POST, media: POST.images, source: FIXED });
  assert.deepEqual(calls, [`${HANDLE}/${RKEY}`], 'only the actor and record key are looked up');
  assert.deepEqual((await blueskyPostPanel(SOURCE, ['bluesky'], lookup(QUOTED)))?.media, QUOTED.quote!.images, 'quoted images count');
  assert.equal(await blueskyPostPanel(SOURCE, ['bluesky'], lookup({ ...POST, images: [] })), undefined, 'a post without images');
  assert.equal(await blueskyPostPanel(SOURCE, ['bluesky'], lookup(null)), undefined, 'a refused or failed lookup');
  assert.equal(await blueskyPostPanel(SOURCE, ['bluesky'], async () => { throw new Error('offline'); }), undefined);
  calls.length = 0;
  assert.equal(await blueskyPostPanel(`${SOURCE} ${SOURCE.replace(RKEY, 'another')}`, ['bluesky'], lookup(POST)), undefined);
  assert.equal(await blueskyPostPanel(`${SOURCE} https://example.com/page`, ['bluesky'], lookup(POST)), undefined);
  assert.equal(await blueskyPostPanel(`<${SOURCE}>`, ['bluesky'], lookup(POST)), undefined, 'a suppressed link stays a link');
  assert.equal(await blueskyPostPanel(SOURCE, ['x'], lookup(POST)), undefined, 'Bluesky disabled for this server');
  assert.equal(await blueskyPostPanel(`https://bsky.app/profile/${HANDLE}`, ['bluesky'], lookup(POST)), undefined, 'a profile is no post');
  assert.deepEqual(calls, [], 'several links, a hidden link, a profile or a disabled platform send no lookup');
});

test('the block shows the display name, the @handle linked to the profile, the text, the quote and every image', () => {
  const block = blueskyPanelComponents({ post: POST, media: POST.images, source: FIXED }, '> **Shared by <@1>**')!;
  assert.equal(block.length, 2);
  assert.deepEqual(texts(block), ['> **Shared by <@1>**', `**Linky \\*Test\\*** [@${HANDLE}](<https://bsky.app/profile/${HANDLE}>)\nHello from Bluesky`]);
  const container = block[1] as Component;
  assert.equal(container.type, ComponentType.Container);
  assert.equal(container.accent_color, 0x1185fe);
  assert.equal(container.components![0].accessory?.media.url, AVATAR, 'the avatar is the thumbnail');
  assert.deepEqual(container.components!.at(-1), { type: ComponentType.MediaGallery,
    items: [{ media: { url: IMAGE }, description: 'A test photo' }] }, 'alt text describes the image');
  const quoted = blueskyPanelComponents({ post: QUOTED, media: blueskyPanelMedia(QUOTED)!, source: FIXED }, '')!;
  assert.equal(quoted.length, 1, 'no lead without one');
  assert.deepEqual(texts(quoted).slice(1), ['> Quoting **[@quoted.bsky.social](<https://bsky.app/profile/quoted.bsky.social/post/3mquotedpost2>)**\n> The quoted words']);
  const { avatar: _avatar, ...plainAuthor } = POST.author;
  const noAvatar = blueskyPanelComponents({ post: { ...POST, author: plainAuthor }, media: POST.images, source: FIXED }, '')!;
  assert.equal((noAvatar[0] as Component).components![0].type, ComponentType.TextDisplay, 'no avatar section without an avatar');
  assert.equal(texts(noAvatar)[0], `**Linky \\*Test\\*** [@${HANDLE}](<https://bsky.app/profile/${HANDLE}>)\nHello from Bluesky`);
  assert.equal(((quoted[0] as Component).components!.at(-1)!.items![0]).description, 'Photo from the post.');
  assert.equal(blueskyPanelComponents({ post: { ...POST, text: 'a'.repeat(4000) }, media: POST.images, source: FIXED }, ''), null,
    'text over 4000 characters keeps the card');
  const eleven = { ...POST, images: Array.from({ length: 11 }, (_, index) => ({ type: 'photo' as const, url: `${IMAGE}${index}`, alt: '' })) };
  assert.equal(blueskyPanelMedia(eleven), null, 'more than ten images keep the card');
  assert.equal(blueskyPanelMedia({ ...POST, quote: { ...POST, url: 'https://bsky.app/profile/a.b/post/c' } })!.length, 1, 'an image shown twice is listed once');
});

test('Bluesky block readiness needs every image fetched as an image', () => {
  const block = blueskyPanelComponents({ post: POST, media: POST.images, source: FIXED }, '')!;
  assert.equal(panelMediaReady({ components: loaded(block) }, POST.images), true);
  assert.equal(panelMediaReady({ components: block }, POST.images), false, 'not yet fetched');
});

function automatic({ ready = true, mode = 'replace' as 'replace' | 'reply', lookup = async () => POST as BlueskyPost | null,
  verifyPreview = forbidden.forbid('A block carries its own media; no native card is checked') as
    (message: Message, expected: readonly ExpectedPreview[]) => Promise<PreviewResult> } = {}) {
  const client = new Client({ intents: [] }); Object.assign(client, { user: { id: BOT } });
  const events: string[] = [], sends: MessageCreateOptions[] = [], edits: { components?: unknown[] }[] = [], logs: unknown[][] = [];
  const lookups: string[] = [];
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
  const card = botMessage({
    id: '123456789012345681', channelId: CHANNEL, author: { id: BOT }, fetch: async () => card,
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
      platforms: ['bluesky'], lookupBluesky: async id => { lookups.push(id); return lookup(); },
      rememberRepost: async () => { events.push('ownership'); return true; }, verifyPreview,
      ...(mode === 'reply' ? { serverPreferences: () => ({ mode }) } : {}),
    });
    try { await handler(source as unknown as Message); } finally { await client.destroy(); }
  };
  return { client, events, sends, edits, logs, lookups, source, run };
}

async function expireBlockWait(t: TestContext, events: readonly string[], pending: Promise<unknown>) {
  for (let turn = 0; turn < 50 && !events.includes('unconfirmed'); turn++) await new Promise(resolve => setImmediate(resolve));
  for (let turn = 0; turn < 40; turn++) { t.mock.timers.tick(10_000); await new Promise(resolve => setImmediate(resolve)); }
  await pending;
}
const published = (payload: MessageCreateOptions) =>
  (payload.components ?? []).map(component => 'toJSON' in component ? component.toJSON() : component) as unknown[];
const nativeOk = async (_message: unknown, expected: readonly ExpectedPreview[]): Promise<PreviewResult> =>
  ({ ok: true, missing: [], videoMetadata: false, attributed: [...expected] });

test('automatic repost of a Bluesky image post sends one confirmed block and keeps it with Remove', async () => {
  const f = automatic();
  await f.run();
  assert.deepEqual(f.lookups, [`${HANDLE}/${RKEY}`]);
  assert.deepEqual(f.events, ['send block', 'ownership', 'delete original', 'controls']);
  const [sent] = f.sends;
  assert.equal(f.sends.length, 1, 'no native card is sent beside the block');
  assert.equal(sent.flags, MessageFlags.IsComponentsV2);
  assert.equal(sent.content, undefined);
  assert.equal(sent.embeds, undefined);
  assert.deepEqual(texts(published(sent)), [`> **Shared by <@${SHARER}>**\nLook`,
    `**Linky \\*Test\\*** [@${HANDLE}](<https://bsky.app/profile/${HANDLE}>)\nHello from Bluesky`], 'the post text appears once');
  assert.doesNotMatch(JSON.stringify(published(sent)), /bskx|fxbsky/);
  assert.match(JSON.stringify(published(sent)), new RegExp(`"url":"${SOURCE.replaceAll('.', '\\.')}"`), 'Original post button');
  assert.match(JSON.stringify(f.edits.at(-1)), /linky:remove/);
  assert.match(JSON.stringify(f.edits.at(-1)), /"type":17/, 'the controls edit keeps the block');
  assert.equal(f.client.listenerCount(Events.Raw), 0);
});

test('a Bluesky post without images, or a failed lookup, keeps the native bskx.app card', async () => {
  for (const lookup of [async () => ({ ...POST, images: [] }), async () => null]) {
    const f = automatic({ lookup, verifyPreview: nativeOk });
    await f.run();
    assert.deepEqual(f.events.slice(0, 1), ['send card']);
    assert.equal(f.sends[0].flags, undefined);
    assert.match(String(f.sends[0].content), new RegExp(FIXED.replaceAll('.', '\\.')));
  }
});

test('a Bluesky source with suppressed embeds is neither looked up nor shown as a block', async () => {
  const f = automatic();
  f.source.flags.add(MessageFlags.SuppressEmbeds);
  await f.run();
  assert.deepEqual(f.lookups, []);
  assert.deepEqual(f.sends, []);
});

test('an unconfirmed automatic Bluesky block is replaced by the native bskx.app card, which is checked and kept', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const checked: string[] = [];
  const f = automatic({ ready: false, verifyPreview: async (message, expected) => { checked.push(message.id); return nativeOk(message, expected); } });
  await expireBlockWait(t, f.events, f.run());
  assert.deepEqual(f.events, ['send block', 'unconfirmed', 'delete block', 'send card', 'ownership', 'delete original', 'card edit'],
    'the block is deleted before the card is sent; the two never coexist');
  const [block, card] = f.sends;
  assert.equal(card.flags, undefined);
  assert.equal(card.content, `> **Shared by <@${SHARER}>**\n> Look\n${FIXED}`);
  assert.notEqual(card.nonce, block.nonce);
  assert.equal(card.enforceNonce, true);
  assert.deepEqual(checked, ['123456789012345681'], 'the card itself is verified');
  assert.match(JSON.stringify(f.edits.at(-1)), /linky:remove/);
  assert(f.logs.some(entry => entry.includes('Post block media unconfirmed; published the native card instead')));
  assert.equal(f.client.listenerCount(Events.Raw), 0);
});

test('in Reply mode an unconfirmed Bluesky block is replaced by a native reply card and the original stays', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = automatic({ ready: false, mode: 'reply', verifyPreview: nativeOk });
  await expireBlockWait(t, f.events, f.run());
  assert.deepEqual(f.events.slice(0, 4), ['send block', 'unconfirmed', 'delete block', 'send card']);
  assert(!f.events.includes('delete original'));
  assert.equal(f.sends[1].reply?.messageReference, '123456789012345679');
  assert.equal(f.sends[1].content, `> **Shared by <@${SHARER}>**
> Look
${FIXED}`, 'the native card, not a Retry notice');
  assert.equal(f.sends.length, 2);
});

const config: Config = { discordToken: '', channelIds: [], serverIds: [], rewritePlatforms: ['bluesky'],
  translateTweets: false, settingsPath: 'unused' };
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

test('/fix of a Bluesky image post publishes one confirmed block with Original post and Remove', async () => {
  const f = manual(), lookups: string[] = [], outcomes: unknown[] = [];
  await execute(f.interaction, config, { lookupBluesky: async id => { lookups.push(id); return POST; },
    verifyPreview: forbidden.forbid('A block carries its own media; no native card is checked'),
    observePreview: (_expected, result) => outcomes.push(result.ok) });
  assert.deepEqual(lookups, [`${HANDLE}/${RKEY}`]);
  const edits = f.events.filter(event => event.name === 'edit').map(event => event.payload!);
  const block = edits.find(edit => edit.flags === MessageFlags.IsComponentsV2)!;
  assert.equal(block.content, null);
  assert.deepEqual(block.embeds, []);
  assert.equal(block.components!.filter(component => component.type === ComponentType.Container).length, 1);
  assert.match(texts(block.components!).join('\n'), /Hello from Bluesky/);
  assert.doesNotMatch(JSON.stringify(edits), /bskx|fxbsky/);
  assert.match(JSON.stringify(edits.at(-1)), /linky:remove-manual/);
  assert.match(JSON.stringify(edits.at(-1)), /"type":17/);
  assert(!f.events.some(event => event.name === 'follow-up' || event.name === 'delete'));
  assert.deepEqual(outcomes, [true]);
  assert.equal(f.client.listenerCount(Events.Raw), 0);
});

for (const send of [true, false]) {
  test(`/fix replaces an unconfirmed Bluesky block with the native card as a ${send ? 'public' : 'private'} follow-up`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = manual({ ready: false, send }), outcomes: unknown[] = [];
    const pending = execute(f.interaction, config, { lookupBluesky: async () => POST,
      verifyPreview: nativeOk, observePreview: (_expected, result) => outcomes.push(result.ok) });
    for (let turn = 0; turn < 40; turn++) { t.mock.timers.tick(1_000); await new Promise(resolve => setImmediate(resolve)); }
    await pending;
    const names = f.events.map(event => event.name);
    const followUp = names.indexOf('follow-up'), deleted = names.indexOf('delete');
    assert(followUp > 0 && deleted === followUp + 1, 'the card is sent first, then the block is deleted');
    const card = f.events[followUp].payload!;
    assert.equal(card.flags, send ? undefined : MessageFlags.Ephemeral);
    assert.equal(card.content, FIXED);
    assert.doesNotMatch(JSON.stringify(card), /"type":17/);
    assert.match(JSON.stringify(card), /linky:remove-manual/);
    assert(f.events.slice(deleted + 1).filter(event => event.name === 'edit').every(event => event.payload?.message === FOLLOW_UP));
    assert.deepEqual(outcomes, [true], 'the native card is checked once');
    assert.equal(f.client.listenerCount(Events.Raw), 0);
  });
}
