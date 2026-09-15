import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readBoundedJson } from '../src/services/BoundedJson';

test('bounded JSON accepts split UTF-8 at the exact byte limit and rejects invalid encoding', async () => {
  const bytes = Buffer.from('{"caption":"日本語 🚀"}');
  let offset = 0;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) controller.close();
      else controller.enqueue(bytes.subarray(offset, ++offset));
    },
  }, { highWaterMark: 0 }));
  assert.deepEqual(await readBoundedJson(response, bytes.length), { caption: '日本語 🚀' });
  await assert.rejects(readBoundedJson(new Response(new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125])), 100));
});

for (const beforeRead of [true, false]) {
  test(`bounded JSON cancels a stalled response when aborted ${beforeRead ? 'before' : 'during'} reading`, { timeout: 1000 }, async () => {
    let started!: () => void, cancelled = false;
    const pulling = new Promise<void>(resolve => { started = resolve; });
    const response = new Response(new ReadableStream<Uint8Array>({
      pull() { started(); return new Promise(() => {}); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }));
    const controller = new AbortController();
    if (beforeRead) controller.abort();
    const result = readBoundedJson(response, 100, controller.signal);
    if (!beforeRead) { await pulling; controller.abort(); }
    await assert.rejects(result, { name: 'AbortError' });
    assert.equal(cancelled, true);
    assert.equal(response.body?.locked, false);
  });
}
