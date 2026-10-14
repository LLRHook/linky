import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { InFlightWork } from '../src/services/InFlightWork';
import {
  CATCH_UP_CHANNEL_LIMIT, CATCH_UP_CLOCK_MARGIN_MS, CATCH_UP_CONCURRENCY, CATCH_UP_MESSAGE_LIMIT, CATCH_UP_WINDOW_MS, CHECKPOINT_INTERVAL_MS,
  catchUp, ServiceCheckpoint, snowflakeBefore, type CatchUpMessage,
} from '../src/services/ServiceCheckpoint';

const directory = mkdtempSync(join(tmpdir(), 'linky-checkpoint-tests-'));
after(() => rmSync(directory, { recursive: true, force: true }));
let cases = 0;
const path = () => join(directory, `checkpoint-${cases++}.json`);
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as unknown;
const channel = (index: number) => String(100000000000000000n + BigInt(index));
const createdAt = (id: string) => Number(BigInt(id) >> 22n) + 1_420_070_400_000;
const message = (timestamp: number, sequence = 0): CatchUpMessage =>
  ({ id: String((BigInt(timestamp - 1_420_070_400_000) << 22n) + BigInt(sequence)), createdTimestamp: timestamp });

test('a clean stop records when messages stopped being accepted, and the next process reads it', async () => {
  const file = path();
  const first = new ServiceCheckpoint({ path: file, trackChannels: false });
  assert.equal(first.previous, undefined);
  assert.equal(await first.start(), true);
  assert.deepEqual(read(file), { channels: [] });
  first.observe(channel(1));
  assert.equal(await first.stop(1_000), true);
  assert.deepEqual(read(file), { stoppedAt: 1_000, channels: [] }, 'Without catch-up no channel IDs are stored');
  assert.deepEqual(new ServiceCheckpoint({ path: file, trackChannels: false }).previous, { stoppedAt: 1_000, channels: [] });
});

test('starting clears the previous stop time so a later crash is not reported as that old stop', async () => {
  const file = path();
  writeFileSync(file, JSON.stringify({ stoppedAt: 1_000, channels: [] }));
  const running = new ServiceCheckpoint({ path: file, trackChannels: false });
  assert.equal(running.previous?.stoppedAt, 1_000);
  await running.start();
  assert.equal(new ServiceCheckpoint({ path: file, trackChannels: false }).previous?.stoppedAt, undefined);
  const tracking = new ServiceCheckpoint({ path: file, trackChannels: true, now: () => 2_000 });
  await tracking.start();
  assert.deepEqual(new ServiceCheckpoint({ path: file, trackChannels: true }).previous, { aliveAt: 2_000, channels: [] },
    'A crash while catch-up is enabled leaves an alive time, never a stop time');
});

test('a process that never started keeps the previous record', async () => {
  const file = path();
  writeFileSync(file, JSON.stringify({ stoppedAt: 1_000, channels: [channel(1)] }));
  const failed = new ServiceCheckpoint({ path: file, trackChannels: true });
  assert.equal(await failed.stop(5_000), true);
  assert.deepEqual(read(file), { stoppedAt: 1_000, channels: [channel(1)] });
});

test('channel tracking keeps the most recent channels and refreshes the checkpoint periodically', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const file = path();
  let now = 10_000;
  const checkpoint = new ServiceCheckpoint({ path: file, trackChannels: true, now: () => now });
  for (let index = 0; index < CATCH_UP_CHANNEL_LIMIT + 5; index++) checkpoint.observe(channel(index));
  checkpoint.observe(channel(10));
  await checkpoint.start();
  const saved = read(file) as { aliveAt: number; channels: string[] };
  assert.equal(saved.aliveAt, 10_000);
  assert.equal(saved.channels.length, CATCH_UP_CHANNEL_LIMIT);
  assert.equal(saved.channels[0], channel(10), 'A repeated channel moves to the front');
  assert.equal(saved.channels[1], channel(CATCH_UP_CHANNEL_LIMIT + 4));
  assert.ok(!saved.channels.includes(channel(4)), 'The oldest channels are dropped');
  assert.equal(new Set(saved.channels).size, saved.channels.length);

  now = 40_000;
  checkpoint.observe(channel(99));
  t.mock.timers.tick(CHECKPOINT_INTERVAL_MS);
  await checkpoint.stop(45_000).then(() => {});
  const restored = new ServiceCheckpoint({ path: file, trackChannels: true });
  assert.deepEqual([restored.previous?.stoppedAt, restored.previous?.aliveAt], [45_000, undefined]);
  assert.equal(restored.previous?.channels[0], channel(99));
});

test('the periodic refresh records the current time while running', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const writes: string[] = [];
  let now = 1_000;
  const checkpoint = new ServiceCheckpoint({ path: path(), trackChannels: true, now: () => now,
    write: async (_file, content) => { writes.push(content); } });
  await checkpoint.start();
  now = 31_000;
  t.mock.timers.tick(CHECKPOINT_INTERVAL_MS);
  await checkpoint.stop(32_000);
  assert.deepEqual(writes.map(content => JSON.parse(content) as unknown), [{ aliveAt: 1_000, channels: [] }, { aliveAt: 31_000, channels: [] },
    { stoppedAt: 32_000, channels: [] }]);
  now = 61_000;
  t.mock.timers.tick(CHECKPOINT_INTERVAL_MS);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 3, 'Stopping ends the periodic refresh');
});

test('invalid or oversized checkpoint files are ignored instead of stopping startup', () => {
  for (const content of ['not json', 'null', '[]', JSON.stringify({ stoppedAt: -1, channels: [] }),
    JSON.stringify({ aliveAt: 1.5, channels: [] }), JSON.stringify({ acceptedUntil: 1, channels: [] }), JSON.stringify({ channels: ['not-an-id'] }),
    JSON.stringify({ channels: [channel(1), channel(1)] }), JSON.stringify({ channels: [], text: 'hello' }),
    JSON.stringify({ channels: Array.from({ length: CATCH_UP_CHANNEL_LIMIT + 1 }, (_, index) => channel(index)) }),
    JSON.stringify({ channels: [], padding: 'x'.repeat(17 * 1024) })]) {
    const file = path();
    writeFileSync(file, content);
    assert.equal(new ServiceCheckpoint({ path: file, trackChannels: true }).previous, undefined, content.slice(0, 60));
  }
});

test('a failed write is reported and does not reject', async () => {
  let reported = 0;
  const checkpoint = new ServiceCheckpoint({ path: path(), trackChannels: false, onError: () => { reported++; },
    write: async () => { throw Error('disk full'); } });
  assert.equal(await checkpoint.start(), false);
  assert.equal(reported, 1);
});

test('snowflakeBefore returns the id just before the first message at that time', () => {
  const at = Date.UTC(2026, 9, 14, 15, 10, 29);
  const before = snowflakeBefore(at);
  assert.equal(createdAt(String(BigInt(before) + 1n)), at);
  assert.equal(createdAt(before), at - 1);
});

const now = Date.UTC(2026, 9, 14, 15, 11, 0);

async function run(messages: Map<string, CatchUpMessage[] | null | Error>, overrides: Partial<Parameters<typeof catchUp>[0]> = {}) {
  const delivered: string[] = [];
  const requests: { channelId: string; after: string; limit: number }[] = [];
  const result = await catchUp({
    channels: [...messages.keys()], since: now - 5_000, until: now - 1_000, now,
    fetchAfter: async (channelId, after, limit) => {
      requests.push({ channelId, after, limit });
      const value = messages.get(channelId);
      if (value instanceof Error) throw value;
      return value ?? null;
    },
    handled: () => false,
    deliver: async item => { delivered.push(item.id); },
    stopped: () => false,
    ...overrides,
  });
  return { result, delivered, requests };
}

test('catch-up delivers messages from the offline gap oldest first and skips handled ones', async () => {
  const first = message(now - 4_000), second = message(now - 4_000, 1), third = message(now - 2_000);
  const handled = message(now - 3_000);
  const { result, delivered, requests } = await run(new Map([[channel(1), [third, handled, second, first]]]),
    { handled: id => id === handled.id });
  assert.deepEqual(delivered, [first.id, second.id, third.id]);
  assert.deepEqual(result, { channels: 1, unavailable: 0, delivered: 3 });
  assert.deepEqual(requests, [{ channelId: channel(1), after: snowflakeBefore(now - 5_000 - CATCH_UP_CLOCK_MARGIN_MS),
    limit: CATCH_UP_MESSAGE_LIMIT }]);
});

test('catch-up stays inside the window: clock margin, two-minute age and the live session start', async () => {
  const since = now - 5_000;
  const insideMargin = message(since - CATCH_UP_CLOCK_MARGIN_MS);
  const beforeMargin = message(since - CATCH_UP_CLOCK_MARGIN_MS - 1);
  const live = message(now - 1_000 + CATCH_UP_CLOCK_MARGIN_MS);
  const nearLive = message(now - 1_001 + CATCH_UP_CLOCK_MARGIN_MS);
  const { delivered } = await run(new Map([[channel(1), [beforeMargin, insideMargin, live, nearLive]]]));
  assert.deepEqual(delivered, [insideMargin.id, nearLive.id], 'Clock margin applies at both ends; the live session dedupes the overlap');

  const longOutage = await run(new Map([[channel(1), [message(now - CATCH_UP_WINDOW_MS - 1), message(now - CATCH_UP_WINDOW_MS)]]]),
    { since: now - 60 * 60_000 });
  assert.deepEqual(longOutage.delivered, [message(now - CATCH_UP_WINDOW_MS).id]);
  assert.equal(longOutage.requests[0].after, snowflakeBefore(now - CATCH_UP_WINDOW_MS));

  const nothingMissed = await run(new Map([[channel(1), [message(now - 2_000)]]]), { since: now, until: now - 2 * CATCH_UP_CLOCK_MARGIN_MS });
  assert.deepEqual(nothingMissed.requests, [], 'No request is made when the gap is empty');
});

test('catch-up bounds work per channel and across channels', async () => {
  const many = Array.from({ length: CATCH_UP_MESSAGE_LIMIT + 10 }, (_, index) => message(now - 4_000, index));
  const { delivered } = await run(new Map([[channel(1), many]]));
  assert.equal(delivered.length, CATCH_UP_MESSAGE_LIMIT);
  assert.equal(delivered[0], many[0].id);

  const channels = new Map(Array.from({ length: CATCH_UP_CHANNEL_LIMIT + 3 }, (_, index) => [channel(index), [] as CatchUpMessage[]]));
  const { requests } = await run(channels);
  assert.equal(requests.length, CATCH_UP_CHANNEL_LIMIT);
});

test('an unavailable channel is skipped without affecting the others', async () => {
  const kept = message(now - 2_000);
  const { result, delivered } = await run(new Map<string, CatchUpMessage[] | null | Error>([
    [channel(1), Error('Missing Access')], [channel(2), null], [channel(3), [kept]],
  ]));
  assert.deepEqual(delivered, [kept.id]);
  assert.deepEqual(result, { channels: 1, unavailable: 2, delivered: 1 });
});

test('catch-up stops when shutdown begins', async () => {
  let stopped = false;
  const { delivered, requests } = await run(new Map([[channel(1), [message(now - 3_000), message(now - 2_000)]], [channel(2), [message(now - 2_000)]]]),
    { deliver: async () => { stopped = true; }, stopped: () => stopped });
  assert.deepEqual(delivered, []);
  assert.equal(requests.length, 2, 'Channels already being fetched finish their request');
});

test('in-flight work settles when tracked tasks finish and reports failures without rejecting', async () => {
  let failures = 0;
  const work = new InFlightWork(() => { failures++; });
  let finish!: () => void;
  const task = new Promise<void>(resolve => { finish = resolve; });
  assert.equal(work.track(task), task);
  void work.track(Promise.reject(Error('boom'))).catch(() => {});
  const settled = work.settle(1_000);
  finish();
  assert.equal(await settled, true);
  assert.equal(work.size, 0);
  assert.equal(failures, 1);
  assert.equal(await new InFlightWork().settle(0), true, 'Nothing running settles immediately');
});

test('in-flight work stops waiting at the limit and leaves unfinished tasks counted', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const work = new InFlightWork();
  void work.track(new Promise<void>(() => {}));
  const settled = work.settle(20_000);
  t.mock.timers.tick(19_999);
  await Promise.resolve();
  let done = false;
  void settled.then(() => { done = true; });
  await Promise.resolve();
  assert.equal(done, false);
  t.mock.timers.tick(1);
  assert.equal(await settled, false);
  assert.equal(work.size, 1);
});

test('catch-up delivers one message at a time per channel and rechecks handled messages before each', async () => {
  const first = message(now - 4_000), second = message(now - 3_000), third = message(now - 2_000);
  const order: string[] = [];
  const live = new Set<string>();
  let release!: () => void;
  const running = run(new Map([[channel(1), [first, second, third]]]), {
    handled: id => live.has(id),
    deliver: item => {
      order.push(`start:${item.id}`);
      return item.id === first.id ? new Promise<void>(resolve => { release = () => { order.push(`end:${item.id}`); resolve(); }; }) : Promise.resolve();
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, [`start:${first.id}`]);
  live.add(second.id);
  release();
  const { result } = await running;
  assert.deepEqual(order, [`start:${first.id}`, `end:${first.id}`, `start:${third.id}`]);
  assert.equal(result.delivered, 2);
});

test('catch-up spreads channels over a bounded number of workers', async () => {
  let active = 0, peak = 0;
  const channels = new Map(Array.from({ length: 10 }, (_, index) => [channel(index), [message(now - 2_000, index)]]));
  const { result } = await run(channels, { deliver: async () => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
  } });
  assert.equal(result.delivered, 10);
  assert.equal(peak, CATCH_UP_CONCURRENCY);
});
