import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createDeliveryProgress, deliveryProgressText } from '../src/services/DeliveryProgress';

test('quick deliveries produce no progress chatter', async () => {
  const edits: string[] = [];
  const progress = createDeliveryProgress(async text => { edits.push(text); }, { delayMs: 20 });
  progress.update({ stage: 'resolve', state: 'running' });
  await progress.stop();
  await delay(30);
  assert.deepEqual(edits, []);
});

test('progress coalesces bursts and stop waits for an accepted edit', async () => {
  const edits: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const progress = createDeliveryProgress(async text => { edits.push(text); await gate; }, { delayMs: 0, intervalMs: 1 });
  progress.update({ stage: 'resolve', state: 'running' });
  progress.update({ stage: 'download', state: 'running' });
  await delay(10);
  progress.update({ stage: 'convert', state: 'running' });
  let finished = false;
  const stopped = progress.stop().then(() => { finished = true; });
  await delay(10);
  assert.equal(finished, false);
  release();
  await stopped;
  progress.update({ stage: 'publish', state: 'running' });
  await delay(10);
  assert.deepEqual(edits, ['Downloading the selected media…']);
});

test('failed progress edits never fail the delivery or repeat identical successes', async () => {
  let calls = 0;
  const progress = createDeliveryProgress(async () => { if (++calls === 1) throw Error('offline'); }, { delayMs: 0, intervalMs: 1 });
  progress.update({ stage: 'download', state: 'running' });
  await delay(10);
  progress.update({ stage: 'inspect', state: 'running' });
  await delay(10);
  progress.update({ stage: 'inspect', state: 'running' });
  await delay(10);
  await progress.stop();
  assert.equal(calls, 2);
});

test('progress uses bounded stage language and honest item counts', () => {
  assert.equal(deliveryProgressText({ stage: 'store', state: 'running', cache: 'hit', itemIndex: 1, itemCount: 3 }),
    'Item 2 of 3. Reusing a validated preview…');
  assert.equal(deliveryProgressText({ stage: 'download', state: 'running', itemIndex: -1, itemCount: 3 }),
    'Downloading the selected media…');
});
