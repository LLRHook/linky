import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * Local counterpart of the CI jobs that need no Docker: the same commands, in one run, continuing after a
 * failure so every result is visible. The production container checks stay in CI and VERIFICATION 2.5.
 * tests/validate.test.mjs keeps this list equal to the single-line commands in .github/workflows/ci.yml.
 */
export const CHECKS = [
  'npm run build',
  'npm run check:workers',
  'npm test',
  'bash tests/deploy.test.sh',
  'npm audit --audit-level=low',
];

/** Fixed command strings only; the shell resolves npm/npm.cmd and bash on each platform. */
function runCommand(command) {
  const result = spawnSync(command, { shell: true, stdio: 'inherit' });
  return result.error ? 1 : result.status ?? 1;
}

export function validate({ run = runCommand, log = console.log, now = () => performance.now() } = {}) {
  const results = [];
  for (const command of CHECKS) {
    log(`\n> ${command}`);
    const started = now();
    const status = run(command);
    results.push({ command, status, seconds: (now() - started) / 1000 });
  }
  log('\nValidation summary');
  for (const { command, status, seconds } of results) {
    log(`${status === 0 ? 'PASS' : 'FAIL'}  ${command}  (${seconds.toFixed(1)}s${status === 0 ? '' : `, exit ${status}`})`);
  }
  log('Not run locally: production container checks (CI job "Production container", VERIFICATION 2.5).');
  const ok = results.every(({ status }) => status === 0);
  log(ok ? 'All checks passed.' : 'One or more checks failed.');
  return { ok, results };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (!validate().ok) process.exitCode = 1;
}
