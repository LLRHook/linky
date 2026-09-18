import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, type APIEmbed, type Message } from 'discord.js';
import { expectedPreviews } from '../src/services/PreviewRecovery';
import { PreviewWatcher } from '../src/services/PreviewWatcher';

const source = 'https://www.instagram.com/reel/RealPost/';
const fixed = 'https://www.instagram7.com/reel/RealPost/';
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
    const alternate = expectedPreviews(source, fixed.replace('www.instagram7.com', 'oginstagram.com'));
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

test('deleted messages still reject and a mismatched bot output is never fetched', async t => {
  const { watcher } = fixture(t);
  await assert.rejects(watcher.arm(channel, expected).verify(message([], async () => { throw new Error('Unknown Message'); })), /Unknown Message/);
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

test('Instagram still confirms immediately and other platforms retain the four-second window', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, watcher } = fixture(t, { gatewayWaitMs: undefined });
  const immediate = watcher.arm(channel, expected).verify(message([], async () => { assert.fail('Early preview needs no fetch'); }));
  raw(client, [embed]);
  assert.equal((await immediate).ok, true);
  const x = expectedPreviews('https://x.com/jack/status/20', 'https://fixupx.com/jack/status/20');
  let fetches = 0;
  const pending = watcher.arm(channel, x).verify(message([], async () => { fetches++; return message(); }));
  t.mock.timers.tick(4_000);
  await Promise.resolve();
  assert.equal(fetches, 1);
  assert.equal((await pending).ok, false);
});
