import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Attachment,
  AttachmentBuilder,
  AttachmentFlags,
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
  createLinkRepostHandler,
  downloadAttachment,
  formatLinkRepost,
  parseDiscordIds,
  parseRewritePlatforms,
  rewriteSocialLinks,
} from '../src/services/SocialLinkService';

import type { TweetTranslation } from '../src/services/TweetTranslation';
import type { ServerPreferences } from '../src/services/ServerSettings';
import type { YouTubeStatistics } from '../src/services/YouTube';
import type { APIEmbed } from 'discord.js';

const CHANNEL_ID = '123456789012345678';
const SECOND_CHANNEL_ID = '223456789012345678';
const AUTHOR_ID = '777777777777777777';
const QUOTED_CREDIT = `> **Shared by <@${AUTHOR_ID}>**`;
const YOUTUBE_ID = 'dQw4w9WgXcQ';
const YOUTUBE_STATS: YouTubeStatistics = { viewCount: '12', likeCount: '0', commentCount: '3',
  topComment: { author: 'Viewer', text: 'A useful video.' } };

test('quoted layout places plain leading context above a native URL', () => {
  const body = "Discord's May patch notes. https://x.com/discord/status/1";
  assert.equal(formatLinkRepost(rewriteSocialLinks(body), AUTHOR_ID),
    `${QUOTED_CREDIT}\n> Discord's May patch notes.\nhttps://fixupx.com/discord/status/1`);
  assert.equal(formatLinkRepost('https://fixupx.com/discord/status/1', AUTHOR_ID),
    `${QUOTED_CREDIT}\nhttps://fixupx.com/discord/status/1`);
  assert.equal(formatLinkRepost('Only context, with no URL.', AUTHOR_ID),
    `${QUOTED_CREDIT}\nOnly context, with no URL.`);
});

test('quoted layout preserves multiline context and all text after the first URL', () => {
  const body = 'First line\nSecond line\nhttps://x.com/a\nAfter the first link. https://x.com/b  \n';
  assert.equal(formatLinkRepost(rewriteSocialLinks(body), AUTHOR_ID),
    `${QUOTED_CREDIT}\n> First line\n> Second line\nhttps://fixupx.com/a\nAfter the first link. https://fixupx.com/b  \n`);
  assert.equal(formatLinkRepost(rewriteSocialLinks('Compare https://x.com/a with https://x.com/b then decide.'), AUTHOR_ID),
    `${QUOTED_CREDIT}\n> Compare\nhttps://fixupx.com/a with https://fixupx.com/b then decide.`);
});

test('quoted layout preserves an unrelated first URL and nested URLs in its query', () => {
  const body = 'Read http://example.test/?next=(https://x.com/a) then https://x.com/b';
  assert.equal(formatLinkRepost(rewriteSocialLinks(body), AUTHOR_ID),
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
    assert.equal(formatLinkRepost(rewritten, AUTHOR_ID), `${QUOTED_CREDIT}\n${rewritten}`, body);
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
    assert.equal(formatLinkRepost(rewritten, AUTHOR_ID), `${QUOTED_CREDIT}\n${rewritten}`, body);
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

test('preserves question marks in fragments when stripping queries', () => {
  for (const suffix of ['#part?detail', '?s=20#part?detail', '#part?one?two']) {
    assert.equal(rewriteSocialLinks(`https://x.com/u/status/1${suffix}`),
      `https://fixupx.com/u/status/1${suffix.slice(suffix.indexOf('#'))}`);
  }
});

test('preserves surrounding punctuation after stripped share queries', () => {
  for (const punctuation of ['.', ',', '!', '?', ':', ';', '...']) {
    assert.equal(rewriteSocialLinks(`Read https://x.com/u/status/1?s=20${punctuation} Next.`),
      `Read https://fixupx.com/u/status/1${punctuation} Next.`);
  }
  assert.equal(rewriteSocialLinks('(https://x.com/u/status/1?s=20).'),
    '(https://fixupx.com/u/status/1).');
  assert.equal(rewriteSocialLinks('https://x.com/u/status/1?data={value}'),
    'https://fixupx.com/u/status/1');
});

test('preserves closing Markdown around links when stripping queries', () => {
  for (const marker of ['*', '**', '***', '_', '__', '~~', '||']) {
    for (const context of ['', 'Read ']) {
      assert.equal(rewriteSocialLinks(`${marker}${context}https://x.com/u/status/1?s=20${marker}.`),
        `${marker}${context}https://fixupx.com/u/status/1${marker}.`);
    }
  }
  assert.equal(rewriteSocialLinks('__**Read https://x.com/u/status/1?s=20.**__'),
    '__**Read https://fixupx.com/u/status/1.**__');
});

test('does not preserve query punctuation as Markdown without an unmatched opener', () => {
  for (const prefix of ['', '**Earlier** ', '\\**Literal ', '**Earlier\n\n']) {
    assert.equal(rewriteSocialLinks(`${prefix}https://x.com/u/status/1?t=abc**`),
      `${prefix}https://fixupx.com/u/status/1`);
  }
  assert.equal(rewriteSocialLinks('https://x.com/u/status/1?t=abc_'),
    'https://fixupx.com/u/status/1');
  assert.equal(rewriteSocialLinks('**Read https://x.com/u/status/1?t=abc\\**'),
    '**Read https://fixupx.com/u/status/1');
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
  'http://instagram.com/p/abc', 'https://www.instagram7.com/p/abc',
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
  'https://instagram.com/share/DAbc123',
  'https://www.instagram.com/share/reel/_69O6RoGd/',
]) {
  test(`leaves nonmatching URL untouched: ${url}`, () => {
    assert.equal(rewriteSocialLinks(url), url);
  });
}

for (const [original, expected] of [
  ['https://www.instagram.com/reels/DdFKS1ABmK4/', 'https://www.instagram7.com/reels/DdFKS1ABmK4/'],
  ['https://instagram.com/p/DAbc-1_x/', 'https://www.instagram7.com/p/DAbc-1_x/'],
  ['https://www.instagram.com/reel/DAbc123/', 'https://www.instagram7.com/reel/DAbc123/'],
  ['https://m.instagram.com/reels/DAbc123', 'https://www.instagram7.com/reels/DAbc123'],
  ['https://mobile.instagram.com/tv/DAbc123', 'https://www.instagram7.com/tv/DAbc123'],
  // Mobile share links arrive as www with an igsh tracking param.
  ['https://www.instagram.com/reel/DAbc123/?igsh=MXY2cWZ4ZzZ4', 'https://www.instagram7.com/reel/DAbc123/'],
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
  test(`rewrites to the fixer host: ${original}`, () => {
    assert.equal(rewriteSocialLinks(original), expected);
  });
}

test('platform names select which hosts are rewritten', () => {
  const body = 'https://x.com/u/status/1 https://instagram.com/p/abc https://tiktok.com/@u/video/1';
  assert.equal(rewriteSocialLinks(body, ['x']),
    'https://fixupx.com/u/status/1 https://instagram.com/p/abc https://tiktok.com/@u/video/1');
  assert.equal(rewriteSocialLinks(body, ['instagram', 'tiktok']),
    'https://x.com/u/status/1 https://www.instagram7.com/p/abc https://tnktok.com/@u/video/1');
  assert.equal(rewriteSocialLinks(body, []), body);
});

test('platform configuration defaults to every platform and rejects unknown names', () => {
  assert.deepEqual(parseRewritePlatforms(undefined), ['x', 'instagram', 'tiktok', 'youtube']);
  assert.deepEqual(parseRewritePlatforms('  '), ['x', 'instagram', 'tiktok', 'youtube']);
  assert.deepEqual(parseRewritePlatforms(' tiktok , x '), ['tiktok', 'x']);
  assert.deepEqual(parseRewritePlatforms('x,x'), ['x']);
  for (const invalid of ['twitter', 'x,', ',x', 'x,,tiktok', 'X', 'all']) {
    assert.throws(() => parseRewritePlatforms(invalid), /REWRITE_PLATFORMS/);
  }
});

test('channel configuration defaults off and rejects invalid scope', () => {
  assert.deepEqual(parseDiscordIds(undefined), []);
  assert.deepEqual(parseDiscordIds('  '), []);
  assert.deepEqual(parseDiscordIds(` ${CHANNEL_ID} `), [CHANNEL_ID]);
  for (const invalid of ['all', '*', '#general', '123']) {
    assert.throws(() => parseDiscordIds(invalid), /Channel IDs must/);
  }
});

test('channel list deduplicates IDs while preserving their order', () => {
  assert.deepEqual(parseDiscordIds(` ${CHANNEL_ID}, ${SECOND_CHANNEL_ID} `), [CHANNEL_ID, SECOND_CHANNEL_ID]);
  assert.deepEqual(parseDiscordIds(` ${SECOND_CHANNEL_ID}, ${CHANNEL_ID}, ${SECOND_CHANNEL_ID} `),
    [SECOND_CHANNEL_ID, CHANNEL_ID]);
});

test('malformed channel list entries fail closed', () => {
  for (const invalid of [
    ',', `,${CHANNEL_ID}`, `${CHANNEL_ID},`, `${CHANNEL_ID},,${SECOND_CHANNEL_ID}`,
    `${CHANNEL_ID}, ,${SECOND_CHANNEL_ID}`, `${CHANNEL_ID},all`, `${CHANNEL_ID},*`,
    `${CHANNEL_ID},#general`, `${CHANNEL_ID},123`, `${CHANNEL_ID};${SECOND_CHANNEL_ID}`,
  ]) {
    assert.throws(() => parseDiscordIds(invalid), /Channel IDs must/);
  }
});

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'file-1', name: 'photo.png', description: 'A photo', size: 3,
    spoiler: false, ephemeral: false, url: 'https://cdn.discordapp.com/test/photo.png',
    flags: new AttachmentFlagsBitField(),
    ...overrides,
  } as Attachment;
}

function fixture(translateTweet?: (statusId: string) => Promise<TweetTranslation | null>) {
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
        const originals = [...source.attachments.values()];
        replacement.attachments = new Collection((options.files ?? []).map((_, index) =>
          [`uploaded-${index}`, originals[index] ?? makeAttachment({ name: 'translation.txt' })]));
        return replacement;
      },
    },
    fetch: async (_force: boolean) => { events.push('fetch'); return source; },
    delete: async () => { events.push('delete original'); },
  };
  const handler = createLinkRepostHandler(CHANNEL_ID, log, undefined, { translateTweet });
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

test('reply mode preserves the original, references it, and never notifies mentions', async () => {
  const f = fixture();
  f.permissions.remove(PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageMessages);
  f.source.deletable = false;
  const handler = createLinkRepostHandler(CHANNEL_ID, f.log, undefined, {
    serverPreferences: () => ({ mode: 'reply' }),
  });
  await handler(f.source as unknown as Message);
  await handler(f.source as unknown as Message);
  assert.deepEqual(f.events, ['send', 'fetch']);
  assert.deepEqual(f.sent[0].reply, { messageReference: f.source.id, failIfNotExists: true });
  assert.deepEqual(f.sent[0].allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
  assert.match(f.sent[0].content!, /https:\/\/fixupx\.com\/user\/status\/1/);
});

test('reply mode leaves source attachments in place without copying or Attach Files permission', async () => {
  const f = fixture();
  f.source.attachments.set('large-file', makeAttachment({ size: 50 * 1024 * 1024 }));
  f.permissions.remove(PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.AttachFiles);
  await createLinkRepostHandler(CHANNEL_ID, f.log, async () => {
    assert.fail('Reply mode must not download original attachments');
  }, { serverPreferences: () => ({ mode: 'reply' }) })(f.source as unknown as Message);
  assert.deepEqual(f.events, ['send', 'fetch']);
  assert.deepEqual(f.sent[0].files, []);
  assert.equal(f.source.attachments.size, 1);
});

test('reply mode still requires access, history, embeds and the correct send permission', async () => {
  for (const permission of ['ViewChannel', 'ReadMessageHistory', 'EmbedLinks', 'SendMessagesInThreads'] as const) {
    const f = fixture();
    f.source.channel.isThread = () => true;
    f.permissions.remove(PermissionFlagsBits.Administrator, PermissionFlagsBits[permission]);
    await createLinkRepostHandler(CHANNEL_ID, f.log, undefined, {
      serverPreferences: () => ({ mode: 'reply' }),
    })(f.source as unknown as Message);
    assert.deepEqual(f.events, []);
  }
});

test('reply mode removes a stale reply when the source changes', async () => {
  const f = fixture();
  f.source.fetch = async () => { f.events.push('fetch'); f.source.content = 'Edited'; return f.source; };
  await createLinkRepostHandler(CHANNEL_ID, f.log, undefined, {
    serverPreferences: () => ({ mode: 'reply' }),
  })(f.source as unknown as Message);
  assert.deepEqual(f.events, ['send', 'fetch', 'delete replacement']);
});

test('server platform choices take effect without overriding operator disables or channel scope', async () => {
  for (const [platforms, preferences, scoped, expected] of [
    [['instagram', 'x'], { platforms: { instagram: false } }, true, 'https://instagram.com/p/abc/ https://fixupx.com/a'],
    [['x'], { platforms: { instagram: true } }, true, 'https://instagram.com/p/abc/ https://fixupx.com/a'],
    [['instagram', 'x'], { mode: 'reply' }, false, undefined],
    [['instagram'], { platforms: { instagram: false } }, true, undefined],
  ] as const) {
    const f = fixture();
    f.source.content = 'https://instagram.com/p/abc/ https://x.com/a';
    await createLinkRepostHandler(scoped ? CHANNEL_ID : [], f.log, undefined, {
      platforms, serverPreferences: () => preferences,
    })(f.source as unknown as Message);
    assert.equal(f.sent[0]?.content, expected ? `${QUOTED_CREDIT}\n${expected}` : undefined);
  }
});

test('changing server preferences during translation or sending cancels the stale replacement', async () => {
  for (const stage of ['translation', 'send', 'fetch']) {
    const f = fixture();
    let preferences: ServerPreferences = {};
    const changed = () => { preferences = { mode: 'reply' }; };
    if (stage === 'send') {
      const send = f.source.channel.send;
      f.source.channel.send = async options => { const result = await send(options); changed(); return result; };
    }
    if (stage === 'fetch') {
      f.source.fetch = async () => { f.events.push('fetch'); changed(); return f.source; };
    }
    await createLinkRepostHandler(CHANNEL_ID, f.log, undefined, {
      serverPreferences: () => preferences,
      translateTweet: async () => { if (stage === 'translation') changed(); return null; },
    })(f.source as unknown as Message);
    assert.deepEqual(f.events, stage === 'translation' ? [] :
      stage === 'send' ? ['send', 'delete replacement'] : ['send', 'fetch', 'delete replacement']);
  }
});

test('a server can disable translation while retaining plain link fixing', async () => {
  const f = fixture();
  await createLinkRepostHandler(CHANNEL_ID, f.log, undefined, {
    serverPreferences: () => ({ translateTweets: false }),
    translateTweet: async () => { assert.fail('Translation was disabled for this server'); },
  })(f.source as unknown as Message);
  assert.deepEqual(f.events, ['send', 'fetch', 'delete original']);
  assert.equal(f.sent[0].embeds, undefined);
});

for (const mode of ['replace', 'reply'] as const) {
  test(`YouTube sends the native video before attaching statistics controls in ${mode} mode`, async () => {
    const f = fixture();
    f.source.content = `https://youtu.be/${YOUTUBE_ID}?si=tracking&t=1m30s`;
    let cards: APIEmbed[] = [];
    await createLinkRepostHandler(CHANNEL_ID, f.log, undefined, {
      serverPreferences: () => ({ mode }),
      lookupYouTube: async ids => { assert.deepEqual(ids, [YOUTUBE_ID]); return new Map([[YOUTUBE_ID, YOUTUBE_STATS]]); },
      publishYouTube: async (_message, value) => {
        f.events.push('stats'); cards = value;
        return { remove: async () => { f.events.push('delete stats'); } };
      },
    })(f.source as unknown as Message);
    assert.deepEqual(f.events, ['send', 'stats', 'fetch', ...(mode === 'replace' ? ['delete original'] : [])]);
    assert.equal(f.sent[0].content, `${QUOTED_CREDIT}\nhttps://www.youtube.com/watch?v=${YOUTUBE_ID}&t=90`);
    assert.equal(f.sent[0].embeds, undefined);
    assert.deepEqual(cards[0].fields, [
      { name: 'Views', value: '**12**', inline: true },
      { name: 'Likes', value: '**0**', inline: true },
      { name: 'Comments', value: '**3**', inline: true },
      { name: 'Top comment', value: 'A useful video.\n\nBy Viewer', inline: false },
    ]);
    assert.equal(cards[0].url, `https://www.youtube.com/watch?v=${YOUTUBE_ID}&t=90`);
  });
}

test('YouTube leaves its original alone when lookup or durable publication fails', async () => {
  for (const failure of ['lookup', 'empty', 'publish']) {
    const f = fixture(); f.source.content = `https://www.youtube.com/watch?v=${YOUTUBE_ID}`;
    await createLinkRepostHandler(CHANNEL_ID, f.log, undefined, {
      lookupYouTube: async () => {
        if (failure === 'lookup') throw new Error('Unavailable');
        return failure === 'empty' ? new Map() : new Map([[YOUTUBE_ID, YOUTUBE_STATS]]);
      },
      publishYouTube: async () => null,
    })(f.source as unknown as Message);
    assert.deepEqual(f.events, failure === 'publish' ? ['send', 'delete replacement'] : []);
  }
});

test('YouTube outage does not prevent Instagram replacement in a mixed message', async () => {
  const f = fixture(); f.source.content = `https://instagram.com/reel/abc/ https://youtu.be/${YOUTUBE_ID}?si=test`;
  await createLinkRepostHandler(CHANNEL_ID, f.log, undefined, {
    lookupYouTube: async () => new Map(), publishYouTube: async () => assert.fail('No statistics are available'),
  })(f.source as unknown as Message);
  assert.deepEqual(f.events, ['send', 'fetch', 'delete original']);
  assert.equal(f.sent[0].content, `${QUOTED_CREDIT}\nhttps://www.instagram7.com/reel/abc/ https://youtu.be/${YOUTUBE_ID}?si=test`);
});

test('hidden, disabled, inaccessible or unconfigured YouTube links make no API request', async () => {
  for (const kind of ['suppressed', 'angle', 'code', 'spoiler', 'platform', 'permission', 'scope']) {
    const f = fixture(); const url = `https://youtu.be/${YOUTUBE_ID}`;
    f.source.content = kind === 'angle' ? `<${url}>` : kind === 'code' ? `\`${url}\`` : kind === 'spoiler' ? `||${url}||` : url;
    if (kind === 'suppressed') f.source.flags.add(MessageFlags.SuppressEmbeds);
    if (kind === 'permission') f.permissions.remove(PermissionFlagsBits.Administrator, PermissionFlagsBits.EmbedLinks);
    await createLinkRepostHandler(kind === 'scope' ? [] : CHANNEL_ID, f.log, undefined, {
      serverPreferences: () => kind === 'platform' ? { platforms: { youtube: false } } : {},
      lookupYouTube: async () => assert.fail('YouTube lookup is not permitted'),
      publishYouTube: async () => assert.fail('YouTube publication is not permitted'),
    })(f.source as unknown as Message);
    assert.deepEqual(f.events, []);
  }
});

test('source edits, deletion and scope changes remove the stale video and its statistics controls', async () => {
  for (const change of ['edit', 'delete', 'scope']) {
    const f = fixture(); f.source.content = `https://youtu.be/${YOUTUBE_ID}`;
    let enabled = true;
    if (change === 'delete') f.source.fetch = async () => {
      f.events.push('fetch'); throw Object.assign(new Error('Unknown message'), { code: 10008 });
    };
    await createLinkRepostHandler(CHANNEL_ID, f.log, undefined, {
      serverEnabled: () => enabled,
      lookupYouTube: async () => new Map([[YOUTUBE_ID, YOUTUBE_STATS]]),
      publishYouTube: async () => {
        if (change === 'edit') f.source.content = 'Edited while posting';
        if (change === 'scope') enabled = false;
        return { remove: async () => { f.events.push('delete stats'); } };
      },
    })(f.source as unknown as Message);
    assert.deepEqual(f.events, ['send', 'fetch', 'delete stats', 'delete replacement'], change);
  }
});

test('a long YouTube message still gets details without consuming its content budget', async () => {
  const f = fixture(); f.source.content = 'a'.repeat(1850) + ` https://youtu.be/${YOUTUBE_ID}`;
  await createLinkRepostHandler(CHANNEL_ID, f.log, undefined, {
    lookupYouTube: async () => new Map([[YOUTUBE_ID, YOUTUBE_STATS]]),
    publishYouTube: async () => {
      f.events.push('stats'); return { remove: async () => { f.events.push('delete stats'); } };
    },
  })(f.source as unknown as Message);
  assert.deepEqual(f.events, ['send', 'stats', 'fetch', 'delete original']);
  assert(f.sent[0].content!.includes('a'.repeat(1850)));
});

test('statistics for multiple YouTube videos retain the native link order and video URLs', async () => {
  const f = fixture(); const ids = [YOUTUBE_ID, 'abcdefghijk', '0123456789_'];
  f.source.content = ids.map(id => `https://youtu.be/${id}`).join('\n');
  let cards: APIEmbed[] = [];
  await createLinkRepostHandler(CHANNEL_ID, f.log, undefined, {
    lookupYouTube: async () => new Map(ids.map(id => [id, YOUTUBE_STATS])),
    publishYouTube: async (_message, values) => { cards = values; return { remove: async () => {} }; },
  })(f.source as unknown as Message);
  assert.deepEqual(cards.map(card => card.url), ids.map(id => `https://www.youtube.com/watch?v=${id}`));
  assert.equal(f.sent[0].embeds, undefined);
  assert(!f.sent[0].content?.includes('Top comment'));
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
  const handler = createLinkRepostHandler([CHANNEL_ID, SECOND_CHANNEL_ID], first.log);

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
  const handler = createLinkRepostHandler([CHANNEL_ID, SECOND_CHANNEL_ID], first.log);
  await handler(first.source as unknown as Message);
  await handler(second.source as unknown as Message);
  assert.equal(first.sent[0].content, second.sent[0].content);
  assert.ok(first.sent[0].content?.startsWith(`${QUOTED_CREDIT}\n> Look\n`));
  assert.deepEqual(first.sent[0].allowedMentions, second.sent[0].allowedMentions);
});

test('server scope includes new channels and isolates other servers', async () => {
  const first = fixture();
  const handler = createLinkRepostHandler([], first.log, undefined, { serverIds: [first.source.guildId] });
  await handler(first.source as unknown as Message);

  // This channel was never supplied to the handler, including at construction.
  const added = fixture();
  added.source.id = '223456789012345679';
  added.source.channelId = SECOND_CHANNEL_ID;
  await handler(added.source as unknown as Message);

  const unrelated = fixture();
  unrelated.source.id = '323456789012345679';
  unrelated.source.guildId = '887654321098765432';
  await handler(unrelated.source as unknown as Message);
  assert.deepEqual(first.events, ['send', 'fetch', 'delete original']);
  assert.deepEqual(added.events, ['send', 'fetch', 'delete original']);
  assert.deepEqual(unrelated.events, []);
});

test('server scope preserves exact channel opt-ins in other servers', async () => {
  const server = fixture();
  const exact = fixture();
  exact.source.id = '223456789012345679';
  exact.source.channelId = SECOND_CHANNEL_ID;
  exact.source.guildId = '887654321098765432';
  const handler = createLinkRepostHandler([SECOND_CHANNEL_ID], server.log, undefined,
    { serverIds: [server.source.guildId] });
  await handler(server.source as unknown as Message);
  await handler(exact.source as unknown as Message);
  assert.deepEqual(server.events, ['send', 'fetch', 'delete original']);
  assert.deepEqual(exact.events, ['send', 'fetch', 'delete original']);
});

test('explicit server choices override legacy scopes without broadening other servers', async () => {
  for (const [channels, server, choice, expected] of [
    [[], false, undefined, false],
    [[CHANNEL_ID], false, undefined, true],
    [[], true, undefined, true],
    [[SECOND_CHANNEL_ID], false, undefined, false],
    [[CHANNEL_ID], true, false, false],
    [[], false, true, true],
  ] as const) {
    const f = fixture();
    await createLinkRepostHandler(channels, f.log, undefined, {
      serverIds: server ? [f.source.guildId] : [],
      serverEnabled: id => id === f.source.guildId ? choice : undefined,
    })(f.source as unknown as Message);
    assert.deepEqual(f.events, expected ? ['send', 'fetch', 'delete original'] : []);
  }
});

test('a running handler immediately respects setup changes in new channels and threads', async () => {
  let enabled: boolean | undefined;
  const first = fixture();
  const handler = createLinkRepostHandler([], first.log, undefined, { serverEnabled: () => enabled });
  await handler(first.source as unknown as Message);
  assert.deepEqual(first.events, []);
  enabled = true;
  first.source.channel.isThread = () => true;
  await handler(first.source as unknown as Message);
  assert.deepEqual(first.events, ['send', 'fetch', 'delete original']);
  enabled = false;
  const next = fixture();
  next.source.id = '223456789012345679';
  await handler(next.source as unknown as Message);
  assert.deepEqual(next.events, []);
});

test('server scope includes threads while enforcing thread permissions', async () => {
  for (const canSend of [true, false]) {
    const f = fixture();
    f.source.channelId = SECOND_CHANNEL_ID;
    f.source.channel.isThread = () => true;
    f.permissions.remove(PermissionFlagsBits.Administrator, PermissionFlagsBits.SendMessages);
    if (!canSend) f.permissions.remove(PermissionFlagsBits.SendMessagesInThreads);
    await createLinkRepostHandler([], f.log, undefined, { serverIds: [f.source.guildId] })(
      f.source as unknown as Message);
    assert.deepEqual(f.events, canSend ? ['send', 'fetch', 'delete original'] : []);
  }
});

test('server IDs use the same strict parser with a distinct error label', () => {
  assert.deepEqual(parseDiscordIds(undefined, 'Server IDs'), []);
  assert.deepEqual(parseDiscordIds(` ${CHANNEL_ID}, ${CHANNEL_ID} `, 'Server IDs'), [CHANNEL_ID]);
  for (const invalid of ['*', 'all', '012345678901234567', '1234567890123456',
    '123456789012345678901', `${CHANNEL_ID},`, `${CHANNEL_ID},,${SECOND_CHANNEL_ID}`]) {
    assert.throws(() => parseDiscordIds(invalid, 'Server IDs'), /Server IDs must/);
  }
});

test('server scope still requires access, deletion and attachment permissions', async () => {
  for (const permission of ['ViewChannel', 'ManageMessages', 'AttachFiles'] as const) {
    const f = fixture();
    f.source.attachments.set('file-1', makeAttachment());
    f.permissions.remove(PermissionFlagsBits.Administrator, PermissionFlagsBits[permission]);
    await createLinkRepostHandler([], f.log, async () => {
      assert.fail('An inaccessible message must not download attachments.');
    }, { serverIds: [f.source.guildId] })(f.source as unknown as Message);
    assert.deepEqual(f.events, []);
  }
});

test('direct messages are excluded even when scope IDs match', async () => {
  const f = fixture();
  f.source.inGuild = () => false;
  await createLinkRepostHandler([CHANNEL_ID], f.log, undefined, { serverIds: [f.source.guildId] })(
    f.source as unknown as Message);
  assert.deepEqual(f.events, []);
});

test('overlapping channel and server scopes produce only one repost', async () => {
  const f = fixture();
  const handler = createLinkRepostHandler([CHANNEL_ID], f.log, undefined,
    { serverIds: [f.source.guildId, f.source.guildId] });
  await Promise.all([handler(f.source as unknown as Message), handler(f.source as unknown as Message)]);
  await handler(f.source as unknown as Message);
  assert.deepEqual(f.events, ['send', 'fetch', 'delete original']);
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
  await createLinkRepostHandler(undefined, f.log)(f.source as unknown as Message);
  await createLinkRepostHandler([], f.log)(f.source as unknown as Message);
  assert.deepEqual(f.events, []);
});

test('a message is left alone when only a disabled platform matches', async () => {
  const disabled = fixture();
  disabled.source.content = 'Look https://instagram.com/p/DAbc123';
  await createLinkRepostHandler(CHANNEL_ID, disabled.log, undefined, { platforms: ['x', 'tiktok'] })(
    disabled.source as unknown as Message);
  assert.deepEqual(disabled.events, []);

  const enabled = fixture();
  enabled.source.content = 'Look https://instagram.com/p/DAbc123';
  await createLinkRepostHandler(CHANNEL_ID, enabled.log, undefined, { platforms: ['instagram'] })(
    enabled.source as unknown as Message);
  assert.deepEqual(enabled.events, ['send', 'fetch', 'delete original']);
  assert.equal(enabled.sent[0].content, `${QUOTED_CREDIT}\n> Look\nhttps://www.instagram7.com/p/DAbc123`);
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
  const handler = createLinkRepostHandler(CHANNEL_ID, f.log, async (file) => {
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
    url: 'https://cdn.discordapp.com/attachments/1/2/photo.png', flags: AttachmentFlags.IsSpoiler,
  }]) as Attachment;
  assert.equal(attachment.name, 'photo.png');
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
    const handler = createLinkRepostHandler(CHANNEL_ID, f.log,
      (file) => downloadAttachment(file, async () => response()));
    await handler(f.source as unknown as Message);
    assert.deepEqual(f.events, []); assert.equal(f.logs.length, 1);
  });
}

test('an attachment omitted from Discord response prevents deletion', async () => {
  const f = fixture(); f.source.attachments.set('file-1', makeAttachment());
  f.source.channel.send = async (options) => { f.events.push('send'); f.sent.push(options); return f.replacement; };
  const handler = createLinkRepostHandler(CHANNEL_ID, f.log, async () => new AttachmentBuilder(Buffer.from('abc')));
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

// ─── Translation ────────────────────────────────────────────────────────────

const JAPANESE: TweetTranslation = {
  text: 'The English translation.', language: 'Japanese',
  author: { name: 'Nintendo (@Nintendo)', url: 'https://x.com/Nintendo' },
  photos: [], hasMedia: false, hasVideo: false,
};

test('text-only translation replaces the native card with English and a small footer', async () => {
  const f = fixture(async () => JAPANESE);
  await f.run();
  assert.match(f.sent[0].content!, /https:\/\/fixupx.com\/user\/status\/1#part/);
  assert.doesNotMatch(f.sent[0].content!, /\/en|The English translation/);
  assert.deepEqual(f.sent[0].embeds, [{
    url: 'https://fixupx.com/user/status/1#part', author: JAPANESE.author,
    description: JAPANESE.text, color: 0x637dff, footer: { text: 'Translated from Japanese' },
  }]);
  assert.deepEqual(f.events, ['send', 'fetch', 'delete original']);
  assert.deepEqual(f.sent[0].allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
});

test('translated photo cards preserve every photo without repeating the caption', async () => {
  const photos = ['https://pbs.twimg.com/media/one.jpg', 'https://pbs.twimg.com/media/two.jpg'];
  const f = fixture(async () => ({ ...JAPANESE, photos, hasMedia: true }));
  await f.run();
  const embeds = f.sent[0].embeds as { description?: string; image?: { url: string } }[];
  assert.deepEqual(embeds.map((embed) => embed.image?.url), photos);
  assert.deepEqual(embeds.map((embed) => embed.description), [JAPANESE.text, undefined]);
});

test('video translation uses a native gallery and one English caption without an original-text card', async () => {
  const f = fixture(async () => ({ ...JAPANESE, hasMedia: true, hasVideo: true }));
  await f.run();
  assert.match(f.sent[0].content!, /https:\/\/g.fixupx.com\/user\/status\/1#part/);
  assert.ok(f.sent[0].content!.endsWith('The English translation.\n-# Translated from Japanese'));
  assert.equal(f.sent[0].embeds, undefined);
  assert.doesNotMatch(f.sent[0].content!, /\/en/);
});

test('mixed platforms keep native previews and suppress the untranslated text-only tweet card', async () => {
  const calls: string[] = [];
  const f = fixture(async (id) => { calls.push(id); return JAPANESE; });
  f.source.content = '**Read https://x.com/u/status/123?s=20#part?detail** https://www.instagram.com/p/abc/?igsh=1. https://vm.tiktok.com/ZN8eQCMCd/?share=1';
  await f.run();
  assert.deepEqual(calls, ['123']);
  assert.equal(f.sent[0].content, `${QUOTED_CREDIT}\n**Read <https://fixupx.com/u/status/123#part?detail>** https://www.instagram7.com/p/abc/. https://tnktok.com/ZN8eQCMCd/\n\n${JAPANESE.text}\n-# Translated from Japanese`);
  assert.equal(f.sent[0].embeds, undefined);
});

test('disabled X or translation never requests a translation', async () => {
  for (const platforms of [undefined, ['instagram'] as const]) {
    const f = fixture();
    f.source.content = 'https://x.com/u/status/123?s=20 https://instagram.com/p/abc/?igsh=1';
    const handler = createLinkRepostHandler(CHANNEL_ID, f.log, undefined, {
      platforms,
      ...(platforms ? { translateTweet: async () => { assert.fail('disabled X lookup'); } } : {}),
    });
    await handler(f.source as unknown as Message);
    assert.equal(f.sent[0].embeds, undefined);
    assert.match(f.sent[0].content!, /https:\/\/www\.instagram7\.com\/p\/abc\//);
  }
});

test('unknown languages and failed translation lookups keep ordinary native previews', async () => {
  for (const lookup of [async () => null, async () => { throw new Error('timeout'); }]) {
    const f = fixture(lookup);
    await f.run();
    assert.equal(f.sent[0].embeds, undefined);
    assert.match(f.sent[0].content!, /https:\/\/fixupx.com\/user\/status\/1#part/);
    assert.deepEqual(f.events, ['send', 'fetch', 'delete original']);
  }
});

test('suppressed, code and spoiler links never expose translated text', async () => {
  for (const content of [
    '<https://x.com/u/status/123>', '`https://x.com/u/status/123`',
    '``https://x.com/u/status/123``', '```\nhttps://x.com/u/status/123\n```',
    '||https://x.com/u/status/123||',
    '\\\\||https://x.com/u/status/123||',
  ]) {
    const f = fixture(async () => { assert.fail('hidden link lookup'); });
    f.source.content = content;
    await f.run();
    assert.equal(f.sent[0].embeds, undefined);
    assert.doesNotMatch(f.sent[0].content!, /Translated from/);
  }
  const f = fixture(async () => { assert.fail('suppressed message lookup'); });
  f.source.flags.add(MessageFlags.SuppressEmbeds);
  await f.run();
  assert.equal(f.sent[0].embeds, undefined);
  assert.equal(f.sent[0].flags, MessageFlags.SuppressEmbeds);
});

test('existing fixer URLs, nested URLs and path modifiers do not request translations', async () => {
  const calls: string[] = [];
  const f = fixture(async (id) => { calls.push(id); return JAPANESE; });
  f.source.content = 'https://x.com/user/status/123 https://fixupx.com/user/status/456 https://other.test/?next=https://x.com/user/status/789 https://x.com/user/status/999/photo/1';
  await f.run();
  assert.deepEqual(calls, ['123']);
  assert.match(f.sent[0].content!, /https:\/\/fixupx.com\/user\/status\/456/);
  assert.match(f.sent[0].content!, /next=https:\/\/x.com\/user\/status\/789/);
});

test('repeated status IDs share one translation lookup and caption', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return JAPANESE; });
  f.source.content = 'https://x.com/u/status/123 https://x.com/u/status/123';
  await f.run();
  assert.equal(calls, 1);
  assert.equal(f.sent[0].content!.split('Translated from').length - 1, 1);
});

test('a quoted video keeps both translations and embeds the quoted media only', async () => {
  const f = fixture(async () => ({ ...JAPANESE,
    url: 'https://x.com/u/status/1',
    quote: { ...JAPANESE, text: 'The quoted English translation.', language: 'Korean',
      url: 'https://x.com/quoted/status/2', hasMedia: true, hasVideo: true },
  }));
  await f.run();
  assert.equal(f.sent[0].embeds, undefined);
  assert.match(f.sent[0].content!, /<https:\/\/fixupx.com\/user\/status\/1#part>/);
  assert.match(f.sent[0].content!, /https:\/\/g.fixupx.com\/quoted\/status\/2/);
  assert.match(f.sent[0].content!, /The quoted English translation/);
  assert.match(f.sent[0].content!, /Translated from Korean/);
});

test('long translations span cards without exceeding Discord limits or losing text', async () => {
  const text = 'A long translated paragraph. '.repeat(170);
  const f = fixture(async () => ({ ...JAPANESE, text }));
  await f.run();
  const embeds = f.sent[0].embeds as { description?: string }[];
  assert.ok(embeds.length > 1);
  assert.ok(embeds.every((embed) => (embed.description?.length ?? 0) <= 4096));
  assert.equal(embeds.map((embed) => embed.description ?? '').join(''), text);
});

test('translations beyond the combined embed limit retain the full text in an attachment', async () => {
  const text = 'A long translated paragraph. '.repeat(400);
  const f = fixture(async () => ({ ...JAPANESE, text }));
  await f.run();
  assert.ok(f.sent[0].content!.length <= 2000);
  const file = (f.sent[0].files as AttachmentBuilder[])[0];
  assert.equal(file.name, 'translation.txt');
  assert.ok(Buffer.isBuffer(file.attachment));
  assert.ok((file.attachment as Buffer).toString('utf8').includes(text));
  assert.deepEqual(f.events, ['send', 'fetch', 'delete original']);
});

test('an existing fixer for the same status remains unchanged', async () => {
  const f = fixture(async () => JAPANESE);
  f.source.content = 'https://x.com/u/status/123 https://fixupx.com/u/status/123';
  await f.run();
  assert.ok(f.sent[0].content!.includes('<https://fixupx.com/u/status/123> https://fixupx.com/u/status/123'));
});

test('captions follow tweet order when lookups finish in reverse order', async () => {
  let finishFirst!: (value: TweetTranslation) => void;
  const f = fixture(async (id) => {
    if (id === '123') return new Promise<TweetTranslation>((resolve) => { finishFirst = resolve; });
    finishFirst({ ...JAPANESE, text: 'First tweet.' });
    return { ...JAPANESE, text: 'Second tweet.' };
  });
  f.source.content = 'https://x.com/u/status/123 https://x.com/u/status/456';
  await f.run();
  assert.ok(f.sent[0].content!.indexOf('First tweet.') < f.sent[0].content!.indexOf('Second tweet.'));
});

test('long video translations keep the playable gallery and attach the full text', async () => {
  const f = fixture(async () => ({ ...JAPANESE, text: 'a'.repeat(2000), hasMedia: true, hasVideo: true }));
  await f.run();
  assert.match(f.sent[0].content!, /https:\/\/g.fixupx.com\/user\/status\/1#part/);
  assert.match(f.sent[0].content!, /Full English translation attached/);
  assert.equal(f.sent[0].embeds, undefined);
  assert.equal((f.sent[0].files as AttachmentBuilder[])[0].name, 'translation.txt');
  assert.deepEqual(f.events, ['send', 'fetch', 'delete original']);
});

test('keeps the original when source context and every quoted video cannot fit together', async () => {
  const f = fixture(async () => ({ ...JAPANESE, hasMedia: true, hasVideo: true,
    quote: { ...JAPANESE, url: 'https://x.com/quoted/status/2', hasMedia: true, hasVideo: true },
  }));
  const original = 'a'.repeat(1900) + ' https://x.com/user/status/1';
  f.source.content = original;
  await f.run();
  assert.deepEqual(f.events, []);
  assert.equal(f.sent.length, 0);
  assert.equal(f.source.content, original);
});

test('source attachments and a generated translation share the copy byte limit', async () => {
  const f = fixture();
  f.source.attachments.set('file-1', makeAttachment({ size: 25 * 1024 * 1024 - 32 }));
  const handler = createLinkRepostHandler(CHANNEL_ID, f.log, async () => {
    f.events.push('download');
    throw new Error('The combined byte budget must be checked before downloading.');
  }, { translateTweet: async () => ({ ...JAPANESE, text: 'a'.repeat(7000) }) });
  await handler(f.source as unknown as Message);
  assert.deepEqual(f.events, []);
  assert.equal(f.sent.length, 0);
});

test('a missing attachment permission preserves the original long tweet', async () => {
  const f = fixture(async () => ({ ...JAPANESE, text: 'a'.repeat(7000) }));
  f.permissions.remove(PermissionFlagsBits.Administrator, PermissionFlagsBits.AttachFiles);
  await f.run();
  assert.deepEqual(f.events, []);
});

test('disabling a server during translation preserves the source without reposting', async () => {
  const f = fixture();
  let enabled = true;
  await createLinkRepostHandler([], f.log, undefined, {
    serverEnabled: () => enabled,
    translateTweet: async () => { enabled = false; return JAPANESE; },
  })(f.source as unknown as Message);
  assert.deepEqual(f.events, []);
});

for (const stage of ['send', 'fetch'] as const) {
  test(`disabling a server during ${stage} removes only the replacement`, async () => {
    const f = fixture();
    let enabled = true;
    if (stage === 'send') {
      const send = f.source.channel.send;
      f.source.channel.send = async options => { const result = await send(options); enabled = false; return result; };
    } else {
      f.source.fetch = async () => { f.events.push('fetch'); enabled = false; return f.source; };
    }
    await createLinkRepostHandler([], f.log, undefined, { serverEnabled: () => enabled })(f.source as unknown as Message);
    assert.deepEqual(f.events, stage === 'send' ? ['send', 'delete replacement'] : ['send', 'fetch', 'delete replacement']);
  });
}

test('edits made during translation keep the original and discard the stale repost', async () => {
  const f = fixture(async () => {
    f.source.content = 'Updated context https://x.com/user/status/1';
    return JAPANESE;
  });
  await f.run();
  assert.deepEqual(f.events, ['send', 'fetch', 'delete replacement']);
});

test('literal markers in earlier words or URLs do not leak tracking values into paths', () => {
  for (const prefix of ['my_name shared ', 'https://instagram.com/p/abc_def/ ', 'https://other.test/?key=* ']) {
    for (const marker of ['_', '*']) {
      assert.equal(rewriteSocialLinks(prefix + 'https://x.com/u/status/123?t=abc' + marker),
        prefix.replace('instagram.com', 'www.instagram7.com') + 'https://fixupx.com/u/status/123');
    }
  }
});

test('preserves multiline and combined closing Markdown around stripped queries', () => {
  for (const [prefix, suffix] of [['**First line\n', '**'], ['*Read **', '***'], ['**Read *', '***']]) {
    assert.equal(rewriteSocialLinks(prefix + 'https://x.com/u/status/123?t=abc' + suffix),
      prefix + 'https://fixupx.com/u/status/123' + suffix);
  }
});
