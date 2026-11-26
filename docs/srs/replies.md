# Replies requirements — Linky

Related: [SRS index](../SRS.md). ADOPT baseline `1a69229`, 2026-11-26.

Delivery is conservatively Implemented from source inspection; tests cited here are verification targets, not fresh execution or a new V&V claim. Open-ticket requirements are Proposed.

## 3. Requirements

### 3.1 Functions

#### RPL-FR-001 — Thread control eligibility
The system shall offer reply-thread controls only for confirmed eligible single-post server outputs when replies are enabled.

- Priority: Should
- Rationale: Thread control eligibility supports bounded, reviewable replies behavior.
- Source: README.md / Replies and comments: "Replies are off by default"; src/services/ReplyThreads.ts; src/services/SocialLinkService.ts; src/commands/fix.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- Delivery evidence: README.md / Replies and comments: "Replies are off by default"; src/services/ReplyThreads.ts; src/services/SocialLinkService.ts; src/commands/fix.ts
- UI: Discord — confirmed post controls
- Acceptance:
  - Given replies enabled, when a confirmed single X or unlabelled Bluesky post has a positive provider reply count in a server text or announcement channel, then Replies (N) is offered, including public server manual previews; multi-link outputs, DMs, personal contexts, threads, forum/media and voice/stage channels have no control.
- Traces: ENT-001, API-017, API-018, CMP-058, CMP-068

#### RPL-FR-002 — Authorize every click
The system shall validate current reply-thread authorization before opening replies.

- Priority: Should
- Rationale: Authorize every click supports bounded, reviewable replies behavior.
- Source: src/services/ReplyThreads.ts handle; README.md / Replies and comments: "Create Public Threads and Send Messages in Threads"
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- Delivery evidence: src/services/ReplyThreads.ts handle; README.md / Replies and comments: "Create Public Threads and Send Messages in Threads"
- UI: Discord — private control response
- Acceptance:
  - Given a clicked control, when authorization fails, then a private unavailable response is returned; when either required permission is missing, then the private response names it and no thread is created.
- Traces: API-016, API-017, API-018, API-019, EVT-005, CMP-058

#### RPL-FR-003 — Existing threads and moderator decisions
The system shall reuse existing thread links without refreshing or paging copied replies.

- Priority: Should
- Rationale: Existing threads and moderator decisions supports bounded, reviewable replies behavior.
- Source: src/services/ReplyThreads.ts open; README.md / Replies and comments: "Existing threads are linked again"
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- Delivery evidence: src/services/ReplyThreads.ts open; README.md / Replies and comments: "Existing threads are linked again"
- UI: Discord — private thread link
- Acceptance:
  - Given a thread is archived, locked, owned by another actor or nonempty, when clicked again, then its URL is returned without repopulation; given recorded creation with a missing thread, when clicked, then removed is reported rather than recreating it.
- Traces: ENT-006, API-017, CMP-058, CMP-056

#### RPL-FR-004 — Serialize creation
The system shall coalesce simultaneous opens for one parent into one creation flight.

- Priority: Should
- Rationale: Serialize creation supports bounded, reviewable replies behavior.
- Source: src/services/ReplyThreads.ts handle/open
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- Delivery evidence: src/services/ReplyThreads.ts handle/open
- UI: Discord — private thread result
- Acceptance:
  - Given overlapping clicks for one parent, when creation is pending, then they share the same flight; given cleanup starts during a lookup, when publication resumes, then no new pages are started after the removal gate. (derived, confirm)
- Traces: API-017, CMP-058

#### RPL-FR-005 — Create and populate
The system shall create an eligible new public thread only after obtaining at least one usable reply and reserving its parent history.

- Priority: Should
- Rationale: Create and populate supports bounded, reviewable replies behavior.
- Source: src/services/ReplyThreads.ts open; README.md / Replies and comments
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- Delivery evidence: src/services/ReplyThreads.ts open; README.md / Replies and comments
- UI: Discord — public replies thread
- Acceptance:
  - Given usable replies and successful history reservation, when creation proceeds, then a thread with a control-character-free name of at most 100 characters and 1,440-minute autoarchive is populated; given no usable replies, when clicked, then a private no-replies notice appears and no thread is created.
- Traces: ENT-006, API-016, API-017, API-018, API-019, CMP-058, CMP-056

#### RPL-FR-006 — X selection
The system shall retain up to ten valid direct non-sensitive X replies ordered by likes descending then timestamp descending.

- Priority: Should
- Rationale: X selection supports bounded, reviewable replies behavior.
- Source: src/services/XReplies.ts parseXReplies; README.md / Replies and comments: "most liked first"
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- Delivery evidence: src/services/XReplies.ts parseXReplies; README.md / Replies and comments: "most liked first"
- UI: Discord — X replies thread
- Acceptance:
  - Given one conversation page, when parsed, then the anchor ID must match and malformed, non-direct or sensitive entries are hidden; given eligible entries, when selected, then the first ten in the documented order are retained.
- Traces: API-037, CMP-077, CMP-058
- Tickets: FEAT-1795541460

#### RPL-FR-007 — Bluesky selection
The system shall retain up to 25 public direct unlabelled Bluesky replies ordered by likes then newest.

- Priority: Should
- Rationale: Bluesky selection supports bounded, reviewable replies behavior.
- Source: src/services/BlueskyReplies.ts; README.md / Replies and comments
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- Delivery evidence: src/services/BlueskyReplies.ts; README.md / Replies and comments
- UI: Discord — Bluesky replies thread
- Acceptance:
  - Given an AppView response, when parsed, then anchor identity, direct parent and DID identity must match, and hidden, blocked, unavailable, author-labelled and post-labelled replies are excluded; ties and displayed dates use the earlier of author creation and indexing time.
- Traces: API-040, CMP-011, CMP-058
- Tickets: FEAT-1795541461

#### RPL-FR-008 — YouTube comments eligibility
The system shall offer Comments (N) only when the single-video comments gate passes.

- Priority: Should
- Rationale: YouTube comments eligibility supports bounded, reviewable replies behavior.
- Source: src/services/YouTubeReplyTarget.ts; src/services/YouTubeStats.ts; README.md / Replies and comments
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- Delivery evidence: src/services/YouTubeReplyTarget.ts; src/services/YouTubeStats.ts; README.md / Replies and comments
- UI: Discord — YouTube Comments control
- Acceptance:
  - Given preview-only or counts-only mode, missing key or nonpositive count, when controls are prepared, then no thread control is offered; given a valid click, when resolved, then its exact count comes from the bot control and its count time from that message creation timestamp.
- Traces: ENT-008, API-016, CMP-083, CMP-084

#### RPL-FR-009 — YouTube relevance page
The system shall copy up to 25 top-level comments for the requested YouTube video in provider relevance order.

- Priority: Should
- Rationale: YouTube relevance page supports bounded, reviewable replies behavior.
- Source: src/services/YouTubeComments.ts; README.md / Replies and comments: "1 YouTube Data API quota unit"
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- Delivery evidence: src/services/YouTubeComments.ts; README.md / Replies and comments: "1 YouTube Data API quota unit"
- UI: Discord — YouTube comments thread
- Acceptance:
  - Given an uncached comments request, when sent, then it requests commentThreads snippet with relevance, maxResults 25 and plainText for that video at one quota unit; mismatched video identities and invalid entries are omitted, and Open video links the video rather than a comment permalink.
- Traces: API-041, API-016, CMP-079, CMP-083, CMP-058
- Tickets: FEAT-1795541462

#### RPL-FR-010 — LinkedIn control gate
The system shall offer LinkedIn Comments (N) only when the confirmed single card has a positive visible count and at least one usable comment from its own preparation.

- Priority: Should
- Rationale: LinkedIn control gate supports bounded, reviewable replies behavior.
- Source: docs/article-previews.md / LinkedIn comments threads: "N is the count displayed on the card"; src/services/LinkedInComments.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- Delivery evidence: docs/article-previews.md / LinkedIn comments threads: "N is the count displayed on the card"; src/services/LinkedInComments.ts
- UI: Discord — LinkedIn Comments control
- Acceptance:
  - Given a confirmed eligible card, when preparing its control, then N retains the card count including compact notation; zero, unknown, mismatched-page or missing usable comments produce no button.
- Traces: API-019, API-048, CMP-038, CMP-058

#### RPL-FR-011 — LinkedIn selection
The system shall copy at most ten usable LinkedIn JSON-LD comments in page order from the matching signed-out post.

- Priority: Should
- Rationale: LinkedIn selection supports bounded, reviewable replies behavior.
- Source: docs/article-previews.md / LinkedIn comments threads; src/services/LinkedInComments.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- Delivery evidence: docs/article-previews.md / LinkedIn comments threads; src/services/LinkedInComments.ts
- UI: Discord — LinkedIn comments thread
- Acceptance:
  - Given matching VideoObject or SocialMediaPosting JSON-LD, when comments are parsed, then creator or author respectively supplies a Person name with valid text, likes and timestamp; invalid entries increment hidden, while valid entries beyond ten are unshown rather than hidden.
- Traces: API-048, API-019, CMP-038
- Tickets: FEAT-1795544485

#### RPL-FR-012 — LinkedIn click lookup isolation
The system shall resolve LinkedIn comments from the canonical post represented in the clicked owned output using an independent comments lookup.

- Priority: Should
- Rationale: LinkedIn click lookup isolation supports bounded, reviewable replies behavior.
- Source: docs/article-previews.md / LinkedIn comments threads: "Refreshes never write to, shorten, or evict the card cache"; src/services/ArticlePreview.ts comments; src/services/LinkedInComments.ts linkedInCommentsUrl
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- Delivery evidence: docs/article-previews.md / LinkedIn comments threads: "Refreshes never write to, shorten, or evict the card cache"; src/services/ArticlePreview.ts comments; src/services/LinkedInComments.ts linkedInCommentsUrl
- UI: Discord — private comments result
- Acceptance:
  - Given cached opted-in preparation, when comments are requested, then its bounded comment page or authoritative null can be reused without copying media bytes; given a miss, when admitted, then one head-only canonical posts GET is used without downloading media or consuming ordinary preview admission; failures, empty/mismatched pages and refused budget give a private no-comments notice.
- Traces: API-048, API-019, CMP-006, CMP-038, CMP-058

#### RPL-FR-013 — Counts and ranking disclosure
The system shall label copied-thread headers with the documented provider sample context.

- Priority: Should
- Rationale: Counts and ranking disclosure supports bounded, reviewable replies behavior.
- Source: src/services/ReplyThreads.ts replyThreadPayloads; README.md / Replies and comments; docs/article-previews.md / LinkedIn comments threads
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- Delivery evidence: src/services/ReplyThreads.ts replyThreadPayloads; README.md / Replies and comments; docs/article-previews.md / LinkedIn comments threads
- UI: Discord — thread header
- Acceptance:
  - Given X, Bluesky or LinkedIn data, when rendered, then N is provider total, r is returned entries, m is invalid/hidden entries and shown is retained entries; given YouTube data, then the header shows shown, published total, message count time and relevance order; these are one provider-page samples, not completeness or quality scores.
  - Given empty or invalid data, when clicked, then no thread is created; ranking uses raw likes with newest ties only for X/Bluesky, no minimum sample beyond one usable entry, no comparative baseline or statistical noise filter, and no sustained live-status claim.
- Traces: API-016, API-017, API-018, API-019, CMP-058

#### RPL-FR-014 — Copied text presentation
The system shall render copied replies as inert bounded text with author headings, separators and source-specific navigation.

- Priority: Should
- Rationale: Copied text presentation supports bounded, reviewable replies behavior.
- Source: src/services/ReplyThreads.ts replyThreadPayloads; src/services/ReplyText.ts; README.md / Replies and comments
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- Delivery evidence: src/services/ReplyThreads.ts replyThreadPayloads; src/services/ReplyText.ts; README.md / Replies and comments
- UI: Discord — copied comment pages
- Acceptance:
  - Given provider prose, when copied, then Markdown and mentions are escaped, embedded links become [link], and comment text is bounded to 500 serialized characters; X/Bluesky show plain handles, separate Profile and Open reply links, YouTube links the video, and LinkedIn shows plain names with only Open post navigation.
- Traces: CMP-057, CMP-058

#### RPL-FR-015 — Reply media presentation
The system shall include only approved provider avatar and image or poster addresses in copied reply pages.

- Priority: Should
- Rationale: Reply media presentation supports bounded, reviewable replies behavior.
- Source: src/services/ReplyThreads.ts replyMediaUrl/replyThreadPayloads; README.md / Replies and comments
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- Delivery evidence: src/services/ReplyThreads.ts replyMediaUrl/replyThreadPayloads; README.md / Replies and comments
- UI: Discord — reply galleries
- Acceptance:
  - Given media, when rendered, then at most four valid items per reply and an approved avatar are handed to Discord media proxy without Linky fetching or uploading bytes; absent or rejected media is labelled media not shown with available source navigation.
- Traces: API-035, CMP-058

#### RPL-FR-016 — Private failure states
The system shall return private actionable thread-open failures without publishing an empty thread.

- Priority: Should
- Rationale: Private failure states supports bounded, reviewable replies behavior.
- Source: src/services/ReplyThreads.ts handle/open; src/services/BlueskyReplies.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- Delivery evidence: src/services/ReplyThreads.ts handle/open; src/services/BlueskyReplies.ts
- UI: Discord — private errors
- Acceptance:
  - Given oversize Bluesky replies, when requested, then too-many-replies is reported privately; given removed parent, active-thread limit, permission denial, creation refusal or transient failure, when handled, then the corresponding private explanation or try-again notice is returned.
- Traces: API-016, API-017, API-018, API-019, CMP-058, CMP-011

#### RPL-FR-017 — Copied-page cleanup
The system shall remove only marked Linky reply pages from the matching bot-owned thread on related preview removal, retry or source change.

- Priority: Should
- Rationale: Copied-page cleanup supports bounded, reviewable replies behavior.
- Source: src/services/ReplyThreads.ts cleanup; src/bot.ts; tests/reply-cleanup.test.ts; README.md / Replies and comments
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- Delivery evidence: src/services/ReplyThreads.ts cleanup; src/bot.ts; tests/reply-cleanup.test.ts; README.md / Replies and comments
- UI: Discord — cleaned thread
- Acceptance:
  - Given cleanup for a parent, when the thread guild, channel and owner match, then creation is awaited, marked bot Default/Reply pages are removed, members and other previews remain, and the thread is named Replies removed and archived where Discord permits; terminal access/permission failures do not block parent removal and can leave pages or thread state unchanged; pagination advances from the greatest fetched snowflake and old pages use individual deletion.
- Traces: ENT-007, EVT-002, EVT-003, EVT-004, CMP-058, CMP-054, CMP-002

#### RPL-FR-018 — Durable manual cleanup
The system shall persist manual thread-cleanup intent before removing a parent that may have a reply thread.

- Priority: Should
- Rationale: Durable manual cleanup supports bounded, reviewable replies behavior.
- Source: docs/self-hosting.md / Replies setting and rollback; src/bot.ts; src/services/ReplyCleanupJournal.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- Delivery evidence: docs/self-hosting.md / Replies setting and rollback; src/bot.ts; src/services/ReplyCleanupJournal.ts
- UI: Discord — Remove and private failure
- Acceptance:
  - Given a parent needing cleanup, when reservation fails, then the parent remains and the requester receives a private failure; given pending deletion, then its reservation is held against sweeps until settlement, and failed transient cleanup stays queued; replies-off outputs without thread or creation evidence can bypass reservation.
  - Given automatic cleanup after parent deletion fails transiently, when transferred to the independent journal, then only cleanup IDs transfer and Retry can regenerate; a refused transfer retains the registry remove intent for its next sweep, while manual/speculative gateway jobs can drop new intent at full capacity.
  - Given single/bulk deletion events, when cached thread evidence or eligible cached manual output exists, then cleanup is queued after ownership checks; no retrospective scan of missing offline-deleted parents is promised.
- Traces: ENT-007, API-012, CMP-054, CMP-002

#### RPL-FR-019 — YouTube expiry integration
The system shall clean copied YouTube comments through the existing expiry cleanup hook.

- Priority: Should
- Rationale: YouTube expiry integration supports bounded, reviewable replies behavior.
- Source: README.md / Replies and comments; src/services/YouTubeStats.ts; src/bot.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- Delivery evidence: README.md / Replies and comments; src/services/YouTubeStats.ts; src/bot.ts
- UI: none (background)
- Acceptance:
  - Given controls reach 24-hour expiry and thread evidence is available, when expiry cleanup runs, then copied comments are cleaned while member messages remain; transient cleanup retries retire after more than seven days past expiry, and missing offline-deleted parents or lost access can leave pages.
- Traces: ENT-008, API-016, CMP-084, CMP-058, CMP-002

#### RPL-FR-020 — Creation history recovery
The system shall retain durable parent creation decisions across restarts before attempting Discord thread creation.

- Priority: Should
- Rationale: Creation history recovery supports bounded, reviewable replies behavior.
- Source: src/services/ReplyCreationHistory.ts; src/services/ReplyThreads.ts; docs/self-hosting.md / Replies setting and rollback
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- Delivery evidence: src/services/ReplyCreationHistory.ts; src/services/ReplyThreads.ts; docs/self-hosting.md / Replies setting and rollback
- UI: none (background)
- Acceptance:
  - Given known creation but a missing thread, when retried after restart, then creation is refused; given a definitive Discord 4xx creation refusal other than existing-thread reconciliation cases, then intent is cleared, while ambiguous transport/5xx retains it; failed clear drops in-memory evidence but can remain on disk until the next successful write.
- Traces: ENT-006, CMP-056, CMP-058

#### RPL-FR-021 — Mutation guard evidence
The system shall prove the listed surviving reply-thread guard mutations with named baseline, mutation and restoration results.

- Priority: Could
- Rationale: Mutation guard evidence supports bounded, reviewable replies behavior.
- Source: features.md FEAT-1795575314 "Acceptance criteria
- Verification: Inspection
- Status: Proposed
- Delivery: Not started
- UI: none (refactor)
- Acceptance:
  - Given every listed X, Bluesky, YouTube, shared and LinkedIn mutant, when validation is recorded, then original passes, mutation causes a named assertion failure and restored code passes; inapplicable/equivalent mutations abstain with reasons rather than counting as kills.
- Traces: CMP-058, CMP-011, CMP-038, CMP-002
- Tickets: FEAT-1795575314

### 3.2 Performance requirements

#### RPL-NFR-001 — Creation admission limits
The system shall bound new reply-thread admission per user and channel.

- Priority: Should
- Rationale: Creation admission limits supports bounded, reviewable replies behavior.
- Source: src/services/ReplyThreads.ts open
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- Delivery evidence: src/services/ReplyThreads.ts open
- Measure: 10-second user cooldown; three new admissions/channel/60 seconds; 10,000 active user keys and channel keys each.
- Acceptance:
  - Given new creation, when one user retries inside ten seconds or a channel reaches three creations in sixty seconds, then try again in a minute is returned; reuse of existing threads does not consume new-thread cooldown. (derived, confirm)
- Traces: CMP-058

#### RPL-NFR-002 — Reply lookup bounds
The system shall bound X, Bluesky and YouTube parsed reply lookup work independently of posting caches.

- Priority: Should
- Rationale: Reply lookup bounds supports bounded, reviewable replies behavior.
- Source: src/services/XReplies.ts; src/services/BlueskyReplies.ts; src/services/YouTubeComments.ts; README.md / Replies and comments
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- Delivery evidence: src/services/XReplies.ts; src/services/BlueskyReplies.ts; src/services/YouTubeComments.ts; README.md / Replies and comments
- Measure: Each lookup cache: at most 100 entries and eight in-flight requests; endpoint byte/deadline bounds as stated.
- Acceptance:
  - Given uncached lookups, when limits apply, then X uses five seconds and 256 KiB, Bluesky five seconds and 1 MiB, and YouTube comments 256 KiB through its bounded API transport; successes reuse for five minutes, failures for thirty seconds, with same-key requests coalesced.
- Traces: API-037, API-040, API-041, CMP-077, CMP-079, CMP-011, CMP-058

#### RPL-NFR-003 — LinkedIn comments budgets
The system shall bound LinkedIn comments misses without changing normal preview capacity or cache retention.

- Priority: Should
- Rationale: LinkedIn comments budgets supports bounded, reviewable replies behavior.
- Source: src/services/ArticlePreview.ts comments; docs/article-previews.md / LinkedIn comments threads
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- Delivery evidence: src/services/ArticlePreview.ts comments; docs/article-previews.md / LinkedIn comments threads
- Measure: Two in flight; ten new requests/minute; twenty pages; 512 KiB head-only; five-second request deadline.
- Acceptance:
  - Given no reusable card page, when comments are fetched, then the separate cache and admission limits apply; successes reuse five minutes and failures fifteen seconds; ordinary card processing retains its independent four-in-flight and thirty-per-minute budget.
- Traces: API-048, CMP-006

### 3.3 Usability requirements

#### RPL-NFR-004 — Message packing
The system shall pack copied reply pages within Discord component and text budgets.

- Priority: Should
- Rationale: Message packing supports bounded, reviewable replies behavior.
- Source: src/services/ReplyThreads.ts replyThreadPayloads; README.md / Replies and comments
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- Delivery evidence: src/services/ReplyThreads.ts replyThreadPayloads; README.md / Replies and comments
- Measure: At most 40 components and 3,800 counted text characters/message; four media items/reply.
- Acceptance:
  - Given a page, when packed, then header text counts toward the first message budget and each message contains at most ten comments with V2, suppressed embeds and quiet flags.
- Traces: API-035, CMP-058

### 3.4 Interface requirements

#### RPL-IR-001 — Provider identity boundaries
The system shall use provider-bound post identities for reply retrieval.

- Priority: Should
- Rationale: Provider identity boundaries supports bounded, reviewable replies behavior.
- Source: src/services/XReplies.ts; src/services/BlueskyReplies.ts; src/services/YouTubeComments.ts; src/services/ArticlePreview.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- Delivery evidence: src/services/XReplies.ts; src/services/BlueskyReplies.ts; src/services/YouTubeComments.ts; src/services/ArticlePreview.ts
- Acceptance:
  - Given a malformed or mismatched identity, when resolved, then no usable page is returned; Bluesky requests depth=1 and parentHeight=0, and no provider paging or nested-comment traversal occurs.
- Traces: API-037, API-040, API-041, API-048, CMP-011, CMP-038, CMP-058

### 3.5 Logical database requirements

#### RPL-FR-022 — History capacity and corrupt-state recovery
The system shall recover invalid creation history by quarantine with an operator warning while preserving bounded storage.

- Priority: Should
- Rationale: History capacity and corrupt-state recovery supports bounded, reviewable replies behavior.
- Source: src/services/ReplyCreationHistory.ts; README.md / Replies and comments
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- Delivery evidence: src/services/ReplyCreationHistory.ts; README.md / Replies and comments
- UI: none (background)
- Acceptance:
  - Given history exceeds 100,000 IDs or 2,400,002 read bytes (at most 2,300,002 bytes written), is malformed or unreadable, when loaded, then quarantine starts empty; quarantine failure disables new creation for that process run; write failure refuses creation for one minute while existing threads remain usable; at capacity oldest snowflakes are evicted and an incoming older parent can remain unrecorded.
- Traces: ENT-006, CMP-056

#### RPL-FR-023 — Cleanup journal retention
The system shall retain failed transient cleanup intent in the bounded independent reply cleanup journal.

- Priority: Should
- Rationale: Cleanup journal retention supports bounded, reviewable replies behavior.
- Source: src/services/ReplyCleanupJournal.ts; docs/self-hosting.md / Replies setting and rollback
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- Delivery evidence: src/services/ReplyCleanupJournal.ts; docs/self-hosting.md / Replies setting and rollback
- UI: none (background)
- Acceptance:
  - Given queued intent, when startup or the sixty-second sweep runs, then up to fifty entries are attempted from a rotating cursor and successful or terminal cleanup removes the entry; capacity is 10,000 ID-only entries, full queues warn/drop new intent, and malformed storage is quarantined with warnings.
- Traces: ENT-007, CMP-054

### 3.6 Design constraints

Product-wide request admission, timeout/redirect/byte limits, operator authentication boundaries, public access and mention parsing are owned by docs/srs/core.md CORE-CON-001 through CORE-CON-005; guarded article retrieval also references index TBD-S0-001. No duplicate constraint is defined here.

### 3.7 Software system attributes

#### 3.7.1 Reliability
Cleanup and failure behavior is specified above; product-wide reliability is in docs/srs/core.md.

#### 3.7.2 Availability
No area availability SLO is evidenced; see index TBD-S0-002.

#### 3.7.3 Security
See docs/srs/core.md CORE-CON-001 through CORE-CON-005 and CORE-NFR-007 for public destination admission and generated output.

#### 3.7.4 Maintainability
Verification targets include the owning unit and wiring tests; no additional maintainability percentage is adopted.

#### 3.7.5 Portability
Node and production platform configuration is owned by docs/srs/ops.md.

#### 3.7.6 Privacy and compliance
Reply creation history is ENT-006; durable cleanup intent is ENT-007. No provider comment text is saved in these stores. Successful provider caches are process-local; copied Discord pages follow removal triggers rather than a universal retention guarantee. History can lose old moderator decisions through eviction, quarantine or rollback. The 100-day illustration assumes 1,000 new parents/day; it is not a time-based retention promise.

#### 3.7.7 Observability
Verification targets: tests/reply-threads.test.ts, tests/reply-cleanup.test.ts, tests/replies-refresh.test.ts, tests/reply-snapshot.test.ts, tests/reply-presentation.test.ts, tests/reply-controls.test.ts, tests/bluesky-replies.test.ts, tests/youtube-comments.test.ts and tests/linkedin-comments-wiring.test.ts. Private action errors and operator warnings are described above; no external compliance certification is claimed.


### 3.8 Supporting information

Setup/settings, permission diagnostics and invite changes are owned by docs/srs/commands.md. YouTube counts, Top comment and control expiry are owned by docs/srs/social.md; this file owns only their thread hooks. Core Remove/Retry and source reconciliation are owned by docs/srs/core.md.

## 5. Appendices

### 5.1 Traceability matrix

| Req | Priority | Delivery | Entities | APIs / Events | Components | Verification |
|---|---|---|---|---|---|---|
| `RPL-FR-001` | Should | Implemented | ENT-001 | API-017, API-018 | CMP-058, CMP-068 | Inspection |
| `RPL-FR-002` | Should | Implemented | — | API-016, API-017, API-018, API-019, EVT-005 | CMP-058 | Inspection |
| `RPL-FR-003` | Should | Implemented | ENT-006 | API-017 | CMP-058, CMP-056 | Inspection |
| `RPL-FR-004` | Should | Implemented | — | API-017 | CMP-058 | Inspection |
| `RPL-FR-005` | Should | Implemented | ENT-006 | API-016, API-017, API-018, API-019 | CMP-058, CMP-056 | Inspection |
| `RPL-FR-006` | Should | Implemented | — | API-037 | CMP-077, CMP-058 | Inspection |
| `RPL-FR-007` | Should | Implemented | — | API-040 | CMP-011, CMP-058 | Inspection |
| `RPL-FR-008` | Should | Implemented | ENT-008 | API-016 | CMP-083, CMP-084 | Inspection |
| `RPL-FR-009` | Should | Implemented | — | API-041, API-016 | CMP-079, CMP-083, CMP-058 | Inspection |
| `RPL-FR-010` | Should | Implemented | — | API-019, API-048 | CMP-038, CMP-058 | Inspection |
| `RPL-FR-011` | Should | Implemented | — | API-048, API-019 | CMP-038 | Inspection |
| `RPL-FR-012` | Should | Implemented | — | API-048, API-019 | CMP-006, CMP-038, CMP-058 | Inspection |
| `RPL-FR-013` | Should | Implemented | — | API-016, API-017, API-018, API-019 | CMP-058 | Inspection |
| `RPL-FR-014` | Should | Implemented | — | — | CMP-057, CMP-058 | Inspection |
| `RPL-FR-015` | Should | Implemented | — | API-035 | CMP-058 | Inspection |
| `RPL-FR-016` | Should | Implemented | — | API-016, API-017, API-018, API-019 | CMP-058, CMP-011 | Inspection |
| `RPL-FR-017` | Should | Implemented | ENT-007 | EVT-002, EVT-003, EVT-004 | CMP-058, CMP-054, CMP-002 | Inspection |
| `RPL-FR-018` | Should | Implemented | ENT-007 | API-012 | CMP-054, CMP-002 | Inspection |
| `RPL-FR-019` | Should | Implemented | ENT-008 | API-016 | CMP-084, CMP-058, CMP-002 | Inspection |
| `RPL-FR-020` | Should | Implemented | ENT-006 | — | CMP-056, CMP-058 | Inspection |
| `RPL-FR-021` | Could | Not started | — | — | CMP-058, CMP-011, CMP-038, CMP-002 | Inspection |
| `RPL-NFR-001` | Should | Implemented | — | — | CMP-058 | Inspection |
| `RPL-NFR-002` | Should | Implemented | — | API-037, API-040, API-041 | CMP-077, CMP-079, CMP-011, CMP-058 | Inspection |
| `RPL-NFR-003` | Should | Implemented | — | API-048 | CMP-006 | Inspection |
| `RPL-NFR-004` | Should | Implemented | — | API-035 | CMP-058 | Inspection |
| `RPL-IR-001` | Should | Implemented | — | API-037, API-040, API-041, API-048 | CMP-011, CMP-038, CMP-058 | Inspection |
| `RPL-FR-022` | Should | Implemented | ENT-006 | — | CMP-056 | Inspection |
| `RPL-FR-023` | Should | Implemented | ENT-007 | — | CMP-054 | Inspection |

## Revision history

| Rev | Date | Commit | Mode | Summary |
|---|---|---|---|---|
| 1 | 2026-11-26T15:42:58-05:00 | 6d2131b09cd6 | ADOPT | Initial RPL-FR-001 through RPL-FR-023; RPL-NFR-001 through RPL-NFR-004; RPL-IR-001 |
