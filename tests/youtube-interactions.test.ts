import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageFlags, type APIEmbed, type ButtonInteraction, type InteractionEditReplyOptions,
  type InteractionReplyOptions, type InteractionDeferReplyOptions } from 'discord.js';
import { replyToYouTubeControl } from '../src/services/YouTubeInteractions';
import type { YouTubeStatistics, YouTubeDisplay } from '../src/services/YouTube';
import { YouTubeStats } from '../src/services/YouTubeStats';

const VIDEO = 'dQw4w9WgXcQ', BOT = '1491240385031311470';
const GUILD = '1491242184391917590', CHANNEL = '1491242185331576884', MESSAGE = '1491242185331576885';
const sample: YouTubeStatistics = { viewCount: '12345', likeCount: '0', commentCount: '7',
  topComment: { author: '@everyone Viewer', text: 'A useful video. https://example.com @everyone' } };

function fixture(action = 'stats') {
  const events: string[] = [], replies: InteractionReplyOptions[] = [], edits: InteractionEditReplyOptions[] = [];
  const deferred: InteractionDeferReplyOptions[] = [], lookups: string[][] = [];
  const displays: (YouTubeDisplay | undefined)[] = [];
  const permissions: [string, string, string][] = [];
  let active = true, tracked = true, fetch = async (): Promise<Map<string, YouTubeStatistics>> => new Map([[VIDEO, sample]]);
  let onDefer = () => {};
  const interaction = {
    customId: `linky:yt:${action}:${VIDEO}`, guildId: GUILD as string | null, channelId: CHANNEL as string | null,
    message: { id: MESSAGE, guildId: GUILD as string | null, channelId: CHANNEL, author: { id: BOT } },
    reply: async (options: InteractionReplyOptions) => { events.push('reply'); replies.push(options); },
    deferReply: async (options: InteractionDeferReplyOptions) => { events.push('defer'); deferred.push(options); onDefer(); },
    editReply: async (options: InteractionEditReplyOptions) => { events.push('edit'); edits.push(options); },
  };
  const options = {
    stats: { canView: (message: { id: string; channelId: string; author: { id: string } }, videoId: string) =>
      tracked && message.id === MESSAGE && message.channelId === CHANNEL && message.author.id === BOT && videoId === VIDEO },
    lookup: async (ids: readonly string[], display?: YouTubeDisplay) => {
      events.push('lookup'); lookups.push([...ids]); displays.push(display); return fetch();
    },
    enabled: (guildId: string, channelId: string, kind: 'stats' | 'comment') => {
      permissions.push([guildId, channelId, kind]); return active;
    },
  };
  return { interaction, options, events, replies, edits, deferred, lookups, displays, permissions,
    run: () => replyToYouTubeControl(interaction as unknown as ButtonInteraction, options),
    active: (value: boolean) => { active = value; }, tracked: (value: boolean) => { tracked = value; },
    fetch: (value: typeof fetch) => { fetch = value; }, onDefer: (value: typeof onDefer) => { onDefer = value; },
  };
}

function assertPrivate(f: ReturnType<typeof fixture>) {
  for (const reply of f.replies) assert.equal(reply.flags, MessageFlags.Ephemeral);
  for (const reply of f.deferred) assert.equal(reply.flags, MessageFlags.Ephemeral);
  for (const reply of [...f.replies, ...f.edits]) {
    assert.deepEqual(reply.allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
  }
}

test('statistics control privately returns labeled counts, keeps zero, and omits the comment', async () => {
  const f = fixture(); assert.equal(await f.run(), true);
  assert.deepEqual(f.events, ['defer', 'lookup', 'edit']); assertPrivate(f);
  assert.deepEqual(f.lookups, [[VIDEO]]);
  assert.deepEqual(f.displays, ['counts'], 'opening statistics must not fetch comment data');
  assert(f.permissions.every(value => value.join(':') === `${GUILD}:${CHANNEL}:stats`));
  const embed = f.edits[0].embeds![0] as APIEmbed;
  assert.equal(embed.title, 'YouTube stats');
  assert.equal(embed.url, `https://www.youtube.com/watch?v=${VIDEO}`);
  assert.deepEqual(embed.fields, [
    { name: 'Views', value: '**12,345**', inline: true },
    { name: 'Likes', value: '**0**', inline: true },
    { name: 'Comments', value: '**7**', inline: true },
  ]);
  assert.equal(embed.footer?.text, 'Recent YouTube snapshot');
  assert(!JSON.stringify(embed).includes('A useful video'));
});

test('comment control privately returns a bounded sanitized comment, author and video link', async () => {
  const f = fixture('comment'); assert.equal(await f.run(), true); assertPrivate(f);
  assert.deepEqual(f.displays, ['counts-and-comment']);
  assert(f.permissions.every(value => value[2] === 'comment'));
  const embed = f.edits[0].embeds![0] as APIEmbed;
  assert.equal(embed.title, 'Top YouTube comment');
  assert.equal(embed.url, `https://www.youtube.com/watch?v=${VIDEO}`);
  assert.equal(embed.footer?.text, 'Recent YouTube snapshot');
  assert.match(embed.description!, /A useful video/); assert.match(embed.description!, /By /);
  assert(!embed.description?.includes('@everyone')); assert(!embed.description?.includes('https://example.com'));
  assert.equal(embed.fields, undefined);
});

test('an uncached message may use the interaction guild when its channel and recorded ownership match', async () => {
  const f = fixture(); f.interaction.message.guildId = null;
  assert.equal(await f.run(), true); assertPrivate(f);
  assert.deepEqual(f.events, ['defer', 'lookup', 'edit']);
});

test('unrelated buttons are not acknowledged or looked up', async () => {
  for (const id of ['remove:message', 'linky:settings:youtube', 'setup', 'linky:yt-other:stats:' + VIDEO]) {
    const f = fixture(); f.interaction.customId = id;
    assert.equal(await f.run(), false); assert.deepEqual(f.events, []);
  }
});

test('malformed, stale, disabled, foreign and mismatched controls make no API requests', async () => {
  const cases: [string, (f: ReturnType<typeof fixture>) => void][] = [
    ['malformed', f => { f.interaction.customId = 'linky:yt:stats:bad'; }],
    ['unknown action', f => { f.interaction.customId = `linky:yt:delete:${VIDEO}`; }],
    ['untracked', f => { f.tracked(false); }],
    ['disabled', f => { f.active(false); }],
    ['foreign author', f => { f.interaction.message.author.id = '1491240385031311499'; }],
    ['foreign message', f => { f.interaction.message.id = '1491240385031311499'; }],
    ['wrong video', f => { f.interaction.customId = 'linky:yt:stats:abcdefghijk'; }],
    ['mismatched channel', f => { f.interaction.channelId = '1491240385031311499'; }],
    ['mismatched guild', f => { f.interaction.guildId = '1491240385031311499'; }],
    ['outside guild', f => { f.interaction.guildId = null; }],
    ['missing channel', f => { f.interaction.channelId = null; }],
  ];
  for (const [name, change] of cases) {
    const f = fixture(); change(f); assert.equal(await f.run(), true, name);
    assert.deepEqual(f.events, ['reply'], name); assertPrivate(f);
    assert.match(String(f.replies[0].content), /no longer available/);
  }
});

test('missing lookup or cleanup manager replies privately without making API requests', async () => {
  for (const key of ['lookup', 'stats'] as const) {
    const f = fixture(); const options = { ...f.options, [key]: undefined };
    assert.equal(await replyToYouTubeControl(f.interaction as unknown as ButtonInteraction, options), true);
    assert.deepEqual(f.events, ['reply']); assertPrivate(f);
  }
});

test('authorization is checked after deferral and again after the API response', async () => {
  for (const stage of ['defer', 'lookup']) for (const change of ['scope', 'expiry', 'channel']) {
    const f = fixture();
    const revoke = () => {
      if (change === 'scope') f.active(false);
      if (change === 'expiry') f.tracked(false);
      if (change === 'channel') f.interaction.message.channelId = '1491240385031311499';
    };
    if (stage === 'defer') f.onDefer(revoke);
    else f.fetch(async () => { revoke(); return new Map([[VIDEO, sample]]); });
    assert.equal(await f.run(), true);
    assert.deepEqual(f.events, ['defer', ...(stage === 'lookup' ? ['lookup'] : []), 'edit']);
    assertPrivate(f); assert.deepEqual(f.edits[0].embeds, []);
    assert.match(String(f.edits[0].content), /no longer available/);
  }
});

test('API failure, missing video and missing requested data produce friendly private replies', async () => {
  for (const action of ['stats', 'comment']) for (const failure of ['throw', 'missing video', 'missing data']) {
    const f = fixture(action);
    f.fetch(async () => {
      if (failure === 'throw') throw new Error('secret-api-key-and-provider-error');
      if (failure === 'missing video') return new Map();
      return new Map([[VIDEO, action === 'stats' ? { topComment: sample.topComment } : { viewCount: '5' }]]);
    });
    assert.equal(await f.run(), true); assertPrivate(f);
    assert.deepEqual(f.edits[0].embeds, []); assert.match(String(f.edits[0].content), /not available/);
    assert(!JSON.stringify(f.edits).includes('secret-api-key'));
  }
});

test('a restarted cleanup manager permits a recorded control and rejects it after expiry', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'linky-youtube-controls-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'youtube-stats.json');
  await writeFile(path, JSON.stringify([{ kind: 'controls', channelId: CHANNEL, messageId: MESSAGE,
    expiresAt: 1000, videoIds: [VIDEO] }]));
  let time = 500;
  const stats = new YouTubeStats({ path, botUserId: BOT, now: () => time, fetchMessage: async () => null });
  for (const action of ['stats', 'comment']) {
    const f = fixture(action);
    assert.equal(await replyToYouTubeControl(f.interaction as unknown as ButtonInteraction, { ...f.options, stats }), true);
    assert.deepEqual(f.events, ['defer', 'lookup', 'edit']); assertPrivate(f);
  }
  time = 1000;
  const expired = fixture();
  assert.equal(await replyToYouTubeControl(expired.interaction as unknown as ButtonInteraction, { ...expired.options, stats }), true);
  assert.deepEqual(expired.events, ['reply']); assertPrivate(expired);
});
