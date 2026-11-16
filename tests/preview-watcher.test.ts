import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, DiscordAPIError, type APIEmbed, type Message } from 'discord.js';
import { expectedPreviews } from '../src/services/PreviewRecovery';
import { PreviewWatcher } from '../src/services/PreviewWatcher';

const source = 'https://www.instagram.com/reel/RealPost/';
const fixed = 'https://fkinstagram.com/reel/RealPost/';
const expected = expectedPreviews(source, fixed);
const embed: APIEmbed = { url: fixed, video: { url: 'https://cdn.example/video.mp4' } };
const bot = '100000000000000001', channel = '100000000000000002', id = '100000000000000003';
function fixture(t: { after: (fn: () => void) => void }, options = {}) {
  const client = new Client({ intents: [] });
  Object.defineProperty(client, 'user', { value: { id: bot } });
  const watcher = new PreviewWatcher(client, { gatewayWaitMs: 10, reconcileTimeoutMs: 10, ...options });
  t.after(() => watcher.close());
  return { client, watcher };
}
function raw(client: Client, embeds: APIEmbed[], changes = {}) {
  client.emit('raw', { t: 'MESSAGE_UPDATE', d: { id, channel_id: channel, embeds, ...changes } } as never);
}
function message(embeds: APIEmbed[] = [], fetch = async (): Promise<Message> => message(embeds)) {
  return { id, channelId: channel, author: { id: bot }, embeds: embeds.map(value => ({ toJSON: () => value })), fetch } as unknown as Message;
}

test('Gateway preview received before send resolves is accepted without a REST fetch', async t => {
  const { client, watcher } = fixture(t);
  const watch = watcher.arm(channel, expected);
  raw(client, [embed]);
  let fetches = 0;
  const result = await watch.verify(message([], async () => { fetches++; return message(); }));
  assert.equal(result.ok, true);
  assert.equal(result.attributed?.[0].providerId, 'instagram7');
  assert.equal(fetches, 0);
});

test('Gateway update wakes an active verifier and unrelated messages cannot satisfy it', async t => {
  const { client, watcher } = fixture(t, { gatewayWaitMs: 100 });
  const watch = watcher.arm(channel, expected);
  const pending = watch.verify(message([], async () => { assert.fail('No REST after Gateway success'); }));
  raw(client, [embed], { channel_id: 'wrong' });
  raw(client, [embed], { id: 'wrong' });
  raw(client, [embed], { author: { id: 'wrong' } });
  raw(client, [{ url: fixed, title: 'Error', description: 'Try again later' }]);
  raw(client, [embed]);
  assert.equal((await pending).ok, true);
});

test('canonical and late previous-provider embeds can confirm source metadata without provider credit', async t => {
  const { client, watcher } = fixture(t);
  for (const url of [source, fixed]) {
    const alternate = expectedPreviews(source, fixed.replace('fkinstagram.com', 'oginstagram.com'));
    const watch = watcher.arm(channel, alternate);
    raw(client, [{ ...embed, url }]);
    const result = await watch.verify(message());
    assert.equal(result.ok, true);
    assert.equal(result.videoMetadata, true);
    assert.deepEqual(result.attributed, []);
  }
});

test('a missed Gateway event causes exactly one REST reconciliation', async t => {
  const { watcher } = fixture(t);
  let fetches = 0;
  const result = await watcher.arm(channel, expected).verify(message([], async () => { fetches++; return message([embed]); }));
  assert.equal(result.ok, true);
  assert.equal(fetches, 1);
});

test('a vxTwitter service-error event and REST echo cannot wake or confirm a post preview', async t => {
  const { client, watcher } = fixture(t, { gatewayWaitMs: 0 });
  const url = 'https://vxtwitter.com/public/status/123';
  const items = expectedPreviews('https://x.com/public/status/123', url);
  const error: APIEmbed = { url, title: 'vxTwitter / fixvx', description: 'Failed to scan your link! This post is unavailable.' };
  const watch = watcher.arm(channel, items);
  raw(client, [error]);
  let fetches = 0;
  const result = await watch.verify(message([], async () => { fetches++; return message([error]); }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, items);
  assert.deepEqual(result.attributed, []);
  assert.equal(fetches, 1);
});

test('a stuck REST fetch and explicit cancellation both terminate within the bounded wait', async t => {
  const { watcher } = fixture(t);
  let fetches = 0;
  const result = await watcher.arm(channel, expected).verify(message([], () => { fetches++; return new Promise(() => {}); }));
  assert.equal(result.ok, false);
  assert.equal(fetches, 1);
  const controller = new AbortController();
  const watch = watcher.arm(channel, expected, { signal: controller.signal });
  const pending = watch.verify(message([], async () => { assert.fail('Cancelled verification must not fetch'); }));
  controller.abort();
  assert.equal((await pending).ok, false);
});

test('concurrent watchers use one listener and a late REST snapshot cannot overwrite a Gateway success', async t => {
  const { client, watcher } = fixture(t, { gatewayWaitMs: 0, maxActive: 1 });
  const count = client.listenerCount('raw');
  const watch = watcher.arm(channel, expected);
  const extra = watcher.arm(channel, expected);
  assert.equal(client.listenerCount('raw'), count);
  const result = await watch.verify(message([], async () => { raw(client, [embed]); return message(); }));
  assert.equal(result.ok, true);
  assert.equal((await extra.verify(message([embed]))).ok, true);
  watcher.close();
  assert.equal(client.listenerCount('raw'), count - 1);
});

test('unreadable or deleted reconcile snapshots remain unconfirmed and mismatched output is never fetched', async t => {
  const { watcher } = fixture(t);
  for (const error of [new DiscordAPIError({ code: 50001, message: 'Missing Access' }, 50001, 403, 'GET', 'https://discord.example/message', {}),
    new Error('Unknown Message')]) {
    const result = await watcher.arm(channel, expected).verify(message([], async () => { throw error; }));
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, expected);
  }
  const untrusted = message([], async () => { assert.fail('Wrong author must not fetch'); });
  Object.assign(untrusted, { author: { id: 'wrong' } });
  assert.equal((await watcher.arm(channel, expected).verify(untrusted)).ok, false);
});

test('a cold Instagram media preview arriving after seven seconds is accepted before reconciliation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, watcher } = fixture(t, { gatewayWaitMs: undefined });
  let fetches = 0;
  const pending = watcher.arm(channel, expected).verify(message([], async () => { fetches++; return message(); }));
  t.mock.timers.tick(7_500);
  await Promise.resolve();
  assert.equal(fetches, 0, 'Instagram must still be listening for the observed late media update');
  raw(client, [embed]);
  assert.equal((await pending).ok, true);
});

test('cold TikTok video metadata at 7.5 seconds wakes the verifier without a premature REST check', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, watcher } = fixture(t, { gatewayWaitMs: undefined });
  const source = 'https://www.tiktok.com/@auramonster_67_69/video/7695457160653851935';
  const fixed = source.replace('www.tiktok.com', 'tnktok.com');
  let fetches = 0;
  const pending = watcher.arm(channel, expectedPreviews(source, fixed)).verify(message([], async () => { fetches++; return message(); }));
  t.mock.timers.tick(7_500);
  await Promise.resolve();
  assert.equal(fetches, 0, 'TikTok must still be listening for cold media');
  raw(client, [{ url: source, video: { url: 'https://cdn.example/video.mp4' } }]);
  assert.equal((await pending).ok, true);
});

test('cold Facebed video at 7.5 seconds wakes the verifier without a premature REST check', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, watcher } = fixture(t, { gatewayWaitMs: undefined });
  const source = 'https://www.facebook.com/reel/1060921586772217';
  let fetches = 0;
  const pending = watcher.arm(channel, expectedPreviews(source, 'https://facebed.com/reel/1060921586772217'))
    .verify(message([], async () => { fetches++; return message(); }));
  t.mock.timers.tick(7_500);
  await Promise.resolve();
  assert.equal(fetches, 0, 'Facebook must still be listening for cold media');
  raw(client, [{ url: source, video: { url: 'https://video.fbcdn.example/clip.mp4' } }]);
  assert.equal((await pending).ok, true);
});

test('Instagram still confirms immediately and other platforms retain the four-second window', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, watcher } = fixture(t, { gatewayWaitMs: undefined });
  const immediate = watcher.arm(channel, expected).verify(message([], async () => { assert.fail('Early preview needs no fetch'); }));
  raw(client, [embed]);
  assert.equal((await immediate).ok, true);
  const other = expectedPreviews('https://bsky.app/profile/example.com/post/3abc', 'https://bskx.app/profile/example.com/post/3abc');
  let fetches = 0;
  const pending = watcher.arm(channel, other).verify(message([], async () => { fetches++; return message(); }));
  t.mock.timers.tick(4_000);
  await Promise.resolve();
  assert.equal(fetches, 1);
  assert.equal((await pending).ok, false);
});

test('a rejected reconcile cannot erase a concurrent matching Gateway update', async t => {
  const { client, watcher } = fixture(t, { gatewayWaitMs: 0 });
  const result = await watcher.arm(channel, expected).verify(message([], async () => {
    raw(client, [embed]);
    throw new Error('Unreadable snapshot');
  }));
  assert.equal(result.ok, true);
});

for (const [platform, original, rewritten] of [
  ['X', 'https://x.com/public/status/123', 'https://fixupx.com/public/status/123'],
  ['Reddit', 'https://www.reddit.com/r/example/comments/abc123/example/', 'https://vxreddit.com/r/example/comments/abc123/example/'],
]) {
  test(`${platform} video metadata at nine seconds confirms without a premature reconcile`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { client, watcher } = fixture(t, { gatewayWaitMs: undefined });
    const items = expectedPreviews(original, rewritten);
    assert.equal(items.length, 1);
    let fetches = 0;
    const pending = watcher.arm(channel, items).verify(message([], async () => { fetches++; return message(); }));
    t.mock.timers.tick(9_000);
    await Promise.resolve();
    assert.equal(fetches, 0, 'wait for the observed slow large-video unfurl');
    raw(client, [{ url: rewritten, video: { url: 'https://cdn.example/video.mp4' } }]);
    assert.equal((await pending).ok, true);
    assert.equal(fetches, 0);
  });
}

test('X without an update remains unconfirmed after ten seconds and one reconcile', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { watcher } = fixture(t, { gatewayWaitMs: undefined });
  const items = expectedPreviews('https://x.com/public/status/123', 'https://fixupx.com/public/status/123');
  let fetches = 0;
  const pending = watcher.arm(channel, items).verify(message([], async () => { fetches++; return message(); }));
  t.mock.timers.tick(9_999);
  await Promise.resolve();
  assert.equal(fetches, 0);
  t.mock.timers.tick(1);
  const result = await pending;
  assert.equal(fetches, 1);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, items);
});

test('caller-supplied Gateway waits cannot exceed ten seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { watcher } = fixture(t, { gatewayWaitMs: 60_000 });
  let fetches = 0;
  const pending = watcher.arm(channel, expected).verify(message([], async () => { fetches++; return message(); }));
  t.mock.timers.tick(9_999);
  await Promise.resolve();
  assert.equal(fetches, 0);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(fetches, 1, 'the configured maximum must end the Gateway wait');
  assert.equal((await pending).ok, false);
  assert.equal(fetches, 1);
});

for (const sendMs of [21_000, 25_999]) {
  test(`a ${sendMs} ms send still reconciles a missed X Gateway preview`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { watcher } = fixture(t, { gatewayWaitMs: undefined });
    const url = 'https://fixupx.com/public/status/123';
    const items = expectedPreviews('https://x.com/public/status/123', url);
    const watch = watcher.arm(channel, items);
    t.mock.timers.tick(sendMs);
    let fetches = 0;
    const pending = watch.verify(message([], async () => {
      fetches++;
      return message([{ url, video: { url: 'https://cdn.example/video.mp4' } }]);
    }));
    for (let i = 0; i < 10; i++) { t.mock.timers.tick(1_000); await Promise.resolve(); }
    assert.equal((await pending).ok, true);
    assert.equal(fetches, 1);
  });
}

test('a never-published watch expires at 36 seconds and releases its capacity slot', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, watcher } = fixture(t, { gatewayWaitMs: undefined, maxActive: 1 });
  const abandoned = watcher.arm(channel, expected);
  t.mock.timers.tick(35_999);
  let fetches = 0;
  const beforeExpiry = watcher.arm(channel, expected).verify(message([], async () => { fetches++; return message(); }));
  await Promise.resolve();
  assert.equal(fetches, 1, 'slot is occupied before its lifetime ends');
  assert.equal((await beforeExpiry).ok, false);
  t.mock.timers.tick(1);
  assert.equal((await abandoned.verify(message([embed]))).ok, false, 'expired watch cannot confirm');
  const pending = watcher.arm(channel, expected).verify(message([], async () => { assert.fail('Released slot should receive Gateway metadata'); }));
  raw(client, [embed]);
  assert.equal((await pending).ok, true);
});
