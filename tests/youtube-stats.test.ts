import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EmbedType, MessageFlags, type APIEmbed, type MessageCreateOptions, type MessageEditOptions } from 'discord.js';
import { YouTubeStats, YOUTUBE_STATS_TTL, type StatsMessage } from '../src/services/YouTubeStats';

const BOT = '1491240385031311470', CHANNEL = '373953687812440066';
const cards: APIEmbed[] = [{ title: 'YouTube', fields: [
  { name: 'Views', value: '12,345', inline: true },
  { name: 'Top comment', value: 'Private test excerpt' },
] }];
const base = 'Original shared message and native video link';
const suffix = '-# [YouTube](<https://www.youtube.com/watch?v=dQw4w9WgXcQ>) · 12,345 views · snapshot when shared\n> Top comment by Viewer: Private test excerpt';
const legacy = (message: StatsMessage, expiresAt = YOUTUBE_STATS_TTL) => ({ channelId: message.channelId,
  messageId: message.id, expiresAt, baseLength: base.length, suffixLength: suffix.length + 2 });
type TestMessage = StatsMessage & { embeds: APIEmbed[] };

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'linky-youtube-'));
  const path = join(directory, 'expiry.json');
  let time = 0, fetchError: unknown, writeError = false, createError = false, nextId = 1491240385031311471n;
  let prepareCard: (message: TestMessage) => void = () => {};
  const messages = new Map<string, TestMessage>();
  const errors: Error[] = [], creates: MessageCreateOptions[] = [], edits: MessageEditOptions[] = [];
  const removed: string[] = [], managers: YouTubeStats[] = [], events: string[] = [];
  const nonces = new Map<string, TestMessage>();
  const message = (content = base): TestMessage => {
    const value: TestMessage = { id: String(nextId++), channelId: CHANNEL, author: { id: BOT }, content, embeds: [],
      edit: async options => {
        events.push('edit'); edits.push(options);
        assert.equal(options.allowedMentions?.repliedUser, false);
        assert.deepEqual(options.allowedMentions?.parse, []);
        if (options.content !== undefined && options.content !== null) value.content = options.content;
        if (options.embeds) value.embeds = options.embeds as APIEmbed[];
      },
      delete: async () => { events.push('delete'); removed.push(value.id); messages.delete(value.id); },
    };
    messages.set(value.id, value);
    return value;
  };
  const video = message();
  const channel = { send: async (options: MessageCreateOptions): Promise<StatsMessage> => {
    events.push('send'); creates.push(options);
    if (createError) throw new Error('create denied');
    const nonce = String(options.nonce);
    const existing = nonces.get(nonce);
    if (existing && messages.has(existing.id)) return existing;
    const card = message(String(options.content));
    prepareCard(card); nonces.set(nonce, card);
    return card;
  } };
  const manager = (customWrite?: (path: string, content: string) => Promise<void>) => {
    const instance = new YouTubeStats({ path, botUserId: BOT, now: () => time,
      fetchMessage: async (channel, id) => {
        assert.equal(channel, CHANNEL);
        if (fetchError) throw fetchError;
        return messages.get(id) ?? null;
      }, onError: error => errors.push(error),
      ...(customWrite ? { write: customWrite } : {}),
    });
    managers.push(instance); return instance;
  };
  t.after(async () => { managers.forEach(instance => instance.stop()); await rm(directory, { recursive: true, force: true }); });
  return { path, messages, creates, edits, removed, errors, events, message, manager, video,
    target: { id: video.id, channelId: CHANNEL, author: video.author, channel },
    prepare: (value: typeof prepareCard) => { prepareCard = value; },
    advance: (amount = YOUTUBE_STATS_TTL) => { time += amount; },
    failFetch: (error?: unknown) => { fetchError = error; },
    failCreate: () => { createError = true; },
    failWrite: () => { writeError = true; },
    write: async (file: string, content: string) => { if (writeError) throw new Error('disk denied'); await writeFile(file, content); },
    records: async () => JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>[],
  };
}

test('sends an API-free card after the video and durably records expiry before editing it', async t => {
  const f = await fixture(t), manager = f.manager();
  f.video.embeds = [{ type: EmbedType.Video }];
  f.prepare(card => {
    const edit = card.edit;
    card.edit = async options => {
      assert.equal((await f.records())[0].messageId, card.id);
      assert.equal(card.content, 'YouTube details');
      return edit(options);
    };
  });
  assert(await manager.publish(f.target, cards));
  assert.deepEqual(f.events, ['send', 'edit']);
  assert.deepEqual(f.creates[0], { content: 'YouTube details', flags: MessageFlags.SuppressNotifications,
    allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
    nonce: `yt:${f.video.id}`, enforceNonce: true });
  assert.deepEqual(f.edits[0], { content: '', embeds: cards,
    allowedMentions: { parse: [], users: [], roles: [], repliedUser: false } });
  assert.equal(f.video.content, base);
  assert.deepEqual(f.video.embeds, [{ type: 'video' }]);
  const serialized = await readFile(f.path, 'utf8');
  for (const privateValue of ['12,345', 'Private test excerpt', 'youtube.com', base]) assert(!serialized.includes(privateValue));
  assert.deepEqual(Object.keys((await f.records())[0]).sort(), ['baseMessageId', 'channelId', 'expiresAt', 'kind', 'messageId']);
  assert.equal((await f.records())[0].baseMessageId, f.video.id);
  assert.equal((await f.records())[0].expiresAt, YOUTUBE_STATS_TTL);
});

test('duplicate nonce results verify publication without resetting expiry', async t => {
  const f = await fixture(t), manager = f.manager();
  assert(await manager.publish(f.target, cards)); f.advance(1000);
  assert(await manager.publish(f.target, cards));
  assert.equal((await f.records()).length, 1);
  assert.equal((await f.records())[0].expiresAt, YOUTUBE_STATS_TTL);
  assert.equal(f.edits.length, 2);
});

test('restart re-edits a journaled placeholder and refuses to republish an expired nonce result', async t => {
  const f = await fixture(t), manager = f.manager();
  await manager.publish(f.target, cards);
  const card = [...f.messages.values()].find(value => value.id !== f.video.id)!;
  card.content = 'YouTube details'; card.embeds = [];
  assert(await f.manager().publish(f.target, cards));
  assert.equal(card.content, ''); assert.deepEqual(card.embeds, cards);
  assert.equal((await f.records())[0].expiresAt, YOUTUBE_STATS_TTL);
  f.advance();
  assert.equal(await f.manager().publish(f.target, cards), null);
  assert.deepEqual(f.removed, [card.id]); assert.deepEqual(await f.records(), []);
});

test('restart expires both legacy suffixes and new cards while preserving both video messages', async t => {
  const f = await fixture(t), old = f.message(base + '\n\n' + suffix);
  old.embeds = [{ type: EmbedType.Video }];
  await writeFile(f.path, JSON.stringify([legacy(old)]));
  const manager = f.manager(); await manager.publish(f.target, cards);
  const cardId = String((await f.records()).find(record => record.kind === 'card')!.messageId);
  await manager.sweep(); assert.equal(f.removed.length, 0);
  f.advance(); await f.manager().sweep();
  assert.deepEqual(f.removed, [cardId]);
  assert.equal(old.content, base); assert.deepEqual(old.embeds, [{ type: 'video' }]);
  assert.equal(f.video.content, base); assert.deepEqual(await f.records(), []);
});

test('failed placeholder creation does not publish or alter the video', async t => {
  const f = await fixture(t); f.failCreate();
  assert.equal(await f.manager().publish(f.target, cards), null);
  assert.equal(f.edits.length, 0); assert.equal(f.removed.length, 0);
  assert.equal(f.video.content, base); assert.equal(f.errors.length, 1);
});

test('failed journal writes remove only the API-free placeholder and do not poison the queue', async t => {
  const f = await fixture(t); let fail = true;
  const manager = f.manager(async (path, content) => {
    if (fail) throw new Error('write failure');
    await writeFile(path, content);
  });
  assert.equal(await manager.publish(f.target, cards), null);
  assert.equal(f.edits.length, 0); assert.equal(f.removed.length, 1);
  assert(!f.removed.includes(f.video.id)); assert.equal(f.errors.length, 1);
  fail = false; assert(await manager.publish(f.target, cards));
});

test('uncertain publication is deleted immediately and failed deletion remains expired for restart retry', async t => {
  const f = await fixture(t), manager = f.manager();
  let originalDelete: StatsMessage['delete'] | undefined, card: TestMessage | undefined;
  f.prepare(value => {
    card = value; originalDelete = value.delete;
    const edit = value.edit;
    value.edit = async options => { await edit(options); throw new Error('response lost after edit'); };
    value.delete = async () => { throw { code: 50013 }; };
  });
  assert.equal(await manager.publish(f.target, cards), null);
  assert.deepEqual(card!.embeds, cards, 'API publication may have succeeded before the request failed');
  assert.equal((await f.records())[0].expiresAt, 0);
  card!.delete = originalDelete!; await f.manager().sweep();
  assert.deepEqual(f.removed, [card!.id]); assert.deepEqual(await f.records(), []);
  assert.equal(f.video.content, base);
});

test('rollback removes only its card and remains idempotent', async t => {
  const f = await fixture(t), publication = await f.manager().publish(f.target, cards);
  assert(publication); await publication.remove(); await publication.remove();
  assert.equal(f.removed.length, 1); assert(!f.removed.includes(f.video.id));
  assert.deepEqual(await f.records(), []);
});

test('base-message removal finds its card after restart and leaves unrelated videos and cards untouched', async t => {
  const f = await fixture(t), manager = f.manager();
  await manager.publish(f.target, cards);
  const other = f.message(); await manager.publish({ ...f.target, id: other.id }, cards);
  const ownCard = String((await f.records()).find(record => record.baseMessageId === f.video.id)!.messageId);
  const restarted = f.manager(); await restarted.removeForMessage(f.video.id);
  assert.deepEqual(f.removed, [ownCard]);
  assert.equal((await f.records()).length, 1);
  assert.equal((await f.records())[0].baseMessageId, other.id);
  assert(f.messages.has(f.video.id)); assert(f.messages.has(other.id));
  await restarted.removeForMessage(f.video.id);
  assert.equal(f.removed.length, 1);
});

test('rollback failures retain an immediately expired record for later cleanup', async t => {
  const f = await fixture(t), manager = f.manager(), publication = await manager.publish(f.target, cards);
  assert(publication);
  const card = [...f.messages.values()].find(value => value.id !== f.video.id)!;
  const remove = card.delete; card.delete = async () => { throw { code: 50013 }; };
  await publication.remove();
  assert.equal((await f.records())[0].expiresAt, 0); assert.equal(f.errors.length, 1);
  card.delete = remove; await manager.sweep(); assert.deepEqual(await f.records(), []);
});

test('rollback still attempts card deletion when the journal cannot be updated', async t => {
  const f = await fixture(t), manager = f.manager(f.write), publication = await manager.publish(f.target, cards);
  assert(publication); f.failWrite(); await publication.remove();
  assert.equal(f.removed.length, 1); assert(!f.removed.includes(f.video.id));
  f.advance(); await f.manager().sweep(); assert.deepEqual(await f.records(), []);
});

test('serialized simultaneous publications retain all card records', async t => {
  const f = await fixture(t), manager = f.manager();
  const targets = [f.target, { ...f.target, id: f.message().id }, { ...f.target, id: f.message().id }];
  assert((await Promise.all(targets.map(target => manager.publish(target, cards)))).every(Boolean));
  assert.equal((await f.records()).length, 3);
  f.advance(); await manager.sweep();
  assert.deepEqual(await f.records(), []); assert.equal(f.removed.length, 3);
});

test('fetch and permission failures retain cards for later successful cleanup', async t => {
  const f = await fixture(t), manager = f.manager();
  await manager.publish(f.target, cards); f.advance();
  for (const failure of [new Error('network failed'), { code: 50001 }, { code: 50013, status: 403 }]) {
    f.failFetch(failure); await manager.sweep(); assert.equal((await f.records()).length, 1);
  }
  f.failFetch(); await manager.sweep();
  assert.deepEqual(await f.records(), []); assert.equal(f.errors.length, 3);
});

test('missing cards and channels remove records without another Discord mutation', async t => {
  const f = await fixture(t);
  for (const failure of [{ code: 10003 }, { code: 10008 }, { status: 404 }, undefined]) {
    f.failFetch(); const manager = f.manager(), target = { ...f.target, id: f.message().id };
    await manager.publish(target, cards); f.advance(); f.failFetch(failure);
    if (!failure) f.messages.clear();
    await manager.sweep(); assert.deepEqual(await f.records(), []);
  }
  assert.equal(f.removed.length, 0); assert.equal(f.edits.length, 4);
});

test('foreign authors and mismatched fetched messages cannot be edited or deleted', async t => {
  const f = await fixture(t), manager = f.manager();
  assert.equal(await manager.publish({ ...f.target, author: { id: '1491240385031311479' } }, cards), null);
  assert.equal(f.creates.length, 0);
  await manager.publish(f.target, cards); f.advance();
  const card = [...f.messages.values()].find(value => value.id !== f.video.id)!, cardId = card.id;
  card.id = '1491240385031311480'; await manager.sweep();
  assert.equal((await f.records()).length, 1); assert.equal(f.removed.length, 0);
  card.id = cardId; card.author.id = '1491240385031311479'; await manager.sweep();
  assert.equal(f.removed.length, 0); assert.deepEqual(await f.records(), []);
});

test('unexpected placeholder ownership never permits API publication or deletion', async t => {
  const f = await fixture(t); f.prepare(card => { card.author.id = '1491240385031311479'; });
  assert.equal(await f.manager().publish(f.target, cards), null);
  assert.equal(f.edits.length, 0); assert.equal(f.removed.length, 0);
});

test('legacy cleanup retains changed messages and removes only the recorded suffix', async t => {
  const f = await fixture(t), old = f.message(base + '\n\n' + suffix);
  await writeFile(f.path, JSON.stringify([legacy(old, 0)])); const manager = f.manager();
  old.content += '\nUnexpected edit'; await manager.sweep();
  assert.equal((await f.records()).length, 1); assert.equal(f.edits.length, 0);
  old.content = base + '\n\n' + suffix; await manager.sweep();
  assert.equal(old.content, base);
  assert.deepEqual(Object.keys(f.edits[0]).sort(), ['allowedMentions', 'content']);
  assert.deepEqual(await f.records(), []);
});

test('legacy failed publication never removes marker-like original input', async t => {
  const f = await fixture(t), old = f.message(base + '\n\n' + suffix);
  await writeFile(f.path, JSON.stringify([{ ...legacy(old, 0), baseLength: old.content.length }]));
  await f.manager().sweep(); assert.equal(old.content, base + '\n\n' + suffix);
  assert.equal(f.edits.length, 0); assert.deepEqual(await f.records(), []);
});

test('successful expiry deletion retries journal failures without touching the video', async t => {
  const f = await fixture(t), manager = f.manager(f.write);
  await manager.publish(f.target, cards); f.advance(); f.failWrite();
  await assert.rejects(manager.sweep(), /disk denied/);
  assert.equal(f.removed.length, 1); assert.equal(f.video.content, base);
  await f.manager().sweep(); assert.deepEqual(await f.records(), []); assert.equal(f.removed.length, 1);
});

test('journal write failure cannot starve later expired cards of Discord cleanup', async t => {
  const f = await fixture(t), manager = f.manager(f.write);
  await manager.publish(f.target, cards);
  await manager.publish({ ...f.target, id: f.message().id }, cards);
  f.advance(); f.failWrite();
  await assert.rejects(manager.sweep(), /disk denied/);
  assert.equal(f.removed.length, 2, 'both cards are removed before the journal write');
  assert.equal((await f.records()).length, 2, 'failed write retains records for safe retry');
  await f.manager().sweep();
  assert.deepEqual(await f.records(), []); assert.equal(f.removed.length, 2);
});

test('startup sweeps immediately and rejects invalid card payloads and corrupt journals', async t => {
  const f = await fixture(t), manager = f.manager();
  for (const payload of [[], [{ title: 'x'.repeat(257) }], [{ description: 'x'.repeat(4097) }],
    Array.from({ length: 4 }, () => cards[0]), Array.from({ length: 3 }, () => ({ description: 'x'.repeat(2100) })), [{}]]) {
    assert.equal(await manager.publish(f.target, payload), null);
  }
  assert.equal(f.creates.length, 0);
  await manager.publish(f.target, cards); f.advance();
  const restarted = f.manager(); restarted.start(); restarted.start(); await restarted.sweep();
  assert.deepEqual(await f.records(), []);
  for (const record of [
    { kind: 'card', channelId: CHANNEL, messageId: f.video.id, expiresAt: 0, apiData: 'must not be stored' },
    { kind: 'other', channelId: CHANNEL, messageId: f.video.id, expiresAt: 0 },
    { kind: 'card', channelId: CHANNEL, messageId: f.video.id, expiresAt: -1 },
    { kind: 'card', channelId: CHANNEL, messageId: f.video.id, expiresAt: 0, baseLength: 4 },
  ]) {
    await writeFile(f.path, JSON.stringify([record])); assert.throws(() => f.manager(), /Invalid YouTube cleanup records/);
  }
});

test('a full cleanup journal skips new cards before sending a placeholder', async t => {
  const f = await fixture(t);
  const records = Array.from({ length: 10_000 }, (_, i) => ({ kind: 'card', channelId: CHANNEL,
    messageId: String(2000000000000000000n + BigInt(i)), expiresAt: YOUTUBE_STATS_TTL }));
  await writeFile(f.path, JSON.stringify(records));
  assert.equal(await f.manager().publish(f.target, cards), null);
  assert.equal(f.creates.length, 0); assert.equal((await f.records()).length, 10_000);
});
