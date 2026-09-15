import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { ButtonStyle, ComponentType, Events, type Client, type Message, type APIMessageTopLevelComponent } from 'discord.js';
import { eromeMediaComponents, messageHasEromeMedia, onlyEromeLinks, sendEromeMedia, watchEromeMedia,
  type EromeMedia } from '../src/services/EromeMedia';

const channelId = '111111111111111111', messageId = '222222222222222222', botId = '333333333333333333';
const media: EromeMedia = { id: 'a'.repeat(32), size: 25_000_000, sha256: 'b'.repeat(64), videoCount: 1,
  url: `https://media.example.com/media/${'a'.repeat(32)}.mp4`, metadata: { width: 1280, height: 720, duration: 160.121, fps: 30 } };
const gallery = (fields: Record<string, unknown> = {}) => ({ type: ComponentType.MediaGallery,
  items: [{ media: { url: media.url, content_type: 'video/mp4', proxy_url: 'https://media.discordapp.net/proxy.mp4',
    width: 1280, height: 720, ...fields } }] });
function client() {
  return Object.assign(new EventEmitter(), { user: { id: botId } }) as unknown as Client;
}
function message(components: unknown[] = [], fields: Record<string, unknown> = {}): Message {
  return { id: messageId, channelId, author: { id: botId }, components: components.map(value => ({ toJSON: () => value })),
    fetch: async () => message(), ...fields } as unknown as Message;
}
const packet = (components: unknown[], fields: Record<string, unknown> = {}) => ({ t: 'MESSAGE_UPDATE', d: {
  id: messageId, channel_id: channelId, author: { id: botId }, components, ...fields,
} });

test('V2 rendering keeps text, exact original media URL, multi-video notice and caller controls', () => {
  const controls: APIMessageTopLevelComponent[] = [{ type: ComponentType.ActionRow, components: [
    { type: ComponentType.Button, style: ButtonStyle.Link, label: 'Album', url: 'https://www.erome.com/a/Album' },
  ] }];
  const content = 'Caption\nhttps://www.erome.com/a/Album';
  const rendered = eromeMediaComponents(media, content, controls);
  assert.equal(rendered[0].type, ComponentType.TextDisplay);
  if (rendered[0].type === ComponentType.TextDisplay) assert.equal(rendered[0].content,
    `${content}\n-# Video preview · Original video and audio. Album kept.`);
  assert.deepEqual(rendered[1], { type: ComponentType.MediaGallery, items: [{ media: { url: media.url },
    description: 'Original video from the linked album.' }] });
  assert.equal(rendered[2], controls[0]); assert.equal(controls.length, 1);
  const multiple = eromeMediaComponents({ ...media, videoCount: 3 }, content);
  assert.equal(multiple[0].type, ComponentType.TextDisplay);
  if (multiple[0].type === ComponentType.TextDisplay) assert.match(multiple[0].content, /First of 3 videos/);
  assert.equal(messageHasEromeMedia(message([gallery()]), media.url), true);
  assert.equal(messageHasEromeMedia(message([gallery({ url: media.url + '?other=1' })]), media.url), false);
});

test('onlyEromeLinks excludes other visible URLs while respecting hidden links, markup and exact album hosts', () => {
  const album = 'https://www.erome.com/a/Album';
  for (const content of [album, `Caption **${album}**!`, `[album](${album}) https://erome.com/a/Second`,
    `${album} \`https://example.com\``, `${album} ||https://example.com||`, `${album} <https://example.com>`])
    assert.equal(onlyEromeLinks(content), true, content);
  for (const content of ['', 'ordinary text', `\`${album}\``, `||${album}||`, `<${album}>`,
    `${album} https://youtube.com/watch?v=123`, `${album} [other](https://example.com)`,
    'https://erome.com.evil.test/a/Album', 'https://example.com/?url=' + album, `${album} ftp://example.com/file`])
    assert.equal(onlyEromeLinks(content), false, content);
});

test('a valid Gateway event before REST completion verifies only its eventual returned message', async () => {
  const bot = client(), watcher = watchEromeMedia(bot, channelId, media);
  assert.equal(bot.listenerCount(Events.Raw), 1);
  bot.emit(Events.Raw, { ...packet([gallery()]), t: 'MESSAGE_CREATE' });
  assert.equal(await watcher.verify(message([], { fetch: async () => { assert.fail('early event should avoid REST'); } })), true);
  watcher.close(); assert.equal(bot.listenerCount(Events.Raw), 0);
});

test('Gateway verification requires exact channel, target ID, author, gallery URL, video MIME, proxy and dimensions', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const cases = [packet([gallery()], { channel_id: 'wrong' }), packet([gallery()], { id: 'wrong' }),
    packet([gallery()], { author: { id: 'wrong' } }), packet([gallery({ url: media.url + '?other=1' })]),
    packet([gallery({ content_type: 'image/png' })]), packet([gallery({ proxy_url: '' })]),
    ...[{ width: 640, height: 360 }, { width: 1278 }, { height: 722 }, { width: 1279.5 },
      { width: '1280' }, { height: null }, { width: 0 }, { height: -1 }, { width: NaN }]
      .map(fields => packet([gallery(fields)])), packet([{ ...gallery(), type: ComponentType.TextDisplay }]),
    { ...packet([gallery()]), t: 'OTHER_EVENT' }];
  for (const value of cases) {
    const bot = client(), watcher = watchEromeMedia(bot, channelId, media);
    bot.emit(Events.Raw, value);
    let reads = 0;
    const pending = watcher.verify(message([], { fetch: async () => { reads++; return message(); } }));
    context.mock.timers.tick(6_000);
    assert.equal(await pending, false); assert.equal(reads, 1);
    watcher.close(); assert.equal(bot.listenerCount(Events.Raw), 0);
  }
  const bot = client(), watcher = watchEromeMedia(bot, channelId, media);
  const pending = watcher.verify(message());
  bot.emit(Events.Raw, packet([gallery({ width: 720, height: 1280 })], { author: undefined }));
  assert.equal(await pending, true); watcher.close();
});

test('Gateway and REST accept one-pixel rounding in either orientation', async () => {
  for (const dimensions of [{ width: 1279, height: 720 }, { width: 1280, height: 721 },
    { width: 721, height: 1279 }, { width: 720, height: 1281 }]) {
    const bot = client(), watcher = watchEromeMedia(bot, channelId, media);
    bot.emit(Events.Raw, packet([gallery(dimensions)]));
    assert.equal(await watcher.verify(message()), true);
    watcher.close();
    const restWatcher = watchEromeMedia(client(), channelId, media);
    assert.equal(await restWatcher.verify(message([gallery(dimensions)])), true);
    restWatcher.close();
  }
});

test('REST inspection and fallback require the same bot, channel and message identity', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  for (const wrong of [{ channelId: 'wrong' }, { author: { id: 'wrong' } }]) {
    const watcher = watchEromeMedia(client(), channelId, media);
    assert.equal(await watcher.verify(message([gallery()], wrong)), false); watcher.close();
  }
  for (const wrong of [{ id: 'wrong' }, { channelId: 'wrong' }, { author: { id: 'wrong' } }]) {
    const watcher = watchEromeMedia(client(), channelId, media);
    const pending = watcher.verify(message([], { fetch: async () => message([gallery()], wrong) }));
    context.mock.timers.tick(6_000);
    assert.equal(await pending, false); watcher.close();
  }
  const watcher = watchEromeMedia(client(), channelId, media);
  const pending = watcher.verify(message([], { fetch: async () => message([gallery()]) }));
  context.mock.timers.tick(6_000); assert.equal(await pending, true); watcher.close();
});

test('closing a watcher removes its listener, settles a wait and prevents late REST work', async () => {
  const bot = client(), watcher = watchEromeMedia(bot, channelId, media);
  const target = message([], { fetch: async () => { assert.fail('closed watcher fetched'); } });
  const pending = watcher.verify(target);
  watcher.close(); assert.equal(await pending, false); assert.equal(bot.listenerCount(Events.Raw), 0);
  assert.equal(await watcher.verify(message([gallery()])), false);
  watcher.close();
});

test('an uncertain send reconciles once after its grace period and never repeats the POST', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const original = new Error('uncertain POST');
  for (const outcome of ['found', 'missing', 'read-error']) {
    let sends = 0, reads = 0;
    const expected = message();
    const pending = sendEromeMedia(async () => { sends++; throw original; }, async () => {
      reads++; if (outcome === 'read-error') throw Error('read failed');
      return outcome === 'found' ? expected : null;
    });
    const rejected = outcome === 'found' ? undefined : assert.rejects(pending, error => error === original);
    await new Promise(resolve => setImmediate(resolve));
    context.mock.timers.tick(9_999); assert.equal(reads, 0);
    context.mock.timers.tick(1);
    if (outcome === 'found') assert.equal(await pending, expected); else await rejected;
    assert.equal(sends, 1); assert.equal(reads, 1);
  }
  let reads = 0;
  const expected = message();
  assert.equal(await sendEromeMedia(async () => expected, async () => { reads++; return null; }), expected);
  assert.equal(reads, 0);
});
