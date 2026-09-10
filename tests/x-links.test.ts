import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Attachment,
  AttachmentBuilder,
  AttachmentFlagsBitField,
  Collection,
  Message,
  MessageCreateOptions,
  MessageFlags,
  MessageFlagsBitField,
  MessageType,
  PermissionFlagsBits,
  PermissionsBitField,
} from 'discord.js';
import {
  createXLinkHandler,
  downloadAttachment,
  formatXLinkRepost,
  parseFixupXChannelId,
  parseFixupXChannelIds,
  parseRewritePlatforms,
  rewriteSocialLinks,
} from '../src/services/XLinkService';

const CHANNEL_ID = '123456789012345678';
const SECOND_CHANNEL_ID = '223456789012345678';
const AUTHOR_ID = '777777777777777777';
const QUOTED_CREDIT = `> **Shared by <@${AUTHOR_ID}>**`;

test('quoted layout places plain leading context above a native URL', () => {
  const body = "Discord's May patch notes. https://x.com/discord/status/1";
  assert.equal(formatXLinkRepost(rewriteSocialLinks(body), AUTHOR_ID),
    `${QUOTED_CREDIT}\n> Discord's May patch notes.\nhttps://fixupx.com/discord/status/1`);
  assert.equal(formatXLinkRepost('https://fixupx.com/discord/status/1', AUTHOR_ID),
    `${QUOTED_CREDIT}\nhttps://fixupx.com/discord/status/1`);
  assert.equal(formatXLinkRepost('Only context, with no URL.', AUTHOR_ID),
    `${QUOTED_CREDIT}\nOnly context, with no URL.`);
});

test('quoted layout preserves multiline context and all text after the first URL', () => {
  const body = 'First line\nSecond line\nhttps://x.com/a\nAfter the first link. https://x.com/b  \n';
  assert.equal(formatXLinkRepost(rewriteSocialLinks(body), AUTHOR_ID),
    `${QUOTED_CREDIT}\n> First line\n> Second line\nhttps://fixupx.com/a\nAfter the first link. https://fixupx.com/b  \n`);
  assert.equal(formatXLinkRepost(rewriteSocialLinks('Compare https://x.com/a with https://x.com/b then decide.'), AUTHOR_ID),
    `${QUOTED_CREDIT}\n> Compare\nhttps://fixupx.com/a with https://fixupx.com/b then decide.`);
});

test('quoted layout preserves an unrelated first URL and nested URLs in its query', () => {
  const body = 'Read http://example.test/?next=(https://x.com/a) then https://x.com/b';
  assert.equal(formatXLinkRepost(rewriteSocialLinks(body), AUTHOR_ID),
    `${QUOTED_CREDIT}\n> Read\nhttp://example.test/?next=(https://x.com/a) then https://fixupx.com/b`);
});

test('quoted layout leaves existing Markdown and link wrappers intact beneath the credit', () => {
  for (const body of [
    '**Bold context** https://x.com/a', '_Emphasis_ https://x.com/a',
    '[Read this](https://x.com/a) and then https://x.com/b',
    'Code sample:\n```text\nhttps://x.com/a\n```\nAfter the fence.',
    '`https://x.com/a`', '> Existing quotation\nhttps://x.com/a',
    '> https://x.com/a', '>>> Existing multiline quotation\nhttps://x.com/a',
    '||Spoiler https://x.com/a||', 'Read <https://x.com/a>',
    '- List item\nhttps://x.com/a', '1. Ordered item\nhttps://x.com/a',
    '# Heading\nhttps://x.com/a', 'Escaped \\*asterisk https://x.com/a',
  ]) {
    const rewritten = rewriteSocialLinks(body);
    assert.equal(formatXLinkRepost(rewritten, AUTHOR_ID), `${QUOTED_CREDIT}\n${rewritten}`, body);
  }
});

test('quoted layout preserves complex whitespace without trimming or reordering', () => {
  for (const body of [
    '  Indented context https://x.com/a', 'Context  https://x.com/a',
    'Context\n\nhttps://x.com/a', 'Context \nhttps://x.com/a',
    'Context\t https://x.com/a', 'Context\r\nhttps://x.com/a',
    'Context\u00a0https://x.com/a', '\nhttps://x.com/a',
  ]) {
    const rewritten = rewriteSocialLinks(body);
    assert.equal(formatXLinkRepost(rewritten, AUTHOR_ID), `${QUOTED_CREDIT}\n${rewritten}`, body);
  }
});

test('rewrites links while preserving text, punctuation, paths and fragments, and dropping queries', () => {
  const original = 'See [this](HTTPS://X.COM/user/status/1?a=%2F+b&c=2#part), ' +
    '<https://x.com/u/status/2> and https://x.com.\nKeep @everyone and **text**.';
  assert.equal(rewriteSocialLinks(original),
    'See [this](https://fixupx.com/user/status/1#part), ' +
    '<https://fixupx.com/u/status/2> and https://fixupx.com.\nKeep @everyone and **text**.');
  assert.equal(rewriteSocialLinks('[a](https://x.com/a)[b](https://x.com/b)'),
    '[a](https://fixupx.com/a)[b](https://fixupx.com/b)');
});

test('strips the tracking query string, including any share params or nested URLs within it', () => {
  const original = 'https://x.com/venturetwins/status/2097769059937047002?s=46&t=JnU-mg-_ruRIqJJQHP3cxg';
  assert.equal(rewriteSocialLinks(original), 'https://fixupx.com/venturetwins/status/2097769059937047002');
  for (const nested of ['(https://x.com/a)', '[https://x.com/a]', '{https://x.com/a}', '([https://x.com/a])']) {
    assert.equal(rewriteSocialLinks(`https://x.com/a?url=${nested}`), 'https://fixupx.com/a');
    // A query on an unrelated host is untouched — only x.com links have their query dropped.
    assert.equal(rewriteSocialLinks(`https://other.test/?url=${nested}`), `https://other.test/?url=${nested}`);
  }
  assert.equal(rewriteSocialLinks('[a](https://x.com/a?x=(https://x.com/b))[b](https://x.com/c)'),
    '[a](https://fixupx.com/a)[b](https://fixupx.com/c)');
});

for (const url of [
  'https://x.com.evil/status/1', 'https://www.x.com/status/1',
  'https://x.com@evil.test/a', 'https://evil@x.com/a',
  'https://x.com:443/a', 'https://x.com:8443/a', 'https://x.com./a',
  'https://х.com/a', 'https://x．com/a', 'https://x.com\\@evil.test',
  'http://x.com/a', 'ftp://x.com/a', 'x.com/a', 'https://fixupx.com/a',
  'https://other.test/?url=https://x.com/a',
  'http://other.test/?url=https://x.com/a',
  // Instagram and TikTok inherit the same authority rules.
  'https://instagram.com.evil/p/abc', 'https://evil@instagram.com/p/abc',
  'https://instagram.com@evil.test/p/abc', 'https://instagram.com:443/p/abc',
  'http://instagram.com/p/abc', 'https://kkclip.com/p/abc',
  'https://tiktok.com.evil/@user/video/1', 'https://evil@tiktok.com/@user/video/1',
  'https://tiktok.com:443/@user/video/1', 'http://tiktok.com/@user/video/1',
  'https://tnktok.com/@user/video/1',
  // Profiles and index pages gain nothing from an embed fixer.
  'https://instagram.com/username', 'https://www.instagram.com/', 'https://instagram.com',
  'https://tiktok.com/@username', 'https://www.tiktok.com/', 'https://tiktok.com',
  'https://tiktok.com/@user/video/notanumber',
  'https://tiktok.com/@user/video/123oops',
  'https://tiktok.com/@user/video/123/extra',
  'https://tiktok.com/v/7412345678901234567',
  'https://tiktok.com/v/7412345678901234567.html',
  'https://instagram.com/p/code/extra',
  'https://instagram.com/p/code%2Fextra',
]) {
  test(`leaves nonmatching URL untouched: ${url}`, () => {
    assert.equal(rewriteSocialLinks(url), url);
  });
}

for (const [original, expected] of [
  ['https://instagram.com/p/DAbc-1_x/', 'https://kkclip.com/p/DAbc-1_x/'],
  ['https://www.instagram.com/reel/DAbc123/', 'https://kkclip.com/reel/DAbc123/'],
  ['https://m.instagram.com/reels/DAbc123', 'https://kkclip.com/reels/DAbc123'],
  ['https://mobile.instagram.com/tv/DAbc123', 'https://kkclip.com/tv/DAbc123'],
  ['https://instagram.com/share/DAbc123', 'https://kkclip.com/share/DAbc123'],
  // Mobile share links arrive as www with an igsh tracking param.
  ['https://www.instagram.com/reel/DAbc123/?igsh=MXY2cWZ4ZzZ4', 'https://kkclip.com/reel/DAbc123/'],
  ['https://tiktok.com/@user.name/video/7412345678901234567',
    'https://tnktok.com/@user.name/video/7412345678901234567'],
  ['https://www.tiktok.com/@user/photo/7412345678901234567',
    'https://tnktok.com/@user/photo/7412345678901234567'],
  ['https://m.tiktok.com/t/ZGdFhBqWK', 'https://tnktok.com/t/ZGdFhBqWK'],
  ['https://vm.tiktok.com/ZGdFhBqWK/', 'https://tnktok.com/ZGdFhBqWK/'],
  ['https://vt.tiktok.com/ZGdFhBqWK', 'https://tnktok.com/ZGdFhBqWK'],
  ['https://vm.tiktok.com/ZGdFhBqWK/?share=1#part?detail', 'https://tnktok.com/ZGdFhBqWK/#part?detail'],
  ['https://vt.tiktok.com/ZGdFhBqWK#part', 'https://tnktok.com/ZGdFhBqWK#part'],
  ['https://www.tiktok.com/@user/video/7412345678901234567?is_from_webapp=1&sender_device=pc',
    'https://tnktok.com/@user/video/7412345678901234567'],
] as const) {
  test(`rewrites to the fixer apex: ${original}`, () => {
    assert.equal(rewriteSocialLinks(original), expected);
  });
}

test('platform names select which hosts are rewritten', () => {
  const body = 'https://x.com/u/status/1 https://instagram.com/p/abc https://tiktok.com/@u/video/1';
  assert.equal(rewriteSocialLinks(body, ['x']),
    'https://fixupx.com/u/status/1 https://instagram.com/p/abc https://tiktok.com/@u/video/1');
  assert.equal(rewriteSocialLinks(body, ['instagram', 'tiktok']),
    'https://x.com/u/status/1 https://kkclip.com/p/abc https://tnktok.com/@u/video/1');
  assert.equal(rewriteSocialLinks(body, []), body);
});

test('platform configuration defaults to every platform and rejects unknown names', () => {
  assert.deepEqual(parseRewritePlatforms(undefined), ['x', 'instagram', 'tiktok']);
  assert.deepEqual(parseRewritePlatforms('  '), ['x', 'instagram', 'tiktok']);
  assert.deepEqual(parseRewritePlatforms(' tiktok , x '), ['tiktok', 'x']);
  assert.deepEqual(parseRewritePlatforms('x,x'), ['x']);
  for (const invalid of ['twitter', 'x,', ',x', 'x,,tiktok', 'X', 'all']) {
    assert.throws(() => parseRewritePlatforms(invalid), /REWRITE_PLATFORMS/);
  }
});

test('channel configuration defaults off and rejects invalid scope', () => {
  assert.equal(parseFixupXChannelId(undefined), undefined);
  assert.equal(parseFixupXChannelId('  '), undefined);
  assert.equal(parseFixupXChannelId(` ${CHANNEL_ID} `), CHANNEL_ID);
  for (const invalid of ['all', '*', '#general', '123', `${CHANNEL_ID},987654321098765432`]) {
    assert.throws(() => parseFixupXChannelId(invalid), /FIXUPX_CHANNEL_ID/);
  }
});

test('channel list combines and deduplicates explicit IDs with the legacy setting', () => {
  assert.deepEqual(parseFixupXChannelIds(undefined), []);
  assert.deepEqual(parseFixupXChannelIds('  ', '  '), []);
  assert.deepEqual(parseFixupXChannelIds(undefined, ` ${CHANNEL_ID} `), [CHANNEL_ID]);
  assert.deepEqual(parseFixupXChannelIds(` ${CHANNEL_ID}, ${SECOND_CHANNEL_ID} `), [CHANNEL_ID, SECOND_CHANNEL_ID]);
  assert.deepEqual(parseFixupXChannelIds(` ${SECOND_CHANNEL_ID}, ${CHANNEL_ID}, ${SECOND_CHANNEL_ID} `, CHANNEL_ID),
    [CHANNEL_ID, SECOND_CHANNEL_ID]);
});

test('malformed channel list entries fail closed even with a valid legacy channel', () => {
  for (const invalid of [
    ',', `,${CHANNEL_ID}`, `${CHANNEL_ID},`, `${CHANNEL_ID},,${SECOND_CHANNEL_ID}`,
    `${CHANNEL_ID}, ,${SECOND_CHANNEL_ID}`, `${CHANNEL_ID},all`, `${CHANNEL_ID},*`,
    `${CHANNEL_ID},#general`, `${CHANNEL_ID},123`, `${CHANNEL_ID};${SECOND_CHANNEL_ID}`,
  ]) {
    assert.throws(() => parseFixupXChannelIds(invalid, CHANNEL_ID), /FIXUPX_CHANNEL_IDS/);
  }
  assert.throws(() => parseFixupXChannelIds(CHANNEL_ID, 'all'), /FIXUPX_CHANNEL_ID/);
});

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'file-1', name: 'photo.png', description: 'A photo', size: 3,
    spoiler: false, ephemeral: false, url: 'https://cdn.discordapp.com/test/photo.png',
    flags: new AttachmentFlagsBitField(),
    ...overrides,
  } as Attachment;
}

function fixture() {
  const events: string[] = [];
  const sent: MessageCreateOptions[] = [];
  const logs: unknown[] = [];
  const log = { info: (...args: unknown[]) => { logs.push(args); },
    warn: (...args: unknown[]) => { logs.push(args); },
    error: (...args: unknown[]) => { logs.push(args); } };
  const permissions = new PermissionsBitField(PermissionsBitField.All);
  const replacement = {
    id: 'replacement-1', attachments: new Collection<string, Attachment>(),
    delete: async () => { events.push('delete replacement'); },
  };
  const source = {
    id: '123456789012345679', channelId: CHANNEL_ID, guildId: '987654321098765432',
    content: 'Look https://x.com/user/status/1?q=%2F+ok#part @everyone <@&999> <@888>',
    author: { id: '777777777777777777', bot: false },
    guild: { members: { me: { id: 'bot-1' } } },
    partial: false, webhookId: null as string | null, type: MessageType.Default,
    poll: null as unknown, pinned: false, hasThread: false, editedTimestamp: null as number | null,
    stickers: new Collection<string, unknown>(), components: [] as unknown[],
    messageSnapshots: new Collection<string, unknown>(),
    flags: new MessageFlagsBitField(), attachments: new Collection<string, Attachment>(),
    reference: null as { messageId: string; channelId?: string } | null,
    deletable: true,
    inGuild: () => true,
    channel: {
      isSendable: () => true, isThread: () => false,
      permissionsFor: () => permissions,
      send: async (options: MessageCreateOptions) => {
        events.push('send'); sent.push(options);
        replacement.attachments = source.attachments.clone();
        return replacement;
      },
    },
    fetch: async (_force: boolean) => { events.push('fetch'); return source; },
    delete: async () => { events.push('delete original'); },
  };
  const handler = createXLinkHandler(CHANNEL_ID, log);
  return { source, replacement, handler, log, logs, permissions, events, sent,
    run: () => handler(source as unknown as Message) };
}

test('reposts with credit and all mentions disabled, then fetches and deletes original', async () => {
  const f = fixture();
  await f.run();
  assert.deepEqual(f.events, ['send', 'fetch', 'delete original']);
  assert.equal(f.sent[0].content,
    `${QUOTED_CREDIT}\n> Look\nhttps://fixupx.com/user/status/1#part @everyone <@&999> <@888>`);
  assert.deepEqual(f.sent[0].allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
  assert.equal(f.sent[0].nonce, f.source.id);
  assert.equal(f.sent[0].enforceNonce, true);
  assert.equal(f.sent[0].reply, undefined);
  assert.equal(f.sent[0].embeds, undefined);
  assert.equal(f.sent[0].flags, undefined);
});

test('retains reply context in attribution without replying to the original', async () => {
  const f = fixture();
  f.source.type = MessageType.Reply;
  f.source.reference = { messageId: 'parent-1' };
  await f.run();
  assert.match(f.sent[0].content!, /reply to https:\/\/discord.com\/channels\/987654321098765432\/123456789012345678\/parent-1/);
  assert.ok(f.sent[0].content?.startsWith(`${QUOTED_CREDIT} (reply to `));
  assert.ok(f.sent[0].content?.includes('\n> Look\nhttps://fixupx.com/'));
  assert.equal(f.sent[0].reply, undefined);
});

test('one handler processes two exact channels in different guilds and ignores unrelated channels', async () => {
  const first = fixture();
  const second = fixture();
  second.source.id = '223456789012345679';
  second.source.channelId = SECOND_CHANNEL_ID;
  second.source.guildId = '887654321098765432';
  second.source.type = MessageType.Reply;
  second.source.reference = { messageId: 'parent-2' };
  const unrelated = fixture();
  unrelated.source.id = '323456789012345679';
  unrelated.source.channelId = '323456789012345678';
  const handler = createXLinkHandler([CHANNEL_ID, SECOND_CHANNEL_ID], first.log);

  await handler(first.source as unknown as Message);
  await handler(second.source as unknown as Message);
  await handler(unrelated.source as unknown as Message);

  assert.deepEqual(first.events, ['send', 'fetch', 'delete original']);
  assert.deepEqual(second.events, ['send', 'fetch', 'delete original']);
  assert.deepEqual(unrelated.events, []);
  assert.ok(second.sent[0].content?.includes(`reply to https://discord.com/channels/887654321098765432/${SECOND_CHANNEL_ID}/parent-2`));
});

test('both configured channels use the same quoted layout', async () => {
  const first = fixture();
  const second = fixture();
  second.source.id = '223456789012345679';
  second.source.channelId = SECOND_CHANNEL_ID;
  second.source.guildId = '887654321098765432';
  const handler = createXLinkHandler([CHANNEL_ID, SECOND_CHANNEL_ID], first.log);
  await handler(first.source as unknown as Message);
  await handler(second.source as unknown as Message);
  assert.equal(first.sent[0].content, second.sent[0].content);
  assert.ok(first.sent[0].content?.startsWith(`${QUOTED_CREDIT}\n> Look\n`));
  assert.deepEqual(first.sent[0].allowedMentions, second.sent[0].allowedMentions);
});

test('the 2000-character limit includes credit and every quote prefix', async () => {
  const url = 'https://fixupx.com/a';
  const fixedText = `${QUOTED_CREDIT}\n> First line\n> \n${url}`;
  const padding = 'a'.repeat(2000 - fixedText.length);
  const fitting = fixture();
  fitting.source.content = `First line\n${padding}\nhttps://x.com/a`;
  await fitting.run();
  assert.deepEqual(fitting.events, ['send', 'fetch', 'delete original']);
  assert.equal(fitting.sent[0].content?.length, 2000);
  assert.equal(fitting.sent[0].content, `${QUOTED_CREDIT}\n> First line\n> ${padding}\n${url}`);

  const oversized = fixture();
  oversized.source.content = `First line\n${padding}a\nhttps://x.com/a`;
  await oversized.run();
  assert.deepEqual(oversized.events, []);
});

for (const [name, change] of Object.entries({
  'another channel': (f: ReturnType<typeof fixture>) => { f.source.channelId = 'other'; },
  'DM': (f: ReturnType<typeof fixture>) => { f.source.inGuild = () => false; },
  'bot': (f: ReturnType<typeof fixture>) => { f.source.author.bot = true; },
  'webhook': (f: ReturnType<typeof fixture>) => { f.source.webhookId = 'webhook-1'; },
  'partial': (f: ReturnType<typeof fixture>) => { f.source.partial = true; },
  'system message': (f: ReturnType<typeof fixture>) => { f.source.type = MessageType.ChannelPinnedMessage; },
  'poll': (f: ReturnType<typeof fixture>) => { f.source.poll = {}; },
  'sticker': (f: ReturnType<typeof fixture>) => { f.source.stickers.set('sticker-1', {}); },
  'forward': (f: ReturnType<typeof fixture>) => { f.source.messageSnapshots.set('snapshot-1', {}); },
  'components': (f: ReturnType<typeof fixture>) => { f.source.components.push({}); },
  'pinned message': (f: ReturnType<typeof fixture>) => { f.source.pinned = true; },
  'thread starter': (f: ReturnType<typeof fixture>) => { f.source.hasThread = true; },
  'voice message': (f: ReturnType<typeof fixture>) => { f.source.flags.add(MessageFlags.IsVoiceMessage); },
  'crossposted message': (f: ReturnType<typeof fixture>) => { f.source.flags.add(MessageFlags.Crossposted); },
  'ephemeral attachment': (f: ReturnType<typeof fixture>) => { f.source.attachments.set('file-1', makeAttachment({ ephemeral: true })); },
  'no matching link': (f: ReturnType<typeof fixture>) => { f.source.content = 'hello https://x.com.evil/a'; },
  'too much text': (f: ReturnType<typeof fixture>) => { f.source.content += 'a'.repeat(2000); },
  'too many bytes': (f: ReturnType<typeof fixture>) => { f.source.attachments.set('large', makeAttachment({ size: 26 * 1024 * 1024 })); },
  'not deletable': (f: ReturnType<typeof fixture>) => { f.source.deletable = false; },
})) {
  test(`keeps original without reposting: ${name}`, async () => {
    const f = fixture(); change(f); await f.run();
    assert.deepEqual(f.events, []);
  });
}

test('unset configuration disables all processing', async () => {
  const f = fixture();
  await createXLinkHandler(undefined, f.log)(f.source as unknown as Message);
  await createXLinkHandler([], f.log)(f.source as unknown as Message);
  assert.deepEqual(f.events, []);
});

test('a message is left alone when only a disabled platform matches', async () => {
  const disabled = fixture();
  disabled.source.content = 'Look https://instagram.com/p/DAbc123';
  await createXLinkHandler(CHANNEL_ID, disabled.log, undefined, ['x', 'tiktok'])(
    disabled.source as unknown as Message);
  assert.deepEqual(disabled.events, []);

  const enabled = fixture();
  enabled.source.content = 'Look https://instagram.com/p/DAbc123';
  await createXLinkHandler(CHANNEL_ID, enabled.log, undefined, ['instagram'])(
    enabled.source as unknown as Message);
  assert.deepEqual(enabled.events, ['send', 'fetch', 'delete original']);
  assert.equal(enabled.sent[0].content, `${QUOTED_CREDIT}\n> Look\nhttps://kkclip.com/p/DAbc123`);
});

for (const permission of ['ViewChannel', 'ReadMessageHistory', 'ManageMessages', 'SendMessages', 'EmbedLinks'] as const) {
  test(`missing ${permission} prevents a repost and deletion`, async () => {
    const f = fixture();
    f.permissions.remove(PermissionFlagsBits.Administrator, PermissionFlagsBits[permission]);
    await f.run(); assert.deepEqual(f.events, []);
  });
}

test('attachment permission is required only for messages with attachments', async () => {
  const f = fixture();
  f.permissions.remove(PermissionFlagsBits.Administrator, PermissionFlagsBits.AttachFiles);
  f.source.attachments.set('file-1', makeAttachment());
  await f.run(); assert.deepEqual(f.events, []);
  f.source.attachments.clear();
  await f.run(); assert.deepEqual(f.events, ['send', 'fetch', 'delete original']);
});

test('exact thread ID uses SendMessagesInThreads and does not inherit parent scope', async () => {
  const f = fixture();
  f.source.channel.isThread = () => true;
  f.permissions.remove(PermissionFlagsBits.Administrator, PermissionFlagsBits.SendMessages);
  await f.run(); assert.deepEqual(f.events, ['send', 'fetch', 'delete original']);
  const denied = fixture();
  denied.source.channel.isThread = () => true;
  denied.permissions.remove(PermissionFlagsBits.Administrator, PermissionFlagsBits.SendMessagesInThreads);
  await denied.run(); assert.deepEqual(denied.events, []);
});

test('a failed send preserves the original and is contained', async () => {
  const f = fixture();
  f.source.channel.send = async () => { f.events.push('send failed'); throw new Error('Forbidden'); };
  await f.run(); assert.deepEqual(f.events, ['send failed']); assert.equal(f.logs.length, 1);
});

test('a failed deletion leaves the repost and suppresses repeated delivery', async () => {
  const f = fixture();
  f.source.delete = async () => { f.events.push('delete failed'); throw new Error('Forbidden'); };
  await f.run(); await f.run();
  assert.deepEqual(f.events, ['send', 'fetch', 'delete failed']);
});

test('concurrent delivery produces only one repost', async () => {
  const f = fixture();
  await Promise.all([f.run(), f.run(), f.run()]);
  assert.deepEqual(f.events, ['send', 'fetch', 'delete original']);
});

test('an edit during copying preserves the newer original and removes the stale repost', async () => {
  const f = fixture();
  f.source.fetch = async () => { f.events.push('fetch'); f.source.content += ' new text'; return f.source; };
  await f.run(); assert.deepEqual(f.events, ['send', 'fetch', 'delete replacement']);
});

test('link warning flag updates do not discard an unchanged repost', async () => {
  const f = fixture();
  const originalContent = f.source.content;
  f.source.fetch = async () => {
    f.events.push('fetch');
    f.source.flags.add(MessageFlags.ShouldShowLinkNotDiscordWarning);
    return f.source;
  };
  await f.run();
  assert.equal(f.source.content, originalContent);
  assert.equal(f.source.editedTimestamp, null);
  assert.deepEqual(f.events, ['send', 'fetch', 'delete original']);
  assert.equal(f.source.flags.bitfield, MessageFlags.ShouldShowLinkNotDiscordWarning);
  assert.equal(f.sent[0].flags, undefined);
});

test('a changed SuppressEmbeds preference still preserves the original', async () => {
  const f = fixture();
  f.source.fetch = async () => {
    f.events.push('fetch');
    f.source.flags.add(MessageFlags.SuppressEmbeds);
    return f.source;
  };
  await f.run();
  assert.deepEqual(f.events, ['send', 'fetch', 'delete replacement']);
});

test('a link warning flag update does not hide a real content edit', async () => {
  const f = fixture();
  f.source.fetch = async () => {
    f.events.push('fetch');
    f.source.flags.add(MessageFlags.ShouldShowLinkNotDiscordWarning);
    f.source.content += ' changed by author';
    return f.source;
  };
  await f.run();
  assert.deepEqual(f.events, ['send', 'fetch', 'delete replacement']);
});

test('a failed final fetch never deletes the original', async () => {
  const f = fixture();
  f.source.fetch = async () => { f.events.push('fetch failed'); throw new Error('Not found'); };
  await f.run(); assert.deepEqual(f.events, ['send', 'fetch failed']);
});

test('preserves suppressed embed preference', async () => {
  const f = fixture(); f.source.flags.add(MessageFlags.SuppressEmbeds);
  await f.run(); assert.equal(f.sent[0].flags, MessageFlags.SuppressEmbeds);
});

test('downloads and reuploads attachment bytes and metadata before deleting', async () => {
  const f = fixture();
  const attachment = makeAttachment({ name: 'SPOILER_photo.png', spoiler: true });
  f.source.attachments.set(attachment.id, attachment);
  const handler = createXLinkHandler(CHANNEL_ID, f.log, async (file) => {
    f.events.push('download');
    return downloadAttachment(file, async () => new Response(new Uint8Array([1, 2, 3])));
  });
  await handler(f.source as unknown as Message);
  assert.deepEqual(f.events, ['download', 'send', 'fetch', 'delete original']);
  const uploaded = f.sent[0].files![0] as AttachmentBuilder;
  assert.deepEqual(uploaded.attachment, Buffer.from([1, 2, 3]));
  assert.equal(uploaded.name, 'SPOILER_photo.png');
  assert.equal(uploaded.description, 'A photo'); assert.equal(uploaded.spoiler, true);
});

test('preserves a spoiler represented only by the Discord attachment flag', async () => {
  // The SDK constructor exists at runtime but is marked private in its typings.
  const attachment = Reflect.construct(Attachment, [{
    id: 'file-1', filename: 'photo.png', size: 3,
    url: 'https://cdn.discordapp.com/attachments/1/2/photo.png', flags: 1 << 3,
  }]) as Attachment;
  assert.equal(attachment.spoiler, false); // Installed SDK only checks the filename.
  const copy = await downloadAttachment(attachment, async () => new Response(new Uint8Array([1, 2, 3])));
  assert.equal(copy.spoiler, true);
  assert.equal(copy.name, 'SPOILER_photo.png');
});

for (const [name, response] of [
  ['HTTP error page', () => new Response('not found', { status: 404 })],
  ['short body', () => new Response(new Uint8Array([1, 2]))],
  ['oversized body', () => new Response(new Uint8Array([1, 2, 3, 4]))],
] as const) {
  test(`failed attachment download preserves original: ${name}`, async () => {
    const f = fixture(); f.source.attachments.set('file-1', makeAttachment());
    const handler = createXLinkHandler(CHANNEL_ID, f.log,
      (file) => downloadAttachment(file, async () => response()));
    await handler(f.source as unknown as Message);
    assert.deepEqual(f.events, []); assert.equal(f.logs.length, 1);
  });
}

test('an attachment omitted from Discord response prevents deletion', async () => {
  const f = fixture(); f.source.attachments.set('file-1', makeAttachment());
  f.source.channel.send = async (options) => { f.events.push('send'); f.sent.push(options); return f.replacement; };
  const handler = createXLinkHandler(CHANNEL_ID, f.log, async () => new AttachmentBuilder(Buffer.from('abc')));
  await handler(f.source as unknown as Message);
  assert.deepEqual(f.events, ['send']);
});

test('removes a stale repost if the original was deleted during upload', async () => {
  const f = fixture();
  f.source.fetch = async () => {
    f.events.push('original gone');
    throw Object.assign(new Error('Unknown Message'), { code: 10008 });
  };
  await f.run();
  assert.deepEqual(f.events, ['send', 'original gone', 'delete replacement']);
});
