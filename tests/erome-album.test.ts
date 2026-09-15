import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundedEromeBody, isEromeImageUrl, parseEromeItems, resolveEromeItems, selectEromeItem } from '../src/services/EromeAlbum';

const video = (name = 'first') => `<video><source src="https://v63.erome.com/Album/${name}.mp4"></video>`;
const image = (name = 'first', extra = '') => `<img class="img-front" src="https://s63.erome.com/Album/${name}.jpg" ${extra}>`;
const group = (contents: string) => `<div class="media-group"><div>${contents}</div></div>`;
const album = 'https://www.erome.com/a/Album';

test('album extraction preserves unique media order and selects exact items after reordering', () => {
  const parsed = parseEromeItems(group(image()) + group(video() + video()) + group(image('second')));
  assert.deepEqual(parsed.items.map(item => [item.kind, item.index]), [['image', 0], ['video', 1], ['image', 2]]);
  const value = { ...parsed, album, videoCount: 1 };
  assert.equal(selectEromeItem(value)?.kind, 'video');
  assert.equal(selectEromeItem(value, { index: 0 })?.kind, 'image');
  const fingerprint = parsed.items[2].fingerprint;
  const reordered = { ...value, ...parseEromeItems(group(image('second')) + group(video())) };
  assert.equal(selectEromeItem(reordered, { fingerprint })?.index, 0);
  assert.equal(selectEromeItem(value, { fingerprint: 'a'.repeat(64) }), null);
  for (const index of [-1, 1.5, 100, NaN]) assert.equal(selectEromeItem(value, { index }), null);
});

test('image-only albums work without accepting posters, suggestions, scripts or duplicate attributes', () => {
  const outside = image('outside') + video('outside');
  const parsed = parseEromeItems(outside + `<script>${group(image('script'))}</script>` + `<!--${group(image('comment'))}-->` +
    group('<img class="avatar" src="https://s63.erome.com/Album/avatar.jpg">' +
      '<video poster="https://s63.erome.com/Album/poster.jpg"></video>' + image('bad', 'src="https://example.org/x.jpg"') + image('real')));
  assert.equal(parsed.items.length, 1); assert.match(parsed.items[0].source, /real.jpg$/);
  assert.equal(selectEromeItem({ ...parsed, album, videoCount: 0 })?.kind, 'image');
  for (const source of ['https://s63.erome.com/Album/a.svg', 'https://s63.erome.com/Album/a.webp',
    'https://s63.erome.com/Album/a.jpg?x=1', 'https://s63.erome.com:443/Album/a.jpg',
    'https://s63.erome.com/../a.jpg', 'https://s63.erome.com.evil.example/a.jpg', 'https://127.0.0.1/a.jpg'])
    assert.equal(isEromeImageUrl(source), false, source);
});

test('album parsing bounds item count, HTML bytes and nesting', () => {
  const capped = parseEromeItems(Array.from({ length: 105 }, (_, index) => group(image(String(index)))).join(''));
  assert.equal(capped.items.length, 100); assert.equal(capped.truncated, true);
  assert.deepEqual(parseEromeItems('x'.repeat(1024 * 1024 + 1)), { items: [], truncated: false });
  assert.equal(parseEromeItems('<div>'.repeat(129) + group(image())).items.length, 0);
});

test('fresh album resolution rejects deletion, challenge, redirect and unbounded responses', async () => {
  for (const response of [new Response(group(image()), { status: 404, headers: { 'content-type': 'text/html' } }),
    new Response('Just a moment' + group(image()), { headers: { 'content-type': 'text/html' } }),
    new Response(group(image()), { headers: { 'content-type': 'image/jpeg' } }),
    new Response(group(image()), { headers: { 'content-type': 'text/html', 'content-length': '1048577' } })]) {
    assert.equal(await resolveEromeItems(album, async () => response), null);
  }
  const parsed = await resolveEromeItems(album, async (_input, init) => {
    assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
    return new Response(group(image()), { headers: { 'content-type': 'text/html' } });
  });
  assert.equal(parsed?.items[0].kind, 'image');
});

test('bounded bodies reject mismatched lengths, overflow and caller cancellation', async () => {
  assert.equal(await boundedEromeBody(new Response('abcd', { headers: { 'content-length': '3' } }), 8), null);
  assert.equal(await boundedEromeBody(new Response('abcd'), 3), null);
  let cancelled = false;
  const abort = new AbortController();
  const pending = boundedEromeBody(new Response(new ReadableStream({ cancel() { cancelled = true; } })), 10, abort.signal);
  abort.abort(); await assert.rejects(pending); assert.equal(cancelled, true);
});
