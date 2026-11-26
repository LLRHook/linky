# Linky — Bug Tracker

Active work only. Format and rules: [`.cycle/TRACKERS.md`](.cycle/TRACKERS.md). Write with `python .cycle/trackers.py`, never by hand. Shipped and closed entries are removed; their record is `CHANGELOG.md`, Jira, and `python .cycle/trackers.py show <id>`.

## Open

### [BUG-1790270871] Deploy workflow intermittently fails with an SSH connect timeout to the bot host
- [ ] **Severity:** med
- **Area:** ops, ci
- **File(s):** .github/workflows/deploy.yml, docs/self-hosting.md
- **Observation:** Deploy runs for 94e34b2 (2026-09-18) and 8859ab5 (2026-09-24 17:30Z) both ended with `ssh: connect to host *** port 22: Connection timed out` and exit code 255, despite `ConnectTimeout=20` and `ConnectionAttempts=3`. The next push (d4d6e32) deployed successfully, so the host was only stale until another commit landed.
- **Expected:** A green CI run on `main` reaches the host, or the workflow retries connection establishment for longer before failing; a single merged fix should not sit undeployed until the next unrelated merge.
- **Req:** unknown
- **Depends on:** unknown
- **Repro / Notes:** `gh run list --branch main --workflow Deploy` and `gh run view <id> --log-failed`. Connection retry is safe because the remote `deploy` command is idempotent per SHA and refuses superseded revisions (`ops/deploy.sh`). Options: raise `ConnectionAttempts`, add a job-level retry of the SSH step only, or check whether the Hostinger firewall rate-limits GitHub runner ranges.
- **Bump:** patch
- **Status:** open

### [BUG-1791990872] Self-hosting guide says the container runs Node.js 24
- [ ] **Severity:** low
- **Area:** docs
- **File(s):** docs/self-hosting.md
- **Observation:** `docs/self-hosting.md:94` says "The container runs Node.js 24"; both `Dockerfile` stages use `node:26-trixie-slim` (PR #52 moved the runtime to Node 26).
- **Expected:** The guide names the runtime the `Dockerfile` actually builds.
- **Req:** unknown
- **Depends on:** unknown
- **Repro / Notes:** `grep -n FROM Dockerfile`; found during FEAT-1791990467 recon (pre-existing, not caused by that change).
- **Bump:** patch
- **Status:** open

### [BUG-1791991450] README counts seven social platforms after Facebook was added
- [ ] **Severity:** low
- **Area:** docs
- **File(s):** README.md
- **Observation:** README "Self-hosting and development" says the hosted bot is free "for the seven social platforms above"; the platform table lists eight (X/Twitter, Instagram, TikTok, YouTube, Bluesky, Reddit, Twitch clips, Facebook) since FEAT-1791951567.
- **Expected:** The count matches the table, or the sentence avoids a number.
- **Req:** unknown
- **Depends on:** unknown
- **Repro / Notes:** Found during FEAT-1791990470 docs update (pre-existing, not caused by that change).
- **Bump:** patch
- **Status:** open

### [BUG-1791837720] Confirmed social previews lose Remove and Details controls in live Discord
- [ ] **Severity:** med
- **Area:** previews, ownership
- **File(s):** src/services/SocialLinkService.ts, src/services/RepostRegistry.ts, tests/social-links.test.ts, tests/repost-sync.test.ts, tests/delivery-recovery.test.ts
- **Observation:** Fresh-stack GAMBA TikTok, Bluesky and Reddit previews were confirmed and their sources safely deleted, but the resulting Discord messages retained only Original post. The canonical reported TikTok initially displayed Remove and Details, then lost both within seconds. A Bot REST GET confirms this server state; the durable ownership records still exist. X and Instagram controls remain present.
- **Expected:** A confirmed automatic preview retains the original sharer's Remove action and its delivery Details while its ownership record is valid.
- **Req:** unknown
- **Depends on:** unknown
- **Repro / Notes:** Owned examples: TikTok 1559302634077425725 (canonical), 1559302873437962383 (Retry reply), 1559304300969070615 and 1559304343214231662 (corpus); Bluesky 1559304532083736667; Reddit 1559304570570670212. .vv/discord-fixtures.json, .vv/gui-evidence.json and Hostinger registry/log evidence show the mismatch. No product root cause has been assumed.
- **Bump:** patch
- **Status:** in-progress
- **Log:**
  - Investigation: Batch A reproduced Original-only controls on Reddit 1559369650746429450 in both the GUI and channel-list REST response. A later Reddit delivery retained all controls in single-message and channel-list REST checks; bound private Details and owner Remove worked. TikTok and a three-minute Bluesky replay also retained controls. Controlled REST probes and the actual Discord.js publication handler without a Gateway connection retained controls. The failure is intermittent; its writer remains unproven. Component fixtures now preserve serialized server state and model cloned edit/fetch results, but this characterization is not a product fix.
  - Acceptance criteria: Confirmed automatic and Retry previews retain Original post, owner-only Remove and correctly bound Details after delayed updates; unrelated controls, source-deletion ordering and cleanup remain correct.
  - Test plan: Reproduce component-state loss with faithful send/edit/cache and delayed-event behavior; exercise Replace, Reply, Retry, ownership reload, non-owner actions and cancellation against the captured lifecycle.

### [BUG-1791838422] vxTwitter error card is accepted as a useful post preview
- [ ] **Severity:** high
- **Area:** previews, source-safety
- **File(s):** src/services/PreviewRecovery.ts, tests/preview-recovery.test.ts, tests/preview-watcher.test.ts, tests/delivery-recovery.test.ts, tests/manual-fix.test.ts
- **Observation:** Retrying the current unavailable X fixture produced a vxTwitter / fixvx card whose description begins "Failed to scan your link!" and returned a confirmed preview. A read-only invocation of the committed inspectPreviews matcher against the actual Discord embed returns ok:true with no missing expectation.
- **Expected:** A provider's unavailable/error card cannot satisfy useful post delivery or permit source deletion.
- **Req:** unknown
- **Depends on:** unknown
- **Repro / Notes:** Owned source 1559305894511116288, retry response 1559306040581816402. .vv/live-fixture-analysis.json captures the real embed and current matcher result. Retry kept the source because it forces Reply; the automatic Replace path shares this matcher and remains at risk. No source loss was observed in this fixture.
- **Bump:** patch
- **Status:** in-progress
- **Log:**
  - Root cause: The known-error expressions omit the branded vxTwitter service-error signature, allowing its matching URL, title and description to satisfy a text-post preview.
  - Implementation progress: Added a narrow branded scan-error rejection before media checks and regression coverage for aliases, logos/video, legitimate quoted text, Gateway/REST observations, automatic Replace/Retry and manual commands. The live REST-backed SDK probe rejected both unavailable providers, retained its source and exposed an owned recovery notice. Integrated sign-off and verification through the normal deployed bot remain pending.
  - Acceptance criteria: Recognizable provider service-error cards remain missing and receive no success attribution; automatic failure preserves the source and owned recovery controls; legitimate post/media and useful bounded fallback still pass.
  - Test plan: Regress the captured error signature and media/logo variants, legitimate-post positive controls, Gateway/REST rejection, automatic Replace/Retry source safety and explicit manual fixing.

### [BUG-1791837090] Fresh live TikTok attempt cannot confirm the reported share preview
- [ ] **Severity:** med
- **Area:** providers, previews
- **File(s):** src/services/MobileShareLinks.ts, src/services/PreviewWatcher.ts, src/services/PreviewRecovery.ts
- **Observation:** After the approved fresh Hostinger reset at SHA 1bdfa5a, posting the reported public share in GAMBA Replace mode produced an unconfirmed-preview notice. The source remained intact. Private Details reported native TikTok delivery, 8.8 seconds total and an 8.1-second unavailable preview stage. X controls succeeded in the same session.
- **Expected:** The reported share resolves to video 7695457160653851935 and receives a matching playable preview, with safe source retention when provider delivery is unavailable.
- **Req:** unknown
- **Depends on:** unknown
- **Repro / Notes:** Current owned fixture source 1559302030542118972, notice 1559302069590949890, attempt 5ee06734-e617-46af-adce-9c63f1ac0d23. Browser mutation evidence and screenshot are retained under .vv/. Provider timing and Retry are under investigation; do not infer an identity mismatch or source loss from the unconfirmed notice alone.
- **Bump:** patch
- **Status:** open

### [BUG-1791837609] Live Twitch corpus delivery has no confirmed Discord preview
- [ ] **Severity:** med
- **Area:** providers, previews
- **File(s):** src/services/SocialProviders.ts, ops/preview-corpus.json
- **Observation:** A fresh-stack GAMBA post of the existing public Twitch corpus clip kept its source and returned an unconfirmed-preview notice. The local provider metadata control had passed for that clip in this session.
- **Expected:** The corpus clip previews once through the configured provider; unavailable delivery retains the source and safe Retry controls.
- **Req:** unknown
- **Depends on:** unknown
- **Repro / Notes:** Owned source 1559304608327929888 and notice 1559304628900991091. The native Twitch source card rendered, but that does not establish Linky provider delivery. Host-network control and Retry are being checked.
- **Bump:** patch
- **Status:** open
- **Log:**
  - 2026-11-16 Evidence: 2026-11-16 driver live fixture: fxtwitch returned a components embed with no video at 2.5 s (one Twitch clip; evidence/driver/unfurl-timing-others.out). This is a selected render observation, not a provider success-rate estimate.

### [BUG-1794873496] Refresh stale automated test counts in VERIFICATION.md
- [ ] **Severity:** low
- **Area:** docs, tests
- **File(s):** VERIFICATION.md:91; VERIFICATION.md:102
- **Observation:** L8 measured 1418 TypeScript tests and 85 Node ESM tests at PR 109 head 1d8ff1b; VERIFICATION.md still states 1190 and 62. This drift predates L6 changes and round 1 adds further regression tests.
- **Expected:** Update the current baseline and procedure expectations using exact runner-reported counts at the commit actually tested; keep passed, failed and host-skipped counts separate.
- **Req:** unknown
- **Depends on:** none (driver-requested follow-up)
- **Repro / Notes:** File only per L6 round 1 driver decision; do not build here. Run npm test once on the target commit and compare each runner summary with the Stage 2 table and 2.1 prose. Unit: test cases per runner at one named commit; baseline documented 1190 TS / 62 ESM versus observed 1418 TS / 85 ESM at 1d8ff1b; minimum one complete run; noise floor zero unexplained count mismatches; abstain if any runner did not complete. Refresh from the final target, not the historical L8 count.
- **Bump:** patch
- **Status:** open

### [BUG-1794873497] Ignore a leading UTF-8 byte-order mark in PR evidence bodies
- [ ] **Severity:** low
- **Area:** tooling, ci
- **File(s):** ops/pr-evidence-check.mjs; tests/pr-evidence-check.test.mjs
- **Observation:** On PRs 108 and 109 on 2026-11-16, a PowerShell-written body with a leading UTF-8 mark failed the evidence gate with Section ## Tickets is missing or empty despite containing that section. The checker startsWith heading parser treats the mark as part of the heading.
- **Expected:** Ignore one leading UTF-8 byte-order mark before parsing required headings; a marked complete body should pass and genuinely absent or empty sections must still fail.
- **Req:** unknown
- **Depends on:** none (driver-requested follow-up)
- **Repro / Notes:** File only per L6 round 1 driver decision; do not build here. In a regression call missingEvidence with a complete template body prefixed with U+FEFF and expect an empty missing list. Control: the same unmarked body passes; removing Tickets still fails. No token, message content or Discord identity is needed.
- **Bump:** patch
- **Status:** open

### [BUG-1795460094] VERIFICATION 1.5 host grep reports accepted provider hosts as findings
- [ ] **Severity:** low
- **Area:** docs
- **File(s):** VERIFICATION.md
- **Observation:** On main bd86577 the Stage 1.5 command `git grep -nE "https://" src/services | grep -vE "SocialProviders|ArticlePreview|TweetTranslation|YouTube|PromptService|Erome|Regional|MobileShareLinks|Instagram|logger"` prints hits the step does not list as accepted: LinkedIn.ts (canonical permalinks built from LINKEDIN_HOST), TruthSocial.ts (canonical URLs from TRUTH_SOCIAL_HOST and a relay-URL error message), PreviewRecovery.ts (a documentation link in a comment) and TweetPresentation.ts:158 (the g.fixupx.com rewrite, which the step names). The step says any other hit is a finding, so every run reports these as findings.
- **Expected:** Stage 1.5 lists every accepted host module or hit, so a run reports only a newly hard-coded provider host outside the catalogue.
- **Req:** unknown
- **Depends on:** unknown
- **Repro / Notes:** Found while adding BlueskyPost/BlueskyPanel (FEAT-1795457637), which added `Bluesky` to the exclusion list for its own AppView and profile URLs. Decide per hit whether it is a catalogued host (exclude the module) or a real finding; do not change the code to satisfy the grep.
- **Bump:** patch
- **Status:** open

### [BUG-1795540133] tests/bot.test.ts sometimes aborts partway through a full npm test run
- [ ] **Severity:** high
- **Area:** tests
- **File(s):** tests/bot.test.ts
- **Observation:** In the V&V run on b5f281f (Windows 11, Node 24.15.0), the first `npm test` straight after `npm ci` reported `ℹ tests 1429` / `ℹ fail 1`. The failure was the file itself: `✖ tests\bot.test.ts (3705ms)`, 'test failed' at tests/bot.test.ts:1:1, with no failing test named and no error output. The file stopped after 25 of its 47 tests. The last test reported was 'failed startup registration disconnects without reporting readiness'. The next test, 'startup restores repost ownership and fetches reply excerpts across bot restarts' (timeout 5000 ms), never reported. The npm test chain then stopped before the ESM suite. The same SHA then passed 7 more times: bot.test.ts alone (47/47), the TypeScript suite 3 times (1451/1451), and `npm test` 4 times, 2 of them after a fresh `npm ci` (1451 TS and 85 ESM, 8 skipped).
- **Expected:** Every test file reports the same result on every run at one SHA. A file that stops early prints the error that stopped it.
- **Req:** none (found by the V&V protocol run, 2026-11-24)
- **Depends on:** none
- **Repro / Notes:** Seen 1 time in 8 runs of `npm test` / `npx tsx --test tests/*.test.ts` on the host; CI (Linux) passed at b5f281f. The logs are local: .vv/logs/2.1-npm-test.log (failing run) and 2.1-*repro*/afterci-*.log (passing runs). The file stopped at about 3.7 s, before the 5 s per-test timeout, and printed nothing on stderr, so this looks like the child process exiting rather than a timeout. Leads: an exception or rejection after a test finished (for example a fixture's `assert.fail` in a callback that is not awaited), or a Windows file-lock error while the repost registry writes under the temp directory. Loop the file (`for i in $(seq 50); do npx tsx --test tests/*.test.ts || break; done`) with `--test-reporter=tap` to keep the child's output.
- **Bump:** patch
- **Assignee:** Victor Ivanov
- **Status:** in-progress
- **Log:**
  - 2026-11-24 protocol: Found by: protocol (Stage 2.1, release run on b5f281f). Class: flaky test (local-gate counts flaky as RED).
  - 2026-11-24 Investigation: B1 investigation on Windows 11 / Node 24.15.0: 100 isolated TAP runs passed (50 with four CPU busy workers; 50 through tsx CLI with fatal-error/exit preload), eight consecutive full npm test runs and baseline validate passed. Original silent file abort did not reproduce; no root cause or corrective change established. Evidence: .git/agent-handoffs/driver-replies-build/evidence/B1/B1.md. Keep in-progress; blocked per implementation brief rather than guessing a fix.
  - 2026-11-24 Investigation: B1 round 2 on b0fa652: Node 24.15.0 embedded runner/harness source and deliberate tsx child exits show the silent file-only failure fits abrupt nonzero termination; late throw/rejection emits an async diagnostic and timeout increments cancelled. Targeted timing probes contain delayed startup cleanup, final-edit rejection, forced sweep assertion after stop and forced EPERM rollback assertion; none reproduces the original silent abort. Root cause remains unproved. Evidence: .git/agent-handoffs/driver-replies-build/evidence/B1/round2 and B1.md.
  - 2026-11-24 Diagnostics: Round 2 established abrupt nonzero test-child termination; its cause and exit code/signal are unrecoverable from the old spec log. This PR adds a parallel TAP file while preserving spec stdout, failed-test CI artifacts, and shutdown-before-error assertions. Root cause is not found and Status stays in-progress. On the next occurrence, read exitCode and signal from .vv/npm-test.tap before retrying.
  - 2026-11-26 Sighting: Sighting 2 on 2026-11-25: direct tsx pair (reply-threads.test.ts and bot.test.ts) ended after 83/84 reported tests with the same bot file-only failure, immediately after failed startup registration. No TAP captured by this direct invocation. Source: .git/agent-handoffs/driver-replies-build/evidence/F6/R11-fixups/focused.txt; immediate bot recheck passed.
  - 2026-11-26 Investigation: B2 round 3 on d856a61 (Windows 11, Node 24.15.0): audited 93 local imported modules; index.ts is not imported, register.ts exit is CLI-guarded. Ten instrumented original two-file runs passed 133/133 each; no exit/abort/kill or application child-process calls observed in bot test context. Handler-install trace found only Node test harness handlers and probe listeners. Forced EBUSY/EPERM after-hook errors and a real rmSync argument failure report hookFailed with explicit errors, unlike both sightings. Existing non-joining sweep shutdown remains a known lead, not a demonstrated cause. Application event IDs 1000/1001 have no node/esbuild/tsx match for Nov 24-26. Validate passed (1742 TS, 77/85 ESM with 8 expected container skips). No forced reproduction or root cause, no guessed fix; keep in-progress and escalate after final round. Preserve TAP before retrying. Evidence: .git/agent-handoffs/driver-replies-build/evidence/B2.

### [BUG-1795540134] VERIFICATION.md 1.5 host grep does not exclude the LinkedIn and Truth Social post modules
- [ ] **Severity:** low
- **Area:** docs
- **File(s):** VERIFICATION.md
- **Observation:** Stage 1.5's `git grep -nE "https://" src/services | grep -vE ...` exclusion list predates the LinkedIn (FEAT-1794395496) and Truth Social (FEAT-1793013312) post modules. At b5f281f it reports src/services/LinkedIn.ts (www.linkedin.com permalinks) and src/services/TruthSocial.ts (truthsocial.com), which hold their own host constants the same way the excluded Instagram and Bluesky modules do. It also reports a Discord developer-docs link in a src/services/PreviewRecovery.ts comment. The accepted-hit list names neither.
- **Expected:** The 1.5 command reports only new hard-coded provider hosts: add LinkedIn and TruthSocial to the exclusion and name the PreviewRecovery.ts docs comment as an accepted hit, or move the check into a CI guard script.
- **Req:** none (found by the V&V protocol run, 2026-11-24)
- **Depends on:** none
- **Repro / Notes:** Run the 1.5 command at b5f281f. Truth Social's network reads go through ArticlePreview.ts's bounded helpers (statusJson and fetchText). LinkedIn.ts makes no fetch itself.
- **Bump:** patch
- **Status:** open
- **Log:**
  - 2026-11-24 protocol: Found by: protocol (Stage 1.5). Class: stale verification step, not a product defect.

### [BUG-1795648504] Persistent-state inventory omits existing runtime JSON files
- [ ] **Severity:** low
- **Area:** docs
- **File(s):** VERIFICATION.md
- **Observation:** R11 review found Appendix A at line 228 omits reply-cleanup.json, personal-preferences.json, service-checkpoint.json and prompt-jobs.json, all already wired by src/bot.ts before BUG-1795645210.
- **Expected:** The persistent-state inspection inventory lists those existing state files and their purposes.
- **Req:** none; operator documentation accuracy
- **Depends on:** none
- **Repro / Notes:** Compare VERIFICATION.md Appendix A against src/bot.ts constructors for ReplyCleanupJournal, PersonalPreferences, ServiceCheckpoint and PromptService. Found by: review (R11-11). Pre-existing drift, not fixed in this PR.
- **Bump:** patch
- **Status:** open

### [BUG-1795648784] Bluesky post handle masked label keeps markdown escapes
- [ ] **Severity:** low
- **Area:** previews
- **File(s):** src/services/BlueskyPanel.ts:53
- **Observation:** heading inserts escapeMarkdown(handle) into a masked-link label. Discord does not honor backslash escapes inside masked-link labels (driver live evidence, 2026-11-25).
- **Expected:** Provider or member text displays literally; links use fixed labels when needed.
- **Req:** none (sibling sweep for BUG-1795648664)
- **Depends on:** none (independent renderer)
- **Repro / Notes:** Use elric-mtl.bsky.social: the escaped hyphen remains visible inside the label. Found by F9 sibling sweep; outside reply pages, not fixed in this PR.
- **Bump:** patch
- **Status:** open

### [BUG-1795648785] Bluesky facet link labels interpret provider markdown
- [ ] **Severity:** low
- **Area:** previews
- **File(s):** src/services/BlueskyPost.ts:88
- **Observation:** blueskyText puts arbitrary provider facet text into a masked-link label, escaping only brackets and backslashes. Discord does not honor backslash escapes inside masked-link labels (driver live evidence, 2026-11-25).
- **Expected:** Provider or member text displays literally; links use fixed labels when needed.
- **Req:** none (sibling sweep for BUG-1795648664)
- **Depends on:** none (independent renderer)
- **Repro / Notes:** Facet text _abc_ becomes italic; square brackets produce visible escape characters. Found by F9 sibling sweep; outside reply pages, not fixed in this PR.
- **Bump:** patch
- **Status:** open

### [BUG-1795648786] Instagram username masked label keeps markdown escapes
- [ ] **Severity:** low
- **Area:** previews
- **File(s):** src/services/InstagramPresentation.ts:25
- **Observation:** instagramPanelComponents inserts escapeMarkdown(username) into a masked-link label. Discord does not honor backslash escapes inside masked-link labels (driver live evidence, 2026-11-25).
- **Expected:** Provider or member text displays literally; links use fixed labels when needed.
- **Req:** none (sibling sweep for BUG-1795648664)
- **Depends on:** none (independent renderer)
- **Repro / Notes:** Username a_b produces a literal backslash inside the profile label. Found by F9 sibling sweep; outside reply pages, not fixed in this PR.
- **Bump:** patch
- **Status:** open

### [BUG-1795648787] Post prose URL masked labels interpret member or provider path markdown
- [ ] **Severity:** low
- **Area:** previews
- **File(s):** src/services/TweetTranslation.ts:69
- **Observation:** formatProse derives a masked-link label from host and pathname and only escapes brackets and backslashes. Discord does not honor backslash escapes inside masked-link labels (driver live evidence, 2026-11-25).
- **Expected:** Provider or member text displays literally; links use fixed labels when needed.
- **Req:** none (sibling sweep for BUG-1795648664)
- **Depends on:** none (independent renderer)
- **Repro / Notes:** URL https://example.com/_abc_ has formatting interpreted in the displayed path; this helper is also reused by Bluesky prose. Found by F9 sibling sweep; outside reply pages, not fixed in this PR.
- **Bump:** patch
- **Status:** open

### [BUG-1795648788] Article video author masked labels keep markdown escapes
- [ ] **Severity:** low
- **Area:** previews
- **File(s):** src/services/ArticlePosts.ts:125
- **Observation:** articleVideoComponents inserts inert(author), with markdown escapes, into a masked-link label. Discord does not honor backslash escapes inside masked-link labels (driver live evidence, 2026-11-25).
- **Expected:** Provider or member text displays literally; links use fixed labels when needed.
- **Req:** none (sibling sweep for BUG-1795648664)
- **Depends on:** none (independent renderer)
- **Repro / Notes:** Author a_b with an author URL produces a literal backslash in the byline. Found by F9 sibling sweep; outside reply pages, not fixed in this PR.
- **Bump:** patch
- **Status:** open

### [BUG-1795648789] Article video title masked labels interpret provider markdown
- [ ] **Severity:** low
- **Area:** previews
- **File(s):** src/services/ArticlePosts.ts:126
- **Observation:** articleVideoComponents inserts card.title into a masked-link label; upstream title literals contain escaped markdown. Discord does not honor backslash escapes inside masked-link labels (driver live evidence, 2026-11-25).
- **Expected:** Provider or member text displays literally; links use fixed labels when needed.
- **Req:** none (sibling sweep for BUG-1795648664)
- **Depends on:** none (independent renderer)
- **Repro / Notes:** Provider title _abc_ or a_b retains escapes or formats text in a masked heading link. Found by F9 sibling sweep; outside reply pages, not fixed in this PR.
- **Bump:** patch
- **Status:** open

### [BUG-1795685854] YouTube comment lookup requests commenters' channel URLs that Linky never uses
- [ ] **Severity:** low
- **Area:** privacy, youtube
- **File(s):** src/services/YouTubeComments.ts
- **Observation:** src/services/YouTubeComments.ts:36 asks the YouTube Data API commentThreads endpoint for snippet.authorChannelUrl in its fields mask. The parser never reads it (grep: only the fields string and two test fixtures, tests/bot.test.ts:1230 and tests/youtube-comments.test.ts), and the hosted privacy notice says Linky does not copy commenters' channel links.
- **Expected:** The fields mask requests only the fields the parser reads (textDisplay, authorDisplayName, authorProfileImageUrl, likeCount, publishedAt and the ids), so no unused commenter data is fetched.
- **Req:** none; data minimisation in the hosted privacy notice (linky-web content/privacy.md, Reply and comment threads)
- **Depends on:** none
- **Repro / Notes:** Read the fields string at src/services/YouTubeComments.ts:36 and grep src for authorChannelUrl. Found by: driver review of linky-web PR #67. The value stays in memory only and is discarded by the parser; no disk write or display.
- **Bump:** patch
- **Status:** open

### [BUG-1795689487] Product roadmap still advertises retired Instagram presentation choices
- [ ] **Severity:** low
- **Area:** docs
- **File(s):** docs/product-roadmap.md:19
- **Observation:** The living roadmap says current release work adds three Instagram presentation choices. The current caption-free implementation removed those choices; README and docs/instagram-media.md describe the replacement. Found by: protocol (V2 Stage 3.1 freshness audit). Class: pre-existing doc drift.
- **Expected:** The roadmap describes the current caption-free Instagram behavior without advertising retired choices.
- **Req:** none; living documentation accuracy
- **Depends on:** none
- **Repro / Notes:** Compare docs/product-roadmap.md:19 with README Instagram section, src/services/ServerSettings.ts RETIRED_FIELDS, and docs/instagram-media.md. Detection only; historical research remains unchanged.
- **Bump:** patch
- **Status:** open
