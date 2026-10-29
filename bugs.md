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
- [x] **Severity:** low
- **Area:** docs
- **File(s):** docs/self-hosting.md, VERIFICATION.md
- **Observation:** The October 12 branch documentation review found pre-existing claims that the container uses Node 24 and stores delivery-archive/ and repost-registry.json. Dockerfile selects Node 26; src/bot.ts derives delivery-logs and reposts.json. The operator guide already agrees with the current archive path.
- **Expected:** Current operational instructions identify the actual runtime and state paths; dated historical evidence remains unchanged.
- **Repro / Notes:** Compare Dockerfile FROM lines, src/bot.ts archive/registry initialization, docs/self-hosting.md container description, and VERIFICATION.md Appendix A. Reported by docs-sync as pre-existing drift; not caused by the TikTok change.
- **Bump:** patch
- **Status:** fixed-pending-migration
- **Fix:** The approved documentation correction identifies Node.js 26, reposts.json and delivery-logs/, matching Dockerfile and src/bot.ts. The historical verification reports remain verbatim in their archive.

### [BUG-1791981980] Permission tests can pass because the repost handler swallows assertions raised in its callbacks
- [x] **Severity:** low
- **Area:** tests
- **File(s):** tests/social-links.test.ts, tests/delivery-recovery.test.ts
- **Observation:** On 2026-10-14, a mutation check during FEAT-1791981013 removed the Attach Files requirement for replace-mode attachments and `server scope still requires access, deletion and attachment permissions` still passed. Its `copyAttachment` callback calls `assert.fail`, but `createLinkRepostHandler` catches delivery errors and logs them, so the assertion never reaches the test runner; `f.events` stays empty for the wrong reason.
- **Expected:** Tests that mean "this callback must not run" count calls (or record a flag) and assert on that after the handler returns.
- **Repro / Notes:** In `src/services/SocialLinkService.ts`, pass `attachments: false` to `requiredRepostPermissions`, then run `npx tsx --test tests/social-links.test.ts`; the server-scope permission test still passes. The new replace-mode Attach Files test counts copies and fails on that mutant. Other `assert.fail` callbacks passed into the handler should be audited the same way.
- **Bump:** patch
- **Status:** fixed-pending-migration
- **Fix:** `tests/social-links.test.ts` replaces every callback `assert.fail` with a recorded `forbid` callback checked in `afterEach`. This exposed an article test whose permission case kept Administrator, so it never lacked Embed Links; it now removes both. A suite-wide probe of swallowed `assert.fail` calls found one more, in `tests/delivery-recovery.test.ts`, where the community-lookup case used `nolinky` instead of `!nolinky`; it now uses the real bypass and counts lookups. The probe reports no swallowed assertions. Removing the Attach Files or Embed Links requirement now fails the matching test.
- **Docs:** none needed (tests only).

### [BUG-1791986809] Operator docs and V&V checklist omit the Facebook platform
- [x] **Severity:** low
- **Area:** docs
- **File(s):** docs/self-hosting.md, .env.example, VERIFICATION.md
- **Observation:** The 2026-10-14 PR audit found that FEAT-1791951567 (PR #72) left `REWRITE_PLATFORMS` documented as `x,instagram,tiktok,youtube,bluesky,reddit,twitch,articles,erome` in `docs/self-hosting.md` and `.env.example`; the hosted-platform sentence at the top of `docs/self-hosting.md` also omits Facebook. `VERIFICATION.md` step 3.7 covers Bluesky, Reddit and Twitch corpus entries but not the new Facebook share.
- **Expected:** Operator references list `facebook` wherever they enumerate rewrite platforms, so an explicit list copied from the docs keeps Facebook; step 3.7 includes the Facebook share.
- **Repro / Notes:** `git grep -n "twitch,articles" -- docs .env.example`; compare with `REWRITE_PLATFORMS` in `src/services/LinkConfiguration.ts`.
- **Bump:** patch
- **Status:** fixed-pending-migration
- **Fix:** `.env.example` and `docs/self-hosting.md` now list `facebook` in `REWRITE_PLATFORMS`, the hosted-platform sentence names Facebook Reels and videos, and `VERIFICATION.md` step 3.7 includes the Facebook `/share/r/` corpus entry.
- **Docs:** `.env.example`, `docs/self-hosting.md`, `VERIFICATION.md`.

### [BUG-1791986810] Facebook, Erome and hosted-album wiring paths have no regression tests
- [x] **Severity:** low
- **Area:** tests
- **File(s):** tests/preview-watcher.test.ts, tests/diagnose-command.test.ts, tests/mobile-share-links.test.ts, tests/erome-media-repost.test.ts, tests/manual-media.test.ts
- **Observation:** The 2026-10-14 PR audit removed each of these conditions and the suite stayed green: Facebook's eight-second Gateway wait (`PreviewWatcher.ts`), the Facebook branch of `/diagnose` share detection (`diagnose.ts`), the automatic-repost Erome link suppression (`eromeMedia` passed to `canonicalRepostLinks`), and album registration in the hosted `/fix` Erome path (`publishHostedErome`). `m.facebook.com` share redirects are handled but untested.
- **Expected:** Each path has a test that fails when the condition is removed.
- **Repro / Notes:** Mutate the condition, run the named suite with `npx tsx --test`, observe no failure.
- **Bump:** patch
- **Status:** fixed-pending-migration
- **Fix:** Added a Facebed 7.5-second cold-media watcher test, a Facebook share row in the `/diagnose` shape table, an `m.facebook.com` share redirect test, an assertion that automatic hosted Erome reposts show the album link in angle brackets, and a public/private album-registration test for hosted `/fix`. Each removed condition (the Facebook wait, the diagnose branch, the mobile host, `eromeMedia`, and both halves of the album-registration guard) now fails its suite.
- **Docs:** none needed (tests only).

### [BUG-1791986811] Strict-URL test case is a no-op and shared ID and platform constants are incomplete
- [x] **Severity:** low
- **Area:** tests, security
- **File(s):** tests/social-providers.test.ts, src/services/RepostRegistry.ts, src/services/MediaAssetStore.ts, src/services/EromeAlbumSessions.ts, src/services/DeliveryDiagnostics.ts, src/services/DeliveryContext.ts
- **Observation:** The 2026-10-14 audit of PR #73 found: the `strictHttpsUrl` test string `'https://x.com\a'` contains no backslash (JS drops the escape), so the backslash case is never exercised directly; three identical `/^[1-9]\d{16,19}$/` copies remain outside the shared `DISCORD_ID`; `DeliveryDiagnostics` keeps an intentionally looser `DISCORD_ID` under the same name with no explanation; `DELIVERY_PLATFORMS` restates `REWRITE_PLATFORMS` by hand and can drift.
- **Expected:** Real backslash and other normalisation cases are asserted on `strictHttpsUrl`; every strict snowflake check uses the shared constant; the looser legacy pattern is named and explained; delivery platforms derive from rewrite platforms.
- **Repro / Notes:** `node -e "console.log('https://x.com\a'.includes('\\'))"` prints false.
- **Bump:** patch
- **Status:** fixed-pending-migration
- **Fix:** The strict-URL test now asserts real backslash host and path cases, a non-443 port, encoded and single-dot segments, a tab, an uppercase scheme and a literal Unicode lookalike. `RepostRegistry`, `MediaAssetStore` and `EromeAlbumSessions` use the shared `DISCORD_ID`; the looser diagnostics pattern is renamed `LEGACY_SNOWFLAKE` with its reason; `DELIVERY_PLATFORMS` derives from `REWRITE_PLATFORMS`. Build, workers, 1,238 TypeScript tests, 54 script tests (eight environment-dependent skips), audit and deploy safeguards pass.
- **Docs:** none needed (internal constants and tests).

### [BUG-1791986812] Facebook page-name pattern accepts dot-only names and the host allowlist is exported mutable
- [x] **Severity:** low
- **Area:** providers, security
- **File(s):** src/services/SocialProviders.ts, tests/social-providers.test.ts
- **Observation:** `/^\/(?:reel|[A-Za-z0-9.]{1,80}\/videos)\/(\d{1,20})\/?$/` accepts `https://www.facebook.com/.../videos/123`, rewriting it to a Facebed URL. `FACEBOOK_HOSTS` is exported as a mutable `Set`, which the share resolver also uses as an allowlist.
- **Expected:** Page names start with a letter or digit; the shared host set is typed read-only.
- **Repro / Notes:** `parseSocialUrl('https://www.facebook.com/.../videos/123')` returns a Facebook source. Harmless today (fixed provider host, video required) but outside the documented URL forms.
- **Bump:** patch
- **Status:** fixed-pending-migration
- **Fix:** Facebook page names must start with a letter or digit, and `FACEBOOK_HOSTS` is typed `ReadonlySet<string>`. Dot-only and dot-leading page names are rejected in tests; restoring the old pattern fails them.
- **Docs:** none needed (documented URL forms unchanged).

### [BUG-1791990872] Self-hosting guide says the container runs Node.js 24
- [ ] **Severity:** low
- **Area:** docs
- **File(s):** docs/self-hosting.md
- **Observation:** `docs/self-hosting.md:94` says "The container runs Node.js 24"; both `Dockerfile` stages use `node:26-trixie-slim` (PR #52 moved the runtime to Node 26).
- **Expected:** The guide names the runtime the `Dockerfile` actually builds.
- **Repro / Notes:** `grep -n FROM Dockerfile`; found during FEAT-1791990467 recon (pre-existing, not caused by that change).
- **Bump:** patch
- **Status:** open

### [BUG-1791991450] README counts seven social platforms after Facebook was added
- [ ] **Severity:** low
- **Area:** docs
- **File(s):** README.md
- **Observation:** README "Self-hosting and development" says the hosted bot is free "for the seven social platforms above"; the platform table lists eight (X/Twitter, Instagram, TikTok, YouTube, Bluesky, Reddit, Twitch clips, Facebook) since FEAT-1791951567.
- **Expected:** The count matches the table, or the sentence avoids a number.
- **Repro / Notes:** Found during FEAT-1791990470 docs update (pre-existing, not caused by that change).
- **Bump:** patch
- **Status:** open

### [BUG-1792164365] Reddit component previews cannot be confirmed by Linky's embed verifier
- [x] **Severity:** high
- **Area:** providers, previews
- **File(s):** src/services/SocialProviders.ts, tests/social-providers.test.ts, tests/delivery-recovery.test.ts, tests/manual-fix.test.ts, ops/preview-corpus.json
- **Observation:** The reported ColumbiaMD image post produced a Retry preview failure notice. vxReddit now advertises a `discord:component-embed` payload by default, while Linky's Gateway/REST verifier checks conventional embeds. The same post returns usable canonical image metadata with vxReddit's documented `?legacy` option, without the component payload.
- **Expected:** Automatic and manual Reddit previews request a format Linky can verify, retain post identity and controls, and preserve the source whenever confirmation fails.
- **Repro / Notes:** Compare Discord-crawler responses for `https://vxreddit.com/r/ColumbiaMD/comments/1x3j1s3/to_all_my_luxury_car_driving_neighbors/` with and without `?legacy`. Upstream documentation: https://github.com/dylanpdx/vxReddit#extras. Production logged two vxReddit confirmation failures for the reported source.
- **Bump:** patch
- **Status:** fixed-pending-migration
- **Fix:** The shared provider builder requests `?legacy` before fragments for automatic, manual and resolved-share previews. Regression fixtures cover canonical image/video confirmation, Replace/Reply modes, missing/unrelated metadata, original-post controls and source preservation. Node 26 validation passes (1,273 TypeScript tests, 74 script tests, 24 deployment safeguards; eight expected container-only skips). Local and Hostinger probes confirm HTTP 200, matching image metadata and no component payload for the reported legacy URL; a live Discord render was not exercised.
- **Docs:** docs/provider-checks.md records the format requirement and observation limits.

### [BUG-1792164560] PR template assertion fails on Windows CRLF checkouts
- [x] **Severity:** low
- **Area:** tests, ci
- **File(s):** tests/pr-evidence-check.test.mjs
- **Observation:** `npm run validate` on Node 26 failed because the template-heading test searches for a literal LF immediately after each heading, but `core.autocrlf=true` checks out the Markdown template with CRLF. The evidence parser itself already handles both line endings.
- **Expected:** Template structure assertions accept the repository's Windows checkout and Linux CI line endings.
- **Repro / Notes:** Run `node --test tests/pr-evidence-check.test.mjs` in a CRLF checkout; the unedited-template test fails on its first heading.
- **Bump:** patch
- **Status:** fixed-pending-migration
- **Fix:** Assert exact heading lines after splitting LF, CRLF or CR line endings. The original assertion failed in this Windows checkout; all ten PR evidence tests and full Node 26 validation now pass.

### [BUG-1792536754] Manual X fixes never request tweet translation in servers or DMs
- [x] **Severity:** med
- **Area:** commands, previews
- **File(s):** src/commands/fix.ts, src/bot.ts, tests/manual-fix.test.ts, tests/bot.test.ts
- **Observation:** `/fix` and Apps → Fix with Linky rewrite X links but never call the tweet translator. An offline reproduction with translation enabled made zero translation calls in both server and DM contexts; the reported group-DM preview retained a Japanese quoted post.
- **Expected:** Both manual entry points use the existing English tweet presentation, including quoted text and media, honor server opt-outs, and use the operator translation setting in DMs. Failed lookups retain the native preview.
- **Repro / Notes:** Exercise both commands with translation enabled in a server and without a guild. Cover translated cards, quoted videos, long-text attachments, provider recovery, disabled settings, and source/settings changes during preparation.
- **Bump:** patch
- **Status:** fixed-pending-migration
- **Fix:** Share the enabled tweet adapter with both manual commands and reuse tweet cards, quote/video captions, long-text files and delivery expectations. Respect operator/server switches, retain native previews when translation or attachment delivery is unavailable, and clear stale output after source/settings changes. Node 26 `npm run validate` passes; targeted mutation checks reject missing command wiring and missing video requirements. Live Discord rendering/playback was not exercised.
- **Docs:** README.md, CONTRIBUTING.md.

### [BUG-1792537162] Empty outer posts discard usable quoted-post translations
- [x] **Severity:** med
- **Area:** providers, previews
- **File(s):** src/services/TweetTranslation.ts, src/services/TweetPresentation.ts, tests/tweet-translation.test.ts, tests/bot.test.ts
- **Observation:** The reported X post returns a successful FxEmbed response with empty outer text, a null outer language, a photo, and a Japanese quote with an English translation. The parser rejects the outer post before inspecting the quote, so the usable translation is lost even after manual command wiring is repaired.
- **Expected:** Preserve an empty post's supported media and translate usable quoted text without inventing a source-language label. Unknown-language prose, malformed quotes, and wholly untranslated chains must still keep native previews.
- **Repro / Notes:** A bounded live lookup confirmed the response shape. Regression fixtures use synthetic text and media and must cover parsing, manual dispatch, image preservation, and textless video captions.
- **Bump:** patch
- **Status:** fixed-pending-migration
- **Fix:** Parse empty posts only with usable media or valid quoted context, retain their null language, preserve photo cards and video galleries, and show only the quoted text's translation label. Synthetic parser/command/bot regressions and the full Node 26 validation pass. A post-fix live lookup of the reported post produced one preserved photo and one English quote card; removing the empty-post photo rendering fails its regression.
- **Docs:** README.md, CONTRIBUTING.md.

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

### [BUG-1793013677] Locked undici 6.28.1 fails the dependency audit gate
- [x] **Severity:** high
- **Area:** security, ci
- **File(s):** package-lock.json
- **Observation:** On 2026-10-26 `npm audit --audit-level=low` on main reported two high-severity undici advisories (GHSA-4qv8-2p9j-2685, GHSA-xjj6-f33q-929c) for undici 6.28.1, a discord.js dependency. `npm run validate` and the CI audit step fail for every branch.
- **Expected:** The lockfile resolves a patched undici within discord.js's declared range and the audit reports no vulnerabilities.
- **Repro / Notes:** `npm ls undici`; `npm audit --audit-level=low`. Found while validating FEAT-1793013312; not caused by it.
- **Bump:** patch
- **Status:** fixed-pending-migration
- **Fix:** `npm audit fix` updated only package-lock.json to undici 6.29.1; `npm audit` reports 0 vulnerabilities and the full test suite passes.

### [BUG-1793035756] Truth Social card images and avatars do not render in Discord
- [x] **Severity:** high
- **Area:** previews, providers
- **File(s):** src/services/TruthSocial.ts, src/services/ArticlePreview.ts, src/services/ArticlePosts.ts, src/services/PreviewRecovery.ts, src/services/SocialLinkService.ts, src/commands/fix.ts, tests/truth-social.test.ts, tests/social-links.test.ts, tests/manual-fix.test.ts, docs/article-previews.md
- **Observation:** After FEAT-1793034185 deployed, Truth Social cards in GAMBA showed text, counts and Play video links but no post image or author icon. Discord's image proxy answers `404 Invalid resource` for every `static-assets.truthsocial.com` address; Truth Social refuses Discord's fetchers, Vercel, Cloudflare Workers and wsrv.nl, while the bot host receives the same images with HTTP 200.
- **Expected:** Truth Social cards show the post's first image and the author's avatar for any account.
- **Repro / Notes:** A REST probe from the bot host posted a card with an `attachment://` image plus avatar; Discord rendered both (517x800 image). Referenced uploads are hidden from `message.attachments` and reported at their `cdn.discordapp.com/attachments/...` address in the echoed embed.
- **Bump:** patch
- **Status:** fixed-pending-migration
- **Fix:** The bot host downloads the post image (8 MiB cap) and avatar (1 MiB cap) from the validated media hosts and uploads them with the card as `attachment://truth-<id>[-avatar].<ext>`; preview confirmation accepts the matching Discord CDN address. Without Attach Files, or past six files or 16 MiB per message, cards link the originals. An unconfirmed `/fix` card removes its hidden uploads with it. Downloads are cached with the lookup (32 MiB total).

### [BUG-1791833859] Verification checklist relies on CI evidence and retains completed run reports
- [x] **Severity:** low
- **Area:** docs, tests
- **File(s):** VERIFICATION.md, docs/verification-history.md
- **Observation:** The checklist contains two filled historical reports, calls the image vulnerability scan CI-only, requires a GitHub CI success as Stage 2.7, and lacks the fresh-stack/data-restore manifest required by the invoked protocol. Step 1.5 also names the gallery host's former module.
- **Expected:** A local run proves its committed artifact and freshly restored stack without citing CI; the checklist holds reusable procedure and baselines, and preserves historical evidence separately.
- **Repro / Notes:** Compare VERIFICATION.md Stages 0, 2.5, 2.7 and the Run log with the invoked protocol's local-evidence, fresh-stack and compaction requirements. The complete proposal is in .vv/protocol-proposal/proposal.diff; the user explicitly approved that diff on 2026-10-12.
- **Bump:** patch
- **Status:** fixed-pending-migration
- **Fix:** Preserve both historical reports verbatim in docs/verification-history.md; add the exact pinned local Trivy scan and fresh-stack restore rows; replace CI evidence with local matrix results; update the gallery module reference. CHANGELOG.md remains unchanged until a green full run.

### [BUG-1791837090] Fresh live TikTok attempt cannot confirm the reported share preview
- [ ] **Severity:** med
- **Area:** providers, previews
- **File(s):** src/services/MobileShareLinks.ts, src/services/PreviewWatcher.ts, src/services/PreviewRecovery.ts
- **Observation:** After the approved fresh Hostinger reset at SHA 1bdfa5a, posting the reported public share in GAMBA Replace mode produced an unconfirmed-preview notice. The source remained intact. Private Details reported native TikTok delivery, 8.8 seconds total and an 8.1-second unavailable preview stage. X controls succeeded in the same session.
- **Expected:** The reported share resolves to video 7695457160653851935 and receives a matching playable preview, with safe source retention when provider delivery is unavailable.
- **Repro / Notes:** Current owned fixture source 1559302030542118972, notice 1559302069590949890, attempt 5ee06734-e617-46af-adce-9c63f1ac0d23. Browser mutation evidence and screenshot are retained under .vv/. Provider timing and Retry are under investigation; do not infer an identity mismatch or source loss from the unconfirmed notice alone.
- **Bump:** patch
- **Status:** open

### [BUG-1791837609] Live Twitch corpus delivery has no confirmed Discord preview
- [ ] **Severity:** med
- **Area:** providers, previews
- **File(s):** src/services/SocialProviders.ts, ops/preview-corpus.json
- **Observation:** A fresh-stack GAMBA post of the existing public Twitch corpus clip kept its source and returned an unconfirmed-preview notice. The local provider metadata control had passed for that clip in this session.
- **Expected:** The corpus clip previews once through the configured provider; unavailable delivery retains the source and safe Retry controls.
- **Repro / Notes:** Owned source 1559304608327929888 and notice 1559304628900991091. The native Twitch source card rendered, but that does not establish Linky provider delivery. Host-network control and Retry are being checked.
- **Bump:** patch
- **Status:** open

### [BUG-1793043364] MyAnimeList catalogue previews are rejected as unverifiable articles
- [x] **Severity:** med
- **Area:** previews, commands
- **File(s):** src/services/ArticlePreview.ts, src/commands/fix.ts, tests/article-preview.test.ts, tests/manual-fix.test.ts, tests/social-links.test.ts, tests/fixtures/myanimelist.ts, README.md, docs/article-previews.md
- **Observation:** The reported `/fix` request for `https://myanimelist.net/anime/61578/Seitokai_ni_mo_Ana_wa_Aru` returns the public-article-metadata failure. A public metadata check on 2026-10-26 returned HTTP 200, a title, synopsis and cover, but `og:type=video.tv_show` with no player. Article parsing rejects that type before requiring Article metadata. Anime films use `video.movie`; manga entries use `books.book`.
- **Expected:** Public MyAnimeList anime and manga detail links produce compact, attributed cards with a bounded synopsis and cover; actual player pages, unrelated pages, unsafe requests and changed sources retain their existing protections.
- **Repro / Notes:** The screenshot's anime link; offline fixtures reproduce its head metadata. Verify both manual entry points, automatic source-retention checks, exact catalogue identities and genuine media-player exclusions.
- **Bump:** patch
- **Status:** fixed-pending-migration
- **Fix:** Accept matching MyAnimeList anime/film/manga detail metadata through the existing bounded HTTPS lookup, with a source-labelled card, synopsis of at most 300 characters and full-size cover when available. Keep real player exclusions, source/card confirmation, settings, ownership and HTTPS redirect checks. Update manual failure guidance and support docs. Node 26.12.1: 1,234 TypeScript tests and 54 script tests passed (eight unchanged container-only skips), worker type-check and 24 deploy safeguards passed. Real pinned lookups returned cards for the reported anime, an anime film and a manga entry. The unrelated dependency audit failure is BUG-1793043611; deployment and live Discord rendering were not performed.

### [BUG-1793043611] Dependency audit fails for the existing undici version
- [x] **Severity:** med
- **Area:** security, ci
- **File(s):** package-lock.json
- **Observation:** On 2026-10-26, `npm audit --audit-level=low` reports one high-severity vulnerable package, `undici@6.28.1`, installed through `discord.js@14.27.0` and `@discordjs/rest@2.6.3`. The reported advisories are GHSA-4qv8-2p9j-2685 and GHSA-xjj6-f33q-929c. The MyAnimeList fix does not change dependencies or the lockfile.
- **Expected:** The CI dependency audit passes with a reviewed, fixed transitive dependency version.
- **Repro / Notes:** `npm audit --audit-level=low`; `npm ls undici`. Advisory links: https://github.com/advisories/GHSA-4qv8-2p9j-2685 and https://github.com/advisories/GHSA-xjj6-f33q-929c. Review the upstream fixes and dependency compatibility before updating the lockfile; no live exploitability assessment was performed in this preview-fix task.
- **Bump:** patch
- **Status:** fixed-pending-migration
- **Fix:** Integrate current main's existing BUG-1793013677 fix, which pins the transitive dependency to undici 6.29.1 within discord.js's declared range. Both upstream advisories identify 6.29.1 as patched. A fresh Node 26 `npm ci` reports zero vulnerabilities. Duplicate of BUG-1793013677; no separate changelog line. No dependency override or additional version bump is needed.

### [BUG-1793048766] Verification backups are not ignored in other clones
- [x] **Severity:** med
- **Area:** security, docs
- **File(s):** .gitignore, VERIFICATION.md
- **Observation:** The verification checklist stores state backups and run evidence under `.vv/`, but only this checkout's private Git exclusion ignored that directory. A fresh clone could accidentally stage production JSON state or private evidence with `git add .`.
- **Expected:** The shared repository ignore rules exclude verification backups and scratch evidence in every clone.
- **Repro / Notes:** Independent review of Stage 0.8 and D3 identified the missing shared rule. `git check-ignore --no-index -v .vv/backups/synthetic.json` must identify `.gitignore` as the source, and `git ls-files .vv` must remain empty.
- **Bump:** patch
- **Status:** fixed-pending-migration
- **Fix:** Add `.vv/` to the shared .gitignore; preserve the documented private backup location and keep all verification scratch files outside the committed change set.

### [BUG-1793226105] Telegraph articles remain bare links when the publisher blocks bot metadata requests
- [x] **Severity:** med
- **Area:** previews
- **File(s):** src/services/ArticlePreview.ts, src/services/PreviewRecovery.ts, src/commands/diagnose.ts, src/commands/fix.ts, src/commands/settings.ts, tests/article-preview.test.ts, tests/manual-fix.test.ts, tests/social-links.test.ts, tests/fixtures/telegraph.ts, docs/article-previews.md, README.md
- **Observation:** The reported `https://www.telegraph.co.uk/football/2026/10/28/china-reject-mbappe-real-madrid-apologies-mao-joke/` stays unembedded in Discord. On 2026-10-28 the production host and local pinned HTTPS reader both receive HTTP 402 with a TollBit bot-access refusal, so the article lookup returns null. A public browser sees valid article metadata; the reader is blocked before it reaches that metadata.
- **Expected:** Give this supported publisher link a useful, accurately labelled card when public article metadata cannot be retrieved, while preserving bounded HTTPS retrieval, the Articles setting, source identity, ownership and exact-card confirmation.
- **Repro / Notes:** Use the exact screenshot URL. Offline fixtures must reproduce the HTTP 402 and exercise automatic and manual delivery. Do not hardcode this article's metadata, claim a URL-derived title is the publisher's headline, or bypass access restrictions.
- **Bump:** patch
- **Status:** fixed-pending-migration
- **Fix:** For matching dated Telegraph editorial links, a bounded HTTP 402 TollBit refusal produces a readable URL-title card labelled `Title from URL` and `Site: The Telegraph`, with no invented headline, excerpt, image or publication time. Exact host/path/date validation, a 4 KiB refusal cap, existing public-DNS/time/cancellation limits and 15-second caching apply; normal publisher metadata takes precedence. Automatic Replace/Reply and both manual commands retain their exact-card, settings, source and ownership checks. Update public docs and diagnostic/settings/failure guidance. Node 26.12.0 `npm run validate`: 1,325 TypeScript tests and 77 script tests pass (eight unchanged container-only skips), worker check, 24 deployment safeguards and dependency audit pass. All nine targeted mutations fail their guarding tests. The real lookup also returns the card from production's network. Live Discord client rendering was not exercised in this scoped fix.

### [BUG-1793284731] Secret scan fails after main history was rewritten
- [x] **Severity:** med
- **Area:** ci
- **File(s):** .gitleaksignore
- **Observation:** Since the 2026-10-29 02:39 UTC rewrite of `main`, which replaced `045860b` with `a5a0683` (identical tree, author emails normalised), every CI run fails `Secret scan`. Then `CI gate` fails, so `main` has not redeployed and PR #96 is blocked. Gitleaks reports two `generic-api-key` detections at `tests/regional-downloader.test.ts:12`, in rewritten commits `7aa0fd4` (main, #29) and `132c459` (`feat/erome-regional-media`). These are the same synthetic signing fixture that `.gitleaksignore` already allows under the pre-rewrite SHAs `4a8296e` and `64e01b0`.
- **Expected:** The historical synthetic fixture stays allowed under its current commit SHAs, and any real secret still fails the scan.
- **Repro / Notes:** `gitleaks git --log-opts=--all --redact=100 .` (v8.30.1, as in CI) on a full clone reports `leaks found: 2`. Fingerprints are exact (commit:file:rule:line), so no other finding is suppressed.
- **Bump:** patch
- **Status:** fixed-pending-migration
- **Fix:** Add exact fingerprints for `7aa0fd4` and `132c459`. The pre-rewrite entries remain for local branches that still contain the old commits. With gitleaks v8.30.1 over `--all`, the scan now reports `no leaks found`.

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
