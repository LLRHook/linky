# Self-hosting and operations

The public hosted bot runs on Hostinger; the website uses Vercel. It provides X/Twitter, Instagram, TikTok, YouTube, Bluesky, Reddit, Twitch clip and Facebook Reel and video previews, with available tweet translation and YouTube extras. Members need no keys or hosting. Erome is self-host-only for public users: use your own bot application, server, storage and any media workers. The optional coding integration is disabled on the public bot. Operator settings do not bypass a server administrator's channel choices.

## Hosted and self-hosted features

Self-hosting provides the implemented platforms and configuration controls; it does not make every website embeddable. Erome retains its existing media, channel and preparation limits. Your instance uses your token and resources. The website invite always adds the public hosted bot, so create an invite using your own application ID.

`REWRITE_PLATFORMS` controls the operator platform ceiling. `EROME_GUILD_IDS` can restrict Erome further: omit it for the self-hosted default, set it to `none` to disable Erome everywhere, or supply a comma-separated allowlist of server IDs. Server administrators cannot override that restriction. Published media cleanup and owner removal remain active when new Erome processing is disabled; do not disable the media server just to stop new requests.

## Optional coding requests

In a server approved by the bot operator, an **Administrator** can type
`/prompt`, choose Linky's command, and describe one change in **request**. For
example: `/prompt request: Add a setting to hide the original-post button`.
Use **Check status** on the private response to follow the job and open its PR.
If that response disappears, run `/prompt` without a request to recover this server's latest job.

The feature request and coding run are public on GitHub. Send a feature description,
without private messages, credentials, or personal information. A successful request
changes the shared hosted bot for every server. Installing Linky or running `/setup`
does not grant coding access.

The optional worker uses GPT-6 Astra with Codex's Ultra mode in an isolated checkout.
A separate reviewer must approve the patch, the existing required checks must pass,
and a protected merge must succeed before the normal Hostinger deployment runs.
Failed or unsupported changes stop with an explanation or an open PR. Operator
setup and limitations are in [Discord coding requests](discord-prompt.md).

## Run your own bot

Requires Node.js 22+ and npm, or Docker Compose on Linux. Erome also requires `ffmpeg` and `ffprobe` on PATH; the Docker image includes Debian's maintained FFmpeg package. Create an application in the [Discord developer portal](https://discord.com/developers/applications), enable **Message Content Intent**, and put its bot token in `.env`. Enable both **Guild Install** and **User Install** in Installation settings. User installation needs only `applications.commands`; guild installation also needs `bot` and the permissions listed in the [README](../README.md#add-to-discord). The README invite links add the hosted Linky; create invite links using your own application ID for a self-hosted instance.

```bash
git clone https://github.com/LLRHook/linky.git
cd linky
npm ci
cp .env.example .env
# Set DISCORD_TOKEN in .env.
npm run dev
```

Linky registers its commands automatically at startup. Open `/setup` to enable your test server. Server Members Intent is unnecessary.

| Setting | Meaning |
| --- | --- |
| `DISCORD_TOKEN` | Required bot token; keep it private |
| `LINK_CHANNEL_IDS` | Optional comma-separated exact channel IDs to enable initially |
| `LINK_SERVER_IDS` | Optional comma-separated server IDs to enable initially, including accessible threads |
| `LINK_SETTINGS_PATH` | Saved enablement and preferences; default `data/servers.json` |
| `REWRITE_PLATFORMS` | Subset of `x,instagram,tiktok,youtube,bluesky,reddit,twitch,facebook,articles,erome`; empty enables available platforms, with automatic YouTube statistics requiring its API key and Erome following the server's channel policy; public article metadata and PDF previews need no key |
| `TRANSLATE_TWEETS` | `true` enables English translation; default `false` |
| `YOUTUBE_API_KEY` | Optional operator key for YouTube Data API v3; absent leaves native videos untouched; public community text/image posts need no key |
| `TRUTH_SOCIAL_RELAY_URL`, `TRUTH_SOCIAL_RELAY_TOKEN` | Optional [Truth Social relay](truth-social-relay.md) HTTPS origin and its 32–512 character bearer secret; set both or neither. Used only when Truth Social's status API refuses the host; without either, other accounts' posts fall back to page text and first images |
| `EROME_MEDIA_ENABLED` | Enables optional regional original-video delivery after hosting is configured; default `false` |
| `EROME_WORKER_KEY`, `EROME_WORKER_BASE_URL` | Shared worker HMAC secret and the dedicated Vercel worker project's HTTPS origin |
| `EROME_MEDIA_BASE_URL` | Public HTTPS media origin, without a path, query or credentials |
| `EROME_MEDIA_PATH`, `EROME_MEDIA_PORT` | Persistent media directory and listener port; `.env.example` uses `data/media` and `8092` |
| `CATCH_UP_ENABLED` | `true` fixes links posted while the bot was offline after a restart; default `false` |
| `LOG_LEVEL` | Logging level; default `info` |
| `PROMPT_ENABLED` | Explicitly enables the optional coding integration after worker setup; default `false` |
| `PROMPT_GUILD_IDS` | Separate operator list of servers whose Administrators may request code changes |
| `PROMPT_GITHUB_TOKEN` | Repository-scoped Actions dispatch/read credential; never the publishing credential |

The optional ID lists preserve operator channel restrictions. Saved server enablement takes priority, then selected channel preferences narrow that scope. With no saved choice or configured IDs, a server stays inactive. Legacy exact-channel scope still requires each thread's own ID. DMs have no automatic processing. Malformed settings stop startup rather than silently changing scope.

For YouTube, the operator enables [YouTube Data API v3](https://developers.google.com/youtube/v3/getting-started), sets `YOUTUBE_API_KEY`, and [restricts it](https://docs.cloud.google.com/api-keys/docs/add-restrictions-api-keys) to that API and the host's outbound IP. Hosted-bot users do not need a key. API results have a five-minute memory cache shared by posting and button requests. Keep `data/youtube-stats.json` available for expiry cleanup; it stores message/channel/video IDs and expiry metadata, with character lengths for legacy messages, not counts or comments.

The X post lookup sends only the public status ID to FxTwitter (`api.fxtwitter.com`), whenever the X platform is enabled and a message's only link is one X post, even with `TRANSLATE_TWEETS` off; it adds `?lang=en` only when translating. Translation and one-post blocks share a bounded memory cache: five minutes per status (30 seconds after a failure), at most 100 entries and eight requests in flight. Disable the X platform to stop these requests.

The Bluesky post lookup sends only the post's actor (the handle or DID in the link) and record key to Bluesky's public AppView (`public.api.bsky.app`, `app.bsky.feed.getPostThread`), when the Bluesky platform is enabled and a message's only link is one Bluesky post. It sends no credentials and refuses redirects. Results stay in a bounded memory cache: five minutes per post (30 seconds after a failure), at most 100 entries and eight requests in flight. Discord, not Linky, fetches the images from `cdn.bsky.app`. Disable the Bluesky platform to stop these requests.

To confirm a one-post block whose media Discord has not yet marked loaded, Linky sends one HEAD request per such item to the proxy address Discord assigned it, only on `images-ext-N.discordapp.net` or `media.discordapp.net`, without redirects and with a five-second limit. The address is Discord's own copy of the source media URL; the request carries no credentials, and Linky reads only the status and content type.

The Instagram post lookup sends only the public post shortcode to OGInstagram and keeps the author and media addresses in a bounded five-minute memory cache; it never reads or stores captions. Instagram caption translation was removed on November 23, 2026: `TRANSLATE_INSTAGRAM` and `GOOGLE_TRANSLATE_API_KEY` are ignored, and an existing `data/translation-usage.json` is no longer read and can be deleted. Revoke a key created only for this feature.

`data/personal-preferences.json` stores only opted-out server/account ID pairs, with a 1 MiB and 10,000-record limit. Re-enabling your automatic fixes removes your pair. Removing the bot clears that server on departure or the next successful startup; operator backups need separate deletion. Writes are atomic and owner-only on POSIX. Invalid storage stops startup rather than silently forgetting choices. Retain this file across upgrades; versions predating `/autofix` do not honor it.

Public YouTube community lookups fetch only an allowed first-party `/post/` page with pinned public DNS, no redirects or cookies, a five-second default deadline and a 2 MiB response limit. Their bounded memory cache may reuse successful post metadata for up to one minute and failed lookups for 15 seconds. Expired entries are removed on later lookups, eviction, or restart; these reuse limits do not guarantee physical removal while the process is idle. Mobile share resolution similarly uses strict platform destinations and bounded requests. Neither lookup sends Discord IDs or surrounding message text.

`data/reposts.json` stores source/repost/author/channel/server IDs, posting mode and pending cleanup IDs. The sibling `data/reposts-permission.json` stores optional timestamps for consecutive permission-failing sweeps. It contains no chat text. Ownership lasts up to 30 days, with a 10,000-record cap; pending cleanup is retained for retry unless permission failures persist for at least 24 hours. Failed YouTube cleanup records retire more than seven days after expiry. See [cleanup and rollback details](delivery-reliability.md#local-retention-and-operations), including fail-open loading of missing or malformed observations. The ownership journal keeps its original three-key schema; older images ignore the sibling file and can still load ownership during rollback. Recent provider observations are process-local and contain no message content or server IDs.

Erome processing requests the selected public album and its chosen media, without sending Discord message text or account/server IDs. Temporary files are removed after preparation; Docker keeps them in a bounded memory-backed mount. The attachment cache holds at most 32 variants for five minutes and 128 MiB total. Optional hosting retains registered originals and their message references, up to 10 GiB and 4,096 files. Public random-ID media URLs work while their asset is retained. Removing the final bound preview releases its asset; unbound publishes expire after 15 minutes.

New local state includes `data/delivery-diagnostics.json` (seven days, 4,096 attempts, 4 MiB) and the private `erome-reuse` sibling of the media directory (seven days since use, 1,024 entries, 2 MiB). Diagnostics contain finite codes/timings and ownership IDs, not URLs or chat text; the reuse index contains hashed source validators and asset descriptors. Album controls keep bounded session state in memory for up to 24 hours and expire on restart. See [delivery reliability and retention](delivery-reliability.md) for exact lifecycle and failure behavior, including shared work, fair scheduling and private Details. These records do not activate the website analytics collector.

The media store supports legacy MP4 records plus new MIME-aware MP4/JPEG/PNG records. Keep compatible data backups before upgrading; old MP4-only images cannot safely read the new image records. See [Erome limits](erome-previews.md) and the [regional hosting guide](erome-regional-hosting.md).

For production:

```bash
docker compose up -d --build
docker compose logs -f
```

The container runs Node.js 26 as a non-root user on Debian 13, with a read-only root filesystem, no Linux capabilities and no privilege escalation. Writable state belongs in `/app/data`; preparation uses the bounded `/tmp` mount. npm and other package managers are only available during the image build. Back up the `linky-data` volume and server's `.env`. Keep one running instance per bot token. Restart after changing environment settings; `/setup` and `/settings` take effect immediately.

When the container stops, Linky stops taking new messages and lets running deliveries finish for up to 20 seconds, then cancels the rest. Commands and buttons used meanwhile get a private "restarting" reply. Keep Compose's `stop_grace_period` (30 seconds) above that limit. `data/service-checkpoint.json` records when the bot stopped, so the next startup logs `Back online after N s offline`; nothing is logged after a crash. With `CATCH_UP_ENABLED=true` it also keeps the IDs of the 20 enabled channels where a link was posted most recently, plus a time refreshed every 30 seconds. After a restart or crash, Linky reads up to 50 messages per channel posted since then and at most two minutes ago, four channels at a time, and handles them like new messages. It skips messages it already reposted. Messages in other channels, older ones, and channels without **Read Message History** stay unchanged. After a crash, a link whose repost was sent but not yet recorded can be reposted again. The file never contains message text.

This version reads both legacy `{ "serverId": true }` settings and records with optional enablement and preferences. Once preferences are saved, older images cannot read those records. Keep a compatible settings backup before upgrading; a rollback to an older image also needs its compatible settings file. Restoring an image alone does not migrate the data volume.

## Checks and deployment

```bash
npm test             # strict typecheck and isolated tests; no token needed
npm run build        # production TypeScript
npm run check:workers # regional worker entrypoints
bash tests/deploy.test.sh
```

CI tests Node.js 22, 24 and 26, deployment safeguards, and the production container, with the dependency audit and secret scan as separate jobs; the `CI gate` check passes only when every job passes. See [contribution guide](../CONTRIBUTING.md) for live preview checks.

The hosted bot deploys after CI passes for a push to `main`. Deployment accepts only the current tested commit, builds before replacing the bot, checks its Discord connection, and prints how long the bot was offline. It supplies the verified full commit as the `LINKY_SOURCE_REVISION` build argument and compares the running container's image label with that commit. Failed startup, a missing/unreadable label or a revision mismatch restores the previous image and deployed Compose configuration without advancing the successful-deployment marker. The server's `.env` and data volume are preserved. Successful output still ends with `LINKY_DEPLOYED_SHA=<sha>`.

Read the latest image's source revision with:

```bash
docker image inspect linky:latest --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
```

To identify the running container rather than the mutable `latest` tag, first run `docker inspect linky --format '{{.Image}}'`, then use that image ID in the same `docker image inspect` command. The OCI label `org.opencontainers.image.revision` records the supplied build revision; it is not a signature. Manual builds can set `LINKY_SOURCE_REVISION=$(git rev-parse HEAD) docker compose build linky`. Without the argument the label is empty and the image still builds and starts. During the first rollout of this change the already-parsed older deploy script builds the new files without a revision; the following deployment uses the new script and enforces the label. Rollback starts the previous image and Compose configuration without applying the new revision check to the restored image.

Operators use `/root/linky`, configure `LINKY_DEPLOY_HOST`, `LINKY_SSH_KEY` and `LINKY_SSH_KNOWN_HOSTS`, and install `ops/ssh-deploy.sh` as `/usr/local/sbin/linky-deploy` with a restricted SSH key and pinned host key. After the first successful manual deployment, run `git rev-parse HEAD > .git/linky-deployed-revision` to initialize the rollback marker. Connection establishment retries automatically; for a failed deployment, inspect its logs and rerun the failed Deploy job. Disable Deploy in GitHub Actions to pause updates.

[MIT license](../LICENSE).

## Delivery archive and weekly reports

The bot also writes a separate, bounded operator archive alongside its persistent settings. It defaults to 30 days; `DELIVERY_LOG_RETENTION_DAYS` accepts 1–90 days. The 64 MiB storage cap can expire older data sooner. The archive contains only sanitized delivery measurements and random attempt IDs, not Discord identities or message content. Discord Details keeps its own seven-day retention and permissions. See [operator reliability](operator-reliability.md) for reporting, coverage checks and backups.

## Operational logs

The current error serializer keeps a bounded set of error names, numeric API/status codes, known system codes and HTTP methods. It excludes arbitrary error messages, stacks, request bodies, URLs and uploaded bytes. Operational events can still contain Discord identifiers needed to trace delivery and cleanup. Earlier releases could include request content in error logs; historical copies and backups need separate retention handling. The Compose configuration rotates each container's JSON logs at 10 MiB with three files; this is a size limit, not a time-based deletion guarantee. See the [public privacy notice](https://linkybot.dev/privacy) for current data flows.

### Replies setting and rollback

`/settings replies:true|false` enables public reply threads per server; the default is false. Linky needs Create Public Threads and Send Messages in Threads. Existing installs may need an admin to grant Create Public Threads. An eligible X post fetches one public FxTwitter conversation page only on a click: five seconds, 256 KiB, no credentials, redirects refused. Parsed replies stay in a bounded memory cache, not on disk.

Deploy and host-confirm the settings reader (PR #123, merge b0fa652) before the replies writer merges. Reverting the writer retains the reader. Images older than that reader cannot load saved `replies` preferences; restoring one requires a compatible settings backup.

`reply-cleanup.json`, beside settings, retries manual and deferred repost thread cleanup at startup and every minute. It contains at most 10,000 entries of guild, channel and thread IDs only, written atomically; old images ignore it during rollback. It stores no text, author or counts. Manual Remove persists intent before deleting a parent that may have a replies thread; a failed write preserves that parent and sends the requester a private failure notice. In a replies-off server, an output without HasThread and without any in-process thread creation is deleted directly, without a journal reservation or thread lookup. A pending deletion holds its reservation against timer sweeps. Once the request settles, even on rejection, the hold is released while durable intent remains. The minute sweep retries deletion of an existing owned manual parent, treats an already missing parent as deleted, then cleans its thread. Replies stay disabled for a pending entry. Single and bulk gateway deletions queue cleanup when cached thread evidence or an eligible cached manual output is available, with bot-thread ownership checked before deleting copied reply pages. Automatic repost deletion uses the existing repost journal; after the parent is deleted, a transient reply-thread cleanup failure transfers only its cleanup IDs to reply-cleanup.json so Retry can regenerate without waiting for recovery. A refused transfer, including journal capacity or a failed disk write, retains the original registry record and remove intent for the next registry sweep. Remove reports the existing could-not-remove-yet notice while cleanup is pending, even if its parent has already been deleted. Manual and speculative gateway jobs still follow the capacity-drop policy below. Cleanup deletes only Linky's marked copied reply pages and renames/archives the thread where Discord permits; other Linky posts, system messages and members' messages remain. Unknown thread or lost access is terminal; other failures remain queued.

#### Reply cleanup boundaries

Cleanup removes only Linky's copied reply pages, identified by a dedicated container marker and an ordinary message type. It preserves members' messages, their Linky reposts and manual previews, and Discord system/starter messages. An already archived thread named Replies removed is a no-op. Locked threads and terminal Discord access/permission errors do not block removal of the parent; only transient failures stay queued. Copied pages that Discord no longer allows Linky to delete can remain in a locked or inaccessible thread.

The replies setting gates new threads and speculative deletion work, never cleanup of an existing thread. Owned removal skips thread discovery only when replies are off, the parent has no HasThread flag (a fresh fetch for registry removals, the interaction snapshot for manual Remove), and this process has no in-flight or completed creation for that id. A missing parent or any positive evidence still causes one bounded lookup. Process-local creation evidence for cleanup is bounded at 10,000 IDs; reaching the cap conservatively disables this shortcut for the rest of the process. Cleanup waits for active creation, so a late stale snapshot cannot strand newly posted pages. A missing thread counts as done. With replies off and no trustworthy thread evidence, gateway deletion events cause no new reply-cleanup journal write or REST call. Explicit owned removal that may have a thread creates cleanup intent. A cached member-owned thread overrides HasThread evidence. With replies enabled, speculative cleanup of an eligible cached manual output can still queue despite that foreign owner; the thread-owner check prevents mutation, but the event incurs bounded journal and REST work. Gateway cleanup honors hasThread only on a cached Linky-authored or own application output, or an independently cached Linky-owned thread, even after replies are disabled. A member or other bot's message with a member-owned thread is ignored whatever the setting. With replies on, an eligible cached Linky manual output can also enqueue speculative cleanup. An uncached deletion without either form of evidence is ignored: Linky does not fetch arbitrary deleted messages to discover ownership. New enqueue work attempts only that entry; startup/minute sweeps visit at most 50 entries in round-robin order. The journal holds at most 10,000 entries; at capacity new cleanup is dropped with a warning and manual Remove still removes the parent. Completed jobs are deduplicated in a bounded ten-minute memory cache.

If a moderator deletes a parent while Linky is offline, Discord does not replay that deletion event on reconnect. Its copied replies can therefore remain until another supported cleanup path reaches them. The same gap applies to an online uncached deletion without ownership evidence. There is no offline deletion reconciler. Operators can remove the remaining reply pages manually.

If reply-cleanup.json cannot be read or validated (other than a missing file), startup attempts to rename it to reply-cleanup.json.corrupt-{timestamp}, logs a warning and starts with an empty journal. A transient read error can therefore set aside valid intent too; a failed rename is also warned about. The quarantined cleanup intent is not replayed automatically; an operator can inspect the IDs and remove remaining copied pages. Keep the data directory writable for durable cleanup. Reservation or deletion failures send a private failure notice; a successfully reserved deletion that rejects is still retried by the journal.

Live acceptance must verify rename and archive using only the documented invite permissions, without Manage Threads, on both active and auto-archived public threads. In particular, confirm whether Discord permits the bot owner to rename and archive, and that a 50013 denial still leaves copied pages deleted and parent removal complete. The bot treats rename/archive permission denial as terminal, so names or archive state may remain unchanged; Manage Threads is not requested.

A manual card can briefly publish Replies before a late source/settings recheck rewrites it into a notice. A thread opened in that window may retain copied pages until Remove or another supported cleanup path. This notice-rewrite gap is not reconciled automatically: the durable manual journal also deletes its parent and cannot safely be reused for a notice that must remain. No new journal schema or reconciler is added here.

For Bluesky public reply threads, including the `depth=1` / `parentHeight=0` AppView request,
limits, filtering and cleanup, see [Replies and comments on X, Bluesky, YouTube and LinkedIn](../README.md#replies-and-comments-on-x-bluesky-youtube-and-linkedin).

YouTube comments threads: with `/settings replies:true`, a configured `YOUTUBE_API_KEY`, and `/settings youtube_display:counts-and-comment`, single-video posts with a positive comment count include **Comments (N)**. Clicking opens a public thread with up to 25 top-level comments in YouTube relevance order. Each uncached click costs **1 YouTube Data API quota unit**; parsed comments are cached for 5 minutes in a separate cache of at most 100 videos. Counts-only mode does not offer comments. Cleanup starts when the YouTube controls expire after **24 hours**, removing copied comments and renaming and archiving the thread while preserving members' messages. Transient failures retry through the existing durable queue, but records are dropped after more than seven days of failed cleanup. If the parent is deleted while the bot is offline, the missing parent provides no thread evidence and copied pages may remain. Lost access can also prevent deletion; removal within 24 hours is not guaranteed. Comments link to the video.

YouTube expiry edits controls on the statistics queue, then cleans copied comment pages outside that queue while retaining the original durable expiry record until cleanup succeeds (or reaches the terminal retry limit). Unrelated publication and parent removal do not wait for thread cleanup. Remove/Retry leaves copied-page cleanup to the existing owned-parent removal path, avoiding a second pass. A cached member-owned thread skips discovery; an uncached member thread can still cause one bounded ownership lookup at expiry.

### LinkedIn comments threads

The existing `/settings replies:true` option also enables LinkedIn comments. See the [comments source, limits, retention and cleanup](article-previews.md#linkedin-comments-threads).

### Reply thread creation history

`reply-creation-history.json`, beside `servers.json`, stores at most 100,000 parent message IDs, with at most 2,300,002 bytes written and a 2,400,002-byte read limit. Intent is saved atomically before Discord creation. A definitive Discord API refusal (HTTP 4xx, apart from existing-thread conflicts) clears intent durably so a later click can create; ambiguous transport/5xx failures retain it and a retry only links a thread that exists. A failed clear logs a warning and drops the ID from memory; after the one-minute write backoff this process can retry creation. The prior disk snapshot remains until a later successful save, so a restart before then can still answer removed. Oldest parent snowflakes are evicted at capacity, regardless of insertion order. At an assumed 1,000 new parent IDs daily across the bot this retains about 100 days; higher volume shortens retention. A moderator-deleted thread on an old parent outside retained history (evicted or too old to record) can be recreated. Previously deleted threads predating this history cannot be identified after Discord clears HasThread. Keep the history with the data volume on restart.

Invalid, oversized or unreadable state follows `ReplyCleanupJournal.ts`: quarantine as `.corrupt-<time>` with an operator warning and start empty. This loses deletion protection for the quarantined IDs. If quarantine fails, new creation stops only for that process run, with a warning; restart retries recovery without a required file edit. Failed writes warn and refuse the current creation. Existing threads still link or fill. No provider reply content is stored here.

History write failures pause new creation for one minute before retrying, including writes to remember an existing thread. Existing threads remain usable during this backoff. At capacity an older incoming parent that would evict itself does not rewrite the history file. The separate 10,000-entry process-local cleanup evidence tracks removal races and remains unchanged by this durable creation ledger.

Rollback: older images ignore reply-creation-history.json and lose this deletion protection while running; preserve the file for a later upgrade. It carries IDs only and changes no existing state schema. Deletions during rollback or before rollout cannot be reconstructed when Discord clears HasThread.
