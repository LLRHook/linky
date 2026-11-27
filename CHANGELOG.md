# Changelog

Bug fixes are migrated here from `bugs.md` once verified. Features are
migrated from `features.md`. Each entry keeps the original `BUG-<id>` /
`FEAT-<id>` so history can be traced both ways.

The format is loosely [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
with `Verified`, `Added`, `Changed`, `Fixed`, `Removed`, and `Security`
sections under each release/date heading. Each migrated line ends with its
version-bump marker (`[major]`, `[minor]` or `[patch]`), which `/release` reads.

Work that shipped before the trackers existed (2026-09-24) is recorded in the
Git history and pull requests, not here.

---

## Unreleased

### Verified

### Added

### Changed

### Fixed

### Removed

### Security

## [v1.1.0] - 2026-11-26

### Verified

- 2026-11-26 V&V pass on Hostinger production (approved staging-token exception) plus isolated local production-profile image, SHA 61f5ee8: TypeScript 1756 passed; ESM 78 passed, 8 baseline skips; deploy 27 checks; container counts n/a (baselines retained); evidence ran 3 rows, ci 4 (#45796807937), carried 0; batch BUG-1790722056, BUG-1791399021, BUG-1791399500, BUG-1791399501, BUG-1790322965, BUG-1790322966, BUG-1790785731, BUG-1794401869, BUG-1794403249, BUG-1791830086, BUG-1791830959, BUG-1791831056, BUG-1791981980, BUG-1791986809, BUG-1791986810, BUG-1791986811, BUG-1791986812, BUG-1792164365, BUG-1792164560, BUG-1792536754, BUG-1792537162, BUG-1793013677, BUG-1793035756, BUG-1791833859, BUG-1793043364, BUG-1793043611, BUG-1793048766, BUG-1793226105, BUG-1793283258, BUG-1793284731, BUG-1790270870, BUG-1794864397, BUG-1794864398, BUG-1794864603, BUG-1794864628, BUG-1794864802, BUG-1794864951, BUG-1794864952, BUG-1794864954, BUG-1794864955, BUG-1794864956, BUG-1794961723, BUG-1794961724, BUG-1795443760, BUG-1795453217, BUG-1795454591, BUG-1795462081, BUG-1795645211, BUG-1795645210, BUG-1795648664, BUG-1795645212, FEAT-1791951567, FEAT-1791981013, FEAT-1791981014, FEAT-1791990467, FEAT-1791990468, FEAT-1791990469, FEAT-1791990470, FEAT-1791990471, FEAT-1792002672, FEAT-1792002673, FEAT-1793283259, FEAT-1794400497, FEAT-1794400619, FEAT-1794400814, FEAT-1794401068, FEAT-1794401433, FEAT-1795456232, FEAT-1795457628, FEAT-1795457637, FEAT-1795541460, FEAT-1795541461, FEAT-1795541462, FEAT-1795544485, FEAT-1795645566; stack fresh locally, data D3 restored, D1/D2 production probes accepted from driver; gui n/a (Discord-client walkthrough accepted from driver). Counts increased from the recorded 1190/62/24 baselines to 1756/86/27 through the merged batch; since V1 9f908cf the reply/history/provider regressions added 62 TypeScript and 1 ESM test. Live ticket evidence at 63d6f08, c2fe1f4, d67c2e6 and d856a61 is carried under driver decision E293; it was not observed again at 61f5ee8.

### Added

- [FEAT-1791951567] Facebook Reel and video previews [minor]
- [FEAT-1791981013] Extract repost eligibility, permission, link and expectation helpers from SocialLinkService [patch]
- [FEAT-1791981014] Split the /fix command's execute into named stages [patch]
- [FEAT-1791990467] Independent CI jobs behind one required CI gate [minor]
- [FEAT-1791990468] Acceptance evidence required in every pull request [minor]
- [FEAT-1791990469] Documentation consistency test against the provider catalog [minor]
- [FEAT-1791990470] One local validate command, primary Node version and pre-push hook [minor]
- [FEAT-1791990471] Shared Discord test fixtures and fake-timer timeout boundaries [minor]
- [FEAT-1792002672] Finish in-flight deliveries when the bot shuts down [minor]
- [FEAT-1792002673] Process messages posted while the bot was offline [minor]
- [FEAT-1793283259] PDF document cards [minor]
- [FEAT-1794400497] General article video blocks [minor]
- [FEAT-1794400619] Truth Social video upload and inline playback [minor]
- [FEAT-1794400814] Single video panels for manual fixes [minor]
- [FEAT-1794401068] Group standalone prepared Erome media and document compatibility fallbacks [minor]
- [FEAT-1794401433] Confirm images are already inside authored cards [minor]
- [FEAT-1795456232] Show Instagram posts as one caption-free block [minor]
- [FEAT-1795457628] Show every lone X post with media as one block [minor]
- [FEAT-1795457637] Show a lone Bluesky image post as one block [minor]
- [FEAT-1795541460] Replies thread for X posts: a Replies button opens a public thread with the post's top replies [minor]
- [FEAT-1795541461] Replies thread for Bluesky posts [minor]
- [FEAT-1795541462] Replies thread for YouTube videos (top comments) [minor]
- [FEAT-1795544485] Comments thread for LinkedIn posts from the page's own JSON-LD comments [minor]
- [FEAT-1795645566] Reply threads show who wrote each comment and display its media [minor]

### Fixed

- [BUG-1790270870] Docs named the CI Node matrix as 22 and 24; now 22, 24 and 26, and `SECURITY_AUDIT.md` points at `bugs.md`. [patch]
- [BUG-1790785731] Discord two-factor or permission refusals while deleting an original now keep the verified preview as a reply with Remove/Details controls and report a permission outcome; /diagnose flags servers that require moderator 2FA. [patch]
- [BUG-1792536754] Manual `/fix` and Apps → Fix with Linky now translate tweets and quotes in servers and DMs, honor translation settings, and preserve native previews when translation or required attachments are unavailable. [patch]
- [BUG-1792537162] Empty outer X posts now preserve their media while showing usable English translations of quoted text without an invented source-language label. [patch]
- [BUG-1790722056] Reddit app shares silently remain unchanged when Reddit blocks redirect resolution [patch]
- [BUG-1791399021] Instagram previews and caption lookups use an unavailable provider domain [patch]
- [BUG-1791399500] Dependency audit fails for development-only fast-copy [patch]
- [BUG-1791399501] Archive timeout test intermittently fails during temporary-directory cleanup [patch]
- [BUG-1790322965] Both Instagram providers fail: instagram7.com no longer resolves and OGInstagram returns 403 [patch]
- [BUG-1790322966] VERIFICATION.md step 1.4 secret-file check matches the source file LinkTokens.ts [patch]
- [BUG-1794401869] Manual media panel can confirm a revoked final verification [patch]
- [BUG-1794403249] Private article image uploads fail CDN confirmation [patch]
- [BUG-1791830086] TikTok share previews lack an exact post identity and a cold-media wait [patch]
- [BUG-1791830959] npm test requires a pre-existing build and can exercise stale provider code [patch]
- [BUG-1791831056] Operations documentation still names old runtime and state paths [patch]
- [BUG-1791981980] Permission tests can pass because the repost handler swallows assertions raised in its callbacks [patch]
- [BUG-1791986809] Operator docs and V&V checklist omit the Facebook platform [patch]
- [BUG-1791986810] Facebook, Erome and hosted-album wiring paths have no regression tests [patch]
- [BUG-1791986811] Strict-URL test case is a no-op and shared ID and platform constants are incomplete [patch]
- [BUG-1791986812] Facebook page-name pattern accepts dot-only names and the host allowlist is exported mutable [patch]
- [BUG-1792164365] Reddit component previews cannot be confirmed by Linky's embed verifier [patch]
- [BUG-1792164560] PR template assertion fails on Windows CRLF checkouts [patch]
- [BUG-1793013677] Locked undici 6.28.1 fails the dependency audit gate [patch]
- [BUG-1793035756] Truth Social card images and avatars do not render in Discord [patch]
- [BUG-1791833859] Verification checklist relies on CI evidence and retains completed run reports [patch]
- [BUG-1793043364] MyAnimeList catalogue previews are rejected as unverifiable articles [patch]
- [BUG-1793043611] Dependency audit fails for the existing undici version [patch]
- [BUG-1793048766] Verification backups are not ignored in other clones [patch]
- [BUG-1793226105] Telegraph articles remain bare links when the publisher blocks bot metadata requests [patch]
- [BUG-1793283258] Blocked Telegraph cards show only a URL-derived title instead of the real headline [patch]
- [BUG-1793284731] Secret scan fails after main history was rewritten [patch]
- [BUG-1794864397] X and Reddit preview wait ends before large-video unfurls arrive [patch]
- [BUG-1794864398] Delivery reliability window documentation omits Facebook [patch]
- [BUG-1794864603] Rejected preview reconcile fetch fails the delivery [patch]
- [BUG-1794864628] Repost cleanup retries permission failures without error detail or grace limit [patch]
- [BUG-1794864802] YouTube statistics cleanup retains expired failures indefinitely [patch]
- [BUG-1794864951] Link replacement failure log omits error class [patch]
- [BUG-1794864952] YouTube preview-display no-op is recorded as cancelled [patch]
- [BUG-1794864954] Preview failure logs omit provider history and matched-provider attribution [patch]
- [BUG-1794864955] Production image lacks a source commit label [patch]
- [BUG-1794864956] Recognized provider error cards should end preview waits early [patch]
- [BUG-1794961723] Instagram previews are never confirmed because OGInstagram answers Discord with a component link preview [patch]
- [BUG-1794961724] Instagram catalog still starts with fkinstagram.com, which no longer resolves [patch]
- [BUG-1795443760] Translated quote tweets show the post twice: captions beside a separate native card [patch]
- [BUG-1795453217] Translated Instagram post shows its caption outside the native card and repeats the author [patch]
- [BUG-1795454591] /fix cycles through every X provider although the first card already shows the post [patch]
- [BUG-1795462081] One-post blocks rarely confirm: Discord marks gallery media loaded long after the 10 s check [patch]
- [BUG-1795645211] LinkedIn video posts show a Comments button but the thread finds no comments [patch]
- [BUG-1795645210] Replies button recreates a moderator-deleted thread (Req: FEAT-1795541460) [patch]
- [BUG-1795648664] Reply-thread handles show stray backslashes inside the profile link [patch]
- [BUG-1795645212] TikTok share, Reddit video, Twitch clip and Facebook Reel previews end unconfirmed from the bot host [patch]
