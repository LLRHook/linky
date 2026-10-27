# Historical verification evidence

Archived verbatim from `VERIFICATION.md`; these partial runs are not green Verified entries.

## Source: VERIFICATION.md / Stage 6 / Run log

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

**2026-09-25 — run, SHA 4ae273d (main after PR #60; only docs/trackers changed since d4d6e32).** Host is macOS
with Node 25.9.0 (outside the CI matrix), so Stages 1–2 ran CI's exact commands in `node:22` (v22.23.3),
`node:24` (v24.21.0) and `node:26` (v26.10.0) containers; Docker 29.7.2. Stage 3 was not walked in a Discord
client; 3.13 was executed. Stage 4 by test evidence; 4.6 and 4.7 not executed (no test token; no `src/` change
since the deployed d4d6e32).

| Stage                    | Pass / Fail | Notes |
|--------------------------|-------------|-------|
| 0 Pre-flight             | Pass        | clean tree, `.env` ignored, containers for the Node matrix |
| 1 Static review          | Pass        | build, check:workers, audit 0 vulnerabilities on 22/24/26; 1.4 command corrected (BUG-1790322966) |
| 2 Automated tests        | Pass        | 1,190 + 62 (54 pass / 8 skipped) on each of 22/24/26, two identical runs each; deploy 24 `PASS:`; container module check (v26.9.0 production, uid 1000), archive 1, video 7; CI and Deploy success for 4ae273d |
| 3 Functional E2E         | Fail / partial | walkthrough not run; 3.13 exit 1: Instagram providers down (BUG-1790322965) |
| 4 Adversarial / perf     | Pass (tests)| evidence files present; no perf budget (FEAT-1790270881 open) |
| 5 Hard constraints       | Pass        | by test evidence; Dockerfile `USER node`, compose read-only / cap_drop / no-new-privileges |
| 6 Reporting hygiene      | Pass        | BUG-1790322965 and BUG-1790322966 filed; no Verified entry (Stage 3 incomplete) |

2a: no ticket shipped since d4d6e32 besides PR #60 (docs/trackers); BUG-1790270870 proven by
`grep -n "Node.js 22, 24 and 26" README.md docs/self-hosting.md`. 2b: `git diff --stat d4d6e32..HEAD -- src tests` is empty.

---
