import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEromeJobs } from '../src/services/EromeJobs';
import type { DeliveryContext } from '../src/services/DeliveryContext';

const turn = () => new Promise(resolve => setImmediate(resolve));
function observer() {
  const events: string[] = [];
  const context: DeliveryContext = { trace: { id: 'test', startStage(stage) {
    events.push(`${stage}:start`); return { finish(outcome) { events.push(`${stage}:${outcome ?? 'ok'}`); } };
  }, setPath(path) { events.push(path); }, setCache(cache) { events.push(cache); },
  finish() { assert.fail('shared producer finalized a caller delivery'); } },
  progress(event) { events.push(`${event.stage}:${event.state}`); } };
  return { context, events };
}

test('coalesced consumers get their own remaining stage spans and one cancellation cannot stop followers', async () => {
  const jobs = createEromeJobs<number>(), first = observer(), second = observer(), controller = new AbortController();
  let finish!: () => void, producerSignal: AbortSignal | undefined, started = false;
  const work = async (context: DeliveryContext) => {
    producerSignal = context.signal; const span = context.trace!.startStage('download');
    context.trace!.setPath('hosted-original'); context.trace!.setCache!('miss'); started = true;
    await new Promise<void>(resolve => { finish = resolve; });
    context.progress!({ stage: 'download', state: 'done' }); span.finish('ok'); context.trace!.finish('confirmed'); return 42;
  };
  const a = jobs.run('same', { ...first.context, signal: controller.signal }, work);
  while (!started) await turn();
  const b = jobs.run('same', second.context, async () => assert.fail('duplicate producer'));
  assert.deepEqual(second.events, ['hosted-original', 'miss', 'download:start']);
  controller.abort(); assert.equal(await a, null); assert.equal(producerSignal?.aborted, false);
  assert.equal(first.events.at(-1), 'download:cancelled');
  finish(); assert.equal(await b, 42);
  assert.deepEqual(second.events, ['hosted-original', 'miss', 'download:start', 'download:done', 'download:ok']);
  assert.equal(first.events.includes('download:done'), false); await jobs.drain();
});

test('the last cancelled consumer aborts preparation and bad observers cannot interrupt work', async () => {
  const jobs = createEromeJobs<number>(), controller = new AbortController();
  let aborted = false, started = false;
  const pending = jobs.run('job', { signal: controller.signal, progress() { throw Error('observer'); } }, async context => {
    context.progress!({ stage: 'download', state: 'running' }); started = true;
    await new Promise<void>(resolve => context.signal!.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
    return null;
  });
  while (!started) await turn(); controller.abort(); assert.equal(await pending, null);
  await jobs.drain(); assert.equal(aborted, true);
});
