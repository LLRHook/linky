import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Pull-request evidence gate: every PR body carries the acceptance evidence that VERIFICATION 2.3 later relies on.
 * Template guidance lives in HTML comments, so a section holding only the template is reported as empty.
 */
export const REQUIRED_SECTIONS = ['Tickets', 'Acceptance evidence', 'Mutation checks', 'Docs checked', 'Remaining gaps'];
const MAX_EVENT_BYTES = 1_000_000;

const normalize = title => title.trim().toLowerCase().replace(/\s+/g, ' ');

/** Section bodies keyed by normalized `##` heading; a repeated heading keeps its first body. */
export function sections(body) {
  const found = new Map();
  let current;
  for (const line of String(body ?? '').replace(/<!--[\s\S]*?(?:-->|$)/g, '').split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      current = normalize(heading[1]);
      if (found.has(current)) current = undefined;
      else found.set(current, []);
    } else if (current) found.get(current).push(line);
  }
  return found;
}

/** Content lines that are not blank and not only Markdown table framing. */
const substantive = lines => lines.filter(line => /[^\s|:-]/.test(line));

/** Required sections that are missing or contain nothing beyond template guidance. */
export function missingEvidence(body) {
  const found = sections(body);
  return REQUIRED_SECTIONS.filter(title => !substantive(found.get(normalize(title)) ?? []).length);
}

/** Check the pull_request event payload; any other event has no PR body and is not gated here. */
export function checkEvent(event) {
  const pr = event?.pull_request;
  if (!pr) return { ok: true, missing: [], skipped: true };
  const missing = missingEvidence(pr.body);
  return { ok: missing.length === 0, missing, skipped: false };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const path = process.argv[2] ?? process.env.GITHUB_EVENT_PATH;
  if (!path || statSync(path).size > MAX_EVENT_BYTES) throw new Error('Pull-request event payload is unavailable or too large');
  const result = checkEvent(JSON.parse(readFileSync(path, 'utf8')));
  if (result.skipped) console.log('No pull request in this event; nothing to check.');
  else if (result.ok) console.log(`PR evidence present: ${REQUIRED_SECTIONS.join(', ')}.`);
  else {
    for (const title of result.missing) console.error(`::error title=PR evidence::Section "## ${title}" is missing or empty. Fill it in the PR description (see .github/pull_request_template.md).`);
    process.exitCode = 1;
  }
}
