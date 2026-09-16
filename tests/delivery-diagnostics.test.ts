import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { MessageFlags, MessageFlagsBitField, type ButtonInteraction } from 'discord.js';
import { DeliveryDiagnostics, type DeliveryRequest, type DeliveryDiagnosticsOptions } from '../src/services/DeliveryDiagnostics';
import { deliveryDetailsButton, formatDeliveryDetails, handleDeliveryDetails } from '../src/services/DeliveryDetails';

const request: DeliveryRequest = { requesterId: '100000000000000001', channelId: '100000000000000002',
  guildId: '100000000000000003', mode: 'automatic', platform: 'erome' };
const messageId = '100000000000000004';
const reader = { ...request, messageId };
const stores = new Map<string, DeliveryDiagnostics[]>();
function createDiagnostics(options: DeliveryDiagnosticsOptions): DeliveryDiagnostics {
  const diagnostics = new DeliveryDiagnostics(options);
  stores.set(options.path, [...(stores.get(options.path) ?? []), diagnostics]);
  return diagnostics;
}

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), 'linky-diagnostics-'));
  const path = join(directory, 'delivery.json');
  t.after(async () => {
    for (const diagnostics of stores.get(path) ?? []) await diagnostics.close();
    stores.delete(path);
    await rm(directory, { recursive: true, force: true });
  });
  return path;
}

test('delivery spans are monotonic, overlap safely, finish once, and retain no input text', async t => {
  const path = await fixture(t);
  let mono = 100, wall = 100_000;
  const diagnostics = createDiagnostics({ path, monotonicNow: () => mono, wallNow: () => wall });
  const trace = diagnostics.begin({ ...request, secret: 'https://source.test/private-caption' } as DeliveryRequest);
  const download = trace.startStage('download');
  mono += 20;
  const inspect = trace.startStage('inspect', 0);
  wall += 20_000; mono += 10;
  inspect.finish(); download.finish(); download.finish('failed');
  trace.setPath('hosted-original');
  trace.finish('confirmed'); trace.finish('internal-failure');
  assert.equal(await diagnostics.bind(trace.id, messageId), true);
  const details = await diagnostics.lookup(trace.id, reader);
  assert.equal(details?.durationMs, 30);
  assert.deepEqual(details?.stages, [
    { stage: 'inspect', itemIndex: 0, outcome: 'ok', durationMs: 10 },
    { stage: 'download', outcome: 'ok', durationMs: 30 },
  ]);
  const raw = await readFile(path, 'utf8');
  assert.doesNotMatch(raw, /source\.test|private-caption|secret/);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  const restarted = createDiagnostics({ path, wallNow: () => wall });
  assert.equal((await restarted.lookup(trace.id, reader))?.outcome, 'confirmed');
});

test('pending attempts become interrupted after restart; identity boundaries are exact', async t => {
  const path = await fixture(t);
  const diagnostics = createDiagnostics({ path });
  const trace = diagnostics.begin(request);
  assert.equal(await diagnostics.bind(trace.id, messageId), true);
  const restarted = createDiagnostics({ path });
  assert.equal((await restarted.lookup(trace.id, reader))?.outcome, 'interrupted');
  for (const changed of [
    { requesterId: '100000000000000009' }, { channelId: '100000000000000009' },
    { guildId: undefined }, { guildId: '100000000000000009' }, { messageId: '100000000000000009' },
  ]) assert.equal(await restarted.lookup(trace.id, { ...reader, ...changed }), undefined);
  await restarted.flush();
});

test('failed persistence never exposes Details or rejects delivery traces', async t => {
  const diagnostics = createDiagnostics({ path: await fixture(t), write: async () => { throw new Error('disk full'); } });
  const trace = diagnostics.begin(request);
  trace.startStage('publish').finish(); trace.finish('confirmed');
  assert.equal(await diagnostics.bind(trace.id, messageId), false);
  assert.equal(await diagnostics.lookup(trace.id, reader), undefined);
  assert.equal(await diagnostics.flush(), false);
});

test('a binding changed while a write is in flight is not credited to the earlier snapshot', async t => {
  let release: (() => void) | undefined;
  let first = true;
  const snapshots: string[] = [];
  const diagnostics = createDiagnostics({ path: await fixture(t), write: async (_path, content) => {
    snapshots.push(content);
    if (first) { first = false; await new Promise<void>(resolve => { release = resolve; }); }
  } });
  await diagnostics.ready;
  const trace = diagnostics.begin(request);
  await new Promise(resolve => setImmediate(resolve));
  const binding = diagnostics.bind(trace.id, messageId);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await diagnostics.lookup(trace.id, reader), undefined);
  assert.doesNotMatch(snapshots[0], /messageId/);
  release!();
  assert.equal(await binding, true);
  assert.match(snapshots.at(-1)!, /messageId/);
});

test('a stalled diagnostic write omits Details without blocking delivery indefinitely', async t => {
  let release: (() => void) | undefined;
  let blocked = true;
  const diagnostics = createDiagnostics({ path: await fixture(t), operationTimeoutMs: 10,
    write: async () => { if (blocked) { blocked = false; await new Promise<void>(resolve => { release = resolve; }); } } });
  const trace = diagnostics.begin(request);
  const bound = await diagnostics.bind(trace.id, messageId);
  assert.equal(bound, false);
  assert.equal(await diagnostics.lookup(trace.id, reader), undefined);
  // Complete the pending I/O so teardown can flush normally; delivery already continued without the button.
  release!();
  await diagnostics.flush();
});

test('history is bounded by retention, count, bytes, and number of stages', async t => {
  const path = await fixture(t);
  let wall = 1_000;
  const diagnostics = createDiagnostics({ path, wallNow: () => wall, maxAttempts: 2, maxBytes: 2_000, retentionMs: 100 });
  const traces = [];
  for (let index = 0; index < 3; index++) {
    const trace = diagnostics.begin(request); traces.push(trace);
    await diagnostics.bind(trace.id, messageId); wall++;
  }
  assert.equal(await diagnostics.lookup(traces[0].id, reader), undefined);
  assert.ok(await diagnostics.lookup(traces[2].id, reader));
  for (let index = 0; index < 500; index++) traces[2].startStage('download').finish();
  await diagnostics.flush();
  assert.ok((await stat(path)).size <= 2_000);
  wall += 100;
  assert.equal(await diagnostics.lookup(traces[2].id, reader), undefined);
  await diagnostics.flush();
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).attempts, []);
});

test('malformed or oversized diagnostics cannot block startup or restore arbitrary fields', async t => {
  const path = await fixture(t);
  for (const content of ['not json', 'x'.repeat(1_025), JSON.stringify({ version: 1, attempts: [{ id: 'bad' }] })]) {
    await writeFile(path, content);
    const diagnostics = createDiagnostics({ path, maxBytes: 1_024 });
    await diagnostics.ready;
    assert.equal(await diagnostics.lookup('bad', reader), undefined);
    await diagnostics.close();
  }
});

test('idle expiry is persisted without waiting for another delivery', async t => {
  const path = await fixture(t);
  let wall = 1_000;
  const diagnostics = createDiagnostics({ path, retentionMs: 15, wallNow: () => wall });
  const trace = diagnostics.begin(request);
  assert.equal(await diagnostics.bind(trace.id, messageId), true);
  wall += 20;
  await new Promise(resolve => setTimeout(resolve, 35));
  await diagnostics.flush();
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).attempts, []);
});

test('untrusted stage fields and excess overlapping spans are discarded before persistence', async t => {
  const diagnostics = createDiagnostics({ path: await fixture(t) });
  const trace = diagnostics.begin(request);
  const spans = Array.from({ length: 300 }, () => trace.startStage('download'));
  trace.startStage('private caption' as never).finish();
  trace.startStage('inspect', Number.NaN).finish();
  spans.forEach(span => span.finish());
  await diagnostics.bind(trace.id, messageId);
  const record = await diagnostics.lookup(trace.id, reader);
  assert.equal(record?.stages.length, 96);
  assert.ok(record?.stages.every(span => span.stage === 'download'));
});

test('any member can open shared Details privately, but private replies and message bindings stay protected', async t => {
  const diagnostics = createDiagnostics({ path: await fixture(t) });
  const trace = diagnostics.begin(request); trace.finish('metadata-unconfirmed');
  assert.equal(await diagnostics.bind(trace.id, messageId), true);
  const botId = '100000000000000005';
  const button = deliveryDetailsButton(trace.id).toJSON();
  const other = '100000000000000009';
  const available = /metadata was not confirmed/, unavailable = /no longer available/;
  for (const { actor = request.requesterId, author = botId, guild = request.guildId,
    channel = request.channelId, output = messageId, ephemeral = false, expected } of [
    { expected: available },
    { actor: other, expected: available },
    { actor: other, ephemeral: true, expected: unavailable },
    { ephemeral: true, expected: available },
    { author: other, expected: unavailable },
    { guild: null, expected: unavailable },
    { guild: other, expected: unavailable },
    { channel: other, expected: unavailable },
    { output: other, expected: unavailable },
  ]) {
    const replies: unknown[] = [];
    const interaction = { customId: 'custom_id' in button ? button.custom_id : '', user: { id: actor },
      channelId: channel, guildId: guild, message: { id: output, author: { id: author },
        channelId: request.channelId, guildId: request.guildId,
        flags: new MessageFlagsBitField(ephemeral ? MessageFlags.Ephemeral : 0) },
      client: { user: { id: botId } }, deferReply: async (value: unknown) => { replies.push(value); },
      editReply: async (value: unknown) => { replies.push(value); } } as unknown as ButtonInteraction;
    assert.equal(await handleDeliveryDetails(interaction, diagnostics), true);
    assert.deepEqual(replies[0], { flags: MessageFlags.Ephemeral });
    const response = replies[1] as { content: string; allowedMentions: unknown };
    assert.match(response.content, expected);
    assert.deepEqual(response.allowedMentions, { parse: [] });
  }
  assert.equal((await diagnostics.lookup(trace.id, reader))?.requesterId, request.requesterId);
});

test('shared delivery lookup remains bound to its saved server message and cannot expose DM attempts', async t => {
  const diagnostics = createDiagnostics({ path: await fixture(t) });
  const trace = diagnostics.begin(request); trace.finish('confirmed');
  assert.equal(await diagnostics.bind(trace.id, messageId), true);
  const shared = { ...reader, requesterId: '100000000000000009', sharedMessage: true };
  assert.equal((await diagnostics.lookup(trace.id, shared))?.outcome, 'confirmed');
  for (const changed of [{ channelId: '100000000000000008' }, { guildId: undefined },
    { guildId: '100000000000000008' }, { messageId: '100000000000000008' }, { requesterId: 'invalid' }]) {
    assert.equal(await diagnostics.lookup(trace.id, { ...shared, ...changed }), undefined);
  }
  const dm = diagnostics.begin({ ...request, guildId: undefined, mode: 'manual' });
  assert.equal(await diagnostics.bind(dm.id, messageId), true);
  assert.equal(await diagnostics.lookup(dm.id, { ...shared, guildId: undefined }), undefined);
  assert.ok(await diagnostics.lookup(dm.id, { ...reader, guildId: undefined }));
});

test('private Details shows finite non-ok stage outcomes with timing and repeat counts', async t => {
  let mono = 0;
  const diagnostics = createDiagnostics({ path: await fixture(t), monotonicNow: () => mono });
  const trace = diagnostics.begin(request);
  trace.startStage('queue').finish('busy');
  for (const outcome of ['unavailable', 'unavailable', 'timeout', 'ok'] as const) {
    const span = trace.startStage('download'); mono += 250; span.finish(outcome);
  }
  trace.startStage('inspect').finish('cancelled');
  trace.startStage('store').finish('failed');
  trace.finish('unavailable');
  await diagnostics.bind(trace.id, messageId);
  const record = (await diagnostics.lookup(trace.id, reader))!;
  const content = formatDeliveryDetails(record);
  assert.match(content, /queue: 0\.0 s · busy/);
  assert.match(content, /download: 1\.0 s · unavailable × 2, timeout/);
  assert.match(content, /inspect: 0\.0 s · cancelled/);
  assert.match(content, /store: 0\.0 s · failed/);
  assert.doesNotMatch(content, /· ok/);
  assert.match(content, /preview could not be prepared/);
});

test('delivery summaries do not invent metadata, album items, or a definite Discord rejection', async t => {
  const diagnostics = createDiagnostics({ path: await fixture(t) });
  const trace = diagnostics.begin({ ...request, platform: 'instagram' });
  await diagnostics.bind(trace.id, messageId);
  const record = (await diagnostics.lookup(trace.id, reader))!;
  assert.match(formatDeliveryDetails({ ...record, outcome: 'partial' }), /partial preview/);
  assert.doesNotMatch(formatDeliveryDetails({ ...record, outcome: 'partial' }), /album items/);
  assert.match(formatDeliveryDetails({ ...record, outcome: 'confirmed' }), /preview was delivered/);
  assert.doesNotMatch(formatDeliveryDetails({ ...record, outcome: 'confirmed' }), /supplied preview metadata/);
  assert.match(formatDeliveryDetails({ ...record, outcome: 'discord-failure' }), /delivery could not be confirmed/);
});

test('finishing an attempt retains open spans with its finite outcome and ignores later completion', async t => {
  const diagnostics = createDiagnostics({ path: await fixture(t), monotonicNow: (() => { let now = 0; return () => ++now; })() });
  for (const [outcome, expected] of [['discord-failure', 'failed'], ['timeout', 'timeout'], ['cancelled', 'cancelled'],
    ['unavailable', 'unavailable'], ['busy', 'busy'], ['confirmed', 'ok']] as const) {
    const trace = diagnostics.begin(request);
    const publish = trace.startStage('publish');
    const preview = trace.startStage('preview');
    trace.finish(outcome);
    publish.finish('ok'); preview.finish('ok'); trace.finish('confirmed');
    await diagnostics.bind(trace.id, messageId);
    const record = (await diagnostics.lookup(trace.id, reader))!;
    assert.equal(record.outcome, outcome);
    assert.deepEqual(record.stages.map(stage => [stage.stage, stage.outcome]), [['publish', expected], ['preview', expected]]);
    assert.ok(record.stages.every(stage => stage.durationMs > 0));
  }
});

test('finishing a full set of open spans respects the same 96-span cap', async t => {
  const diagnostics = createDiagnostics({ path: await fixture(t) });
  const trace = diagnostics.begin(request);
  for (let index = 0; index < 200; index++) trace.startStage('download');
  trace.finish('timeout');
  trace.startStage('publish').finish();
  await diagnostics.bind(trace.id, messageId);
  const record = (await diagnostics.lookup(trace.id, reader))!;
  assert.equal(record.stages.length, 96);
  assert.ok(record.stages.every(stage => stage.outcome === 'timeout'));
});

test('cache reuse persists independently of progress, and late cache callbacks cannot change finished attempts', async t => {
  const path = await fixture(t);
  const diagnostics = createDiagnostics({ path });
  const trace = diagnostics.begin(request);
  trace.setCache?.('miss'); trace.setCache?.('hit');
  trace.finish('confirmed'); trace.setCache?.('miss');
  await diagnostics.bind(trace.id, messageId);
  const restarted = createDiagnostics({ path });
  const record = (await restarted.lookup(trace.id, reader))!;
  assert.equal(record.cache, 'hit');
  assert.match(formatDeliveryDetails(record), /Cache: reused a validated local preview/);
  assert.match(formatDeliveryDetails({ ...record, cache: 'miss', outcome: 'unavailable' }), /Cache: no reusable local preview/);
});

test('cache fields accept only the finite schema and never restore arbitrary input text', async t => {
  const path = await fixture(t);
  const diagnostics = createDiagnostics({ path });
  const trace = diagnostics.begin(request);
  trace.setCache?.('private-caption' as never);
  await diagnostics.bind(trace.id, messageId);
  assert.equal((await diagnostics.lookup(trace.id, reader))?.cache, undefined);
  const snapshot = JSON.parse(await readFile(path, 'utf8'));
  snapshot.attempts[0].cache = 'https://source.example/private';
  await writeFile(path, JSON.stringify(snapshot));
  const restarted = createDiagnostics({ path });
  assert.equal(await restarted.lookup(trace.id, reader), undefined);
});

test('a burst of full-span records keeps only the newest whole records within the exact byte budget', async t => {
  const maxBytes = 48_000;
  let wall = 1_000, snapshot = '';
  const diagnostics = createDiagnostics({ path: await fixture(t), maxBytes, wallNow: () => wall,
    write: async (_path, content) => { snapshot = content; } });
  await diagnostics.ready;
  const ids: string[] = [];
  for (let index = 0; index < 120; index++) {
    const trace = diagnostics.begin(request); ids.push(trace.id);
    for (let stage = 0; stage < 96; stage++) trace.startStage('download').finish();
    trace.finish('confirmed'); wall++;
  }
  await diagnostics.flush();
  const records = JSON.parse(snapshot).attempts as { id: string; stages: unknown[] }[];
  assert.ok(records.length > 1 && records.length < ids.length);
  assert.deepEqual(records.map(record => record.id), ids.slice(-records.length));
  assert.ok(records.every(record => record.stages.length === 96));
  assert.ok(Buffer.byteLength(snapshot) <= maxBytes);
  assert.ok(Buffer.byteLength(snapshot) + Buffer.byteLength(JSON.stringify(records[0])) + 1 > maxBytes,
    'The newest whole record that fits should not be discarded');
});
