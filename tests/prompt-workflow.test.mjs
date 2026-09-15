import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvedReview, publish, requiredChecksPass, validateRequest } from '../ops/prompt-workflow.mjs';

const directory = mkdtempSync(join(tmpdir(), 'linky-workflow-'));
after(() => rmSync(directory, { recursive: true, force: true }));
const base = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const head = 'a'.repeat(40);
const merged = 'b'.repeat(40);
const checkNames = ['Build (Node 22)', 'Build (Node 24)', 'Production container'];
const checks = () => checkNames.map((name, index) => ({ id: index + 1, name, head_sha: head,
  app: { slug: 'github-actions' }, status: 'completed', conclusion: 'success' }));

test('required check evidence must match all names, latest run, app, head and completion', () => {
  assert.equal(requiredChecksPass(checks(), head), true);
  for (const replacement of [{ conclusion: 'failure' }, { status: 'queued' }, { head_sha: merged }, { app: { slug: 'other' } }]) {
    const input = checks();
    input[0] = { ...input[0], ...replacement };
    assert.equal(requiredChecksPass(input, head), false);
  }
  assert.equal(requiredChecksPass(checks().slice(1), head), false);
  assert.equal(requiredChecksPass([...checks(), { ...checks()[0], id: 99, conclusion: 'failure' }], head), false);
});

test('request validation rejects injection-shaped IDs and oversized/control inputs', () => {
  validateRequest('123456789012345678', 'Add a preview setting.');
  for (const args of [['x; shell', 'A long feature'], ['123456789012345678', 'short'],
    ['123456789012345678', 'x'.repeat(3001)], ['123456789012345678', 'text\0with control']]) {
    assert.throws(() => validateRequest(...args));
  }
});

test('review needs an explicit approval and reason', () => {
  assert.equal(Boolean(approvedReview({ verdict: 'approve', reason: 'Focused change with coverage.' })), true);
  for (const review of [null, {}, { verdict: 'request_changes', reason: 'A bug' }, { verdict: 'approve', reason: '' }]) {
    assert.equal(Boolean(approvedReview(review)), false);
  }
});

async function scenario(t, options = {}) {
  const candidate = { files: [{ path: 'README.md', content: 'A focused documentation improvement.\n' }] };
  const paths = ['candidate.json', 'review.json', 'binding.json'].map(name => join(directory, name));
  writeFileSync(paths[0], JSON.stringify(candidate));
  writeFileSync(paths[1], JSON.stringify({ verdict: options.reject ? 'request_changes' : 'approve', reason: 'Reviewed.' }));
  writeFileSync(paths[2], JSON.stringify({ base, digest: options.wrongDigest ? 'bad' : createHash('sha256').update(JSON.stringify(candidate)).digest('hex') }));
  const previous = { ...process.env };
  Object.assign(process.env, { BASE_SHA: base, JOB_ID: '123456789012345678', FEATURE_REQUEST: 'Improve the setup documentation.',
    GITHUB_RUN_ID: '123', PROMPT_PUBLISH_TOKEN: 'test-publisher' });
  delete process.env.GITHUB_STEP_SUMMARY;
  t.after(() => { process.env = previous; });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url).replace('https://api.github.com/repos/LLRHook/linky', '');
    calls.push({ path, method: init.method || 'GET', body: init.body && JSON.parse(init.body) });
    assert.equal(init.redirect, 'error');
    if (path === '/git/ref/heads/main') return Response.json({ object: { sha: options.changedMain ? merged : base } });
    if (path === `/git/commits/${base}`) return Response.json({ tree: { sha: 'old-tree' } });
    if (path === '/git/blobs') return Response.json({ sha: 'blob' });
    if (path === '/git/trees') return Response.json({ sha: 'new-tree' });
    if (path === '/git/commits') return Response.json({ sha: head });
    if (path === '/git/refs') return Response.json({});
    if (path === '/pulls') return Response.json({ number: 123 });
    if (path === '/pulls/123') return Response.json({ head: { sha: options.changedHead ? merged : head },
      base: { sha: base }, state: 'open', mergeable_state: 'clean' });
    if (path.includes('/check-runs?')) return Response.json({ check_runs: options.failedCheck
      ? checks().map(check => ({ ...check, conclusion: 'failure' })) : checks() });
    if (path === '/pulls/123/merge') return Response.json({ merged: true, sha: merged });
    if (path.includes('/actions/workflows/deploy.yml/runs?')) {
      assert.ok(path.includes(`head_sha=${merged}`));
      return Response.json({ workflow_runs: [{ id: 456, head_sha: merged, event: 'workflow_run', head_branch: 'main',
        status: 'completed', conclusion: options.failedDeploy ? 'failure' : 'success' }] });
    }
    if (path === '/actions/runs/456/jobs?per_page=100') return Response.json({ jobs: [{ name: 'deploy', conclusion: options.failedDeploy ? 'failure' : 'success',
      steps: [{ name: `Hostinger confirmed commit ${merged}`, conclusion: options.skippedDeploy ? 'skipped' : 'success' }] }] });
    throw new Error(`Unexpected request: ${path}`);
  });
  return { execute: () => publish(...paths), calls };
}

test('publisher creates a PR, requires exact-head checks, uses protected merge and waits for deployment', async t => {
  const s = await scenario(t);
  await s.execute();
  const merge = s.calls.find(call => call.path.endsWith('/merge'));
  assert.equal(merge.method, 'PUT');
  assert.deepEqual(merge.body, { sha: head, merge_method: 'squash', commit_title: 'prompt/123456789012345678 (#123)' });
  assert.ok(s.calls.at(-1).path.includes('/actions/runs/456/jobs'));
  assert.ok(!s.calls.some(call => call.path.includes('protection')));
});

for (const options of [{ reject: true }, { wrongDigest: true }, { changedMain: true }, { changedHead: true }, { failedCheck: true }]) {
  test(`publisher refuses unsafe merge: ${Object.keys(options)[0]}`, async t => {
    const s = await scenario(t, options);
    await assert.rejects(s.execute());
    assert.ok(!s.calls.some(call => call.path.endsWith('/merge')));
  });
}

test('deployment failure cannot report overall success after merging', async t => {
  const s = await scenario(t, { failedDeploy: true });
  await assert.rejects(s.execute(), /deployment failed/);
  assert.ok(s.calls.some(call => call.path.endsWith('/merge')));
});

test('a green but superseded deployment cannot report that the candidate reached Hostinger', async t => {
  const s = await scenario(t, { skippedDeploy: true });
  await assert.rejects(s.execute(), /host did not confirm/);
});
