# Operations requirements — Linky

Related: [SRS index](../SRS.md). ADOPT baseline `1a69229`, 2026-11-26.

Delivery records source inspection, not fresh execution of CI or production deployment. All shipped requirements are Approved and conservatively Implemented; open tickets are Proposed. Operator-only functions are Should; required shared CI/deploy gates are Must.

## 3. Requirements

### 3.1 Functions

#### OPS-FR-001 — Archive finalized attempts
The system shall archive allowlisted finalized delivery measurements separately from interactive Details history.

- Priority: Should
- Rationale: Archive finalized attempts makes operator behavior reviewable.
- Source: docs/operator-reliability.md / What is recorded; src/services/DeliveryArchive.ts archiveDelivery; src/bot.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- UI: none (infra)
- Acceptance:
  — Given a finalized attempt, when archived, then only random attempt identity, timestamp, finite platform/mode/outcome/path/cache and bounded elapsed/stage fields are copied; Discord identities, URLs, prose, credentials, arbitrary errors and media are excluded.
- Traces: ENT-010, ENT-011, CMP-014, CMP-002

#### OPS-FR-002 — Nonblocking archive lifecycle
The system shall queue archive records without awaiting disk writes on preview delivery.

- Priority: Should
- Rationale: Nonblocking archive lifecycle makes operator behavior reviewable.
- Source: docs/operator-reliability.md / What is recorded; src/services/DeliveryArchive.ts; src/bot.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- UI: none (infra)
- Acceptance:
  — Given restart, when finalized Details records are imported, then attempt IDs deduplicate and unfinished restored attempts become interrupted; expired or never-saved measurements are not reconstructed; later Details eviction does not prevent archiving finalization.
- Traces: ENT-009, ENT-010, CMP-014, CMP-018, CMP-002

#### OPS-FR-003 — Archive failure disclosure
The system shall continue preview delivery while exposing bounded archive loss and I/O warnings.

- Priority: Should
- Rationale: Archive failure disclosure makes operator behavior reviewable.
- Source: docs/operator-reliability.md / What is recorded; src/services/DeliveryArchive.ts
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- UI: none (infra)
- Acceptance:
  — Given overload or sustained storage failure, when queue or storage limits apply, then fixed warnings and health counters describe dropped records, failures and eviction; heartbeat days establish observation only and counters are cumulative.
- Traces: ENT-011, CMP-014

#### OPS-FR-004 — Daily operator report
The system shall produce read-only aggregates over the selected archive period without printing attempt IDs or Discord identities.

- Priority: Should
- Rationale: Daily operator report makes operator behavior reviewable.
- Source: docs/operator-reliability.md / Pull a daily report with trend context; ops/delivery-archive-report.mjs
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- UI: CLI — report:deliveries and JSON
- Acceptance:
  — Given --days 1 or --days 7 with optional --json, when run through report:deliveries after build or direct node in the runtime container, then selected finalized attempts are grouped by platform/path/outcome with elapsed samples, median and p95 milliseconds, cache observations and stage outcomes.
- Traces: ENT-010, ENT-011, API-026, CMP-095

#### OPS-FR-005 — Report interpretation
The system shall disclose the denominator and evidence limits of archive confirmation and latency aggregates.

- Priority: Should
- Rationale: Report interpretation makes operator behavior reviewable.
- Source: docs/operator-reliability.md / Interpret the results; ops/delivery-archive-report.mjs; ops/delivery-report.mjs
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- UI: CLI — aggregate report and notes
- Acceptance:
  — Given a report, when confirmation is computed, then confirmed is divided by all finalized recorded attempts in that window, including partial/disabled/cancelled/interrupted, with null rate for zero samples; ignored messages and uninstrumented paths are outside scope.
  — Given elapsed statistics, when computed, then pending/interrupted attempts are excluded, median and nearest-rank p95 use the stated sample count in milliseconds, and empty samples yield null/n/a; same-stage spans sum per completed attempt but overlapping stages do not add to total elapsed.
  — Given these descriptive samples, when presented, then playbackVerified is false and no comparative baseline, statistical noise floor, population census or sustained uptime/speed conclusion is asserted; comparative decisions require separately reviewed comparable coverage.
- Traces: API-026, API-027, CMP-095, CMP-096

#### OPS-FR-006 — Coverage and loss reporting
The system shall report archive coverage uncertainty alongside recorded delivery aggregates.

- Priority: Should
- Rationale: Coverage and loss reporting makes operator behavior reviewable.
- Source: ops/delivery-archive-report.mjs; docs/operator-reliability.md / Interpret the results
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- UI: CLI — coverage warnings
- Acceptance:
  — Given missing days, unknown health, read errors, invalid/conflicting duplicates, loss counters or a requested window exceeding retention, when reporting, then coverage warnings and counters accompany lower-bound totals; heartbeat older than five minutes is stale and never proves an outage; the rule has one last-health timestamp as its sample, no comparison baseline or hysteresis, and unknown health abstains through warnings.
- Traces: ENT-011, API-026, CMP-095

#### OPS-FR-007 — Controlled Details report
The system shall evaluate operator-requested evidence gates on selected local Details history.

- Priority: Should
- Rationale: Controlled Details report makes operator behavior reviewable.
- Source: ops/delivery-report.mjs; docs/operator-reliability.md / Pull a daily report with trend context
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- UI: CLI — delivery-report gate
- Acceptance:
  — Given filters --since, --platform, --path or --cache and explicit --min-completed, --require and --reject-outcome, when evaluated, then output shows selected/completed/pending/interrupted samples, requested minima and rejected observed counts; the rule compares exact record counts with the supplied minima and zero rejected outcomes, has no statistical baseline/noise filter, and returns no gate verdict when none was requested; malformed input fails with a finite error.
- Traces: ENT-009, API-027, CMP-096

#### OPS-FR-008 — Provider metadata control
The system shall check corpus or explicit operator HTTPS links against every catalog provider with the production preview matcher.

- Priority: Should
- Rationale: Provider metadata control makes operator behavior reviewable.
- Source: docs/provider-checks.md / Provider metadata control; ops/provider-metadata-check.mjs
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- UI: CLI — check:providers and --json
- Acceptance:
  — Given a built checkout, when check:providers runs, then mobile shares normalize first, Discord crawler user agent retrieves metadata and each source/provider result reports HTTP status, elapsed milliseconds, recognized identity, satisfied matcher, observed media and expectationMet; wrong media fails the entry even if metadata is otherwise useful.
  — Given a result, then its sample is that one source/provider fetch and its baseline is the corpus expected media kind or expected unavailable result; no uptime/playback population or statistical noise claim is made, and network failure reports status zero with timeout/fetch_failed while preserving expected-unavailable semantics.
- Traces: API-028, CMP-101, CMP-069

#### OPS-FR-009 — Local validation sequence
The system shall run all non-Docker CI validation commands and report every result even after failures.

- Priority: Should
- Rationale: Local validation sequence makes operator behavior reviewable.
- Source: README.md / Self-hosting and development; CONTRIBUTING.md; ops/validate.mjs
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- UI: CLI — validation summary
- Acceptance:
  — Given validate, when invoked, then build, check:workers, npm test, bash tests/deploy.test.sh and npm audit --audit-level=low each run in order; each PASS/FAIL refers to command exit zero/nonzero with elapsed seconds, final exit fails if any command fails, and secret-scan/container omissions are explicit.
- Traces: API-029, CMP-103

#### OPS-FR-010 — CI aggregate gate
The system shall pass CI gate only when every required independent CI job succeeds.

- Priority: Must
- Rationale: CI aggregate gate makes operator behavior reviewable.
- Source: .github/workflows/ci.yml; CONTRIBUTING.md
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- UI: CI — required CI gate
- Acceptance:
  — Given a main push or PR, when CI completes, then secret scan, dependency audit, Node 22/24/26 build-worker-tests-deploy checks and production container jobs must all report success; missing, failed, cancelled or skipped job results cannot produce a successful aggregate gate.
- Traces: API-029, CMP-103

#### OPS-FR-011 — Container and scanner checks
The system shall verify production image behavior and supply-chain checks through the CI container and scan jobs.

- Priority: Must
- Rationale: Container and scanner checks makes operator behavior reviewable.
- Source: .github/workflows/ci.yml; VERIFICATION.md Stage 2
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- UI: CI — build/scan job results
- Acceptance:
  — Given CI, when executed, then full-history pinned-checksum Gitleaks, low-level npm audit and Trivy fixable-vulnerability gating run; labelled/unlabelled builds, Compose revision interpolation, non-root writable data, private archive reporting and network-disabled real video conversion are checked in restricted containers; vulnerability reports retain fourteen days.
- Traces: API-029, CMP-103

#### OPS-FR-012 — Failed test diagnostics
The system shall retain failing TypeScript child diagnostics for inspection.

- Priority: Should
- Rationale: Failed test diagnostics makes operator behavior reviewable.
- Source: CONTRIBUTING.md; .github/workflows/ci.yml; package.json
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- UI: CI/CLI — TAP diagnostics
- Acceptance:
  — Given npm test reaches its TypeScript runner, when run, then .vv/npm-test.tap is overwritten while spec output remains visible; given CI test-step failure, then its TAP artifact is retained for three days; pre-run build/type errors can leave no artifact.
- Traces: API-029, CMP-103

#### OPS-FR-013 — PR evidence gate
The system shall require substantive PR description sections using the base branch checker.

- Priority: Must
- Rationale: PR evidence gate makes operator behavior reviewable.
- Source: CONTRIBUTING.md; .github/workflows/pr-evidence.yml; ops/pr-evidence-check.mjs
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- UI: CI — PR evidence
- Acceptance:
  — Given a normal PR event, when checked, then Tickets, Acceptance evidence, Mutation checks, Docs checked and Remaining gaps each require substantive content after HTML guidance removal; empty sections fail, while non-PR events and actual Dependabot Bot updates are skipped; the check tests presence, not truth of supplied evidence.
- Traces: API-034, CMP-098

#### OPS-FR-014 — Tested-main deployment admission
The system shall deploy only the current tested main revision after successful same-repository push CI.

- Priority: Must
- Rationale: Tested-main deployment admission makes operator behavior reviewable.
- Source: .github/workflows/deploy.yml; ops/deploy.sh; docs/self-hosting.md / Checks and deployment
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- UI: CI/CLI — Deploy host result
- Acceptance:
  — Given a successful main-push CI completion, when Deploy runs, then it passes that full SHA through pinned-host-key restricted SSH; host requires clean main, serializes deployment with a lock and skips superseded origin/main SHAs without replacing the bot; connection establishment retries do not replay an uncertain remote deployment.
- Traces: API-031, CMP-097, CMP-102

#### OPS-FR-015 — Build before replacement
The system shall build the tested revision before replacing the running bot.

- Priority: Must
- Rationale: Build before replacement makes operator behavior reviewable.
- Source: ops/deploy.sh; docs/self-hosting.md / Checks and deployment
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- UI: CLI — deploy output
- Acceptance:
  — Given an existing container and valid last-success marker, when deploying, then checkout fast-forwards to the exact revision and saves previous image plus Compose configuration from the last successful revision; a failed build leaves the existing container serving.
- Traces: API-031, CMP-097

#### OPS-FR-016 — Image provenance and confirmation
The system shall confirm successful deployment only after startup readiness and exact running-image revision match.

- Priority: Must
- Rationale: Image provenance and confirmation makes operator behavior reviewable.
- Source: ops/deploy.sh; Dockerfile; docker-compose.yml; docs/self-hosting.md / Checks and deployment
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- UI: CLI — revision and readiness evidence
- Acceptance:
  — Given the new container, when checked up to thirty times at two-second intervals, then it must run with zero restarts and startup logs Logged in as and Serving, and its actual image OCI revision must equal the tested SHA; only then is the success marker advanced and final LINKY_DEPLOYED_SHA printed.
  — Given operator attribution, when reading provenance, then the running image ID selects the label rather than assuming latest equals running; absent labels mean unknown, and the supplied label is provenance rather than a signature. Manual builds without the argument remain permitted.
- Traces: API-031, CMP-097

#### OPS-FR-017 — Deployment rollback
The system shall restore the last successful deployment after failed replacement validation.

- Priority: Must
- Rationale: Deployment rollback makes operator behavior reviewable.
- Source: ops/deploy.sh; docs/self-hosting.md / Checks and deployment
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- UI: CLI — rollback result
- Acceptance:
  — Given failed startup or missing/unreadable/mismatched label, when rollback executes, then prior image/configuration restart without advancing the success marker; operator environment and data volume remain; restored-image readiness is checked without imposing the new revision label; rollback failure is explicit.
- Traces: API-031, CMP-097

#### OPS-FR-018 — Core operator configuration
The system shall load required credentials, scope and feature ceilings from validated operator configuration.

- Priority: Should
- Rationale: Core operator configuration makes operator behavior reviewable.
- Source: src/config.ts; docs/self-hosting.md / Run your own bot
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- UI: none (deploy-config)
- Acceptance:
  — Given startup, when DISCORD_TOKEN is absent or configured ID/platform lists are malformed, then startup fails; LINK_SETTINGS_PATH defaults to data/servers.json; LINK_CHANNEL_IDS, LINK_SERVER_IDS and REWRITE_PLATFORMS establish ceilings, and saved server/channel choices cannot expand them.
  — Given optional configuration, when read, then TRANSLATE_TWEETS defaults false, YOUTUBE_API_KEY is optional, EROME_GUILD_IDS unset preserves self-host availability and none disables it, relay URL/token must be valid together, and disabled operator platforms cannot be re-enabled by server settings.
  - Given environment changes, when applied, then restart is required, while runtime setup/settings choices apply immediately; Message Content Intent and Guild/User installation setup follow docs/self-hosting.md and command permissions remain in docs/srs/commands.md.
- Traces: ENT-001, API-030, CMP-003, CMP-035

#### OPS-FR-019 — Catch-up operator opt-in
The system shall enable restart catch-up only when CATCH_UP_ENABLED is true.

- Priority: Should
- Rationale: Catch-up operator opt-in makes operator behavior reviewable.
- Source: src/config.ts; docs/self-hosting.md / Run your own bot
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- UI: none (deploy-config)
- Acceptance:
  — Given omitted or non-true CATCH_UP_ENABLED, when started, then catch-up defaults off; given true and retained service-checkpoint.json, then the core recovery path can operate within its scope; lifecycle drain, channel/message bounds and crash duplication behavior are owned by docs/srs/core.md.
- Traces: ENT-003, CMP-003, CMP-066

#### OPS-FR-020 — Optional media configuration
The system shall require worker and public media settings when EROME_MEDIA_ENABLED enables hosting.

- Priority: Should
- Rationale: Optional media configuration makes operator behavior reviewable.
- Source: src/config.ts; docs/self-hosting.md / Run your own bot
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- UI: none (deploy-config)
- Acceptance:
  — Given hosting enabled, when configured, then worker key, worker base URL and media base URL are required; directory defaults to media beside settings and port to 8092; HTTPS origin validation and gallery/channel/media behavior are owned by docs/srs/erome.md; disabling new requests preserves cleanup through retained state and media service.
- Traces: ENT-012, CMP-003, CMP-029

#### OPS-FR-021 — Optional prompt intake configuration
The system shall enable coding intake only with explicit operator enablement, dispatch credential and separate approved-server list.

- Priority: Should
- Rationale: Optional prompt intake configuration makes operator behavior reviewable.
- Source: src/config.ts; src/services/PromptService.ts; docs/discord-prompt.md / Operator setup
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- UI: none (deploy-config)
- Acceptance:
  — Given PROMPT_ENABLED false, absent dispatch token or unapproved guild, when intake is attempted, then no coding request is admitted; PROMPT_WORKER_ENABLED controls new worker execution independently; disabling intake does not cancel active runs or stop ordinary fixing. Command permissions and private UI belong to docs/srs/commands.md.
- Traces: ENT-014, API-032, CMP-003, CMP-048

#### OPS-FR-022 — Prompt admission and uncertain dispatch
The system shall reserve prompt jobs before dispatch without automatically resubmitting uncertain requests.

- Priority: Should
- Rationale: Prompt admission and uncertain dispatch makes operator behavior reviewable.
- Source: src/services/PromptService.ts; docs/discord-prompt.md / Limits and failure handling
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- UI: none (system-only)
- Acceptance:
  — Given a 10-to-3,000-character request, when admitted, then one global active job, three per UTC day and a thirty-minute user cooldown apply; repeated job identity returns its existing record; uncertain response is reconciled through status; corrupt journal disables coding only and operators inspect history before marking a record failed.
- Traces: ENT-014, API-032, API-056, CMP-048

#### OPS-FR-023 — Isolated coding workflow
The system shall run coding, independent review and publishing in separate trusted workflow stages.

- Priority: Should
- Rationale: Isolated coding workflow makes operator behavior reviewable.
- Source: .github/workflows/discord-prompt.yml; docs/discord-prompt.md / Where the work runs
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- UI: CI — optional coding jobs
- Acceptance:
  — Given enabled worker on main and first run attempt, when launched, then pinned Codex 0.154.0 with gpt-6-astra and ultra runs implementation in a fresh checkout and independent read-only review with no fallback; timeouts are thirty, twenty and forty-five minutes for implementation, review and publication; coding/review do not receive production or publishing credentials.
- Traces: API-032, API-056, CMP-100

#### OPS-FR-024 — Candidate boundaries
The system shall reject prompt candidates outside the trusted baseline path and size policy.

- Priority: Should
- Rationale: Candidate boundaries makes operator behavior reviewable.
- Source: ops/prompt-candidate.mjs; ops/prompt-workflow.mjs; docs/discord-prompt.md / Limits and failure handling
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- UI: none (system-only)
- Acceptance:
  — Given a candidate, when exported and independently checked for publication, then at most thirty files and 200,000 UTF-8 bytes are permitted; application changes, new tests and feature docs stay within allowed paths while existing tests, dependencies, startup/wiring, command registration, configuration/shared parsers, deployment, workflows and controller edits are rejected.
- Traces: API-033, CMP-099, CMP-100

#### OPS-FR-025 — Protected prompt publication
The system shall publish reviewed prompt candidates only while reviewed base and PR head remain unchanged through required checks and protected merge.

- Priority: Should
- Rationale: Protected prompt publication makes operator behavior reviewable.
- Source: ops/prompt-workflow.mjs; docs/discord-prompt.md / Limits and failure handling
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- UI: CI — coding publication result
- Acceptance:
  — Given independent approval bound to the candidate, when publishing, then CI gate and PR evidence must succeed for that exact head before normal protected squash merge; changed main/head, requested changes or failed checks stop automation; coding success additionally requires Deploy success for the merged revision.
- Traces: API-032, API-034, API-056, CMP-100, CMP-098

#### OPS-FR-026 — Prompt data separation
The system shall retain prompt job state without request text or credentials in the local journal.

- Priority: Should
- Rationale: Prompt data separation makes operator behavior reviewable.
- Source: src/services/PromptService.ts; docs/discord-prompt.md / Data retained
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- UI: none (background)
- Acceptance:
  — Given dispatch, when sent externally, then only request and job ID accompany the workflow without surrounding Discord text or user/server IDs; local journal holds identities/status/links, completed records expire after fourteen days on next write and active/uncertain records persist; candidate/review artifacts retain seven days and public PR/run retention remains GitHub-managed.
- Traces: ENT-014, API-056, CMP-048, CMP-100

#### OPS-FR-027 — Deterministic verification guards
The system shall gate tracked-secret-file and provider-host predicates in one CI verification-guard step.

- Priority: Could
- Rationale: Deterministic verification guards makes operator behavior reviewable.
- Source: features.md FEAT-1795540134 / Acceptance criteria
- Verification: Inspection
- Status: Proposed
- Delivery: Not started
- UI: CI — Verification guards
- Acceptance:
  — Given the proposed guard, when a tracked forbidden file or uncatalogued provider host is introduced, then it exits one with offending path and fails CI gate; clean HEAD exits zero and VERIFICATION markers match fidelity checks.
- Traces: API-029, CMP-103
- Tickets: FEAT-1795540134

#### OPS-FR-028 — Repeatable three-stage corpus evidence
The system shall extend the operator corpus evidence workflow with separate metadata, Discord embed and dated manual client playback stages.

- Priority: Must
- Rationale: Repeatable three-stage corpus evidence supports operator verification.
- Source: features.md FEAT-1790270880 / Acceptance criteria
- Verification: Inspection
- Status: Proposed
- Delivery: Not started
- UI: CLI — opt-in corpus embed runner
- Acceptance:
  - Given the proposed corpus, when checked, then GIF, unavailable, suppression and article cases are covered; the opt-in embed stage refuses absent explicit token/channel, records dated per-entry confirmed/unconfirmed with observed identity and cleans owned messages even on failure; desktop/iOS/Android playback remains a separate dated manual column rather than inferred metadata success.
- Traces: API-028, CMP-101 (missing: operator corpus embed-stage API)
- Tickets: FEAT-1790270880

#### OPS-FR-029 — Gateway readiness health check
The system shall expose container health from a local Gateway-readiness freshness signal.

- Priority: Could
- Rationale: Gateway readiness health check supports operator verification.
- Source: features.md FEAT-1790270882 / Acceptance criteria
- Verification: Inspection
- Status: Proposed
- Delivery: Not started
- UI: CLI — Docker health status
- Acceptance:
  - Given the proposed readiness writer, when startup and heartbeat acknowledgments are fresh, then Docker reports healthy; when stale beyond the chosen threshold, then unhealthy is reported and deploy prefers available health status while preserving the log fallback; threshold, sample freshness/noise floor and enter/exit hysteresis remain TBD-OPS-002 rather than invented.
- Traces: CMP-001, CMP-002, CMP-097
- Tickets: FEAT-1790270882

#### OPS-FR-030 — Contributor formatting gate
The system shall provide an idempotent contributor formatting check locally and in CI.

- Priority: Could
- Rationale: Contributor formatting gate supports operator verification.
- Source: features.md FEAT-1790785730 / Acceptance criteria
- Verification: Inspection
- Status: Proposed
- Delivery: Not started
- UI: CLI/CI — formatting check
- Acceptance:
  - Given documented formatter/check commands, when a deliberately malformed fixture is checked, then CI rejects drift; formatting twice is idempotent and initial mechanical adoption is separately reviewable; dependency selection remains unresolved.
- Traces: API-029, CMP-103
- Tickets: FEAT-1790785730

#### OPS-FR-031 — Operational error serialization
The system shall serialize operational errors through the bounded logger allowlist.

- Priority: Should
- Rationale: Operational error serialization supports operator verification.
- Source: src/logger.ts; docs/self-hosting.md / Operational logs; docs/operator-reliability.md / What is recorded
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- UI: none (infra)
- Acceptance:
  - Given an SDK error, when logged, then only recognized type, allowed system or numeric code, HTTP status and known method are copied; arbitrary message, stack, cause, URLs, request content and bytes are excluded. LOG_LEVEL defaults info, production emits JSON and development uses pretty output; preview-failure event errorName is separately limited to a letter-led ASCII alphanumeric class of at most 64 characters and is not added to delivery history.
- Traces: CMP-004, CMP-068

### 3.2 Performance requirements

#### OPS-NFR-001 — Archive retention and capacity
The system shall bound private archive retention and storage.

- Priority: Should
- Rationale: Archive retention and capacity makes operator behavior reviewable.
- Source: src/services/DeliveryArchive.ts; src/config.ts; docs/operator-reliability.md
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- Measure: Default thirty days, configurable integer 1-90; maximum 64 MiB including reserved health space; default queue 4,096 records / 4 MiB; at most 96 spans/record.
- Acceptance:
  — Given UTC day rotation, when retention/capacity requires pruning, then oldest days can expire before configured retention; invalid environment retention rejects startup; downtime or failed physical deletion can delay cleanup and backups need independent retention.
- Traces: ENT-010, ENT-011, CMP-014, CMP-003

#### OPS-NFR-002 — Archive shutdown and retries
The system shall bound archive flush retries and process close waiting.

- Priority: Should
- Rationale: Archive shutdown and retries makes operator behavior reviewable.
- Source: src/services/DeliveryArchive.ts; docs/operator-reliability.md
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- Measure: Default retry 5,000 ms; heartbeat 60,000 ms; default close deadline 2,000 ms, bounded configuration maximum 5,000 ms.
- Acceptance:
  — Given I/O failure, when retained queued data retries, then default retry delay is five seconds; given shutdown, when close cannot finish within its deadline, then incomplete close is counted/warned without extending delivery indefinitely.
- Traces: ENT-011, CMP-014

### 3.3 Usability requirements

No quantified operator usability target is evidenced; CLI flags, errors and result scope are specified above.

### 3.4 Interface requirements

#### OPS-IR-001 — Private local archive interface
The system shall read archive reports from bounded local regular files without exposing an HTTP log endpoint.

- Priority: Should
- Rationale: Private local archive interface makes operator behavior reviewable.
- Source: src/services/DeliveryArchive.ts readDeliveryArchive; ops/delivery-archive-report.mjs; docs/operator-reliability.md
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- Acceptance:
  — Given archive reporting, when paths are inspected, then symlink/nonregular/hard-linked or oversized daily files are rejected, scanning is bounded and malformed lines count as coverage loss; POSIX directory/files are owner-only and one writer owns the directory outside public media.
- Traces: ENT-010, API-026, CMP-014, CMP-095

### 3.5 Logical database requirements

ENT-010/ENT-011 own archive/health, ENT-009 Details, ENT-003 checkpoint and ENT-014 prompt job storage. Retain settings, ownership, permission observations, YouTube cleanup, personal preferences, reply journals/history and configured media/reuse state across upgrades. Schema compatibility and rollback limits belong to Data Contracts and the owning area; operator backups have separate retention and restoring an image does not migrate data.

### 3.6 Design constraints

#### OPS-CON-001 — Production runtime configuration
The system shall run the production bot in the documented constrained single-writer container configuration.

- Priority: Should
- Rationale: Production runtime configuration makes operator behavior reviewable.
- Source: Dockerfile; docker-compose.yml; docs/self-hosting.md / Run your own bot
- Verification: Inspection
- Status: Approved
- Delivery: Implemented
- Acceptance:
  — Given production Compose, when started, then Node 26 on Debian 13 runs as non-root with read-only root, no capabilities or privilege escalation, persistent /app/data and 256 MiB temporary storage; thirty-second Compose grace exceeds the core twenty-second drain, and JSON logs rotate three files at ten MiB each; runtime contains no npm/yarn.
- Traces: CMP-001, CMP-003, CMP-097

For outbound destinations, I/O limits, operator authentication and generated mentions see docs/srs/core.md CORE-CON-001 through CORE-CON-005. General article/relay scope remains index TBD-S0-001/TBD-S0-003. The operator metadata CLI currently buffers a response before truncating to 512 KiB and allows three HTTPS redirects with a fifteen-second per-hop timer; whether universal streaming-byte limits apply to this operator-only tool remains TBD-OPS-001. Development requires Node 22+; Linux-compatible Bash is required for deploy safeguards, with Git Bash or a clean Linux checkout on Windows.

### 3.7 Software system attributes

#### 3.7.1 Reliability
Deployment rollback and archive loss behavior are specified above; core owns graceful restart and catch-up execution.

#### 3.7.2 Availability
No production availability/support-hours/RPO/RTO target is inferred; see index TBD-S0-002.

#### 3.7.3 Security
Separate dispatch, publishing and model credentials retain their intended boundaries; public fetch constraints are in core. Secrets stay in operator/CI secret stores; restricted SSH accepts only deploy plus full revision.

#### 3.7.4 Maintainability
CONTRIBUTING.md and VERIFICATION.md map each changed acceptance criterion to a proving test or structural inspection and critical assertions to mutation evidence. A presence-only PR gate does not replace review.

#### 3.7.5 Portability
Local validation excludes production container and secret scan explicitly. Production remains Linux Compose, with one running process per token/state directory.

#### 3.7.6 Privacy and compliance
Archive measurements contain no Discord identity or prose. Operational logs use bounded error serialization but may retain Discord IDs for tracing; older logs/backups need separate retention. No legal certification is asserted.

#### 3.7.7 Observability
Historical verification-history.md partial runs do not establish a green release. VERIFICATION.md owns preflight, source/test traceability, live Discord/provider checks, adversarial/performance checks, hard constraints and final evidence. Failed checks and gaps retain tracker references; green runs append CHANGELOG evidence. Verification targets include tests/delivery-archive.test.ts, tests/delivery-archive-report.test.mjs, tests/delivery-report.test.mjs, tests/provider-metadata-check.test.mjs, tests/validate.test.mjs, tests/ci-workflow.test.mjs, tests/pr-evidence-check.test.mjs, tests/prompt-workflow.test.mjs and tests/deploy.test.sh. No current deployment is claimed here.


### 3.8 Supporting information

Daily review first checks coverage, then the previous daily window and seven-day context only when comparable; select evidence-backed regressions without treating the first week as comparative uptime/speed proof. This is an operator procedure, not a scheduled background service. Setup, settings, command registration and private prompt/status surfaces belong to docs/srs/commands.md; platform behavior belongs to social/articles/erome; threads belong to replies.

## 5. Appendices

### 5.1 Traceability matrix

| Req | Priority | Delivery | Entities | APIs / Events | Components | Verification |
|---|---|---|---|---|---|---|
| `OPS-FR-001` | Should | Implemented | ENT-010, ENT-011 | — | CMP-014, CMP-002 | Inspection |
| `OPS-FR-002` | Should | Implemented | ENT-009, ENT-010 | — | CMP-014, CMP-018, CMP-002 | Inspection |
| `OPS-FR-003` | Should | Implemented | ENT-011 | — | CMP-014 | Inspection |
| `OPS-FR-004` | Should | Implemented | ENT-010, ENT-011 | API-026 | CMP-095 | Inspection |
| `OPS-FR-005` | Should | Implemented | — | API-026, API-027 | CMP-095, CMP-096 | Inspection |
| `OPS-FR-006` | Should | Implemented | ENT-011 | API-026 | CMP-095 | Inspection |
| `OPS-FR-007` | Should | Implemented | ENT-009 | API-027 | CMP-096 | Inspection |
| `OPS-FR-008` | Should | Implemented | — | API-028 | CMP-101, CMP-069 | Inspection |
| `OPS-FR-009` | Should | Implemented | — | API-029 | CMP-103 | Inspection |
| `OPS-FR-010` | Must | Implemented | — | API-029 | CMP-103 | Inspection |
| `OPS-FR-011` | Must | Implemented | — | API-029 | CMP-103 | Inspection |
| `OPS-FR-012` | Should | Implemented | — | API-029 | CMP-103 | Inspection |
| `OPS-FR-013` | Must | Implemented | — | API-034 | CMP-098 | Inspection |
| `OPS-FR-014` | Must | Implemented | — | API-031 | CMP-097, CMP-102 | Inspection |
| `OPS-FR-015` | Must | Implemented | — | API-031 | CMP-097 | Inspection |
| `OPS-FR-016` | Must | Implemented | — | API-031 | CMP-097 | Inspection |
| `OPS-FR-017` | Must | Implemented | — | API-031 | CMP-097 | Inspection |
| `OPS-FR-018` | Should | Implemented | ENT-001 | API-030 | CMP-003, CMP-035 | Inspection |
| `OPS-FR-019` | Should | Implemented | ENT-003 | — | CMP-003, CMP-066 | Inspection |
| `OPS-FR-020` | Should | Implemented | ENT-012 | — | CMP-003, CMP-029 | Inspection |
| `OPS-FR-021` | Should | Implemented | ENT-014 | API-032 | CMP-003, CMP-048 | Inspection |
| `OPS-FR-022` | Should | Implemented | ENT-014 | API-032, API-056 | CMP-048 | Inspection |
| `OPS-FR-023` | Should | Implemented | — | API-032, API-056 | CMP-100 | Inspection |
| `OPS-FR-024` | Should | Implemented | — | API-033 | CMP-099, CMP-100 | Inspection |
| `OPS-FR-025` | Should | Implemented | — | API-032, API-034, API-056 | CMP-100, CMP-098 | Inspection |
| `OPS-FR-026` | Should | Implemented | ENT-014 | API-056 | CMP-048, CMP-100 | Inspection |
| `OPS-FR-027` | Could | Not started | — | API-029 | CMP-103 | Inspection |
| `OPS-FR-028` | Must | Not started | — | API-028 (missing: embed-stage API) | CMP-101 | Inspection |
| `OPS-FR-029` | Could | Not started | — | — | CMP-001, CMP-002, CMP-097 | Inspection |
| `OPS-FR-030` | Could | Not started | — | API-029 | CMP-103 | Inspection |
| `OPS-FR-031` | Should | Implemented | — | — | CMP-004, CMP-068 | Inspection |
| `OPS-NFR-001` | Should | Implemented | ENT-010, ENT-011 | — | CMP-014, CMP-003 | Inspection |
| `OPS-NFR-002` | Should | Implemented | ENT-011 | — | CMP-014 | Inspection |
| `OPS-IR-001` | Should | Implemented | ENT-010 | API-026 | CMP-014, CMP-095 | Inspection |
| `OPS-CON-001` | Should | Implemented | — | — | CMP-001, CMP-003, CMP-097 | Inspection |

## Revision history

| Rev | Date | Commit | Mode | Summary |
|---|---|---|---|---|
| 1 | 2026-11-26T15:44:02-05:00 | 63dff025bffe | ADOPT | Initial OPS-FR-001 through OPS-FR-031; OPS-NFR-001 through OPS-NFR-002; OPS-IR-001; OPS-CON-001 |
