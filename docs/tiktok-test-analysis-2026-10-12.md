# TikTok repair and test analysis — October 12, 2026

Scope: the reported `https://www.tiktok.com/t/ZPLBWgdad/`, integration of open
PRs #61, #65, #66, #67, #68 and #70, and the full CI test surface. The integration
branch preserves each PR's commit history, the current Instagram provider
migration, and all three dependency updates. Package version remains 1.0.0.

## Findings and repairs

- **BUG-1791830086:** TikTok shares previously reached tnktok without a resolved
  post ID. The matcher allowed any canonical TikTok post to satisfy a short
  share, so one video could confirm unrelated shares. The bounded first-party
  resolver now accepts `/t/`, `vm.` and `vt.` forms and returns only an allowed
  public video/photo destination. Matching uses the exact identity. An unresolved
  share can still match its own provider share URL, as observed in Discord.
- The reported first-party redirect contained 8,212 header bytes. The initial
  resolver's 8 KiB limit produced `HPE_HEADER_OVERFLOW`; a finite TikTok-only
  16 KiB cap resolved the post. No response body or cookies are consumed or
  replayed. DNS pinning, public IPv4 checks, four hops, the shared four-second
  deadline and resolver capacity limits remain in force.
- TikTok now shares Instagram's eight-second Gateway window and returns
  immediately for useful metadata. Other platforms retain four seconds; one
  bounded REST reconciliation remains. A deterministic 7.5-second regression
  failed before this change and passes afterwards. The exact timing of the
  originally reported historical failure was not available.
- **BUG-1791399501:** PR #70's Node 22 CI failed with `ENOTEMPTY` during archive
  fixture cleanup. A deadline-limited close can leave a health write active.
  Fixture and restarted archives now finish persistence before directory
  removal; the deliberately stalled writer is released in `finally`.
- **BUG-1791830959:** `npm ci` followed by `npm test` in a fresh Linux checkout
  failed because the ESM provider tests imported missing `dist` modules.
  `npm test` now builds the current production sources before both runners,
  preventing missing or stale build output from invalidating the test result.

## Automated evidence

The combined pre-fix PR tree passed 1,207 TypeScript tests. The repair adds
11 tests, for **1,218 TypeScript unit/integration tests in 65 files**. The seven
ESM files contain 62 tests: **54 pass on the host and eight require the production
image**. The image executes those eight with no skips: one archive test and
seven image/video/FFmpeg tests. A separate container check proves non-root
execution, production module loading and writable state storage.

| Surface | Evidence and result |
| --- | --- |
| Strict production/test TypeScript | `npm run build` and the `npm test` type-check pass |
| Regional workers | `npm run check:workers` passes |
| Dependency advisories | `npm audit --audit-level=low` reports zero vulnerabilities |
| Windows Node 24.15.0 | Full suite passes; affected regressions also pass in focused runs |
| Linux Node 22.23.3, 24.21.0, 26.11.1 | Full CI command set exercised in isolated checkouts; repeated suite runs agree |
| Deployment safety | `bash tests/deploy.test.sh`: 24 safeguards pass |
| Production image | Builds and passes module/storage, archive and all seven FFmpeg/image/video tests with `--network none`, read-only root, dropped capabilities and no privilege escalation |
| Live provider corpus | Nine of nine sources meet their expectations across X, Instagram, TikTok, Bluesky, Reddit and Twitch |

Raw command outputs, the red/green regressions and runtime evidence are private
scratch artifacts under `.vv/local-gate/`. GitHub's protected checks independently
gate the final integration PR. Initial Linux fixture runs without Git metadata
failed the workflow tests; the verification fixture was corrected to clone the
actual commit through a Git bundle before those successful runs.

## Changed-source coverage

Every changed production source module has behavior-oriented coverage:

| Changed module | Proving tests and boundaries |
| --- | --- |
| `commands/diagnose.ts` | `diagnose-command`: private admin checks, scope/permissions, elevated moderator MFA, TikTok share recognition without fetching |
| `commands/fix.ts` | `manual-fix`, `manual-media`, `youtube-interactions`: slash/context entry points, defer-before-resolution, public/private responses, source retention, exact metadata and failure handling |
| `DeliveryDetails.ts` | `delivery-diagnostics`, `delivery-recovery`: durable binding, visibility/ownership, finite outcomes and permission failures |
| `MobileShareLinks.ts` | `mobile-share-links`, `delivery-recovery`, `manual-fix`: all supported TikTok share forms, video/photo IDs, redirects, tracking removal, hidden/disabled links, public DNS, cancellation, deadlines and capacity |
| `PreviewRecovery.ts` | `preview-recovery`, `provider-metadata-check`: indexed provider selection, canonical identities, wrong-post rejection, video requirements, native/authored reconciliation and failed refetches |
| `PreviewWatcher.ts` | `preview-watcher`: updates before/after send, wrong channel/message/author, immediate completion, missed events, stuck reconciliation, cancellation and delayed Instagram/TikTok media |
| `RepostAttachments.ts` | `social-links`, `attachment-limits`, `delivery-recovery`: copied bytes/metadata, upload constraints, source rechecks and preservation when copying fails |
| `RepostRegistry.ts` | `repost-registry`, `repost-sync`, `delivery-recovery`: persistence/restart, ownership, source edits/deletes and atomic replace-to-reply downgrade after 60003/50013 |
| `SocialLinkService.ts` | `social-links`, `delivery-recovery` and media delivery suites: platform scope, automatic Reply/Replace, notifications, source races, translation, provider recovery, attachments and final controls |
| `SocialProviders.ts` | `social-providers`, `social-links`, `preview-recovery`: strict hosts/paths, provider order, legacy Instagram aliases, URL preservation and pure rewrite compatibility |
| `TweetPresentation.ts` | `social-links`, `tweet-translation`, `delivery-recovery`: translated text/media, quoted posts, gallery links, splitting and fallback |

The remaining suites cover bot startup and command registration, settings and
personal opt-out persistence, bounded JSON/HTTP, translation budgets, articles,
YouTube/community posts, Erome/media jobs and stores, regional HMAC/transport,
operator reports, logging redaction, and prompt publication/deployment guards.

## Live Discord evidence

In the user-authorized GAMBA general channel, the exact reported share produced
a Linky repost with attribution, Original post, owner Remove and private Details.
The Details control reported a delivered native TikTok preview. Chrome playback
advanced beyond three minutes at **1280×720**, with a **23:17** duration and no
media error. Provider and Discord proxy range requests returned MP4 bytes.
These are actual client observations, separate from provider HTML and embed
metadata. Temporary bot controls were removed; marked QA posts are cleaned up
at the end of the session. Deployment and the final production recheck are
recorded in the session's evidence report.

The provider corpus's Instagram primary passed; the sampled OGInstagram
alternate returned HTTP 403. The successful primary means the source passes;
it does not establish current availability of that alternate.

## Review and remaining limits

An independent Claude Opus 5.5 read-only review checked the combined changes and
ten relevant documents. Review follow-ups added resolver capacity/deadline
delivery tests, private manual acknowledgement, TikTok diagnostics and completion
of restarted archive writes. The review's claim that unresolved shares always
fail is disproved by the live Discord share-URL embed and a new exact-share
delivery regression. Arbitrary canonical identities remain intentionally rejected.

Affected documentation was synchronized to the canonical resolver and wait
windows. Pre-existing runtime/state-path drift is filed as BUG-1791831056;
historical audits and observations were preserved.

There is no configured line/branch coverage tool, automated Discord client
playback harness, or approved absolute latency budget. The existing CPU benchmark
ran successfully; its five median measurements stayed close to the September 30
baseline, with no slowdown above the baseline's 10% investigation threshold.
The live playback check covers Chrome for the reported post. It does not measure
every post, provider, device or Discord client. This targeted verification does
not constitute a complete Stage 3 release walkthrough, so no full V&V Verified
entry or release-ticket migration is claimed.
