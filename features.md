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

---

## Shipped
