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

### [FEAT-1795575314] Killing tests for reply-thread guards that survive mutation
- [ ] **Priority:** low
- **Area:** tests
- **File(s):** src/services/BlueskyReplies.ts, src/services/ReplyThreads.ts, src/services/YouTubeStats.ts, src/services/ArticlePreview.ts, tests/bluesky-replies.test.ts, tests/reply-threads.test.ts, tests/youtube-comments.test.ts, tests/bot.test.ts, tests/linkedin-comments.test.ts, src/bot.ts, src/services/SocialLinkService.ts
- **Req:** none (validation lead V1, driver-replies-build brief, 2026-11-24)
- **Depends on:** FEAT-1795541460, FEAT-1795541461, FEAT-1795541462, FEAT-1795544485
- **UI:** none (test coverage)
- **Why:** Independent reviews accepted surviving defensive guard mutants as non-blocking. Unit: mutants; scope: the listed reply/thread provider, lifecycle and cache files. This ticket measures whether each listed mutation is detected by a named test, not production correctness or a score. Baseline: these mutants survived their cited review runs; minimum sample: every listed mutant; noise floor: a deterministic assertion failure with the original passing, excluding setup errors; abstain if a mutation no longer applies and record replacement evidence instead of claiming a kill.
- **Approach:** Add behavior assertions for Bluesky B08, B09, B10, B12, B13, B16, B17, B18, B37, B38, B39 (R4/R6); YouTube Y17 created.has exact creation, Y23/Y24 publication().remove deferred cleanup, Y14 cleanupComments exact gate, Y25 spurious statistics warning (R8); shared defence-in-depth M9 and M27 (R6); LinkedIn N8b and N14 (R9). Definitions and probes: .git/agent-handoffs/driver-replies-build/evidence/R4, R6, R8, R9. R8-P10 targets Y23/Y24 and R8-P12 targets Y17. X core (R3, evidence/R3): MD bot.ts journal-callback parent-ownership check, MF cleanup thread guild and parent check, MM gateway delete handler skipping registered posts, MR first removing check, MT author check in handle.
- **Library / dependency notes:** none
- **Acceptance criteria:**
  - [ ] Each listed mutant is killed by a named test, with the baseline passing, mutation producing an assertion failure, and restored code passing; record the exact guard, test name and result for each. Inapplicable/equivalent mutations are explicitly abstained and justified, never counted as kills.
- **Test plan:** Run each affected layer and each exact independent-review mutation in isolated copied inputs; keep original source intact, distinguish assertion failures from harness/setup errors, and restore copied bytes before the final run.
- **Out of scope:** Production behavior changes, live Discord/provider calls, tokens and already killed or superseded review mutants.
- **Bump:** patch
- **Status:** open
