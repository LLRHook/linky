import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ButtonStyle, ComponentType, EmbedType, type APIEmbed, type APIMessageTopLevelComponent, type MessageEditOptions } from 'discord.js';
import { formatYouTubeStatistics } from '../src/services/YouTube';
import { YouTubeStats, YOUTUBE_STATS_TTL, type StatsMessage } from '../src/services/YouTubeStats';

const BOT = '1491240385031311470', CHANNEL = '373953687812440066';
const VIDEO = 'dQw4w9WgXcQ', SECOND = 'u0_UyltqaFI';
const cards: APIEmbed[] = [formatYouTubeStatistics({ viewCount: '12345', likeCount: '0', commentCount: '4',
  topComment: { text: 'Private test excerpt', author: 'Viewer' } }, `https://www.youtube.com/watch?v=${VIDEO}`)!];
const base = 'Original shared message and native video link';
const suffix = `-# [YouTube](<https://www.youtube.com/watch?v=${VIDEO}>) · 12,345 views · snapshot when shared\n> Top comment by Viewer: Private test excerpt`;
const legacy = (message: StatsMessage, expiresAt = YOUTUBE_STATS_TTL) => ({ channelId: message.channelId,
  messageId: message.id, expiresAt, baseLength: base.length, suffixLength: suffix.length + 2 });
const otherRow: APIMessageTopLevelComponent = { type: ComponentType.ActionRow, components: [
  { type: ComponentType.Button, style: ButtonStyle.Secondary, custom_id: 'linky:remove:original', label: 'Remove' },
] };
type TestMessage = StatsMessage & { embeds: APIEmbed[] };
const componentsOf = (message: StatsMessage) => message.components?.map(component => component.toJSON()) ?? [];
const setComponents = (message: StatsMessage, components: APIMessageTopLevelComponent[]) => {
  message.components = components.map(component => ({ toJSON: () => structuredClone(component) }));
};

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'linky-youtube-')), path = join(directory, 'expiry.json');
  let time = 0, fetchError: unknown, writeError = false, nextId = 1491240385031311471n;
  const messages = new Map<string, TestMessage>();
  const errors: Error[] = [], edits: { id: string; options: MessageEditOptions }[] = [], removed: string[] = [], managers: YouTubeStats[] = [];
  const message = (content = base): TestMessage => {
    const value: TestMessage = { id: String(nextId++), channelId: CHANNEL, author: { id: BOT }, content,
      embeds: [{ type: EmbedType.Video }], components: [],
      edit: async options => {
        edits.push({ id: value.id, options });
        assert.equal(options.allowedMentions?.repliedUser, false);
        assert.deepEqual(options.allowedMentions?.parse, []);
        if (options.content !== undefined && options.content !== null) value.content = options.content;
        if (options.embeds) value.embeds = options.embeds as APIEmbed[];
        if (options.components) setComponents(value, options.components as APIMessageTopLevelComponent[]);
      },
      delete: async () => { removed.push(value.id); messages.delete(value.id); },
    };
    messages.set(value.id, value); return value;
  };
  const video = message();
  const manager = (customWrite?: (path: string, content: string) => Promise<void>) => {
    const instance = new YouTubeStats({ path, botUserId: BOT, now: () => time,
      fetchMessage: async (channel, id) => {
        assert.equal(channel, CHANNEL);
        if (fetchError) throw fetchError;
        return messages.get(id) ?? null;
      }, onError: error => errors.push(error), ...(customWrite ? { write: customWrite } : {}),
    });
    managers.push(instance); return instance;
  };
  t.after(async () => { managers.forEach(instance => instance.stop()); await rm(directory, { recursive: true, force: true }); });
  return { path, messages, edits, removed, errors, message, manager, video,
    advance: (amount = YOUTUBE_STATS_TTL) => { time += amount; },
    failFetch: (error?: unknown) => { fetchError = error; },
    failWrite: () => { writeError = true; },
    write: async (file: string, content: string) => { if (writeError) throw new Error('disk denied'); await writeFile(file, content); },
    records: async () => JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>[],
  };
}

test('publishes controls on the same video only after recording expiry and authorized video IDs', async t => {
  const f = await fixture(t), manager = f.manager(), edit = f.video.edit;
  f.video.edit = async options => {
    assert.equal((await f.records())[0].messageId, f.video.id);
    assert.deepEqual((await f.records())[0].videoIds, [VIDEO]);
    return edit(options);
  };
  const published = await manager.publish(f.video, cards);
  assert(published); assert.equal(f.edits.length, 1); assert.equal(f.messages.size, 1);
  assert.deepEqual(Object.keys(f.edits[0].options).sort(), ['allowedMentions', 'components']);
  assert.deepEqual(f.edits[0].options.allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
  assert.equal(f.video.content, base); assert.deepEqual(f.video.embeds, [{ type: EmbedType.Video }]);
  assert.deepEqual(published.controls, componentsOf(f.video));
  assert.match(JSON.stringify(published.controls), /linky:yt:stats:dQw4w9WgXcQ/);
  assert.match(JSON.stringify(published.controls), /linky:yt:comment:dQw4w9WgXcQ/);
  const serialized = await readFile(f.path, 'utf8');
  for (const privateValue of ['12,345', 'Private test excerpt', 'youtube.com', base]) assert(!serialized.includes(privateValue));
  assert.deepEqual(Object.keys((await f.records())[0]).sort(), ['channelId', 'expiresAt', 'kind', 'messageId', 'videoIds']);
  assert.equal((await f.records())[0].expiresAt, YOUTUBE_STATS_TTL);
  assert.equal((await f.records())[0].kind, 'controls');
});

test('interaction authorization survives restart and rejects other messages, authors, channels and video IDs', async t => {
  const f = await fixture(t), manager = f.manager();
  assert.equal(manager.canView(f.video, VIDEO), false);
  await manager.publish(f.video, cards); const restarted = f.manager();
  assert.equal(restarted.canView(f.video, VIDEO), true);
  assert.equal(restarted.canView(f.video, SECOND), false);
  assert.equal(restarted.canView({ ...f.video, id: '1491240385031311480' }, VIDEO), false);
  assert.equal(restarted.canView({ ...f.video, channelId: '1491240385031311480' }, VIDEO), false);
  assert.equal(restarted.canView({ ...f.video, author: { id: '1491240385031311480' } }, VIDEO), false);
  f.advance(); assert.equal(restarted.canView(f.video, VIDEO), false);
});

test('repeat publication verifies controls without duplicating rows or extending expiry', async t => {
  const f = await fixture(t), manager = f.manager();
  await manager.publish(f.video, cards); f.advance(1000);
  setComponents(f.video, []);
  assert(await f.manager().publish(f.video, cards));
  assert.equal(componentsOf(f.video).length, 1); assert.equal(f.edits.length, 2);
  assert.equal((await f.records())[0].expiresAt, YOUTUBE_STATS_TTL);
  f.advance(); assert.equal(await f.manager().publish(f.video, cards), null);
  assert.deepEqual(componentsOf(f.video), []); assert.deepEqual(await f.records(), []);
  assert.equal(f.messages.size, 1);
});

test('expiry removes only YouTube controls, preserving unrelated buttons and native video', async t => {
  const f = await fixture(t), manager = f.manager();
  setComponents(f.video, [otherRow]);
  const publication = await manager.publish(f.video, cards);
  assert(publication); assert.equal(publication.controls?.length, 1);
  assert.deepEqual(componentsOf(f.video)[0], otherRow);
  assert.equal(componentsOf(f.video).length, 2);
  await manager.sweep(); assert.equal(f.edits.length, 1);
  f.advance(); await f.manager().sweep();
  assert.deepEqual(componentsOf(f.video), [otherRow]);
  assert.equal(f.video.content, base); assert.deepEqual(f.video.embeds, [{ type: EmbedType.Video }]);
  assert.deepEqual(f.removed, []); assert.deepEqual(await f.records(), []);
});

test('components added while the journal is being saved survive publication', async t => {
  const f = await fixture(t), manager = f.manager(async (path, content) => {
    await writeFile(path, content); setComponents(f.video, [otherRow]);
  });
  assert(await manager.publish(f.video, cards));
  assert.deepEqual(componentsOf(f.video)[0], otherRow);
});

test('restart cleans mixed legacy suffix, old card and new control records correctly', async t => {
  const f = await fixture(t), old = f.message(base + '\n\n' + suffix), card = f.message('Older API details');
  await writeFile(f.path, JSON.stringify([legacy(old), { kind: 'card', channelId: CHANNEL, messageId: card.id,
    baseMessageId: old.id, expiresAt: YOUTUBE_STATS_TTL }]));
  const manager = f.manager(); await manager.publish(f.video, cards);
  assert.equal(manager.canView(old, VIDEO), false); assert.equal(manager.canView(card, VIDEO), false);
  f.advance(); await f.manager().sweep();
  assert.deepEqual(f.removed, [card.id]); assert.equal(old.content, base);
  assert.deepEqual(componentsOf(f.video), []); assert.equal(f.video.content, base);
  assert.deepEqual(old.embeds, [{ type: EmbedType.Video }]); assert.deepEqual(await f.records(), []);
});

test('failed journal writes make no Discord edit and do not poison later publication', async t => {
  const f = await fixture(t); let fail = true;
  const manager = f.manager(async (path, content) => {
    if (fail) throw new Error('write failure'); await writeFile(path, content);
  });
  assert.equal(await manager.publish(f.video, cards), null);
  assert.equal(f.edits.length, 0); assert.equal(f.removed.length, 0); assert.equal(f.errors.length, 1);
  assert.equal(manager.canView(f.video, VIDEO), false);
  fail = false; assert(await manager.publish(f.video, cards));
});

test('uncertain component publication immediately disables authorization and retains failed cleanup for restart', async t => {
  const f = await fixture(t), manager = f.manager(), edit = f.video.edit;
  let calls = 0;
  f.video.edit = async options => {
    if (calls++ === 0) { await edit(options); throw new Error('response lost after edit'); }
    throw { code: 50013 };
  };
  assert.equal(await manager.publish(f.video, cards), null);
  assert.equal(componentsOf(f.video).length, 1, 'the first request may have succeeded');
  assert.equal((await f.records())[0].expiresAt, 0); assert.equal(manager.canView(f.video, VIDEO), false);
  f.video.edit = edit; await f.manager().sweep();
  assert.deepEqual(componentsOf(f.video), []); assert.deepEqual(await f.records(), []);
  assert.equal(f.video.content, base); assert.deepEqual(f.removed, []);
});

test('rollback removes only its controls and remains idempotent', async t => {
  const f = await fixture(t), manager = f.manager(); setComponents(f.video, [otherRow]);
  const publication = await manager.publish(f.video, cards);
  assert(publication); await publication.remove(); await publication.remove();
  assert.deepEqual(componentsOf(f.video), [otherRow]); assert.equal(f.edits.length, 2);
  assert.equal(manager.canView(f.video, VIDEO), false); assert.deepEqual(f.removed, []);
  assert.deepEqual(await f.records(), []);
});

test('base-message removal finds controls and old associated cards after restart', async t => {
  const f = await fixture(t), oldCard = f.message('Older API details'), other = f.message();
  await writeFile(f.path, JSON.stringify([{ kind: 'card', channelId: CHANNEL, messageId: oldCard.id,
    baseMessageId: f.video.id, expiresAt: YOUTUBE_STATS_TTL }]));
  const manager = f.manager(); await manager.publish(f.video, cards); await manager.publish(other, cards);
  const restarted = f.manager(); await restarted.removeForMessage(f.video.id);
  assert.deepEqual(f.removed, [oldCard.id]); assert.deepEqual(componentsOf(f.video), []);
  assert.equal((await f.records()).length, 1); assert.equal((await f.records())[0].messageId, other.id);
  assert.equal(restarted.canView(other, VIDEO), true); assert(f.messages.has(f.video.id));
  await restarted.removeForMessage(f.video.id); assert.equal(f.removed.length, 1);
});

test('rollback failure retains an immediately expired record and does not delete the message', async t => {
  const f = await fixture(t), manager = f.manager(), publication = await manager.publish(f.video, cards);
  assert(publication); const edit = f.video.edit; f.video.edit = async () => { throw { code: 50013 }; };
  await publication.remove(); assert.equal((await f.records())[0].expiresAt, 0);
  assert.equal(manager.canView(f.video, VIDEO), false); assert.deepEqual(f.removed, []);
  f.video.edit = edit; await manager.sweep(); assert.deepEqual(await f.records(), []);
});

test('rollback attempts controls cleanup even when journal updates fail', async t => {
  const f = await fixture(t), manager = f.manager(f.write), publication = await manager.publish(f.video, cards);
  assert(publication); f.failWrite(); await publication.remove();
  assert.deepEqual(componentsOf(f.video), []); assert.deepEqual(f.removed, []);
  assert.equal(manager.canView(f.video, VIDEO), false);
  f.advance(); await f.manager().sweep(); assert.deepEqual(await f.records(), []);
});

test('serialized concurrent publications retain every record and authorize only each video ID', async t => {
  const f = await fixture(t), manager = f.manager(), second = f.message();
  const secondCards = [formatYouTubeStatistics({ viewCount: '1' }, `https://youtu.be/${SECOND}`)!];
  assert((await Promise.all([manager.publish(f.video, cards), manager.publish(second, secondCards)])).every(Boolean));
  assert.equal((await f.records()).length, 2); assert.equal(manager.canView(second, SECOND), true);
  assert.equal(manager.canView(second, VIDEO), false);
  f.advance(); await manager.sweep(); assert.deepEqual(await f.records(), []);
});

test('fetch and permission failures retain cleanup records for later retry', async t => {
  const f = await fixture(t), manager = f.manager(); await manager.publish(f.video, cards); f.advance();
  for (const failure of [new Error('network failed'), { code: 50001 }, { code: 50013, status: 403 }]) {
    f.failFetch(failure); await manager.sweep(); assert.equal((await f.records()).length, 1);
  }
  f.failFetch(); await manager.sweep(); assert.deepEqual(await f.records(), []); assert.equal(f.errors.length, 3);
});

test('missing messages and channels remove records without another Discord mutation', async t => {
  const f = await fixture(t);
  for (const failure of [{ code: 10003 }, { code: 10008 }, { status: 404 }, undefined]) {
    f.failFetch(); const manager = f.manager(), message = f.message();
    await manager.publish(message, cards); f.advance(); f.failFetch(failure);
    if (!failure) f.messages.delete(message.id);
    await manager.sweep(); assert.deepEqual(await f.records(), []);
  }
  assert.deepEqual(f.removed, []); assert.equal(f.edits.length, 4);
});

test('foreign authors and mismatched fetched messages cannot be edited or deleted', async t => {
  const f = await fixture(t), manager = f.manager();
  assert.equal(await manager.publish({ ...f.video, author: { id: '1491240385031311480' } }, cards), null);
  assert.equal(f.edits.length, 0); await manager.publish(f.video, cards); f.advance();
  const id = f.video.id; f.video.id = '1491240385031311480'; await manager.sweep();
  assert.equal((await f.records()).length, 1); assert.equal(f.edits.length, 1);
  f.video.id = id; f.video.author.id = '1491240385031311480'; await manager.sweep();
  assert.deepEqual(await f.records(), []); assert.equal(f.edits.length, 1); assert.deepEqual(f.removed, []);
});

test('legacy cleanup preserves changed and marker-like source text', async t => {
  const f = await fixture(t), old = f.message(base + '\n\n' + suffix);
  await writeFile(f.path, JSON.stringify([legacy(old, 0)])); const manager = f.manager();
  old.content += '\nUnexpected edit'; await manager.sweep(); assert.equal((await f.records()).length, 1);
  old.content = base + '\n\n' + suffix; await manager.sweep(); assert.equal(old.content, base);
  assert.deepEqual(Object.keys(f.edits[0].options).sort(), ['allowedMentions', 'content']);
  old.content = base + '\n\n' + suffix;
  await writeFile(f.path, JSON.stringify([{ ...legacy(old, 0), baseLength: old.content.length }]));
  await f.manager().sweep(); assert.equal(old.content, base + '\n\n' + suffix);
  assert.equal(f.edits.length, 1); assert.deepEqual(await f.records(), []);
});

test('journal write failure cannot starve later expired controls of cleanup', async t => {
  const f = await fixture(t), manager = f.manager(f.write), second = f.message();
  await manager.publish(f.video, cards); await manager.publish(second, cards); f.advance(); f.failWrite();
  await assert.rejects(manager.sweep(), /disk denied/);
  assert.deepEqual(componentsOf(f.video), []); assert.deepEqual(componentsOf(second), []);
  assert.equal((await f.records()).length, 2); assert.equal(f.edits.length, 4);
  await f.manager().sweep(); assert.deepEqual(await f.records(), []); assert.equal(f.edits.length, 4);
});

test('invalid inputs and full existing component rows cause no publication', async t => {
  const f = await fixture(t), manager = f.manager();
  for (const payload of [[], [{}], Array.from({ length: 4 }, () => cards[0])]) {
    assert.equal(await manager.publish(f.video, payload), null);
  }
  setComponents(f.video, Array.from({ length: 5 }, () => structuredClone(otherRow)));
  assert.equal(await manager.publish(f.video, cards), null);
  assert.equal(f.edits.length, 0);
});

test('startup removes expired controls and rejects corrupt journal records', async t => {
  const f = await fixture(t); await f.manager().publish(f.video, cards); f.advance();
  const restarted = f.manager(); restarted.start(); restarted.start(); await restarted.sweep();
  assert.deepEqual(componentsOf(f.video), []); assert.deepEqual(await f.records(), []);
  const valid = { kind: 'controls', channelId: CHANNEL, messageId: f.video.id, expiresAt: 0, videoIds: [VIDEO] };
  for (const record of [
    { ...valid, apiData: 'must not be stored' }, { ...valid, kind: 'other' }, { ...valid, expiresAt: -1 },
    { ...valid, videoIds: [] }, { ...valid, videoIds: [VIDEO, VIDEO] }, { ...valid, videoIds: ['bad-id'] },
    { ...valid, videoIds: [VIDEO, SECOND, 'aaaaaaaaaaa', 'bbbbbbbbbbb'] },
    { ...valid, baseMessageId: f.video.id }, { ...valid, videoIds: 'not an array' },
  ]) {
    await writeFile(f.path, JSON.stringify([record])); assert.throws(() => f.manager(), /Invalid YouTube cleanup records/);
  }
});

test('a full cleanup journal skips new publications before editing Discord', async t => {
  const f = await fixture(t);
  await writeFile(f.path, JSON.stringify(Array.from({ length: 10_000 }, (_, i) => ({ kind: 'controls', channelId: CHANNEL,
    messageId: String(2000000000000000000n + BigInt(i)), expiresAt: YOUTUBE_STATS_TTL, videoIds: [VIDEO] }))));
  assert.equal(await f.manager().publish(f.video, cards), null);
  assert.equal(f.edits.length, 0); assert.equal((await f.records()).length, 10_000);
});
