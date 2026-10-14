import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { REQUIRED_CHECKS } from '../ops/prompt-workflow.mjs';

/** Read top-level jobs from a workflow without a YAML dependency: id, display name, needs and if. */
export function workflowJobs(text) {
  const body = text.slice(text.indexOf('\njobs:\n') + 7);
  const jobs = new Map();
  let current;
  for (const line of body.split(/\r?\n/)) {
    const job = /^ {2}([A-Za-z][\w-]*):\s*$/.exec(line);
    if (job) {
      current = { id: job[1], name: job[1], needs: [], if: undefined };
      jobs.set(job[1], current);
      continue;
    }
    const field = /^ {4}(name|needs|if):\s*(.+?)\s*$/.exec(line);
    if (!current || !field) continue;
    if (field[1] === 'needs') current.needs = field[2].replace(/^\[|\]$/g, '').split(',').map(value => value.trim()).filter(Boolean);
    else current[field[1]] = field[2];
  }
  return jobs;
}

const ci = workflowJobs(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
const gate = [...ci.values()].find(job => job.name === 'CI gate');

test('CI gate waits for every other CI job and runs even after a failure', () => {
  assert.ok(gate, 'ci.yml has a job named "CI gate"');
  assert.equal(gate.if, 'always()');
  assert.deepEqual([...gate.needs].sort(), [...ci.keys()].filter(id => id !== gate.id).sort());
});

test('dependency audit runs apart from the functional and container jobs', () => {
  const audit = [...ci.values()].find(job => job.name === 'Dependency audit');
  assert.ok(audit, 'ci.yml has a job named "Dependency audit"');
  const text = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.equal(text.match(/npm audit --audit-level=low/g)?.length, 1);
  assert.deepEqual(audit.needs, []);
});

test('the Discord prompt publisher waits only for checks that CI workflows define', () => {
  const names = new Set([...ci.values()].map(job => job.name));
  for (const check of REQUIRED_CHECKS) assert.ok(names.has(check), `no workflow job is named "${check}"`);
});

test('workflow job reader understands needs lists and display names', () => {
  const jobs = workflowJobs('on: push\njobs:\n  a:\n    name: First\n    steps: []\n  b:\n    if: always()\n    needs: [a, c]\n');
  assert.deepEqual([...jobs.values()], [
    { id: 'a', name: 'First', needs: [], if: undefined },
    { id: 'b', name: 'b', needs: ['a', 'c'], if: 'always()' },
  ]);
});
