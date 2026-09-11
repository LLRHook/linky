import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MessageEditOptions } from 'discord.js';
import { formatYouTubeStatistics } from '../src/services/YouTube';
import { YouTubeStats, YOUTUBE_STATS_TTL, type StatsMessage } from '../src/services/YouTubeStats';

const BOT = '1491240385031311470', CHANNEL = '373953687812440066';
const suffix = formatYouTubeStatistics({ viewCount: '12345', topComment: { author: 'Viewer', text: 'Private test excerpt' } }, 'https://youtu.be/dQw4w9WgXcQ');
const base = 'Original shared message and native video link';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'linky-youtube-'));
  const path = join(directory, 'expiry.json');
  let time = 0, fetchError: unknown, writeError = false;
  const messages = new Map<string, StatsMessage>();
  const errors: Error[] = [], edits: MessageEditOptions[] = [], managers: YouTubeStats[] = [];
  const message = (id = '1491240385031311471', content = base, failEdit = false): StatsMessage => {
    const value: StatsMessage = { id, channelId: CHANNEL, author: { id: BOT }, content,
      edit: async options => {
        edits.push(options);
        assert.deepEqual(Object.keys(options).sort(), ['allowedMentions', 'content']);
        assert.deepEqual(options.allowedMentions, { parse: [], repliedUser: false });
        if (failEdit) throw new Error('edit denied');
        value.content = options.content!;
      },
    };
    messages.set(id, value);
    return value;
  };
  const manager = (customWrite?: (path: string, content: string) => Promise<void>) => {
    const instance = new YouTubeStats({ path, botUserId: BOT, now: () => time,
      fetchMessage: async (channel, id) => {
        assert.equal(channel, CHANNEL);
        if (fetchError) throw fetchError;
        return messages.get(id) ?? null;
      }, onError: error => errors.push(error),
      ...(customWrite ? { write: customWrite } : {}),
    });
    managers.push(instance);
    return instance;
  };
  t.after(async () => { managers.forEach(instance => instance.stop()); await rm(directory, { recursive: true, force: true }); });
  return { path, messages, edits, errors, message, manager,
    advance: () => { time += YOUTUBE_STATS_TTL; },
    failFetch: (error?: unknown) => { fetchError = error; },
    failWrite: () => { writeError = true; },
    write: async (file: string, content: string) => { if (writeError) throw new Error('disk denied'); await writeFile(file, content); },
    records: async () => JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>[],
  };
}

test('durably records expiry before publication and cleans only the suffix after restart', async t => {
  const f = await fixture(t), message = f.message(), manager = f.manager();
  const edit = message.edit;
  message.edit = async options => {
    assert.equal((await f.records()).length, 1, 'record is durable before Discord edit');
    return edit(options);
  };
  assert.equal(await manager.publish(message, suffix), true);
  assert.equal(await manager.publish(message, suffix), false, 'duplicate publication cannot postpone expiry');
  assert.equal(message.content, base + '\n\n' + suffix);
  const serialized = await readFile(f.path, 'utf8');
  assert(!serialized.includes('12345'));
  assert(!serialized.includes('Private test excerpt'));
  assert(!serialized.includes('youtube.com'));
  assert.deepEqual(Object.keys((await f.records())[0]).sort(), ['baseLength', 'channelId', 'expiresAt', 'messageId', 'suffixLength']);
  assert.equal((await f.records())[0].expiresAt, 24 * 60 * 60_000);
  await manager.sweep(); assert.equal(f.edits.length, 1);
  f.advance();
  await f.manager().sweep();
  assert.equal(message.content, base);
  assert.deepEqual(await f.records(), []);
});

test('failed record writes never publish statistics and do not poison later queued writes', async t => {
  const f = await fixture(t), message = f.message();
  let fail = true;
  const manager = f.manager(async (path, content) => {
    if (fail) throw new Error('write failure');
    await writeFile(path, content);
  });
  assert.equal(await manager.publish(message, suffix), false);
  assert.equal(f.edits.length, 0);
  assert.equal(f.errors.length, 1);
  fail = false;
  assert.equal(await manager.publish(message, suffix), true);
});

test('failed Discord publication remains tracked and does not remove original marker-like input', async t => {
  const f = await fixture(t), original = base + '\n\n' + suffix;
  const message = f.message(undefined, original, true), manager = f.manager();
  assert.equal(await manager.publish(message, suffix), false);
  assert.equal((await f.records()).length, 1);
  f.advance(); await f.manager().sweep();
  assert.equal(message.content, original);
  assert.equal(f.edits.length, 1, 'cleanup did not attempt another edit of the original');
  assert.deepEqual(await f.records(), []);
});

test('serialized simultaneous publications retain every cleanup record', async t => {
  const f = await fixture(t), manager = f.manager();
  const messages = [f.message(), f.message('1491240385031311472'), f.message('1491240385031311473')];
  assert.deepEqual(await Promise.all(messages.map(message => manager.publish(message, suffix))), [true, true, true]);
  assert.equal((await f.records()).length, 3);
  f.advance(); await manager.sweep();
  assert.deepEqual(await f.records(), []);
  messages.forEach(message => assert.equal(message.content, base));
});

test('fetch and permission failures retain records for a later successful cleanup', async t => {
  const f = await fixture(t), manager = f.manager(), message = f.message();
  await manager.publish(message, suffix); f.advance();
  for (const failure of [new Error('network failed'), { code: 50001 }, { code: 50013, status: 403 }]) {
    f.failFetch(failure); await manager.sweep();
    assert.equal((await f.records()).length, 1);
    assert(message.content.includes('snapshot when shared'));
  }
  f.failFetch();
  const edit = message.edit;
  message.edit = async () => { throw { code: 50013 }; };
  await manager.sweep(); assert.equal((await f.records()).length, 1);
  message.edit = edit;
  await manager.sweep(); assert.deepEqual(await f.records(), []);
  assert.equal(message.content, base);
  assert.equal(f.errors.length, 4);
});

test('unknown channels/messages and confirmed deletion remove records without editing', async t => {
  const f = await fixture(t);
  for (const [index, failure] of [{ code: 10003 }, { code: 10008 }, { status: 404 }, undefined].entries()) {
    f.failFetch();
    const message = f.message(`149124038503131147${index + 1}`), manager = f.manager();
    await manager.publish(message, suffix); f.advance();
    f.failFetch(failure);
    if (!failure) f.messages.delete(message.id);
    await manager.sweep();
    assert.deepEqual(await f.records(), []);
  }
  assert.equal(f.edits.length, 4, 'only the original publications edited Discord');
});

test('changed bot messages retaining the marker remain tracked and report a cleanup problem', async t => {
  const f = await fixture(t), manager = f.manager(), message = f.message();
  await manager.publish(message, suffix); f.advance();
  message.content += '\nAn unexpected edit';
  await manager.sweep();
  assert.equal((await f.records()).length, 1);
  assert.equal(f.edits.length, 1);
  assert.equal(f.errors.length, 1);
  message.content = base;
  await manager.sweep(); assert.deepEqual(await f.records(), []);
});

test('cleanup retries journal failures after a successful Discord edit without deleting base text', async t => {
  const f = await fixture(t), manager = f.manager(f.write), message = f.message();
  await manager.publish(message, suffix); f.advance(); f.failWrite();
  await assert.rejects(manager.sweep(), /disk denied/);
  assert.equal(message.content, base);
  await f.manager().sweep();
  assert.deepEqual(await f.records(), []);
  assert.equal(f.edits.length, 2);
});

test('startup sweeps immediately and rejects invalid authors, oversized messages and corrupt journals', async t => {
  const f = await fixture(t), manager = f.manager(), message = f.message();
  const other = f.message('1491240385031311472'); other.author.id = '1491240385031311473';
  assert.equal(await manager.publish(other, suffix), false);
  assert.equal(await manager.publish(f.message('1491240385031311474', 'x'.repeat(1999)), suffix), false);
  assert.equal(await manager.publish(message, 'unrecognized suffix'), false);
  await manager.publish(message, suffix); f.advance();
  const restarted = f.manager(); restarted.start(); restarted.start();
  await restarted.sweep();
  assert.equal(message.content, base);
  await writeFile(f.path, JSON.stringify([{ channelId: CHANNEL, messageId: message.id, apiData: 'must not be stored' }]));
  assert.throws(() => f.manager(), /Invalid YouTube cleanup records/);
});

test('a full cleanup journal skips new statistics without losing existing records', async t => {
  const f = await fixture(t);
  const records = Array.from({ length: 10_000 }, (_, i) => ({ channelId: CHANNEL,
    messageId: String(2000000000000000000n + BigInt(i)), expiresAt: YOUTUBE_STATS_TTL, baseLength: base.length, suffixLength: suffix.length + 2 }));
  await writeFile(f.path, JSON.stringify(records));
  assert.equal(await f.manager().publish(f.message(), suffix), false);
  assert.equal(f.edits.length, 0);
  assert.equal((await f.records()).length, 10_000);
});
