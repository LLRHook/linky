# Linky — End-to-End Verification & Validation Protocol

This document is the canonical checklist for taking Linky from "compiles" to
"ship-ready". Run it before any release, after any large refactor, and any
time you suspect a regression. It is **executable from a cold start** — every
command is written verbatim, every expected output is named, and every
"manual" step has unambiguous accept / reject criteria.

Linky is a single Node.js/TypeScript Discord bot (`src/`, discord.js 14) built
into one production container and deployed to a Hostinger host by
`.github/workflows/deploy.yml` after CI passes on `main`. Optional tiers: an
Erome media server inside the same process (`EROME_MEDIA_ENABLED`), Vercel
regional media workers (`api/*.ts`, type-checked only here) and two operator
report scripts under `ops/`. There is no database; state lives in JSON files
under the `linky-data` volume.

See also: [`bugs.md`](./bugs.md), [`features.md`](./features.md),
[`CHANGELOG.md`](./CHANGELOG.md), [`README.md`](./README.md).

## How to use this file

1. Work top-to-bottom. Do not skip stages.
2. Tick each step locally as you go.
3. Every failed step files a `BUG-NNN` entry in `bugs.md`.
4. Every gap that is a missing feature, not a defect, files a `FEAT-NNN` in `features.md`.
5. Fill in the summary table (§ 6.3) and either declare the build green or block on open `BUG-NNN`s.

Time estimate: 15–25 minutes automated (Stages 0–2 and the container checks),
plus 20–40 minutes for the manual Discord walkthrough in Stage 3 when a test
server is available.

## Roles & abbreviations

- **Host** — the developer machine running this protocol (Windows 11 with Git Bash, or Linux).
- **Bot host** — the Hostinger server running the `linky` container; only the operator can reach it over SSH.
- **Test server** — an authorised Discord server where a self-hosted or staging bot token is enabled with `/setup`.
- **CI** — `.github/workflows/ci.yml` (jobs `Build (Node 22|24|26)` and `Production container`).
- **Deploy** — `.github/workflows/deploy.yml`, triggered by a green CI run on a `main` push.

---

## Stage 0 — Pre-flight

- [ ] 0.1 Record the commit under test: `git rev-parse --short HEAD`. Every result and the final Verified entry bind to it.
- [ ] 0.2 Clean tree on `main`: `git status --short` prints nothing except untracked scratch files.
- [ ] 0.3 Toolchain: `node --version` is 22, 24 or 26 (CI matrix); `npm --version` prints a version; `docker version --format '{{.Server.Version}}'` prints a version (needed for Stage 2.5).
- [ ] 0.4 Dependencies: `npm ci` exits 0.
- [ ] 0.5 No `.env` is required for Stages 1–2; `git check-ignore -q .env && echo ignored` prints `ignored`.
- [ ] 0.6 Production profile: Stage 2.5 runs the built image (`NODE_ENV=production`, non-root `node` user, read-only root, all capabilities dropped), not `npm run dev`.
- [ ] 0.7 Determinism posture: unit tests use fake timers and injected fetch/clock; no test opens the network or logs in to Discord (`CONTRIBUTING.md`). Stage 2c runs the suite twice.

> **Protocol vs CI.** CI is the continuous gate on every push. This protocol is
> the deeper release-readiness gate at a chosen SHA: it runs CI's exact commands
> locally, proves that newly shipped tickets have a test that demonstrates them,
> walks the user-facing flows, and re-ticks the hard constraints before `/release`.

**Command fidelity.** Stages 1–2 run the **exact** invocations from
`.github/workflows/ci.yml`, flags included. Do not substitute a paraphrase.

## Stage 1 — Static / spec compliance review

- [ ] 1.1 Strict production build (CI step "TypeScript build (strict)"): `npm run build` exits 0. `tsconfig.json` has `strict`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`.
- [ ] 1.2 Regional worker type-check (CI step "Check regional video workers"): `npm run check:workers` exits 0.
- [ ] 1.3 Dependency audit (CI step "Audit dependencies"): `npm audit --audit-level=low` prints `found 0 vulnerabilities`.
- [ ] 1.4 Secrets: CI runs Gitleaks 8.30.1 over all history with a pinned checksum. Locally, confirm no new `.env`, token or key file is tracked: `git ls-files | grep -iE '\.env$|token|secret|\.pem$'` prints nothing.
- [ ] 1.5 Provider abstraction intact: `git grep -nE "https://" src/services | grep -vE "SocialProviders|ArticlePreview|TweetTranslation|CaptionTranslation|YouTube|PromptService|Erome|Regional|MobileShareLinks|Instagram|logger" ` shows no new hard-coded provider host outside the catalogue modules. Any hit is a finding.
- [ ] 1.6 Bounded network I/O: every outbound fetch has a timeout, redirect policy and byte cap (`BoundedJson.ts`, `ArticlePreview.ts`, `MobileShareLinks.ts`, `RegionalHttp.ts`). New fetch sites must reuse those helpers.
- [ ] 1.7 Performance anti-pattern scan of the message hot path (`src/bot.ts` message handler → `SocialLinkService`): no per-message disk read in the loop, no unbounded regex on message bodies, no await per link before detection completes. Record any finding as a `BUG` (area `perf`).
- [ ] 1.8 No lint or formatter is wired in this repo (no ESLint/Prettier config); do not invent one here.

A failure in 1.1–1.3 is a hard block.

## Stage 2 — Automated builds & tests

Baseline (2026-09-24, SHA d4d6e32, Node 24.15.0 on the host):

| Layer | Command | Files | Tests | Result |
|-------|---------|-------|-------|--------|
| TypeScript unit/integration (tsx runner) | part of `npm test` | 65 `tests/*.test.ts` | 1,190 | 1,190 pass |
| Node ESM ops/runtime tests | part of `npm test` | 7 `tests/*.test.mjs` | 62 | 54 pass, 8 skipped on the host (need the Linux image; run in 2.5) |
| Deployment safeguards | `bash tests/deploy.test.sh` | 1 script | 24 checks | all `PASS:` |
| Container: modules and settings storage | CI step, see 2.5 | 1 | 1 | pass |
| Container: delivery archive runtime | `tests/delivery-archive-runtime.test.mjs` in the image | 1 | 1 | pass |
| Container: FFmpeg video runtime | `tests/video-runtime.test.mjs` in the image | 1 | 7 | pass |
| Performance / benchmark | `benchmarks/erome-scheduling.mjs` (manual, Docker + FFmpeg) | 1 | exploratory, not asserted | see Stage 4 |

Node's test runner has no list-only mode; the count is the `ℹ tests` line each
runner prints. A changed count means tests appeared or vanished — investigate before ticking.

- [ ] 2.1 Test suite (CI step "Test link fixing and bot startup"): `npm test` exits 0. The tsx run prints `ℹ tests 1190` / `ℹ fail 0`; the node run prints `ℹ tests 62` / `ℹ fail 0` with 8 skipped on a non-Linux host.
- [ ] 2.2 Deployment safeguards (CI step "Test deployment safeguards"): `bash tests/deploy.test.sh` exits 0 and every line starts with `PASS:`.
- [ ] 2.3 **2a — Per-ticket acceptance.** For every ticket at `shipped-pending-migration` / `fixed-pending-migration` (and every PR merged since the last Verified SHA), name the test that proves it and confirm it passes. A ticket with no proving test is a hard block: file a `FEAT`/`BUG` (area `tests`). Record the mapping in § 6.4.
- [ ] 2.4 **2b — Coverage of the change.** No coverage tool is wired (`c8`/`nyc` absent). Fall back to the 2a mapping and, for each changed `src/` file since the last Verified SHA, name the test file that exercises it (`git diff --stat <sha>..HEAD -- src`). Uncovered changed files block.
- [ ] 2.5 Production container (CI job "Production container"), run from the repo root with Docker available:
  ```bash
  docker build --tag linky:ci .
  ```
  ```bash
  docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --volume /app/data linky:ci node -e 'const assert = require("node:assert/strict"); const fs = require("node:fs"); assert.notEqual(process.getuid(), 0); require("./dist/services/SocialLinkService"); const file = "/app/data/ci-check"; fs.writeFileSync(file, "writable"); assert.equal(fs.readFileSync(file, "utf8"), "writable"); fs.unlinkSync(file);'
  ```
  ```bash
  docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --volume /app/data --env LINKY_ARCHIVE_RUNTIME_TEST=true --mount type=bind,src="$PWD/tests/delivery-archive-runtime.test.mjs",dst=/tmp/delivery-archive-runtime.test.mjs,readonly linky:ci node --test /tmp/delivery-archive-runtime.test.mjs
  ```
  ```bash
  docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777 --env LINKY_VIDEO_RUNTIME_TEST=true --mount type=bind,src="$PWD/tests/video-runtime.test.mjs",dst=/tmp/video-runtime.test.mjs,readonly linky:ci node --test /tmp/video-runtime.test.mjs
  ```
  Expected: build exits 0; the module check exits 0; the archive run prints `ℹ tests 1` / `ℹ fail 0`; the video run prints `ℹ tests 7` / `ℹ fail 0`. On Git Bash set `MSYS_NO_PATHCONV=1` and use `$(pwd -W)` for `src=`. The Trivy image scan is CI-only (pinned binary download); read its result on the CI run for the SHA.
- [ ] 2.6 **2c — Flake check.** Run `npm test` a second time and diff the sorted `✔`/`✖`/`﹣` lines of both runs; any difference quarantines that test as a `BUG` (area `tests`) and the run is not green.
- [ ] 2.7 CI for the SHA: `gh run list --branch main --limit 3` shows `CI` `completed success` for the SHA under test.

A failure in any Stage 2 step is a hard block.

## Stage 3 — Functional E2E walkthrough

Runs against a self-hosted bot built from the SHA (`docker compose up -d --build`
with a test token) or against the deployed hosted bot after Deploy succeeds.
Offline tests cannot prove live rendering (`CONTRIBUTING.md`); tick only from
observation in a Discord client.

- [ ] 3.1 Startup: container logs show `Logged in as ` and `Serving ` within 60 s; `docker inspect --format '{{.RestartCount}}' linky` is `0`.
- [ ] 3.2 `/setup` in a test channel: private panel; **Enable server** persists across `docker compose restart linky`.
- [ ] 3.3 `/settings` without options shows the effective configuration; `/settings mode:reply` then `/settings mode:replace` round-trips.
- [ ] 3.4 X text post (`https://x.com/jack/status/20`): preview appears in under 4 s; Replace mode removes the source and credits the sharer; **Original post** and owner-only **Remove** work.
- [ ] 3.5 TikTok share link (`https://www.tiktok.com/t/ZTU7oFukc/`) and long URL: preview confirmed (no "Discord preview metadata was not confirmed" notice). This is the live check for PR #51.
- [ ] 3.6 Instagram Reel `DdFKS1ABmK4`: preview within 8 s; note separately whether the video plays in the client (metadata is not playback).
- [ ] 3.7 Bluesky, Reddit `/comments/` video, Twitch clip from `ops/preview-corpus.json`: each previews once.
- [ ] 3.8 Public article (Open Graph `article` page): card shows publisher label, headline, excerpt; a Tenor GIF link keeps Discord's native player (PR #58); `/settings articles:false` disables it.
- [ ] 3.9 Manual path: `/fix link:` and **Apps → Fix with Linky** keep the source message.
- [ ] 3.10 Failure path: an unavailable post keeps the original and shows **Retry preview** owned by the sharer.
- [ ] 3.11 Suppression: `!nolinky`, `<angle-bracket>` links and links inside code stay untouched; `/autofix enabled:false` stops automatic fixing for that member.
- [ ] 3.12 `/diagnose link:` reports permissions, settings and recent provider observations.
- [ ] 3.13 Provider metadata control: `npm run check:providers` after `npm run build` exits 0 and every corpus entry prints `ok`. Network-dependent; a provider outage is logged, not a block, unless it reproduces from the bot host.
- [ ] 3.14 Operator report (bot host only): `docker exec linky node ops/delivery-archive-report.mjs --days 1 --json` returns a report whose `platforms` counts are consistent with 3.4–3.8.

## Stage 4 — Adversarial, stress & performance checks

- [ ] 4.1 Hostile article destinations: `tests/article-preview.test.ts` covers private DNS answers, HTTP redirects, explicit ports, credentials, DNS rebinding, oversized heads, malformed UTF-8 and rate limits. Confirm the file still contains those cases after any change to `ArticlePreview.ts`.
- [ ] 4.2 Provider responses: `tests/provider-response-security.test.ts` and `tests/bounded-json.test.ts` cover oversized and redirecting JSON bodies (1 MiB / 128 000 B / 4 MiB caps).
- [ ] 4.3 Mobile share resolution: `tests/mobile-share-links.test.ts` covers loops, non-public answers, excess hops and expiry.
- [ ] 4.4 Regional worker: `tests/regional-worker.test.ts` and `tests/regional-http.test.ts` cover HMAC claim validation, wrong method/path, and bounded transfers.
- [ ] 4.5 Attachments and media: `tests/attachment-limits.test.ts`, `tests/erome-media.test.ts` cover oversize, wrong MIME and truncated streams; the container video run (2.5) proves FFmpeg rejects a truncated stream.
- [ ] 4.6 Restart preserves data: after 3.2, `docker compose restart linky` keeps the server enabled; `docker compose down -v` (confirm with the user first) drops `data/servers.json` and the bot starts inactive.
- [ ] 4.7 Migration realism: no schema migrations exist; persisted JSON readers reject unknown fields and malformed files (`tests/server-settings.test.ts`, `tests/delivery-archive.test.ts`). Confirm a `data/` directory written by the previously deployed SHA still loads on the new SHA (run the new image against a copy of the old volume).
- [ ] 4.8 Performance: no stated budget. Evidence today is the exploratory `benchmarks/erome-scheduling.md` (ordinary rewrite p95 below 1 ms while encoding). Until FEAT-1790270881 lands, record the median from Stage 3.4 (X preview latency) and flag anything over 4 s. A crit/high regression on the message hot path blocks.
- [ ] 4.9 Storage caps: archive 30 days / 64 MiB, diagnostics 4,096 attempts / 4 MiB / 7 days, reuse index 1,024 entries / 2 MiB (`docs/delivery-reliability.md`); covered by `tests/delivery-archive.test.ts`, `tests/delivery-diagnostics.test.ts`, `tests/media-reuse-index.test.ts`.

## Stage 5 — Hard product-constraint verification

Re-tick the non-negotiable contracts stated in the README and `docs/`:

- [ ] 5.1 The operator archive contains no Discord user, server, channel or message IDs, message text, captions, source URLs or credentials (README "Reliability and operations"): `tests/delivery-archive.test.ts` and `tests/delivery-archive-report.test.mjs` assert the record shape.
- [ ] 5.2 Linky fetches only fixed HTTPS provider hosts and post-shaped paths; it never fetches arbitrary member-supplied URLs except public article candidates under the bounded rules in `docs/article-previews.md` (`tests/social-providers.test.ts`, `tests/article-preview.test.ts`).
- [ ] 5.3 Replace mode removes a source only after a matching preview is confirmed and source/ownership checks pass (`tests/preview-recovery.test.ts`, `tests/social-links.test.ts`).
- [ ] 5.4 Only the original sharer can **Remove** an automatic preview; Retry does not transfer ownership (`tests/repost-registry.test.ts`, `tests/bot.test.ts`).
- [ ] 5.5 No cookies, credentials or login bypass on any outbound request; DNS answers must be public (`tests/mobile-share-links.test.ts`, `tests/article-preview.test.ts`).
- [ ] 5.6 Translation stays within the durable 15,000 characters/day budget (`tests/translation-budget.test.ts`).
- [ ] 5.7 Erome is disabled on the hosted bot and requires an age-restricted channel by default on self-hosted instances (`tests/erome-album-policy.test.ts`).
- [ ] 5.8 Runtime hardening: image runs as `node`, read-only root, `cap_drop: [ALL]`, `no-new-privileges`, no npm/yarn in the runtime (Stage 2.5 module check asserts non-root; `Dockerfile` and `docker-compose.yml` retain the flags).
- [ ] 5.9 Deploy only ships the exact tested `main` SHA, refuses dirty trees and superseded commits, and rolls back on failed startup (`bash tests/deploy.test.sh`).

## Stage 6 — Reporting

- [ ] 6.1 every failed step has a `BUG-NNN`
- [ ] 6.2 every gap has a `FEAT-NNN`
- [ ] 6.3 fill in summary table
- [ ] 6.4 record run metadata (git SHA, env versions, profile flags)
- [ ] 6.5 if all green, append `Verified` entry to `CHANGELOG.md / Unreleased`

Summary table template:

```
| Stage                    | Pass / Fail | Notes |
|--------------------------|-------------|-------|
| 0 Pre-flight             |             |       |
| 1 Static review          |             |       |
| 2 Automated tests        |             |       |
| 3 Functional E2E         |             |       |
| 4 Adversarial / perf     |             |       |
| 5 Hard constraints       |             |       |
| 6 Reporting hygiene      |             |       |
```

A build is **release-ready** only if all six stages tick. A failed step in
Stages 1, 2, or 5 is a hard block, including 2a (no proving test), 2b
(uncovered changed code) and 2c (flaky green). In Stage 4, a crit/high
performance failure and a failed load of the prior volume (4.7) also block.

### Run log

**2026-09-24 — bootstrap run, SHA d4d6e32 (main after PRs #58, #55, #59 merged).** Stages 0–2 and 5 executed on
the host; Stage 3 was not executed (no Discord test server or bot host reachable
from the developer machine) and Stage 4 was executed by test evidence only.

| Stage                    | Pass / Fail | Notes |
|--------------------------|-------------|-------|
| 0 Pre-flight             | Pass        | Node 24.15.0, npm 11.12.1, Docker 29.7.2 |
| 1 Static review          | Pass        | build, check:workers, audit 0 vulnerabilities |
| 2 Automated tests        | Pass        | 1,190 + 62 (54 pass / 8 skipped on host), deploy 24 checks, container 1 + 1 + 7 (8859ab5) and module check (d4d6e32), two runs identical |
| 3 Functional E2E         | Not run     | needs a test server; 3.5 (TikTok share) and 3.6 (Reel playback) are the open live checks |
| 4 Adversarial / perf     | Pass (tests)| no perf budget, FEAT-1790270881 filed |
| 5 Hard constraints       | Pass        | all by test evidence |
| 6 Reporting hygiene      | Pass        | BUG-1790270870 fixed and migrated; FEAT-1790270880/881/882 filed |

2a mapping for the batch since the previous release checks (2026-09-15):

| Change | Proving test |
|--------|--------------|
| PR #51 TikTok share links accept the canonical post embed | `tests/preview-recovery.test.ts` "a TikTok share link accepts the canonical post embed that providers publish" |
| PR #50 TypeScript 7, esbuild transform in tests | `npm run build`, `npm run check:workers`, `tests/erome-media-runtime.test.ts` |
| PR #52 Node 26 runtime image | Stage 2.5 module check (`v26.9.0 production`) |
| PR #53 provider metadata control | `tests/provider-metadata-check.test.mjs` (5 tests) |
| PR #57 public article previews | `tests/article-preview.test.ts` (30 tests), `tests/article-posts.test.ts`, `tests/manual-fix.test.ts` |
| PR #58 keep native GIF/media players | `tests/article-preview.test.ts` "media pages keep their native Discord player even when they also declare an Article" |
| PR #55 dotenv 18 | `tests/config.test.ts`; Stage 2.5 module check loads `dotenv/config` in the image |
| PR #59 @types/node 26.6.2, tsx 4.23.15 | `npm run build`, `npm test` |

---

## Appendix A — Inspecting persistent state

All state is JSON under the data directory (`LINK_SETTINGS_PATH` directory, default `data/`; `/app/data` in the container):

```bash
docker exec linky ls -la /app/data
```

Files: `servers.json` (server settings), `repost-registry.json` (ownership), `youtube-stats.json`, `translation-usage.json`, `delivery-diagnostics.json`, `delivery-archive/` (daily files), `media/` (Erome assets, self-hosted only). Never copy these off the host with user data intact; the archive is the sanitized view.

## Appendix B — Reusable command recipes

```bash
docker logs --since 10m linky
```

```bash
docker exec linky node ops/delivery-archive-report.mjs --days 7
```

```bash
node ops/delivery-report.mjs --file data/delivery-diagnostics.json
```

```bash
npm run build && npm run check:providers -- --json
```

## Appendix C — Common platform commands

```bash
gh run list --branch main --limit 5
```

```bash
gh pr list --json number,title,mergeStateStatus
```

```bash
docker compose up -d --build
```

```bash
docker compose restart linky
```

## Appendix D — Toggling provider variants

Provider order is fixed in `src/services/SocialProviders.ts`; health-based
reordering is automatic and temporary (`docs/delivery-reliability.md`). Optional
integrations are env toggles in `.env.example`: `TRANSLATE_TWEETS`,
`TRANSLATE_INSTAGRAM` + `GOOGLE_TRANSLATE_API_KEY`, `YOUTUBE_API_KEY`,
`PROMPT_ENABLED`, `EROME_MEDIA_ENABLED` + worker/media variables. Tests inject
fetch and never need a key.

## Appendix E — Smoke checklist (sub-15-minute version)

1. `npm ci && npm run build && npm run check:workers`
2. `npm test` prints `ℹ fail 0` twice
3. `bash tests/deploy.test.sh` all `PASS:`
4. `npm audit --audit-level=low` prints 0 vulnerabilities
5. `docker build --tag linky:ci .` and the Stage 2.5 module check exit 0
6. `gh run list --branch main --limit 1` shows CI success for HEAD
7. One X post and one TikTok share link preview in a test channel
8. `docker inspect --format '{{.RestartCount}}' linky` is `0` after deploy
