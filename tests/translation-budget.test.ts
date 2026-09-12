import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TranslationBudget } from '../src/services/TranslationBudget';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'linky-translation-budget-'));
  const path = join(directory, 'budget.json');
  let time = Date.parse('2026-09-11T12:00:00Z');
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { path, now: () => time, setTime: (value: string) => { time = Date.parse(value); },
    saved: async () => JSON.parse(await readFile(path, 'utf8')) as { day: string; characters: number } };
}

test('defaults to 15,000 daily code points and persists only day and count', async t => {
  const f = await fixture(t), budget = new TranslationBudget(f.path, { now: f.now });
  assert.equal(await budget.reserve(14_999), true);
  assert.equal(await budget.reserve([...'🚀'].length), true);
  assert.equal(await budget.reserve(1), false);
  assert.deepEqual(await f.saved(), { day: '2026-09-11', characters: 15_000 });
});

test('restart preserves spent budget and a lowered limit cannot grant more', async t => {
  const f = await fixture(t);
  assert.equal(await new TranslationBudget(f.path, { now: f.now, dailyLimit: 10 }).reserve(6), true);
  assert.equal(await new TranslationBudget(f.path, { now: f.now, dailyLimit: 5 }).reserve(1), false);
  const restarted = new TranslationBudget(f.path, { now: f.now, dailyLimit: 10 });
  assert.equal(await restarted.reserve(4), true);
  assert.equal(await restarted.reserve(1), false);
  assert.deepEqual(await f.saved(), { day: '2026-09-11', characters: 10 });
});

test('concurrent reservations cannot spend the same remaining characters', async t => {
  const f = await fixture(t), budget = new TranslationBudget(f.path, { now: f.now, dailyLimit: 10 });
  const results = await Promise.all(Array.from({ length: 20 }, () => budget.reserve(3)));
  assert.equal(results.filter(Boolean).length, 3);
  assert.equal((await f.saved()).characters, 9);
});

test('authorization waits for persistence and failed writes leave the queue usable', async t => {
  const f = await fixture(t);
  let release!: () => void, started!: () => void, writes = 0, authorized = false;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const writing = new Promise<void>(resolve => { started = resolve; });
  const budget = new TranslationBudget(f.path, { now: f.now, dailyLimit: 10,
    write: async (path, content) => {
      if (++writes === 1) { started(); await blocked; throw new Error('disk unavailable'); }
      await writeFile(path, content);
    },
  });
  const first = budget.reserve(7).then(value => { authorized = value; return value; });
  await writing;
  const second = budget.reserve(10);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(authorized, false);
  assert.equal(writes, 1);
  release();
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.equal(await budget.reserve(1), false);
  assert.equal((await f.saved()).characters, 10);
});

test('an uncertain write never authorizes and a restart honors what reached disk', async t => {
  const f = await fixture(t);
  const budget = new TranslationBudget(f.path, { now: f.now, dailyLimit: 10,
    write: async (path, content) => { await writeFile(path, content); throw new Error('sync failed after rename'); },
  });
  assert.equal(await budget.reserve(6), false);
  const restarted = new TranslationBudget(f.path, { now: f.now, dailyLimit: 10 });
  assert.equal(await restarted.reserve(5), false);
  assert.equal(await restarted.reserve(4), true);
  assert.equal((await f.saved()).characters, 10);
});

for (const [name, before, after, day] of [
  ['daylight time', '2026-09-12T06:59:59Z', '2026-09-12T07:00:00Z', '2026-09-12'],
  ['standard time', '2026-01-12T07:59:59Z', '2026-01-12T08:00:00Z', '2026-01-12'],
]) {
  test(`resets at Pacific midnight in ${name}, not UTC midnight`, async t => {
    const f = await fixture(t);
    f.setTime(before);
    const budget = new TranslationBudget(f.path, { now: f.now, dailyLimit: 10 });
    assert.equal(await budget.reserve(10), true);
    assert.equal(await budget.reserve(1), false);
    f.setTime(after);
    assert.equal(await budget.reserve(10), true);
    assert.deepEqual(await f.saved(), { day, characters: 10 });
  });
}

test('clock rollback cannot reopen yesterday or bypass persisted usage after restart', async t => {
  const f = await fixture(t), budget = new TranslationBudget(f.path, { now: f.now, dailyLimit: 10 });
  assert.equal(await budget.reserve(10), true);
  f.setTime('2026-09-12T12:00:00Z');
  assert.equal(await budget.reserve(10), true);
  f.setTime('2026-09-11T12:00:00Z');
  assert.equal(await budget.reserve(1), false);
  const restarted = new TranslationBudget(f.path, { now: f.now, dailyLimit: 10 });
  assert.equal(await restarted.reserve(1), false);
  f.setTime('2026-09-12T12:00:00Z');
  assert.equal(await restarted.reserve(1), false);
  f.setTime('2026-09-13T12:00:00Z');
  assert.equal(await restarted.reserve(10), true);
});

test('same-day clock rollback waits until time catches up without granting extra budget', async t => {
  const f = await fixture(t), budget = new TranslationBudget(f.path, { now: f.now, dailyLimit: 10 });
  assert.equal(await budget.reserve(5), true);
  f.setTime('2026-09-11T11:59:59Z');
  assert.equal(await budget.reserve(1), false);
  f.setTime('2026-09-11T12:00:00Z');
  assert.equal(await budget.reserve(5), true);
  assert.equal(await budget.reserve(1), false);
});

test('a failed new-day write still rejects a subsequent clock rollback', async t => {
  const f = await fixture(t);
  let fail = false;
  const budget = new TranslationBudget(f.path, { now: f.now, dailyLimit: 10,
    write: async (path, content) => { if (fail) throw new Error('disk full'); await writeFile(path, content); },
  });
  assert.equal(await budget.reserve(1), true);
  f.setTime('2026-09-12T12:00:00Z'); fail = true;
  assert.equal(await budget.reserve(1), false);
  f.setTime('2026-09-11T12:00:00Z'); fail = false;
  assert.equal(await budget.reserve(1), false);
  assert.equal((await f.saved()).characters, 1);
});

test('invalid character counts and an invalid clock never authorize a request', async t => {
  const f = await fixture(t), budget = new TranslationBudget(f.path, { now: f.now, dailyLimit: 10 });
  for (const count of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 11, '2' as unknown as number]) {
    assert.equal(await budget.reserve(count), false);
  }
  await assert.rejects(readFile(f.path), { code: 'ENOENT' });
  f.setTime('invalid');
  assert.equal(await budget.reserve(1), false);
  f.setTime('2026-09-11T12:00:00Z');
  assert.equal(await budget.reserve(10), true);
});

test('malformed or extended records fail closed without replacing the journal', async t => {
  const f = await fixture(t);
  for (const content of ['invalid json', 'null', '[]', '{}',
    '{"day":"2026-02-30","characters":0}', '{"day":"2026-13-01","characters":0}',
    '{"day":"2026-09-11","characters":-1}', '{"day":"2026-09-11","characters":0.5}',
    '{"day":"2026-09-11","characters":"0"}', '{"day":"2026-09-11","characters":9007199254740992}',
    '{"day":"2026-09-11","characters":0,"caption":"unexpected"}',
  ]) {
    await writeFile(f.path, content);
    assert.throws(() => new TranslationBudget(f.path, { now: f.now }), /Could not load translation budget/);
    assert.equal(await readFile(f.path, 'utf8'), content);
  }
});

test('zero limit disables requests and invalid limits fail at construction', async t => {
  const f = await fixture(t);
  assert.equal(await new TranslationBudget(f.path, { now: f.now, dailyLimit: 0 }).reserve(1), false);
  for (const dailyLimit of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new TranslationBudget(f.path, { now: f.now, dailyLimit }), /Invalid translation daily limit/);
  }
});
