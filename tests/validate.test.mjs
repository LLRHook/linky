import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CHECKS, validate } from '../ops/validate.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('validate runs exactly the single-line CI commands that need no Docker or install', () => {
  const ci = [...read('.github/workflows/ci.yml').matchAll(/^\s+run:\s+([^|>\s].*?)\s*$/gm)].map(match => match[1])
    .filter(command => command !== 'npm ci' && !command.startsWith('docker '));
  assert.deepEqual([...CHECKS].sort(), [...new Set(ci)].sort());
});

test('a failing check does not stop later checks, and the summary lists every result', () => {
  const ran = [];
  const lines = [];
  const result = validate({ run: command => { ran.push(command); return command === 'npm test' ? 3 : 0; },
    log: line => lines.push(line), now: () => 0 });
  assert.deepEqual(ran, CHECKS);
  assert.equal(result.ok, false);
  const summary = lines.slice(lines.indexOf('\nValidation summary') + 1);
  for (const command of CHECKS) {
    assert.ok(summary.includes(`${command === 'npm test' ? 'FAIL' : 'PASS'}  ${command}  (0.0s${command === 'npm test' ? ', exit 3' : ''})`));
  }
  assert.equal(lines.at(-1), 'One or more checks failed.');
});

test('validate passes only when every check passes', () => {
  assert.equal(validate({ run: () => 0, log: () => {} }).ok, true);
  assert.equal(validate({ run: command => (command === CHECKS.at(-1) ? 1 : 0), log: () => {} }).ok, false);
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
  assert.equal(JSON.parse(read('package.json')).scripts.validate, 'node ops/validate.mjs');
});
