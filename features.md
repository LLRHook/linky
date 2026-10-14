# Linky — Feature Tracker

This file is the working list of features to implement. New features are appended
here as they are scoped. When a feature is shipped, tick its checkbox and migrate
the entry (with the implementation note) to `CHANGELOG.md` so this file stays
focused on outstanding work.

## Conventions

Each entry uses the form:

```
### [<id>] <short title>
- [ ] **Priority:** crit | high | med | low
- **Area:** bot | commands | providers | previews | media | regional | archive | ops | ci | docs | tests | security | perf
- **File(s):** comma-separated paths the feature will create or modify
- **Why:** product / user motivation, with doc or roadmap section if relevant
- **Approach:** the design — concrete enough that an implementer doesn't have to ask
- **Library / dependency notes:** evaluation of any third-party deps, with the recommendation called out explicitly
- **Acceptance criteria:** bullet checklist of what "done" means
- **Test plan:** unit / integration / E2E coverage to land with the feature
- **Out of scope:** explicit "we are NOT doing X in this ticket"
- **Bump:** major | minor | patch  (version impact when shipped; a feature defaults **minor**, a breaking change is **major** — `major` flags a breaking change for the user's planned major release; it does not auto-bump X, which only the user cuts at `/release`)
- **Status:** open | in-progress | shipped-pending-migration
```

Tick `- [x]` once verified shipped. The implementer also adds an
`**Implementation:**` line summarising the diff before migrating the entry to
`CHANGELOG.md`.

Ids are UNIX-epoch timestamps (`FEAT-$(date +%s)`), never sequential. Append new
entries at the end of `## Open`; change `Status:` in place; the only physical move
(`## Open` to `## Shipped`) happens at `/protocol-v-and-v` migration.

Priority guide: crit / high / med / low.

## Lifecycle
1. **File:** new entries under `## Open` with the full template.
2. **Implement:** flip status to `in-progress`, write code + tests.
3. **Verify:** set `shipped-pending-migration`, tick checkbox, add `**Implementation:**` line.
4. **Migrate:** move to `## Shipped`, append a one-liner to `CHANGELOG.md / Unreleased / Added` (or `Changed`).

---

## Open

### [FEAT-1790270880] Discord embed and client playback stages for the preview corpus
- [ ] **Priority:** high
- **Area:** previews, providers, tests, ops
- **File(s):** ops/preview-corpus.json, ops/provider-metadata-check.mjs, ops/delivery-archive-report.mjs, docs/provider-checks.md
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
- **Why:** Every Discord message in an enabled channel runs link detection and rewriting on the event loop. The only measurement is a synthetic probe inside `benchmarks/erome-scheduling.mjs` (ordinary rewrite p95 below 1 ms during Erome encoding), which needs Docker, FFmpeg and a generated video and is not a repeatable check. No budget is stated anywhere, so a super-linear regex or per-link await added to the hot path would ship unnoticed.
- **Approach:** Add a small Node-only benchmark (`benchmarks/link-rewrite.mjs`) that feeds a fixed corpus of 1,000 messages (mixed platforms, hidden links, `!nolinky`, article candidates, plain text) through the rewrite function and prints p50/p95/max; add one `node:test` assertion that the p95 stays under a confirmed budget (proposed 2 ms per message on the CI runner, to be confirmed by the user) so the check runs in `npm test` without network.
- **Library / dependency notes:** Use `perf_hooks` from Node; no benchmark library needed.
- **Acceptance criteria:**
  - `node benchmarks/link-rewrite.mjs` prints p50/p95/max for the fixed corpus in under ten seconds.
  - A test in `npm test` fails when the p95 exceeds the confirmed budget.
  - `VERIFICATION.md` Stage 4 records the budget and the measured baseline.
- **Test plan:** The assertion itself plus a fixture check that the corpus covers every platform in `SocialProviders`.
- **Audit note (2026-09-30):** `PERFORMANCE_AUDIT.md` and `benchmarks/link-handling.cjs` establish exploratory CPU measurements and a reusable synthetic corpus. This ticket remains open because the budget and CI guard have not shipped.
- **Out of scope:** Measuring Discord publication latency; Erome scheduling (already benchmarked).
- **Bump:** patch
- **Status:** open

### [FEAT-1790270882] Container health check for the bot process
- [ ] **Priority:** low
- **Area:** ops, bot
- **File(s):** docker-compose.yml, Dockerfile, ops/deploy.sh, src/index.ts, tests/deploy.test.sh
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
- **Implementation:** `facebook` platform and `facebed` provider in `SocialProviders.ts` (video-ID identity, strict hosts); `/share/r|v/` resolution in `MobileShareLinks.ts`; video required and eight-second Gateway window in `PreviewRecovery.ts` / `PreviewWatcher.ts`; `/settings facebook:`, setup menu, diagnostics and archive platform lists; corpus entry and docs. Live: the reported link resolved from Hostinger, Discord built a 720×1280 video embed that Linky's matcher accepted and Chrome Discord played (`docs/provider-checks.md`).
- **Status:** shipped-pending-migration

### [FEAT-1791981013] Extract repost eligibility, permission, link and expectation helpers from SocialLinkService
- [x] **Priority:** low
- **Area:** bot, previews
- **File(s):** src/services/SocialLinkService.ts, src/services/RepostEligibility.ts (new), src/services/RepostDelivery.ts (new), tests/repost-eligibility.test.ts (new)
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
- [ ] **Priority:** high
- **Area:** ci, docs
- **File(s):** .github/workflows/ci.yml, ops/prompt-workflow.mjs, tests/prompt-workflow.test.mjs, tests/ci-workflow.test.mjs (new), VERIFICATION.md, CONTRIBUTING.md, README.md, docs/self-hosting.md, docs/discord-prompt.md
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
- **Status:** in-progress
- **Implementation:** `ci.yml` runs `Secret scan`, `Dependency audit`, `Build (Node 22|24|26)` and `Production container` independently; `CI gate` (`needs` all, `if: always()`) fails unless every result is `success` (gate script exercised with success/failure/skipped/cancelled/empty inputs). The prompt publisher's `REQUIRED_CHECKS` is `CI gate` + `PR evidence`; `tests/ci-workflow.test.mjs` pins the gate's needs and the publisher names (mutation: dropping `audit` from needs fails it). Remaining: switch `main` protection to `CI gate` + `PR evidence` after this branch merges and record the `gh api` output; status stays in-progress until then.
- **Docs:** VERIFICATION, CONTRIBUTING, README, docs/self-hosting.md, docs/discord-prompt.md.

### [FEAT-1791990468] Acceptance evidence required in every pull request
- [x] **Priority:** high
- **Area:** ci, docs
- **File(s):** .github/pull_request_template.md (new), .github/workflows/pr-evidence.yml (new), ops/pr-evidence-check.mjs (new), tests/pr-evidence-check.test.mjs (new), ops/prompt-workflow.mjs, tests/prompt-workflow.test.mjs, CONTRIBUTING.md, docs/discord-prompt.md
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

---

## Shipped
