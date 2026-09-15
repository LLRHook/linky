import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PromptService } from '../src/services/PromptService';

const directory = mkdtempSync(join(tmpdir(), 'linky-prompt-'));
after(() => rmSync(directory, { recursive: true, force: true }));
const guildId = '111111111111111111';
const userId = '222222222222222222';
const id = '333333333333333333';
const input = { id, guildId, userId, request: 'Add a compact preview preference.' };
let sequence = 0;

function fixture(handler: (url: string, init: RequestInit) => Response | Promise<Response> = () => new Response(null, { status: 204 })) {
  const calls: { url: string; init: RequestInit }[] = [];
  const file = join(directory, `${sequence++}.json`);
  let now = Date.parse('2026-09-14T12:00:00Z');
  const fetcher = (async (url, init) => { calls.push({ url: String(url), init: init! }); return handler(String(url), init!); }) as typeof fetch;
  const open = () => new PromptService({ token: 'private-test-token', guildIds: [guildId] }, file, fetcher, () => now);
  return { service: open(), open, calls, file, advance: (milliseconds: number) => { now += milliseconds; } };
}

function run(state = 'in_progress', conclusion: string | null = null) {
  return { id: 123, display_title: `Linky prompt ${id}`, event: 'workflow_dispatch', head_branch: 'main', status: state, conclusion };
}

test('intake dispatches fixed workflow/main once without persisting request text or tokens', async () => {
  const f = fixture();
  assert.equal((await f.service.submit(input)).state, 'queued');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://api.github.com/repos/LLRHook/linky/actions/workflows/discord-prompt.yml/dispatches');
  assert.deepEqual(JSON.parse(f.calls[0].init.body as string), { ref: 'main', inputs: { job_id: id, request: input.request } });
  assert.equal(f.calls[0].init.redirect, 'error');
  const journal = readFileSync(f.file, 'utf8');
  assert.ok(!journal.includes(input.request));
  assert.ok(!journal.includes('private-test-token'));
  assert.equal((await f.service.submit(input)).state, 'queued');
  assert.equal((await f.open().submit(input)).state, 'queued');
  assert.equal(f.calls.length, 1);
});

test('invalid requests and ineligible servers cause no network requests', async () => {
  const f = fixture();
  for (const patch of [{ guildId: '999999999999999999' }, { id: 'bad' }, { userId: '' }, { request: 'short' }, { request: 'x'.repeat(3001) }]) {
    await assert.rejects(f.service.submit({ ...input, ...patch }));
  }
  assert.equal(f.calls.length, 0);
});

test('simultaneous requests serialize admission, including identical retries', async () => {
  const f = fixture(url => url.endsWith('/dispatches') ? new Response(null, { status: 204 }) : Response.json({ workflow_runs: [] }));
  const results = await Promise.allSettled([f.service.submit(input), f.service.submit(input),
    f.service.submit({ ...input, id: '444444444444444444' })]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled', 'rejected']);
  assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 1);
});

test('lost dispatch responses remain uncertain across restart and never automatically resend', async () => {
  const f = fixture(() => { throw new Error('private transport details'); });
  const job = await f.service.submit(input);
  assert.equal(job.state, 'uncertain');
  assert.ok(!job.message.includes('private transport details'));
  assert.equal((await f.open().submit(input)).state, 'uncertain');
  await assert.rejects(f.open().submit({ ...input, id: '444444444444444444' }), /already active/);
  assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 1);
});

test('confirmed dispatch rejections fail without exposing response bodies', async () => {
  const f = fixture(() => new Response('secret internal error', { status: 403 }));
  const job = await f.service.submit(input);
  assert.equal(job.state, 'failed');
  assert.ok(!job.message.includes('secret'));
});

test('status finds the exact run and builds only fixed repository URLs', async () => {
  let complete = false;
  const f = fixture(url => {
    if (url.endsWith('/dispatches')) return new Response(null, { status: 204 });
    if (url.includes('/pulls?')) return Response.json([{ number: 42, html_url: 'https://evil.invalid' }]);
    if (url.endsWith('/actions/runs/123')) return Response.json(run('completed', complete ? 'success' : 'failure'));
    return Response.json({ workflow_runs: [{ ...run(), display_title: 'different run' }, run()] });
  });
  await f.service.submit(input);
  const working = await f.service.status(id, guildId);
  assert.equal(working.state, 'running');
  assert.equal(working.runUrl, 'https://github.com/LLRHook/linky/actions/runs/123');
  assert.equal(working.prUrl, 'https://github.com/LLRHook/linky/pull/42');
  complete = true;
  assert.equal((await f.open().status(id, guildId)).state, 'succeeded');
});

test('a failed/cancelled workflow never reports a successful deployment', async () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped']) {
    const f = fixture(url => {
      if (url.endsWith('/dispatches')) return new Response(null, { status: 204 });
      if (url.includes('/pulls?')) return Response.json([]);
      return Response.json({ workflow_runs: [run('completed', conclusion)] });
    });
    await f.service.submit(input);
    assert.equal((await f.service.status(id, guildId)).state, 'failed');
  }
});

test('status denial prevents cross-server information disclosure and duplicate ID spoofing', async () => {
  const f = fixture();
  await f.service.submit(input);
  await assert.rejects(f.service.status(id, '999999999999999999'), /not enabled/);
  await assert.rejects(f.service.status('444444444444444444', guildId), /not found/);
  await assert.rejects(f.service.submit({ ...input, userId: '555555555555555555' }), /not found/);
  assert.equal(f.calls.length, 1);
});

test('daily admission limits and user cooldown survive process restarts', async () => {
  const f = fixture(() => new Response(null, { status: 403 }));
  await f.service.submit(input);
  await assert.rejects(f.open().submit({ ...input, id: '444444444444444444' }), /30 minutes/);
  f.advance(31 * 60_000);
  await f.open().submit({ ...input, id: '444444444444444444' });
  f.advance(31 * 60_000);
  await f.open().submit({ ...input, id: '555555555555555555' });
  f.advance(31 * 60_000);
  await assert.rejects(f.open().submit({ ...input, id: '666666666666666666' }), /3 coding jobs/);
  f.advance(86_400_000);
  assert.equal((await f.open().submit({ ...input, id: '666666666666666666' })).state, 'failed');
});

test('corrupt job history cannot silently reset limits', () => {
  const f = fixture();
  writeFileSync(f.file, '{corrupt');
  assert.throws(f.open, /Cannot read/);
});

test('unrelated workflow metadata cannot settle an uncertain request', async () => {
  const f = fixture(url => url.endsWith('/dispatches') ? new Response(null, { status: 502 }) :
    Response.json({ workflow_runs: [{ ...run('completed', 'success'), head_branch: 'other' }] }));
  await f.service.submit(input);
  assert.equal((await f.service.status(id, guildId)).state, 'uncertain');
});

test('latest status can recover a lost Discord response without resubmitting, and refreshes are bounded', async () => {
  const f = fixture(url => url.endsWith('/dispatches') ? new Response(null, { status: 204 }) : Response.json({ workflow_runs: [] }));
  await assert.rejects(f.service.status(undefined, guildId), /not found/);
  await f.service.submit(input);
  assert.equal((await f.open().status(undefined, guildId)).id, id);
  await f.service.status(undefined, guildId);
  const calls = f.calls.length;
  await f.service.status(undefined, guildId);
  assert.equal(f.calls.length, calls);
  assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 1);
});

function streamedResponse(payload: unknown, declaredBytes?: number, status = 200) {
  const bytes = Buffer.from(JSON.stringify(payload));
  let consumed = 0, cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (consumed === bytes.length) { controller.close(); return; }
      const end = Math.min(consumed + 16_384, bytes.length);
      controller.enqueue(bytes.subarray(consumed, end)); consumed = end;
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), {
    status, headers: declaredBytes === undefined ? {} : { 'content-length': String(declaredBytes) },
  });
  return { response, consumed: () => consumed, cancelled: () => cancelled, size: bytes.length };
}

for (const endpoint of ['workflow-list', 'run', 'pulls']) for (const declared of [true, false]) {
  test(`oversized ${declared ? 'declared' : 'chunked'} ${endpoint} metadata preserves confirmed prompt progress`, async () => {
    const limit = 4 * 1024 * 1024;
    const unused = declared ? 'small body with an oversized header' : 'x'.repeat(limit * 2);
    const payload = endpoint === 'workflow-list' ? { workflow_runs: [run()], unused }
      : endpoint === 'run' ? { ...run('completed', 'success'), unused } : [{ number: 42, unused }];
    const body = streamedResponse(payload, declared ? 1024 * 1024 * 1024 : undefined);
    const f = fixture(url => {
      if (url.endsWith('/dispatches')) return new Response(null, { status: 204 });
      if (url.endsWith('/actions/runs/123')) return endpoint === 'run' ? body.response : Response.json(run());
      if (url.includes('/pulls?')) return endpoint === 'pulls' ? body.response : Response.json([]);
      return endpoint === 'workflow-list' ? body.response : Response.json({ workflow_runs: [run()] });
    });
    await f.service.submit(input);
    if (endpoint === 'run') {
      assert.equal((await f.service.status(id, guildId)).state, 'running');
      f.advance(10_001);
    }
    const result = await f.service.status(id, guildId);
    assert.equal(result.state, endpoint === 'workflow-list' ? 'queued' : 'running');
    assert.equal(result.prUrl, undefined);
    assert.equal(body.cancelled(), true);
    if (declared) assert.equal(body.consumed(), 0);
    else assert(body.consumed() <= limit + 16_384 && body.consumed() < body.size);
    assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 1, 'a failed status read must never dispatch again');
  });
}

test('dispatch and status HTTP errors cancel unread bodies without exposing or changing confirmed state', async () => {
  const dispatch = streamedResponse({ private: 'unneeded dispatch error' }, undefined, 502);
  const status = streamedResponse({ private: 'unneeded status error' }, undefined, 503);
  const f = fixture(url => url.endsWith('/dispatches') ? dispatch.response : status.response);
  assert.equal((await f.service.submit(input)).state, 'uncertain');
  assert.equal((await f.service.status(id, guildId)).state, 'uncertain');
  for (const body of [dispatch, status]) {
    assert.equal(body.consumed(), 0);
    assert.equal(body.cancelled(), true);
  }
});
