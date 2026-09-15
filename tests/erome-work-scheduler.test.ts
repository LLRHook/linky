import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEromeWorkScheduler, EromeAdmissionError, EromeCleanupError, type EromeSchedulerEvent } from '../src/services/EromeWorkScheduler';
import type { DeliveryContext, StageOutcome } from '../src/services/DeliveryContext';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function gate<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const reason = (expected: EromeAdmissionError['reason']) => (error: unknown) => error instanceof EromeAdmissionError && error.reason === expected;

test('early admission failures finish guarded queue diagnostics without starting work', async () => {
  const finished: StageOutcome[] = [];
  const context: DeliveryContext = { trace: { id: 'test', startStage(stage) {
    assert.equal(stage, 'queue'); return { finish(outcome) { finished.push(outcome!); } };
  }, setPath() {}, finish() {} } };
  const work = async () => assert.fail('rejected work started');
  const scheduler = createEromeWorkScheduler({ clock: () => 10 }), held = gate();
  const first = scheduler.run({ fairnessKey: 'busy' }, 'original', () => held.promise);
  const waiting = [1, 2].map(() => scheduler.run({ fairnessKey: 'busy' }, 'original', async () => {}));
  await assert.rejects(scheduler.run({ ...context, fairnessKey: 'busy' }, 'original', work), reason('queue_full'));
  await assert.rejects(scheduler.run({ ...context, deadlineAt: 10 }, 'original', work), reason('deadline'));
  await assert.rejects(scheduler.run({ ...context, signal: AbortSignal.abort() }, 'original', work), reason('cancelled'));
  held.resolve(); await Promise.all([first, ...waiting]); await scheduler.close();
  await assert.rejects(scheduler.run(context, 'original', work), reason('closed'));
  await assert.rejects(scheduler.run({ trace: { ...context.trace!, startStage() { throw Error('ignored'); } } }, 'original', work), reason('closed'));
  const poisoned = createEromeWorkScheduler();
  await assert.rejects(poisoned.run({}, 'original', async () => { throw new EromeCleanupError(); }), EromeCleanupError);
  await assert.rejects(poisoned.run(context, 'original', work), reason('cleanup_failed')); await poisoned.close();
  assert.deepEqual(finished, ['busy', 'timeout', 'cancelled', 'cancelled', 'failed']);
});

test('original and attachment profiles overlap across guilds with atomic bounded scratch reservations', async () => {
  const events: EromeSchedulerEvent[] = [], scheduler = createEromeWorkScheduler({ observe: event => events.push(event) });
  const original = gate(), attachment = gate(), starts: string[] = [];
  const a = scheduler.run({ fairnessKey: 'a' }, 'attachment', async () => { starts.push('attachment'); await attachment.promise; });
  const b = scheduler.run({ fairnessKey: 'b' }, 'original', async () => { starts.push('original'); await original.promise; });
  await turn(); assert.deepEqual(starts, ['attachment', 'original']);
  assert.equal(Math.max(...events.map(event => event.scratchBytes)), 152 * 1024 * 1024);
  assert.equal(Math.max(...events.map(event => event.active)), 2);
  original.resolve(); attachment.resolve(); await Promise.all([a, b]); await scheduler.close();
  assert.equal(events.at(-1)?.scratchBytes, 0);
});

test('round robin serves other waiting guilds before repeating a guild and keeps its FIFO order', async context => {
  const scheduler = createEromeWorkScheduler(), starts: string[] = [], gates = Array.from({ length: 5 }, () => gate());
  context.after(async () => { gates.forEach(item => item.resolve()); await scheduler.close(); });
  const enqueue = (guild: string, index: number) => scheduler.run({ fairnessKey: guild }, 'original', async () => {
    starts.push(`${guild}${index}`); await gates[index].promise;
  });
  const requests = [enqueue('a', 0), enqueue('a', 1), enqueue('a', 2), enqueue('b', 3), enqueue('c', 4)];
  await turn(); gates[0].resolve(); await turn(); assert.deepEqual(starts, ['a0', 'b3']);
  gates[3].resolve(); await turn(); assert.deepEqual(starts, ['a0', 'b3', 'c4']);
  gates[4].resolve(); await turn(); assert.equal(starts.at(-1), 'a1');
  gates[1].resolve(); await turn(); assert.equal(starts.at(-1), 'a2');
  gates[2].resolve(); await Promise.all(requests); await scheduler.close();
});

test('one active job per guild prevents a second profile bypassing its FIFO head', async () => {
  const scheduler = createEromeWorkScheduler(), held = gate(), starts: string[] = [];
  const first = scheduler.run({ fairnessKey: 'a' }, 'attachment', async () => { starts.push('a-attachment'); await held.promise; });
  const second = scheduler.run({ fairnessKey: 'a' }, 'original', async () => { starts.push('a-original'); });
  const other = scheduler.run({ fairnessKey: 'b' }, 'original', async () => { starts.push('b-original'); });
  await other; assert.deepEqual(starts, ['a-attachment', 'b-original']);
  held.resolve(); await Promise.all([first, second]); await scheduler.close();
  assert.equal(starts.at(-1), 'a-original');
});

test('pending queues are bounded globally and per guild without starting rejected work', async () => {
  const scheduler = createEromeWorkScheduler(), held = gate(); let runs = 0;
  const active = scheduler.run({ fairnessKey: 'active' }, 'original', () => held.promise);
  const requests = Array.from({ length: 8 }, (_, i) => scheduler.run({ fairnessKey: `guild-${Math.floor(i / 2)}` }, 'original', async () => { runs++; }));
  await assert.rejects(scheduler.run({ fairnessKey: 'guild-0' }, 'original', async () => { runs++; }), reason('queue_full'));
  await assert.rejects(scheduler.run({ fairnessKey: 'other' }, 'original', async () => { runs++; }), reason('queue_full'));
  held.resolve(); await Promise.all([active, ...requests]); await scheduler.close(); assert.equal(runs, 8);
});

test('queued cancellation frees admission promptly and observers cannot interrupt work', async () => {
  const scheduler = createEromeWorkScheduler({ observe: () => { throw Error('ignored'); } }), held = gate();
  const active = scheduler.run({ fairnessKey: 'a' }, 'original', () => held.promise);
  const cancel = new AbortController(); let started = false;
  const pending = scheduler.run({ fairnessKey: 'b', signal: cancel.signal, progress: () => { throw Error('ignored'); },
    trace: { id: 'test', startStage() { throw Error('ignored'); }, setPath() {}, finish() {} } }, 'original', async () => { started = true; });
  cancel.abort(); await assert.rejects(pending, reason('cancelled'));
  held.resolve(); await active; await scheduler.close(); assert.equal(started, false);
});

test('active cancellation rejects promptly but retains resources until producer cleanup settles', async () => {
  const events: EromeSchedulerEvent[] = [], scheduler = createEromeWorkScheduler({ observe: event => events.push(event) });
  const cleanup = gate(), controller = new AbortController(); let signal!: AbortSignal, secondStarted = false;
  const first = scheduler.run({ fairnessKey: 'a', signal: controller.signal }, 'attachment', async current => { signal = current; await cleanup.promise; });
  await turn(); controller.abort(); await assert.rejects(first, reason('cancelled')); assert.equal(signal.aborted, true);
  const second = scheduler.run({ fairnessKey: 'b' }, 'attachment', async () => { secondStarted = true; });
  await turn(); assert.equal(secondStarted, false); assert.equal(events.at(-1)?.scratchBytes, 128 * 1024 * 1024);
  cleanup.resolve(); await second; await scheduler.close(); assert.equal(events.at(-1)?.scratchBytes, 0);
});

test('deadline includes queue time and active work is aborted without early resource release', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0; const scheduler = createEromeWorkScheduler({ clock: () => now }), held = gate();
  const first = scheduler.run({ fairnessKey: 'a' }, 'original', () => held.promise);
  let ran = false;
  const queued = scheduler.run({ fairnessKey: 'b', deadlineAt: 20 }, 'original', async () => { ran = true; });
  now = 20; context.mock.timers.tick(20); await assert.rejects(queued, reason('deadline')); assert.equal(ran, false);
  held.resolve(); await first; await scheduler.close();
});

test('cleanup failure quarantines charged bytes, rejects pending work and blocks new admission', async () => {
  const events: EromeSchedulerEvent[] = [], scheduler = createEromeWorkScheduler({ observe: event => events.push(event) });
  const held = gate(), first = scheduler.run({ fairnessKey: 'a' }, 'original', async () => { await held.promise; throw new EromeCleanupError(); });
  const queued = scheduler.run({ fairnessKey: 'b' }, 'original', async () => assert.fail('quarantined work started'));
  const rejected = assert.rejects(queued, reason('cleanup_failed'));
  held.resolve(); await assert.rejects(first, EromeCleanupError); await rejected; await turn();
  await assert.rejects(scheduler.run({ fairnessKey: 'c' }, 'attachment', async () => {}), reason('cleanup_failed'));
  assert.equal(events.at(-1)?.scratchBytes, 24 * 1024 * 1024); assert.equal(events.at(-1)?.quarantinedBytes, 24 * 1024 * 1024);
  await scheduler.close();
});

test('quarantine remains charged alongside another active profile until that producer drains', async () => {
  const events: EromeSchedulerEvent[] = [], scheduler = createEromeWorkScheduler({ observe: event => events.push(event) });
  const held = gate(), failed = gate();
  const attachment = scheduler.run({ fairnessKey: 'a' }, 'attachment', () => held.promise);
  const original = scheduler.run({ fairnessKey: 'b' }, 'original', async () => { await failed.promise; throw new EromeCleanupError(); });
  failed.resolve(); await assert.rejects(original, EromeCleanupError); await turn();
  assert.equal(events.at(-1)?.scratchBytes, 152 * 1024 * 1024);
  held.resolve(); await attachment; await scheduler.close();
  assert.equal(events.at(-1)?.scratchBytes, 24 * 1024 * 1024);
});

test('task failures release slots and close aborts queued/running jobs, drains and is idempotent', async () => {
  const scheduler = createEromeWorkScheduler();
  await assert.rejects(scheduler.run({}, 'attachment', async () => { throw Error('task-failure'); }), /task-failure/);
  const held = gate(), first = scheduler.run({ fairnessKey: 'a' }, 'attachment', () => held.promise);
  const waiting = scheduler.run({ fairnessKey: 'b' }, 'attachment', async () => assert.fail('closed work started'));
  const firstRejected = assert.rejects(first, reason('closed')), waitingRejected = assert.rejects(waiting, reason('closed'));
  await turn(); const closed = scheduler.close(); assert.equal(scheduler.close(), closed);
  await Promise.all([firstRejected, waitingRejected]); let drained = false; void closed.then(() => { drained = true; });
  await turn(); assert.equal(drained, false); held.resolve(); await closed;
  await assert.rejects(scheduler.run({}, 'original', async () => {}), reason('closed'));
});

test('close has a bounded drain when an injected producer ignores cancellation', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const scheduler = createEromeWorkScheduler(), held = gate();
  const request = scheduler.run({}, 'original', () => held.promise);
  const rejected = assert.rejects(request, reason('closed')); await turn();
  const closed = scheduler.close(), failure = assert.rejects(closed, reason('deadline'));
  context.mock.timers.tick(5_000); await Promise.all([rejected, failure]); held.resolve(); await turn();
});
