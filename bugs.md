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

### [BUG-1791399501] Archive timeout test intermittently fails during temporary-directory cleanup
- [x] **Severity:** low
- **Area:** tests
- **File(s):** tests/delivery-archive.test.ts
- **Observation:** On 2026-10-07, a full `npm test` run failed `close has a finite wait and stalled persistence never throws from record or traces` with `ENOTEMPTY` while removing its temporary archive directory. The other 1,191 TypeScript tests passed, and the unchanged archive suite passed all 13 tests when rerun alone. A subsequent full run passed all 1,192 TypeScript tests and 54 script tests (eight environment-dependent skips).
- **Expected:** The fixture's cleanup reliably completes after pending archive writes on Windows, including during a full concurrent suite run.
- **Repro / Notes:** `npm test` on Windows; isolate with `npx --no-install tsx --test tests/delivery-archive.test.ts`. The fixture removes its directory after `archive.close()`, and the affected test configures a 10 ms close timeout. Investigate pending writes at teardown; the production root cause is not established by this cleanup failure.
- **Bump:** patch
- **Status:** fixed-pending-migration
- **Fix:** Finish persistence after the deadline-limited close before removing fixture and restarted archive directories, and release the stalled writer even if an assertion fails. The same ENOTEMPTY failure was confirmed in PR #70 Linux Node 22 CI. Focused archive tests and repeated full Windows/Linux suites pass.

### [BUG-1790322965] Both Instagram providers fail: instagram7.com no longer resolves and OGInstagram returns 403
- [x] **Severity:** high
- **Area:** providers, previews
- **File(s):** src/services/SocialProviders.ts, src/services/InstagramTranslation.ts, src/services/InstagramPresentation.ts, ops/preview-corpus.json
- **Observation:** `npm run check:providers` at SHA 4ae273d (2026-09-25) exits 1: `FAIL instagram expect=video https://www.instagram.com/reel/DdFKS1ABmK4/` with `instagram7: fetch_failed` and `oginstagram: http 403`. `dig @1.1.1.1 instagram7.com SOA` returns `status: NXDOMAIN` (same via 8.8.8.8), so the primary provider domain is gone for every resolver, bot host included. `curl -A 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' https://oginstagram.com/reel/DdFKS1ABmK4/` also returns 403. Instagram caption translation calls `https://www.instagram7.com/api/` and fails as well.
- **Expected:** At least one catalogued Instagram provider returns a satisfying preview for the corpus Reel, and caption translation has a reachable metadata source.
- **Repro / Notes:** `npm run build && npm run check:providers`. Every other platform in the corpus passed in the same run. Replace mode keeps the source when no preview is confirmed, so posts are not lost, but Instagram links will show the retry notice instead of a preview. Next step: confirm from the bot host and the delivery archive (`docker exec linky node ops/delivery-archive-report.mjs --days 1`), then evaluate a replacement provider (vetted per `docs/provider-checks.md`) and drop or demote instagram7.
- **Bump:** patch
- **Status:** fixed-pending-migration
- **Fix:** BUG-1791399021 migrated the primary to fkinstagram.com. The October 12 provider corpus confirms its Reel video metadata; caption/presentation regressions pass. The sampled OGInstagram HTTP 403 remains an independent upstream observation, with the primary delivering the required preview.

### [BUG-1790322966] VERIFICATION.md step 1.4 secret-file check matches the source file LinkTokens.ts
- [x] **Severity:** low
- **Area:** docs, tests
- **File(s):** VERIFICATION.md
- **Observation:** Step 1.4 expects `git ls-files | grep -iE '\.env$|token|secret|\.pem$'` to print nothing, but it prints `src/services/LinkTokens.ts` (an ordinary source module) on every run, so the step can never pass as written.
- **Expected:** The check flags only tracked env, key and credential files, not source or test modules whose names contain "token".
- **Repro / Notes:** Run the step 1.4 command at 4ae273d.
- **Bump:** patch
- **Status:** fixed-pending-migration
- **Fix:** Step 1.4 now excludes `src/` and `tests/` TypeScript/ESM modules from the name match.

### [BUG-1790785731] Two-factor-protected deletion reports a delivery failure after a useful preview
- [x] **Severity:** med
- **Area:** bot, previews, commands
- **File(s):** src/services/SocialLinkService.ts, src/commands/diagnose.ts, tests/social-links.test.ts, tests/diagnose-command.test.ts
- **Observation:** A sanitized 2026-09-30 inspection found a useful preview logged before an automatic-delivery failure with Discord HTTP 403/code 60003. This code means two-factor authentication is required. The catch labels the attempt discord-failure and the final control edit occurs only after original deletion succeeds, so this condition can leave a useful output without its final Remove/Details controls.
- **Expected:** A server moderation/authentication restriction is distinguished from a provider preview failure, originals remain safe, and administrators receive actionable diagnostics.
- **Repro / Notes:** Simulate an original-message delete throwing code 60003 after preview confirmation. Check original/replacement state, durable ownership, final controls and diagnostic classification. The live observation is one current-container failure; it does not establish the cause of older failures or the exact failing Discord request. [Discord.js error enum](https://discord.js.org/docs/packages/discord.js/main/RESTJSONErrorCodes%3AEnum) documents the code.
- **Bump:** patch
- **Status:** fixed-pending-migration
- **Fix:** Atomically downgrade identical replace ownership to reply after Discord refuses source deletion with 60003 or 50013, retain the verified preview with final controls, and report a permission outcome. Details includes server security restrictions and /diagnose flags elevated moderator 2FA requirements in Replace mode.

---

### [BUG-1791830086] TikTok share previews lack an exact post identity and a cold-media wait
- [x] **Severity:** high
- **Area:** providers, previews, tests
- **File(s):** src/services/MobileShareLinks.ts, src/services/PreviewRecovery.ts, src/services/PreviewWatcher.ts, ops/provider-metadata-check.mjs, tests/mobile-share-links.test.ts, tests/preview-recovery.test.ts, tests/preview-watcher.test.ts, tests/delivery-recovery.test.ts, tests/manual-fix.test.ts, tests/provider-metadata-check.test.mjs
- **Observation:** The reported `https://www.tiktok.com/t/ZPLBWgdad/` resolves by HTTP 301 to video `7695457160653851935`. Linky sends the unresolved share to the provider and accepts any canonical TikTok post embed for that share, so two short links can both be confirmed by one unrelated video. TikTok also retains the four-second Gateway window despite depending on cold redirect/media preparation. The October 12 GAMBA control successfully rendered and played after provider warm-up; this does not identify the historical failure's exact timing.
- **Expected:** Resolve public TikTok shares within the existing bounded first-party resolver, verify the resolved post ID, and accept matching cold media through the bounded eight-second Gateway window. Unsafe/unavailable destinations must not permit source deletion based on an unrelated post.
- **Repro / Notes:** Add an offline two-share wrong-post regression and a 7.5-second delayed TikTok Gateway update. Live first-party resolution initially rejected the reported share with `HPE_HEADER_OVERFLOW`: its HTTP 301 response contained 8,212 header bytes, beyond the resolver's 8 KiB limit. A bounded 16 KiB TikTok-only header cap resolves the exact post. The share and canonical URL return video metadata; Discord Chrome playback advances at 1280x720. Verify again after deployment.
- **Bump:** patch
- **Status:** fixed-pending-migration
- **Fix:** Resolve TikTok shares to their exact public post through the bounded first-party resolver, with a 16 KiB TikTok header limit. Require exact preview identities and extend only the TikTok Gateway window to eight seconds. Automatic/manual, wrong-post, capacity/deadline, suppression and delayed-update regressions pass. The reported share resolves live and its Discord video plays at 1280x720.

### [BUG-1791830959] npm test requires a pre-existing build and can exercise stale provider code
- [x] **Severity:** med
- **Area:** tests, ci
- **File(s):** package.json, tests/provider-metadata-check.test.mjs
- **Observation:** After `npm ci` in a fresh Linux Node 22 checkout with no `dist/`, `npm test` passed the TypeScript tests but failed with `ERR_MODULE_NOT_FOUND` for `dist/services/SocialProviders.js`. The ESM provider tests import production build output, while the test TypeScript configuration uses `noEmit`. An existing `dist/` can also leave those tests inspecting an older source revision.
- **Expected:** `npm test` builds the current production code before running either test layer, so a fresh checkout and a changed source revision exercise the same implementation.
- **Repro / Notes:** `npm ci` then `npm test` in a fresh checkout before `npm run build`; keep `dist/` absent. The existing provider tests prove whether the build output is present and correct.
- **Bump:** patch
- **Status:** fixed-pending-migration
- **Fix:** Build the current production TypeScript as the first step of npm test, before test type-checking and both runners. A fresh-checkout reproduction failed before the fix; the full suite now passes and ESM provider tests use current compiled code.

### [BUG-1791831056] Operations documentation still names old runtime and state paths
- [ ] **Severity:** low
- **Area:** docs
- **File(s):** docs/self-hosting.md, VERIFICATION.md
- **Observation:** The October 12 branch documentation review found pre-existing claims that the container uses Node 24 and stores delivery-archive/ and repost-registry.json. Dockerfile selects Node 26; src/bot.ts derives delivery-logs and reposts.json. The operator guide already agrees with the current archive path.
- **Expected:** Current operational instructions identify the actual runtime and state paths; dated historical evidence remains unchanged.
- **Repro / Notes:** Compare Dockerfile FROM lines, src/bot.ts archive/registry initialization, docs/self-hosting.md container description, and VERIFICATION.md Appendix A. Reported by docs-sync as pre-existing drift; not caused by the TikTok change.
- **Bump:** patch
- **Status:** open

### [BUG-1791837720] Confirmed social previews lose Remove and Details controls in live Discord
- [ ] **Severity:** med
- **Area:** previews, ownership
- **File(s):** src/services/SocialLinkService.ts, src/services/RepostRegistry.ts, tests/social-links.test.ts, tests/repost-sync.test.ts, tests/delivery-recovery.test.ts
- **Observation:** Fresh-stack GAMBA TikTok, Bluesky and Reddit previews were confirmed and their sources safely deleted, but the resulting Discord messages retained only Original post. The canonical reported TikTok initially displayed Remove and Details, then lost both within seconds. A Bot REST GET confirms this server state; the durable ownership records still exist. X and Instagram controls remain present.
- **Expected:** A confirmed automatic preview retains the original sharer's Remove action and its delivery Details while its ownership record is valid.
- **Repro / Notes:** Owned examples: TikTok 1559302634077425725 (canonical), 1559302873437962383 (Retry reply), 1559304300969070615 and 1559304343214231662 (corpus); Bluesky 1559304532083736667; Reddit 1559304570570670212. .vv/discord-fixtures.json, .vv/gui-evidence.json and Hostinger registry/log evidence show the mismatch. No product root cause has been assumed.
- **Investigation:** Batch A reproduced Original-only controls on Reddit 1559369650746429450 in both the GUI and channel-list REST response. A later Reddit delivery retained all controls in single-message and channel-list REST checks; bound private Details and owner Remove worked. TikTok and a three-minute Bluesky replay also retained controls. Controlled REST probes and the actual Discord.js publication handler without a Gateway connection retained controls. The failure is intermittent; its writer remains unproven. Component fixtures now preserve serialized server state and model cloned edit/fetch results, but this characterization is not a product fix.
- **Acceptance criteria:** Confirmed automatic and Retry previews retain Original post, owner-only Remove and correctly bound Details after delayed updates; unrelated controls, source-deletion ordering and cleanup remain correct.
- **Test plan:** Reproduce component-state loss with faithful send/edit/cache and delayed-event behavior; exercise Replace, Reply, Retry, ownership reload, non-owner actions and cancellation against the captured lifecycle.
- **Bump:** patch
- **Status:** in-progress

### [BUG-1791838422] vxTwitter error card is accepted as a useful post preview
- [ ] **Severity:** high
- **Area:** previews, source-safety
- **File(s):** src/services/PreviewRecovery.ts, tests/preview-recovery.test.ts, tests/preview-watcher.test.ts, tests/delivery-recovery.test.ts, tests/manual-fix.test.ts
- **Observation:** Retrying the current unavailable X fixture produced a vxTwitter / fixvx card whose description begins "Failed to scan your link!" and returned a confirmed preview. A read-only invocation of the committed inspectPreviews matcher against the actual Discord embed returns ok:true with no missing expectation.
- **Expected:** A provider's unavailable/error card cannot satisfy useful post delivery or permit source deletion.
- **Repro / Notes:** Owned source 1559305894511116288, retry response 1559306040581816402. .vv/live-fixture-analysis.json captures the real embed and current matcher result. Retry kept the source because it forces Reply; the automatic Replace path shares this matcher and remains at risk. No source loss was observed in this fixture.
- **Root cause:** The known-error expressions omit the branded vxTwitter service-error signature, allowing its matching URL, title and description to satisfy a text-post preview.
- **Implementation progress:** Added a narrow branded scan-error rejection before media checks and regression coverage for aliases, logos/video, legitimate quoted text, Gateway/REST observations, automatic Replace/Retry and manual commands. The live REST-backed SDK probe rejected both unavailable providers, retained its source and exposed an owned recovery notice. Integrated sign-off and verification through the normal deployed bot remain pending.
- **Acceptance criteria:** Recognizable provider service-error cards remain missing and receive no success attribution; automatic failure preserves the source and owned recovery controls; legitimate post/media and useful bounded fallback still pass.
- **Test plan:** Regress the captured error signature and media/logo variants, legitimate-post positive controls, Gateway/REST rejection, automatic Replace/Retry source safety and explicit manual fixing.
- **Bump:** patch
- **Status:** in-progress

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
