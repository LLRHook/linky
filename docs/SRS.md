# Software Requirements Specification — Linky

Conforms to the ISO/IEC/IEEE 29148:2018 §9.6 content outline using the large-product index layout. Related: [Data Contracts](DATA_CONTRACTS.md) · [Architecture](ARCHITECTURE.md).

Status: Draft — foundation ADOPT pass, code baseline `1a69229`, 2026-11-26. Area files are assigned for subsequent passes and may not yet exist; their requirements are not claimed baselined/verified by this index.

## 1. Introduction
### 1.1 Purpose
Specify shipped Linky behavior and distinguish future work for the product owner, implementers, operators and verifiers. This index owns context, area ownership and verification navigation. Area files own normative FR/IR/CON/NFR definitions and matrices. Data Contracts owns shapes; Architecture owns components/decisions. Existing prose remains cited evidence and is not silently rewritten.

### 1.2 Scope
Linky repairs or authors supported public social-post, article, PDF and MyAnimeList previews in Discord: automatically in enabled server channels or on explicit personal/manual requests. It preserves attribution, member control and originals when delivery cannot be confirmed. Optional public replies/comments, YouTube extras, self-host Erome and operator diagnostics extend the workflow. Hosted Erome is excluded. Linky does not summarize/fact-check articles, sign into private accounts, bypass paywalls, guarantee upstream availability or certify playback from metadata alone. The separate linky-web website is outside this implementation. No production latency/availability/conversion SLO is inferred from historical selected trials.

### 1.3 Product perspective
Standalone Discord gateway bot with slash/context/component interactions, optional in-process media HTTP and separate regional/relay workers. [Architecture §3](ARCHITECTURE.md#3-system-context-c4-level-1) owns context and §6 deployment.

#### 1.3.1 System interfaces
Discord Gateway/REST supplies messages, interactions, identity and current permissions. Public provider APIs/pages supply metadata/media. Optional YouTube API, GitHub coding workflow, Vercel regional functions and Cloudflare relay have narrow authenticated boundaries in Data Contracts §7.

#### 1.3.2 User interfaces
Discord automatic preview/retry/details/remove; private setup/platform/channel menus; settings/help/diagnose;/autofix;/fix and Apps → Fix with Linky; public reply/comment threads; optional coding status and album loading. Discord owns native desktop/mobile accessibility. No product-specific WCAG certification target is evidenced; area requirements should name observable labels/states without inventing conformance claims.

#### 1.3.3 Hardware interfaces
No direct hardware interfaces. Native media processing uses host CPU, disk and memory within container/process controls.

#### 1.3.4 Software interfaces
Exposed operations: API-001 through API-034 in Data Contracts §4. Consumed integrations: API-035 through API-060 in §7. Gateway/lifecycle events: EVT-001 through EVT-008. Durable state: ENT-001 through ENT-014. Architecture §4 maps source owners to CMP ids.

#### 1.3.5 Communications interfaces
TLS Discord gateway/REST and HTTPS public retrieval; optional signed regional protocol and relay authentication. Media HTTP sits behind operator HTTPS routing. No arbitrary proxy endpoint is exposed. General articles validate and pin public destinations rather than using a fixed publisher allowlist; TBD-S0-001 resolves blanket constraint wording.

#### 1.3.6 Memory constraints
Preparation profiles reserve 24 MiB originals or128 MiB attachments against a shared 192 MiB scheduling budget; Compose temporary storage is 256 MiB. These are not process RSS guarantees. Individual JSON/media/cache caps live in Data Contracts; some stores have record bounds without byte caps. PERFORMANCE_AUDIT establishes no approved absolute CPU/RSS budget.

#### 1.3.7 Operations
One production container on the Hostinger VPS, deployed by GitHub Actions after successful main CI for the tested revision. One writer owns the JSON data volume. Shutdown drains work/checkpoints/flushes; catch-up defaults off. Operators manage secrets, updates, reports, backups and restore. No support hours or RPO/RTO is evidenced (TBD-S0-002).

#### 1.3.8 Site adaptation requirements
An admin explicitly enables a new server, chooses channel/platform scope and checks channel/thread permissions. Saved choices survive restart and do not implicitly enable inactive servers. Self-hosting adds operator feature allowlists, intended optional API credentials and media/regional/relay infrastructure. Public docs contain no real resource identities/environment values.

### 1.4 Product functions
- [Core](srs/core.md) (CORE): eligibility, confirmation/recovery, Replace/Reply/source preservation, ownership, scope/preferences, opt-out, and all product-wide constraints/NFRs.
- [Social](srs/social.md) (SOC): catalog rewrites, mobile shares, X translation/panels, Instagram/Bluesky panels, YouTube video/community display/controls, and Truth Social and LinkedIn posts.
- [Articles](srs/articles.md) (ART): public article/PDF/MyAnimeList cards, Telegraph fallback. Truth Social and LinkedIn posts belong to Social.
- [Replies](srs/replies.md) (RPL): opt-in public replies/comments, thread refresh, moderation memory and durable cleanup.
- [Commands](srs/commands.md) (CMD): slash commands, message action, private admin/member guidance and optional coding requests.
- [Erome](srs/erome.md) (ERO): self-host admission, album selection, preparation, scheduling, originals, attachments and incremental galleries.
- [Operations](srs/ops.md) (OPS): diagnostics/archive reports, provider evidence, checkpoint recovery, lifecycle, deployment and operational verification.

### 1.5 User characteristics
| User class | Description | Technical expertise | Permissions |
|---|---|---|---|
| Server admins | Activate/configure server | Discord server/channel permissions | Owner, Administrator or Manage Server as command requires; cannot override operator-disabled features |
| Members | Share links/use public controls | Ordinary Discord use | Current view/send/no-timeout checks for Retry/album; own automatic opt-out |
| Original sharers | Own automatic preview removal | Ordinary Discord use | Owner-only Remove; admin status does not transfer button ownership |
| Personal-install users | Explicit manual previews in supported servers/DMs | Commands/context menu | Requester controls own preview; no passive DM watch or server enablement |
| Self-hosting operators | Run own bot/infrastructure | Node/Docker, secrets, HTTPS, workers | Host/configuration/state access; optional Erome |
| Hosted-bot operator | Maintain public service/evidence | Actions, Docker, Discord operations | Production updates, scoped credentials, private diagnostics/archive |

### 1.6 Limitations
Provider refusals, schemas, quotas and Discord rendering can fail independently of URL recognition. Confirmation proves useful matching metadata, not end-user playback. Guild/category/thread permissions may block delivery. State is local/single-writer. Erome excludes DMs and follows saved age-channel policy. Sessions/records expire; restart can invalidate memory-only controls. Optional relay transport lacks an explicit upstream timer/stream cap (TBD-S0-003). No legal certification or safety-critical use is claimed.

### 1.7 Assumptions and dependencies
Discord semantics remain compatible with discord.js 14. Operators keep credentials at intended boundaries, private writable state and one volume owner. Public metadata/media remains compatible with bounded parsers. GitHub Actions, host deploy routing and optional workers remain available. Historical selected checks prove their cases/dates only. Code wins over conflicting prose in this adoption; unrelated stale claims become documentation bugs while existing sources remain unchanged.

### 1.8 Apportioning of requirements
Approved priorities: shipped/on by default=Must; off by default, self-host-only or operator-only=Should; open features take ticket priority, otherwise Could. Priority expresses adopted scope, not deployment proof. Delivery comes from actual code/ticket/execution evidence. [Product roadmap](product-roadmap.md) separates shipped foundation from proposals; features.md is active backlog and CHANGELOG is shipped ledger.

| Phase | Scope (FR/NFR ids) | Exit criteria |
|---|---|---|
| Pilot | No separate new pilot allocated by adoption | Future pilot names area ids/acceptance explicitly |
| Production | Shipped behavior across CORE/SOC/ART/RPL/CMD/ERO/OPS; hosted excludes Erome; optional paths retain gates | Area passes enumerate ids/acceptance/delivery; verification/release gates establish verified claims |
| Later | Roadmap/open features, including target language and reliability/latency evidence gaps | Approved scoped requirements/tickets, implemented and verified acceptance; no invented date |

## 2. References
Baseline code:`1a69229`. Existing documents retain their dates and historical limits. Using the 29148 outline is not an external standards certification.

| Reference | Role / evidence status |
|---|---|
| [Data Contracts](DATA_CONTRACTS.md) | Adopted interface/state inventory |
| [Architecture](ARCHITECTURE.md) | Adopted components, flows, deployment/decisions |
| [package.json](../package.json),[Dockerfile](../Dockerfile),[Compose](../docker-compose.yml),[workflows](../.github/workflows) | Current build/runtime/deploy source at baseline |
| [features.md](../features.md),[bugs.md](../bugs.md),[CHANGELOG.md](../CHANGELOG.md) | Active proposals/defects and shipped ledger |
| [README.md](../README.md) | Current source guidance; dated examples keep their original scope |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Current source guidance; dated examples keep their original scope |
| [VERIFICATION.md](../VERIFICATION.md) | Current source guidance; dated examples keep their original scope |
| [SECURITY_AUDIT.md](../SECURITY_AUDIT.md) | Historical dated research/audit/validation evidence; not a fresh guarantee |
| [PERFORMANCE_AUDIT.md](../PERFORMANCE_AUDIT.md) | Historical dated research/audit/validation evidence; not a fresh guarantee |
| [docs/article-previews.md](article-previews.md) | Current source guidance; dated examples keep their original scope |
| [docs/delivery-reliability.md](delivery-reliability.md) | Current source guidance; dated examples keep their original scope |
| [docs/discord-prompt.md](discord-prompt.md) | Current source guidance; dated examples keep their original scope |
| [docs/erome-fast-embed-research.md](erome-fast-embed-research.md) | Historical dated research/audit/validation evidence; not a fresh guarantee |
| [docs/erome-previews.md](erome-previews.md) | Current source guidance; dated examples keep their original scope |
| [docs/erome-regional-hosting.md](erome-regional-hosting.md) | Current source guidance; dated examples keep their original scope |
| [docs/growth-research-2026-09-17.md](growth-research-2026-09-17.md) | Historical dated research/audit/validation evidence; not a fresh guarantee |
| [docs/instagram-media.md](instagram-media.md) | Current source guidance; dated examples keep their original scope |
| [docs/media-blocks.md](media-blocks.md) | Historical dated research/audit/validation evidence; not a fresh guarantee |
| [docs/operator-reliability.md](operator-reliability.md) | Current source guidance; dated examples keep their original scope |
| [docs/optimization-directions-2026-09-15.md](optimization-directions-2026-09-15.md) | Historical dated research/audit/validation evidence; not a fresh guarantee |
| [docs/product-roadmap.md](product-roadmap.md) | Current source guidance; dated examples keep their original scope |
| [docs/provider-checks.md](provider-checks.md) | Current source guidance; dated examples keep their original scope |
| [docs/runtime-security-2026-09-15.md](runtime-security-2026-09-15.md) | Historical dated research/audit/validation evidence; not a fresh guarantee |
| [docs/self-hosting.md](self-hosting.md) | Current source guidance; dated examples keep their original scope |
| [docs/tiktok-test-analysis-2026-10-12.md](tiktok-test-analysis-2026-10-12.md) | Historical dated research/audit/validation evidence; not a fresh guarantee |
| [docs/truth-social-relay.md](truth-social-relay.md) | Current source guidance; dated examples keep their original scope |
| [docs/verification-history.md](verification-history.md) | Historical dated research/audit/validation evidence; not a fresh guarantee |
| [docs/youtube-embedding-research.md](youtube-embedding-research.md) | Historical dated research/audit/validation evidence; not a fresh guarantee |
| [docs/youtube-single-message-layout.md](youtube-single-message-layout.md) | Current source guidance; dated examples keep their original scope |

No repository AGENTS.md or CLAUDE.md exists at this baseline. Personal/local instructions are not copied into public product requirements.

## 3. Requirements
| Component | File | Prefix | Owner | Requirements (ADOPT rev 1) |
|---|---|---|---|---|
| Core | [core](srs/core.md) | CORE | Victor | 43 |
| Social | [social](srs/social.md) | SOC | Victor | 52 |
| Articles | [articles](srs/articles.md) | ART | Victor | 20 |
| Replies | [replies](srs/replies.md) | RPL | Victor | 28 |
| Commands | [commands](srs/commands.md) | CMD | Victor | 26 |
| Erome | [erome](srs/erome.md) | ERO | Victor | 30 |
| Operations | [ops](srs/ops.md) | OPS | Victor | 35 |

Product-wide CON/NFR definitions live only in core as CORE-CON-/CORE-NFR-. Other areas cite them. Area requirements cite companion ENT/API/EVT/CMP/ADR ids without duplicating shapes/decisions. This pass creates no area files.

## 4. Verification
Each area requirement names Test, Demonstration, Inspection or Analysis and observable acceptance. Source inspection establishes Implemented when behavior is present; Verified requires relevant execution/live evidence. Rendering/permissions need authorized live Discord checks because offline mocks do not prove playback or real gateway timing.

`npm test` builds strict TypeScript, checks the test project and runs TS/JS tests. `npm run check:workers` checks regional targets;`bash tests/deploy.test.sh` exercises safeguards. Current CI additionally covers Node 22/24/26,dependency/secrets/image gates, restricted container storage/archive and real network-disabled video conversion. Those workflow definitions were inspected, not executed by this documentation-only pass. No CI was triggered, rerun or cancelled.

[VERIFICATION.md](../VERIFICATION.md) owns end-to-end preflight/data, static/spec review, automated layers, authorized live Discord walkthrough, adversarial/performance checks, hard constraints and evidence reporting. Distinguish URL recognition, provider metadata, confirmed rendering and observed client playback. Reports disclose coverage/losses, finite denominators and dates. Historical selected audits/live examples do not replace the current release gate. Unapproved production SLOs remain TBD-S0-002.

## 5. Appendices
### 5.1 Traceability matrix
Matrices are owned by [core §5.1](srs/core.md#51-traceability-matrix),[social §5.1](srs/social.md#51-traceability-matrix),[articles §5.1](srs/articles.md#51-traceability-matrix),[replies §5.1](srs/replies.md#51-traceability-matrix),[commands §5.1](srs/commands.md#51-traceability-matrix),[erome §5.1](srs/erome.md#51-traceability-matrix) and [ops §5.1](srs/ops.md#51-traceability-matrix). Each maps priority/delivery, entities, APIs/events, components and verification. These are intentional pending pointers for subsequent adoption passes, not completed coverage claims.

### 5.2 Open issues (TBD)
Foundation questions (TBD-S0-) and the questions each area pass raised are listed here; area files carry `(derived, confirm)` markers on the criteria these TBDs cover.

| TBD | Question | Assumption used | Affects | Owner |
|---|---|---|---|---|
| TBD-S0-001 | How should blanket fixed-host/no-credentials/no-arbitrary-URL/no-anti-bot-bypass wording cover shipped general articles and authenticated integrations/Truth relay? | Describe validated public articles, no exposed arbitrary proxy/member credentials, intended operator authentication, no login/paywall bypass; do not silently forbid shipped paths. | Core CON/NFR; Data Contracts§7;Architecture§2 | Victor |
| TBD-S0-002 | What production SLOs, support hours, backup cadence, RPO/RTO are approved? | No target invented; local measurements/selected live checks remain dated evidence. | Core NFR, ops, architecture risks | Victor |
| TBD-S0-003 | Should optional Cloudflare relay add upstream timeout and streaming byte rejection to meet universal bounded-I/O wording? | Existing worker checks size only after arrayBuffer and has no explicit fetch timer; bot caller independently bounded; no code change here. | Relay API, core request bounds | Victor |
| TBD-S0-004 | What support/deprecation window applies to breaking contracts/durable state? | Preserve shipped legacy readers; explicit migration plan per breaking change; no invented global window. | Data Contracts§2/§9 | Victor |
| TBD-SOC-001 | Are the acceptance criteria marked `(derived, confirm)` approved? | Preserve inspected code semantics for admission, cache limits, interface rejection, cancellation and journal-save failure. | SOC-NFR-001–004; SOC-IR-001/003/004/006; SOC-CON-001 | Victor |
| TBD-SOC-002 | Which pilot locale, script variants, opt-in surface and quota disclosure are approved? | No locale selected; pilot remains Proposed and Not started. | SOC-FR-040 | Victor |
| TBD-CORE-001 | Confirm derived core acceptance scenarios and UI labels? | Scenarios carry `(derived, confirm)`; implementation is source-inspected, without a new live Verified claim. | CORE-FR-001–030, CORE-NFR-001–007, CORE-IR-001, CORE-CON-001–005 | Victor |
| TBD-CORE-002 | Approve rewrite latency budget, runner, repetitions, noise floor and insufficient-sample behavior? | FEAT-1790270881 proposes 1,000 messages, under 10 seconds and 2 ms/message p95; the threshold remains unapproved. | CORE-NFR-004 | Victor |
| TBD-CORE-003 | Which failed-share outcome and cache population define complete attempt coverage? | Share resolution currently precedes timing; retain current semantics until FEAT-1790785729 defines coverage and comparable denominators. | CORE-FR-028, CORE-NFR-003 | Victor |
| TBD-CMD-001 | Confirm derived command acceptance scenarios and UI placements/states? | Existing Discord surfaces are retained; scenarios carry `(derived, confirm)`. | CMD-FR-001–024, CMD-IR-001–002 | Victor |
| TBD-CMD-002 | Should diagnose display explicit observation age/sample scope, and what additional stale-evidence disclosure is required? | Current output describes the last attributed process-local check within 15 minutes, otherwise no recent observation; it makes no sustained-health or playback claim. | CMD-FR-020 | Victor |
| TBD-ART-001 | Are the shipped first-page title heuristic thresholds sufficient as the adopted output-claim evidence rule, or should a separately approved title-quality criterion be added? | Preserve the code's font-size baseline, 1.15 ratio and 0.25 grouping tolerance, with file-name abstention; make no population-level title-quality claim. | ART-FR-013 | Victor |
| TBD-RPL-001 | Confirm derived concurrency and rate-limit acceptance? | Adopt current guards: overlapping opens share a flight; new creation uses current cooldowns. | RPL-FR-004; RPL-NFR-001 | Victor |
| TBD-OPS-001 | Do universal streaming-byte bounds apply to the operator metadata CLI? | Describe the shipped fifteen-second per-hop timer, three HTTPS redirects and buffering before 512 KiB truncation; no code change. | OPS-FR-008; core outbound constraint scope | Victor |
| TBD-OPS-002 | What health freshness threshold, enter/exit behavior and noise policy should the proposed Gateway check use? | No threshold invented; existing deployment continues using startup logs. | OPS-FR-029; FEAT-1790270882 | Victor |
| TBD-OPS-003 | Which API id owns the proposed operator corpus embed-stage runner? | Marked missing in OPS-FR-028; API-028 remains metadata only. Allocate the id when FEAT-1790270880 is groomed. | OPS-FR-028; FEAT-1790270880 | Victor |
| TBD-OPS-004 | Which formatter and version should the proposed contributor check adopt? | No dependency selected or installed. | OPS-FR-030; FEAT-1790785730 | Victor |

### 5.3 Acronyms, abbreviations, and definitions
| Term | Definition |
|---|---|
| ADOPT | Normalize existing behavior/evidence into traceable specifications without silently redesigning |
| FR/NFR/IR/CON | Functional/non-functional/interface requirement/design constraint |
| ENT/API/EVT/CMP/ADR | Entity/operation/event/component/architecture decision ids |
| Replace | Confirm preview and fresh source conditions before deleting source |
| Reply | Preserve source; related preview reconciles edits/deletions while retained |
| Confirmation | Matching useful Discord metadata/proxy evidence, not demonstrated playback |
| Hosted/self-host | Public operator service/independently run instance and infrastructure |
| Personal install | Explicit user commands/context action, no passive DM watching |
| Snowflake | Decimal-string Discord resource id with embedded creation time |
| Components V2 | Discord attributed text/media message layout |
| HMAC/ETag | Keyed authentication/representation validator for exact media jobs |
| MiB | 1,048,576 bytes |
| SLO/RPO/RTO | Service-level/recovery-point/recovery-time objective |
| Must/Should/Could | Scope priority distinct from delivery/verification state |

## Revision history

| Rev | Date | Commit | Mode | Summary |
|---|---|---|---|---|
| 1 | 2026-11-26T15:19:42-05:00 | 041cc00854e8 | ADOPT | Initial index: seven area homes; foundation TBD-S0-001 through TBD-S0-004; no requirement definitions in this pass |
