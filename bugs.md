# Linky — Bug Tracker

This file is the working list of known issues. New bugs are appended here as they
are found. When a bug is fixed, tick its checkbox and move the entry (with the fix
note) to `CHANGELOG.md` so this file stays focused on outstanding work.

## Conventions

Each entry uses the form:

```
### [<id>] <short title>
- [ ] **Severity:** crit | high | med | low
- **Area:** bot | commands | providers | previews | media | regional | archive | ops | ci | docs | tests | security
- **File(s):** comma-separated paths (or "n/a")
- **Observation:** what was seen, with line refs where useful.
- **Expected:** what should happen, citing the doc or spec section if relevant.
- **Repro / Notes:** how to confirm, or why it matters.
- **Bump:** major | minor | patch  (version impact when shipped; a bug fix defaults **patch**, a behaviour-breaking fix is **major** — `major` flags it for the user's planned major release; it does not auto-bump X, which only the user cuts at `/release`)
- **Status:** open | in-progress | fixed-pending-migration
```

Tick `- [x]` once verified fixed. The fixer also adds a `**Fix:**` line summarising
the change before migrating the entry to `CHANGELOG.md`.

Ids are UNIX-epoch timestamps (`BUG-$(date +%s)`), never sequential. Append new
entries at the end of `## Open`; change `Status:` in place; the only physical move
(`## Open` to `## Migrated to changelog`) happens at `/protocol-v-and-v` migration.

Severity guide:
- **crit** — blocks build, run, or a hard product constraint.
- **high** — data loss, crash, or a defining feature is wrong.
- **med** — a documented feature is missing or noticeably broken.
- **low** — UX polish, minor doc drift, or test-quality issue.

Area tags for this project: `bot` (Discord client, events, interactions), `commands`
(slash and context-menu commands, setup panel), `providers` (social provider
catalog, health ordering), `previews` (preview recovery, watcher, article cards),
`media` (Erome media, FFmpeg, media server), `regional` (Vercel regional workers),
`archive` (delivery diagnostics and operator archive), `ops` (deploy scripts,
container, reports), `ci`, `docs`, `tests`, `security`.

---

## Open

_The 2026-09-15 security audit findings in `SECURITY_AUDIT.md` were all resolved
in that maintenance branch and are not re-filed here._

### [BUG-1790270871] Deploy workflow intermittently fails with an SSH connect timeout to the bot host
- [ ] **Severity:** med
- **Area:** ops, ci
- **File(s):** .github/workflows/deploy.yml, docs/self-hosting.md
- **Observation:** Deploy runs for 94e34b2 (2026-09-18) and 8859ab5 (2026-09-24 17:30Z) both ended with `ssh: connect to host *** port 22: Connection timed out` and exit code 255, despite `ConnectTimeout=20` and `ConnectionAttempts=3`. The next push (d4d6e32) deployed successfully, so the host was only stale until another commit landed.
- **Expected:** A green CI run on `main` reaches the host, or the workflow retries connection establishment for longer before failing; a single merged fix should not sit undeployed until the next unrelated merge.
- **Repro / Notes:** `gh run list --branch main --workflow Deploy` and `gh run view <id> --log-failed`. Connection retry is safe because the remote `deploy` command is idempotent per SHA and refuses superseded revisions (`ops/deploy.sh`). Options: raise `ConnectionAttempts`, add a job-level retry of the SSH step only, or check whether the Hostinger firewall rate-limits GitHub runner ranges.
- **Bump:** patch
- **Status:** open

### [BUG-1790322965] Both Instagram providers fail: instagram7.com no longer resolves and OGInstagram returns 403
- [ ] **Severity:** high
- **Area:** providers, previews
- **File(s):** src/services/SocialProviders.ts, src/services/InstagramTranslation.ts, src/services/InstagramPresentation.ts, ops/preview-corpus.json
- **Observation:** `npm run check:providers` at SHA 4ae273d (2026-09-25) exits 1: `FAIL instagram expect=video https://www.instagram.com/reel/DdFKS1ABmK4/` with `instagram7: fetch_failed` and `oginstagram: http 403`. `dig @1.1.1.1 instagram7.com SOA` returns `status: NXDOMAIN` (same via 8.8.8.8), so the primary provider domain is gone for every resolver, bot host included. `curl -A 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' https://oginstagram.com/reel/DdFKS1ABmK4/` also returns 403. Instagram caption translation calls `https://www.instagram7.com/api/` and fails as well.
- **Expected:** At least one catalogued Instagram provider returns a satisfying preview for the corpus Reel, and caption translation has a reachable metadata source.
- **Repro / Notes:** `npm run build && npm run check:providers`. Every other platform in the corpus passed in the same run. Replace mode keeps the source when no preview is confirmed, so posts are not lost, but Instagram links will show the retry notice instead of a preview. Next step: confirm from the bot host and the delivery archive (`docker exec linky node ops/delivery-archive-report.mjs --days 1`), then evaluate a replacement provider (vetted per `docs/provider-checks.md`) and drop or demote instagram7.
- **Bump:** patch
- **Status:** open

### [BUG-1790322966] VERIFICATION.md step 1.4 secret-file check matches the source file LinkTokens.ts
- [ ] **Severity:** low
- **Area:** docs, tests
- **File(s):** VERIFICATION.md
- **Observation:** Step 1.4 expects `git ls-files | grep -iE '\.env$|token|secret|\.pem$'` to print nothing, but it prints `src/services/LinkTokens.ts` (an ordinary source module) on every run, so the step can never pass as written.
- **Expected:** The check flags only tracked env, key and credential files, not source or test modules whose names contain "token".
- **Repro / Notes:** Run the step 1.4 command at 4ae273d.
- **Bump:** patch
- **Status:** fixed-pending-migration
- **Fix:** Step 1.4 now excludes `src/` and `tests/` TypeScript/ESM modules from the name match.

---

## Migrated to changelog

Entries below have been ticked off and copied as a one-liner into `CHANGELOG.md`.
They are kept here so each `BUG-NNN` stays resolvable.

### [BUG-1790270870] Docs claim CI tests Node.js 22 and 24 only
- [x] **Severity:** low
- **Area:** docs, ci
- **File(s):** README.md, docs/self-hosting.md, SECURITY_AUDIT.md
- **Observation:** `README.md` line 105 and `docs/self-hosting.md` line 107 said "CI tests Node.js 22 and 24"; `.github/workflows/ci.yml` has run the matrix `['22', '24', '26']` since commit 9b64ad6 (PR #52). `SECURITY_AUDIT.md` line 7 said the repository has no `bugs.md` tracker, which stopped being true at this bootstrap.
- **Expected:** In-repo docs name the CI matrix the pipeline actually runs and point at the tracker that now exists.
- **Repro / Notes:** `grep -n "Node.js 22 and 24" README.md docs/self-hosting.md` before the fix; found by the `/protocol-v-and-v` bootstrap doc-drift audit on 2026-09-24.
- **Bump:** patch
- **Status:** fixed-pending-migration
- **Fix:** Both sentences now read "Node.js 22, 24 and 26"; `SECURITY_AUDIT.md` points at `bugs.md` for follow-up work.
