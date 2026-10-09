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

### [BUG-1790722056] Reddit app shares silently remain unchanged when Reddit blocks redirect resolution
- [x] **Severity:** med
- **Area:** providers, previews
- **File(s):** src/services/MobileShareLinks.ts, tests/mobile-share-links.test.ts, tests/delivery-recovery.test.ts, tests/manual-fix.test.ts
- **Observation:** The reported public Reddit app share was recognized, but Hostinger received HTTP 403 without a canonical redirect. Automatic fixing then had no supported post URL to publish. The same post's vxReddit video worked directly in GAMBA.
- **Expected:** Resolve supported public app shares when a vetted redirect service can supply the canonical post, verify its preview, and retain the source if resolution or delivery fails.
- **Repro / Notes:** A real Hostinger invocation of createMobileShareLinkNormalizer returned normalized=false and HTTP 403 for the reported share. Regression fixtures cover blocked first-party lookup, allowed fallback, malformed redirects, DNS, deadlines, body cancellation, automatic delivery and manual commands.
- **Bump:** patch
- **Status:** fixed-pending-migration
- **Fix:** Use one vetted FixReddit redirect fallback within the existing network budgets, then verify the canonical vxReddit preview. The reported share automatically replaced in GAMBA in 2.411 seconds and played to completion in Chrome Discord; an unavailable-share control retained its source. Regression, build, worker, dependency-audit and deploy-safeguard checks passed.

### [BUG-1791399021] Instagram previews and caption lookups use an unavailable provider domain
- [x] **Severity:** high
- **Area:** providers, previews
- **File(s):** src/services/SocialProviders.ts, src/services/InstagramTranslation.ts, src/services/InstagramPresentation.ts, tests/social-providers.test.ts, tests/instagram-translation.test.ts, tests/instagram-presentation.test.ts
- **Observation:** On 2026-10-07, the configured primary's `instagram7.com`, `www.instagram7.com` and `g.instagram7.com` hosts returned DNS `ENOTFOUND`; Google and Cloudflare public DNS also returned NXDOMAIN. Both normal previews and caption lookup/gallery URLs use that domain. The reported Instagram post reached the unconfirmed-preview notice.
- **Expected:** Normal, translated and Media-first Instagram previews use the reachable primary service, retain bounded OGInstagram recovery and keep the original when no matching media arrives.
- **Repro / Notes:** `npm run check:providers -- https://www.instagram.com/p/DeIfsDPo0zx/`; upstream outage report: https://github.com/Bl0ck154/InstaFix-Revived/issues/3. The same service at https://fkinstagram.com/ returned matching image metadata and downloadable JPEG bytes for this post, caption-free gallery metadata, Reel video metadata and the existing caption API shape. These are provider observations, not live Discord rendering or playback verification.
- **Bump:** patch
- **Status:** fixed-pending-migration
- **Fix:** Shared primary provider configuration now uses `fkinstagram.com` for normal previews and caption lookup, and `g.fkinstagram.com` for translated and Media-first galleries. Legacy URLs remain recognizable; OGInstagram remains the bounded alternate. Migration, host validation, captions, fallback and source-preservation tests pass; build and worker checks pass. The full suite passed on rerun (1,192 TypeScript tests and 54 script tests, with eight environment-dependent skips).
- **Production evidence:** Read-only inspection on October 8 matched the screenshot to the unchanged source link `https://www.instagram.com/p/DeIfsDPo0zx/`, posted October 7 at 18:37:57 UTC. Attempt `843953d7-bf36-4458-9e2e-c37b44e881f6` ended `metadata-unconfirmed` after 17,101 ms; its two preview stages were unavailable after 8,149 ms and 8,147 ms. The final operational log at 18:38:14.635 UTC named `oginstagram`. A current Hostinger probe still returned `ENOTFOUND` for Instagram7; OGInstagram and both replacement routes now returned matching image metadata and downloadable JPEG bytes. Historical failed confirmation does not establish a continuing OGInstagram outage.

### [BUG-1791399500] Dependency audit fails for development-only fast-copy
- [x] **Severity:** med
- **Area:** security, ci
- **File(s):** package-lock.json
- **Observation:** On 2026-10-07, `npm audit --audit-level=low` failed on the existing `fast-copy@4.0.2` dependency of development-only `pino-pretty@13.1.3`. Advisory GHSA-jggr-w7fw-pc2j rates deeply nested input causing stack exhaustion as moderate. The Instagram provider fix does not change dependencies.
- **Expected:** The CI dependency audit passes with a reviewed, non-vulnerable transitive dependency version.
- **Repro / Notes:** `npm audit --audit-level=low`; `npm explain fast-copy`. Advisory: https://github.com/advisories/GHSA-jggr-w7fw-pc2j. The audit reports a fix is available; update and validate separately from the preview-provider change.
- **Bump:** patch
- **Status:** fixed-pending-migration
- **Fix:** Update only the transitive `fast-copy` lockfile entry from 4.0.2 to the latest stable 4.1.2 after checking the upstream advisory and depth-limit documentation. No dependency ranges or production packages change. `npm audit --audit-level=low` reports zero vulnerabilities; build, worker checks, 1,197 TypeScript tests, 54 script tests (eight environment-dependent skips) and deployment safeguards pass.

### [BUG-1791399501] Archive timeout test intermittently fails during Windows temporary-directory cleanup
- [ ] **Severity:** low
- **Area:** tests
- **File(s):** tests/delivery-archive.test.ts
- **Observation:** On 2026-10-07, a full `npm test` run failed `close has a finite wait and stalled persistence never throws from record or traces` with `ENOTEMPTY` while removing its temporary archive directory. The other 1,191 TypeScript tests passed, and the unchanged archive suite passed all 13 tests when rerun alone. A subsequent full run passed all 1,192 TypeScript tests and 54 script tests (eight environment-dependent skips).
- **Expected:** The fixture's cleanup reliably completes after pending archive writes on Windows, including during a full concurrent suite run.
- **Repro / Notes:** `npm test` on Windows; isolate with `npx --no-install tsx --test tests/delivery-archive.test.ts`. The fixture removes its directory after `archive.close()`, and the affected test configures a 10 ms close timeout. Investigate pending writes at teardown; the production root cause is not established by this cleanup failure.
- **Bump:** patch
- **Status:** open

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
