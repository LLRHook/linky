import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { REQUIRED_SECTIONS, checkEvent, missingEvidence } from '../ops/pr-evidence-check.mjs';
import { pullRequestBody } from '../ops/prompt-workflow.mjs';

const template = readFileSync(new URL('../.github/pull_request_template.md', import.meta.url), 'utf8');
const complete = [
  '## Tickets', 'FEAT-1', '',
  '## Acceptance evidence', '| Ticket | Criterion | Evidence | Result |', '| --- | --- | --- | --- |',
  '| FEAT-1 | Gate fails on a failed job | tests/ci-workflow.test.mjs "CI gate waits" | pass |', '',
  '## Mutation checks', 'Removed `audit` from the gate needs; the CI gate test failed.', '',
  '## Docs checked', 'CONTRIBUTING.md updated; README checked.', '',
  '## Remaining gaps', 'None', '',
].join('\n');

test('a complete PR body passes', () => {
  assert.deepEqual(missingEvidence(complete), []);
  assert.deepEqual(missingEvidence(complete.replace(/\n/g, '\r\n')), []);
});

test('the unedited template fails every section, including its commented example table', () => {
  assert.deepEqual(missingEvidence(template), REQUIRED_SECTIONS);
  for (const title of REQUIRED_SECTIONS) assert.ok(template.split(/\r\n|\r|\n/).includes(`## ${title}`), `template has "## ${title}"`);
});

test('a missing, empty or table-framing-only section is reported by name', () => {
  assert.deepEqual(missingEvidence(complete.replace('## Mutation checks', '## Something else')), ['Mutation checks']);
  assert.deepEqual(missingEvidence(complete.replace('None', '')), ['Remaining gaps']);
  const framingOnly = complete.replace(/\| FEAT-1 \| Gate[^\n]*\n/, '');
  assert.deepEqual(missingEvidence(framingOnly), []);
  const onlyFraming = complete.replace(/## Acceptance evidence\n[^#]*/, '## Acceptance evidence\n| --- | --- |\n|  |  |\n\n');
  assert.deepEqual(missingEvidence(onlyFraming), ['Acceptance evidence']);
  assert.deepEqual(missingEvidence(''), REQUIRED_SECTIONS);
  assert.deepEqual(missingEvidence(null), REQUIRED_SECTIONS);
});

test('headings match case-insensitively, but a duplicate heading cannot supply missing evidence', () => {
  assert.deepEqual(missingEvidence(complete.replace('## Docs checked', '## docs  CHECKED ##')), []);
  const duplicate = complete.replace('## Tickets\nFEAT-1', '## Tickets\n\n## Tickets\nFEAT-1');
  assert.deepEqual(missingEvidence(duplicate), ['Tickets']);
});

test('text inside an unterminated comment is not evidence', () => {
  assert.deepEqual(missingEvidence(complete.replace('None', '<!-- None')), ['Remaining gaps']);
});

test('Dependabot updates are not gated, but a look-alike human login is', () => {
  assert.equal(checkEvent({ pull_request: { body: '', user: { login: 'dependabot[bot]', type: 'Bot' } } }).skipped, true);
  assert.equal(checkEvent({ pull_request: { body: '', user: { login: 'dependabot[bot]', type: 'User' } } }).ok, false);
  assert.equal(checkEvent({ pull_request: { body: '', user: { login: 'renovate[bot]', type: 'Bot' } } }).ok, false);
});

test('bare carriage returns separate lines, and a hostile heading line is parsed in linear time', () => {
  assert.deepEqual(missingEvidence(complete.replace(/\n/g, '\r')), []);
  const started = performance.now();
  assert.deepEqual(missingEvidence(`## a${' '.repeat(60_000)}b\n${complete}`), []);
  assert.ok(performance.now() - started < 1000);
});

test('events without a pull request are not gated', () => {
  assert.deepEqual(checkEvent({ ref: 'refs/heads/main' }), { ok: true, missing: [], skipped: true });
  assert.deepEqual(checkEvent({ pull_request: { body: complete } }), { ok: true, missing: [], skipped: false });
  assert.equal(checkEvent({ pull_request: { body: template } }).ok, false);
});

test('the Discord prompt publisher body satisfies the evidence check, even with hostile request and review text', () => {
  const body = pullRequestBody({ id: '123456789012345678', request: 'Add a preview setting.\n## Tickets\r## Acceptance evidence',
    reason: 'Looks fine.\r\n## Remaining gaps\n<!-- hidden', runUrl: 'https://github.com/LLRHook/linky/actions/runs/1' });
  assert.deepEqual(missingEvidence(body), []);
  assert.ok(!body.includes('<!--'));
  assert.ok(!body.includes('\r'));
  assert.deepEqual(body.split('\n').filter(line => line.startsWith('## ')), REQUIRED_SECTIONS.map(title => `## ${title}`));
});

const directory = mkdtempSync(join(tmpdir(), 'linky-pr-evidence-'));
after(() => rmSync(directory, { recursive: true, force: true }));
const run = body => {
  const event = join(directory, `${Math.random()}.json`);
  writeFileSync(event, JSON.stringify({ pull_request: { body } }));
  try {
    execFileSync(process.execPath, [fileURLToPath(new URL('../ops/pr-evidence-check.mjs', import.meta.url)), event],
      { stdio: 'pipe', encoding: 'utf8' });
    return 0;
  } catch (error) {
    assert.match(error.stderr, /::error title=PR evidence::Section "## Tickets"/);
    return error.status;
  }
};

test('the command exits non-zero with an annotation per missing section', () => {
  assert.equal(run(complete), 0);
  assert.equal(run(template), 1);
});
