import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { devNull } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX_CANDIDATE_FILES = 30;
export const MAX_CANDIDATE_BYTES = 200_000;

const protectedSource = new Set([
  'src/bot.ts',
  'src/index.ts',
  'src/config.ts',
  'src/commands/prompt.ts',
  'src/commands/register.ts',
  'src/services/linkconfiguration.ts',
  'src/services/boundedjson.ts',
  'src/services/promptservice.ts',
]);

function objectWithKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function validatePath(filePath) {
  if (typeof filePath !== 'string' || filePath.length > 240
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(filePath)
    || filePath.split('/').some((part) => part.endsWith('.')
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('Candidate contains an unsafe file path.');
  }
  const lower = filePath.toLowerCase();
  const source = /^src\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.ts$/.test(filePath)
    && !protectedSource.has(lower);
  const test = /^tests\/[A-Za-z0-9][A-Za-z0-9._-]*\.test\.ts$/.test(filePath);
  const documentation = /^docs\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(filePath)
    && !lower.startsWith('docs/discord-prompt');
  if (!(source || test || documentation || filePath === 'README.md')) {
    throw new Error(`Candidate cannot change protected path: ${filePath}`);
  }
  return { lower, test };
}

/** Validate again in the trusted publisher, using its own baseline file list. */
export function validateCandidate(candidate, baselineFiles) {
  if (!objectWithKeys(candidate, ['files']) || !Array.isArray(candidate.files)) {
    throw new Error('Candidate must contain a files array.');
  }
  if (candidate.files.length === 0) throw new Error('Candidate contains no changes.');
  if (candidate.files.length > MAX_CANDIDATE_FILES) {
    throw new Error(`Candidate exceeds ${MAX_CANDIDATE_FILES} files.`);
  }
  if (baselineFiles !== undefined && !(baselineFiles instanceof Set)) {
    throw new Error('Baseline files must be a trusted Set.');
  }
  const baseline = baselineFiles && new Set([...baselineFiles].map((name) => name.toLowerCase()));
  const seen = new Set();
  let totalBytes = 0;
  const files = Array.from(candidate.files, (file) => {
    if (!objectWithKeys(file, ['path', 'content'])) {
      throw new Error('Each candidate file must contain only path and content.');
    }
    const { lower, test } = validatePath(file.path);
    if (seen.has(lower)) throw new Error(`Candidate repeats a file path: ${file.path}`);
    seen.add(lower);
    if (test && (!baseline || baseline.has(lower) || file.content === null)) {
      throw new Error('Candidate may only add tests absent from the trusted baseline.');
    }
    if (file.content !== null) {
      if (typeof file.content !== 'string'
        || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(file.content)
        || Buffer.from(file.content, 'utf8').toString('utf8') !== file.content) {
        throw new Error(`Candidate content must be UTF-8 text: ${file.path}`);
      }
      totalBytes += Buffer.byteLength(file.content, 'utf8');
      if (totalBytes > MAX_CANDIDATE_BYTES) {
        throw new Error(`Candidate exceeds ${MAX_CANDIDATE_BYTES} UTF-8 bytes.`);
      }
    }
    return { path: file.path, content: file.content };
  });
  return { files };
}

function git(root, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const nullFile = process.platform === 'win32' ? 'NUL' : devNull;
  return execFileSync('git', [
    '--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${nullFile}`,
    '-c', `core.worktree=${root}`, ...args,
  ], {
    cwd: root, encoding: 'utf8', timeout: 15_000, maxBuffer: 1_000_000,
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: nullFile, GIT_OPTIONAL_LOCKS: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function nulList(value) {
  if (value === '') return [];
  if (!value.endsWith('\0')) throw new Error('Git returned an incomplete file list.');
  return value.slice(0, -1).split('\0');
}

function readText(root, filePath, deleted) {
  const parts = filePath.split('/');
  for (let index = 1; index <= parts.length; index++) {
    let stat;
    try {
      stat = lstatSync(path.join(root, ...parts.slice(0, index)));
    } catch (error) {
      if (deleted && error.code === 'ENOENT') return null;
      throw error;
    }
    if (stat.isSymbolicLink() || (index < parts.length && !stat.isDirectory())) {
      throw new Error(`Candidate cannot read a symbolic link or non-directory: ${filePath}`);
    }
    if (index === parts.length && (!stat.isFile() || stat.nlink > 1)) {
      throw new Error(`Candidate must be a regular file without hard links: ${filePath}`);
    }
    if (index === parts.length && stat.size > MAX_CANDIDATE_BYTES) {
      throw new Error(`Candidate exceeds ${MAX_CANDIDATE_BYTES} UTF-8 bytes.`);
    }
  }
  if (deleted) throw new Error(`Deleted candidate still exists: ${filePath}`);
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      .decode(readFileSync(path.join(root, ...parts)));
  } catch (error) {
    if (error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') {
      throw new Error(`Candidate content must be UTF-8 text: ${filePath}`);
    }
    throw error;
  }
}

/** Export is untrusted input: the publisher must validate against a fresh checkout. */
export function exportCandidate(base, cwd = process.cwd()) {
  if (typeof base !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(base)) {
    throw new Error('Candidate baseline must be a full Git commit SHA.');
  }
  const root = realpathSync(cwd);
  git(root, ['rev-parse', '--verify', `${base}^{commit}`]);
  const baseline = new Set(nulList(git(root, ['ls-tree', '-r', '--name-only', '-z', base, '--'])));
  const diff = nulList(git(root, [
    'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', base, '--',
  ]));
  if (diff.length % 2 !== 0) throw new Error('Git returned an invalid change list.');
  const changes = [];
  for (let index = 0; index < diff.length; index += 2) {
    if (!['A', 'M', 'D'].includes(diff[index])) throw new Error('Candidate contains an unsupported file change.');
    changes.push({ path: diff[index + 1], deleted: diff[index] === 'D' });
  }
  for (const filePath of nulList(git(root, ['ls-files', '--others', '--exclude-standard', '-z']))) {
    changes.push({ path: filePath, deleted: false });
  }
  if (changes.length > MAX_CANDIDATE_FILES) throw new Error(`Candidate exceeds ${MAX_CANDIDATE_FILES} files.`);
  const files = changes.map((file) => {
    validatePath(file.path);
    return { path: file.path, content: readText(root, file.path, file.deleted) };
  });
  return validateCandidate({ files }, baseline);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] !== 'export' || process.argv.length !== 4) {
      throw new Error('Usage: node ops/prompt-candidate.mjs export COMMIT_SHA');
    }
    process.stdout.write(`${JSON.stringify(exportCandidate(process.argv[3]))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
