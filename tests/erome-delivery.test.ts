import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AttachmentBuilder, Collection, MessageFlags, MessageFlagsBitField, MessageType, PermissionFlagsBits,
  PermissionsBitField, type Attachment, type ChatInputCommandInteraction, type InteractionEditReplyOptions,
  type Message, type MessageContextMenuCommandInteraction, type MessageCreateOptions, type MessageEditOptions } from 'discord.js';
import type { Config } from '../src/config';
import { execute } from '../src/commands/fix';
import { createLinkRepostHandler } from '../src/services/SocialLinkService';
import { verifyEromeAttachment, type EromeProgress } from '../src/services/EromeDelivery';
import type { RepostRecord } from '../src/services/RepostRegistry';
import type { ServerPreferences } from '../src/services/ServerSettings';

const GUILD = '1700000000000000001', CHANNEL = '1700000000000000002';
const AUTHOR = '1700000000000000003', BOT = '1700000000000000004', SOURCE = '1700000000000000005';
const ALBUM = 'https://www.erome.com/a/Synthetic01', SECOND = 'https://www.erome.com/a/Synthetic02';
const config: Config = { discordToken: '', channelIds: [], serverIds: [], rewritePlatforms: ['erome', 'x'],
  translateTweets: false, settingsPath: 'unused' };
const prepared = () => ({ file: new AttachmentBuilder(Buffer.from('synthetic MP4 test fixture'), { name: 'linky-video.mp4' }), videoCount: 2 });
type AutoOptions = NonNullable<Parameters<typeof createLinkRepostHandler>[3]>;
type ManualOptions = NonNullable<Parameters<typeof execute>[2]>;

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
    guild: { members: { me: { id: BOT } } }, channel, inGuild: () => true,
    partial: false, webhookId: null, type: MessageType.Default, poll: null, pinned: false, hasThread: false,
    stickers: new Collection(), components: [], messageSnapshots: new Collection(),
    attachments: new Collection<string, Attachment>(), flags: new MessageFlagsBitField(), editedTimestamp: null,
    reference: null, deletable: true, fetch: async () => source as unknown as Message,
    delete: async () => { state.originalDeleted = true; },
  };
  const run = (options: AutoOptions = {}) => createLinkRepostHandler([], { info() {}, warn() {}, error() {} },
    async () => assert.fail('Source attachment downloads are forbidden for album replies'), {
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
  const response = { id: SOURCE, content: '', fetch: async () => response };
  const input = {
    isChatInputCommand: () => !context, inGuild: () => true, guildId: GUILD, channel: ageChannel(),
    memberPermissions: new PermissionsBitField(PermissionsBitField.All),
    appPermissions: new PermissionsBitField(PermissionsBitField.All),
    options: { getString: () => content },
    targetMessage: { content, author: { id: AUTHOR },
      delete: () => assert.fail('Manual previews must preserve their source'),
      edit: () => assert.fail('Manual previews must not edit their source') },
    reply: async (options: { content?: string; flags?: unknown }) => { replies.push(options); },
    deferReply: async (options: unknown) => { deferrals.push(options); },
    editReply: async (options: InteractionEditReplyOptions) => {
      edits.push(options);
      if (typeof options.content === 'string') response.content = options.content;
      return response as unknown as Message;
    },
  };
  const run = (options: ManualOptions = {}) => execute(input as unknown as ChatInputCommandInteraction | MessageContextMenuCommandInteraction,
    config, { prepareErome: async url => { calls.push(url); return prepared(); }, verifyErome: async () => true,
      verifyPreview: async (_message, expected) => ({ ok: false, missing: [...expected], videoMetadata: false }), ...options });
  return { input, calls, replies, edits, deferrals, response, run };
}

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
    assert.equal(f.state.originalDeleted, false);
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

test('automatic Erome replies preserve the complete source in both modes and inherit thread age restriction', async () => {
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
      assert.deepEqual(f.outputs[0].options.reply, { messageReference: SOURCE, failIfNotExists: true });
      assert.match(f.outputs[0].options.content!, /First of 2 videos/);
      assert.equal(f.outputs[0].deleted, false);
      assert.equal(f.source.content, content);
      assert.equal(f.state.originalDeleted, false);
      assert.deepEqual(f.records, [{ guildId: GUILD, channelId: CHANNEL, sourceId: SOURCE,
        replacementId: String(BigInt(SOURCE) + 1n), authorId: AUTHOR, mode: 'reply' }]);
      assert.match(JSON.stringify(f.outputs[0].edits.at(-1)), /linky:remove/);
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

test('automatic unavailable or throwing Erome preparation preserves source without publishing', async () => {
  for (const fail of [false, true]) {
    const f = automatic();
    await f.run({ prepareErome: async () => { if (fail) throw new Error('unavailable'); return null; } });
    assert.deepEqual(f.outputs, []);
    assert.deepEqual(f.records, []);
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

test('manual Erome rechecks a revoked server policy after preparation', async () => {
  const f = manual();
  f.input.channel.nsfw = false;
  let preference: ServerPreferences['eromeChannels'] = 'all';
  await f.run({ serverPreferences: () => ({ eromeChannels: preference }), prepareErome: async () => {
    preference = 'age-restricted';
    return prepared();
  } });
  assert(f.edits.every(edit => !edit.files?.length));
  assert.match(f.response.content, /could not be prepared/);
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
    assert.equal(f.edits.length, 1);
    assert.equal(f.edits[0].files?.length, 1);
    assert.match(f.response.content, /First of 2 videos/);
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
    assert.match(f.response.content, /could not be prepared/);
  }
});

test('manual unavailable or throwing Erome preparation returns a useful failure with no upload', async () => {
  for (const fail of [false, true]) {
    const f = manual(ALBUM, true);
    await f.run({ prepareErome: async () => { if (fail) throw new Error('unavailable'); return null; } });
    assert(f.edits.every(edit => !edit.files?.length));
    assert.match(f.response.content, /could not be prepared/);
    assert.equal(f.input.targetMessage.content, ALBUM);
  }
});

test('manual Erome removes an unverified attachment and keeps the original-post and Remove controls', async () => {
  const f = manual();
  await f.run({ verifyErome: async () => false });
  assert.equal(f.edits.length, 2);
  assert.deepEqual(f.edits[1].attachments, []);
  assert.match(f.response.content, /preview could not be confirmed/);
  assert.match(JSON.stringify(f.edits[0].components), /Synthetic01/);
  assert.match(JSON.stringify(f.edits[0].components), /linky:remove-manual/);
});

test('manual mixed-platform failure is still reported when the Erome upload succeeds', async () => {
  const f = manual(`${ALBUM} https://x.com/jack/status/20`, true);
  await f.run();
  assert.match(f.response.content, /preview could not be confirmed/);
  assert.equal(f.edits.filter(edit => edit.files?.length).length, 1);
  assert.equal(f.edits.at(-1)!.attachments, undefined, 'retain the independently verified video');
  assert.equal(f.input.targetMessage.content, `${ALBUM} https://x.com/jack/status/20`);
});

test('manual Erome serializes progress before the final upload and ignores late stage notifications', async () => {
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
    return prepared();
  } });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(started.length, 1, 'Only one progress edit may be in flight');
    assert.match(String(started[0].content), /queued/i);
    assert.equal(started[0].files, undefined);
    release();
    await pending;
    assert.equal(f.edits.length, 4);
    assert.match(String(f.edits[1].content), /downloading/i);
    assert.match(String(f.edits[2].content), /preparing/i);
    assert.equal(f.edits[3].files?.length, 1);
    assert(f.edits.slice(0, 3).every(edit => !String(edit.content).includes('https://') && !edit.files));
    await late?.('queued');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.edits.length, 4, 'A late progress edit must not replace the uploaded preview');
    assert.match(f.response.content, /Synthetic01/);
  } finally { release(); await pending; }
});

test('manual Erome completes despite rejected progress edits for a deleted or inaccessible reply', async () => {
  const f = manual(), editReply = f.input.editReply;
  let progressAttempts = 0;
  f.input.editReply = async options => {
    if (!options.files?.length) { progressAttempts++; throw new Error('Unknown message'); }
    return editReply(options);
  };
  await f.run({ prepareErome: async (_url, onStage) => {
    await onStage?.('cached');
    return prepared();
  } });
  assert.equal(progressAttempts, 1);
  assert.equal(f.edits.length, 1);
  assert.equal(f.edits[0].files?.length, 1);
  assert.match(f.response.content, /Synthetic01/);
});

function attachmentMessage(attachments: Partial<Attachment>[]) {
  const value = { attachments: new Collection(attachments.map((item, index) => [String(index), item as Attachment])),
    fetch: async (_force?: boolean) => value as unknown as Awaited<ReturnType<Message['fetch']>> };
  return value;
}

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
