import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { exportCandidate, MAX_CANDIDATE_BYTES, validateCandidate } from '../ops/prompt-candidate.mjs';

const candidate = (filePath, content = 'text') => ({ files: [{ path: filePath, content }] });
const baseline = new Set(['src/example.ts', 'tests/existing.test.ts', 'README.md']);

test('validates source edits, deletions, new tests and documentation', () => {
  const input = { files: [
    { path: 'src/services/Example.ts', content: 'export const text = "こんにちは";\n' },
    { path: 'src/old.ts', content: null },
    { path: 'tests/new.test.ts', content: 'test();\n' },
    { path: 'docs/example.md', content: '# Example\r\n\ttext' },
    { path: 'README.md', content: '' },
  ] };
  assert.deepEqual(validateCandidate(input, baseline), input);
  assert.notEqual(validateCandidate(input, baseline).files, input.files);
  assert.throws(() => validateCandidate({ files: [] }), /no changes/);
});

test('rejects malformed envelopes, entries and content types', () => {
  for (const input of [null, [], {}, { files: {} }, { files: [], extra: true }, { files: Array(1) },
    { files: [null] }, { files: [['src/example.ts', 'text']] },
    { files: [{ path: 'src/example.ts' }] },
    { files: [{ path: 'src/example.ts', content: 'text', mode: '120000' }] },
    candidate('src/example.ts', 123), candidate('src/example.ts', {}),
    { files: [{ path: 'src/example.ts', content: undefined }] }]) {
    assert.throws(() => validateCandidate(input, baseline));
  }
  assert.throws(() => validateCandidate(candidate('README.md'), []), /trusted Set/);
});

test('rejects traversal, aliases, hidden segments and non-ASCII paths', () => {
  for (const filePath of [
    '../README.md', '/README.md', 'C:/README.md', 'src/../README.md',
    'src/./example.ts', 'src//example.ts', 'src\\example.ts', 'src/.git/example.ts',
    'src/.hidden.ts', 'src/é.ts', 'src/example.ts\0', 'src/example.ts ',
    'src/CON.ts', 'src/aux/example.ts', 'src/lpt1.test.ts', 'src/folder./example.ts',
    'src/' + 'a'.repeat(240) + '.ts',
  ]) assert.throws(() => validateCandidate(candidate(filePath), baseline), /unsafe/);
});

test('rejects files outside the coding scope and the prompt control surface', () => {
  for (const filePath of [
    '.env', '.github/workflows/ci.yml', 'ops/prompt-candidate.mjs', 'scripts/run.ts',
    'package.json', 'package-lock.json', 'tsconfig.json', 'Dockerfile', 'docker-compose.yml',
    'src/bot.ts', 'src/index.ts', 'src/config.ts', 'src/Config.ts', 'src/commands/prompt.ts',
    'src/commands/register.ts', 'src/services/PromptService.ts',
    'src/example.js', 'tests/nested/new.test.ts', 'tests/new.ts',
    'docs/nested/example.md', 'docs/discord-prompt.md', 'docs/discord-prompt-plan.md',
    'docs/Discord-Prompt-Controller.md', 'readme.md',
  ]) assert.throws(() => validateCandidate(candidate(filePath), baseline));
});

test('requires a trusted baseline for tests and only permits added tests', () => {
  assert.throws(() => validateCandidate(candidate('tests/new.test.ts')), /trusted baseline/);
  assert.throws(() => validateCandidate(candidate('tests/existing.test.ts'), baseline), /only add tests/);
  assert.throws(() => validateCandidate(candidate('tests/EXISTING.test.ts'), baseline), /only add tests/);
  assert.throws(() => validateCandidate(candidate('tests/existing.test.ts', null), baseline), /only add tests/);
  assert.throws(() => validateCandidate(candidate('tests/new.test.ts', null), baseline), /only add tests/);
  assert.deepEqual(validateCandidate(candidate('tests/new.test.ts'), baseline), candidate('tests/new.test.ts'));
});

test('rejects repeated paths, including differences in case', () => {
  for (const duplicate of ['src/example.ts', 'src/Example.ts']) {
    assert.throws(() => validateCandidate({ files: [
      { path: 'src/example.ts', content: 'first' },
      { path: duplicate, content: null },
    ] }, baseline), /repeats/);
  }
});

test('enforces file count and aggregate UTF-8 bytes at the boundary', () => {
  const files = Array.from({ length: 30 }, (_, index) => ({ path: `src/file${index}.ts`, content: '' }));
  assert.equal(validateCandidate({ files }, baseline).files.length, 30);
  assert.throws(() => validateCandidate({ files: [...files, { path: 'README.md', content: '' }] }, baseline), /30 files/);
  assert.equal(validateCandidate(candidate('README.md', 'a'.repeat(MAX_CANDIDATE_BYTES)), baseline).files.length, 1);
  assert.throws(() => validateCandidate(candidate('README.md', 'a'.repeat(MAX_CANDIDATE_BYTES + 1)), baseline), /UTF-8 bytes/);
  assert.throws(() => validateCandidate(candidate('README.md', 'é'.repeat(100_001)), baseline), /UTF-8 bytes/);
  assert.throws(() => validateCandidate({ files: [
    { path: 'README.md', content: 'a'.repeat(100_000) },
    { path: 'docs/example.md', content: 'b'.repeat(100_001) },
  ] }, baseline), /UTF-8 bytes/);
});

test('rejects binary control characters and invalid Unicode strings', () => {
  for (const text of ['a\0b', '\x01', '\x1b', '\x7f', '\ud800', '\udc00']) {
    assert.throws(() => validateCandidate(candidate('README.md', text), baseline), /UTF-8 text/);
  }
  assert.equal(validateCandidate(candidate('README.md', '😀'), baseline).files[0].content, '😀');
});

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'linky-candidate-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.join(path.resolve(tmpdir()), 'linky-candidate-')));
    rmSync(root, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const write = (name, content) => {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), content);
  };
  git('init', '--quiet');
  git('config', 'user.name', 'Victor Ivanov');
  git('config', 'user.email', 'victor.n.ivanov@gmail.com');
  git('config', 'core.autocrlf', 'false');
  write('src/example.ts', 'export const value = 1;\n');
  write('src/deleted.ts', 'export const old = true;\n');
  write('tests/existing.test.ts', 'test();\n');
  write('README.md', '# Linky\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'Test fixture');
  return { root, git, write, base: git('rev-parse', 'HEAD') };
}

test('exports actual working-tree edits, deletions and untracked additions', (t) => {
  const { root, git, write, base } = fixture(t);
  write('src/example.ts', 'staged content\n');
  git('add', 'src/example.ts');
  write('src/example.ts', 'working tree content\n');
  rmSync(path.join(root, 'src/deleted.ts'));
  write('tests/new.test.ts', 'new test\n');
  const result = exportCandidate(base, root);
  assert.deepEqual(result.files.sort((a, b) => a.path.localeCompare(b.path)), [
    { path: 'src/deleted.ts', content: null },
    { path: 'src/example.ts', content: 'working tree content\n' },
    { path: 'tests/new.test.ts', content: 'new test\n' },
  ]);
});

test('exports committed changes since the baseline and preserves a UTF-8 BOM', (t) => {
  const { root, git, write, base } = fixture(t);
  write('README.md', '\ufeff# Updated\n');
  git('add', 'README.md');
  git('commit', '--quiet', '-m', 'Candidate fixture');
  assert.deepEqual(exportCandidate(base, root), candidate('README.md', '\ufeff# Updated\n'));
});

test('exports renames as a deletion and addition', (t) => {
  const { root, git, base } = fixture(t);
  git('mv', 'src/example.ts', 'src/renamed.ts');
  assert.deepEqual(exportCandidate(base, root), { files: [
    { path: 'src/example.ts', content: null },
    { path: 'src/renamed.ts', content: 'export const value = 1;\n' },
  ] });
});

test('export rejects modifications to existing tests and protected files', (t) => {
  const { root, write, base } = fixture(t);
  write('tests/existing.test.ts', 'changed test\n');
  assert.throws(() => exportCandidate(base, root), /only add tests/);
  write('tests/existing.test.ts', 'test();\n');
  write('package.json', '{}\n');
  assert.throws(() => exportCandidate(base, root), /protected path/);
});

test('export rejects invalid UTF-8 bytes and oversized files', (t) => {
  const { root, write, base } = fixture(t);
  write('README.md', Buffer.from([0xc3, 0x28]));
  assert.throws(() => exportCandidate(base, root), /UTF-8 text/);
  write('README.md', 'a'.repeat(MAX_CANDIDATE_BYTES + 1));
  assert.throws(() => exportCandidate(base, root), /UTF-8 bytes/);
});

test('export rejects symbolic links and directory junctions', (t) => {
  const { root, base } = fixture(t);
  const outside = mkdtempSync(path.join(tmpdir(), 'linky-candidate-'));
  t.after(() => {
    assert.ok(path.resolve(outside).startsWith(path.join(path.resolve(tmpdir()), 'linky-candidate-')));
    rmSync(outside, { recursive: true, force: true });
  });
  writeFileSync(path.join(outside, 'example.ts'), 'must not be exported');
  const link = path.join(root, 'src/linked.ts');
  symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => exportCandidate(base, root), /symbolic link/);
  assert.equal(readFileSync(path.join(outside, 'example.ts'), 'utf8'), 'must not be exported');
});

test('export rejects hard links', (t) => {
  const { root, base } = fixture(t);
  linkSync(path.join(root, 'README.md'), path.join(root, 'src/linked.ts'));
  assert.throws(() => exportCandidate(base, root), /without hard links/);
});

test('export ignores inherited Git index and worktree overrides', (t) => {
  const { root, write, base } = fixture(t);
  write('README.md', '# Changed\n');
  const keys = ['GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_DIR'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = path.join(root, 'nonexistent');
    assert.deepEqual(exportCandidate(base, root), candidate('README.md', '# Changed\n'));
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test('export disables external diff and fsmonitor commands from repository config', (t) => {
  const { root, git, write, base } = fixture(t);
  git('config', 'diff.external', 'command-that-must-not-run');
  git('config', 'core.fsmonitor', 'command-that-must-not-run');
  write('README.md', '# Changed\n');
  assert.deepEqual(exportCandidate(base, root), candidate('README.md', '# Changed\n'));
});

test('baseline rejects options, abbreviated hashes and revision expressions', (t) => {
  const { root } = fixture(t);
  for (const base of ['HEAD', 'abcdef0', '--help', 'HEAD~1', 'a'.repeat(40) + '; echo bad', null]) {
    assert.throws(() => exportCandidate(base, root), /full Git commit SHA/);
  }
});

test('CLI writes only JSON to stdout and returns nonzero for a rejected candidate', (t) => {
  const { root, write, base } = fixture(t);
  const script = fileURLToPath(new URL('../ops/prompt-candidate.mjs', import.meta.url));
  write('README.md', '# Changed\n');
  const result = spawnSync(process.execPath, [script, 'export', base], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), candidate('README.md', '# Changed\n'));
  assert.equal(result.stderr, '');
  write('src/config.ts', 'protected\n');
  const denied = spawnSync(process.execPath, [script, 'export', base], { cwd: root, encoding: 'utf8' });
  assert.equal(denied.status, 1);
  assert.equal(denied.stdout, '');
  assert.match(denied.stderr, /protected path/);
});
