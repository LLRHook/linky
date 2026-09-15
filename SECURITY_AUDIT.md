# Linky security audit

## Scope and date

Reviewed on 15 September 2026, on the maintenance branch based on `6f1c1927f367f3c5a240bdd9b9386c80c9fec705`. Scope includes the bot, regional media workers, persisted state, provider responses, dependencies, Git history, CI, deployment and production-container packages. This is a point-in-time audit, not a claim that unknown vulnerabilities are absent. No evidence of exploitation was found or inferred from scanner results.

The repository has no `bugs.md` tracker. This file owns the audit findings and follow-up conditions. The website has its own audit in the separate website repository.

## Results

| Check | Result |
| --- | --- |
| Locked npm dependency graph, including development packages | `npm audit --json`: zero findings before and after maintenance |
| Git history secrets | Checksum-verified Gitleaks 8.30.1 scanned all available history: no actual credentials; two exact historical detections were synthetic regional-worker test fixtures |
| Working files secrets | All tracked and nonignored untracked files scanned with redaction: only the same synthetic fixture; no actual credentials |
| Application regression suite | 828 TypeScript tests and 31 workflow tests passed; six real FFmpeg tests run separately in Linux |
| Build and deployment safeguards | Strict production build, regional-worker typecheck and all 24 deployment checks passed |
| Container packages | Separate Trivy 0.74.0 audit; see the runtime baseline and unresolved upstream advisories below |

The two `.gitleaksignore` entries identify one fixture path/line in two historical commits. They do not ignore that file generally, disable a detector or allow future credentials. Scanner output is redacted; reports must not contain secret values.

## Resolved findings

| Finding | Change and evidence |
| --- | --- |
| Unbounded provider JSON responses | Tweet translation, YouTube metadata and optional GitHub job-status calls now use one streaming decoded-byte reader with limits of 1 MiB, 128,000 bytes and 4 MiB respectively. Oversized declared or streamed responses are rejected, UTF-8 is validated, readers are cancelled and body reads remain within the request timeout. Redirects are rejected. Existing fail-open behavior is retained. Regression cases failed before the fixes and pass afterward. |
| Coding-request guard lost through a shared helper | The extracted configuration parser and bounded JSON reader are explicitly protected from optional coding candidates, with case-insensitive regression checks. Configuration refactoring cannot move privileged admission/status behavior outside the protected file set. The hosted coding integration remains disabled. |
| Duplicated durable-write implementation | Repost ownership, YouTube expiry records and translation budgets share the same exclusive owner-only temporary write, file sync, rename and Linux directory sync. Their existing serialization and failure semantics are preserved. Different persistence designs were not forced into this helper. |
| Runtime package-manager surface | The updated runtime removes unused global npm, npx, Corepack and Yarn after building. The bot executes Node directly and does not install packages in production. Bundled-tool vulnerabilities are therefore removed from the runtime rather than hidden by npm's application-only audit. |
| Mutable image references and missing update detection | Base images are pinned to verified OCI digests. Dependabot checks npm, Docker and GitHub Actions weekly; GitHub vulnerability alerts and automatic security fixes are enabled. CI verifies downloaded Gitleaks and Trivy checksums, audits npm and rejects container vulnerabilities with available fixes. |
| Untracked log limits and stale documentation | Compose records JSON-log rotation at 10 MiB with three files. Current docs describe the existing safe error serializer, operational IDs and the separate historical-log caveat. This does not retroactively erase old logs or provider backups. |

Behavior-preserving cleanup also moves platform configuration and repost presentation out of the social-link coordinator. Existing exports retain their identity for the optional external instrumentation adapter. The README now points to a dedicated self-hosting guide; detailed quotas, privacy boundaries and rollback instructions were retained.

## Runtime baseline and upstream issues

The running pre-maintenance image used Debian 12.15. Trivy 0.74.0 reported 10 critical, 239 high, 341 medium, 221 low and 70 unknown package/advisory rows. Fifteen rows had a fixed version available. These are package records, not a count of independently exploitable bot defects; one CVE can appear against several FFmpeg binary packages.

The validated replacement uses official Node 24.21.0 on Debian 13.7 (Trixie), with FFmpeg 7:7.1.5-0+deb13u1, Debian updates and no runtime package managers. The full scan reports 1 critical, 200 high, 197 medium, 165 low and 27 unknown rows, with **zero fixed-version findings**. Critical/high rows deduplicate to 37 CVEs. All six real video tests and the non-root settings/media-store smoke passed with the tracked read-only filesystem, dropped capabilities and no-new-privileges restrictions.

The remaining critical is [libxml2 CVE-2026-6653](https://security-tracker.debian.org/tracker/CVE-2026-6653); Debian describes it as a minor issue with no Trixie security update. Sixteen high FFmpeg CVEs are deferred pending upstream fixes in the 7.1 branch. The scanner severity is retained beside that distro assessment. The [runtime comparison and full critical/high matrix](docs/runtime-security-2026-09-15.md) records every advisory, applicable controls and the remaining exposure. Review on the next dependency update, when the distro publishes a fix, or when accepted media types change. No CVEs have been silently suppressed.

The runtime comparison used unchanged production application files to isolate library changes. CI builds the complete maintenance image from this repository and retains its unfiltered vulnerability report for 14 days alongside the fixable-only gate. A zero-result Alpine comparison is not treated as proof of safety: Trivy's Alpine source does not report unfixed vulnerabilities. Prefer a maintained runtime with tested codec compatibility and explicit residual tracking over changing distribution solely to reduce scanner counts. [Trivy vulnerability sources](https://trivy.dev/docs/latest/coverage/os/alpine/), [Debian security tracker](https://security-tracker.debian.org/tracker/).

## Application boundaries reviewed

- Automatic processing still requires effective server/channel enablement, HTTPS post-shaped links and current permissions. New servers remain disabled and joins stay quiet. Source retention and ownership checks are unchanged.
- Remove remains original-author-only for automatic messages and requester-only for manual messages. Retry has its separate author/current-moderator check. A button identifier alone does not grant authority.
- Existing media safeguards validate URLs, resolved destinations, redirects, MIME/ranges and byte limits. Signed regional requests are versioned, bounded and one-use; source URLs and transfer credentials are not logged. Erome is limited to eligible server channels under the saved policy.
- FFprobe and FFmpeg process local bounded inputs, allow the MOV/MP4 demuxer, disable external data references and absolute paths, and allow only local file/pipe protocols as required. They have time limits, allocation/thread bounds and bounded temporary storage. These controls reduce reachability and resource exposure; they do not prove every codec vulnerability unreachable.
- The bot runs as a non-root user with a read-only root filesystem, all capabilities dropped and no-new-privileges. Persistent operational files and media have explicit size/record bounds; malformed ownership/settings files fail closed rather than silently resetting authority. One instance owns the data volume.
- The error serializer excludes arbitrary messages, stacks, URLs, request bodies and attachment bytes. Operational Discord IDs can still be logged. Older logs and backups require separate retention handling.
- The optional coding workflow has restricted files, a separate review stage, required checks and protected merge/deploy controls. Its credentials and GitHub responses are not shared with Discord. Disabled hosted configuration is verified without reading credential values.

## CI and repository controls

The public bot's `main` protection requires **Build (Node 22)**, **Build (Node 24)** and **Production container**, with up-to-date branches, admin enforcement, no force pushes and no branch deletion. Pull requests are used for maintenance and feature changes. The current approval count is zero; independent review is performed in the development workflow rather than claimed as a GitHub-required approval.

CI's npm gate includes all severities. The container gate uses `--ignore-unfixed --exit-code 1`; it rejects fixed-version findings at every severity and does not claim a clean full vulnerability scan. Re-run the full scan when changing the runtime and review unresolved distro advisories. Scanner/download/database failures fail the check rather than silently passing. No broad vulnerability suppression file is used.

The website remains private; its current GitHub plan does not permit private-repository branch protection. That limitation is documented in its own audit and does not change this bot's controls.

## Verification and release status

Local application checks and independent source review passed. The cleanup release must additionally pass the production image's non-root storage smoke test, six real FFmpeg tests, GitHub's required checks, and deployment health verification. Container/library changes require real video verification; mocked provider metadata cannot establish playback on every Discord client.

Update this baseline after the cleanup release and the later diagnostics/cache/scheduling/album work. Changes to persisted diagnostics, retention or media reuse also require matching updates to the public privacy notice.
