import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { AttachmentBuilder, Collection, ComponentType, MessageFlags, MessageFlagsBitField, MessageType, PermissionFlagsBits,
  PermissionsBitField, type Attachment, type ChatInputCommandInteraction, type InteractionEditReplyOptions,
  type Message, type MessageContextMenuCommandInteraction, type MessageCreateOptions, type MessageEditOptions } from 'discord.js';
import type { Config } from '../src/config';
import { execute } from '../src/commands/fix';
import { createLinkRepostHandler } from '../src/services/SocialLinkService';
import { eromeNotice, verifyEromeAttachment, type EromeProgress } from '../src/services/EromeDelivery';
import type { RepostRecord } from '../src/services/RepostRegistry';
import type { ServerPreferences } from '../src/services/ServerSettings';
import type { DeliveryOutcome } from '../src/services/DeliveryContext';
import { isEromeAvailable } from '../src/services/EromeAvailability';
import { deferred, diagnosticsStub, mockClock, reached } from './support/discord';

const GUILD = '1700000000000000001', CHANNEL = '1700000000000000002';
const AUTHOR = '1700000000000000003', BOT = '1700000000000000004', SOURCE = '1700000000000000005';
const ALBUM = 'https://www.erome.com/a/Synthetic01', SECOND = 'https://www.erome.com/a/Synthetic02';
const MiB = 1024 * 1024;
const config: Config = { discordToken: '', channelIds: [], serverIds: [], rewritePlatforms: ['erome', 'x'],
  translateTweets: false, settingsPath: 'unused' };
const prepared = () => ({ file: new AttachmentBuilder(Buffer.from('synthetic MP4 test fixture'), { name: 'linky-video.mp4' }), videoCount: 2 });

function bodyText(value: { content?: string | null; components?: readonly unknown[] }): string {
  const text = (entry: unknown): string => {
    const item = entry as { toJSON?: () => unknown; content?: string; components?: unknown[] };
    if (item.toJSON) return text(item.toJSON());
    return [item.content ?? '', ...item.components?.map(text) ?? []].join('\n');
  };
  return value.content || value.components?.map(text).join('\n') || '';
}
type AutoOptions = NonNullable<Parameters<typeof createLinkRepostHandler>[3]>;
type ManualOptions = NonNullable<Parameters<typeof execute>[2]>;
// /fix creates its progress reporter with a 500 ms delay (src/commands/fix.ts).
const FIX_PROGRESS_DELAY_MS = 500;

function ageChannel() {
  return { nsfw: true, parent: { nsfw: false } as { nsfw: boolean } | null, isThread: () => false };
}

function automatic(content = ALBUM) {
  const calls: string[] = [], records: RepostRecord[] = [];
  const outputs: { options: MessageCreateOptions; edits: MessageEditOptions[]; deleted: boolean }[] = [];
  const state = { enabled: true, preferences: { mode: 'replace' } as ServerPreferences,
    permissions: new PermissionsBitField(PermissionsBitField.All), originalDeleted: false };
  const channel = { ...ageChannel(), id: CHANNEL, parentId: '1700000000000000006',
    isSendable: () => true, permissionsFor: () => state.permissions,
    send: async (options: MessageCreateOptions) => {
      const entry = { options, edits: [] as MessageEditOptions[], deleted: false };
      outputs.push(entry);
      const message = {
        id: String(BigInt(SOURCE) + BigInt(outputs.length)), guildId: GUILD, channelId: CHANNEL,
        author: { id: BOT, bot: true }, content: options.content ?? '',
        components: (options.components ?? []).map(c => ({ toJSON: () => 'toJSON' in c ? c.toJSON() : c })),
        attachments: new Collection<string, Attachment>((options.files ?? []).map((_, i) => [String(i), {} as Attachment])),
        delete: async () => { entry.deleted = true; },
        fetch: async () => message,
        edit: async (edit: MessageEditOptions) => {
          entry.edits.push(edit);
          if (typeof edit.content === 'string') message.content = edit.content;
          return message;
        },
      };
      return message as unknown as Message;
    },
  };
  const source = {
    id: SOURCE, guildId: GUILD, channelId: CHANNEL, author: { id: AUTHOR, bot: false }, content,
    guild: { members: { me: { id: BOT } }, premiumTier: 0 as number | undefined }, channel, inGuild: () => true,
    partial: false, webhookId: null, type: MessageType.Default, poll: null, pinned: false, hasThread: false,
    stickers: new Collection(), components: [], messageSnapshots: new Collection(),
    attachments: new Collection<string, Attachment>(), flags: new MessageFlagsBitField(), editedTimestamp: null,
    reference: null, deletable: true, fetch: async () => source as unknown as Message,
    delete: async () => { state.originalDeleted = true; },
  };
  const run = (options: AutoOptions = {}, copyAttachment: Parameters<typeof createLinkRepostHandler>[2] =
    async () => assert.fail('Unexpected source attachment download')) => createLinkRepostHandler([], { info() {}, warn() {}, error() {} },
    copyAttachment, {
      serverEnabled: () => state.enabled, serverPreferences: () => state.preferences,
      prepareErome: async url => { calls.push(url); return prepared(); },
      verifyErome: async () => true,
      verifyPreview: async (_message, expected) => ({ ok: false, missing: [...expected], videoMetadata: false }),
      rememberRepost: async record => { records.push(record); return true; }, ...options,
    })(source as unknown as Message);
  return { state, source, channel, calls, outputs, records, run };
}

function manual(content = ALBUM, context = false) {
  const calls: string[] = [], replies: { content?: string; flags?: unknown }[] = [];
  const edits: InteractionEditReplyOptions[] = [], deferrals: unknown[] = [];
  const response = { id: SOURCE, content: '', components: [] as { toJSON(): unknown }[], fetch: async () => response };
  const input = {
    isChatInputCommand: () => !context, inGuild: () => true, guildId: GUILD, channelId: CHANNEL, user: { id: AUTHOR }, channel: ageChannel(),
    memberPermissions: new PermissionsBitField(PermissionsBitField.All),
    appPermissions: new PermissionsBitField(PermissionsBitField.All),
    attachmentSizeLimit: undefined as number | undefined,
    options: { getString: () => content },
    targetMessage: { content, author: { id: AUTHOR },
      delete: () => assert.fail('Manual previews must preserve their source'),
      edit: () => assert.fail('Manual previews must not edit their source') },
    reply: async (options: { content?: string; flags?: unknown }) => { replies.push(options); },
    deferReply: async (options: unknown) => { deferrals.push(options); },
    editReply: async (options: InteractionEditReplyOptions) => {
      edits.push(options);
      if (typeof options.content === 'string') response.content = options.content;
      if (options.content === null) response.content = '';
      if (options.components) response.components = options.components.map(c => ({ toJSON: () => 'toJSON' in c ? c.toJSON() : c }));
      return response as unknown as Message;
    },
  };
  const run = (options: ManualOptions = {}, settings: Config = config) => execute(input as unknown as ChatInputCommandInteraction | MessageContextMenuCommandInteraction,
    settings, { prepareErome: async url => { calls.push(url); return prepared(); }, verifyErome: async () => true,
      verifyPreview: async (_message, expected) => ({ ok: false, missing: [...expected], videoMetadata: false }), ...options });
  return { input, calls, replies, edits, deferrals, response, run };
}

test('standalone Erome prepared video and image previews group text and media in automatic and both manual commands', async () => {
  for (const kind of ['video', 'image'] as const) {
    const file = new AttachmentBuilder(Buffer.from('prepared media'), { name: kind === 'image' ? 'erome-image.jpg' : 'erome-video.mp4' });
    const f = automatic();
    await f.run({ prepareErome: async () => ({ file, videoCount: 1, kind }) });
    assert.equal(f.outputs.length, 1);
    const sent = f.outputs[0].options;
    assert.equal(sent.content, undefined);
    assert.equal(sent.embeds, undefined);
    assert(new MessageFlagsBitField(sent.flags as number).has(MessageFlags.IsComponentsV2));
    assert.match(JSON.stringify(sent.components), new RegExp(`attachment://${file.name}`));
    assert.match(bodyText(sent), /Shared by/);
    assert.equal(f.state.originalDeleted, true);
    assert.match(JSON.stringify(f.outputs[0].edits.at(-1)?.components), new RegExp(`attachment://${file.name}`));
    for (const context of [false, true]) {
      const m = manual(ALBUM, context); m.input.attachmentSizeLimit = 10 * MiB;
      await m.run({ prepareErome: async () => ({ file, videoCount: 1, kind }) });
      const publication = m.edits.find(edit => edit.files?.length)!;
      assert.equal(publication.content, null);
      assert.deepEqual(publication.embeds, []);
      assert.equal(publication.flags, MessageFlags.IsComponentsV2);
      assert.match(JSON.stringify(publication.components), new RegExp(`attachment://${file.name}`));
      assert.match(JSON.stringify(m.edits.at(-1)?.components), new RegExp(`attachment://${file.name}`));
    }
  }
});

test('automatic inline Erome replies recheck source and scope after ownership and final Details binding', async () => {
  for (const change of ['none', 'source', 'settings', 'disabled']) {
    const f = automatic(); f.state.preferences = { mode: 'reply' };
    let bindings = 0;
    await f.run({ diagnostics: diagnosticsStub({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', bind: async () => {
      bindings++;
      assert.equal(f.records.length, 1, 'ownership was durably saved before the late change');
      if (change === 'source') f.source.content += ' edited';
      if (change === 'settings') f.state.preferences = { mode: 'reply', platforms: { erome: false } };
      if (change === 'disabled') f.state.enabled = false;
      return true;
    } }) });
    assert.equal(bindings, 1, change);
    assert.equal(f.outputs.length, 1, change);
    assert.equal(f.records[0].mode, 'reply', change);
    assert.equal(f.outputs[0].options.flags, MessageFlags.IsComponentsV2);
    assert.match(JSON.stringify(f.outputs[0].options.components), /attachment:\/\/linky-video.mp4/);
    assert.equal(f.outputs[0].edits.length, 1, 'the final controls edit completed');
    assert.equal(f.state.originalDeleted, false, change);
    assert.equal(f.outputs[0].deleted, change !== 'none', change);
  }
});

test('operator Erome restrictions make no media calls and leave automatic sources unchanged', async () => {
  for (const guildIds of [[], ['1700000000000000099']]) {
    const f = automatic(); f.state.preferences = { eromeChannels: 'all', platforms: { erome: true } };
    await f.run({ eromeAvailable: guildId => isEromeAvailable({ ...config, eromeGuildIds: guildIds }, guildId),
      prepareEromeMedia: async () => assert.fail('Blocked hosted preparation'), bindEromeMedia: async () => true,
      releaseEromeMedia: async () => {} });
    assert.deepEqual(f.calls, []); assert.deepEqual(f.outputs, []); assert.equal(f.state.originalDeleted, false);
  }
  const allowed = automatic();
  await allowed.run({ eromeAvailable: guildId => isEromeAvailable({ ...config, eromeGuildIds: [GUILD] }, guildId) });
  assert.deepEqual(allowed.calls, [ALBUM]);
});

test('mixed messages still fix normal links but suppress blocked Erome embeds and keep the source', async () => {
  const f = automatic(`${ALBUM} https://x.com/example/status/20`);
  f.channel.nsfw = false;
  await f.run({ eromeAvailable: () => false, verifyPreview: async (_message, expected) => {
    assert.equal(expected.length, 1); assert.equal(expected[0].platform, 'x');
    return { ok: true, missing: [], videoMetadata: false };
  } });
  assert.deepEqual(f.calls, []); assert.equal(f.outputs.length, 1);
  assert.equal(f.state.originalDeleted, false); assert.equal(f.records[0].mode, 'reply');
  assert.match(bodyText(f.outputs[0].options), /https:\/\/fixupx.com\/example\/status\/20/);
  assert.ok(bodyText(f.outputs[0].options).includes(`<${ALBUM}>`));
  assert.doesNotMatch(JSON.stringify(f.outputs[0].options.components), /erome.com/);
  assert.deepEqual(f.outputs[0].options.reply, { messageReference: SOURCE, failIfNotExists: true });
});

test('operator revocation during preparation skips fallback and publication', async () => {
  const f = automatic(); let available = true;
  await f.run({ eromeAvailable: () => available,
    prepareEromeMedia: async () => { available = false; return null; },
    bindEromeMedia: async () => true, releaseEromeMedia: async () => {} });
  assert.deepEqual(f.calls, []); assert.deepEqual(f.outputs, []); assert.equal(f.state.originalDeleted, false);
});

test('operator-blocked slash and context fixes respond privately without preparing media', async () => {
  for (const context of [false, true]) for (const guildIds of [[], ['1700000000000000099']]) {
    const f = manual(ALBUM, context);
    await f.run({ prepareEromeMedia: async () => assert.fail('Blocked hosted preparation'),
      serverPreferences: () => ({ platforms: { erome: true }, eromeChannels: 'all' }) }, { ...config, eromeGuildIds: guildIds });
    assert.deepEqual(f.calls, []); assert.deepEqual(f.edits, []); assert.deepEqual(f.deferrals, []);
    assert.equal(f.replies[0].flags, MessageFlags.Ephemeral);
    assert.match(f.replies[0].content!, /unavailable.*self-host/);
    assert.doesNotMatch(f.replies[0].content!, /erome_channels/);
  }
});

test('actual private contexts cannot prepare Erome even with an unrestricted self-host policy', async () => {
  for (const context of [false, true]) {
    const f = manual(ALBUM, context);
    Object.assign(f.input, { guildId: null, inGuild: () => false });
    await f.run();
    assert.deepEqual(f.calls, []); assert.deepEqual(f.edits, []); assert.deepEqual(f.deferrals, []);
    assert.equal(f.replies[0].flags, MessageFlags.Ephemeral); assert.match(f.replies[0].content!, /private conversation/);
  }
});

test('manual mixed messages fix allowed links without including blocked Erome or requiring its channel policy', async () => {
  const f = manual(`${ALBUM} https://x.com/example/status/20`, true); f.input.channel.nsfw = false;
  await f.run({ verifyPreview: async (_message, expected) => {
    assert.equal(expected.length, 1); return { ok: true, missing: [], videoMetadata: false };
  } }, { ...config, eromeGuildIds: [] });
  assert.deepEqual(f.calls, []); assert.deepEqual(f.replies, []);
  assert.match(f.edits[0].content!, /fixupx.com/);
  assert.ok(f.edits.every(edit => !String(edit.content).includes('erome.com')));
});

test('manual attachment preview is withdrawn if operator policy changes during verification', async () => {
  const settings = { ...config, eromeGuildIds: [GUILD] };
  const f = manual(); f.input.attachmentSizeLimit = 10 * MiB;
  await f.run({ verifyErome: async () => { settings.eromeGuildIds = []; return true; } }, settings);
  assert.deepEqual(f.calls, [ALBUM]);
  assert.deepEqual(f.edits.at(-1)?.attachments, []);
  assert.match(bodyText(f.edits.at(-1)!), /no longer allowed/);
});

test('automatic Erome gating rejects ordinary channels, unmarked thread parents and DMs before preparation', async () => {
  for (const restriction of ['channel', 'thread', 'missing-parent', 'dm']) {
    const f = automatic();
    if (restriction === 'channel') f.channel.nsfw = false;
    if (restriction === 'thread' || restriction === 'missing-parent') f.channel.isThread = () => true;
    if (restriction === 'missing-parent') f.channel.parent = null;
    if (restriction === 'dm') f.source.inGuild = () => false;
    await f.run();
    assert.deepEqual(f.calls, [], restriction);
    assert.deepEqual(f.outputs, [], restriction);
    assert.equal(f.state.originalDeleted, false);
  }
});

test('automatic Erome allows ordinary channels and threads when the server chooses all', async () => {
  for (const thread of [false, true]) {
    const f = automatic();
    f.state.preferences.eromeChannels = 'all';
    f.channel.nsfw = false;
    f.channel.isThread = () => thread;
    await f.run();
    assert.deepEqual(f.calls, [ALBUM]);
    assert.equal(f.outputs.length, 1);
    assert.equal(f.outputs[0].options.files?.length, 1);
    assert.equal(f.state.originalDeleted, true);
  }
});

test('all-channel Erome policy does not override scope, platforms, DMs or unknown parents', async () => {
  for (const restriction of ['server', 'channel', 'platform', 'dm', 'parent']) {
    const f = automatic();
    f.state.preferences.eromeChannels = 'all';
    f.channel.nsfw = false;
    if (restriction === 'server') f.state.enabled = false;
    if (restriction === 'channel') f.state.preferences.channelIds = [];
    if (restriction === 'platform') f.state.preferences.platforms = { erome: false };
    if (restriction === 'dm') f.source.inGuild = () => false;
    if (restriction === 'parent') { f.channel.isThread = () => true; f.channel.parent = null; }
    await f.run();
    assert.deepEqual(f.calls, [], restriction);
    assert.deepEqual(f.outputs, [], restriction);
  }
});

test('automatic Erome respects a revoked ordinary-channel policy before publishing', async () => {
  const f = automatic();
  f.state.preferences.eromeChannels = 'all';
  f.channel.nsfw = false;
  await f.run({ prepareErome: async () => {
    f.state.preferences = { ...f.state.preferences, eromeChannels: 'age-restricted' };
    return prepared();
  } });
  assert.deepEqual(f.outputs, []);
  assert.equal(f.state.originalDeleted, false);
});

test('automatic Erome respects posting mode, preserves every album URL and inherits thread age restriction', async () => {
  for (const mode of ['reply', 'replace'] as const) {
    for (const thread of [false, true]) {
      const content = `${ALBUM}?tracking=1 ${ALBUM} ${SECOND}`;
      const f = automatic(content);
      f.state.preferences.mode = mode;
      f.channel.isThread = () => thread;
      f.channel.nsfw = !thread;
      f.channel.parent!.nsfw = thread;
      await f.run();
      assert.deepEqual(f.calls, [ALBUM], 'prepare only the first distinct album');
      assert.equal(f.outputs.length, 1);
      assert.equal(f.outputs[0].options.files?.length, 1);
      assert.deepEqual(f.outputs[0].options.reply, mode === 'reply' ? { messageReference: SOURCE, failIfNotExists: true } : undefined);
      assert.match(bodyText(f.outputs[0].options), /First of 2 videos/);
      assert.equal(f.outputs[0].deleted, false);
      assert.equal(f.source.content, content);
      assert.equal(f.state.originalDeleted, mode === 'replace');
      assert(bodyText(f.outputs[0].options).includes(ALBUM) && bodyText(f.outputs[0].options).includes(SECOND));
      assert.deepEqual(f.records, [{ guildId: GUILD, channelId: CHANNEL, sourceId: SOURCE,
        replacementId: String(BigInt(SOURCE) + 1n), authorId: AUTHOR, mode }]);
      assert.match(JSON.stringify(f.outputs[0].edits.at(-1)), /linky:remove/);
    }
  }
});

test('Replace copies source attachments through the attachment path; failed copies keep the original', async () => {
  for (const fail of [false, true]) {
    const f = automatic();
    const attachment = { id: 'source-file', name: 'photo.png', size: 3, description: 'A photo',
      spoiler: false, flags: { has: () => false } } as unknown as Attachment;
    f.source.attachments.set(attachment.id, attachment);
    await f.run({
      prepareEromeMedia: async () => assert.fail('Hosted V2 must not discard source attachments'),
      bindEromeMedia: async () => true, releaseEromeMedia: async () => {},
    }, async source => {
      assert.equal(source, attachment);
      if (fail) throw Error('Attachment unavailable');
      return new AttachmentBuilder(Buffer.from([1, 2, 3]), { name: source.name, description: source.description! });
    });
    assert.equal(f.state.originalDeleted, !fail);
    assert.equal(f.outputs.length, fail ? 0 : 1);
    if (!fail) {
      assert.equal(f.outputs[0].options.files?.length, 2);
      const copied = f.outputs[0].options.files![0] as AttachmentBuilder;
      assert.deepEqual(copied.attachment, Buffer.from([1, 2, 3]));
      assert.equal(copied.name, 'photo.png');
    }
  }
});

test('automatic Erome requires Attach Files before preparing or sending video', async () => {
  const f = automatic();
  f.state.permissions = new PermissionsBitField(PermissionsBitField.All & ~PermissionFlagsBits.AttachFiles & ~PermissionFlagsBits.Administrator);
  await f.run();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.outputs, []);
  assert.equal(f.state.originalDeleted, false);
});

test('manual Erome requires Attach Files before preparing or sending video', async () => {
  const f = manual();
  f.input.appPermissions = new PermissionsBitField(0n);
  await f.run();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.edits, []);
  assert.deepEqual(f.deferrals, []);
  assert.match(f.replies[0].content ?? '', /Attach Files/);
  assert.equal(f.replies[0].flags, MessageFlags.Ephemeral);
});

test('manual Erome passes Discord interaction upload limits to preparation as output budgets', async () => {
  for (const context of [false, true]) {
    for (const [upload, output] of [[10, 9], [20, 19], [50, 49], [100, 63], [undefined, 19]] as const) {
      const f = manual(ALBUM, context), budgets: unknown[] = [];
      f.input.attachmentSizeLimit = upload === undefined ? undefined : upload * MiB;
      await f.run({ prepareErome: async (_source, _stage, options) => { budgets.push(options?.maxBytes); return prepared(); } });
      assert.deepEqual(budgets, [output * MiB]);
      assert.equal(f.edits[0].files?.length, 1);
      assert.equal(f.input.targetMessage.content, ALBUM);
    }
  }
});

test('automatic Erome passes gateway boost tier budgets and accepts a bounded video beyond the old copy limit', async () => {
  for (const [tier, output] of [[0, 19], [1, 19], [2, 49], [3, 63], [undefined, 19]] as const) {
    const f = automatic(), budgets: unknown[] = [];
    f.source.guild.premiumTier = tier;
    await f.run({ prepareErome: async (_source, _stage, options) => {
      budgets.push(options?.maxBytes);
      return { ...prepared(), file: new AttachmentBuilder(Buffer.alloc(output * MiB), { name: 'linky-video.mp4' }) };
    } });
    assert.deepEqual(budgets, [output * MiB]);
    assert.equal(f.outputs.length, 1);
    assert.equal(f.outputs[0].options.files?.length, 1);
    assert.equal(f.state.originalDeleted, true);
    assert.equal(f.records[0].authorId, AUTHOR);
  }
});

test('manual Erome rejects invalid or unusably small explicit upload limits before preparation', async () => {
  for (const limit of [null, NaN, Infinity, -1, 0, 1, 2 * MiB - 1, '10485760']) {
    const f = manual();
    f.input.attachmentSizeLimit = limit as number;
    await f.run();
    assert.deepEqual(f.calls, [], String(limit));
    assert.deepEqual(f.deferrals, []);
    assert.deepEqual(f.edits, []);
    assert.equal(f.replies[0].flags, MessageFlags.Ephemeral);
    assert.match(f.replies[0].content ?? '', /upload limit/);
    assert.equal(f.input.targetMessage.content, ALBUM);
  }
});

test('manual Erome never uploads an oversized, empty or remote prepared attachment', async () => {
  const files = [new AttachmentBuilder(Buffer.alloc(9 * MiB + 1)), new AttachmentBuilder(Buffer.alloc(0)),
    new AttachmentBuilder('https://example.test/unbounded.mp4')];
  for (const file of files) {
    const f = manual();
    f.input.attachmentSizeLimit = 10 * MiB;
    await f.run({ prepareErome: async () => ({ ...prepared(), file }) });
    assert(f.edits.every(edit => !edit.files?.length));
    assert.match(bodyText(f.response), /could not be prepared/);
    assert.equal(f.input.targetMessage.content, ALBUM);
    assert.match(JSON.stringify(f.edits[0].components), /linky:remove-manual/);
  }
});

test('automatic Erome never uploads a file beyond the requested budget, an empty file or a remote attachment', async () => {
  for (const file of [new AttachmentBuilder(Buffer.alloc(19 * MiB + 1)), new AttachmentBuilder(Buffer.alloc(0)),
    new AttachmentBuilder('https://example.test/unbounded.mp4')]) {
    const f = automatic();
    await f.run({ prepareErome: async () => ({ ...prepared(), file }) });
    assert.equal(f.outputs.length, 1);
    assert(!f.outputs[0].options.files?.length);
    assert.match(String(f.outputs[0].options.content), /could not be prepared/);
    assert.match(JSON.stringify(f.outputs[0].edits.at(-1)), /linky:retry/);
    assert.equal(f.records.length, 1);
    assert.equal(f.records[0].authorId, AUTHOR);
    assert.equal(f.state.originalDeleted, false);
  }
});

test('automatic Erome rechecks server upload allowance after preparation and later metadata work', async () => {
  for (const change of ['prepare', 'translate']) {
    const f = automatic(change === 'translate' ? `${ALBUM} https://x.com/jack/status/20` : ALBUM);
    f.source.guild.premiumTier = 2;
    await f.run({ prepareErome: async () => {
      if (change === 'prepare') f.source.guild.premiumTier = 0;
      return { ...prepared(), file: new AttachmentBuilder(Buffer.alloc(20 * MiB), { name: 'linky-video.mp4' }) };
    }, translateTweet: async () => { f.source.guild.premiumTier = 0; return null; } });
    assert.equal(f.source.guild.premiumTier, 0);
    assert.deepEqual(f.outputs, [], change);
    assert.deepEqual(f.records, [], change);
    assert.equal(f.state.originalDeleted, false);
  }
});

test('automatic Erome stops uploads when scope, preferences, age restriction or source changes during preparation', async () => {
  for (const change of ['disabled', 'preferences', 'age', 'thread-age', 'content']) {
    const f = automatic();
    if (change === 'thread-age') { f.channel.isThread = () => true; f.channel.parent!.nsfw = true; }
    await f.run({ prepareErome: async () => {
      if (change === 'disabled') f.state.enabled = false;
      if (change === 'preferences') f.state.preferences = { mode: 'reply' };
      if (change === 'age') f.channel.nsfw = false;
      if (change === 'thread-age') f.channel.parent!.nsfw = false;
      if (change === 'content') f.source.content = SECOND;
      return prepared();
    } });
    assert.deepEqual(f.outputs, [], change);
    assert.deepEqual(f.records, [], change);
    assert.equal(f.state.originalDeleted, false);
  }
});

test('automatic unavailable or throwing Erome preparation preserves the source and offers an owned retry without uploading media', async () => {
  for (const fail of [false, true]) {
    const f = automatic();
    await f.run({ prepareErome: async () => { if (fail) throw new Error('unavailable'); return null; } });
    assert.equal(f.outputs.length, 1);
    assert(!f.outputs[0].options.files?.length);
    assert.match(String(f.outputs[0].options.content), /could not be prepared/);
    assert.match(JSON.stringify(f.outputs[0].edits.at(-1)), /linky:retry/);
    assert.equal(f.records.length, 1);
    assert.equal(f.records[0].authorId, AUTHOR);
    assert.equal(f.state.originalDeleted, false);
  }
});

test('automatic failed video verification discards the upload and leaves only an owned retry notice', async () => {
  const f = automatic();
  await f.run({ verifyErome: async () => false });
  assert.equal(f.state.originalDeleted, false);
  assert.equal(f.outputs.length, 2);
  assert.equal(f.outputs[0].deleted, true);
  assert.equal(f.outputs[1].deleted, false);
  assert.equal(f.outputs[1].options.files, undefined);
  assert.match(f.outputs[1].options.content!, /could not confirm a preview/);
  assert.equal(f.records[0].authorId, AUTHOR);
  assert.equal(f.records[0].replacementId, String(BigInt(SOURCE) + 2n));
});

test('a verified Erome attachment does not hide a missing ordinary preview in a mixed message', async () => {
  const f = automatic(`${ALBUM} https://x.com/jack/status/20`);
  const expectedPlatforms: string[][] = [];
  await f.run({ verifyPreview: async (_message, expected) => {
    expectedPlatforms.push(expected.map(item => item.providerId));
    return { ok: false, missing: [...expected], videoMetadata: false };
  } });
  assert.deepEqual(expectedPlatforms, [['fixupx'], ['fixvx']]);
  assert.equal(f.state.originalDeleted, false);
  assert.equal(f.outputs[0].deleted, true);
  assert.match(f.outputs[1].options.content!, /could not confirm a preview/);
});

test('manual Erome gating rejects normal channels, unsafe thread parents and DMs privately before preparation', async () => {
  for (const context of [false, true]) {
    for (const restriction of ['channel', 'thread', 'missing-parent', 'dm']) {
      const f = manual(ALBUM, context);
      if (restriction === 'channel') f.input.channel.nsfw = false;
      if (restriction === 'thread' || restriction === 'missing-parent') f.input.channel.isThread = () => true;
      if (restriction === 'missing-parent') f.input.channel.parent = null;
      if (restriction === 'dm') f.input.inGuild = () => false;
      await f.run();
      assert.deepEqual(f.calls, []);
      assert.deepEqual(f.edits, []);
      assert.deepEqual(f.deferrals, []);
      assert.equal(f.replies.length, 1);
      assert.equal(f.replies[0].flags, MessageFlags.Ephemeral);
    }
  }
});

test('manual Erome uses the current server policy for both slash and message actions', async () => {
  for (const context of [false, true]) {
    for (const thread of [false, true]) {
      const f = manual(ALBUM, context);
      f.input.channel.nsfw = false;
      f.input.channel.isThread = () => thread;
      await f.run({ serverPreferences: id => id === GUILD ? { eromeChannels: 'all' } : {} });
      assert.deepEqual(f.calls, [ALBUM]);
      assert.equal(f.edits[0].files?.length, 1);
      assert.equal(f.input.targetMessage.content, ALBUM);
    }
  }
});

test('manual ordinary-channel permission is not inherited from another server and never enables DMs', async () => {
  for (const restriction of ['other-server', 'dm']) {
    const f = manual();
    f.input.channel.nsfw = false;
    if (restriction === 'dm') f.input.inGuild = () => false;
    await f.run({ serverPreferences: id => restriction === 'dm' || id !== GUILD ? { eromeChannels: 'all' } : {} });
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.edits, []);
    assert.equal(f.replies[0].flags, MessageFlags.Ephemeral);
  }
});

test('manual Erome preserves policy-specific revocation notices and source controls after preparation or verification', async () => {
  for (const context of [false, true]) for (const phase of ['preparation', 'verification']) {
    const f = manual(ALBUM, context);
    f.input.channel.nsfw = false;
    let preference: ServerPreferences['eromeChannels'] = 'all';
    await f.run({ serverPreferences: () => ({ eromeChannels: preference }), prepareErome: async () => {
      if (phase === 'preparation') preference = 'age-restricted';
      return prepared();
    }, verifyErome: async () => {
      if (phase === 'verification') preference = 'age-restricted';
      return true;
    } });
    if (phase === 'preparation') assert(f.edits.every(edit => !edit.files?.length));
    assert.match(bodyText(f.response), /Erome previews are no longer allowed/);
    assert.equal(f.input.targetMessage.content, ALBUM);
    const last = f.edits.at(-1)!;
    assert.deepEqual(last.attachments, []); assert.deepEqual(last.embeds, []);
    assert.equal(last.flags, phase === 'verification' ? MessageFlags.IsComponentsV2 : MessageFlags.SuppressEmbeds);
    assert.match(JSON.stringify(last.components), /Original post/);
    assert.match(JSON.stringify(last.components), /linky:remove-manual/);
    assert.deepEqual(last.allowedMentions, { parse: [] });
  }
});

test('manual Erome slash and message actions upload only the first album and preserve the source', async () => {
  for (const context of [false, true]) {
    const content = `${ALBUM} ${ALBUM}?tracking=1 ${SECOND}`;
    const f = manual(content, context);
    f.input.channel.isThread = () => true;
    f.input.channel.nsfw = false;
    f.input.channel.parent!.nsfw = true;
    await f.run();
    assert.deepEqual(f.calls, [ALBUM]);
    assert.equal(f.edits.length, 2);
    assert.equal(f.edits[0].files?.length, 1);
    assert.match(bodyText(f.response), /First of 2 videos/);
    assert.equal(f.input.targetMessage.content, content);
    assert.deepEqual(f.edits[0].allowedMentions, { parse: [] });
    assert.match(JSON.stringify(f.edits[0].components), /linky:remove-manual/);
  }
});

test('manual Erome stops upload if channel or parent age restriction changes during preparation', async () => {
  for (const thread of [false, true]) {
    const f = manual();
    f.input.channel.isThread = () => thread;
    f.input.channel.parent!.nsfw = thread;
    await f.run({ prepareErome: async () => {
      f.input.channel.nsfw = false;
      f.input.channel.parent!.nsfw = false;
      return prepared();
    } });
    assert(f.edits.every(edit => !edit.files?.length));
    assert.match(bodyText(f.response), /no longer allowed/);
  }
});

test('manual unavailable or throwing Erome preparation returns a useful failure with no upload', async () => {
  for (const fail of [false, true]) {
    const f = manual(ALBUM, true);
    await f.run({ prepareErome: async () => { if (fail) throw new Error('unavailable'); return null; } });
    assert(f.edits.every(edit => !edit.files?.length));
    assert.match(bodyText(f.response), /could not be prepared/);
    assert.equal(f.input.targetMessage.content, ALBUM);
  }
});

test('manual Erome removes an unverified attachment and keeps the original-post and Remove controls', async () => {
  const f = manual();
  await f.run({ verifyErome: async () => false });
  assert.equal(f.edits.length, 2);
  assert.deepEqual(f.edits[1].attachments, []);
  assert.match(bodyText(f.response), /preview could not be confirmed/);
  assert.match(JSON.stringify(f.edits[0].components), /Synthetic01/);
  assert.match(JSON.stringify(f.edits[0].components), /linky:remove-manual/);
});

test('manual mixed-platform failure is still reported when the Erome upload succeeds', async () => {
  const f = manual(`${ALBUM} https://x.com/jack/status/20`, true);
  await f.run();
  assert.match(bodyText(f.response), /preview could not be confirmed/);
  assert.equal(f.edits.filter(edit => edit.files?.length).length, 1);
  assert.equal(f.edits.at(-1)!.attachments, undefined, 'retain the independently verified video');
  assert.equal(f.input.targetMessage.content, `${ALBUM} https://x.com/jack/status/20`);
});

test('manual Erome serializes progress before the final upload and ignores late stage notifications', async t => {
  const clock = mockClock(t), staged = deferred(), ready = deferred();
  const f = manual(), started: InteractionEditReplyOptions[] = [];
  let release!: () => void, late: EromeProgress | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const editReply = f.input.editReply;
  f.input.editReply = async options => {
    started.push(options);
    if (started.length === 1) await gate;
    return editReply(options);
  };
  const pending = f.run({ prepareErome: async (_url, onStage) => {
    late = onStage;
    void onStage?.('queued');
    void onStage?.('downloading');
    void onStage?.('preparing');
    staged.resolve();
    await ready.promise;
    return prepared();
  } });
  try {
    await reached(staged.promise, pending, 'attachment preparation');
    await clock.advance(FIX_PROGRESS_DELAY_MS - 1);
    assert.equal(started.length, 0, 'no progress edit before the delay elapses');
    await clock.advance(1);
    assert.equal(started.length, 1, 'the coalesced progress edit starts at the delay');
    // Preparation finishes while that edit is still in flight; later intervals must not start another.
    ready.resolve();
    await clock.advance(FIX_PROGRESS_DELAY_MS * 4);
    assert.equal(started.length, 1, 'Only one progress edit may be in flight');
    assert.match(String(started[0].content), /preparing/i);
    assert.equal(started[0].files, undefined);
    release();
    await clock.settle(pending);
    assert.equal(f.edits.length, 3);
    assert.equal(f.edits[1].files?.length, 1);
    assert(f.edits.slice(0, 1).every(edit => !String(edit.content).includes('https://') && !edit.files));
    await late?.('queued');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.edits.length, 3, 'A late progress edit must not replace the uploaded preview');
    assert.match(bodyText(f.response), /Synthetic01/);
  } finally { release(); ready.resolve(); await clock.settle(pending).catch(() => {}); }
});

test('manual Erome completes despite rejected progress edits for a deleted or inaccessible reply', async t => {
  const clock = mockClock(t), staged = deferred(), ready = deferred();
  const f = manual(), editReply = f.input.editReply;
  let progressAttempts = 0;
  f.input.editReply = async options => {
    if (!options.files?.length && !options.components?.length) { progressAttempts++; throw new Error('Unknown message'); }
    return editReply(options);
  };
  const pending = f.run({ prepareErome: async (_url, onStage) => {
    await onStage?.('cached');
    staged.resolve();
    await ready.promise;
    return prepared();
  } });
  try {
    await reached(staged.promise, pending, 'attachment preparation');
    await clock.advance(FIX_PROGRESS_DELAY_MS - 1);
    assert.equal(progressAttempts, 0, 'no progress edit before the delay elapses');
    await clock.advance(1);
    assert.equal(progressAttempts, 1, 'the progress edit is attempted at the delay');
    ready.resolve();
    await clock.settle(pending);
  } finally { ready.resolve(); await clock.settle(pending).catch(() => {}); }
  assert.equal(progressAttempts, 1);
  assert.equal(f.edits.length, 2);
  assert.equal(f.edits[0].files?.length, 1);
  assert.match(bodyText(f.response), /Synthetic01/);
});

test('prepared Erome panels fail closed when Discord omits their gallery', async () => {
  const f = automatic(), send = f.channel.send;
  f.channel.send = async options => {
    const result = await send(options);
    Object.assign(result, { components: [] });
    return result;
  };
  await f.run();
  assert.equal(f.state.originalDeleted, false);
  assert.equal(f.outputs[0].deleted, true);
  for (const context of [false, true]) {
    const m = manual(ALBUM, context), edit = m.input.editReply;
    m.input.editReply = async options => {
      const result = await edit(options);
      if (options.files?.length) m.response.components = [];
      return result;
    };
    await m.run();
    const last = m.edits.at(-1)!;
    assert.deepEqual(last.attachments, []);
    assert.doesNotMatch(JSON.stringify(last.components), /attachment:\/\/linky-video.mp4/);
    assert.equal(last.flags, MessageFlags.IsComponentsV2);
  }
});

test('prepared Erome galleries require the exact uploaded media with Discord type, proxy and positive dimensions', async () => {
  const { file } = prepared();
  const good = { url: 'attachment://linky-video.mp4', content_type: 'video/mp4', proxy_url: 'https://media.discordapp.net/proxy',
    width: 1280, height: 720 };
  const variants = [good, { ...good, url: 'attachment://unrelated.mp4' }, { ...good, content_type: 'text/html' },
    { ...good, proxy_url: '' }, { ...good, width: 0 }, { ...good, height: -1 },
    { ...good, url: 'https://evil.com/attachments/123456789012345678/123456789012345679/linky-video.mp4' }];
  for (const [index, media] of variants.entries()) {
    const value = { components: [{ toJSON: () => ({ type: ComponentType.Container, components: [
      { type: ComponentType.MediaGallery, items: [{ media }] },
    ] }) }], attachments: new Collection<string, Attachment>(), fetch: async () => value as unknown as Message };
    assert.equal(await verifyEromeAttachment(value as unknown as Message, file, async () => {}), index === 0, JSON.stringify(media));
  }
});

test('manual Erome rechecks source, settings and cancellation after the final asynchronous media verification', async () => {
  for (const context of [false, true]) for (const change of ['source', 'settings', 'cancelled']) {
    const f = manual(ALBUM, context), controller = new AbortController();
    let enabled = true, verifications = 0;
    await f.run({ signal: controller.signal, serverPreferences: () => ({ platforms: { erome: enabled } }),
      verifyErome: async () => {
        if (++verifications === 2) {
          if (change === 'settings') enabled = false;
          if (change === 'source' && context) f.input.targetMessage.content += ' edited';
          if (change === 'cancelled') controller.abort();
        }
        return true;
      } });
    assert.equal(verifications, 2);
    if (change === 'source' && !context) continue; // Slash commands have no mutable source message.
    const last = f.edits.at(-1)!;
    assert.deepEqual(last.attachments, [], `${context}/${change}`);
    assert.equal(last.flags, MessageFlags.IsComponentsV2);
    assert.doesNotMatch(JSON.stringify(last.components), /attachment:\/\/linky-video.mp4/);
  }
});

function attachmentMessage(attachments: Partial<Attachment>[]) {
  const value = { attachments: new Collection(attachments.map((item, index) => [String(index), item as Attachment])),
    fetch: async (_force?: boolean) => value as unknown as Awaited<ReturnType<Message['fetch']>> };
  return value;
}

test('image attachments use image metadata and do not claim video compression', async () => {
  for (const [name, contentType] of [['linky-image.png', 'image/png'], ['linky-image.jpg', 'image/jpeg']]) {
    const file = new AttachmentBuilder(Buffer.from('validated image'), { name });
    const message = attachmentMessage([{ name, size: 15, contentType, width: 640, height: 480 }]);
    assert.equal(await verifyEromeAttachment(message, file, async () => {}), true);
  }
  assert.match(eromeNotice(0, 'image'), /Original image quality/);
  assert.doesNotMatch(eromeNotice(0, 'image'), /video|compressed/i);
});

test('manual Erome does not upload when its deadline expires while a progress edit drains', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = manual(), outcomes: DeliveryOutcome[] = [];
  const diagnostics = diagnosticsStub({ outcomes });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const editReply = f.input.editReply;
  let first = true;
  f.input.editReply = async options => {
    if (first) { first = false; entered(); await gate; }
    return editReply(options);
  };
  const pending = f.run({ diagnostics, prepareErome: async (_source, onStage) => {
    onStage?.('preparing');
    t.mock.timers.tick(FIX_PROGRESS_DELAY_MS);
    await started;
    return prepared();
  }, verifyErome: async () => assert.fail('Expired work must not upload or verify a video') });
  // Fail rather than hang if the progress edit did not start at the delay.
  await Promise.race([started, nextTurn().then(() => assert.fail('the progress edit starts at the delay'))]);
  await nextTurn();
  t.mock.timers.tick(120_000);
  release();
  await pending;
  assert.ok(f.edits.every(edit => !edit.files?.length));
  assert.match(bodyText(f.response), /time limit/);
  assert.deepEqual(outcomes, ['timeout']);
  assert.equal(f.input.targetMessage.content, ALBUM);
});

test('Erome attachment verification rejects thumbnails, unrelated names, mismatched sizes and incomplete video metadata', async () => {
  const file = prepared().file;
  const good = { name: file.name!, size: (file.attachment as Buffer).length, contentType: 'video/mp4', width: 640, height: 360 };
  for (const attachment of [
    { ...good, contentType: 'image/jpeg' }, { ...good, name: 'another-video.mp4' },
    { ...good, size: good.size + 1 }, { ...good, width: null }, { ...good, height: 0 },
  ]) {
    const message = attachmentMessage([attachment]);
    const waits: number[] = [];
    assert.equal(await verifyEromeAttachment(message, file, async ms => { waits.push(ms); }), false);
    assert.deepEqual(waits, [1000, 2000, 3000]);
  }
});

test('Erome attachment verification accepts matching Discord MP4 metadata when it becomes available', async () => {
  const file = prepared().file, message = attachmentMessage([]);
  const waits: number[] = [];
  let polls = 0;
  message.fetch = async force => {
    assert.equal(force, true);
    if (++polls === 2) message.attachments.set('video', { name: file.name!, size: (file.attachment as Buffer).length,
      contentType: 'video/mp4', width: 640, height: 360 } as Attachment);
    return message as unknown as Awaited<ReturnType<Message['fetch']>>;
  };
  assert.equal(await verifyEromeAttachment(message, file, async ms => { waits.push(ms); }), true);
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(polls, 2);
});
