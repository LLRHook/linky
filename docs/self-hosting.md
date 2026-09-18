# Self-hosting and operations

The public hosted bot runs on Hostinger; the website uses Vercel. It provides X/Twitter, Instagram, TikTok, YouTube, Bluesky, Reddit and Twitch clip previews, with available tweet and Instagram caption translation and YouTube extras. Members need no keys or hosting. Erome is self-host-only for public users: use your own bot application, server, storage and any media workers. The optional coding integration is disabled on the public bot. Operator settings do not bypass a server administrator's channel choices.

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
| `REWRITE_PLATFORMS` | Subset of `x,instagram,tiktok,youtube,bluesky,reddit,twitch,erome`; empty enables available platforms, with automatic YouTube statistics requiring its API key and Erome following the server's channel policy |
| `TRANSLATE_TWEETS` | `true` enables English translation; default `false` |
| `TRANSLATE_INSTAGRAM` | `true` enables English Instagram captions when the translation key is available; default `false` |
| `GOOGLE_TRANSLATE_API_KEY` | Optional dedicated Cloud Translation Basic v2 key; independent of the YouTube key |
| `YOUTUBE_API_KEY` | Optional operator key for YouTube Data API v3; absent leaves native videos untouched; public community text/image posts need no key |
| `EROME_MEDIA_ENABLED` | Enables optional regional original-video delivery after hosting is configured; default `false` |
| `EROME_WORKER_KEY`, `EROME_WORKER_BASE_URL` | Shared worker HMAC secret and the dedicated Vercel worker project's HTTPS origin |
| `EROME_MEDIA_BASE_URL` | Public HTTPS media origin, without a path, query or credentials |
| `EROME_MEDIA_PATH`, `EROME_MEDIA_PORT` | Persistent media directory and listener port; `.env.example` uses `data/media` and `8092` |
| `LOG_LEVEL` | Logging level; default `info` |
| `PROMPT_ENABLED` | Explicitly enables the optional coding integration after worker setup; default `false` |
| `PROMPT_GUILD_IDS` | Separate operator list of servers whose Administrators may request code changes |
| `PROMPT_GITHUB_TOKEN` | Repository-scoped Actions dispatch/read credential; never the publishing credential |

The optional ID lists preserve operator channel restrictions. Saved server enablement takes priority, then selected channel preferences narrow that scope. With no saved choice or configured IDs, a server stays inactive. Legacy exact-channel scope still requires each thread's own ID. DMs have no automatic processing. Malformed settings stop startup rather than silently changing scope.

For YouTube, the operator enables [YouTube Data API v3](https://developers.google.com/youtube/v3/getting-started), sets `YOUTUBE_API_KEY`, and [restricts it](https://docs.cloud.google.com/api-keys/docs/add-restrictions-api-keys) to that API and the host's outbound IP. Hosted-bot users do not need a key. API results have a five-minute memory cache shared by posting and button requests. Keep `data/youtube-stats.json` available for expiry cleanup; it stores message/channel/video IDs and expiry metadata, with character lengths for legacy messages, not counts or comments.

For Instagram captions, complete [Google's Cloud Translation setup](https://docs.cloud.google.com/translate/docs/setup), including linking a billing account, then enable Cloud Translation. Create a separate API key restricted to that service and the host's outbound IP. Set the service's daily character quota to **15,000**, put the key in `GOOGLE_TRANSLATE_API_KEY`, and set `TRANSLATE_INSTAGRAM=true`. Restart and complete the [Instagram live checks](instagram-translation.md) before announcing availability. Hosted-bot server admins do not supply keys.

Google currently includes the first **500,000 characters/month** for standard translation, then charges **$20 per million characters**. Its credit is shared by Basic and Advanced translation. Linky also enforces a durable **15,000 characters/day** limit, resetting at midnight Pacific; one instance can admit at most 465,000 characters in a 31-day month. Preserve `data/translation-usage.json` in the data volume and keep the Cloud quota as a separate guard. Other usage, changing prices, extra instances or deleting the journal can invalidate that allowance calculation. A failed budget write disables that request; malformed saved usage disables caption translation until repaired. [Pricing](https://cloud.google.com/products/translate/pricing), [quotas](https://docs.cloud.google.com/translate/quotas).

Instagram caption lookup sends the public post shortcode to Instagram7. Translation sends caption text to Google, without the surrounding Discord message or Discord account/server IDs. Results use bounded five-minute memory caches. The usage journal stores only a date and character count; it contains no captions. English captions posted to Discord follow Discord's message retention. Update the hosted privacy notice before enabling this optional data flow.

`data/personal-preferences.json` stores only opted-out server/account ID pairs, with a 1 MiB and 10,000-record limit. Re-enabling your automatic fixes removes your pair. Removing the bot clears that server on departure or the next successful startup; operator backups need separate deletion. Writes are atomic and owner-only on POSIX. Invalid storage stops startup rather than silently forgetting choices. Retain this file across upgrades; versions predating `/autofix` do not honor it.

Public YouTube community lookups fetch only an allowed first-party `/post/` page with pinned public DNS, no redirects or cookies, a five-second default deadline and a 2 MiB response limit. Their bounded memory cache may reuse successful post metadata for up to one minute and failed lookups for 15 seconds. Expired entries are removed on later lookups, eviction, or restart; these reuse limits do not guarantee physical removal while the process is idle. Mobile share resolution similarly uses strict platform destinations and bounded requests. Neither lookup sends Discord IDs or surrounding message text.

`data/reposts.json` stores source/repost/author/channel/server IDs, posting mode and pending cleanup IDs. It contains no chat text. Ownership lasts up to 30 days, with a 10,000-record cap; pending cleanup is retained for retry. Recent provider observations are process-local and contain no message content or server IDs.

Erome processing requests the selected public album and its chosen media, without sending Discord message text or account/server IDs. Temporary files are removed after preparation; Docker keeps them in a bounded memory-backed mount. The attachment cache holds at most 32 variants for five minutes and 128 MiB total. Optional hosting retains registered originals and their message references, up to 10 GiB and 4,096 files. Public random-ID media URLs work while their asset is retained. Removing the final bound preview releases its asset; unbound publishes expire after 15 minutes.

New local state includes `data/delivery-diagnostics.json` (seven days, 4,096 attempts, 4 MiB) and the private `erome-reuse` sibling of the media directory (seven days since use, 1,024 entries, 2 MiB). Diagnostics contain finite codes/timings and ownership IDs, not URLs or chat text; the reuse index contains hashed source validators and asset descriptors. Album controls keep bounded session state in memory for up to 24 hours and expire on restart. See [delivery reliability and retention](delivery-reliability.md) for exact lifecycle and failure behavior, including shared work, fair scheduling and private Details. These records do not activate the website analytics collector.

The media store supports legacy MP4 records plus new MIME-aware MP4/JPEG/PNG records. Keep compatible data backups before upgrading; old MP4-only images cannot safely read the new image records. See [Erome limits](erome-previews.md) and the [regional hosting guide](erome-regional-hosting.md).

For production:

```bash
docker compose up -d --build
docker compose logs -f
```

The container runs Node.js 24 as a non-root user on Debian 13, with a read-only root filesystem, no Linux capabilities and no privilege escalation. Writable state belongs in `/app/data`; preparation uses the bounded `/tmp` mount. npm and other package managers are only available during the image build. Back up the `linky-data` volume and server's `.env`. Keep one running instance per bot token. Restart after changing environment settings; `/setup` and `/settings` take effect immediately.

This version reads both legacy `{ "serverId": true }` settings and records with optional enablement and preferences. Once preferences are saved, older images cannot read those records. Keep a compatible settings backup before upgrading; a rollback to an older image also needs its compatible settings file. Restoring an image alone does not migrate the data volume.

## Checks and deployment

```bash
npm test             # strict typecheck and isolated tests; no token needed
npm run build        # production TypeScript
npm run check:workers # regional worker entrypoints
bash tests/deploy.test.sh
```

CI tests Node.js 22 and 24, deployment safeguards, and the production container. See [contribution guide](../CONTRIBUTING.md) for live preview checks.

The hosted bot deploys after CI passes for a push to `main`. Deployment accepts only the current tested commit, builds before replacing the bot, and checks its Discord connection. Failed startup restores the previous image and deployed Compose configuration. The server's `.env` and data volume are preserved.

Operators use `/root/linky`, configure `LINKY_DEPLOY_HOST`, `LINKY_SSH_KEY` and `LINKY_SSH_KNOWN_HOSTS`, and install `ops/ssh-deploy.sh` as `/usr/local/sbin/linky-deploy` with a restricted SSH key and pinned host key. After the first successful manual deployment, run `git rev-parse HEAD > .git/linky-deployed-revision` to initialize the rollback marker. Connection establishment retries automatically; for a failed deployment, inspect its logs and rerun the failed Deploy job. Disable Deploy in GitHub Actions to pause updates.

[MIT license](../LICENSE).

## Delivery archive and weekly reports

The bot also writes a separate, bounded operator archive alongside its persistent settings. It defaults to 30 days; `DELIVERY_LOG_RETENTION_DAYS` accepts 1–90 days. The 64 MiB storage cap can expire older data sooner. The archive contains only sanitized delivery measurements and random attempt IDs, not Discord identities or message content. Discord Details keeps its own seven-day retention and permissions. See [operator reliability](operator-reliability.md) for reporting, coverage checks and backups.

## Operational logs

The current error serializer keeps a bounded set of error names, numeric API/status codes, known system codes and HTTP methods. It excludes arbitrary error messages, stacks, request bodies, URLs and uploaded bytes. Operational events can still contain Discord identifiers needed to trace delivery and cleanup. Earlier releases could include request content in error logs; historical copies and backups need separate retention handling. The Compose configuration rotates each container's JSON logs at 10 MiB with three files; this is a size limit, not a time-based deletion guarantee. See the [public privacy notice](https://linkybot.dev/privacy) for current data flows.
