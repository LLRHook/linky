# Contributing to Linky

Use Node.js 22+ (26, pinned in `.nvmrc`, matches the production image; CI also tests 22 and 24) and `npm ci`. Tests need no Discord token. For a local bot, copy `.env.example` to `.env`, set its token, then run `npm run dev`. Commands register automatically at startup. Open `/setup` and use the private panel to enable a test server and select its channels, as described in the [README](README.md).

Before opening a PR, run:

```bash
npm run validate
```

It runs CI's `npm run build`, `npm run check:workers`, `npm test`, `bash tests/deploy.test.sh` and `npm audit --audit-level=low`, continues after a failure and ends with a PASS/FAIL summary; a test keeps the list equal to `.github/workflows/ci.yml`. The production container checks need Docker and run in CI (or by hand per `VERIFICATION.md` 2.5). `tests/deploy.test.sh` needs Linux-compatible Bash: on Windows run validate from Git Bash with Git's `bash` first on `PATH`, or validate the committed `HEAD` in a clean Linux checkout (works from worktrees too): `git bundle create - HEAD | docker run --rm -i node:26 sh -c 'cat > /tmp/head.bundle && git clone -q /tmp/head.bundle /app && cd /app && npm ci && npm run validate'`. To run it before every push, opt in once per clone: `git config core.hooksPath .githooks`.

CI runs the secret scan, dependency audit, Node 22/24/26 builds and production container as independent jobs, so one failure does not hide the others. `CI gate` is the required check on `main` and passes only when every job passes.

Every PR description fills the [template](.github/pull_request_template.md) sections Tickets, Acceptance evidence, Mutation checks, Docs checked and Remaining gaps; the required `PR evidence` check fails while any is empty and reruns when the description is edited. Map each acceptance criterion to a named test, or to the `file:function` you inspected when the criterion is structural ("execute reads as named stages"): passing behaviour tests do not prove structure. A criterion delivered only in part stays unticked, is stated under Remaining gaps and gets a follow-up ticket. For each critical new assertion, break the code it guards and record which test failed.

Test observable behavior: channel scope, exact URL matching, attribution, attachment integrity, source edits, permissions and provider failures. Cover preference migration and concurrent writes, operator limits, and `/settings` changing preferences without enabling a server. Use synthetic or non-sensitive translation and YouTube API fixtures. Avoid network calls or bot login in unit tests. Never commit tokens, API keys, `.env` or private chat exports.

For rendering changes, use an authorized Discord test channel. Check X, Instagram and TikTok (including a real `vm.tiktok.com` share link), profile and lookalike URLs, attachments and replies. In Replace mode, missing Manage Messages permission must preserve the original. Reply mode must work without that permission, keep the original and avoid copying its attachments. Check per-platform switches and translation limits. With translation enabled, inspect text/photo cards, playable videos, quoted posts and long text; confirm the language label stays small. Offline tests cannot prove live preview rendering or channel permissions.

Instagram caption translation has a separate operator flag and key. Follow the [translation activation checks](docs/instagram-translation.md): mixed-language captions, hard-wrapped paragraphs, literal handles/links, English-only posts, working image and Reel media, unavailable previews, source edits and server opt-outs. Verify native media actually plays and the original caption is absent. A translation fixture proves code behavior, not the provider's language accuracy or a live Discord render.

YouTube checks need an operator-provided API key configured as described in the README. Check HTTPS watch, short, Shorts, live and embed links, valid timestamps, lookalikes and malformed URLs. Confirm the native video and compact counts share one message; exact counts and the attributed top comment open privately. Test preview-only, counts, and counts plus comment separately, including policy changes while lookup is pending. Missing fields are omitted; missing keys and API failures preserve the original. Use controlled expiry to verify cleanup and durable retry across restarts while retaining the native video, Original post and Remove controls. The queue contains only message/channel/video IDs and expiry metadata, plus legacy character lengths. API counts and comment text belong only in the five-minute memory cache and Discord additions.

The bot must remain silent when joining a server. `/help`, `/setup`, `/settings` and `/diagnose` are private. Every setup component checks Manage Server permission. Preference changes must not enable servers or broaden legacy scope. Test selected parent-channel threads, empty channel selection and permission changes.

Verify missing, delayed, unrelated and provider-error embeds before source deletion. Video metadata is evidence of an embedded player, not proof of actual playback. Test automatic fallback on one output, `!nolinky`, hidden URLs, disabled features and source changes during every awaited operation. Preserve original messages whenever replacement cannot be verified and disable mention notifications.

Use current public Bluesky, Reddit and Twitch clip examples for new-provider checks. Profiles, indexes, lookalike hosts and unsupported share forms must stay unchanged. A successful HTTP status alone is not a usable preview. Record first-party provider sources and the actual metadata observed, including failures.

Test `/fix` and **Apps → Fix with Linky** in guild and user installation contexts. They must never alter the source or enable passive DM processing. Reject forged Remove/Retry actions; test source edits/deletes and manually deleted bot output across registry restarts. Registry records contain ownership IDs and cleanup intent, never message content. Keep legacy settings readable and document rollback compatibility.

The security baseline and exact scanner commands are in [SECURITY_AUDIT.md](SECURITY_AUDIT.md). CI scans the complete Git history with Gitleaks and checks npm advisories. Test-only secret-scan suppressions must identify the exact synthetic fixture; never suppress a whole credential rule. Dependency and base-image updates arrive through Dependabot and still require the normal checks.

For bugs, include expected and actual behavior, a reproducible public link where possible, sanitized logs and any Discord error code. Report security issues privately to `victor.n.ivanov@gmail.com`.

## Project-cycle files

`bugs.md`, `features.md`, `CHANGELOG.md` and `VERIFICATION.md` are interlocked: defects and features are filed, work is verified against `VERIFICATION.md`, and shipped or fixed entries are migrated into `CHANGELOG.md`.

- File a `BUG-<id>` in `bugs.md / ## Open` when you find a bug, in the same change; never silently fix one. When the fix lands, tick it, add a `**Fix:**` line and set `Status: fixed-pending-migration`.
- File a `FEAT-<id>` in `features.md / ## Open` before writing feature code. When it ships, tick it, add an `**Implementation:**` line and set `Status: shipped-pending-migration`.
- Ids are UNIX-epoch timestamps (`date +%s`), never sequential. Append new entries at the end of their section and change `Status:` in place. The trackers carry `merge=union` so concurrent appends merge; the only physical move between sections happens at the release verification run.
- Every ticket carries a `Bump:` (`major | minor | patch`). Migration copies a one-liner with the id and bump marker into `CHANGELOG.md / Unreleased`.
- A green `VERIFICATION.md` run appends a `Verified` entry to `CHANGELOG.md` and updates the test counts in `VERIFICATION.md`. When a doc claim drifts from the code, fix it with evidence or file a `docs` bug; do not edit a claim without checking.
