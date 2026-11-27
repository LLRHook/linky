# Core requirements — Linky

Related: [SRS index](../SRS.md) · [Data Contracts](../DATA_CONTRACTS.md) · [Architecture](../ARCHITECTURE.md).

ADOPT baseline `1a69229`, 2026-11-26. Implemented means inspected code, not a new test execution or playback guarantee. Acceptance scenarios below are derived from cited behavior and await owner confirmation through the grouped area TBD returned to the index owner. Existing sources remain unchanged.

## 3.1 Functions

### CORE-FR-001 — New-message eligibility
The system shall start automatic processing only for new human-authored guild messages within effective server and channel scope.

- Priority: Must
- Rationale: Preserve the documented new-message eligibility behavior and failure boundary.
- Source: README.md §Supported links: “Automatic fixing starts with new messages from people”; src/bot.ts; src/services/ServerScope.ts; src/services/RepostEligibility.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/bot.ts`, `src/services/ServerScope.ts`, `src/services/RepostEligibility.ts`)
- UI: Discord — preview, progress and private controls
- Acceptance:
  - Given a bot, webhook or out-of-scope message, when received, then no automatic repost starts. Given an unrelated old message, when edited, then no new repost starts. (derived, confirm)
- Traces: ENT-001, EVT-001, EVT-002, CMP-002, CMP-061, CMP-064, CMP-068

### CORE-FR-002 — Unsupported message structures
The system shall skip automatic copying outside Default/Reply message types or with polls, pins, threads, stickers, components, snapshots, voice/crosspost flags or ephemeral attachments.

- Priority: Must
- Rationale: Preserve the documented unsupported message structures behavior and failure boundary.
- Source: README.md §Supported links: “Polls, stickers, forwards, pinned messages and thread starters are skipped”; src/services/RepostEligibility.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/RepostEligibility.ts`)
- UI: Discord — preview, progress and private controls
- Acceptance:
  - Given any listed structure or a partial message, when processing runs, then the original stays without a replacement. (derived, confirm)
- Traces: EVT-001, CMP-061, CMP-068

### CORE-FR-003 — Explicit suppression
The system shall skip automatic handling of suppressed embeds and case-insensitive whitespace-delimited !nolinky tokens.

- Priority: Must
- Rationale: Preserve the documented explicit suppression behavior and failure boundary.
- Source: README.md §Server preferences: “Put `!nolinky` in a message to skip automatic fixing”; src/services/RepostEligibility.ts; src/services/SocialLinkService.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/RepostEligibility.ts`, `src/services/SocialLinkService.ts`)
- UI: Discord — preview, progress and private controls
- Acceptance:
  - Given either suppression, when receiving a message, then it remains unchanged. Given the token letters inside another word, when checked, then that substring alone does not bypass processing. (derived, confirm)
- Traces: CMP-061, CMP-068

### CORE-FR-004 — Visible supported HTTPS tokens
The system shall consider only supported HTTPS URL tokens outside angle brackets, code and spoilers.

- Priority: Must
- Rationale: Preserve the documented visible supported https tokens behavior and failure boundary.
- Source: README.md §Supported links: “Supported links must use HTTPS”; §Server preferences; src/services/LinkTokens.ts; src/services/SocialProviders.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/LinkTokens.ts`, `src/services/SocialProviders.ts`)
- UI: Discord — preview, progress and private controls
- Acceptance:
  - Given hidden or non-HTTPS links, when rewriting, then those tokens remain unchanged. (derived, confirm)
- Traces: CMP-036, CMP-069

### CORE-FR-005 — Canonicalization
The system shall remove social tracking queries while retaining article queries, valid YouTube start timestamps and surrounding text.

- Priority: Must
- Rationale: Preserve the documented canonicalization behavior and failure boundary.
- Source: README.md §Supported links: “Social tracking query strings are removed”; src/services/SocialProviders.ts; src/services/YouTube.ts; src/services/ArticlePreview.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/SocialProviders.ts`, `src/services/YouTube.ts`, `src/services/ArticlePreview.ts`)
- UI: Discord — preview, progress and private controls
- Acceptance:
  - Given social tracking, article parameters and valid video start times, when rewritten, then social tracking disappears and the other listed information survives. (derived, confirm)
- Traces: CMP-036, CMP-069, CMP-078, CMP-006

### CORE-FR-006 — Replace safeguards
The system shall delete a Replace source only after useful preview coverage, complete attachment copies, saved ownership and fresh source/settings checks succeed.

- Priority: Must
- Rationale: Preserve the documented replace safeguards behavior and failure boundary.
- Source: README.md §Supported links: “Before removing an original, Linky waits for a useful preview tied to each rewritten post”; docs/delivery-reliability.md introduction; src/services/SocialLinkService.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/SocialLinkService.ts`)
- UI: Discord — preview, progress and private controls
- Acceptance:
  - Given changed source/settings, failed copies, unconfirmed previews or failed ownership persistence, when finalizing, then the original remains and unsafe replacement rollback is attempted. (derived, confirm)
- Traces: ENT-001, ENT-004, CMP-068, CMP-060, CMP-063

### CORE-FR-007 — Reply mode
The system shall retain the source and its attachments when publishing an attributed Reply preview.

- Priority: Must
- Rationale: Preserve the documented reply mode behavior and failure boundary.
- Source: README.md §Server preferences: “Reply mode keeps the source and its attachments”; src/services/SocialLinkService.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/SocialLinkService.ts`)
- UI: Discord — preview, progress and private controls
- Acceptance:
  - Given Reply mode, when publishing, then source files remain on the source and are not copied into the reply. (derived, confirm)
- Traces: ENT-001, ENT-004, CMP-068

### CORE-FR-008 — Matching useful evidence
The system shall confirm ordinary delivery only from useful metadata matching every expected rewritten post and required media type.

- Priority: Must
- Rationale: Preserve the documented matching useful evidence behavior and failure boundary.
- Source: README.md §Supported links: “Known videos require video metadata”; docs/delivery-reliability.md §Preview detection and provider recovery; src/services/PreviewRecovery.ts; src/services/RepostDelivery.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/PreviewRecovery.ts`, `src/services/RepostDelivery.ts`)
- UI: Discord — preview, progress and private controls
- Acceptance:
  - Given unrelated, empty or recognized error metadata, when inspecting, then it cannot confirm delivery. Given a known video, when only photo metadata appears, then it remains unconfirmed. Given translated text already delivered as a caption, when building expectations, then no separate native text embed is required. (derived, confirm)
- Traces: CMP-046, CMP-060, CMP-068

### CORE-FR-009 — Gateway-first reconciliation
The system shall arm confirmation before publication or edit and perform at most one bounded REST reconciliation after an unconfirmed Gateway wait.

- Priority: Must
- Rationale: Preserve the documented gateway-first reconciliation behavior and failure boundary.
- Source: docs/delivery-reliability.md §Preview detection: “subscribes ... before publishing or editing”; src/services/PreviewWatcher.ts; src/commands/fix.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/PreviewWatcher.ts`, `src/commands/fix.ts`)
- UI: Discord — preview, progress and private controls
- Acceptance:
  - Given useful early metadata, when send resolves, then matching buffered evidence can confirm immediately. Given a missed update, when the wait expires, then one refetch reconciles; manual replies use their interaction webhook even without channel Gateway access. (derived, confirm)
- Traces: API-035, CMP-047, CMP-087, CMP-068

### CORE-FR-010 — Provider error early exit
The system shall end a wait unconfirmed when every still-missing post has a recognized error card matching the current provider and post identity.

- Priority: Must
- Rationale: Preserve the documented provider error early exit behavior and failure boundary.
- Source: docs/delivery-reliability.md §Preview detection: “A recognised provider error card ends the wait immediately”; src/services/PreviewRecovery.ts; src/services/PreviewWatcher.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/PreviewRecovery.ts`, `src/services/PreviewWatcher.ts`)
- UI: Discord — preview, progress and private controls
- Acceptance:
  - Given canonical-host, wrong-provider, wrong-post or unrecognized cards, when inspecting, then the classifier abstains and the bounded wait continues. (derived, confirm)
- Traces: CMP-046, CMP-047

### CORE-FR-011 — Alternate recovery
The system shall try available catalogued alternates in the same ordinary-preview message after failed confirmation.

- Priority: Must
- Rationale: Preserve the documented alternate recovery behavior and failure boundary.
- Source: README.md §Supported links: “Failed previews try an alternate provider when available, in the same message”; src/services/PreviewRecovery.ts; src/services/SocialLinkService.ts; src/commands/fix.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/PreviewRecovery.ts`, `src/services/SocialLinkService.ts`, `src/commands/fix.ts`)
- UI: Discord — preview, progress and private controls
- Acceptance:
  - Given a failed primary and an alternate, when recovering, then the existing message is edited and checked again. Given no useful confirmation, when recovery ends, then the original remains. (derived, confirm)
- Traces: CMP-046, CMP-060, CMP-068, CMP-087

### CORE-FR-012 — Retry authority
The system shall allow saved Retry preview actions only to current channel members with view/send permission and no timeout.

- Priority: Must
- Rationale: Preserve the documented retry authority behavior and failure boundary.
- Source: README.md §Server preferences: “Retry preview ... current view/send permission”; src/bot.ts; src/services/RepostRegistry.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/bot.ts`, `src/services/RepostRegistry.ts`)
- UI: Discord — preview, progress and private controls
- Acceptance:
  - Given an eligible clicker, when retrying, then the source remains and attribution/Remove ownership stay with the original sharer. Given an in-flight retry or a completed retry within 30 seconds for that source, when clicked, then a private wait notice appears. (derived, confirm)
- Traces: ENT-004, API-011, CMP-002, CMP-063

### CORE-FR-013 — Remove authority
The system shall restrict Remove to the automatic original sharer or manual requester even when another clicker is an administrator or moderator.

- Priority: Must
- Rationale: Preserve the documented remove authority behavior and failure boundary.
- Source: README.md §Server preferences: “Only the original sharer can use Remove”; src/services/RepostRegistry.ts; src/commands/fix.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/RepostRegistry.ts`, `src/commands/fix.ts`)
- UI: Discord — preview, progress and private controls
- Acceptance:
  - Given a different member, when Remove is clicked, then deletion is refused privately. Given a valid owner and matching bot message/location, when Remove succeeds, then the preview is deleted. (derived, confirm)
- Traces: ENT-004, API-011, API-012, CMP-063, CMP-087

### CORE-FR-014 — Original source controls
The system shall offer Original post links to visible recognized source permalinks for preview viewers.

- Priority: Must
- Rationale: Preserve the documented original source controls behavior and failure boundary.
- Source: README.md §Server preferences: “Anyone who can see a preview can open its Original post link”; src/services/RepostPresentation.ts; src/commands/fixMedia.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/RepostPresentation.ts`, `src/commands/fixMedia.ts`)
- UI: Discord — preview, progress and private controls
- Acceptance:
  - Given a visible source control, when opened, then the original permalink opens without changing Remove ownership. (derived, confirm)
- Traces: API-011, API-012, CMP-062, CMP-088

### CORE-FR-015 — Bound private Details
The system shall return delivery Details privately only after matching the saved attempt to its exact bot message, channel and server.

- Priority: Must
- Rationale: Preserve the documented bound private details behavior and failure boundary.
- Source: docs/delivery-reliability.md §What members see: “The exact bot message, channel and server must still match”; src/services/DeliveryDetails.ts; src/services/DeliveryAttempt.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/DeliveryDetails.ts`, `src/services/DeliveryAttempt.ts`)
- UI: Discord — preview, progress and private controls
- Acceptance:
  - Given a public server preview, when a viewer clicks valid Details, then the report is private to that viewer. Given a private reply or DM, when a different requester attempts access, then it is refused. Given missing/expired/mismatched binding, when clicked, then details-unavailable appears. (derived, confirm)
- Traces: ENT-009, API-013, CMP-015, CMP-017, CMP-018

### CORE-FR-016 — Details output scope
The system shall describe the bound attempt using its finite outcome, platform/path and observed elapsed/stage seconds with overlap and playback limitations.

- Priority: Must
- Rationale: Preserve the documented details output scope behavior and failure boundary.
- Source: docs/delivery-reliability.md §What members see; src/services/DeliveryDetails.ts formatDeliveryDetails
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/DeliveryDetails.ts`)
- UI: Discord — preview, progress and private controls
- Acceptance:
  - Given an attempt, when Details renders, then its random attempt identity scopes elapsed seconds rounded to one decimal and sums same-stage spans; overlapping stages are disclosed. Given no outcome, when rendering, then preparing appears; absent cache/timing fields are omitted. Given confirmed metadata, when described, then the output disclaims client playback; no statistical baseline, minimum sample or sustained-health verdict applies to this single attempt. (derived, confirm)
- Traces: ENT-009, API-013, CMP-016, CMP-017

### CORE-FR-017 — Stage progress
The system shall coalesce slow-delivery progress into the automatic progress reply or existing manual response without inventing percentage or ETA.

- Priority: Must
- Rationale: Preserve the documented stage progress behavior and failure boundary.
- Source: docs/delivery-reliability.md §What members see: “do not invent a completion percentage or arrival time”; src/services/DeliveryProgress.ts; src/services/SocialLinkService.ts; src/commands/fix.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/DeliveryProgress.ts`, `src/services/SocialLinkService.ts`, `src/commands/fix.ts`)
- UI: Discord — preview, progress and private controls
- Acceptance:
  - Given slow work, when updating, then current stage and validated item position/cache observations describe only this job. Given final delivery, when publishing, then pending progress edits drain before the final response. (derived, confirm)
- Traces: CMP-019, CMP-068, CMP-087

### CORE-FR-018 — Sharer and reply context
The system shall credit the original sharer with a bounded reply excerpt that hides spoilers and link targets.

- Priority: Must
- Rationale: Preserve the documented sharer and reply context behavior and failure boundary.
- Source: README.md §Supported links: “Attachment names, descriptions, spoilers and reply context are preserved”; src/services/RepostPresentation.ts; src/services/ReplyContext.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/RepostPresentation.ts`, `src/services/ReplyContext.ts`)
- UI: Discord — preview, progress and private controls
- Acceptance:
  - Given a same-channel reference, when composing, then the original author or saved repost sharer and an excerpt up to 160 characters are shown. Given spoilers or links, when excerpting, then placeholders hide their content/targets. Given inaccessible or cross-channel context, when composing, then Original message unavailable appears without fetching another channel. (derived, confirm)
- Traces: ENT-004, CMP-055, CMP-062

### CORE-FR-019 — Complete source attachments
The system shall copy Replace attachments only after successful exact-size bounded downloads while retaining names, descriptions and spoiler flags.

- Priority: Must
- Rationale: Preserve the documented complete source attachments behavior and failure boundary.
- Source: README.md §Supported links; src/services/RepostAttachments.ts; src/services/SocialLinkService.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/RepostAttachments.ts`, `src/services/SocialLinkService.ts`)
- UI: Discord — preview, progress and private controls
- Acceptance:
  - Given failed, truncated, oversized or over-budget copying, when replacing, then the original remains. Given success, when uploaded, then the source-file properties survive within the ten-file and 25 MiB aggregate ceiling. (derived, confirm)
- Traces: API-057, CMP-059, CMP-068

### CORE-FR-020 — Explicit notification recipients
The system shall limit fresh automatic mention recipients to the sharer plus visible Discord-resolved explicit source user tags in Replace mode.

- Priority: Must
- Rationale: Preserve the documented explicit notification recipients behavior and failure boundary.
- Source: docs/delivery-reliability.md §Mention notifications: “Reply allows only the source author”; src/services/SourceMentions.ts; src/services/SocialLinkService.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/SourceMentions.ts`, `src/services/SocialLinkService.ts`)
- UI: Discord — preview, progress and private controls
- Acceptance:
  - Given Reply, when posting, then only the sharer can be added. Given role/everyone/here tags, code/spoiler/escaped tags, provider text or quoted excerpts, when posting, then they add no recipients. Given fallback edits, when sent, then the original list is retained with at most 100 users. (derived, confirm)
- Traces: CMP-070, CMP-068

### CORE-FR-021 — Quiet secondary actions
The system shall preserve source SuppressNotifications and add no mention recipients for manual fixes, retries, refreshes, progress or failure notices.

- Priority: Must
- Rationale: Preserve the documented quiet secondary actions behavior and failure boundary.
- Source: README.md §Supported links: “Linky preserves @silent”; docs/delivery-reliability.md §Mention notifications; src/services/SocialLinkService.ts; src/commands/fix.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/SocialLinkService.ts`, `src/commands/fix.ts`)
- UI: Discord — preview, progress and private controls
- Acceptance:
  - Given @silent, when reposted, then SuppressNotifications remains. Given a secondary action, when sent, then its allowed-user list is empty; recipient settings and the original notification mean exactly one alert is not guaranteed. (derived, confirm)
- Traces: CMP-068, CMP-087, CMP-070

### CORE-FR-022 — Deletion refusal downgrade
The system shall downgrade a verified Replace preview to a tracked Reply copy after Discord deletion refusal 60003 or 50013.

- Priority: Must
- Rationale: Preserve the documented deletion refusal downgrade behavior and failure boundary.
- Source: README.md §Supported links: “keeps the verified preview as a tracked reply copy”; src/services/SocialLinkService.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/SocialLinkService.ts`)
- UI: Discord — preview, progress and private controls
- Acceptance:
  - Given explicit refusal and saved downgraded ownership, when finalizing, then source and verified preview remain with final controls and permission outcome. Given downgrade persistence failure, when handled, then replacement removal is attempted. Given another ambiguous deletion failure, when handled, then the potentially only remaining preview stays and final controls may be absent. (derived, confirm)
- Traces: ENT-004, CMP-068, CMP-063

### CORE-FR-023 — Complete one-block confirmation
The system shall require every media item of a selected authored block to confirm before accepting it as replacement delivery.

- Priority: Must
- Rationale: Preserve the documented complete one-block confirmation behavior and failure boundary.
- Source: docs/media-blocks.md §Publication paths and compatibility constraints; src/services/MediaWatch.ts; src/services/TweetPanel.ts; src/services/SocialLinkService.ts; src/commands/fixMedia.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/MediaWatch.ts`, `src/services/TweetPanel.ts`, `src/services/SocialLinkService.ts`, `src/commands/fixMedia.ts`)
- UI: Discord — preview, progress and private controls
- Acceptance:
  - Given a block, when checked within ten seconds, then every item needs matching loaded/proxy/type evidence or an allowed successful media-proxy probe. Given unconfirmed X/Bluesky media, when falling back, then the block is replaced by the ordinary card and rechecked; manual fallback publishes a new follow-up before deleting the old block. Given no approved fallback, when failing, then the original remains with a notice. (derived, confirm)
- Traces: API-058, CMP-042, CMP-072, CMP-068, CMP-088

### CORE-FR-024 — Complete mixed payload preservation
The system shall retain compatible content/embed/attachment delivery when a single-media block cannot represent source files or other requested previews.

- Priority: Must
- Rationale: Preserve the documented complete mixed payload preservation behavior and failure boundary.
- Source: docs/media-blocks.md §Publication paths: “preserves source-file integrity”; src/services/SocialLinkService.ts; src/commands/fix.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/SocialLinkService.ts`, `src/commands/fix.ts`)
- UI: Discord — preview, progress and private controls
- Acceptance:
  - Given copied source files, mixed native previews, multi-card or overlong payloads, when selecting presentation, then the compatible path preserves their content rather than silently discarding it. Given suppressed automatic embeds, when selecting, then no gallery overrides suppression. (derived, confirm)
- Traces: CMP-005, CMP-068, CMP-075, CMP-087

### CORE-FR-025 — Reply synchronization
The system shall synchronize active tracked Reply previews with source edits and single/bulk deletions through durable refresh/removal intents.

- Priority: Must
- Rationale: Preserve the documented reply synchronization behavior and failure boundary.
- Source: README.md §Server preferences: “Replies follow edits and deletions ... up to 30 days”; src/bot.ts; src/services/RepostRegistry.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/bot.ts`, `src/services/RepostRegistry.ts`)
- UI: Discord — preview, progress and private controls
- Acceptance:
  - Given an active Reply record, when its source changes or disappears, then the related preview is refreshed or removed and failed work remains retryable. (derived, confirm)
- Traces: ENT-004, EVT-002, EVT-003, EVT-004, CMP-063, CMP-002

### CORE-FR-026 — Graceful restart
The system shall stop accepting new work before draining active deliveries and cancelling unfinished work during shutdown.

- Priority: Must
- Rationale: Preserve the documented graceful restart behavior and failure boundary.
- Source: README.md §Reliability: “let running deliveries finish first”; src/bot.ts; src/services/InFlightWork.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/bot.ts`, `src/services/InFlightWork.ts`)
- UI: Discord — preview, progress and private controls
- Acceptance:
  - Given shutdown, when the default 20-second drain ends, then unfinished work is cancelled, watchers/sessions close and services flush before client destruction. Given a new interaction while stopping, when routed, then a private restarting response appears. (derived, confirm)
- Traces: EVT-005, CMP-002, CMP-031, CMP-066

### CORE-FR-027 — Bounded catch-up
The system shall recover missed eligible messages through ordinary handling when catch-up is enabled and the prior checkpoint is usable.

- Priority: Should
- Rationale: Preserve the documented bounded catch-up behavior and failure boundary.
- Source: README.md §Reliability: “up to two minutes old, in the 20 channels”; src/services/ServiceCheckpoint.ts; src/bot.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/ServiceCheckpoint.ts`, `src/bot.ts`)
- UI: Discord — preview, progress and private controls
- Acceptance:
  - Given valid checkpoint recovery, when scanning, then at most 20 remembered channels and 50 messages/channel run four channels concurrently, oldest first within each, within two minutes with a three-second clock margin. Given a live-seen message, when encountered, then it is not redelivered. Given disabled catch-up or unusable checkpoint, when starting, then no recovery scan runs. (derived, confirm)
- Traces: ENT-003, EVT-007, CMP-002, CMP-066

### CORE-FR-028 — Complete measurement boundary
The system shall start eligible-attempt measurement before mobile-share network resolution and expose observed provider-cache decisions.

- Priority: Should
- Rationale: Preserve the documented complete measurement boundary behavior and failure boundary.
- Source: features.md FEAT-1790785729: “Redirect latency is therefore absent from reported duration”
- Verification: Inspection
- Status: Proposed
- Delivery: Not started
- UI: Discord — preview, progress and private controls
- Acceptance:
  - Given delayed or failed share resolution, when measured, then its stage/time and documented outcome are represented. Given a cache lookup, when supported, then hit/miss is observed and absent evidence is unknown; reports disclose comparable denominators. (derived, confirm)
- Traces: ENT-009, ENT-010, CMP-015, CMP-016, CMP-043, CMP-068, CMP-087
- Tickets: FEAT-1790785729

### CORE-FR-029 — Exact uploaded-media confirmation
The system shall accept uploaded media evidence only for the prepared file in the expected presentation and permitted Discord CDN location.

- Priority: Must
- Rationale: Preserve the documented exact uploaded-media confirmation behavior and failure boundary.
- Source: docs/media-blocks.md private manual responses and Erome media verification; src/services/UploadedMedia.ts; src/services/EromeDelivery.ts; src/commands/fixMedia.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/UploadedMedia.ts`, `src/services/EromeDelivery.ts`, `src/commands/fixMedia.ts`)
- UI: Discord — preview, progress and private controls
- Acceptance:
  - Given a CDN URL, when matched, then HTTPS, the exact prepared filename, two numeric Discord path components and attachments/ephemeral-attachments on cdn.discordapp.com or media.discordapp.net are required with no explicit port/credentials; signed query strings are permitted. Given prepared Erome media, when confirming, then matching type, proxy and positive dimensions are required and legacy loose attachments also require prepared size. Given failed gallery confirmation, when automatic, then the replacement is removed and source kept; manual failure clears uploads and keeps a notice with original-link controls. (derived, confirm)
- Traces: CMP-075, CMP-025, CMP-088

### CORE-FR-030 — Diagnostic no-op exclusion
The system shall discard an intended no-op from delivery diagnostics when no YouTube lookup was attempted.

- Priority: Must
- Rationale: Preserve the documented diagnostic no-op exclusion behavior and failure boundary.
- Source: docs/delivery-reliability.md §Local retention and operations; src/services/SocialLinkService.ts; src/services/DeliveryAttempt.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/SocialLinkService.ts`, `src/services/DeliveryAttempt.ts`)
- UI: Discord — preview, progress and private controls
- Acceptance:
  - Given unchanged preview-only YouTube handling without lookup, when finishing, then no outcome record is added. Given an attempted failed/empty YouTube lookup or actual source-edit cancellation, when finishing, then the applicable cancelled attempt remains. (derived, confirm)
- Traces: ENT-009, ENT-010, CMP-068, CMP-015

## 3.2 Performance requirements

### CORE-NFR-001 — Performance: confirmation bounds
The system shall bound ordinary confirmation waits and active watcher state.

- Priority: Must
- Rationale: Preserve the documented performance: confirmation bounds behavior and failure boundary.
- Source: docs/delivery-reliability.md §Preview detection; src/services/PreviewWatcher.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/PreviewWatcher.ts`)
- Measure: X/Reddit/Facebook/Twitch wait <=10,000 ms; Instagram/TikTok <=8,000 ms; others <=4,000 ms. Default REST reconciliation 2,000 ms, maximum 5,000 ms. <=128 active watchers, <=16 early results/watch, 36,000 ms lifetime.
- Acceptance:
  - Given no useful update, when waiting, then the platform deadline and one reconciliation bound the check; cancellation disposes it. (derived, confirm)
- Traces: CMP-047

### CORE-NFR-002 — Performance: fair preparation
The system shall rotate queued media preparation between servers in arrival order within each server under bounded resource profiles.

- Priority: Should
- Rationale: Preserve the documented performance: fair preparation behavior and failure boundary.
- Source: docs/delivery-reliability.md §Scheduling and reuse; src/services/EromeWorkScheduler.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/EromeWorkScheduler.ts`)
- Measure: 8 globally waiting jobs, 2 waiting/server, 1 running/server. Original reserves 24 MiB, attachment 128 MiB against 192 MiB scratch. Compatible profiles overlap across different servers. These are not total process RSS limits.
- Acceptance:
  - Given competing servers, when a slot opens, then server rotation admits work with at most one active job/server. Given failed temporary-file cleanup, when admission runs, then uncertain capacity remains quarantined. (derived, confirm)
- Traces: CMP-030

### CORE-NFR-003 — Performance: bounded delivery and copies
The system shall cancel over-deadline delivery work while enforcing source-file byte and time ceilings.

- Priority: Must
- Rationale: Preserve the documented performance: bounded delivery and copies behavior and failure boundary.
- Source: docs/delivery-reliability.md §Scheduling; src/services/DeliveryAttempt.ts; src/services/RepostAttachments.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/DeliveryAttempt.ts`, `src/services/RepostAttachments.ts`)
- Measure: 120,000 ms delivery deadline including queue after attempt creation. Attachment copy <=15,000 ms/file, exact declared bytes and <=25 MiB aggregate. Share resolution currently precedes attempt timing; CORE-FR-028 proposes coverage.
- Acceptance:
  - Given a delivery deadline, when cancellation occurs, then source safety remains and encoder capacity is held until process exit/cleanup. Given an attachment beyond its declared or allowed size, when downloading, then copying fails. (derived, confirm)
- Traces: CMP-015, CMP-059, CMP-030

### CORE-NFR-004 — Performance: rewrite regression guard
The system shall provide a repeatable Node-only fixed-corpus ordinary-rewrite latency check.

- Priority: Should
- Rationale: Preserve the documented performance: rewrite regression guard behavior and failure boundary.
- Source: features.md FEAT-1790270881; PERFORMANCE_AUDIT.md exploratory measurements
- Verification: Inspection
- Status: Proposed
- Delivery: Not started
- Measure: Proposed 1,000 mixed messages and <10 s benchmark; proposed 2 ms/message p95 pending approval. Runner, repetitions, noise floor and abstain rule remain TBD-CORE-002.
- Acceptance:
  - Given the fixed corpus, when benchmarked, then per-message p50/p95/max and runner baseline are reported in under ten seconds. Given an approved budget, when exceeded, then a test fails; the proposed 2 ms p95 is not treated as approved. (derived, confirm)
- Traces: CMP-068, CMP-069
- Tickets: FEAT-1790270881

## 3.3 Usability requirements

Discord supplies native controls and accessibility. Functional requirements specify labels, private/error states and actions; no product-specific WCAG certification is evidenced.

## 3.4 Interface requirements

### CORE-IR-001 — Discord event boundary
The system shall use Gateway message/interaction events and bounded REST/webhook reconciliation for core delivery.

- Priority: Must
- Rationale: Preserve the documented discord event boundary behavior and failure boundary.
- Source: src/bot.ts; src/services/PreviewWatcher.ts; docs/DATA_CONTRACTS.md §4/§5/§7
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/bot.ts`, `src/services/PreviewWatcher.ts`)
- Acceptance:
  - Given a message or interaction event, when dispatched, then eligibility/ownership checks precede its action; personal installs without Gateway access reconcile their interaction reply. (derived, confirm)
- Traces: API-035, EVT-001, EVT-002, EVT-003, EVT-004, EVT-005, CMP-002, CMP-047

## 3.5 Logical database requirements

Data Contracts owns ENT-001/003/004/005/009 shapes. Core requirements constrain source authority and diagnostic retention without duplicating their schemas.

## 3.6 Design constraints

### CORE-CON-001 — Outbound destination admission
The system shall restrict bot outbound requests to validated HTTPS provider/asset destinations or guarded public-article retrieval without exposing an arbitrary fetch/proxy action.

- Priority: Must
- Rationale: Preserve the documented outbound destination admission behavior and failure boundary.
- Source: Approved adoption constraints; SECURITY_AUDIT.md historical threat model; src/services/SocialProviders.ts; src/services/ArticlePreview.ts; src/services/RegionalHttp.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/SocialProviders.ts`, `src/services/ArticlePreview.ts`, `src/services/RegionalHttp.ts`)
- Acceptance:
  - Given an unsupported member URL, when processed, then it does not become an unrestricted fetch. Given an article candidate, when retrieving, then raw URL, public DNS and each redirect are validated with pinned connections. Public articles and intended authenticated integrations remain scoped exceptions under TBD-S0-001. (derived, confirm)
- Traces: API-043, API-049, CMP-006, CMP-051, CMP-069

### CORE-CON-002 — Outbound I/O bounds
The system shall apply endpoint-specific timeout, redirect and byte restrictions to external retrieval.

- Priority: Must
- Rationale: Preserve the documented outbound i/o bounds behavior and failure boundary.
- Source: Approved adoption constraints; docs/runtime-security-2026-09-15.md historical resource bounds; docs/DATA_CONTRACTS.md §7; src/services/ArticlePreview.ts; workers/truth-social-relay/worker.mjs
- Verification: Inspection
- Status: Approved
- Delivery: Partial (bounded bot callers; optional relay upstream lacks explicit timer/stream rejection)
- Acceptance:
  - Given article metadata, when fetched, then a five-second window and 512 KiB head cap apply; PDFs read at most 4 MiB and post videos at most 15 MiB in a separate 15-second window. Given other endpoints, when fetched, then their Data Contracts restrictions apply; optional relay upstream timer/stream rejection remains TBD-S0-003. (derived, confirm)
- Traces: API-043, API-047, API-060, CMP-006, CMP-104

### CORE-CON-003 — No member sessions
The system shall fetch public sources without member credentials or cookie sessions while confining intended operator authentication to its integration boundary.

- Priority: Must
- Rationale: Preserve the documented no member sessions behavior and failure boundary.
- Source: Approved adoption constraints; src/services/ArticlePreview.ts; docs/DATA_CONTRACTS.md §7; SECURITY_AUDIT.md historical trust boundaries
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/ArticlePreview.ts`)
- Acceptance:
  - Given public source requests, when built, then member cookies/passwords are not accepted or forwarded. Given Discord/YouTube/GitHub/relay/regional authentication, when used, then it is sent only to the named boundary; blanket credential wording remains TBD-S0-001. (derived, confirm)
- Traces: API-035, API-041, API-055, API-056, CMP-006, CMP-052

### CORE-CON-004 — Public access only
The system shall preserve originals when supported public metadata and fallbacks cannot succeed without login or paywall bypass.

- Priority: Must
- Rationale: Preserve the documented public access only behavior and failure boundary.
- Source: README.md §Supported links: “does not ... bypass paywalls”; src/services/ArticlePreview.ts; src/services/TruthSocial.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/ArticlePreview.ts`, `src/services/TruthSocial.ts`)
- Acceptance:
  - Given an unavailable public source, when public fallbacks fail, then no login/paywall bypass is attempted and the original remains. The optional public Truth relay and page warming require explicit anti-bot-policy wording in TBD-S0-001. (derived, confirm)
- Traces: API-043, API-045, API-055, CMP-006, CMP-071

### CORE-CON-005 — Explicit allowed mentions
The system shall disable automatic mention parsing on generated Discord output with only the explicit source-user exception in CORE-FR-020.

- Priority: Must
- Rationale: Preserve the documented explicit allowed mentions behavior and failure boundary.
- Source: Approved adoption constraints; src/services/SocialLinkService.ts; src/services/SourceMentions.ts; src/commands/*.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/SocialLinkService.ts`, `src/services/SourceMentions.ts`, `src/commands/*.ts`)
- Acceptance:
  - Given generated content, when sent, then allowedMentions.parse is empty and role/everyone parsing and implicit replied-user notification grant no recipients. Given fresh automatic posting, when eligible, then only the explicit allowed-user list can notify. (derived, confirm)
- Traces: API-035, CMP-068, CMP-070, CMP-087

## 3.7 Software system attributes

### CORE-NFR-005 — Privacy: bounded Details history
The system shall retain only allowlisted diagnostic binding, finite outcome and timing data for private Details.

- Priority: Must
- Rationale: Preserve the documented privacy: bounded details history behavior and failure boundary.
- Source: docs/delivery-reliability.md §Local retention: “contains no message text, captions, URLs, media or credentials”; src/services/DeliveryDiagnostics.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/DeliveryDiagnostics.ts`)
- Measure: <=4,096 attempts, <=4 MiB, <=96 stages/attempt and seven days; default write wait 1,000 ms, maximum 2,000 ms.
- Acceptance:
  - Given expiry or capacity pressure, when maintenance/access runs, then records prune. Given a failed/slow diagnostic save, when delivering, then the preview continues without Details. Given restored unfinished work, when loading, then it is marked interrupted rather than resubmitted. (derived, confirm)
- Traces: ENT-009, API-013, CMP-018

### CORE-NFR-006 — Reliability: ownership retirement
The system shall retire inaccessible repost authority only after persisted continuous permission-failure grace or normal retention cleanup.

- Priority: Must
- Rationale: Preserve the documented reliability: ownership retirement behavior and failure boundary.
- Source: docs/delivery-reliability.md §Local retention; src/services/RepostRegistry.ts; src/services/CleanupFailure.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/RepostRegistry.ts`, `src/services/CleanupFailure.ts`)
- Measure: 30-day replacement-age retention; 24-hour permission grace; <=10,000 records/intent list. Retirement ends Remove/Retry/source synchronization for that record.
- Acceptance:
  - Given every checked sweep failing 50001/50013 or HTTP 403 for 24 hours, when retirement saves, then one numeric-only terminal notice appears without deleting the Discord message. Given a successful check or different error, when sweeping, then the permission clock resets. Given failed observation persistence, when sweeping, then authority remains retryable. (derived, confirm)
- Traces: ENT-004, ENT-005, CMP-063, CMP-013

### CORE-NFR-007 — Security: article SSRF rejection
The system shall reject unsafe article destinations before connection and after redirects.

- Priority: Must
- Rationale: Preserve the documented security: article ssrf rejection behavior and failure boundary.
- Source: SECURITY_AUDIT.md historical SSRF controls; src/services/ArticlePreview.ts publicUrl/publicAddresses; src/services/RegionalHttp.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/ArticlePreview.ts`, `src/services/RegionalHttp.ts`)
- Measure: Source URL <=500 characters; raw validated URL <=2,048; DNS set 1–32 IPv4 addresses all public; <=3 redirects. Historical audits establish no current vulnerability-free verdict.
- Acceptance:
  - Given credentials, explicit ports, IP literals, local/reserved names, disallowed service paths or any non-public DNS answer, when validating, then retrieval is rejected. Given a redirect, when followed, then validation and connection pinning repeat. (derived, confirm)
- Traces: API-043, CMP-006, CMP-051

## 3.8 Supporting information

Platform eligibility and media selection are in docs/srs/social.md; public retrieval behavior in docs/srs/articles.md; threads in docs/srs/replies.md; Erome hosting in docs/srs/erome.md; deployment, reports and operator archive in docs/srs/ops.md. CORE-CON-001 through CORE-CON-005 apply across areas; exceptions remain index TBD-S0-001/TBD-S0-003. Historical security documents retain their dates and are not a fresh security verdict.

## 5.1 Traceability matrix

| Req | Priority | Delivery | Entities | APIs / Events | Components | Verification |
|---|---|---|---|---|---|---|
| `CORE-FR-001` | Must | Implemented | ENT-001 | EVT-001, EVT-002 | CMP-002, CMP-061, CMP-064, CMP-068 | Inspection |
| `CORE-FR-002` | Must | Implemented | — | EVT-001 | CMP-061, CMP-068 | Inspection |
| `CORE-FR-003` | Must | Implemented | — | — | CMP-061, CMP-068 | Inspection |
| `CORE-FR-004` | Must | Implemented | — | — | CMP-036, CMP-069 | Inspection |
| `CORE-FR-005` | Must | Implemented | — | — | CMP-036, CMP-069, CMP-078, CMP-006 | Inspection |
| `CORE-FR-006` | Must | Implemented | ENT-001, ENT-004 | — | CMP-068, CMP-060, CMP-063 | Inspection |
| `CORE-FR-007` | Must | Implemented | ENT-001, ENT-004 | — | CMP-068 | Inspection |
| `CORE-FR-008` | Must | Implemented | — | — | CMP-046, CMP-060, CMP-068 | Inspection |
| `CORE-FR-009` | Must | Implemented | — | API-035 | CMP-047, CMP-087, CMP-068 | Inspection |
| `CORE-FR-010` | Must | Implemented | — | — | CMP-046, CMP-047 | Inspection |
| `CORE-FR-011` | Must | Implemented | — | — | CMP-046, CMP-060, CMP-068, CMP-087 | Inspection |
| `CORE-FR-012` | Must | Implemented | ENT-004 | API-011 | CMP-002, CMP-063 | Inspection |
| `CORE-FR-013` | Must | Implemented | ENT-004 | API-011, API-012 | CMP-063, CMP-087 | Inspection |
| `CORE-FR-014` | Must | Implemented | — | API-011, API-012 | CMP-062, CMP-088 | Inspection |
| `CORE-FR-015` | Must | Implemented | ENT-009 | API-013 | CMP-015, CMP-017, CMP-018 | Inspection |
| `CORE-FR-016` | Must | Implemented | ENT-009 | API-013 | CMP-016, CMP-017 | Inspection |
| `CORE-FR-017` | Must | Implemented | — | — | CMP-019, CMP-068, CMP-087 | Inspection |
| `CORE-FR-018` | Must | Implemented | ENT-004 | — | CMP-055, CMP-062 | Inspection |
| `CORE-FR-019` | Must | Implemented | — | API-057 | CMP-059, CMP-068 | Inspection |
| `CORE-FR-020` | Must | Implemented | — | — | CMP-070, CMP-068 | Inspection |
| `CORE-FR-021` | Must | Implemented | — | — | CMP-068, CMP-087, CMP-070 | Inspection |
| `CORE-FR-022` | Must | Implemented | ENT-004 | — | CMP-068, CMP-063 | Inspection |
| `CORE-FR-023` | Must | Implemented | — | API-058 | CMP-042, CMP-072, CMP-068, CMP-088 | Inspection |
| `CORE-FR-024` | Must | Implemented | — | — | CMP-005, CMP-068, CMP-075, CMP-087 | Inspection |
| `CORE-FR-025` | Must | Implemented | ENT-004 | EVT-002, EVT-003, EVT-004 | CMP-063, CMP-002 | Inspection |
| `CORE-FR-026` | Must | Implemented | — | EVT-005 | CMP-002, CMP-031, CMP-066 | Inspection |
| `CORE-FR-027` | Should | Implemented | ENT-003 | EVT-007 | CMP-002, CMP-066 | Inspection |
| `CORE-FR-028` | Should | Not started | ENT-009, ENT-010 | — | CMP-015, CMP-016, CMP-043, CMP-068, CMP-087 | Inspection |
| `CORE-NFR-001` | Must | Implemented | — | — | CMP-047 | Inspection |
| `CORE-NFR-002` | Should | Implemented | — | — | CMP-030 | Inspection |
| `CORE-NFR-003` | Must | Implemented | — | — | CMP-015, CMP-059, CMP-030 | Inspection |
| `CORE-NFR-004` | Should | Not started | — | — | CMP-068, CMP-069 | Inspection |
| `CORE-NFR-005` | Must | Implemented | ENT-009 | API-013 | CMP-018 | Inspection |
| `CORE-NFR-006` | Must | Implemented | ENT-004, ENT-005 | — | CMP-063, CMP-013 | Inspection |
| `CORE-CON-001` | Must | Implemented | — | API-043, API-049 | CMP-006, CMP-051, CMP-069 | Inspection |
| `CORE-CON-002` | Must | Partial (bounded bot callers; optional relay upstream lacks explicit timer/stream rejection) | — | API-043, API-047, API-060 | CMP-006, CMP-104 | Inspection |
| `CORE-CON-003` | Must | Implemented | — | API-035, API-041, API-055, API-056 | CMP-006, CMP-052 | Inspection |
| `CORE-CON-004` | Must | Implemented | — | API-043, API-045, API-055 | CMP-006, CMP-071 | Inspection |
| `CORE-CON-005` | Must | Implemented | — | API-035 | CMP-068, CMP-070, CMP-087 | Inspection |
| `CORE-NFR-007` | Must | Implemented | — | API-043 | CMP-006, CMP-051 | Inspection |
| `CORE-IR-001` | Must | Implemented | — | API-035, EVT-001, EVT-002, EVT-003, EVT-004, EVT-005 | CMP-002, CMP-047 | Inspection |
| `CORE-FR-029` | Must | Implemented | — | — | CMP-075, CMP-025, CMP-088 | Inspection |
| `CORE-FR-030` | Must | Implemented | ENT-009, ENT-010 | — | CMP-068, CMP-015 | Inspection |

## Revision history

| Rev | Date | Commit | Mode | Summary |
|---|---|---|---|---|
| 1 | 2026-11-26T15:33:08-05:00 | 0329a493616f | ADOPT | Initial CORE-FR-001–030, CORE-NFR-001–007, CORE-IR-001, CORE-CON-001–005 |
