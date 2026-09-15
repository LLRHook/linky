import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { atomicWrite } from '../src/services/AtomicWrite';

test('durable writes create private journals and replace complete contents without leaving temporary files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'linky-atomic-write-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const parent = join(directory, 'state'), path = join(parent, 'journal.json');
  await atomicWrite(path, '{"generation":1}\n');
  assert.equal(await readFile(path, 'utf8'), '{"generation":1}\n');
  await atomicWrite(path, '{"generation":2,"complete":true}\n');
  assert.equal(await readFile(path, 'utf8'), '{"generation":2,"complete":true}\n');
  assert.deepEqual(await readdir(parent), ['journal.json']);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('a failed rename leaves its existing destination intact and removes the temporary file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'linky-atomic-write-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = join(directory, 'existing-directory');
  await mkdir(destination);
  await assert.rejects(atomicWrite(destination, '{"generation":1}\n'));
  assert((await stat(destination)).isDirectory());
  assert.deepEqual(await readdir(directory), ['existing-directory']);
});
