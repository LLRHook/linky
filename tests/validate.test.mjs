import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const CHECKS = [...read('tools/validate/src/lib.rs').match(/pub const CHECKS:[\s\S]*?= &\[([\s\S]*?)\];/)[1]
  .matchAll(/^\s*"([^"]+)",\s*$/gm)].map(match => match[1]);

test('validate runs exactly the single-line CI commands that need no Docker or install', () => {
  const ci = [...read('.github/workflows/ci.yml').matchAll(/^\s+run:\s+([^|>\s].*?)\s*$/gm)].map(match => match[1])
    .filter(command => command !== 'npm ci' && !command.startsWith('docker ') && !command.startsWith('rustup '));
  assert.deepEqual([...CHECKS].sort(), [...new Set(ci)].sort());
});

test('Rust validator retains the original gates and Node validator is fully replaced', () => {
  assert.deepEqual(CHECKS.slice(0, 5), ['npm run build', 'npm run check:workers', 'npm test',
    'bash tests/deploy.test.sh', 'npm audit --audit-level=low']);
  assert.equal(CHECKS.length, 8);
  assert.throws(() => read('ops/validate.mjs'), { code: 'ENOENT' });
  assert.match(read('rust-toolchain.toml'), /^channel = "1\.93\.1"$/m);
  assert.match(read('.github/workflows/ci.yml'), /rustup toolchain install 1\.93\.1 /);
});

test('the primary Node version matches the production image and CI matrix', () => {
  const primary = read('.nvmrc').trim();
  assert.match(primary, /^\d+$/);
  for (const line of read('Dockerfile').split(/\r?\n/).filter(line => line.startsWith('FROM node:'))) {
    assert.ok(line.startsWith(`FROM node:${primary}-`), line);
  }
  assert.match(read('.github/workflows/ci.yml'), new RegExp(`node: \\[[^\\]]*'${primary}'`));
});

test('the opt-in pre-push hook runs validate', () => {
  const hook = read('.githooks/pre-push');
  assert.match(hook, /^#!\/bin\/sh\r?\n/);
  assert.match(hook, /^exec npm run validate$/m);
  assert.equal(JSON.parse(read('package.json')).scripts.validate,
    'cargo run --quiet --locked --manifest-path tools/validate/Cargo.toml --');
});
