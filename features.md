# Linky — Feature Tracker

Active work only. Format and rules: [`.cycle/TRACKERS.md`](.cycle/TRACKERS.md). Write with `python .cycle/trackers.py`, never by hand. Shipped and closed entries are removed; their record is `CHANGELOG.md`, Jira, and `python .cycle/trackers.py show <id>`.

## Open

### [FEAT-1790270880] Discord embed and client playback stages for the preview corpus
- [ ] **Priority:** high
- **Area:** previews, providers, tests, ops
- **File(s):** ops/preview-corpus.json, ops/provider-metadata-check.mjs, ops/delivery-archive-report.mjs, docs/provider-checks.md
- **Req:** unknown
- **Depends on:** unknown
- **UI:** unknown
- **Why:** `docs/product-roadmap.md` item 1 ("Ordinary-platform reliability coverage") is marked in progress: only the provider-metadata stage shipped on 2026-09-19 (`npm run check:providers`). The Discord embed stage and the client playback stage are still manual, so the September 18 TikTok 1/5 confirmation rate and the unverified Instagram Reel playback cannot be re-checked repeatably. The corpus also lacks the GIF, unavailable-post, intentional-suppression and article cases the roadmap names.
- **Approach:** (1) Extend `ops/preview-corpus.json` with a GIF post, a synthetic unavailable post (`expect: "unavailable"`), an `!nolinky` suppression case and one public article entry; teach the metadata check to assess article candidates through `ArticlePreview` the way it already assesses social providers. (2) Add a Discord embed stage: an operator command that posts each corpus entry to an authorised test channel with a bot token, waits with the existing `PreviewWatcher` windows and records `confirmed` / `unconfirmed` per entry with the observed embed identity, then deletes its own messages. (3) Document the playback stage as a dated manual checklist per client (desktop, iOS, Android) in `docs/provider-checks.md`, keeping metadata, embed and playback as three separate columns.
- **Library / dependency notes:** No new dependencies; reuse discord.js, `PreviewRecovery` and the archive report. Recommendation: keep the embed stage opt-in behind an explicit token and channel argument so `npm test` and CI stay network-free.
- **Acceptance criteria:**
  - The corpus contains at least one GIF, one unavailable post, one suppression case and one article, and `npm run check:providers` still exits 0 on the public corpus.
  - The embed stage produces a dated per-entry table with confirmed/unconfirmed and observed identity, and removes its own test messages.
  - `docs/provider-checks.md` shows the three stages as separate columns with dates, so a metadata pass is never presented as playback evidence.
- **Test plan:** Unit tests for the new corpus expectations and article assessment with injected fetch (extend `tests/provider-metadata-check.test.mjs`); a unit test that the embed stage refuses to run without an explicit channel and cleans up on failure; no live Discord calls in CI.
- **Out of scope:** Automated client playback detection (Discord exposes no playback signal); changing provider order; the hosted archive's retention.
- **Bump:** minor
- **Status:** open

### [FEAT-1790270881] Latency guard for the ordinary link-rewrite hot path
- [ ] **Priority:** med
- **Area:** perf, tests
- **File(s):** benchmarks/, tests/social-links.test.ts, src/services/SocialLinkService.ts, VERIFICATION.md
- **Req:** unknown
- **Depends on:** unknown
- **UI:** unknown
- **Why:** Every Discord message in an enabled channel runs link detection and rewriting on the event loop. The only measurement is a synthetic probe inside `benchmarks/erome-scheduling.mjs` (ordinary rewrite p95 below 1 ms during Erome encoding), which needs Docker, FFmpeg and a generated video and is not a repeatable check. No budget is stated anywhere, so a super-linear regex or per-link await added to the hot path would ship unnoticed.
- **Approach:** Add a small Node-only benchmark (`benchmarks/link-rewrite.mjs`) that feeds a fixed corpus of 1,000 messages (mixed platforms, hidden links, `!nolinky`, article candidates, plain text) through the rewrite function and prints p50/p95/max; add one `node:test` assertion that the p95 stays under a confirmed budget (proposed 2 ms per message on the CI runner, to be confirmed by the user) so the check runs in `npm test` without network.
- **Library / dependency notes:** Use `perf_hooks` from Node; no benchmark library needed.
- **Acceptance criteria:**
  - `node benchmarks/link-rewrite.mjs` prints p50/p95/max for the fixed corpus in under ten seconds.
  - A test in `npm test` fails when the p95 exceeds the confirmed budget.
  - `VERIFICATION.md` Stage 4 records the budget and the measured baseline.
- **Test plan:** The assertion itself plus a fixture check that the corpus covers every platform in `SocialProviders`.
- **Out of scope:** Measuring Discord publication latency; Erome scheduling (already benchmarked).
- **Bump:** patch
- **Status:** open
- **Log:**
  - Audit note (2026-09-30): `PERFORMANCE_AUDIT.md` and `benchmarks/link-handling.cjs` establish exploratory CPU measurements and a reusable synthetic corpus. This ticket remains open because the budget and CI guard have not shipped.

### [FEAT-1790270882] Container health check for the bot process
- [ ] **Priority:** low
- **Area:** ops, bot
- **File(s):** docker-compose.yml, Dockerfile, ops/deploy.sh, src/index.ts, tests/deploy.test.sh
- **Req:** unknown
- **Depends on:** unknown
- **UI:** unknown
- **Why:** `ops/deploy.sh` decides readiness by scanning container logs for "Logged in as" and "Serving", and Compose declares no `healthcheck`, so Docker's `restart: unless-stopped` cannot distinguish a hung Gateway session from a healthy one. The media server exposes `/healthz` only when `EROME_MEDIA_ENABLED=true`, which the hosted bot does not set.
- **Approach:** Write a readiness file (for example `/tmp/linky-ready` updated on `ClientReady` and on each Gateway heartbeat ack) and add a Compose `healthcheck` that checks its age with `node -e`; keep `deploy.sh`'s log check but let it prefer the health status when present. No listening port on the hosted bot.
- **Library / dependency notes:** None.
- **Acceptance criteria:**
  - `docker inspect linky` reports `healthy` after startup and `unhealthy` when the Gateway session stops acking for longer than the chosen threshold.
  - `bash tests/deploy.test.sh` still passes, with a new case for the health-based readiness path.
- **Test plan:** Deploy-script mock case; unit test for the readiness writer with a fake clock.
- **Out of scope:** External uptime monitoring; exposing an HTTP endpoint on the hosted bot.
- **Bump:** minor
- **Status:** open

### [FEAT-1790785729] Include share resolution and provider cache decisions in delivery measurements
- [ ] **Priority:** med
- **Area:** perf, previews, archive
- **File(s):** src/commands/fix.ts, src/services/SocialLinkService.ts, src/services/DeliveryContext.ts, src/services/DeliveryDiagnostics.ts, tests/delivery-diagnostics.test.ts
- **Req:** unknown
- **Depends on:** unknown
- **UI:** unknown
- **Why:** The 2026-09-30 audit found that both entry points normalize mobile shares before starting the delivery attempt. Redirect latency is therefore absent from reported duration, and unsuccessful resolution may have no recorded attempt. Ordinary-provider caches do not supply observed hit/miss coverage.
- **Approach:** Define the eligible-attempt boundary before network work, time share resolution, and expose bounded cache decisions from existing translation/metadata lookups. Keep ignored-message and unavailable-source coverage explicit in operator reports. Retain the archive schema's exclusion of URLs, captions and Discord identities.
- **Library / dependency notes:** Reuse the current trace/archive interfaces and injected clocks; no metrics service is needed.
- **Acceptance criteria:** A delayed share resolver appears in elapsed/stage timing; failed resolution has a documented outcome; supported cache decisions are observed rather than inferred; reports explain comparable denominators.
- **Test plan:** Inject delayed/failed resolvers, clocks and cached lookups into automatic/manual entry points; verify archive privacy and source preservation.
- **Out of scope:** Changing provider ordering, preview deadlines or cache sizes without measurements.
- **Bump:** patch
- **Status:** open

### [FEAT-1790785730] Define a consistent formatting check for contributors
- [ ] **Priority:** low
- **Area:** tooling, tests
- **File(s):** package.json, CONTRIBUTING.md, .github/workflows/ci.yml
- **Req:** unknown
- **Depends on:** unknown
- **UI:** unknown
- **Why:** The 2026-09-30 cleanup found strict TypeScript unused-code checks but no formatter or lint/fix command. Formatting is maintained manually.
- **Approach:** Select a formatter after checking current docs and repository conventions, then separate its mechanical adoption from behavior changes. Keep a check command available locally and in CI.
- **Library / dependency notes:** No dependency selected or installed by this cleanup; evaluate and pin an actively maintained tool before implementation.
- **Acceptance criteria:** Contributors have documented format/check commands; CI catches formatting drift; an initial mechanical diff is separately reviewable.
- **Test plan:** Verify idempotent formatting, check failure on a deliberately malformed fixture, and the existing build/test suite.
- **Out of scope:** Adding architectural lint rules or reformatting code during this cleanup.
- **Bump:** patch
- **Status:** open

### [FEAT-1791951567] Facebook Reel and video previews
- [x] **Priority:** high
- **Area:** previews, providers
- **File(s):** src/services/SocialProviders.ts, src/services/MobileShareLinks.ts, src/services/LinkConfiguration.ts, src/services/PreviewRecovery.ts, src/commands/settings.ts, README.md
- **Req:** unknown
- **Depends on:** unknown
- **UI:** unknown
- **Why:** A user-reported Facebook mobile share (`https://www.facebook.com/share/r/1DTK3shLVM/?mibextid=wwXIfr`) stays unchanged: Linky has no Facebook support, and Discord's native card for Facebook shows only a thumbnail with no playable video.
- **Approach:** Add a `facebook` platform for `/reel/<id>` and `/<page>/videos/<id>` URLs, previewed through Facebed (`facebed.com`, https://github.com/facebed/facebed), which serves an `og:video` MP4. Resolve `/share/r/` and `/share/v/` mobile shares with the existing bounded, cookie-free redirect lookup (Facebook answers them with a 302 to `/reel/<id>`). Identify previews by numeric video ID because Facebed's `og:url` varies between `/reel/` and `/videos/` forms; require a playable video before replacement.
- **Library / dependency notes:** No new dependencies.
- **Acceptance criteria:**
  - The reported share link resolves to `https://www.facebook.com/reel/1060921586772217` and is rewritten to `https://facebed.com/reel/1060921586772217`.
  - Facebed login-wall responses (no video) are not accepted as a preview; the source message is kept.
  - `/settings facebook:` and the setup Platforms menu control the platform; existing servers inherit it as on.
- **Test plan:** Unit tests for parsing, rewriting, provider identity, share resolution with injected HTTP, and verification rejecting a video-less embed; live Discord check of the reported link.
- **Out of scope:** Facebook photo/text posts, `/watch?v=` and `fb.watch` links, private or login-only videos.
- **Bump:** minor
- **Status:** shipped-pending-migration
- **Implementation:** `facebook` platform and `facebed` provider in `SocialProviders.ts` (video-ID identity, strict hosts); `/share/r|v/` resolution in `MobileShareLinks.ts`; video required and eight-second Gateway window in `PreviewRecovery.ts` / `PreviewWatcher.ts`; `/settings facebook:`, setup menu, diagnostics and archive platform lists; corpus entry and docs. Live: the reported link resolved from Hostinger, Discord built a 720×1280 video embed that Linky's matcher accepted and Chrome Discord played (`docs/provider-checks.md`).

### [FEAT-1791981013] Extract repost eligibility, permission, link and expectation helpers from SocialLinkService
- [x] **Priority:** low
- **Area:** bot, previews
- **File(s):** src/services/SocialLinkService.ts, src/services/RepostEligibility.ts (new), src/services/RepostDelivery.ts (new), tests/repost-eligibility.test.ts (new)
- **Req:** unknown
- **Depends on:** unknown
- **UI:** unknown
- **Why:** `SocialLinkService.ts` is 675 lines, almost all inside one `createLinkRepostHandler` closure. Pure decisions (message copy eligibility, source versioning, required channel permissions, link canonicalization, preview expectations) are inlined between network and Discord calls, so they cannot be read or tested on their own. Deferred from the 2026-10-14 tightening pass (PR #73).
- **Approach:** Behaviour-preserving extraction only. (1) Move `bypassLinky`, `canCopy` and `sourceVersion` to `RepostEligibility.ts`; keep `bypassLinky` re-exported from `SocialLinkService` for existing imports. (2) Add pure `requiredRepostPermissions({ reply, thread, attachments, erome })` and `canonicalRepostLinks(content, { articles, community, eromeMedia, youtube })` and `repostExpectations(...)` to `RepostDelivery.ts`, called from the closure with the same arguments it computes today. (3) Name the handler's options type `LinkRepostOptions`. No change to message text, ordering of Discord calls, abort checks or retry results.
- **Library / dependency notes:** None.
- **Acceptance criteria:**
  - `SocialLinkService.ts` keeps its public exports and signatures; existing tests pass unchanged.
  - Each extracted helper has a direct unit test pinning current behaviour.
  - Full CI gate passes.
- **Test plan:** Characterization tests for the extracted helpers in `tests/repost-eligibility.test.ts`; existing `social-links`, `repost-sync`, `erome-media-repost` suites as the behaviour net.
- **Out of scope:** Restructuring the closure's state machine, changing delivery behaviour, splitting by platform.
- **Bump:** patch
- **Status:** shipped-pending-migration
- **Implementation:** `bypassLinky`, `canCopy` and `sourceVersion` moved verbatim to `RepostEligibility.ts` (`bypassLinky` still re-exported); `requiredRepostPermissions`, `canonicalRepostLinks`, `instagramShortcodes` and `repostExpectations` in `RepostDelivery.ts`; handler options named `LinkRepostOptions`. `SocialLinkService.ts` 675 to 622 lines with unchanged exports. Seven characterization tests in `tests/repost-eligibility.test.ts` plus a replace-mode Attach Files wiring test in `tests/social-links.test.ts` (mutation-checked); full CI gate green (1,235 TypeScript and 54 script tests, 0 vulnerabilities, deploy tests).
- **Docs:** none affected; no document names the moved internals.

### [FEAT-1791981014] Split the /fix command's execute into named stages
- [x] **Priority:** low
- **Area:** commands, previews
- **File(s):** src/commands/fix.ts, src/commands/fixMedia.ts (new), tests/repost-eligibility.test.ts, tests/manual-fix.test.ts
- **Req:** unknown
- **Depends on:** unknown
- **UI:** unknown
- **Why:** `execute` in `src/commands/fix.ts` runs from line 71 to 447 as one function covering source resolution, permission checks, presentation, preview verification and recording. Deferred from the 2026-10-14 tightening pass (PR #73).
- **Approach:** Behaviour-preserving extraction of self-contained pure or single-purpose stages into `fixMedia.ts` (for example the preview expectation builder and permission/eligibility checks), reusing `RepostDelivery.ts` helpers from FEAT-1791981013 where the logic is identical. `data`, `contextData`, `manualLinks`, `execute` and `removeManual` keep their exports and signatures. No change to replies, ephemeral flags, ordering or timeouts.
- **Library / dependency notes:** None.
- **Acceptance criteria:**
  - `execute` is shorter, with the hosted Erome publish stage and button builder behind named functions (amended 2026-10-14: the remaining stages are FEAT-1791986813).
  - Existing `manual-fix` tests pass unchanged; extracted helpers have unit tests.
  - Full CI gate passes.
- **Test plan:** Existing `tests/manual-fix.test.ts` plus characterization tests for extracted helpers.
- **Out of scope:** Behaviour changes to /fix or Apps → Fix with Linky.
- **Bump:** patch
- **Status:** shipped-pending-migration
- **Implementation:** The hosted-original Erome publish stage moved to `publishHostedErome` and the Original post/Remove buttons to `manualButtons` in `src/commands/fixMedia.ts`; preview expectations reuse `repostExpectations` and `instagramShortcodes` from FEAT-1791981013. `fix.ts` 463 to 389 lines; exports and signatures unchanged; existing `manual-fix` tests pass unchanged, plus a `manualButtons` characterization test in `tests/repost-eligibility.test.ts` and a mutation-checked Instagram image expectation test in `tests/manual-fix.test.ts`.
- **Docs:** none affected.

### [FEAT-1791986813] Finish splitting the /fix command's execute into named stages
- [ ] **Priority:** low
- **Area:** commands, previews
- **File(s):** src/commands/fix.ts, src/commands/fixMedia.ts, tests/manual-fix.test.ts, tests/manual-media.test.ts
- **Req:** unknown
- **Depends on:** unknown
- **UI:** unknown
- **Why:** FEAT-1791981014 extracted only the hosted Erome stage and the button builder; the 2026-10-14 audit measured `execute` at about 300 lines with community/article resolution, Erome attachment preparation and the verify/recovery loop still inline.
- **Approach:** Behaviour-preserving extraction of those three stages behind named functions, passing the `manualButtons` result instead of separate `buttons`/`buttonRows`, and moving `manualButtons` out of the media module.
- **Library / dependency notes:** None.
- **Acceptance criteria:**
  - `execute` reads as resolve, prepare, publish and verify stages.
  - Existing manual tests pass unchanged; each extracted stage has a wiring test that fails when mutated.
- **Test plan:** Existing `manual-fix` and `manual-media` suites plus mutation-checked wiring tests.
- **Out of scope:** Behaviour changes to /fix.
- **Bump:** patch
- **Status:** open

### [FEAT-1791990467] Independent CI jobs behind one required CI gate
- [x] **Priority:** high
- **Area:** ci, docs
- **File(s):** .github/workflows/ci.yml, ops/prompt-workflow.mjs, tests/prompt-workflow.test.mjs, tests/ci-workflow.test.mjs (new), VERIFICATION.md, CONTRIBUTING.md, README.md, docs/self-hosting.md, docs/discord-prompt.md
- **Req:** unknown
- **Depends on:** unknown
- **UI:** unknown
- **Why:** 2026-10-14 workflow review, items 1-2. `npm audit` runs inside each `Build (Node N)` job before build and tests, so an advisory hides every functional result. Branch protection on `main` requires `Build (Node 22)`, `Build (Node 24)` and `Production container` but not `Build (Node 26)`, the version the production `Dockerfile` runs.
- **Approach:** Split `ci.yml` into independent jobs: `Secret scan` (gitleaks, once), `Dependency audit` (`npm ci` + `npm audit --audit-level=low`, once), `Build (Node N)` matrix 22/24/26 (build, `check:workers`, `npm test`, `deploy.test.sh`) and `Production container`. Add `CI gate` with `needs:` on all of them and `if: always()`, failing unless every needed job concluded `success`. Matrix job names stay `Build (Node N)` so this change merges under the current rules. The Discord prompt publisher's hard-coded required checks become `CI gate` and `PR evidence` (FEAT-1791990468). After merge, switch `main` branch protection required checks to `CI gate` and `PR evidence` via `gh api` (keep strict, enforce-admins and conversation resolution). Deploy keeps triggering on the CI workflow conclusion.
- **Library / dependency notes:** None; existing pinned actions and tool checksums move unchanged.
- **Acceptance criteria:**
  - An audit failure leaves build, test, deploy-safeguard and container results reported.
  - `CI gate` fails when any needed job fails, is cancelled or is skipped.
  - `main` requires only `CI gate` and `PR evidence`; strict, enforce-admins and conversation resolution remain on; recorded with `gh api` output.
  - VERIFICATION, CONTRIBUTING, CLAUDE.md and README name the new job and step names.
- **Test plan:** `bash tests/deploy.test.sh` plus a static assertion test that `ci.yml` gate `needs:` covers every other job; the PR's own CI run shows all jobs; `gh api .../branches/main/protection` output after the change.
- **Out of scope:** `linky-web` / Vercel deployment gating (separate repository); changing Deploy's SSH steps.
- **Bump:** minor
- **Status:** shipped-pending-migration
- **Implementation:** `ci.yml` runs `Secret scan`, `Dependency audit`, `Build (Node 22|24|26)` and `Production container` independently; `CI gate` (`needs` all, `if: always()`) fails unless every result is `success` (gate script exercised with success/failure/skipped/cancelled/empty inputs). The prompt publisher's `REQUIRED_CHECKS` is `CI gate` + `PR evidence`; `tests/ci-workflow.test.mjs` pins the gate's needs and the publisher names (mutation: dropping `audit` from needs fails it). After #77 merged (cdc4347), `gh api -X PATCH repos/LLRHook/linky/branches/main/protection/required_status_checks` returned `{"checks":[{"app_id":15368,"context":"CI gate"},{"app_id":15368,"context":"PR evidence"}],"strict":true}`; `GET .../branches/main/protection` then showed `enforce_admins` true, conversation resolution true, 0 required approvals (2026-10-14).
- **Docs:** VERIFICATION, CONTRIBUTING, README, docs/self-hosting.md, docs/discord-prompt.md.

### [FEAT-1791990468] Acceptance evidence required in every pull request
- [x] **Priority:** high
- **Area:** ci, docs
- **File(s):** .github/pull_request_template.md (new), .github/workflows/pr-evidence.yml (new), ops/pr-evidence-check.mjs (new), tests/pr-evidence-check.test.mjs (new), ops/prompt-workflow.mjs, tests/prompt-workflow.test.mjs, CONTRIBUTING.md, docs/discord-prompt.md
- **Req:** unknown
- **Depends on:** unknown
- **UI:** unknown
- **Why:** 2026-10-14 workflow review, item 3. VERIFICATION 2.3 maps tickets to tests only at release; FEAT-1791981014 ticked a structural criterion ("execute reads as named stages") that behaviour tests could not prove.
- **Approach:** PR template sections: Tickets; Acceptance evidence (criterion, named test or file:function inspection, result); Mutation checks (what was broken, which test failed); Docs affected and checked; Remaining gaps or reduced scope. `ops/pr-evidence-check.mjs` reads the PR body from the event payload and fails when a required section is missing or left as template placeholder. A separate `pr-evidence.yml` workflow (job `PR evidence`) runs it on `pull_request` opened/edited/synchronize/reopened, so body edits do not rerun the full CI; it is a required check beside `CI gate`. The Discord prompt publisher fills every section from the request, the isolated review verdict and the coding-run link. CONTRIBUTING: structural criteria need inspection evidence; partial delivery stays unticked with a follow-up ticket.
- **Library / dependency notes:** None; Node built-ins only.
- **Acceptance criteria:**
  - Opening a PR pre-fills the template.
  - A PR with an empty or placeholder evidence section fails the required `PR evidence` check.
  - The prompt publisher's generated body passes the check.
  - Editing the PR body re-runs the check.
  - CONTRIBUTING states the structural-criterion and partial-scope rules.
- **Test plan:** `node --test tests/pr-evidence-check.test.mjs` with complete, missing-section, placeholder-only and push-event bodies; mutation check removing one required section from the checker.
- **Out of scope:** Judging whether evidence is correct (reviewer responsibility).
- **Bump:** minor
- **Status:** shipped-pending-migration
- **Implementation:** `.github/pull_request_template.md`; `ops/pr-evidence-check.mjs` (comment-stripped sections, linear heading parse, Dependabot exempt) run by `pr-evidence.yml` from the base commit on opened/edited/synchronize/reopened; the publisher's `pullRequestBody` fills every section from the request, review and run link with carriage returns normalized. `tests/pr-evidence-check.test.mjs` (10 tests; four checker mutations each fail) and the publisher test assert the generated body passes.
- **Docs:** CONTRIBUTING (evidence, structural-criterion and partial-scope rules), VERIFICATION 2.3, docs/discord-prompt.md.

### [FEAT-1791990469] Documentation consistency test against the provider catalog
- [x] **Priority:** med
- **Area:** tests, docs, providers
- **File(s):** src/services/MobileShareLinks.ts, tests/docs-consistency.test.ts (new), README.md, .env.example, docs/provider-checks.md, docs/self-hosting.md
- **Req:** unknown
- **Depends on:** unknown
- **UI:** unknown
- **Why:** 2026-10-14 workflow review, item 4. Facebook shipped without operator docs (BUG-1791986809) and the `rxddit.com` share-resolution fallback is a hard-coded host outside `SOCIAL_PROVIDERS`.
- **Approach:** Export the share-resolution fallback hosts from `MobileShareLinks.ts`. A test reads the docs and asserts the `.env.example` comment and `docs/self-hosting.md` `REWRITE_PLATFORMS` lists equal `REWRITE_PLATFORMS`, and every `SOCIAL_PROVIDERS` origin host and share fallback host appears in the README platform table and the `docs/provider-checks.md` table. VERIFICATION has no full platform list, only corpus steps, so it is not checked. Failure messages name the missing doc and value.
- **Library / dependency notes:** None.
- **Acceptance criteria:**
  - Removing `facebook` from any listed doc, or adding a provider/fallback host without documenting it, fails `npm test` with a message naming file and value.
  - Current docs pass; any drift found is fixed in the same change.
- **Test plan:** `tests/docs-consistency.test.ts`; mutation checks deleting a platform from one doc and adding an undocumented fallback host.
- **Out of scope:** Automated review of privacy prose (stays human); generating docs from code.
- **Bump:** minor
- **Status:** shipped-pending-migration
- **Implementation:** `SHARE_FALLBACK_HOSTS` exported from `MobileShareLinks.ts`; `tests/docs-consistency.test.ts` checks the `.env.example` and self-hosting platform lists against `REWRITE_PLATFORMS` and every provider origin, caption-free origin and fallback host against the README and provider-checks tables. It caught the README omitting `rxddit.com` and both tables omitting the caption-free Instagram hosts; all fixed. Mutations (drop a host from README, drop `facebook` from `.env.example`, add an undocumented fallback) fail it.
- **Docs:** README and docs/provider-checks.md platform tables, CONTRIBUTING.

### [FEAT-1791990470] One local validate command, primary Node version and pre-push hook
- [x] **Priority:** med
- **Area:** ci, ops, docs
- **File(s):** package.json, ops/validate.mjs (new), tests/validate.test.mjs (new), .nvmrc (new), .githooks/pre-push (new), CONTRIBUTING.md, CLAUDE.md, README.md
- **Req:** unknown
- **Depends on:** unknown
- **UI:** unknown
- **Why:** 2026-10-14 workflow review, item 6. Contributors and agents copy five commands from CONTRIBUTING/CLAUDE.md; a stop on first failure hides later results; no primary Node version is pinned while production runs Node 26.
- **Approach:** `npm run validate` runs build, `check:workers`, `npm test`, `npm audit --audit-level=low` and `bash tests/deploy.test.sh` in order, continues after failures, prints a PASS/FAIL table and exits non-zero on any failure. `.nvmrc` = 26 (Dockerfile). `.githooks/pre-push` runs `npm run validate`, enabled with `git config core.hooksPath .githooks` (documented, opt-in per clone). Document a Linux path (Docker `node:26` or WSL) for `deploy.test.sh` on Windows. When FEAT-1790785730 lands, its format check joins the list.
- **Library / dependency notes:** None; no hook manager dependency.
- **Acceptance criteria:**
  - One failing check does not stop later checks; summary lists every result; exit code non-zero.
  - Command list matches `ci.yml` (asserted by a test).
  - CONTRIBUTING and CLAUDE.md point to `npm run validate`, `.nvmrc` and the hook.
- **Test plan:** `tests/validate.test.mjs` with an injected runner (all pass, one fail, list matches CI); manual `npm run validate` run.
- **Out of scope:** Mandatory hooks; replacing CI.
- **Bump:** minor
- **Status:** shipped-pending-migration
- **Implementation:** `npm run validate` (`ops/validate.mjs`) runs build, `check:workers`, `npm test`, `deploy.test.sh` and audit, continues after failures and prints a PASS/FAIL summary; `tests/validate.test.mjs` keeps the list equal to the single-line `ci.yml` commands and `.nvmrc` (26) equal to the Dockerfile; `.githooks/pre-push` (LF, executable) runs it after `git config core.hooksPath .githooks`. Verified green on Windows Node 24 and in a clean `node:26` Linux clone via `git bundle`.
- **Docs:** CONTRIBUTING, README, local CLAUDE.md (gitignored).

### [FEAT-1791990471] Shared Discord test fixtures and fake-timer timeout boundaries
- [x] **Priority:** low
- **Area:** tests
- **File(s):** tests/support/discord.ts (new), tests/social-links.test.ts, tests/erome-media-repost.test.ts, tests/delivery-recovery.test.ts, tests/manual-fix.test.ts, tests/diagnose-command.test.ts, tests/manual-media.test.ts, tests/erome-delivery.test.ts
- **Req:** unknown
- **Depends on:** unknown
- **UI:** unknown
- **Why:** 2026-10-14 workflow review, item 5. Each suite builds its own Discord message/channel/interaction fakes, so tests for reposts, /fix, /diagnose, delayed embeds and album registration drift apart and can pass without exercising the intended path (BUG-1791981980).
- **Approach:** Shared typed fakes for message, channel, interaction and a repost harness, recording forbidden calls by default. Migrate the suites that duplicate these fakes (repost source message: social-links, erome-media-repost, delivery-recovery; command interaction: manual-fix, diagnose-command, manual-media) without weakening assertions. The real 550-1600 ms progress waits in erome-media-repost, manual-media and erome-delivery move to `mock.timers` with just-before and at-deadline cases. preview-watcher and erome-album-sessions already use mocked timers and stay as they are.
- **Library / dependency notes:** None; `node:test` mock timers.
- **Acceptance criteria:**
  - Named suites use the shared fixtures; test count unchanged or higher.
  - No migrated timeout test relies on wall-clock delay.
  - One mutation check per migrated path recorded in the PR.
- **Test plan:** Full `npm test`; per-path mutation checks.
- **Out of scope:** Migrating every other suite.
- **Bump:** minor
- **Status:** shipped-pending-migration
- **Implementation:** `tests/support/discord.ts` (source message and channel, bot message, command/button interactions, diagnostics stub, fake clock, forbidden-call recorder) used by social-links, erome-media-repost, delivery-recovery, manual-fix, diagnose-command, manual-media and erome-delivery. Progress waits (500/1500 ms) and a 10 s send deadline are fake-clock checks one millisecond before and at the deadline. The seven suites run 430 tests in under 1 s (was about 17 s); delay mutations in `fix.ts` and `DeliveryProgress.ts` fail 4 tests each, and skipping the `canCopy` gate fails delivery-recovery only through the recorder.
- **Docs:** none affected.

### [FEAT-1792002672] Finish in-flight deliveries when the bot shuts down
- [x] **Priority:** high
- **Area:** bot, ops
- **File(s):** src/bot.ts, src/config.ts, src/services/ServiceCheckpoint.ts (new), docker-compose.yml, ops/deploy.sh, tests/bot.test.ts, tests/service-checkpoint.test.ts (new), tests/deploy.test.sh, docs/self-hosting.md
- **Req:** unknown
- **Depends on:** unknown
- **UI:** unknown
- **Why:** A deploy recreates the single container. On SIGTERM `client.destroy()` immediately aborts the shared shutdown signal (`src/bot.ts`), so a delivery in progress is cancelled: the source stays, but its link is never fixed. The last production deploy (2026-10-14 15:10 UTC) measured about 1.3 s between the old container stopping and the new one running, and nothing reports that gap.
- **Approach:** On shutdown, stop accepting new messages, edits and interactions; interactions get a private "restarting" reply instead of a failure. Track every running message and interaction handler and wait for them to settle for up to 20 s before aborting the remainder, then run the existing cleanup. Record the stop time in a small `data/service-checkpoint.json` (time only, no content). After the next login the bot logs how long it was offline, and `deploy.sh` prints that line. Raise `stop_grace_period` from 15 s to 30 s so Docker does not kill the drain.
- **Library / dependency notes:** None.
- **Acceptance criteria:**
  - A delivery that is running when shutdown starts completes and is not cancelled if it finishes within the drain limit.
  - A delivery still running at the drain limit is cancelled through the existing abort path, and shutdown still completes.
  - Messages, edits and interactions that arrive after shutdown starts are not processed; a repliable interaction receives a private restarting reply.
  - Startup after a clean stop logs the offline duration; startup after a crash with no recorded stop logs none.
  - `docker-compose.yml` `stop_grace_period` exceeds the drain limit plus cleanup.
  - `deploy.sh` prints the bot's offline-duration line after a successful deploy and still succeeds when the line is absent.
- **Test plan:** `tests/bot.test.ts` drain cases with controlled delivery promises; checkpoint unit tests with a fake clock; `tests/deploy.test.sh` success case asserts the printed offline line.
- **Out of scope:** Running two bot processes at once; replaying missed messages (FEAT-1792002673).
- **Bump:** minor
- **Status:** shipped-pending-migration
- **Implementation:** `src/services/InFlightWork.ts` tracks message, edit, interaction and catch-up handlers; `src/bot.ts` stops accepting on `destroy()`, replies privately to interactions with `RESTARTING_REPLY`, waits up to `SHUTDOWN_DRAIN_MS` (20 s) before aborting, and logs `Back online after N s offline` from the `stoppedAt` in `src/services/ServiceCheckpoint.ts`. `docker-compose.yml` `stop_grace_period` is 30s; `ops/deploy.sh` `report_offline_time` prints the line. Tests: `tests/bot.test.ts` (drain, drain limit, Compose grace, offline report with and without catch-up, edits during shutdown), `tests/service-checkpoint.test.ts`, `tests/deploy.test.sh` success case.
- **Docs:** `docs/self-hosting.md` shutdown paragraph and deployment summary; README Reliability section.

### [FEAT-1792002673] Process messages posted while the bot was offline
- [x] **Priority:** high
- **Area:** bot
- **File(s):** src/bot.ts, src/config.ts, src/services/ServiceCheckpoint.ts, .env.example, tests/bot.test.ts, tests/service-checkpoint.test.ts, tests/config.test.ts, README.md, docs/self-hosting.md
- **Req:** unknown
- **Depends on:** unknown
- **UI:** unknown
- **Why:** Discord does not replay messages to a new Gateway session. Links posted during a deploy, restart or crash stay unfixed. Depends on FEAT-1792002672 for the stop time.
- **Approach:** Opt-in `CATCH_UP_ENABLED` (default `false`; enabled for the public hosted bot, self-hosters choose). When enabled, remember the 20 enabled channels where a link was most recently posted and refresh the checkpoint every 30 s so a crash is covered too. After startup, fetch each remembered channel's messages posted between the checkpoint and the new session (at most 2 minutes old, 50 per channel, one request per channel) and pass them through the normal repost rules. Skip messages Linky already reposted (repost registry) and messages the running session already handles.
- **Library / dependency notes:** Uses discord.js `channel.messages.fetch({ after, limit })`; requires Read Message History, which the invite already requests.
- **Acceptance criteria:**
  - With `CATCH_UP_ENABLED=true`, a link posted in a remembered channel during the offline gap is fixed once after startup, subject to the same scope, opt-out and permission rules as a live message.
  - Messages older than 2 minutes, beyond 50 per channel, outside the 20 remembered channels, or already recorded in the repost registry are not processed.
  - A channel that cannot be fetched is skipped without affecting the others or startup.
  - With the setting off (default), no channel IDs are stored and no history is fetched.
  - The checkpoint file stores only times and channel IDs.
- **Test plan:** Checkpoint unit tests (channel cap, window, persistence, validation); `tests/bot.test.ts` catch-up integration with fake channels including a failing channel and an already-reposted message; config parsing test.
- **Out of scope:** Catch-up for edits and deletions; channels not seen before the restart; configurable limits.
- **Bump:** minor
- **Status:** shipped-pending-migration
- **Implementation:** `CATCH_UP_ENABLED` in `src/config.ts`; `ServiceCheckpoint` keeps the 20 enabled channels with the most recent links and an `aliveAt` refreshed every 30 s; `catchUp()` fetches once per channel after `stoppedAt ?? aliveAt` minus 3 s, within 2 minutes and before session start plus 3 s, 50 messages per channel, four channels at a time, in order per channel, skipping registry-recorded and live-seen messages and channels without Read Message History. Enabled on the hosted bot in `/root/linky/.env` (backup `.env.bak-20261014-catchup`). Tests: `tests/service-checkpoint.test.ts`, catch-up cases in `tests/bot.test.ts`, `tests/config.test.ts`.
- **Docs:** `.env.example`, `docs/self-hosting.md` settings table and catch-up paragraph (including the crash duplicate limitation), README Reliability section.

### [FEAT-1793013312] Truth Social post previews
- [ ] **Priority:** high
- **Area:** previews
- **File(s):** src/services/TruthSocial.ts, src/services/ArticlePreview.ts, src/commands/diagnose.ts, tests/truth-social.test.ts, docs/article-previews.md, README.md
- **Req:** unknown
- **Depends on:** unknown
- **UI:** unknown
- **Why:** Truth Social serves the same placeholder head (`og:title` "Truth Social", `og:type=website`) for every post, so Discord shows no post content and Linky's article path answers `/fix` with "Public article metadata is required" (reported 2026-10-26 for `https://truthsocial.com/@realDonaldTrump/117497314507062631`). No maintained embed-fixer service exists for Truth Social.
- **Approach:** Truth Social post permalinks (`/@user/ID`, `/@user/posts/ID`) stay article candidates, so the existing authored-card pipeline (Replace/Reply, `/fix`, mixed-link guidance, exact-card confirmation, `articles` setting) applies unchanged. The article lookup recognises them and requests the public Mastodon-compatible `GET /api/v1/statuses/{id}` JSON from `truthsocial.com` with the same pinned public DNS, cookie-free request, five-second timeout, shared rate limit and cache. The status must match the requested ID, be public or unlisted, not sensitive, and have text or media. Linky renders one card: author display name and handle with avatar, post text (ReTruths credit the reposter, quotes add the quoted text), the first image or video poster from Truth Social's asset hosts, counts, and the post time. Truth Social's Cloudflare protection returns 403 for the status API from datacenter addresses (Hostinger and Vercel both checked 2026-10-26), so the lookup falls back to signed-out public sources reachable from the hosted bot: for `@realDonaldTrump`, the Trump's Truth archive RSS feed (`www.trumpstruth.org/feed`, latest 100 posts with archived images and MP4s, cached 30 s); otherwise Truth Social's own post-page metadata (rendered only after a first warming visit, so Linky revisits once after 1.2 s) with the oEmbed author name.
- **Library / dependency notes:** None; reuses `RegionalHttp.connectHttps`.
- **Acceptance criteria:**
  - The reported post produces a Truth Social card instead of the metadata-required notice.
  - Mismatched IDs, private/direct/sensitive posts, malformed JSON, oversized bodies, non-JSON responses, redirects and non-asset image hosts leave the original unchanged.
  - Text cannot inject mentions, markdown or links; images come only from Truth Social asset hosts.
  - Other article behaviour is unchanged.
- **Test plan:** `tests/truth-social.test.ts` URL parsing, status parsing and card formatting; lookup request shape and rejection cases through the article lookup fixture.
- **Out of scope:** Inline video playback in the card; multi-image galleries; a separate `truthsocial` platform setting; header spoofing, residential proxies or other evasion of Truth Social's bot protection; media for other accounts' posts when the status API is blocked; signed ActivityPub fetches.
- **Bump:** minor
- **Status:** in-progress
- **Implementation:** `src/services/TruthSocial.ts` parses permalinks, the status API JSON, the archive feed item for the requested ID and page metadata, and formats one card (author, text, image or poster, link title, quote, ReTruth credit, archive Play video link, counts or source footer, time). `createArticleLookup` tries API, archive, then page+oEmbed within the article time and rate limits; `formatArticlePreview` never renders Truth Social placeholder metadata. `/diagnose` names Truth Social posts. Tests: `tests/truth-social.test.ts`. On 2026-10-26 local lookups with the API forced to 403 rendered the reported image post and a video post (archive) and @TeamTrump text posts (page); from the Hostinger host the API returned 403 while the archive feed, post page (after warming) and oEmbed returned 200. Correction (same day): that 403 was measured with curl; Linky's own HTTPS client receives the API from the Hostinger host (21/21, FEAT-1793034185), so production cards come from the API. Pending: confirmation in live Discord after deployment.

### [FEAT-1793034185] Truth Social posts from any account through a Cloudflare relay
- [ ] **Priority:** high
- **Area:** previews
- **File(s):** workers/truth-social-relay/worker.mjs, workers/truth-social-relay/wrangler.toml, src/services/TruthSocial.ts, src/services/ArticlePreview.ts, src/config.ts, src/bot.ts, src/commands/diagnose.ts, tests/truth-social.test.ts, tests/truth-social-relay.test.mjs, docs/truth-social-relay.md, docs/article-previews.md, docs/self-hosting.md, .env.example, README.md
- **Req:** unknown
- **Depends on:** unknown
- **UI:** unknown
- **Why:** FEAT-1793013312 cards depend on Truth Social's status API; when its bot protection refuses the host, posts by accounts other than @realDonaldTrump lose their media and video-only posts stay unchanged. On 2026-10-26 the hosted bot's Node HTTPS client was accepted (21/21), but curl and `fetch()` from the same server, IPv6 and twelve Vercel regions got 403, so the acceptance is fragile. API videos also had no playable link. Signed ActivityPub fetches were refused ("Public key not found"; Truth Social never fetched the probe actor). A Cloudflare Worker received 200 for every account tried (WhiteHouse video and four-image posts, DonaldJTrumpJr, TeamTrump, realDonaldTrump).
- **Approach:** A Cloudflare Worker relay serves only `GET /status/<id>` to callers with a bearer secret, fetches the signed-out status API and returns its JSON. Linky asks the API first, then the relay when `TRUTH_SOCIAL_RELAY_URL` and `TRUTH_SOCIAL_RELAY_TOKEN` are set, then the archive and the page as before. Status API videos hosted on Truth Social's `static-assets` hosts get the same **Play video** link as archived ones. The page fallback also accepts image-only posts by using the page's first image, upgraded from `small` to `original`.
- **Library / dependency notes:** No new runtime dependency; the Worker is deployed with Wrangler (`npx wrangler`).
- **Acceptance criteria:**
  - A public post by any account (text, images or video) produces a card with author, text, first image or poster, a playable video link when the post has a video, counts and time, through the API or, when the API refuses the host, the relay.
  - The relay refuses missing or wrong tokens, other methods, paths and queries without an upstream request, and never forwards the token.
  - A reachable API skips the relay; a failing relay falls back to the existing sources; the token is sent only to the relay host.
  - Without the relay, image-only posts by any account show the post's image from page metadata.
  - Relay settings must be set together and validated at startup.
- **Test plan:** `tests/truth-social.test.ts` relay request shape and authorization, relay fallback, page image-only posts and settings validation; `tests/truth-social-relay.test.mjs` Worker authorization, routing and upstream handling. Live: relay checks from the bot host, then the reported link and other accounts' posts in Discord.
- **Out of scope:** Inline video playback in Discord; multi-image galleries; signed-in API access; residential proxies.
- **Bump:** minor
- **Status:** in-progress

### [FEAT-1793283259] PDF document cards
- [x] **Priority:** med
- **Area:** previews
- **File(s):** src/services/PdfPreview.ts, src/services/ArticlePreview.ts, src/services/PreviewRecovery.ts, src/commands/diagnose.ts, src/commands/fix.ts, src/commands/settings.ts, tests/pdf-preview.test.ts, tests/article-preview.test.ts, tests/manual-fix.test.ts, tests/social-links.test.ts, tests/fixtures/pdf.ts, docs/article-previews.md, docs/self-hosting.md, README.md
- **Req:** unknown
- **Depends on:** unknown
- **UI:** unknown
- **Why:** On 2026-10-29 `https://www.kitp.ucsb.edu/sites/default/files/YM_working_group.pdf` posted in a Linky channel stayed a bare link: Discord does not unfurl PDFs and the article reader accepts only HTML, so readers cannot see what the document is before opening it.
- **Approach:** Public HTTPS responses served as `application/pdf` (or `application/octet-stream` for a `.pdf` path) whose body starts with `%PDF-` are read up to a 4 MiB prefix within the existing article deadline and limits. A dependency-free, bounded parser reads direct and object-stream objects (Flate only, capped inflation), the document information dictionary (Title, Author, CreationDate), XMP `dc:title`, the page count, and the first page's text runs with ToUnicode/simple-encoding decoding. The title comes from document metadata, else the first page's largest-type heading, else the file name, and the footer names which. The card shows `PDF: <host>`, the title, the author when declared, page count and size, and the creation time.
- **Library / dependency notes:** No new dependency; PDF parsing libraries (pdf.js, pdf-parse) are large and execute far more of the format than a title card needs.
- **Acceptance criteria:**
  - The reported KITP PDF produces a card titled "Proof by OpenAI of the Existence of Quantum Yang-Mills theory", labelled `Title from first page`, with page count and size.
  - Metadata titles take precedence; documents without usable text fall back to a labelled file-name title.
  - Non-PDF bodies, oversized declared bodies beyond the prefix, encrypted documents' strings, malformed or hostile streams (inflation bombs, deep nesting, huge counts) never crash, block for long, or produce unlabelled guesses.
  - PDFs follow the Articles setting and every existing article delivery, confirmation and ownership rule.
- **Test plan:** `tests/pdf-preview.test.ts` parser units over generated PDFs (metadata, first-page heading, object streams, ToUnicode, file-name fallback, hostile inputs); `tests/article-preview.test.ts` lookup and card formatting through the fixture connector. Live: the reported URL from the production host.
- **Out of scope:** Rendering page thumbnails; extracting body text beyond the first page's heading; encrypted or password-protected PDFs; non-Flate filters; PDFs behind logins.
- **Bump:** minor
- **Status:** shipped-pending-migration
- **Implementation:** New dependency-free `src/services/PdfPreview.ts` parses a bounded object graph (direct and object-stream objects, Flate only with 4 MiB per stream and 24 MiB per file, a shared 4M-token budget, nesting depth 24, textual reference detection), the information dictionary and XMP title, the page count, and the first page's upright text runs through ToUnicode CMaps or simple encodings with TJ word spacing. Titles come from metadata (placeholders and editor file names rejected), else the largest upright first-page heading that reads as words, else the file name; encrypted files expose only page count and file name. `createArticleLookup` accepts `application/pdf` (or octet-stream for `.pdf` paths) with a PDF header, reads a 4 MiB prefix within the existing deadline, rate and cache limits, and `formatArticlePreview` renders `PDF document: <host>`, the literal title, declared author, page count, size, creation time and a footer naming the title source. Delivery, confirmation, settings and ownership rules are unchanged. The reported KITP PDF and nine other public PDFs (arXiv, IRS, Federal Reserve, Supreme Court, bitcoin.org and others) were checked locally; the reported one returns "Proof by OpenAI of the Existence of Quantum Yang-Mills theory", 2 pages, 87 KB. Same validation run as BUG-1793283258.

### [FEAT-1794395496] LinkedIn post cards with playable video
- [ ] **Priority:** high
- **Area:** previews, media
- **File(s):** src/services/LinkedIn.ts (new), src/services/ArticlePreview.ts, src/services/ArticlePosts.ts, src/services/SocialLinkService.ts, src/commands/fix.ts, src/commands/diagnose.ts, tests/linkedin.test.ts (new), tests/social-links.test.ts, tests/manual-fix.test.ts, docs/article-previews.md, README.md
- **Req:** unknown
- **Depends on:** unknown
- **UI:** unknown
- **Why:** On 2026-11-11 a user shared `https://lnkd.in/p/eMizdACP` (an RTX video post). Linky's article reader followed the redirect and produced a card with only the excerpt: LinkedIn's signed-out pages label every post `og:type=article` with a generic logo as `og:image` (no file extension, so it was rejected), and the video was absent. Users asked for the video and media to load.
- **Approach:** For `www.linkedin.com/posts/...` and `/feed/update/urn:li:...` pages (directly or after an `lnkd.in` redirect, with tracking parameters stripped), read the page's Schema.org `VideoObject` or `SocialMediaPosting` JSON-LD whose `@id` equals `og:url`. Build an authored card (author with profile and logo, post text, video title or shared-link title, first image and image count, reactions, comments, time). Download the JSON-LD `contentUrl` MP4 (signed `dms.licdn.com` address, ≤15 MiB, `video/mp4` with an `ftyp` header, 15 s window after metadata) and upload it with the card so Discord plays it; images stay on `media.licdn.com`. Without the upload, the card shows the poster and a Play video link. Discord lists the uploaded video as a message attachment, so the replacement attachment check and the manual-fix failure path account for it.
- **Library / dependency notes:** No new dependencies.
- **Acceptance criteria:**
  - The reported link resolves to `https://www.linkedin.com/posts/rtx_turn-bold-engineering-ideas-into-real-world-activity-7500720890129756160-lOHY` and prepares a card plus `linkedin-7500720890129756160.mp4`.
  - Image posts show their first image and image count; text posts show their text.
  - Foreign media hosts, unsigned addresses, mismatched JSON-LD and non-MP4 or oversized videos are rejected or fall back to the link.
  - Without Attach Files the card shows the poster and links the MP4; an unconfirmed manual card removes its video.
- **Test plan:** `tests/linkedin.test.ts` parser, formatter and lookup units through the fixture connector; `tests/social-links.test.ts` and `tests/manual-fix.test.ts` delivery wiring (both mutation-checked). Live: the reported link from the production host and a Discord playback check.
- **Out of scope:** LinkedIn Pulse articles (ordinary article cards), document/carousel posts, multi-image galleries, private or login-only posts, higher video renditions.
- **Bump:** minor
- **Status:** in-progress
- **Implementation:** New `src/services/LinkedIn.ts` (URL recognition, JSON-LD parser, signed-CDN validation, card formatter); `createArticleLookup` strips tracking from LinkedIn post addresses, routes post pages through the parser, and downloads the MP4 in an extended window; `prepareArticlePosts` keeps the video upload and a no-upload fallback card; delivery counts the video as a listed attachment; `/diagnose` recognizes LinkedIn posts. Local live lookup of the reported link: card plus a 2.28 MB MP4 in under 1 s. Discord playback from production not yet checked.

### [FEAT-1794398737] LinkedIn video posts as one block with the video inside
- [ ] **Priority:** med
- **Area:** previews, media
- **File(s):** src/services/ArticlePosts.ts, src/services/SocialLinkService.ts, tests/linkedin.test.ts, tests/social-links.test.ts, docs/article-previews.md, README.md
- **Req:** unknown
- **Depends on:** unknown
- **UI:** unknown
- **Why:** After FEAT-1794395496 shipped, a user saw the LinkedIn repost arrive as two pieces: the uploaded video above, and the post card below it. They asked for one block with the post text on top and the video underneath, as TikTok and Facebook embeds look. Discord does not play a video inside a bot-authored embed, so the card and the upload cannot merge as an embed.
- **Approach:** When the automatic repost is exactly one card with its uploaded video, and nothing else needs embeds or attachments (no copied source files, translation files, other cards or suppressed embeds), publish it as a Components V2 message, as Erome originals already are: the shared-by text, then a container in LinkedIn blue holding the author (with logo thumbnail), the linked title and post text, the video in a media gallery, and the counts and post time. Verification checks that the published container shows the uploaded video; no embed is involved. Every other case keeps the card plus attachment, or the poster and Play video link.
- **Library / dependency notes:** No new dependencies; discord.js 14 Components V2 types.
- **Acceptance criteria:**
  - The reported LinkedIn video link publishes one V2 message whose container holds the text, then the video, then counts and time; Remove and Details controls follow it.
  - A published message whose block lost the video is removed and the original kept.
  - Copied source attachments, missing Attach Files, multiple cards or text too long for one message keep the earlier card presentation.
  - Author names render as inert text (no markdown or mentions).
- **Test plan:** `tests/linkedin.test.ts` block builder and verifier units; `tests/social-links.test.ts` delivery wiring and fallbacks (mutation-checked). Live: the reported link in Discord after deploy.
- **Out of scope:** Manual `/fix` responses (they keep the card plus attachment), multi-video posts, other platforms.
- **Bump:** minor
- **Status:** in-progress
- **Implementation:** `articleVideoComponents` builds the block from the prepared card; `messageHasArticleVideo` confirms the published block shows the video; `SocialLinkService` publishes and finishes the block as Components V2 when it applies.

### [FEAT-1794400497] General article video blocks
- [x] **Priority:** high
- **Area:** previews, media, commands, tests, docs
- **File(s):** src/services/ArticlePosts.ts, tests/article-video.test.ts, docs/article-previews.md
- **Req:** unknown
- **Depends on:** unknown
- **UI:** unknown
- **Why:** Media-blocks charter I2: show Linky-authored post text and its media together.
- **Approach:** A single article-family card with one uploaded MP4 uses a Components V2 panel regardless of provider, including an uploaded avatar; verification rejects absent or unrelated media. Existing text and multi-card fallbacks remain.
- **Library / dependency notes:** Reuse discord.js Components V2 and existing bounded media requests; no new dependencies.
- **Acceptance criteria:**
  - [x] A single article-family card with one uploaded MP4 uses a Components V2 panel regardless of provider, including an uploaded avatar; verification rejects absent or unrelated media. Existing text and multi-card fallbacks remain.
  - [x] Named offline tests and mutation checks cover new critical assertions; docs match the result.
- **Test plan:** Inject synthetic HTTP/Discord responses; prove the change fails before, passes after, and fails under mutation.
- **Out of scope:** Native Discord fixer-domain unfurls, live playback claims, limits increases, merge and deployment.
- **Bump:** minor
- **Status:** shipped-pending-migration
- **Implementation:** General filename recognition and video selection support provider-independent MP4 panels with an uploaded avatar. Two new tests and eight existing LinkedIn tests pass; four mutation checks fail as expected. Limits and legacy fallbacks remain. See docs/article-previews.md, General video panels.

### [FEAT-1794400619] Truth Social video upload and inline playback
- [x] **Priority:** high
- **Area:** previews, media, commands, tests, docs
- **File(s):** src/services/TruthSocial.ts, src/services/ArticlePreview.ts, src/services/ArticlePosts.ts, tests/truth-social.test.ts, tests/social-links.test.ts, README.md, docs/article-previews.md
- **Req:** unknown
- **Depends on:** unknown
- **UI:** unknown
- **Why:** Media-blocks charter I1: show Linky-authored post text and its media together.
- **Approach:** Download allow-listed Truth Social or archive MP4s with a 15 MiB cap, ftyp header check and an independent window capped at 15 seconds. Single automatic video posts use the shared panel; download failures retain the poster and Play video card.
- **Library / dependency notes:** Reuse discord.js Components V2 and existing bounded media requests; no new dependencies.
- **Acceptance criteria:**
  - [x] Download allow-listed Truth Social or archive MP4s with a 15 MiB cap, ftyp header check and an independent window capped at 15 seconds. Single automatic video posts use the shared panel; download failures retain the poster and Play video card.
  - [x] Named offline tests and mutation checks cover new critical assertions; docs match the result.
- **Test plan:** Inject synthetic HTTP/Discord responses; prove the change fails before, passes after, and fails under mutation.
- **Out of scope:** Native Discord fixer-domain unfurls, live playback claims, limits increases, merge and deployment.
- **Bump:** minor
- **Status:** shipped-pending-migration
- **Implementation:** Truth Social uploads allow-listed API/archive MP4s through the shared LinkedIn download helper (15 MiB, video/mp4, ftyp, at most 15 seconds, pinned public DNS, no redirects or cookies). Avatar and video share the general panel; failure and permission/budget fallback restore original media URLs. tests/truth-social.test.ts and the Truth Social automatic panel test pass; five mutation checks fail as expected. README and article preview docs updated.

### [FEAT-1794400814] Single video panels for manual fixes
- [x] **Priority:** high
- **Area:** previews, media, commands, tests, docs
- **File(s):** src/commands/fix.ts, tests/manual-fix.test.ts, README.md, docs/article-previews.md
- **Req:** unknown
- **Depends on:** unknown
- **UI:** unknown
- **Why:** Media-blocks charter I3: show Linky-authored post text and its media together.
- **Approach:** Manual /fix and Apps Fix with Linky use the same single-video article panel, verify its media, retain controls, and roll back within Components V2 on missing media, cancellation, source edits or settings revocation.
- **Library / dependency notes:** Reuse discord.js Components V2 and existing bounded media requests; no new dependencies.
- **Acceptance criteria:**
  - [x] Manual /fix and Apps Fix with Linky use the same single-video article panel, verify its media, retain controls, and roll back within Components V2 on missing media, cancellation, source edits or settings revocation.
  - [x] Named offline tests and mutation checks cover new critical assertions; docs match the result.
- **Test plan:** Inject synthetic HTTP/Discord responses; prove the change fails before, passes after, and fails under mutation.
- **Out of scope:** Native Discord fixer-domain unfurls, live playback claims, limits increases, merge and deployment.
- **Bump:** minor
- **Status:** shipped-pending-migration
- **Implementation:** Both manual entry points publish the shared panel through publishManualMediaBlock. V2-only rollback removes uploads and media on missing gallery, source/settings changes, cancellation and publication errors; final controls retain and recheck the panel. tests/manual-fix.test.ts plus tests/manual-media.test.ts: 87 pass, zero skipped; five mutations caught. README and article docs updated.

### [FEAT-1794401068] Group standalone prepared Erome media and document compatibility fallbacks
- [x] **Priority:** high
- **Area:** previews, media, commands, tests, docs
- **File(s):** src/services/UploadedMedia.ts, src/services/EromeDelivery.ts, src/services/ArticlePosts.ts, src/services/SocialLinkService.ts, src/commands/fix.ts, src/commands/fixMedia.ts, tests/erome-delivery.test.ts, docs/media-blocks.md, docs/erome-previews.md, docs/article-previews.md, README.md
- **Req:** unknown
- **Depends on:** unknown
- **UI:** unknown
- **Why:** Media-blocks charter I4: show Linky-authored post text and its media together.
- **Approach:** Standalone Erome attachment delivery groups text and image or video into Components V2, with matching-media verification and rollback for automatic and manual paths. Record every remaining loose-media path and its compatibility constraint with file and line evidence.
- **Library / dependency notes:** Reuse discord.js Components V2 and existing bounded media requests; no new dependencies.
- **Acceptance criteria:**
  - [x] Standalone Erome attachment delivery groups text and image or video into Components V2, with matching-media verification and rollback for automatic and manual paths. Record every remaining loose-media path and its compatibility constraint with file and line evidence.
  - [x] Named offline tests and mutation checks cover new critical assertions; docs match the result.
- **Test plan:** Inject synthetic HTTP/Discord responses; prove the change fails before, passes after, and fails under mutation.
- **Out of scope:** Native Discord fixer-domain unfurls, live playback claims, limits increases, merge and deployment.
- **Bump:** minor
- **Status:** shipped-pending-migration
- **Implementation:** Standalone prepared Erome MP4/JPEG/PNG media now shares a V2 text/gallery container in automatic and manual delivery. The shared manual publisher keeps V2 rollback and revalidates controls. Matching gallery plus Erome metadata is mandatory; legacy byte-size checks remain for loose attachments. Ten mutation checks fail as expected; affected tests pass (336, zero skipped). docs/media-blocks.md inventories every remaining compatibility exception with source line references, and README/Erome/article docs explain the changes.

### [FEAT-1794401433] Confirm images are already inside authored cards
- [x] **Priority:** high
- **Area:** previews, media, commands, tests, docs
- **File(s):** docs/media-blocks.md, features.md
- **Req:** unknown
- **Depends on:** unknown
- **UI:** unknown
- **Why:** Media-blocks charter I5: show Linky-authored post text and its media together.
- **Approach:** Document source-line evidence and named offline tests for images inside article, MyAnimeList, LinkedIn, Truth Social, YouTube community and X translation embeds; leave working image formatting unchanged and test the evidence by removing image fields temporarily.
- **Library / dependency notes:** Reuse discord.js Components V2 and existing bounded media requests; no new dependencies.
- **Acceptance criteria:**
  - [x] Document source-line evidence and named offline tests for images inside article, MyAnimeList, LinkedIn, Truth Social, YouTube community and X translation embeds; leave working image formatting unchanged and test the evidence by removing image fields temporarily.
  - [x] Named offline tests and mutation checks cover new critical assertions; docs match the result.
- **Test plan:** Inject synthetic HTTP/Discord responses; prove the change fails before, passes after, and fails under mutation.
- **Out of scope:** Native Discord fixer-domain unfurls, live playback claims, limits increases, merge and deployment.
- **Bump:** minor
- **Status:** shipped-pending-migration
- **Implementation:** Confirmed six image-card families already use embed image fields on b803f79; no working image layout was rebuilt. docs/media-blocks.md records file:line evidence, named tests and rerun commands. Five image-field mutation runs cover all six families. The video-window regression uses a deterministic mocked clock so proof does not depend on wall-clock scheduling. No loose image-card path was found beyond the documented I4 compatibility cases.

### [FEAT-1795456232] Show Instagram posts as one caption-free block
- [x] **Priority:** high
- **Area:** previews, media, commands, settings, tests, docs
- **File(s):** src/services/InstagramPost.ts, src/services/InstagramPresentation.ts, src/services/SocialLinkService.ts, src/commands/fix.ts, src/commands/settings.ts, src/services/ServerSettings.ts, src/config.ts, src/bot.ts
- **Req:** unknown
- **Depends on:** unknown
- **UI:** unknown
- **Why:** Victor, 2026-11-23: Instagram captions are useless gibberish almost every time; load each post in one box.
- **Approach:** Remove caption parsing, translation and the translation budget. A lone Instagram post becomes one Components V2 block (sharer credit, @author heading, gallery of up to ten OGInstagram offload items); every other case uses the caption-free g.oginstagram.com gallery card. An unconfirmed automatic block is removed and the source kept with the Retry notice. Retire translate_instagram and instagram_presentation settings (saved values ignored on load) and the TRANSLATE_INSTAGRAM / GOOGLE_TRANSLATE_API_KEY env vars.
- **Library / dependency notes:** Reuse discord.js Components V2 and the existing bounded OGInstagram lookup; no new dependencies. Google Cloud Translation is no longer called.
- **Acceptance criteria:**
  - [x] No Instagram response, automatic or manual, contains caption text; a card whose embed or container shows post text does not count as a caption-free success.
  - [x] A message whose only link is one Instagram post with 1-10 offload items shows one block: credit, @author linked to the profile, gallery; Original post and Remove stay.
  - [x] Several links, failed or refused lookups, missing offload addresses and more than ten items use the g.oginstagram.com gallery card.
  - [x] An automatic block whose media Discord does not confirm within 10 s is deleted and the original kept with the Retry preview notice.
  - [x] Saved settings holding translateInstagram or instagramPresentation still load; /settings no longer offers them; an update naming them is rejected.
  - [x] Named offline tests and mutation checks cover the new critical assertions; docs match the result.
- **Test plan:** Synthetic OGInstagram Notes and Discord message payloads in tests/instagram-post, instagram-presentation, instagram-panel, delivery-recovery, social-links, manual-fix, settings-command, server-settings and config tests; mutation: restore a caption line in the block and confirm a named test fails.
- **Out of scope:** One-box blocks for other platforms (separate tickets), live Discord playback claims, a second Instagram provider.
- **Bump:** minor
- **Status:** shipped-pending-migration
- **Implementation:** Removed Instagram caption parsing, Google caption translation and its daily budget (CaptionTranslation.ts, TranslationBudget.ts deleted; InstagramTranslation.ts renamed InstagramPost.ts, author and media only). A lone post is one Components V2 block: sharer credit, @author heading linked to the profile, gallery of up to ten signed OGInstagram offload items; every other case rewrites to the caption-free g.oginstagram.com gallery card, and a card showing post text never counts as success. An automatic block Discord does not confirm within 10 s is deleted and the original kept with Retry preview; /fix keeps Original post. Retired translate_instagram and instagram_presentation (saved values ignored on load and dropped on next save; updates naming them rejected) and the TRANSLATE_INSTAGRAM / GOOGLE_TRANSLATE_API_KEY env vars. Mutations: caption-free check off (1 test fails), captioned provider host (22 fail), caption line in block (4 fail).
- **Docs:** README.md, CONTRIBUTING.md, VERIFICATION.md, .env.example, package.json, docs/instagram-media.md (renamed from instagram-translation.md), docs/media-blocks.md, docs/provider-checks.md, docs/product-roadmap.md, docs/self-hosting.md

### [FEAT-1795457628] Show every lone X post with media as one block
- [x] **Priority:** high
- **Area:** previews, media, commands, tests, docs
- **File(s):** src/services/TweetTranslation.ts, src/services/TweetPresentation.ts, src/services/TweetPanel.ts, src/services/SocialLinkService.ts, src/commands/fix.ts, src/commands/fixMedia.ts, src/bot.ts
- **Req:** unknown
- **Depends on:** unknown
- **UI:** unknown
- **Why:** Victor, 2026-11-23: "just make it load in one box (apply this same rule of loading in one box to all platforms)". Today only a lone translated X video post is one block; English posts, photo posts and untranslated posts use the native fixupx card.
- **Approach:** Look up the lone X status through FxTwitter whenever the X platform is enabled, independent of tweet translation (one shared bounded cache serves both). Build the existing Components V2 block (author, text, quotes, gallery) for any post whose media are all X-hosted photos, mp4 videos or GIFs. Translation on: non-English parts show the English translation and the Translated from label; translation off or English: original text, no label. Every other case keeps today's path. A block Discord does not confirm within 10 s is replaced by today's native card: the automatic handler deletes the block and publishes and verifies the native card; /fix sends the native card as a follow-up and deletes the block.
- **Library / dependency notes:** No new dependencies. FxEmbed API v2 status route (api.fxtwitter.com/2/status/{id}); ?lang=en only when translating. discord.js Components V2 as today.
- **Acceptance criteria:**
  - [x] A message whose only link is one visible X status whose post and quotes carry 1-10 media items, all photos on pbs.twimg.com or mp4 videos and GIFs on video.twimg.com, and whose sharer credit, text and quotes fit 4000 characters, shows one Components V2 block (author, text, quotes, gallery), automatic and /fix, English or not.
  - [x] English parts show their original text; non-English parts show the English translation with the Translated from label when tweet translation is on (TRANSLATE_TWEETS and the server preference), and the original text without a label when it is off.
  - [x] The post lookup needs only the X platform enabled; per status at most one FxTwitter request per 5 min (30 s after a failure), at most 100 cached and 8 pending lookups, 5 s fetch timeout, 1 MiB body cap, redirects refused.
  - [x] Text-only posts, several links, polls, broadcasts, external media, non-mp4 video, more than 10 items, too-long text and suppressed embeds keep today's path.
  - [x] A block whose media Discord does not confirm within 10 s is replaced by today's native card (automatic: block deleted, native card published and verified; /fix: native card as a follow-up, block deleted); no message ever shows the block and the card together.
  - [x] Reply/Replace, Original post and owner-only Remove, the sharer credit, mentions and per-platform switches behave as before.
  - [x] Named offline tests and mutation checks cover the critical assertions; docs match the result.
- **Test plan:** Synthetic FxTwitter v2 payloads and Discord message payloads in tests/tweet-translation, tweet-panel and bot tests; mutations: drop the English lookup, publish a native card beside the block, accept an m3u8 item, skip the native fallback, and confirm a named test fails each time.
- **Out of scope:** YouTube; external (non-X) media; live Discord playback claims; text-only posts as blocks.
- **Bump:** minor
- **Status:** shipped-pending-migration
- **Implementation:** A lone visible X status link with 1-10 X-hosted photos, MP4 videos or GIFs (post and quotes) is one Components V2 block (author, text, quotes, gallery), automatic and /fix, any language: fetchTweetStatus/createTweetLookup (TweetTranslation.ts) read FxTwitter v2 with ?lang=en only when translating, one shared bounded cache (5 min, 30 s after failure, 100 entries, 8 pending, 5 s, 1 MiB, redirect error) serving translation and blocks; tweetPostPanel (TweetPresentation.ts) gates on the X platform only; TweetPanel.ts refuses non-MP4 video. Unconfirmed block within 10 s: automatic deletes the block, publishes today's native card with a fresh nonce and verifies it (Reply mode keeps the reply reference); /fix sends the card as a follow-up (ephemeral when private), deletes the block and targets later edits at the follow-up (fixMedia.ts returns 'unconfirmed'). Tests: tweet-panel 11 added and 3 replaced (an unconfirmed block now falls back to the native card instead of the Retry notice), tweet-translation 5 added, bot request expectation updated. Mutations, each caught by named tests: untranslated lookup dropped, card content beside block, m3u8 accepted, lookup gated on translation, no automatic fallback, fallback without deleting the block, reused nonce, Reply reference dropped, manual no fallback, missing follow-up target, private card made public, cache never stores, cache limit removed, body cap 2 MiB, pending limit removed. npm run validate (Node v24.15.0; .nvmrc 26 unavailable locally): All checks passed; 1427/1427 tsx tests, ops 77 pass 8 skipped, deploy 27 PASS, audit 0 vulnerabilities.
- **Docs:** README.md, VERIFICATION.md, docs/media-blocks.md, docs/provider-checks.md, docs/self-hosting.md, src/commands/help.ts

### [FEAT-1795457637] Show a lone Bluesky image post as one block
- [x] **Priority:** high
- **Area:** previews, media, commands, tests, docs
- **File(s):** src/services/BlueskyPost.ts, src/services/BlueskyPanel.ts, src/services/SocialLinkService.ts, src/services/SocialProviders.ts, src/services/TweetTranslation.ts, src/commands/fix.ts, src/bot.ts, tests/bluesky-post.test.ts, tests/bluesky-panel.test.ts
- **Req:** unknown
- **Depends on:** unknown
- **UI:** unknown
- **Why:** Victor, 2026-11-23: "just make it load in one box (apply this same rule of loading in one box to all platforms)". Bluesky shares use the native bskx.app card today.
- **Approach:** Look up a lone bsky.app post on the public AppView (app.bsky.feed.getPostThread, depth 0, parentHeight 0) and build one Components V2 block: display name and @handle linked to the profile, post text with link facets, quoted post text, and a gallery of the cdn.bsky.app fullsize images. Video posts keep the bskx.app card: the AppView exposes only an HLS playlist on video.bsky.app and no mp4 Discord can fetch. Any other embed, a moderation label, a failed or mismatched lookup or several links keep today's card. An unconfirmed block falls back to the native card as for X.
- **Library / dependency notes:** No new dependencies. Public unauthenticated AppView at public.api.bsky.app; only the actor and record key of the shared post are sent.
- **Acceptance criteria:**
  - [x] A message whose only link is one bsky.app post whose AppView view carries 1-10 images (images or gallery embed, alone or with a quoted post) on cdn.bsky.app feed_fullsize, no moderation labels, and whose credit, text and quote fit 4000 characters, shows one block: display name and @handle linked to the profile, text, quoted text, gallery; automatic and /fix.
  - [x] Video posts, link cards, posts without images, labelled posts, missing or blocked posts, several links and any lookup failure keep the native bskx.app card.
  - [x] Lookup bounds: 5 s fetch timeout, 256 KiB body cap, redirects refused, credentials omitted, only https://public.api.bsky.app and only the actor and record key sent; cache 5 min (30 s after a failure), at most 100 entries and 8 pending lookups.
  - [x] The response must be a threadViewPost whose uri names the requested record key and author (DID or handle); otherwise Linky abstains.
  - [x] A block whose media Discord does not confirm within 10 s is replaced by the native bskx.app card, as for X.
  - [ ] Privacy and self-hosting docs name the AppView request; named offline tests and mutation checks cover the critical assertions.
- **Test plan:** Synthetic AppView getPostThread payloads (images, gallery, recordWithMedia, quote, video, labels, wrong uri, oversize body) in tests/bluesky-post and tests/bluesky-panel; mutations: accept an m3u8 or video embed, skip the uri check, drop the label check, and confirm a named test fails each time.
- **Out of scope:** Bluesky video blocks (no fetchable mp4); external link cards; authenticated AppView requests; YouTube.
- **Bump:** minor
- **Status:** shipped-pending-migration
- **Implementation:** BlueskyPost.ts reads one post from the public AppView (getPostThread, depth 0, parentHeight 0; only the actor and record key; 5 s, 256 KiB via readBoundedJson, redirect error, credentials omit) and accepts only a threadViewPost whose uri names the requested record key and author (DID, or handle compared lowercased), with no label on the post, record, author, quote or quote author, and an images, gallery, record or recordWithMedia(images or gallery) embed; images must be full-size cdn.bsky.app files under each author's DID; link facets become masked links by UTF-8 byte offset, malformed facets are ignored. Cache 5 min / 30 s, 100 entries, 8 pending, copies. BlueskyPanel.ts selects a lone visible bsky.app post with 1-10 images (post and quote) and builds the V2 block (display name, @handle linked to the profile, text, quote, gallery with alt text); wired into SocialLinkService (automatic) and fix.ts (/fix, Apps), with the X native-card fallback (block deleted, bskx.app card published and verified; manual follow-up). Video stays on bskx.app: the AppView video view has only an HLS playlist (video.bsky.app/watch/.../playlist.m3u8; mp4 probes 404). Tests: tests/bluesky-post.test.ts 9, tests/bluesky-panel.test.ts 11 (20 new). Mutations, each caught by named tests: another record key, another author handle, labels ignored, images from any host, video read as text post, body cap 512 KiB, redirects and credentials allowed, facet offsets split UTF-8, cache never stores, cache limit removed, pending limit removed, platform switch ignored, handle linked to the post, card text beside the block, no automatic fallback, no manual fallback. npm run validate (Node v24.15.0; .nvmrc 26 unavailable locally): All checks passed; 1447/1447 tsx tests, ops 77 pass 8 skipped, deploy 27 PASS, audit 0 vulnerabilities. AC6 left open: README and self-hosting name the AppView request, but the hosted privacy notice (https://linkybot.dev/privacy) is not in this repository and does not name it; Victor must update it.
- **Docs:** README.md, VERIFICATION.md (1.5, 3.7), docs/media-blocks.md, docs/provider-checks.md, docs/self-hosting.md, src/commands/help.ts; filed BUG-1795460094 for pre-existing VERIFICATION 1.5 drift

### [FEAT-1795540134] Run the deterministic V&V guard checks in one CI guard step
- [ ] **Priority:** low
- **Area:** ci
- **File(s):** .github/workflows/ci.yml, VERIFICATION.md, ops/
- **Req:** none (V&V protocol §3.1 item 4, run on 2026-11-24)
- **Depends on:** none
- **UI:** none
- **Why:** Two Stage 1 checks in VERIFICATION.md are fixed-predicate commands that need no stack, data or judgment, yet only run by hand at release time. They are 1.4 (no tracked .env, token, secret or .pem file) and 1.5 (no hard-coded provider host outside the catalogue modules). A regression can sit on main until the next protocol run.
- **Approach:** Put both checks in one guard script under ops/ (Node, no dependencies) with the current exclusions and accepted hits. Add one step to an existing CI job, for example 'Verification guards' in the Dependency audit job, so CI gate covers it. Then mark 1.4 and 1.5 in VERIFICATION.md as `(CI: Verification guards)`.
- **Library / dependency notes:** none
- **Acceptance criteria:**
  1. The guard script exits 0 at HEAD and exits 1 with the offending path when a tracked `.env` or a new provider host outside the catalogue is introduced (tests cover both). 2. CI runs it on every PR and push to main, and a failure fails CI gate. 3. VERIFICATION.md 1.4 and 1.5 carry the `(CI: …)` marker, and `fidelity.py VERIFICATION.md` reports MATCH for both.
- **Test plan:** node --test tests for the guard script with temporary git fixtures; `npm run validate`; fidelity.py.
- **Out of scope:** Gitleaks history scan (already the Secret scan job); review-only checks 1.6 and 1.7.
- **Bump:** minor
- **Status:** open
- **Log:**
  - 2026-11-24 protocol: move to CI: 1.4, 1.5 (release run on b5f281f).

### [FEAT-1795541460] Replies thread for X posts: a Replies button opens a public thread with the post's top replies
- [x] **Priority:** med
- **Area:** previews, settings, permissions
- **File(s):** src/services/ServerSettings.ts, src/commands/settings.ts, src/commands/help.ts, src/commands/diagnose.ts, src/commands/fix.ts, src/services/TweetPanel.ts, src/services/TweetTranslation.ts, src/services/TweetPresentation.ts, src/services/SocialLinkService.ts, src/services/RepostRegistry.ts, src/services/RepostPresentation.ts, src/services/YouTube.ts (sanitizer extraction), src/bot.ts, new src/services/ReplyThreads.ts, README.md, docs/self-hosting.md, docs/media-blocks.md
- **Req:** none (Victor request, 2026-11-24)
- **Depends on:** none
- **UI:** Discord: a 'Replies (N)' button on Linky's X posts; a public thread under the Linky post; /settings replies option; /help and /diagnose lines
- **Why:** Victor, 2026-11-24: "adding the comments or a comment section to each post or make the replies to the post visable/scrollable". A Discord message cannot scroll inside itself. Victor chose a public thread under the Linky post (over a private pager or inline top replies), X, Bluesky and YouTube as platforms, and off by default, so admins opt in.
- **Approach:** Two PRs. PR1 (prep) makes the ServerSettings reader accept an optional `replies: boolean` on the record and patch paths (ServerSettings.ts:28, :126) and refuse a non-boolean one, with no writer and no UI. PR1 is merged, deployed and host-confirmed (the Deploy run prints `LINKY_DEPLOYED_SHA` for PR1's merge SHA) before PR2 merges, so an automatic rollback of PR2 (ops/deploy.sh:83) restores an image that reads `replies`. PR2 adds `/settings replies:true|false` (default false; shown by /settings and /help) and the feature, in a shared module `src/services/ReplyThreads.ts` that the Bluesky, YouTube and later platform tickets reuse. Each platform adapter returns `{ N, countTime, r, m, replies[], orderLabel }`. Eligibility: single-link X posts Linky remembers (one-post block or fixupx card, automatic or /fix) in a guild text or announcement channel, whose FxTwitter status lookup returned a `replies` count above 0 (`parseStatus` gains `replies`). No button when no lookup was made or it returned nothing (multi-link messages, polls, broadcasts, external media), and none in forum or media posts, threads, voice or stage text chat, DMs or user-installed contexts. 'Replies (N)' is added in the final controls edit, after the post is confirmed and its ownership saved, in the repost controls row; never at first publish or on the native-card fallback before confirmation. N is X's `replies` count at publish; the label is not edited later. Click flow: check Create Public Threads and Send Messages in Threads locally with `permissionsFor` before any Discord call (a missing one is named privately). If `message.hasThread`, fetch the thread and reply privately with its link. Otherwise, inside a single-flight per message id: re-check the post is still Linky's tracked post, fetch and filter the replies (n = 0 or a failure gives a private 'No replies Linky can show for this post' and creates nothing), `startThread` (name 'Replies to @handle', truncated with '…' at 100 characters, control characters stripped, `autoArchiveDuration: 1440`), post the replies, reply privately with the link. Error 160004 means a thread exists: link it. A Linky-owned thread with `message_count` 0 (restart between create and post) is filled once. Archived or locked thread: link it. Deleted by a moderator (10003): private 'The replies thread for this post was removed' and no new thread. 160006: private 'This server has reached Discord's active thread limit'. Cooldowns: at most one new reply thread per user per 10 s and 3 per channel per 60 s (private 'Try again in a minute'); later clicks make no upstream request. Lookup: `https://api.fxtwitter.com/2/conversation/{id}` with the default `ranking_mode` (likes), 5 s timeout, 256 KiB cap, redirects refused, no credentials. Cache: 5 min on success, 30 s on failure, at most 100 entries and 8 in flight, storing only the parsed replies to show plus the counts. Abstain when `status.id` is not the post id or the shape is unknown. A reply whose `replying_to.status` is not the post id, or with `possibly_sensitive === true` (missing counts as false), is dropped and counted in m. Linky sorts by likes, then newest, and shows at most 10. Format: each reply is one Components V2 text display: '**Display name** [@handle](<profile URL>) · N likes · <t:unix:R>', the text cut to 500 characters through one shared sanitizer extracted from YouTube.ts:190-196 (control characters, Markdown escaping, `@` plus a zero-width space, link handling), '· has media' when it has media, and '[Open reply](<URL>)'. Replies are packed greedily: add replies until the next one would pass 3,800 characters or 10 per message. Every thread message sets flags `IS_COMPONENTS_V2 | SUPPRESS_EMBEDS | SUPPRESS_NOTIFICATIONS` and `allowed_mentions: { parse: [] }`; no buttons in the thread. Header: 'Showing n of N replies from X, most liked first (X returned r; Linky hid m). Count as of <time>.' N = the platform's reported reply count (nested replies included) from the click response's `status.replies`; r = all reply entries the one request returned, before filtering; m = entries Linky dropped, each counted once whatever the reason (not a direct reply, sensitive, labelled, hidden, invalid); n = the replies actually shown = min(10, r − m); n = 0 abstains. Cleanup: every path that deletes Linky's post (Remove, Retry, a source edit or deletion, the block fallback) deletes the owned parent, then runs thread cleanup in `afterReplacementRemoved`: delete only Linky's marked copied reply pages of Default/Reply type in the thread (bulk delete for 2 or more under 14 days old, otherwise one by one), rename the thread 'Replies removed' and archive it as its creator. Members' messages, other Linky previews and system messages stay. 10003 or lost access counts as done; other errors retry through the journal; cleanup waits for an in-flight creation for the same message. Deleting the thread itself needs Manage Threads, which Linky does not request (driver decision under Victor's delegation, 2026-11-24: Manage Threads would also expose every private thread). The module exposes this cleanup as an entry point that FEAT-1795541462 calls from YouTube expiry. Invite and diagnostics: /diagnose reports Create Public Threads and Send Messages in Threads when replies are on. The README invite adds Create Public Threads (permissions=311385254912 = 277025516544 + 2^35; driver decision under Victor's delegation, 2026-11-24); existing installs where Linky lacks the effective permission need an admin to grant it, and the README says so. Driver E58 refines cleanup: replies-off owned removal skips discovery only for a parent without HasThread and no in-process creation; registry paths use the fresh fetched parent, manual Remove uses the interaction snapshot. A bounded creation history prevents delayed false snapshots from discarding newly created pages; if full, discovery stays conservative. Missing parents still discover once. Transient thread cleanup transfers IDs durably to reply-cleanup.json after parent deletion so Retry can regenerate; capacity refusal or failed writes preserve the registry record and remove intent until cleanup succeeds or reaches a terminal code; manual/speculative capacity drops remain unchanged. Driver E65 keeps the existing could-not-remove-yet response while registry cleanup is pending, even if the parent was already deleted. Otherwise manual Remove reserves before deletion and sends a private failure notice on error. Invalid or unreadable cleanup intent is quarantined with a warning, never blocking startup. Cleanup pages oldest first and treats rename/archive permission denial as terminal. Error 160007 also maps to the thread-limit notice. The notice-rewrite window, offline/uncached deletion and inaccessible-thread gaps are documented; Manage Threads behavior remains a driver live-check item.
- **Library / dependency notes:** No new dependencies. `/2/conversation/{id}` is a documented FxEmbed API v2 endpoint (OpenAPI spec at FxEmbed commit 7ac5984; `ranking_mode` likes (default) or recency; logged-out cursor pages are empty). Upstream alternates between two X queries, so reply sets can differ between calls and order is not guaranteed; Linky sorts locally and abstains on any shape it does not recognise. Discord: Start Thread from Message (thread id = message id; 160004 when one exists; forum and media channels unsupported); Components V2 messages allow 4,000 characters across text displays. The hosted privacy notice (linky-web) must name the new request.
- **Acceptance criteria:**
  - [ ] `/settings replies:true|false` persists per server, defaults to false, and appears in /settings and /help; with it off, no Replies button or new request appears anywhere.
  - [ ] Rollback safety: PR1 makes the reader accept an optional boolean `replies` on the record and patch paths and refuse a non-boolean one, and is deployed and host-confirmed for its merge SHA before PR2 (the writer) merges. A test loads old-shape and new-shape servers.json.
  - [ ] With replies on, a single-link X post Linky remembers, in a guild text or announcement channel, whose status lookup returned `replies` above 0 carries 'Replies (N)' with N = X's count at lookup time, added only in the final controls edit after ownership is saved. Multi-link messages, polls, broadcasts, external media, posts with 0 or unknown replies, forum and media posts, threads, voice or stage chat, DMs and user-installed contexts get no button.
  - [ ] Replies are fetched and filtered before any thread is created; a failure, an unknown shape, a `status.id` mismatch or n = 0 gives a private 'No replies Linky can show for this post' and creates nothing.
  - [ ] The first click creates exactly one public thread (single-flight per message id; 'Replies to @handle', at most 100 characters; auto-archive 1440) and posts at most 10 replies sorted by likes then newest, packed greedily up to 3,800 characters and 10 per message, each with author, @handle profile link, sanitized text of 500 characters or fewer, likes, relative time and an Open reply link. Every thread payload sets V2, SUPPRESS_EMBEDS and SUPPRESS_NOTIFICATIONS and `allowed_mentions: { parse: [] }`.
  - [ ] `hasThread` or error 160004 links the existing thread; a Linky-owned thread with `message_count` 0 is filled once; an archived or locked thread is linked; a moderator-deleted thread (10003) gets a private 'removed' message and is not recreated; 160006 gives a private thread-limit message.
  - [ ] The thread's first message states 'Showing n of N replies from X, most liked first (X returned r; Linky hid m). Count as of <time>.' with N, r, m and n as defined in the Approach.
  - [ ] The lookup requests only https://api.fxtwitter.com/2/conversation/{id} (default ranking, 5 s, 256 KiB, redirects refused, no credentials; 5 min success and 30 s failure cache, at most 100 entries and 8 in flight). Replies whose `replying_to.status` is not the post id, or with `possibly_sensitive === true`, are dropped and counted in m.
  - [ ] At most one new reply thread per user per 10 s and 3 per channel per 60 s; later clicks make no upstream request.
  - [ ] Permissions are checked locally before any Discord call; a missing Create Public Threads or Send Messages in Threads gives a private message naming it; /diagnose reports both when replies are on; the README invite includes Create Public Threads (permissions=311385254912) and says existing installs may need an admin grant.
  - [ ] Every path that deletes Linky's post (Remove, Retry, a source edit or deletion, the block fallback) deletes Linky's own thread messages, renames the thread 'Replies removed' and archives it; members' messages stay; 10003 or lost access counts as done and other errors retry through the journal; cleanup waits for an in-flight creation. Retry and Original post otherwise behave as before.
  - [ ] README, docs/self-hosting.md and docs/media-blocks.md describe the feature, the request, the setting and the rollback caveat for images older than PR1 (docs/self-hosting.md:100), and the hosted privacy notice names the FxTwitter conversation request (linky-web).
- **Test plan:** Synthetic FxTwitter conversation payloads in a new tests/reply-threads.test.ts: normal, unsorted (sorted locally), `possibly_sensitive` true and missing, a mismatched `replying_to` (dropped, counted in m), a `status.id` mismatch and a wrong shape (abstain), oversize, redirect, timeout, 0 replies, the failure cache. Packing at the 4,000-character boundary and with long names. Fake Discord client flows: setting off; missing permission (no Discord call made); ineligible channel types and multi-link posts; concurrent clicks give one thread; `hasThread` and 160004 link the thread; `hasThread` with `message_count` 0 fills once; archived thread linked; moderator-deleted thread not recreated; 160006; per-user and per-channel cooldowns; cleanup after Remove, Retry, a source edit and the block fallback; Remove racing a click; flags and allowed mentions asserted on every sent payload. Settings compatibility: old and new servers.json load and a non-boolean `replies` is refused. Mutation checks: drop the `replying_to` filter, drop the sort, use a fixed 5 per message, allow redirects, raise the cap, create a thread per click, skip the permission pre-check, skip cleanup on Retry, enable by default. After deploy, a live check in the test server: one X post, button, thread content with no link previews, a second create handled as 160004, Remove, a moderator-deleted thread not recreated, then delete the fixtures.
- **Out of scope:** Bluesky, YouTube, LinkedIn and Truth Social (separate tickets that depend on this one). Instagram, Facebook and Twitch clips: no rule-compliant source (Instagram and Facebook comments need the content owner's token or Meta App Review; Twitch clips have no comments; driver-replies-research L1, 2026-11-24). TikTok (only an unofficial scraper, against TikTok Terms 3.4: rejected) and Reddit (signed-out access blocked; the official Data API needs Reddit's approval and terms acceptance: deferred); driver decisions under Victor's delegation, 2026-11-24. Reply media galleries, nested replies, paging past the first FxTwitter page, Refresh or More buttons, syncing a thread after creation, deleting the thread itself (needs Manage Threads, not requested), and a private pager.
- **Bump:** minor
- **Assignee:** Victor Ivanov
- **Status:** shipped-pending-migration
- **Implementation:** Public opt-in X reply threads with bounded adapter, marked-page cleanup, durable manual intent and registry refresh preservation. E65 closes MED E58-QA-1: refused deferred cleanup transfers (capacity or failed write) propagate so registry record/remove intent and Retry refresh intent remain durable after parent deletion. Existing could-not-remove-yet notice reports pending cleanup. Narrow QA/security PASS, restart success/10003 probes 4/4, mutation caught, full validation 1581 TS + 77 ESM, 8 baseline Windows skips, 27 deploy checks, audit zero. Prior two LOWs and N1-N9 unchanged and returned to driver; live/CI/privacy gates remain driver-owned.
- **Docs:** README.md, docs/self-hosting.md, docs/media-blocks.md, settings/help/diagnose; E65 self-hosting corrects registry transfer refusal to retain durable intent. Manual/gateway capacity policy and prior LOWs/N1-N9 unchanged. Hosted privacy, live permission checks and deployment are driver-owned. PR acceptance/mutation/Remaining gaps and final F2 evidence updated; no migration.
- **Log:**
  - 2026-11-24 scoping: Victor chose a public thread, X + Bluesky + YouTube, and off by default. Live probes on 2026-11-24: FxTwitter /2/conversation returned 10 replies (29 KB) for a NASA post with 47 replies, and its cursor page returned 0; the Bluesky AppView getPostThread depth=1 returned 198 of 232 replies (299 KB); Instagram comments without login returned 404.
  - 2026-11-24 driver: driver-replies-research (lead L2, verified by the driver: invite bits decoded, FxTwitter ranking_mode re-probed, repo lines checked): two-PR settings rollout; eligibility and button-placement rules; local likes sort; drop-not-abstain for mismatched replies; greedy packing at 3,800 characters; V2 + SUPPRESS_EMBEDS + SUPPRESS_NOTIFICATIONS; error mapping 160004/160005/160006/10003; cooldowns; thread cleanup on every delete path (own messages deleted, thread renamed and archived). Out of scope reason corrected: LinkedIn needs no login and Twitch clips have no comments. Open for Victor: invite gains Create Public Threads; Manage Threads to delete threads.
  - 2026-11-24 driver: driver-replies-research report review (GPT-6.1 Sol): count definitions fixed (r = all entries returned before filtering; m = dropped once for any reason; n = shown); Remove semantics made conditional on Victor's Manage Threads decision.
  - 2026-11-24 decision: Invite gains Create Public Threads (311385254912); Remove keeps delete-own-messages + rename + archive without Manage Threads; TikTok via tikwm rejected; Reddit official API deferred. Victor delegated the decision to the driver on 2026-11-24 ("have the driver do all that it doesnt need me I allow it"); the driver chose the recommended option.
  - 2026-11-24: PR1 (settings reader) opened: optional boolean replies accepted on stored-record and patch paths; legacy records and strict unknown-field rejection preserved; PR2 owns writer, UI and reply behaviour.
  - 2026-11-24 driver: E58 final extra round authorized by Victor through the driver: accepted R2 fixes implemented and full panel completed. Runtime validation passes, but independent QA confirms MED E58-QA-1: full reply-cleanup journal drops deferred intent after parent deletion. No more runtime cycles; return to driver/Victor. Keep in-progress pending their disposition; do not merge.

### [FEAT-1795541461] Replies thread for Bluesky posts
- [ ] **Priority:** med
- **Area:** previews
- **File(s):** src/services/BlueskyPost.ts, src/services/BlueskyPanel.ts, src/services/ReplyThreads.ts, docs/media-blocks.md, docs/self-hosting.md, README.md
- **Req:** none (Victor request, 2026-11-24)
- **Depends on:** FEAT-1795541460
- **UI:** Discord: the same 'Replies (N)' button and public thread on Linky's Bluesky posts (block or bskx.app card)
- **Why:** Victor chose Bluesky as one of the three platforms for the replies thread (2026-11-24).
- **Approach:** Reuse the replies thread from FEAT-1795541460 (ReplyThreads module, shared format, greedy packing, header, cooldowns, cleanup). N is the AppView `replyCount` from the post lookup Linky already makes; no button when that lookup returned nothing (video, link cards, labelled posts, quotes of quotes; BlueskyPost.ts:150-170) or the post is labelled. On click, request `app.bsky.feed.getPostThread` on public.api.bsky.app with depth=1 and parentHeight=0, sending only the `at://` uri built from the actor and record key as BlueskyPost.ts:179 does, with a 5 s timeout, a 1 MiB cap, redirects refused and credentials omitted. Cache 5 min on success and 30 s on failure, at most 100 entries of at most 25 parsed replies, at most 8 in flight. Accept only a threadViewPost whose record key and author (DID or handle, compared as `parseBlueskyThread` does) match the request; the response uri uses the DID even when the request used a handle. Do not reuse that parser's rule against embeds. Keep threadViewPost replies whose `record.reply.parent.uri` equals the anchor's DID-form uri. Drop blocked or notFound entries, replies listed in `threadgate.record.hiddenReplies`, and replies with a label on the post or its author (including `!no-unauthenticated`), counting each in m. Sort by likeCount descending, then newest, and show the top 25 with the shared greedy packing. Links use `https://bsky.app/profile/<did>/post/<rkey>` to bound their length. Thread name 'Replies to @handle', truncated with '…' at 100 characters (handles reach 253). Header: 'Showing n of N replies from Bluesky, most liked first (Bluesky returned r; Linky hid m). Count as of <time>.', with N the anchor's `replyCount` in the click response. An oversize body gives a private 'This post has too many replies for Linky to load' (about 690 direct replies at the measured 1,519 B per reply). Other failures abstain as in FEAT-1795541460.
- **Library / dependency notes:** No new dependencies; the AppView endpoint is already used, and only depth changes. `app.bsky.unspecced.getPostThreadV2` (`above=false&below=1&sort=top`) matches Bluesky's own order but its lexicon says it will change; stable v1 plus a local likes sort is used (V2 rejected while unstable; driver decision under Victor's delegation, 2026-11-24).
- **Acceptance criteria:**
  - [ ] With replies on, a Bluesky post Linky publishes whose replyCount is above 0 carries 'Replies (N)' with N = the AppView replyCount at lookup time; no button when the post lookup returned nothing or the post is labelled.
  - [ ] The click requests only public.api.bsky.app getPostThread (depth=1, parentHeight=0, an at:// uri from the actor and record key) within 5 s, 1 MiB, redirects refused and no credentials, cached 5 min (30 s on failure); an anchor whose record key or author (DID or handle) does not match abstains privately, and an oversize body gives the private too-many-replies message.
  - [ ] The thread shows at most 25 direct replies (parent uri = the anchor's DID-form uri), sorted by likes then newest, with DID-form links; blocked, notFound, author-hidden (`threadgate.record.hiddenReplies`) and labelled replies (post or author, including `!no-unauthenticated`) are dropped and counted in m.
  - [ ] The header reads 'Showing n of N replies from Bluesky, most liked first (Bluesky returned r; Linky hid m). Count as of <time>.' and the thread name is truncated with '…' at 100 characters.
  - [ ] Format, packing, mentions, flags, a single thread per message, permissions, cooldowns and cleanup behave as in FEAT-1795541460.
  - [ ] docs/media-blocks.md and docs/self-hosting.md name the depth=1 request, and the hosted privacy notice covers it.
- **Test plan:** Synthetic getPostThread depth=1 payloads in tests/reply-threads.test.ts and tests/bluesky-post.test.ts: unsorted input, labels on post and author including `!no-unauthenticated`, `threadgate.record.hiddenReplies`, blocked and notFound, a wrong parent uri, a DID-form response to a handle request, a 253-character handle in the thread name, oversize at 1 MiB. Mutations: skip the hidden filter, skip the label filter, accept another parent, compare uris as plain strings, sort by time only, raise the cap. Live check: one Bluesky post in the test server.
- **Out of scope:** Nested replies (depth > 1), quote-posts as replies, reply images, authenticated AppView, getPostThreadV2 while it is unstable.
- **Bump:** minor
- **Status:** open
- **Log:**
  - 2026-11-24 driver: driver-replies-research (lead L2; driver recount of the 2026-11-24 depth=1 probe: 113 direct replies, 4 of 6 author-hidden replies present, 20 replies with author label !no-unauthenticated): add hiddenReplies filter, DID/handle anchor match, DID-form links, shared packing and header, oversize message. Stable v1 kept over getPostThreadV2 (option for Victor).
  - 2026-11-24 decision: Stable getPostThread v1 with local likes sort kept over getPostThreadV2. Victor delegated the decision to the driver on 2026-11-24 ("have the driver do all that it doesnt need me I allow it"); the driver chose the recommended option.

### [FEAT-1795541462] Replies thread for YouTube videos (top comments)
- [ ] **Priority:** low
- **Area:** previews, youtube
- **File(s):** src/services/YouTube.ts, src/services/ReplyThreads.ts, docs/youtube-embedding-research.md, docs/self-hosting.md, README.md
- **Req:** none (Victor request, 2026-11-24)
- **Depends on:** FEAT-1795541460
- **UI:** Discord: a 'Comments (N)' button in Linky's existing YouTube controls row (single-video messages, counts-and-comment display); a public thread under that message
- **Why:** Victor chose YouTube as one of the three platforms for the replies thread (2026-11-24). Linky already shows YouTube's top comment, but not the rest.
- **Approach:** Reuse the replies thread from FEAT-1795541460. Add a `linky:yt:replies:<videoId>` 'Comments (N)' button to the existing YouTube controls row (YouTubeControls.ts), only on single-video messages and only when the server's `youtubeDisplay` is `counts-and-comment`; an admin who chose counts only opted out of comments. N is `statistics.commentCount` from the existing videos.list call; no button when it is absent or 0. The button expires with the other YouTube controls after 24 h, and its click passes the same `canView` check (YouTubeStats.ts:108-112). On click, call `commentThreads.list` with part=snippet, the videoId, order=relevance, maxResults=25, textFormat=plainText and `fields=items(id,snippet(videoId,topLevelComment(id,snippet(textDisplay,authorDisplayName,authorChannelUrl,likeCount,publishedAt))))` with no `pageToken` (confirm these field names against the comments resource docs and in the live check), through the existing `request()` guard with the operator key; that costs 1 quota unit per uncached click. `request()` gains a per-call byte cap (fixed at 128,000 today, YouTube.ts:94); this call uses 5 s and 256 KiB. Cache in a separate map of at most 100 videos with the same 5 min TTL, not in the 1,000-entry statistics cache; the first relevance item may also serve as the top comment. commentsDisabled already returns null through the non-quota 403 path; quota errors, an empty result or a failure abstain privately, and a quota error is logged as it is today. Any 400 blocks every YouTube lookup for 1 h (YouTube.ts:100), so the exact parameters and `fields` string are asserted in a test. Show top-level comments only, in YouTube's relevance order (Linky does not re-sort), with the shared greedy packing and sanitizer. The header names YouTube as the source (Developer Policies III.F.2.a): 'Showing n of N comments from YouTube, in YouTube's relevance order. Count as of <publish time>.' commentThreads returns no total, so N is the publish-time count. Each comment links to the video; the `&lc=<commentId>` form is used only if the live check confirms it. Retention (driver decision under Victor's delegation, 2026-11-24): following Linky's existing reading of Developer Policies III.E.4 for persistent Discord content (docs/youtube-embedding-research.md:52-54), when the YouTube controls expire (24 h) the existing durable cleanup queue (YouTubeStats.ts, thread id = message id, no new storage) calls FEAT-1795541460's cleanup entry point: Linky deletes its comment messages in the thread, then renames and archives the thread, retrying on failure. Without `YOUTUBE_API_KEY` the feature is off for YouTube.
- **Library / dependency notes:** No new dependencies. YouTube Data API v3 quota is 10,000 units/day by default; each uncached click costs 1 unit.
- **Acceptance criteria:**
  - [ ] With replies on, a YouTube key configured and `youtubeDisplay` = counts-and-comment, a single-video statistics message whose commentCount is above 0 carries a `linky:yt:replies:<videoId>` 'Comments (N)' button in the YouTube row, with N = commentCount at lookup time. Counts-only servers, multi-video messages, no key or no count mean no button; the button expires with the YouTube controls and its click passes `canView`.
  - [ ] The click makes one commentThreads.list request (part=snippet, order=relevance, maxResults=25, textFormat=plainText and the exact `fields` string, asserted in a test) within 5 s and 256 KiB through `request()` with a per-call byte cap, cached 5 min in a separate map of at most 100 videos; commentsDisabled, quota errors, empty results and failures abstain privately.
  - [ ] The thread shows at most 25 top-level comments in YouTube's relevance order, in the shared format and packing, each linking to YouTube, under a header that names YouTube as the source and the count time, with mentions disabled and embeds suppressed.
  - [ ] When the YouTube controls expire (24 h), the durable cleanup queue deletes Linky's comment messages in the thread and renames and archives it, retrying on failure.
  - [ ] Docs state the per-click quota cost and the 24 h removal of copied comments, and the hosted privacy notice covers the request.
- **Test plan:** Synthetic commentThreads payloads (normal, commentsDisabled 403, quota 403, empty, oversize) in tests/reply-threads.test.ts and tests/youtube.test.ts; the exact parameters and `fields` string; the per-call byte cap; expiry deletes the thread messages and archives the thread; counts-only display and multi-video messages show no button. Mutations: skip the key check, ignore commentsDisabled, raise maxResults, change the `fields` string, skip expiry cleanup, allow the button with counts-only. Live check: one public video in the test server, confirming that the `fields` string is accepted and whether `&lc=` links open the comment.
- **Out of scope:** Comment replies (nested), live chat, Shorts-specific layouts, re-sorting by likes, keeping copied comments past the 24 h control expiry.
- **Bump:** minor
- **Status:** open
- **Log:**
  - 2026-11-24 driver: driver-replies-research (lead L2; YouTube docs read, no API call): button only on single-video counts-and-comment messages; fields partial response; per-call byte cap in request(); separate 100-entry cache; exact-parameter test because any 400 blocks YouTube lookups for 1 h; YouTube attribution; copied comments removed at the 24 h control expiry under Linky's existing III.E.4 reading. Open for Victor: whether the existing [link] replacement fits III.I.4.
  - 2026-11-24 driver: driver-replies-research report review (GPT-6.1 Sol): L2's exact fields string written into Approach; 24 h retention of copied comments marked proposed, pending Victor.
  - 2026-11-24 decision: Copied comments deleted at the 24 h control expiry; the existing [link] replacement kept as display sanitising under III.I.4. Victor delegated the decision to the driver on 2026-11-24 ("have the driver do all that it doesnt need me I allow it"); the driver chose the recommended option.

### [FEAT-1795544485] Comments thread for LinkedIn posts from the page's own JSON-LD comments
- [ ] **Priority:** low
- **Area:** previews
- **File(s):** src/services/LinkedIn.ts, src/services/ArticlePreview.ts, src/services/ReplyThreads.ts, docs/article-previews.md, docs/self-hosting.md, README.md
- **Req:** none (Victor request, 2026-11-24, via driver-replies-research)
- **Depends on:** FEAT-1795541460
- **UI:** Discord: a 'Comments (N)' button on Linky's LinkedIn card; a public thread under that message
- **Why:** Victor asked for smart ways to show replies on platforms the first three tickets leave out (2026-11-24). The signed-out LinkedIn post page that Linky already fetches carries 6 to 9 Schema.org `Comment` entries in its JSON-LD, which `parseLinkedInPost` (src/services/LinkedIn.ts:96-130) throws away today (lead L1 probes li-02 to li-04; driver re-probe 2026-11-24: 200, 154,680 B, `commentCount` 406, 6 Comment entries).
- **Approach:** Reuse the replies thread from FEAT-1795541460 (ReplyThreads module, placement rules, single-flight, permissions, cooldowns, packing, flags, cleanup). Source: the `comment` array of the same `SocialMediaPosting` or `VideoObject` whose `@id` equals `og:url`, which `parseLinkedInPost` already validates. N is the comment count the card already shows (`commentCount` or the CommentAction counter); no button when it is 0 or unknown. No extra request while the 5 min article cache holds the page (ArticlePreview.ts:713); otherwise the click makes one GET of the canonical `/posts/` permalink through the existing pinned, cookie-free article fetch (5 s, head only, 512 KiB, redirects refused). Keep `@type: Comment` entries with non-empty text (at most 3,000 characters) and an author name (at most 300 characters); likes come from the LikeAction counter and the time from an ISO `datePublished`; anything else is dropped and counted in m. Show LinkedIn's order as served, at most 10. Each comment shows the author's plain name (the page gives no profile link), the text cut to 500 characters through the shared sanitizer (links become `[link]`, mentions are inert), likes and a relative time; the header links the post. Header: 'Showing n of N comments from LinkedIn's public page, in LinkedIn's order (LinkedIn returned r; Linky hid m). Count as of <time>.' A page failure, an `@id` mismatch or 0 usable entries gives a private 'No comments Linky can show for this post' and no thread. Comment text stays only in the 5 min memory cache, as the YouTube top comment does.
- **Library / dependency notes:** No new dependencies and no new host. LinkedIn User Agreement §8.2 (https://www.linkedin.com/legal/user-agreement, effective 2025-11-03) bans scraping and copying content without the owner's consent; the shipped LinkedIn card already relies on the same clause, and comments add commenters' names and text, so Victor confirms this risk before implementation. The official Comments API is not usable (organization admins or select developers only).
- **Acceptance criteria:**
  - [x] Victor's acceptance of the LinkedIn §8.2 risk for commenters' content is recorded in the Log before work starts.
  - [ ] With replies on, a LinkedIn card whose comment count is above 0 carries 'Comments (N)' with N = the count the card shows; 0 or unknown means no button.
  - [ ] The click reuses the cached page or makes one cookie-free GET of the canonical /posts/ permalink (5 s, head only, 512 KiB, redirects refused); an `@id` mismatch, a failure or 0 usable entries gives a private message and no thread.
  - [ ] The thread shows at most 10 Comment entries in LinkedIn's order with plain author name, sanitized text of 500 characters or fewer, likes and relative time; invalid entries are dropped and counted in m; the header states n, N, r, m and the count time.
  - [ ] Format, mentions, flags, a single thread per message, permissions, cooldowns and cleanup behave as in FEAT-1795541460.
  - [ ] docs/article-previews.md and docs/self-hosting.md describe the comments source, and the hosted privacy notice covers it.
- **Test plan:** Captured-shape JSON-LD fixtures in tests/reply-threads.test.ts and tests/linkedin.test.ts: 6 and 9 comments, an empty `comment` array, an `@id` mismatch, entries without text or author, overlong text and names, a non-ISO date. Mutations: skip the `@id` check, keep entries without an author, raise the cap, follow redirects. Live check from the bot host: one public LinkedIn post shows the same comments (this is the first unproven step: the bot host and Linky's production agent were not tested).
- **Out of scope:** Comment replies, reactions breakdown, commenter profile links (the page has none), LinkedIn's official API, and pages that need a login.
- **Bump:** minor
- **Status:** open
- **Log:**
  - 2026-11-24 decision: LinkedIn User Agreement 8.2 risk for commenters' names and text accepted: Victor delegated the decision to the driver on 2026-11-24 ("have the driver do all that it doesnt need me I allow it"); the driver chose the recommended option (accept; the shipped card relies on the same clause).
