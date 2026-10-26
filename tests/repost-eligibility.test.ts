import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Collection, MessageFlags, MessageFlagsBitField, MessageType, PermissionFlagsBits, type Message } from 'discord.js';
import { bypassLinky, canCopy, sourceVersion } from '../src/services/RepostEligibility';
import { canonicalRepostLinks, instagramShortcodes, repostExpectations, requiredRepostPermissions } from '../src/services/RepostDelivery';
import { manualButtons } from '../src/commands/fixMedia';

function message(fields: Record<string, unknown> = {}, flags = 0): Message {
  return {
    partial: false, author: { bot: false }, webhookId: null, type: MessageType.Default, poll: null, pinned: false,
    hasThread: false, stickers: new Collection(), components: [], messageSnapshots: new Collection(),
    attachments: new Collection(), flags: new MessageFlagsBitField(flags), content: 'https://x.com/a/status/1',
    editedTimestamp: null, reference: null, ...fields,
  } as unknown as Message;
}

test('bypassLinky matches only a standalone !nolinky token', () => {
  assert.equal(bypassLinky('!nolinky https://x.com/a/status/1'), true);
  assert.equal(bypassLinky('look https://x.com/a/status/1 !NoLinky'), true);
  assert.equal(bypassLinky('https://x.com/a/status/1 x!nolinky'), false);
  assert.equal(bypassLinky('!nolinkyplease'), false);
});

test('canCopy accepts ordinary user messages and refuses uncopyable ones', () => {
  assert.equal(canCopy(message()), true);
  assert.equal(canCopy(message({ type: MessageType.Reply })), true);
  assert.equal(canCopy(message({ author: { bot: true } })), false);
  assert.equal(canCopy(message({ webhookId: '1' })), false);
  assert.equal(canCopy(message({ partial: true })), false);
  assert.equal(canCopy(message({ pinned: true })), false);
  assert.equal(canCopy(message({ type: MessageType.ThreadCreated })), false);
  assert.equal(canCopy(message({}, MessageFlags.IsVoiceMessage)), false);
  assert.equal(canCopy(message({}, MessageFlags.Crossposted)), false);
  assert.equal(canCopy(message({ attachments: new Collection([['1', { ephemeral: true }]]) })), false);
});

test('sourceVersion ignores only the link-warning flag', () => {
  const base = sourceVersion(message());
  assert.equal(sourceVersion(message({}, MessageFlags.ShouldShowLinkNotDiscordWarning)), base);
  assert.notEqual(sourceVersion(message({}, MessageFlags.SuppressEmbeds)), base);
  assert.notEqual(sourceVersion(message({ content: 'edited' })), base);
  assert.notEqual(sourceVersion(message({ editedTimestamp: 1 })), base);
});

test('requiredRepostPermissions follows the delivery mode', () => {
  const core = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks];
  assert.deepEqual(requiredRepostPermissions({ reply: false, thread: false, attachments: false, erome: false }),
    [...core, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages]);
  assert.deepEqual(requiredRepostPermissions({ reply: true, thread: true, attachments: true, erome: false }),
    [...core, PermissionFlagsBits.SendMessagesInThreads]);
  assert.deepEqual(requiredRepostPermissions({ reply: false, thread: false, attachments: true, erome: true }),
    [...core, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.AttachFiles]);
});

test('canonicalRepostLinks suppresses only links Linky presents itself', () => {
  const article = 'https://example.com/story';
  const community = 'https://www.youtube.com/post/Ug1234567890';
  const content = `${article} https://example.org/other ${community} https://www.erome.com/a/abc ` +
    'https://youtu.be/dQw4w9WgXcQ ||https://example.com/story||';
  const result = canonicalRepostLinks(content, {
    articles: [{ source: article, embeds: [] }], community: [{ source: community, embeds: [] }],
    eromeMedia: true, youtubeIds: new Set(['dQw4w9WgXcQ']),
  });
  assert.equal(result, `<${article}> https://example.org/other <${community}> <https://www.erome.com/a/abc> ` +
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ ||https://example.com/story||');
  assert.equal(canonicalRepostLinks(content, { articles: [], community: [], eromeMedia: false, youtubeIds: new Map() }), content);
});

test('instagramShortcodes maps post URLs and tolerates missing lists', () => {
  assert.deepEqual([...instagramShortcodes(['https://www.instagram.com/reel/ABC123/', 'https://example.com/'])], ['ABC123', undefined]);
  assert.equal(instagramShortcodes(undefined).size, 0);
});

test('repostExpectations drops translated text posts and marks caption-free and video previews', () => {
  const source = 'https://x.com/a/status/11 https://x.com/a/status/22 https://www.instagram.com/reel/ABC123/';
  const rendered = 'https://fixupx.com/a/status/11 https://fixupx.com/a/status/22 https://fkinstagram.com/reel/ABC123/';
  const expected = repostExpectations(source, rendered, [], [], {
    textStatusIds: new Set(['11']), videoStatusIds: new Set(['22']),
    captionFreeInstagram: new Set(['ABC123']), videoInstagram: new Set(['ABC123']),
  });
  assert.deepEqual(expected.map(item => [item.source, item.captionFree, item.requireVideo]), [
    ['https://x.com/a/status/22', undefined, true],
    ['https://www.instagram.com/reel/ABC123/', true, true],
  ]);
  const plain = repostExpectations(source, rendered, [], [], { textStatusIds: new Set(), videoStatusIds: new Set(),
    captionFreeInstagram: new Set(), videoInstagram: new Set() });
  assert.equal(plain.length, 3);
  assert.ok(plain.every(item => item.captionFree === undefined && item.requireVideo === undefined));
});

test('manualButtons adds Remove after up to two rows of original-post links', () => {
  const links = Array.from({ length: 6 }, (_, index) => ({ source: `https://x.com/a/status/${index + 1}` }));
  const { buttons, rows } = manualButtons(links);
  assert.equal(buttons.length, 7);
  assert.deepEqual(rows().map(row => row.components.length), [5, 2]);
  assert.deepEqual(buttons.map(button => button.toJSON()).map(button => 'label' in button ? button.label : ''),
    ['Original post', 'Original post 2', 'Original post 3', 'Original post 4', 'Original post 5', 'Original post 6', 'Remove']);
  assert.deepEqual(manualButtons([{ source: 'https://x.com/a/status/1' }]).rows().map(row => row.components.length), [2]);
});
