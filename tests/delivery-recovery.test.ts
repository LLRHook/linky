import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Collection, MessageFlags, MessageFlagsBitField, MessageType, PermissionsBitField,
  type APIEmbed, type APIMessageTopLevelComponent, type Attachment, type Message, type MessageCreateOptions, type MessageEditOptions } from 'discord.js';
import { createLinkRepostHandler } from '../src/services/SocialLinkService';
import { inspectPreviews, type ExpectedPreview } from '../src/services/PreviewRecovery';
import type { RepostRecord } from '../src/services/RepostRegistry';
import type { ServerPreferences } from '../src/services/ServerSettings';
import type { TweetTranslation } from '../src/services/TweetTranslation';
import type { InstagramTranslation } from '../src/services/InstagramTranslation';
import { YouTubeStats, YOUTUBE_STATS_TTL } from '../src/services/YouTubeStats';

const GUILD = '1700000000000000001', CHANNEL = '1700000000000000002';
const AUTHOR = '1700000000000000003', BOT = '1700000000000000004', SOURCE = '1700000000000000005';
const ORIGINAL_X = 'https://twitter.com/jack/status/20?s=46';
const PRIMARY_X = 'https://fixupx.com/jack/status/20', ALTERNATE_X = 'https://vxtwitter.com/jack/status/20';
const YOUTUBE_ID = 'dQw4w9WgXcQ', NATIVE_YOUTUBE = `https://www.youtube.com/watch?v=${YOUTUBE_ID}`;
const xPreview: APIEmbed = { url: PRIMARY_X, title: 'Jack', description: 'A public post.' };
const videoPreview: APIEmbed = { url: NATIVE_YOUTUBE, video: { url: `https://www.youtube.com/embed/${YOUTUBE_ID}` } };
type HandlerOptions = NonNullable<Parameters<typeof createLinkRepostHandler>[3]>;
interface SentMessage { message: Message; options: MessageCreateOptions; edits: MessageEditOptions[]; deleted: boolean }

const storeComponents = (rows: MessageEditOptions['components']) => (rows ?? []).map(row => ({
  toJSON: () => ('toJSON' in row ? row.toJSON() : row) as APIMessageTopLevelComponent,
}));

/** Independent Discord boundary: durable writes and visible side effects are observable. */
function delivery(content = ORIGINAL_X) {
  const events: string[] = [], sent: SentMessage[] = [], remembered: RepostRecord[] = [];
  const expectedChecks: ExpectedPreview[][] = [];
  const state = {
    enabled: true, preferences: { mode: 'replace' } as ServerPreferences,
    remoteContent: content, editedTimestamp: null as number | null, originalDeleted: false,
    render: (_round: number, _message: Message): APIEmbed[] => [xPreview],
    duringPreview: async (_round: number): Promise<void> => {},
    duringEdit: async (_edit: MessageEditOptions): Promise<void> => {},
    remember: async (_record: RepostRecord): Promise<boolean> => true,
  };
  let sequence = 100;
  const channel = {
    id: CHANNEL, isThread: () => false, isSendable: () => true,
    permissionsFor: () => new PermissionsBitField(PermissionsBitField.All),
    send: async (options: MessageCreateOptions) => {
      const id = String(1_700_000_000_000_000_000n + BigInt(sequence++));
      const entry = { options, edits: [], deleted: false } as unknown as SentMessage;
      const output = {
        id, channelId: CHANNEL, guildId: GUILD, author: { id: BOT, bot: true },
        content: options.content ?? '', attachments: new Collection<string, Attachment>(), embeds: [] as { toJSON(): APIEmbed }[],
        components: storeComponents(options.components),
        delete: async () => { entry.deleted = true; events.push(`delete:${id}`); },
        edit: async (edit: MessageEditOptions) => {
          entry.edits.push(edit);
          if (typeof edit.content === 'string') output.content = edit.content;
          if (edit.embeds) output.embeds = edit.embeds.map(embed => ({ toJSON: () => 'toJSON' in embed ? embed.toJSON() : embed }));
          if (edit.components) output.components = storeComponents(edit.components);
          events.push(`edit:${id}:${typeof edit.content === 'string' ? 'content' : 'controls'}`);
          await state.duringEdit(edit);
          return output;
        },
        fetch: async () => output,
      };
      entry.message = output as unknown as Message;
      sent.push(entry); events.push(`send:${id}`);
      return entry.message;
    },
  };
  const source = {
    id: SOURCE, channelId: CHANNEL, guildId: GUILD, content,
    author: { id: AUTHOR, bot: false }, guild: { members: { me: { id: BOT } } }, channel,
    partial: false, webhookId: null, type: MessageType.Default, poll: null, pinned: false, hasThread: false,
    stickers: new Collection(), components: [], messageSnapshots: new Collection(),
    attachments: new Collection<string, Attachment>(), flags: new MessageFlagsBitField(),
    editedTimestamp: null, reference: null, deletable: true, inGuild: () => true,
    delete: async () => { state.originalDeleted = true; events.push('delete:source'); },
    fetch: async () => {
      events.push('fetch:source');
      return { ...source, content: state.remoteContent, editedTimestamp: state.editedTimestamp } as unknown as Message;
    },
  };
  const create = (options: HandlerOptions = {}) => createLinkRepostHandler([], { info() {}, warn() {}, error() {} },
    async () => assert.fail('this fixture never requests attachment downloads'), {
      serverEnabled: () => state.enabled, serverPreferences: () => state.preferences,
      verifyPreview: async (message, expected) => {
        expectedChecks.push(expected.map(item => ({ ...item })));
        const round = expectedChecks.length;
        events.push(`verify:${round}:started`);
        await state.duringPreview(round);
        const rendered = state.render(round, message);
        Object.assign(message, { embeds: rendered.map(embed => ({ toJSON: () => embed })) });
        const result = inspectPreviews(rendered, expected);
        events.push(`verify:${round}:${result.ok ? 'passed' : 'failed'}`);
        return result;
      },
      rememberRepost: async record => {
        events.push(`remember:${record.replacementId}`);
        const result = await state.remember(record);
        if (result) remembered.push({ ...record });
        return result;
      }, ...options,
    });
  return { source: source as unknown as Message, state, sent, events, remembered, expectedChecks, create };
}

test('a matching X error card cannot authorize deletion of the original', async () => {
  const f = delivery();
  f.state.render = (_round, message) => [{ url: message.content.includes(ALTERNATE_X) ? ALTERNATE_X : PRIMARY_X,
    title: 'Error', description: 'Could not retrieve this post. Try again later.' }];
  await f.create()(f.source);
  assert.equal(f.state.originalDeleted, false);
  assert(f.sent[0].deleted, 'discard the unusable replacement');
});

test('a thrown ownership write removes the retry notice as well as the failed replacement', async () => {
  const f = delivery();
  f.state.render = () => [];
  f.state.remember = async () => { throw new Error('disk unavailable'); };
  await f.create()(f.source);
  assert.equal(f.state.originalDeleted, false);
  assert.equal(f.sent.length, 2, 'one replacement attempt and one retry notice');
  assert(f.sent.every(entry => entry.deleted), 'no interactive output may survive without its ownership record');
  assert.deepEqual(f.remembered, []);
});

test('missing or unrelated previews preserve the original and leave only an owned retry notice', async () => {
  for (const previews of [[], [{ url: 'https://fixupx.com/jack/status/999', title: 'Other post', description: 'Different content.' }],
    [{ url: 'https://evil.test/jack/status/20', image: { url: 'https://cdn.example/image.jpg' } }]] as APIEmbed[][]) {
    const f = delivery();
    f.state.render = () => previews;
    await f.create()(f.source);
    assert.equal(f.state.originalDeleted, false);
    assert.equal(f.sent.length, 2);
    assert(f.sent[0].deleted);
    const notice = f.sent[1];
    assert.equal(notice.deleted, false);
    assert.match(String(notice.options.content), /original is still here/i);
    assert.deepEqual(notice.options.reply, { messageReference: SOURCE, failIfNotExists: true });
    assert.match(JSON.stringify(notice.options.components), /linky:retry/);
    assert.match(JSON.stringify(notice.options.components), /linky:remove/);
    assert.deepEqual(f.remembered, [{ guildId: GUILD, channelId: CHANNEL, sourceId: SOURCE,
      replacementId: notice.message.id, authorId: AUTHOR, mode: 'reply' }]);
    assert.equal(f.expectedChecks.length, 2, 'try each catalogued X provider once');
  }
});

test('automatic X fallback edits one output and verifies it before saving ownership and deleting the source', async () => {
  const f = delivery();
  f.state.render = round => round === 1 ? [] : [{ ...xPreview, url: ALTERNATE_X }];
  await f.create()(f.source);
  assert.equal(f.sent.length, 1);
  const replacement = f.sent[0];
  assert.equal(replacement.deleted, false);
  assert.equal(replacement.edits.filter(edit => typeof edit.content === 'string').length, 1);
  assert.equal(replacement.edits.filter(edit => edit.components).length, 1);
  assert.match(replacement.message.content, /https:\/\/vxtwitter\.com\/jack\/status\/20/);
  assert(!replacement.message.content.includes(PRIMARY_X));
  assert.deepEqual(f.expectedChecks.map(items => items.map(item => item.providerId)), [['fixupx'], ['fixvx']]);
  assert.equal(f.state.originalDeleted, true);
  const passed = f.events.indexOf('verify:2:passed');
  const saved = f.events.indexOf(`remember:${replacement.message.id}`);
  assert(passed >= 0 && saved > passed && f.events.indexOf('delete:source') > saved);
  assert(!JSON.stringify(replacement.options.components).includes('linky:remove'), 'do not expose removal before delivery commits');
  assert.match(JSON.stringify(replacement.edits.at(-1)?.components), /linky:remove/);
  assert(f.events.indexOf(`edit:${replacement.message.id}:controls`) > f.events.indexOf('delete:source'));
  assert.deepEqual(replacement.options.allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
  assert.deepEqual(f.remembered, [{ guildId: GUILD, channelId: CHANNEL, sourceId: SOURCE,
    replacementId: replacement.message.id, authorId: AUTHOR, mode: 'replace' }]);
});

test('editing the source during preview loading removes the stale output without touching the edit', async () => {
  const f = delivery();
  f.state.duringPreview = async () => {
    f.state.remoteContent = 'The user replaced the link with a correction.';
    f.state.editedTimestamp = 123;
  };
  await f.create()(f.source);
  assert.equal(f.state.originalDeleted, false);
  assert.equal(f.state.remoteContent, 'The user replaced the link with a correction.');
  assert.equal(f.sent.length, 1);
  assert(f.sent[0].deleted);
  assert.deepEqual(f.remembered, []);
});

test('a busy refresh rejects without duplicating delivery and a later refresh copies the edited source', async () => {
  const f = delivery();
  let release!: () => void, reachedPreview!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { reachedPreview = resolve; });
  f.state.duringPreview = async round => {
    if (round === 1) { reachedPreview(); await gate; }
  };
  const handle = f.create();
  const initial = handle(f.source);
  await started;
  try {
    f.state.remoteContent = `Corrected context ${ORIGINAL_X}`;
    f.state.editedTimestamp = 123;
    const edited = await f.source.fetch(true);
    await assert.rejects(handle(edited, { refresh: true, forceReply: true }), /still in flight/);
    await handle(edited);
    assert.equal(f.sent.length, 1, 'neither a refresh nor a duplicate event starts a second delivery');
    assert.equal(f.remembered.length, 0);
  } finally { release(); }
  await initial;
  assert.equal(f.state.originalDeleted, false);
  assert(f.sent[0].deleted, 'the first attempt must discard its now-stale output');
  assert.equal(f.remembered.length, 0);

  await handle(await f.source.fetch(true), { refresh: true, forceReply: true });
  assert.equal(f.sent.length, 2);
  const fresh = f.sent[1];
  assert.equal(fresh.deleted, false);
  assert.match(fresh.message.content, /Corrected context/);
  assert.equal(fresh.options.reply?.messageReference, SOURCE);
  assert.notEqual(fresh.options.nonce, f.sent[0].options.nonce, 'refresh must not reuse the stale Discord nonce');
  assert.equal(f.state.originalDeleted, false, 'manual retry remains a reply');
  assert.deepEqual(f.remembered.map(record => [record.replacementId, record.mode]), [[fresh.message.id, 'reply']]);
});

test('server disablement or preference changes during preview loading cancel delivery', async () => {
  for (const change of ['disable', 'mode', 'channel'] as const) {
    const f = delivery();
    f.state.duringPreview = async () => {
      if (change === 'disable') f.state.enabled = false;
      else if (change === 'mode') f.state.preferences = { mode: 'reply' };
      else f.state.preferences = { mode: 'replace', channelIds: [] };
    };
    await f.create()(f.source);
    assert.equal(f.state.originalDeleted, false, change);
    assert.equal(f.sent.length, 1, change);
    assert(f.sent[0].deleted, change);
    assert.deepEqual(f.remembered, [], change);
  }
});

test('changes during the durable ownership write are checked again before source deletion', async () => {
  for (const change of ['source', 'policy'] as const) {
    const f = delivery();
    f.state.remember = async () => {
      if (change === 'source') { f.state.remoteContent = 'A late edit'; f.state.editedTimestamp = 123; }
      else f.state.enabled = false;
      return true;
    };
    await f.create()(f.source);
    assert.equal(f.state.originalDeleted, false, change);
    assert(f.sent[0].deleted, change);
    assert.equal(f.remembered.length, 1, 'the race occurs after a real successful write');
  }
});

test('ownership persistence returning false or throwing never sacrifices the original', async () => {
  for (const throws of [false, true]) {
    const f = delivery();
    f.state.remember = async () => { if (throws) throw new Error('write failed'); return false; };
    await f.create()(f.source);
    assert.equal(f.state.originalDeleted, false);
    assert.equal(f.sent.length, 1);
    assert(f.sent[0].deleted);
    assert.deepEqual(f.remembered, []);
  }
});

test('explicit bypass, hidden links and Discord preview suppression cause no delivery or enrichment', async () => {
  for (const content of [`!nolinky ${ORIGINAL_X}`, `<${ORIGINAL_X}>`, `\`${ORIGINAL_X}\``,
    `\`\`\`\n${ORIGINAL_X}\n\`\`\``, `||${ORIGINAL_X}||`, ORIGINAL_X]) {
    const f = delivery(content);
    if (content === ORIGINAL_X) f.source.flags.add(MessageFlags.SuppressEmbeds);
    await f.create({
      translateTweet: async () => assert.fail('hidden or bypassed text must not be translated'),
      lookupYouTube: async () => assert.fail('hidden or bypassed text must not be enriched'),
      publishYouTube: async () => assert.fail('nothing should be published'),
    })(f.source);
    assert.deepEqual(f.events, [], content);
    assert.equal(f.state.originalDeleted, false, content);
  }
});

test('a visible post does not reveal or require previews for adjacent hidden social and YouTube links', async () => {
  const hidden = '||https://x.com/jack/status/999|| `<https://youtu.be/dQw4w9WgXcQ>`';
  const f = delivery(`${ORIGINAL_X} ${hidden}`);
  await f.create({
    lookupYouTube: async () => assert.fail('the only YouTube link is hidden'),
    publishYouTube: async () => assert.fail('the only YouTube link is hidden'),
  })(f.source);
  assert.equal(f.state.originalDeleted, true);
  assert(f.sent[0].message.content.includes(hidden));
  assert.equal(f.expectedChecks[0].length, 1);
});

test('reply mode preserves the source and an explicit manual retry does not implicitly enable a server', async () => {
  const reply = delivery();
  reply.state.preferences = { mode: 'reply' };
  await reply.create()(reply.source);
  assert.equal(reply.state.originalDeleted, false);
  assert.equal(reply.sent[0].deleted, false);
  assert.deepEqual(reply.sent[0].options.reply, { messageReference: SOURCE, failIfNotExists: true });
  assert.equal(reply.remembered[0].mode, 'reply');
  const disabled = delivery();
  await disabled.create({ serverEnabled: () => undefined })(disabled.source, { refresh: true, forceReply: true });
  assert.deepEqual(disabled.events, []);
});

test('YouTube display reaches the lookup, preview-only skips all work and counts hides a supplied comment', async () => {
  for (const display of ['preview', 'counts', 'counts-and-comment', undefined] as const) {
    const f = delivery(`https://youtu.be/${YOUTUBE_ID}`);
    f.state.preferences = { mode: 'replace', ...(display ? { youtubeDisplay: display } : {}) };
    f.state.render = () => [videoPreview];
    const calls: { ids: readonly string[]; display: string | undefined }[] = [];
    const publications: APIEmbed[][] = [];
    await f.create({
      lookupYouTube: async (ids, mode) => {
        calls.push({ ids, display: mode });
        return new Map([[YOUTUBE_ID, { viewCount: '42', topComment: { author: 'Viewer', text: 'Useful video' } }]]);
      },
      publishYouTube: async (_message, cards) => {
        publications.push(cards); f.events.push('publish:youtube');
        return { remove: async () => { f.events.push('remove:youtube'); } };
      },
    })(f.source);
    if (display === 'preview') {
      assert.deepEqual(calls, []); assert.deepEqual(publications, []); assert.deepEqual(f.events, []);
      assert.equal(f.state.originalDeleted, false);
    } else {
      assert.deepEqual(calls, [{ ids: [YOUTUBE_ID], display: display ?? 'counts-and-comment' }]);
      assert.equal(publications.length, 1);
      assert.equal(publications[0][0].fields?.some(field => field.name === 'Top comment'), display !== 'counts');
      assert(f.events.indexOf('publish:youtube') > f.events.indexOf('verify:1:passed'));
      assert.equal(f.state.originalDeleted, true);
    }
  }
});

test('YouTube statistics cannot substitute for a native video preview or publish before it is confirmed', async () => {
  const f = delivery(`https://youtu.be/${YOUTUBE_ID}`);
  f.state.render = () => [{ url: NATIVE_YOUTUBE, title: 'YouTube stats', fields: [{ name: 'Views', value: '42' }] }];
  await f.create({
    lookupYouTube: async () => new Map([[YOUTUBE_ID, { viewCount: '42' }]]),
    publishYouTube: async () => assert.fail('counts must wait for the native video preview'),
  })(f.source);
  assert.equal(f.state.originalDeleted, false);
  assert(f.sent[0].deleted);
  assert.equal(f.remembered[0].mode, 'reply', 'only the retry notice remains');
});

test('actual YouTube controls survive the final delivery edit and expire without removing Original or Remove', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'linky-delivery-controls-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = delivery(`https://youtu.be/${YOUTUBE_ID}`);
  let time = 0;
  const managerOptions = {
    path: join(directory, 'youtube-stats.json'), botUserId: BOT, now: () => time,
    fetchMessage: async (channelId: string, messageId: string) => {
      assert.equal(channelId, CHANNEL);
      return f.sent.find(entry => entry.message.id === messageId && !entry.deleted)?.message ?? null;
    },
  };
  const manager = new YouTubeStats(managerOptions);
  f.state.render = (_round, message) => {
    Object.assign(message, { embeds: [{ toJSON: () => videoPreview }] });
    return [videoPreview];
  };
  await f.create({
    lookupYouTube: async () => new Map([[YOUTUBE_ID, { viewCount: '12345',
      topComment: { author: 'Viewer', text: 'A useful video' } }]]),
    publishYouTube: (message, cards) => manager.publish(message, cards),
  })(f.source);
  assert.equal(f.state.originalDeleted, true);
  assert.equal(f.sent.length, 1, 'counts must not create a second public message');
  const replacement = f.sent[0];
  const body = replacement.message.content;
  const rows = () => replacement.message.components.map(component => component.toJSON());
  assert.equal(replacement.deleted, false);
  assert.equal(rows().length, 2);
  assert.match(JSON.stringify(rows()), /linky:yt:stats:dQw4w9WgXcQ/);
  assert.match(JSON.stringify(rows()), /linky:yt:comment:dQw4w9WgXcQ/);
  assert.match(JSON.stringify(rows()), /linky:remove/);
  assert.equal(manager.canView(replacement.message, YOUTUBE_ID), true);
  assert(!body.includes('12,345') && !body.includes('A useful video'));
  const originals = rows().filter(row => !JSON.stringify(row).includes('linky:yt:'));
  assert.match(JSON.stringify(originals), /Original post/);
  assert.match(JSON.stringify(originals), /youtube\.com\/watch/);

  const restarted = new YouTubeStats(managerOptions);
  time = YOUTUBE_STATS_TTL;
  assert.equal(restarted.canView(replacement.message, YOUTUBE_ID), false);
  await restarted.sweep();
  assert.deepEqual(rows(), originals);
  assert.equal(replacement.message.content, body);
  assert.deepEqual(replacement.message.embeds.map(embed => embed.toJSON()), [videoPreview]);
  assert.equal(replacement.deleted, false);
});

const translatedText: TweetTranslation = {
  text: 'The translated post.', language: 'Japanese', author: { name: 'Author', url: 'https://x.com/author' },
  photos: [], hasMedia: false, hasVideo: false,
};

test('multiple translated text posts are delivered without requiring intentionally suppressed embeds', async () => {
  const f = delivery(`${ORIGINAL_X} https://x.com/author/status/21`);
  f.state.render = () => assert.fail('translated captions do not ask Discord for an embed');
  await f.create({ translateTweet: async () => translatedText })(f.source);
  assert.equal(f.state.originalDeleted, true);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].deleted, false);
  assert.match(f.sent[0].message.content, /<https:\/\/fixupx.com\/jack\/status\/20>/);
  assert.equal(f.sent[0].message.content.match(/The translated post\./g)?.length, 2);
  assert.equal(f.expectedChecks.length, 0);
});

test('a translated caption beside a reel still requires that reel to produce video metadata', async () => {
  for (const available of [true, false]) {
    const f = delivery(`${ORIGINAL_X} https://instagram.com/reels/ABC/`);
    f.state.render = () => available ? [{ url: 'https://www.instagram7.com/reel/ABC/', video: { url: 'https://cdn.example/reel.mp4' } }] : [];
    await f.create({ translateTweet: async () => translatedText })(f.source);
    assert.equal(f.state.originalDeleted, available);
    assert.deepEqual(f.expectedChecks[0].map(item => item.platform), ['instagram']);
    assert.equal(f.sent[0].deleted, !available);
  }
});

test('translated captions keep hidden adjacent links byte-for-byte unchanged', async () => {
  const hidden = '||https://instagram.com/p/ABC/|| <https://tiktok.com/@user/video/123> `https://twitter.com/other/status/25`';
  const f = delivery(`${ORIGINAL_X} ${hidden}`);
  const lookedUp: string[] = [];
  await f.create({ translateTweet: async id => { lookedUp.push(id); return translatedText; } })(f.source);
  assert.equal(f.state.originalDeleted, true);
  assert(f.sent[0].message.content.includes(hidden));
  assert.deepEqual(lookedUp, ['20']);
});

test('a translated video preserves hidden URLs and verifies only its visible gallery preview', async () => {
  const hidden = '||https://instagram.com/p/ABC/|| <https://tiktok.com/@user/video/123> ' +
    '`https://twitter.com/other/status/25` ```\nhttps://x.com/other/status/26\n```';
  const f = delivery(`${ORIGINAL_X} ${hidden}`);
  const lookedUp: string[] = [];
  f.state.render = () => [{ url: 'https://g.fixupx.com/jack/status/20', video: { url: 'https://cdn.example/video.mp4' } }];
  await f.create({ translateTweet: async id => {
    lookedUp.push(id);
    return { ...translatedText, hasVideo: true, hasMedia: true };
  } })(f.source);
  assert.equal(f.state.originalDeleted, true);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].deleted, false);
  assert(f.sent[0].message.content.includes(hidden));
  assert.match(f.sent[0].message.content, /https:\/\/g\.fixupx\.com\/jack\/status\/20/);
  assert.deepEqual(lookedUp, ['20']);
  assert.deepEqual(f.expectedChecks.map(items => items.map(item => item.url)), [['https://g.fixupx.com/jack/status/20']]);
  assert(!JSON.stringify(f.sent[0].options.components).includes('/status/25'));
});

test('quoted media still needs a preview when its parent is delivered as translated text', async () => {
  const f = delivery(`${ORIGINAL_X} https://x.com/author/status/21`);
  f.state.render = () => [];
  await f.create({ translateTweet: async id => ({ ...translatedText, ...(id === '20' ? {
    quote: { ...translatedText, url: 'https://x.com/quoted/status/22', hasVideo: true, hasMedia: true },
  } : {}) }) })(f.source);
  assert.equal(f.state.originalDeleted, false);
  assert.equal(f.sent[0].deleted, true);
  assert.equal(f.expectedChecks[0][0].source, 'https://x.com/quoted/status/22');
});

for (const quoted of [false, true]) {
  test(`a translated ${quoted ? 'quoted' : 'parent'} video cannot pass as a thumbnail-only preview`, async () => {
    const f = delivery(quoted ? `${ORIGINAL_X} https://x.com/author/status/21` : ORIGINAL_X);
    const url = quoted ? 'https://x.com/quoted/status/22' : 'https://x.com/jack/status/20';
    f.state.render = () => [{ url, title: 'A video post', description: 'Its caption.', thumbnail: { url: 'https://cdn.example/poster.jpg' } }];
    await f.create({ translateTweet: async id => quoted ? {
      ...translatedText, ...(id === '20' ? {
        quote: { ...translatedText, url, hasVideo: true, hasMedia: true },
      } : {}),
    } : { ...translatedText, hasVideo: true, hasMedia: true } })(f.source);
    assert.equal(f.state.originalDeleted, false, quoted ? 'quoted video' : 'parent video');
    assert.equal(f.sent[0].deleted, true, 'a thumbnail cannot replace the requested video player');
  });
}

test('quoted video fallback retains translated captions and verifies the recovered quoted post', async () => {
  const f = delivery(`${ORIGINAL_X} https://x.com/author/status/21`);
  f.state.render = round => round === 1 ? [] : [{
    url: 'https://vxtwitter.com/quoted/status/22', video: { url: 'https://cdn.example/quoted-video.mp4' },
  }];
  await f.create({ translateTweet: async id => ({ ...translatedText, ...(id === '20' ? {
    quote: { ...translatedText, text: 'The translated quoted video.', url: 'https://x.com/quoted/status/22', hasVideo: true, hasMedia: true },
  } : {}) }) })(f.source);
  assert.equal(f.state.originalDeleted, true);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].deleted, false);
  assert.deepEqual(f.expectedChecks.map(items => items.map(item => item.url)), [
    ['https://g.fixupx.com/quoted/status/22'], ['https://vxtwitter.com/quoted/status/22'],
  ]);
  assert.match(f.sent[0].message.content, /<https:\/\/fixupx\.com\/jack\/status\/20>/);
  assert.match(f.sent[0].message.content, /The translated quoted video\./);
  assert.equal(f.sent[0].message.content.match(/The translated post\./g)?.length, 2);
});

test('a failure notice is cancelled if setup changes during source fetch or ownership persistence', async () => {
  for (const stage of ['fetch', 'remember'] as const) {
    const f = delivery();
    f.state.render = () => [];
    if (stage === 'fetch') {
      const fetchSource = f.source.fetch.bind(f.source);
      f.source.fetch = async () => { const source = await fetchSource(true); f.state.enabled = false; return source; };
    } else f.state.remember = async () => { f.state.enabled = false; return true; };
    await f.create()(f.source);
    assert.equal(f.state.originalDeleted, false);
    assert(f.sent.every(entry => entry.deleted), stage);
    assert.equal(f.sent.length, stage === 'fetch' ? 1 : 2);
  }
});

const instagramCaption = (shortcode = 'ABC', kind = 'p', mediaTypes = ['GraphImage']): InstagramTranslation => ({
  sourceUrl: `https://www.instagram.com/${kind}/${shortcode}/`, shortcode, username: 'traveller',
  text: 'This is the full English caption.', languages: ['et'], mediaOnlyUrl: `https://g.instagram7.com/p/${shortcode}/`, mediaTypes,
});
const instagramImage = (shortcode = 'ABC'): APIEmbed => ({ url: `https://g.instagram7.com/p/${shortcode}/`,
  image: { url: `https://cdn.example/${shortcode}.jpg` } });
const instagramVideo = (shortcode = 'ABC'): APIEmbed => ({ url: `https://g.instagram7.com/p/${shortcode}/`,
  video: { url: `https://cdn.example/${shortcode}.mp4` } });

test('translated Instagram images and reels retain their native media before replacing the original', async () => {
  for (const kind of ['p', 'reel']) {
    const caption = instagramCaption('ABC', kind, [kind === 'reel' ? 'GraphVideo' : 'GraphImage']);
    const f = delivery(caption.sourceUrl), preview = kind === 'reel' ? instagramVideo() : instagramImage();
    const lookups: string[] = [];
    f.state.render = () => [preview];
    await f.create({ translateInstagram: async source => { lookups.push(source); return caption; } })(f.source);
    assert.deepEqual(lookups, [caption.sourceUrl]); assert.equal(f.sent.length, 1);
    const replacement = f.sent[0];
    assert.equal(replacement.deleted, false); assert.equal(f.state.originalDeleted, true);
    assert.match(replacement.message.content, /This is the full English caption\./);
    assert.match(replacement.message.content, /Translated from Estonian/);
    assert(replacement.message.content.includes(caption.mediaOnlyUrl));
    assert.equal(replacement.options.embeds, undefined, 'rich embeds must not suppress native media');
    assert.deepEqual(replacement.message.embeds.map(embed => embed.toJSON()), [preview]);
    assert.deepEqual(f.expectedChecks, [[{ source: caption.sourceUrl, url: caption.mediaOnlyUrl,
      platform: 'instagram', providerId: 'instagram7', captionFree: true, ...(kind === 'reel' ? { requireVideo: true } : {}) }]]);
    assert.equal(f.remembered[0].mode, 'replace');
    assert(f.events.indexOf('delete:source') > f.events.indexOf('verify:1:passed'));
    assert.match(JSON.stringify(replacement.message.components), /linky:remove/);
  }
});

test('an Instagram p link identified as GraphVideo requires video metadata, not merely an image', async () => {
  for (const playable of [false, true]) {
    const caption = instagramCaption('ABC', 'p', ['GraphVideo']), f = delivery(caption.sourceUrl);
    f.state.render = () => [playable ? instagramVideo() : instagramImage()];
    await f.create({ translateInstagram: async () => caption })(f.source);
    assert.equal(f.expectedChecks[0][0].requireVideo, true);
    assert.equal(f.state.originalDeleted, playable);
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0].deleted, false);
    assert.equal(f.remembered[0].mode, playable ? 'replace' : 'reply');
    assert.equal(f.sent[0].message.embeds.length, playable ? 1 : 0);
  }
});

test('a media preview repeating the original Instagram caption is rejected instead of duplicating languages', async () => {
  const caption = instagramCaption(), f = delivery(caption.sourceUrl);
  f.state.render = () => [{ ...instagramImage(), description: 'See on algne eestikeelne pealdis.' }];
  await f.create({ translateInstagram: async () => caption })(f.source);
  assert.equal(f.state.originalDeleted, false);
  assert.equal(f.expectedChecks[0][0].captionFree, true);
  assert(f.events.includes('verify:1:failed'));
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].deleted, false);
  assert.equal(f.sent[0].message.embeds.length, 0);
  assert(!f.sent[0].message.content.includes('See on algne'));
  assert.equal(f.sent[0].message.content.match(/This is the full English caption\./g)?.length, 1);
  assert.equal(f.remembered[0].mode, 'reply');
});

test('missing Instagram media keeps one owned English caption, suppresses its gallery embed and preserves the source', async () => {
  for (const mode of ['replace', 'reply'] as const) {
    const caption = instagramCaption(), f = delivery(caption.sourceUrl);
    f.state.preferences = { mode }; f.state.render = () => [];
    await f.create({ translateInstagram: async () => caption })(f.source);
    assert.equal(f.sent.length, 1, 'keep the useful caption rather than sending another public retry notice');
    const replacement = f.sent[0];
    assert.equal(replacement.deleted, false); assert.equal(f.state.originalDeleted, false);
    assert(replacement.message.content.includes(caption.mediaOnlyUrl));
    assert(replacement.edits.some(edit => edit.flags === MessageFlags.SuppressEmbeds));
    assert.match(replacement.message.content, /This is the full English caption\./);
    assert.match(replacement.message.content, /preview could not be verified; the original post is still here/);
    assert.deepEqual(replacement.message.embeds, []);
    const controls = JSON.stringify(replacement.message.components.map(component => component.toJSON()));
    assert.match(controls, /Original post/); assert.match(controls, /linky:remove/);
    assert(controls.includes(caption.sourceUrl));
    assert.deepEqual(f.remembered, [{ guildId: GUILD, channelId: CHANNEL, sourceId: SOURCE,
      replacementId: replacement.message.id, authorId: AUTHOR, mode: 'reply' }]);
    assert.equal(f.expectedChecks.length, 1, 'never retry an ordinary provider that would restore the original-language caption');
    assert(f.expectedChecks.flat().every(item => item.url === caption.mediaOnlyUrl && item.captionFree));
    assert(replacement.edits.some(edit => Array.isArray(edit.embeds) && edit.embeds.length === 0));
  }
});

test('multi-post and mixed-platform Instagram failures use complete-delivery rollback', async () => {
  for (const other of ['instagram', 'x']) {
    const caption = instagramCaption(), second = instagramCaption('DEF');
    const f = delivery(`${caption.sourceUrl} ${other === 'instagram' ? second.sourceUrl : ORIGINAL_X}`);
    // One usable preview cannot authorize deleting a source containing another broken post.
    f.state.render = () => other === 'instagram' ? [instagramImage('DEF')] : [xPreview];
    await f.create({ translateInstagram: async source => source === second.sourceUrl ? second : caption })(f.source);
    assert.equal(f.state.originalDeleted, false); assert.equal(f.sent.length, 2);
    assert.equal(f.sent[0].deleted, true); assert.equal(f.sent[1].deleted, false);
    assert.match(f.sent[1].message.content, /Your original is still here/);
    assert.equal(f.remembered.length, 1); assert.equal(f.remembered[0].replacementId, f.sent[1].message.id);
    assert.equal(f.remembered[0].mode, 'reply');
    assert.equal(f.expectedChecks[0].length, 2);
    assert(f.expectedChecks.flat().filter(item => item.platform === 'instagram').every(item => item.url.startsWith('https://g.instagram7.com/p/')));
  }
});

test('source edits and translation preference changes during Instagram lookup or caption fallback cancel stale output', async () => {
  for (const stage of ['lookup', 'fallback']) for (const change of ['source', 'preference']) {
    const caption = instagramCaption(), f = delivery(caption.sourceUrl);
    f.state.render = () => [];
    let changed = false;
    const mutate = () => {
      changed = true;
      if (change === 'source') { f.state.remoteContent = 'The author corrected this message.'; f.state.editedTimestamp = 123; }
      else f.state.preferences = { ...f.state.preferences, translateInstagram: false };
    };
    if (stage === 'fallback') f.state.duringEdit = async edit => {
      if (String(edit.content).includes('Instagram preview could not be verified')) mutate();
    };
    await f.create({ translateInstagram: async () => { if (stage === 'lookup') mutate(); return caption; } })(f.source);
    assert.equal(changed, true, `${stage}/${change}`);
    assert.equal(f.state.originalDeleted, false, `${stage}/${change}`);
    assert(f.sent.every(entry => entry.deleted), `${stage}/${change}: no stale caption survives`);
    assert.deepEqual(f.remembered, [], `${stage}/${change}`);
    if (change === 'source') assert.equal(f.state.remoteContent, 'The author corrected this message.');
  }
});

test('Instagram caption fallback is removed if its ownership cannot be persisted', async () => {
  for (const failure of ['false', 'throw', 'late edit']) {
    const caption = instagramCaption(), f = delivery(caption.sourceUrl);
    f.state.render = () => [];
    f.state.remember = async record => {
      assert.equal(record.mode, 'reply');
      if (failure === 'throw') throw new Error('ownership unavailable');
      if (failure === 'false') return false;
      f.state.remoteContent = 'An edit while saving the caption.'; f.state.editedTimestamp = 123; return true;
    };
    await f.create({ translateInstagram: async () => caption })(f.source);
    assert.equal(f.state.originalDeleted, false); assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].deleted, true);
  }
});

test('repeated Instagram links near the content limit use bounded fallback and do not suppress a fresh preview', async () => {
  const caption = instagramCaption(), content = Array(4).fill(caption.sourceUrl).join(' ');
  const baseline = delivery(content); baseline.state.render = () => [];
  await baseline.create({ translateInstagram: async () => caption })(baseline.source);
  const notice = '\n-# Instagram preview could not be verified; the original post is still here.';
  // Leave room for the notice, regardless of how many copies of the link were shared.
  const padding = 1998 - String(baseline.sent[0].options.content).length - notice.length;
  assert(padding > 0);
  const long = { ...caption, text: caption.text + 'x'.repeat(padding) }, f = delivery(content);
  f.state.render = () => [];
  const handle = f.create({ translateInstagram: async () => long });
  await handle(f.source);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].deleted, false);
  assert(f.sent[0].message.content.length <= 2000, 'suppression must not add characters for every repeated URL');
  assert.equal(f.state.originalDeleted, false); assert.equal(f.remembered[0].mode, 'reply');
  assert(f.sent[0].edits.some(edit => edit.flags === MessageFlags.SuppressEmbeds));
  assert(f.sent[0].message.content.includes(long.text));
  f.state.render = () => [instagramImage()];
  await handle(f.source, { refresh: true, forceReply: true });
  const refreshed = f.sent[1];
  assert.equal(refreshed.options.flags, undefined);
  assert(!refreshed.edits.some(edit => edit.flags === MessageFlags.SuppressEmbeds));
  assert.deepEqual(refreshed.message.embeds.map(embed => embed.toJSON()), [instagramImage()]);
});
