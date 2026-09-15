import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { createEromeMediaPreparer, mediaBaseUrl } from '../src/services/EromeMediaRuntime';
import { eromeScheduler, withEromePreparation } from '../src/services/Erome';
import { createMediaAssetStore, type MediaAsset } from '../src/services/MediaAssetStore';

const album = 'https://www.erome.com/a/RuntimeAlbum';
const source = 'https://v63.erome.com/RuntimeAlbum/original.mp4';
const bytes = Buffer.from('unchanged complete original');
const metadata = { width: 1280, height: 720, duration: 160.121, fps: 30 };
const baseUrl = 'https://media.example.com';
type Options = Parameters<typeof createEromeMediaPreparer>[0];

function fixture(overrides: Partial<Options> = {}) {
  const controller = new AbortController(), calls: string[] = [];
  const assets = new Map<string, MediaAsset & { path: string }>();
  let sequence = 0;
  const options: Options = { baseUrl, signal: controller.signal,
    resolve: async url => { calls.push('resolve'); return { source, album: url, videoCount: 2 }; },
    download: async (value, signal) => {
      calls.push('download'); assert.equal(value.source, source); assert.ok(signal); assert.equal(signal.aborted, false); return bytes;
    },
    inspect: async (value, options) => {
      calls.push('inspect'); assert.equal(value, bytes); assert.ok(options?.signal); assert.equal(options.signal.aborted, false); return metadata;
    },
    store: { publish: async value => {
      calls.push('publish'); assert.equal(value, bytes);
      const asset = { id: (++sequence).toString(16).padStart(32, '0'), size: value.length, sha256: 'b'.repeat(64) };
      assets.set(asset.id, { ...asset, path: 'private-store-path' }); return asset;
    }, get: async id => { calls.push('get'); return assets.get(id) ?? null; } },
    ...overrides,
  };
  return { prepare: createEromeMediaPreparer(options), controller, calls, assets, options };
}

test('preparation inspects complete unchanged bytes before publication and reuses only a persisted cache hit', async () => {
  const value = fixture();
  const first = await value.prepare(album);
  assert.ok(first); assert.equal(first.url, `${baseUrl}/media/${first.id}.mp4`);
  assert.deepEqual(first.metadata, metadata); assert.equal(first.videoCount, 2);
  assert.deepEqual(value.calls, ['resolve', 'download', 'inspect', 'publish']);
  assert.deepEqual(await value.prepare('https://erome.com/a/RuntimeAlbum/?tracking=1#video'), first);
  assert.deepEqual(value.calls, ['resolve', 'download', 'inspect', 'publish', 'resolve', 'get']);
  value.assets.delete(first.id);
  const rebuilt = await value.prepare(album);
  assert.ok(rebuilt); assert.notEqual(rebuilt.id, first.id);
  assert.deepEqual(value.calls.slice(6), ['resolve', 'get', 'download', 'inspect', 'publish']);
});

test('cache expires after five minutes and stores at most sixty-four album descriptors', async context => {
  let now = 1_000;
  context.mock.method(Date, 'now', () => now);
  const value = fixture();
  const first = await value.prepare(album);
  now += 300_000;
  assert.notEqual((await value.prepare(album))?.id, first?.id);
  for (let i = 2; i <= 65; i++) await value.prepare(album + i);
  const before = value.calls.filter(call => call === 'publish').length;
  await value.prepare(album);
  assert.equal(value.calls.filter(call => call === 'publish').length, before + 1);
});

test('nulls and failures at each preparation stage fall back without publishing uninspected media', async () => {
  for (const stage of ['resolve', 'download', 'inspect', 'publish'] as const) {
    for (const throws of [false, true]) {
      const value = fixture();
      const failure = async () => { if (throws) throw Error('dependency failed'); return null; };
      const options = { ...value.options, ...(stage === 'publish'
        ? { store: { ...value.options.store, publish: failure } } : { [stage]: failure }) };
      const prepare = createEromeMediaPreparer(options);
      assert.equal(await prepare(album), null);
      assert.equal(value.calls.includes('publish'), false);
    }
  }
  const invalid = fixture();
  assert.equal(await invalid.prepare('https://example.com/a/RuntimeAlbum'), null); assert.equal(invalid.calls.length, 0);
});

test('cached storage failures return null and cancellation during a persisted lookup cannot return media', async () => {
  const failed = fixture();
  await failed.prepare(album);
  failed.options.store.get = async () => { throw Error('storage unavailable'); };
  assert.equal(await failed.prepare(album), null);

  const cancelled = fixture();
  const saved = await cancelled.prepare(album); assert.ok(saved);
  let release!: (value: (MediaAsset & { path: string }) | null) => void;
  cancelled.options.store.get = () => new Promise(resolve => { release = resolve; });
  const pending = cancelled.prepare(album);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  cancelled.controller.abort(); release(cancelled.assets.get(saved.id)!);
  assert.equal(await pending, null);
});

test('original media uses the same bounded preparation queue as legacy attachment work', async () => {
  let release!: () => void, entered = false;
  const legacy = withEromePreparation(async () => { entered = true; await new Promise<void>(resolve => { release = resolve; }); });
  while (!entered) await new Promise(resolve => setImmediate(resolve));
  const value = fixture();
  const pending = value.prepare(album);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(value.calls.length, 0);
  release(); await legacy; assert.ok(await pending);
});

test('preparation shares eight consumers, admits only three album jobs, and preserves queue order', async () => {
  let release!: () => void;
  const value = fixture({ resolve: async url => {
    value.calls.push(url);
    if (url === album) await new Promise<void>(resolve => { release = resolve; });
    return { source, album: url, videoCount: 1 };
  } });
  const shared = Array.from({ length: 8 }, () => value.prepare(album));
  assert.equal(await value.prepare(album), null);
  const second = value.prepare(album + '2'), third = value.prepare(album + '3');
  assert.equal(await value.prepare(album + '4'), null);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  release(); const results = await Promise.all([...shared, second, third]);
  assert.ok(results.every(Boolean)); assert.ok(results.slice(0, 8).every(result => result === results[0]));
  assert.deepEqual(value.calls.filter(call => call.startsWith('https:')), [album, album + '2', album + '3']);
  assert.equal(value.calls.filter(call => call === 'publish').length, 3);
});

test('shutdown cancellation propagates through download and stops later inspection or publication', async () => {
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const value = fixture({ download: async (_source, signal) => {
    assert.ok(signal); assert.equal(signal.aborted, false); started();
    return new Promise<null>(resolve => signal!.addEventListener('abort', () => resolve(null), { once: true }));
  } });
  const pending = value.prepare(album); await began; value.controller.abort();
  assert.equal(await pending, null); assert.equal(await value.prepare(album), null);
  assert.deepEqual(value.calls, ['resolve']);

  let release!: () => void;
  const blocked = withEromePreparation(() => new Promise<void>(resolve => { release = resolve; }));
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const queued = fixture(); const waiting = queued.prepare(album);
  queued.controller.abort(); release(); await blocked;
  assert.equal(await waiting, null); assert.deepEqual(queued.calls, []);
});

test('cancellation after each successful stage cannot publish or return a cached result', async () => {
  for (const stage of ['resolve', 'download', 'inspect', 'publish'] as const) {
    const value = fixture();
    const options = { ...value.options };
    if (stage === 'publish') options.store = { ...options.store, publish: async input => {
      const result = await value.options.store.publish(input); value.controller.abort(); return result;
    } };
    else if (stage === 'resolve') options.resolve = async (...args) => {
      const result = await value.options.resolve!(...args); value.controller.abort(); return result;
    };
    else if (stage === 'download') options.download = async (...args) => {
      const result = await value.options.download(...args); value.controller.abort(); return result;
    };
    else options.inspect = async (...args) => {
      const result = await value.options.inspect(...args); value.controller.abort(); return result;
    };
    assert.equal(await createEromeMediaPreparer(options)(album), null);
    assert.equal(value.calls.includes('publish'), stage === 'publish');
  }
});

test('bound original assets survive store restart and disappear only after their message is released', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linky-media-runtime-test-'));
  let store: Awaited<ReturnType<typeof createMediaAssetStore>> | undefined;
  try {
    store = await createMediaAssetStore({ directory });
    const value = fixture({ store });
    const prepared = await value.prepare(album); assert.ok(prepared);
    const saved = await store.get(prepared.id); assert.ok(saved);
    assert.deepEqual(await readFile(saved.path), bytes);
    assert.equal(await store.bind(prepared.id, '123456789012345678'), true);
    await store.close(); store = await createMediaAssetStore({ directory });
    const persisted = await store.get(prepared.id); assert.ok(persisted);
    assert.equal(persisted.sha256, prepared.sha256); assert.deepEqual(await readFile(persisted.path), bytes);
    await store.release('123456789012345678'); assert.equal(await store.get(prepared.id), null);
  } finally {
    await store?.close();
    assert.equal(dirname(resolvePath(directory)), resolvePath(tmpdir()));
    assert.ok(basename(directory).startsWith('linky-media-runtime-test-'));
    await rm(directory, { recursive: true, force: true });
  }
});

test('media base configuration rejects credentials, explicit ports, paths, query and non-HTTPS schemes', () => {
  assert.equal(mediaBaseUrl(baseUrl + '/'), baseUrl);
  for (const raw of ['http://media.example.com', 'https://user:pass@media.example.com', 'https://media.example.com:443',
    'https://media.example.com:8443', baseUrl + '/media', baseUrl + '?token=x', baseUrl + '#fragment'])
    assert.throws(() => mediaBaseUrl(raw));
});

// Substitute constructors in an isolated module; no listener or network transport is opened by lifecycle tests.
async function lifecycleFixture(download: Options['download'], publish?: Options['store']['publish']) {
  const events: string[] = [];
  const store = { get: async () => null, publish: publish ?? (async () => null), bind: async () => true,
    release: async () => {}, close: async () => { events.push('store-close'); } };
  const server = Object.assign(new EventEmitter(), {
    listen() { queueMicrotask(() => server.emit('listening')); },
    closeAllConnections() { events.push('connections-close'); },
    close(callback: () => void) { events.push('server-close'); queueMicrotask(callback); },
  });
  const dependencies: Record<string, unknown> = {
    './MediaAssetStore': { createMediaAssetStore: async () => store, mediaExtension: () => 'mp4' },
    './MediaReuseIndex': { createMediaReuseIndex: async () => undefined },
    './EromeImage': { createEromeImageDownloader: () => ({}) },
    './MediaServer': { createMediaServer: () => server },
    './RegionalDownloader': { createRegionalDownloader: () => ({ download, claim: () => false,
      close() { events.push('downloader-close'); } }) },
    './VideoAttachment': { createOriginalVideoInspector: () => async () => metadata, createOriginalImageInspector: () => async () => null },
    './Erome': { parseEromeUrl: (raw: string) => ({ url: raw }), eromeScheduler,
      resolveEromeAlbum: async (url: string) => ({ source, album: url, videoCount: 1 }) },
  };
  const code = transpileModule(await readFile(join(__dirname, '../src/services/EromeMediaRuntime.ts'), 'utf8'), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  runInNewContext(code, { module: loaded, exports: loaded.exports, URL, AbortController, AbortSignal, Buffer,
    setTimeout, clearTimeout, require: (name: string) => {
      if (name.startsWith('node:')) return require(name) as unknown;
      if (name === './EromeJobs') return require('../src/services/EromeJobs') as unknown;
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      throw Error('Unexpected lifecycle test dependency');
    } }, { timeout: 1_000 });
  const runtime = await (loaded.exports as Pick<typeof import('../src/services/EromeMediaRuntime'), 'createEromeMediaRuntime'>)
    .createEromeMediaRuntime({ key: 'unused-test-key', workerBaseUrl: 'https://workers.example.com',
      publicBaseUrl: baseUrl, directory: 'unused-no-filesystem', port: 8092 });
  return { runtime, events, store };
}

test('runtime shutdown is idempotent, aborts admitted work and drains it before closing storage', async () => {
  let started!: () => void, finish!: (value: null) => void, signal: AbortSignal | undefined;
  const began = new Promise<void>(resolve => { started = resolve; });
  const value = await lifecycleFixture(async (_source, stopped) => {
    signal = stopped; started(); return new Promise<null>(resolve => { finish = resolve; });
  });
  assert.equal(value.runtime.bind, value.store.bind); assert.equal(value.runtime.release, value.store.release);
  const pending = value.runtime.prepare(album); await began;
  const first = value.runtime.close(), second = value.runtime.close(); assert.equal(first, second);
  assert.equal(signal?.aborted, true);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(value.events.includes('store-close'), false);
  finish(null); assert.equal(await pending, null); await first;
  assert.deepEqual(value.events, ['downloader-close', 'connections-close', 'server-close', 'store-close']);
  await value.runtime.close(); assert.equal(value.events.length, 4);
});

test('shutdown reports a bounded timeout for a stalled publication and starts store closure once', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let started!: () => void, finish!: (value: null) => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const value = await lifecycleFixture(async () => bytes, async () => {
    started(); return new Promise<null>(resolve => { finish = resolve; });
  });
  const preparing = value.runtime.prepare(album); await began;
  const closing = value.runtime.close();
  const rejected = assert.rejects(closing, /Media shutdown timed out/);
  context.mock.timers.tick(5_000); await rejected;
  assert.equal(value.events.filter(event => event === 'store-close').length, 1);
  assert.equal(value.runtime.close(), closing);
  finish(null); assert.equal(await preparing, null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(value.events.filter(event => event === 'store-close').length, 1);
});

test('runtime shutdown does not wait behind unrelated legacy work; its queued preparation remains cancelled', async () => {
  let release!: () => void;
  const legacy = withEromePreparation(() => new Promise<void>(resolve => { release = resolve; }));
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const value = await lifecycleFixture(async () => { assert.fail('cancelled queued download started'); });
  const queued = value.runtime.prepare(album);
  try {
    await value.runtime.close();
    assert.equal(value.events.filter(event => event === 'store-close').length, 1);
  } finally { release(); await legacy; }
  assert.equal(await queued, null);
});
