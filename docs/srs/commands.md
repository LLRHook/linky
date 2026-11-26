# Commands requirements — Linky

Related: [SRS index](../SRS.md) · [Data Contracts](../DATA_CONTRACTS.md) · [Architecture](../ARCHITECTURE.md).

ADOPT baseline `1a69229`, 2026-11-26. Implemented means inspected code, not a new test execution or playback guarantee. Acceptance scenarios below are derived from cited behavior and await owner confirmation through the grouped area TBD returned to the index owner. Existing sources remain unchanged.

## 3.1 Functions

### CMD-FR-001 — Setup authorization
The system shall provide a private guild-installed /setup panel only to members with effective Manage Server permission.

- Priority: Must
- Rationale: Preserve the documented setup authorization behavior and failure boundary.
- Source: README.md §Add to Discord: “private setup card”; src/commands/setup.ts; src/commands/setupPanel.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/commands/setup.ts`, `src/commands/setupPanel.ts`)
- UI: Discord — Setup authorization response and controls
- Acceptance:
  - Given a DM or member without Manage Server, when setup or its component is invoked, then a private denial appears and no choice changes. Given permitted access, when opened, then current-channel scope and Reply/Replace examples appear. (derived, confirm)
- Traces: ENT-001, API-002, API-009, API-010, CMP-093, CMP-094

### CMD-FR-002 — Explicit enablement
The system shall change automatic server enablement only through explicit setup enable/disable actions while retaining preferences and channel choices.

- Priority: Must
- Rationale: Preserve the documented explicit enablement behavior and failure boundary.
- Source: README.md §Add to Discord: “Changing preferences alone never enables a server”; src/commands/setup.ts; src/services/ServerSettings.ts; src/bot.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/commands/setup.ts`, `src/services/ServerSettings.ts`, `src/bot.ts`)
- UI: Discord — Explicit enablement response and controls
- Acceptance:
  - Given a new unconfigured server, when Linky joins or choices change, then it remains inactive and sends no join message. Given enabled:true/false or Enable/Disable server, when saved, then enablement changes without clearing choices. (derived, confirm)
- Traces: ENT-001, API-002, API-010, CMP-093, CMP-065, CMP-002

### CMD-FR-003 — Autosaved setup choices
The system shall save valid setup mode, platform and channel selections automatically.

- Priority: Must
- Rationale: Preserve the documented autosaved setup choices behavior and failure boundary.
- Source: README.md §Add to Discord: “Menu selections save automatically”; src/commands/setupPanel.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/commands/setupPanel.ts`)
- UI: Discord — Autosaved setup choices response and controls
- Acceptance:
  - Given a valid authorized choice, when selected, then it persists and refreshes the panel without a Save step or implicit server activation. Given failed persistence, when saving, then previous choices remain and actionable error guidance appears. (derived, confirm)
- Traces: ENT-001, API-009, CMP-094, CMP-065

### CMD-FR-004 — Channel selection
The system shall support up to 25 selected channels, an explicit empty scope and All channels with accessible parent-thread inheritance.

- Priority: Must
- Rationale: Preserve the documented channel selection behavior and failure boundary.
- Source: README.md §Add to Discord: “selected parent channels include their accessible threads”; src/commands/setupPanel.ts; src/services/ServerScope.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/commands/setupPanel.ts`, `src/services/ServerScope.ts`)
- UI: Discord — Channel selection response and controls
- Acceptance:
  - Given no selected channels, when saved, then automatic scope is empty. Given All channels, when selected, then saved restrictions are removed within operator/server admission. Given a selected parent channel, when evaluating an accessible thread, then it inherits that scope; categories do not implicitly match descendants. (derived, confirm)
- Traces: ENT-001, API-009, API-010, CMP-094, CMP-064

### CMD-FR-005 — Readiness output
The system shall derive setup readiness from current effective channel scope, enabled platforms, sendability and required bot permissions.

- Priority: Must
- Rationale: Preserve the documented readiness output behavior and failure boundary.
- Source: README.md §Add to Discord: “effective scope, missing permissions”; src/commands/setupPanel.ts setupReadiness
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/commands/setupPanel.ts`)
- UI: Discord — Readiness output response and controls
- Acceptance:
  - Given current evidence, when rendering, then channel status, selection counts and missing permissions describe only this channel/saved configuration. Given unavailable permission evidence, when rendering, then cannot-check appears. Ready for a plain link requires enabled scope, at least one effective platform, sendability and no missing required permission; it asserts neither provider delivery nor playback. Statistical baseline, noise floor and sustained-status dwell do not apply to this point-in-time Boolean rule. (derived, confirm)
- Traces: ENT-001, API-002, CMP-094, CMP-064

### CMD-FR-006 — Explicit sample test
The system shall post a setup sample only on an authorized ready Test here action with effective X or YouTube support.

- Priority: Must
- Rationale: Preserve the documented explicit sample test behavior and failure boundary.
- Source: README.md §Add to Discord: “checks preview delivery, not replacement or playback”; src/services/SetupPreviewTest.ts; src/commands/setupPanel.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/SetupPreviewTest.ts`, `src/commands/setupPanel.ts`)
- UI: Discord — Explicit sample test response and controls
- Acceptance:
  - Given opening/saving setup, when performed, then no sample is posted. Given a click and readiness still valid after acknowledgment, when testing, then one sample posts with requester-only Remove and bounded confirmation. Given no eligible sample or changed readiness, when clicked, then no sample posts and a reason appears. The result covers this one sample with no statistical baseline or playback claim. (derived, confirm)
- Traces: API-010, CMP-067, CMP-094, CMP-047

### CMD-FR-007 — Settings access and persistence
The system shall provide private /settings to guild members with Manage Server without changing enablement or channel scope.

- Priority: Must
- Rationale: Preserve the documented settings access and persistence behavior and failure boundary.
- Source: README.md §Server preferences: “run /settings without options to see the effective configuration”; src/commands/settings.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/commands/settings.ts`)
- UI: Discord — Settings access and persistence response and controls
- Acceptance:
  - Given no options, when invoked, then effective choices and operator-disabled reasons appear. Given options, when saved, then only supplied preferences change. Given failed persistence, when saving, then previous choices remain with retry/operator guidance. (derived, confirm)
- Traces: ENT-001, API-003, CMP-092, CMP-065

### CMD-FR-008 — Posting mode option
The system shall offer mode:replace and mode:reply with Replace as the effective unset default.

- Priority: Must
- Rationale: Preserve the documented posting mode option behavior and failure boundary.
- Source: README.md §Server preferences; src/commands/settings.ts effectivePreferences
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/commands/settings.ts`)
- UI: Discord — Posting mode option response and controls
- Acceptance:
  - Given absent stored mode, when resolving, then Replace applies. Given reply/replace, when saved, then future behavior follows the selected mode; see docs/srs/core.md. (derived, confirm)
- Traces: ENT-001, API-003, CMP-092

### CMD-FR-009 — Platform switches
The system shall offer independent Boolean settings for instagram, tiktok, x, youtube, bluesky, reddit, twitch, facebook, articles and erome subject to operator admission.

- Priority: Must
- Rationale: Preserve the documented platform switches behavior and failure boundary.
- Source: README.md §Server preferences: “A server cannot enable an operator-disabled feature”; src/commands/settings.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/commands/settings.ts`)
- UI: Discord — Platform switches response and controls
- Acceptance:
  - Given platform:false, when saved, then automatic support is disabled. Given an operator-disabled feature, when requested true, then effective support remains unavailable. Article/PDF/MyAnimeList behavior is in docs/srs/articles.md, social behavior in docs/srs/social.md and Erome in docs/srs/erome.md. (derived, confirm)
- Traces: ENT-001, API-003, CMP-092, CMP-024

### CMD-FR-010 — Tweet translation setting
The system shall offer translate_tweets with effective translation requiring operator translation and enabled X support.

- Priority: Must
- Rationale: Preserve the documented tweet translation setting behavior and failure boundary.
- Source: README.md §Server preferences; src/commands/settings.ts effectivePreferences
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/commands/settings.ts`)
- UI: Discord — Tweet translation setting response and controls
- Acceptance:
  - Given a missing prerequisite, when displaying settings, then translation is off with the applicable reason. Given all enabled, when displayed, then translation is available; its rendering is in docs/srs/social.md. (derived, confirm)
- Traces: ENT-001, API-003, CMP-092

### CMD-FR-011 — YouTube display setting
The system shall offer youtube_display:preview, counts or counts-and-comment with counts-and-comment as the unset legacy default.

- Priority: Must
- Rationale: Preserve the documented youtube display setting behavior and failure boundary.
- Source: README.md §Server preferences; src/commands/settings.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/commands/settings.ts`)
- UI: Discord — YouTube display setting response and controls
- Acceptance:
  - Given preview, when saved, then the setting indicates native preview only without API calls; counts excludes comment requests. Given no API key, when settings display, then counts/comments unavailability and community no-key support are explained; runtime behavior is in docs/srs/social.md. (derived, confirm)
- Traces: ENT-001, API-003, CMP-092

### CMD-FR-012 — Replies setting
The system shall offer an off-by-default replies Boolean for eligible X, Bluesky, YouTube and LinkedIn reply/comment controls.

- Priority: Should
- Rationale: Preserve the documented replies setting behavior and failure boundary.
- Source: README.md §Server preferences; src/commands/settings.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/commands/settings.ts`)
- UI: Discord — Replies setting response and controls
- Acceptance:
  - Given no saved replies:true, when resolving, then replies are off. Given true, when saved, then eligible controls may be offered under docs/srs/replies.md. (derived, confirm)
- Traces: ENT-001, API-003, CMP-092

### CMD-FR-013 — Erome channel setting
The system shall offer erome_channels:age-restricted or all only when self-host Erome is available.

- Priority: Should
- Rationale: Preserve the documented erome channel setting behavior and failure boundary.
- Source: README.md §Supported links Erome paragraphs; src/commands/settings.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/commands/settings.ts`)
- UI: Discord — Erome channel setting response and controls
- Acceptance:
  - Given unset policy, when resolving, then age-restricted applies. Given all, when saved, then channel policy changes without enabling the server, changing automatic channel scope or enabling operator-disabled Erome; see docs/srs/erome.md. (derived, confirm)
- Traces: ENT-001, API-003, CMP-092, CMP-024

### CMD-FR-014 — Personal autofix preference
The system shall privately view or change the invoking member server-specific automatic-fix choice with /autofix enabled.

- Priority: Must
- Rationale: Preserve the documented personal autofix preference behavior and failure boundary.
- Source: README.md §Server preferences: “preference survives restarts”; src/commands/autofix.ts; src/services/PersonalPreferences.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/commands/autofix.ts`, `src/services/PersonalPreferences.ts`)
- UI: Discord — Personal autofix preference response and controls
- Acceptance:
  - Given false, when saved, then future automatic processing skips this member across the server and its threads. Given true, when saved, then the opt-out binding is deleted and allowed future processing resumes without scanning old messages. Given no option, when invoked, then the current choice is shown; manual fixes, existing previews and explicit Retry remain available. (derived, confirm)
- Traces: ENT-002, API-004, CMP-085, CMP-045

### CMD-FR-015 — Personal preference lifecycle
The system shall remove server opt-outs on bot departure and prune records for unjoined servers at startup.

- Priority: Must
- Rationale: Preserve the documented personal preference lifecycle behavior and failure boundary.
- Source: src/commands/autofix.ts privacy disclosure; src/bot.ts; src/services/PersonalPreferences.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/commands/autofix.ts`, `src/bot.ts`, `src/services/PersonalPreferences.ts`)
- UI: Discord — Personal preference lifecycle response and controls
- Acceptance:
  - Given departure during command acknowledgment, when saving, then the command refuses to recreate that server preference. Given departed-server records, when startup prunes, then they disappear. (derived, confirm)
- Traces: ENT-002, EVT-006, EVT-007, CMP-002, CMP-045

### CMD-FR-016 — Manual preview entry points
The system shall provide /fix link and Apps → Fix with Linky for explicit previews without enabling automatic processing or deleting the source.

- Priority: Must
- Rationale: Preserve the documented manual preview entry points behavior and failure boundary.
- Source: README.md §Add to Discord: “Personal installation does not watch your DMs”; src/commands/fix.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/commands/fix.ts`)
- UI: Discord — Manual preview entry points response and controls
- Acceptance:
  - Given /fix, when invoked, then only supplied URL tokens are considered with input at most 1,500 characters. Given the message action, when invoked, then only the selected message supplies source tokens. Given personal installation in a server or DM, when used, then it does not watch DMs or enable automatic server processing. (derived, confirm)
- Traces: API-006, API-007, CMP-087

### CMD-FR-017 — Manual request limits
The system shall handle at most three distinct ordinary supported links or a separate set of up to five community posts within ten cards per manual request.

- Priority: Must
- Rationale: Preserve the documented manual request limits behavior and failure boundary.
- Source: README.md §Add to Discord: “up to three supported links, or five YouTube community posts”; src/commands/fix.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/commands/fix.ts`)
- UI: Discord — Manual request limits response and controls
- Acceptance:
  - Given ordinary supported tokens, when selected, then at most the first three distinct eligible links are handled. Given more than three article candidates or five community posts, when requested, then private limit guidance leaves the source. Given mixed community/native requests, when requested, then private separate-message guidance appears without futile lookup/Retry; see docs/srs/social.md and docs/srs/articles.md. (derived, confirm)
- Traces: API-006, API-007, CMP-087, CMP-080, CMP-006

### CMD-FR-018 — Manual privacy
The system shall use an ephemeral manual response when a guild requester lacks the current channel/thread send permission.

- Priority: Must
- Rationale: Preserve the documented manual privacy behavior and failure boundary.
- Source: src/commands/fix.ts privateResponse; docs/media-blocks.md private manual responses
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/commands/fix.ts`)
- UI: Discord — Manual privacy response and controls
- Acceptance:
  - Given permission, when accepted, then a manual request can publish publicly. Given missing send permission, when accepted, then it publishes privately; rejection guidance is private. Given Remove, when clicked, then only the requester is authorized; see docs/srs/core.md. (derived, confirm)
- Traces: API-006, API-007, API-012, CMP-087

### CMD-FR-019 — Manual video statistics boundary
The system shall retain native YouTube video previews without Data API statistics for manual requests.

- Priority: Must
- Rationale: Preserve the documented manual video statistics boundary behavior and failure boundary.
- Source: README.md §Add to Discord: “YouTube videos use native previews without API statistics”; src/commands/fix.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/commands/fix.ts`)
- UI: Discord — Manual video statistics boundary response and controls
- Acceptance:
  - Given a manual video request, when published, then the native link is retained without video-statistics lookup; community/presentation behavior is in docs/srs/social.md. (derived, confirm)
- Traces: API-006, API-007, CMP-087, CMP-078

### CMD-FR-020 — Private diagnosis
The system shall provide Manage Server members a private /diagnose check of current scope, permissions, local URL recognition and recent observations without posting or fetching the supplied link.

- Priority: Must
- Rationale: Preserve the documented private diagnosis behavior and failure boundary.
- Source: README.md §Add to Discord; src/commands/diagnose.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/commands/diagnose.ts`)
- UI: Discord — Private diagnosis response and controls
- Acceptance:
  - Given an optional URL, when checking, then it is labelled as recognized format or metadata candidate rather than a confirmed preview. Given missing permissions/disabled scope, when diagnosing, then reasons and next actions appear. Given unavailable or failed observations, when diagnosing, then no-live-test/unavailable is stated; historical-observation parameters remain TBD-CMD-002. (derived, confirm)
- Traces: ENT-001, API-005, CMP-086, CMP-064

### CMD-FR-021 — Contextual private help
The system shall provide private /help guidance reflecting current scope, effective platforms and available setup/manual/control workflows.

- Priority: Must
- Rationale: Preserve the documented contextual private help behavior and failure boundary.
- Source: src/commands/help.ts; README.md §Server preferences
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/commands/help.ts`)
- UI: Discord — Contextual private help response and controls
- Acceptance:
  - Given guild, bot-DM or private-channel context, when /help runs, then guidance reflects effective availability without modifying choices or posting samples and explains preview limitations. (derived, confirm)
- Traces: API-001, CMP-089, CMP-092, CMP-064

### CMD-FR-022 — Optional coding admission
The system shall accept /prompt request only from Administrators in operator-approved guilds when the optional service is available.

- Priority: Should
- Rationale: Preserve the documented optional coding admission behavior and failure boundary.
- Source: docs/discord-prompt.md introduction and §Limits and failure handling; src/commands/prompt.ts; src/services/PromptService.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/commands/prompt.ts`, `src/services/PromptService.ts`)
- UI: Discord — Optional coding admission response and controls
- Acceptance:
  - Given missing authority, unapproved guild or unavailable service, when invoked, then a private denial appears. Given trimmed input outside 10–3,000 characters or forbidden controls, when submitted, then it is rejected. Given admission, when accepted, then limits are one active global job, three per UTC day and a 30-minute requester cooldown and the private reply warns of public GitHub work affecting the shared bot. (derived, confirm)
- Traces: ENT-014, API-008, CMP-090, CMP-048

### CMD-FR-023 — Coding status
The system shall return latest guild coding status for /prompt without input and reauthorize Check status in the same guild.

- Priority: Should
- Rationale: Preserve the documented coding status behavior and failure boundary.
- Source: docs/discord-prompt.md §Limits and failure handling; src/commands/prompt.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/commands/prompt.ts`)
- UI: Discord — Coding status response and controls
- Acceptance:
  - Given a valid job, when rendered, then request identity and queued/running/succeeded/failed/uncertain state describe that one job with only this repository run/PR links. Given invalid/unknown/uncertain status, when queried, then private guidance directs checking before resubmitting. This is stored job state, with no statistical baseline, minimum sample, noise floor or sustained-health verdict. (derived, confirm)
- Traces: ENT-014, API-008, API-020, CMP-090, CMP-048

### CMD-FR-024 — Manual stage extraction
The system shall organize manual execution into named resolve, prepare, publish and verify stages without changing observable behavior.

- Priority: Could
- Rationale: Preserve the documented manual stage extraction behavior and failure boundary.
- Source: features.md FEAT-1791986813: “Finish splitting the /fix command’s execute into named stages”
- Verification: Inspection
- Status: Proposed
- Delivery: Not started
- UI: none (refactor)
- Acceptance:
  - Given extracted stages, when unchanged manual suites execute, then results remain equivalent and mutation-checked wiring demonstrates composition. (derived, confirm)
- Traces: CMP-087, CMP-088
- Tickets: FEAT-1791986813

## 3.2 Performance requirements

All product-wide performance requirements are homed in docs/srs/core.md.

## 3.3 Usability requirements

Discord supplies native controls and accessibility. Functional requirements specify labels, private/error states and actions; no product-specific WCAG certification is evidenced.

## 3.4 Interface requirements

### CMD-IR-001 — Global command registration
The system shall replace global Discord commands with help, setup, settings, diagnose, fix, prompt, autofix and Fix with Linky.

- Priority: Should
- Rationale: Preserve the documented global command registration behavior and failure boundary.
- Source: src/commands/register.ts; src/bot.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/commands/register.ts`, `src/bot.ts`)
- Acceptance:
  - Given registration, when Discord application identity is read, then the full list is PUT to its global route with declared installation contexts and default permissions. (derived, confirm)
- Traces: API-030, API-035, CMP-091, CMP-002

### CMD-IR-002 — Invite permission guidance
The system shall provide guild invitation guidance requesting View Channel, Read Message History, Send Messages, Send Messages in Threads, Embed Links, Attach Files and Manage Messages.

- Priority: Must
- Rationale: Preserve the documented invite permission guidance behavior and failure boundary.
- Source: README.md §Add to Discord permission list; src/services/RepostDelivery.ts requiredRepostPermissions
- Verification: Inspection
- Status: Approved
- Delivery: Implemented (source: `src/services/RepostDelivery.ts`)
- Acceptance:
  - Given installation, when following guidance, then Replace permissions and private-thread access requirements are explicit; Reply does not require source deletion or attachment copying permissions. (derived, confirm)
- Traces: API-035, CMP-060, CMP-093

## 3.5 Logical database requirements

Data Contracts owns ENT-001 server preferences, ENT-002 personal opt-outs and ENT-014 prompt jobs. Core owns shared privacy/retention constraints; operator prompt retention is in docs/srs/ops.md.

## 3.6 Design constraints

All commands obey CORE-CON-001 through CORE-CON-005; product-wide constraints have one home in docs/srs/core.md.

## 3.7 Software system attributes

Reliability, privacy and security attributes are homed in docs/srs/core.md; commands introduce no separate product-wide NFR.

## 3.8 Supporting information

Preview execution and control behavior are in docs/srs/core.md, docs/srs/social.md, docs/srs/articles.md, docs/srs/replies.md and docs/srs/erome.md. The coding workflow operator side is in docs/srs/ops.md. All command output follows CORE-CON-005 and shared CORE-NFR privacy/security requirements.

## 5.1 Traceability matrix

| Req | Priority | Delivery | Entities | APIs / Events | Components | Verification |
|---|---|---|---|---|---|---|
| `CMD-FR-001` | Must | Implemented | ENT-001 | API-002, API-009, API-010 | CMP-093, CMP-094 | Inspection |
| `CMD-FR-002` | Must | Implemented | ENT-001 | API-002, API-010 | CMP-093, CMP-065, CMP-002 | Inspection |
| `CMD-FR-003` | Must | Implemented | ENT-001 | API-009 | CMP-094, CMP-065 | Inspection |
| `CMD-FR-004` | Must | Implemented | ENT-001 | API-009, API-010 | CMP-094, CMP-064 | Inspection |
| `CMD-FR-005` | Must | Implemented | ENT-001 | API-002 | CMP-094, CMP-064 | Inspection |
| `CMD-FR-006` | Must | Implemented | — | API-010 | CMP-067, CMP-094, CMP-047 | Inspection |
| `CMD-FR-007` | Must | Implemented | ENT-001 | API-003 | CMP-092, CMP-065 | Inspection |
| `CMD-FR-008` | Must | Implemented | ENT-001 | API-003 | CMP-092 | Inspection |
| `CMD-FR-009` | Must | Implemented | ENT-001 | API-003 | CMP-092, CMP-024 | Inspection |
| `CMD-FR-010` | Must | Implemented | ENT-001 | API-003 | CMP-092 | Inspection |
| `CMD-FR-011` | Must | Implemented | ENT-001 | API-003 | CMP-092 | Inspection |
| `CMD-FR-012` | Should | Implemented | ENT-001 | API-003 | CMP-092 | Inspection |
| `CMD-FR-013` | Should | Implemented | ENT-001 | API-003 | CMP-092, CMP-024 | Inspection |
| `CMD-FR-014` | Must | Implemented | ENT-002 | API-004 | CMP-085, CMP-045 | Inspection |
| `CMD-FR-015` | Must | Implemented | ENT-002 | EVT-006, EVT-007 | CMP-002, CMP-045 | Inspection |
| `CMD-FR-016` | Must | Implemented | — | API-006, API-007 | CMP-087 | Inspection |
| `CMD-FR-017` | Must | Implemented | — | API-006, API-007 | CMP-087, CMP-080, CMP-006 | Inspection |
| `CMD-FR-018` | Must | Implemented | — | API-006, API-007, API-012 | CMP-087 | Inspection |
| `CMD-FR-019` | Must | Implemented | — | API-006, API-007 | CMP-087, CMP-078 | Inspection |
| `CMD-FR-020` | Must | Implemented | ENT-001 | API-005 | CMP-086, CMP-064 | Inspection |
| `CMD-FR-021` | Must | Implemented | — | API-001 | CMP-089, CMP-092, CMP-064 | Inspection |
| `CMD-FR-022` | Should | Implemented | ENT-014 | API-008 | CMP-090, CMP-048 | Inspection |
| `CMD-FR-023` | Should | Implemented | ENT-014 | API-008, API-020 | CMP-090, CMP-048 | Inspection |
| `CMD-FR-024` | Could | Not started | — | — | CMP-087, CMP-088 | Inspection |
| `CMD-IR-001` | Should | Implemented | — | API-030, API-035 | CMP-091, CMP-002 | Inspection |
| `CMD-IR-002` | Must | Implemented | — | API-035 | CMP-060, CMP-093 | Inspection |

## Revision history

| Rev | Date | Commit | Mode | Summary |
|---|---|---|---|---|
| 1 | 2026-11-26T15:33:20-05:00 | f57d7502cac5 | ADOPT | Initial CMD-FR-001–024, CMD-IR-001–002 |
