# Linky

<img src="assets/linky-avatar.png" alt="Linky's smiling chain-link avatar" width="112">

[![CI](https://github.com/LLRHook/linky/actions/workflows/ci.yml/badge.svg)](https://github.com/LLRHook/linky/actions/workflows/ci.yml)
[![Deploy](https://github.com/LLRHook/linky/actions/workflows/deploy.yml/badge.svg)](https://github.com/LLRHook/linky/actions/workflows/deploy.yml)

Linky fixes social links in Discord: X/Twitter, Instagram, TikTok, YouTube, Bluesky, Reddit and Twitch clips. Add it to your server for automatic previews or to your account for links you choose to fix. The hosted bot is free; you do not need to run a server or supply API keys. Self-hosting is optional.

Visit the [Linky website](https://linkybot.dev) for setup guides and troubleshooting.

## Add to Discord

**[Add Linky to your server](https://discord.com/oauth2/authorize?client_id=1491240385031311470&permissions=277025516544&integration_type=0&scope=bot+applications.commands)**

**[Add Linky to your account](https://discord.com/oauth2/authorize?client_id=1491240385031311470&integration_type=1&scope=applications.commands)** to use `/fix link:` and a message's **Apps → Fix with Linky** action in servers or DMs. Each request handles up to three supported links, keeps the source message and uses native YouTube previews without API statistics. Personal installation does not watch your DMs or enable automatic fixing in servers.

You must be the server owner or have **Administrator** or **Manage Server** permission in that server to enable Linky.

1. Choose your server and authorize Linky.
2. Open a text channel in that server, type `/setup`, select **Linky's `/setup` command** from the command picker and send it.
3. The private setup card shows whether Linky is active in this channel. Choose your posting mode, platforms and channels, then select **Enable server**. Menu selections save automatically.
4. Send a fresh supported link in a selected channel. If the preview does not appear, run `/diagnose link:` there to check permissions, settings, URL support and recent provider observations.

If Linky's `/setup` command is missing from the picker, follow the [setup troubleshooting guide](https://linkybot.dev/setup).

New servers stay inactive until an admin enables them. Changing preferences alone never enables a server. Choose specific channels or **All channels**; selected parent channels include their accessible threads. **Disable server** stops automatic processing. `/setup enabled:true` and `/setup enabled:false` also work and preserve channel selections. Setup, settings, help and diagnostics are private; saved choices survive restarts. Linky sends nothing when it joins. Discord may display its own system join notice.

The default Replace mode uses **View Channel**, **Read Message History**, **Send Messages**, **Send Messages in Threads**, **Embed Links**, **Attach Files** and **Manage Messages**. The invite requests these permissions. Reply mode does not require **Manage Messages** or copy the original attachments. If a link stays unchanged, check channel/category overrides for the **Linky** role. Private threads must also be accessible to the bot.

## Server preferences

With **Manage Server** permission, run `/settings` without options to see the effective configuration. Use `/settings mode:reply` to keep original messages and add replies, or `/settings mode:replace` to restore the default. Replace mode credits the author and preserves attachments before removing the original.

Each platform has a `/settings` switch, such as `/settings instagram:false`. `translate_tweets` controls English translation. `youtube_display` selects **preview**, **counts**, or **counts-and-comment**. Preview-only leaves native YouTube messages untouched and makes no API calls; counts skips comment requests. Existing servers retain Replace mode and counts plus comment until an admin changes them. A server cannot enable an operator-disabled feature.

Put `!nolinky` in a message to skip automatic fixing. Links inside `<angle brackets>`, code or spoilers are also left alone. Reposts include **Original post** links. Only the original author or a moderator with Manage Messages can use **Remove** or **Retry preview**; manual previews can be removed by their requester or a moderator. Replies follow edits and deletions of their source while their ownership record is retained (up to 30 days).

## Supported links

| Platform | Preview service | Posts |
| --- | --- | --- |
| X/Twitter | `fixupx.com`, with `vxtwitter.com` recovery | Post URLs on X and Twitter, including `/i/web/status/` and media paths |
| Instagram | `www.instagram7.com` | Posts, reels and TV links |
| TikTok | `tnktok.com` | Videos, photos and mobile share links |
| YouTube | Native YouTube preview and optional YouTube Data API | HTTPS watch, `youtu.be`, Shorts, live and embed links; valid start timestamps retained |
| Bluesky | `bskx.app`, with `fxbsky.app` recovery | Public `/profile/actor/post/id` URLs |
| Reddit | `vxreddit.com` | Public post URLs; profile and community index pages stay unchanged |
| Twitch clips | `fxtwitch.seria.moe` | Clip URLs, including channel `/clip/` links; streams and VODs stay unchanged |

Supported links must use HTTPS and point to posts. Tracking query strings are removed; valid YouTube start timestamps and surrounding text are retained. Automatic fixing starts with new messages from people; editing an unrelated old message does not start a repost. Bots and webhooks are ignored.

When English translation is enabled, translated tweet text replaces the original with a small source-language label. Photos, playable videos and quoted posts retain their media. Long translations continue across cards or include a text attachment. Unsupported posts and failed translations keep the native preview. Preview availability and translation quality depend on the listed services and FxEmbed.

When enabled, YouTube keeps one native video message with compact counts on buttons. Click counts for exact values or **Top comment** for a private, attributed excerpt selected by YouTube's relevance order. Missing fields are omitted; comment failure can still leave counts available. A missing API key or failed video lookup leaves the native YouTube message untouched. YouTube buttons expire after 24 hours; cleanup is retried across restarts while preserving the video, source text and other controls.

Before removing an original, Linky waits for a useful preview tied to each rewritten post, checks attachments, and rechecks the source and settings. Known videos require video metadata; translated text delivered as a caption does not need a separate native embed. Failed previews try an alternate provider when available. If that fails, the original stays with a **Retry preview** notice; retrying posts a reply and keeps the source. Manual fixes check previews and try alternates in the same response. Instagram, TikTok, Reddit and Twitch currently have no verified alternate provider. Preview metadata cannot guarantee playback in every Discord client.

Attachment names, descriptions, spoilers and reply context are preserved. Replies name the original author and show a short excerpt in small italic text. Replies to Linky reposts name the person who shared that post and quote its content. Link-only messages use their existing preview text when available. Excerpts hide spoilers and omit link targets; messages that cannot be read in the same channel show "Original message unavailable." Missing permissions, failed copies and size limits leave the original intact. Polls, stickers, forwards, pinned messages and thread starters are skipped. A failed source deletion can leave both messages. Reply mode keeps the source and its attachments. Both modes suppress mention notifications.

## Self-host

Requires Node.js 22+ and npm, or Docker Compose on Linux. Create an application in the [Discord developer portal](https://discord.com/developers/applications), enable **Message Content Intent**, and put its bot token in `.env`. Enable both **Guild Install** and **User Install** in Installation settings. User installation needs only `applications.commands`; guild installation also needs `bot` and the permissions listed above. The invite links in this README add the hosted Linky, not your self-hosted instance.

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
| `REWRITE_PLATFORMS` | Subset of `x,instagram,tiktok,youtube,bluesky,reddit,twitch`; empty enables available platforms, with automatic YouTube statistics requiring its API key |
| `TRANSLATE_TWEETS` | `true` enables English translation; default `false` |
| `YOUTUBE_API_KEY` | Optional operator key for YouTube Data API v3; absent means YouTube is left untouched |
| `LOG_LEVEL` | Logging level; default `info` |

The optional ID lists preserve operator channel restrictions. Saved server enablement takes priority, then selected channel preferences narrow that scope. With no saved choice or configured IDs, a server stays inactive. Legacy exact-channel scope still requires each thread's own ID. DMs have no automatic processing. Malformed settings stop startup rather than silently changing scope.

For YouTube, the operator enables [YouTube Data API v3](https://developers.google.com/youtube/v3/getting-started), sets `YOUTUBE_API_KEY`, and [restricts it](https://docs.cloud.google.com/api-keys/docs/add-restrictions-api-keys) to that API and the host's outbound IP. Hosted-bot users do not need a key. API results have a five-minute memory cache shared by posting and button requests. Keep `data/youtube-stats.json` available for expiry cleanup; it stores message/channel/video IDs and expiry metadata, with character lengths for legacy messages, not counts or comments.

`data/reposts.json` stores source/repost/author/channel/server IDs, posting mode and pending cleanup IDs. It contains no chat text. Ownership lasts up to 30 days, with a 10,000-record cap; pending cleanup is retained for retry. Recent provider observations are process-local and contain no message content or server IDs.

For production:

```bash
docker compose up -d --build
docker compose logs -f
```

The container runs Node.js 24 as a non-root user. Back up the `linky-data` volume and server's `.env`. Keep one running instance per bot token. Restart after changing environment settings; `/setup` and `/settings` take effect immediately.

This version reads both legacy `{ "serverId": true }` settings and records with optional enablement and preferences. Once preferences are saved, older images cannot read those records. Keep a compatible settings backup before upgrading; a rollback to an older image also needs its compatible settings file. Restoring an image alone does not migrate the data volume.

## Development and deployment

```bash
npm test             # strict typecheck and isolated tests; no token needed
npm run build        # production TypeScript
bash tests/deploy.test.sh
```

CI tests Node.js 22 and 24, deployment safeguards, and the production container. See [CONTRIBUTING.md](CONTRIBUTING.md) for live preview checks.

The hosted bot deploys after CI passes for a push to `main`. Deployment accepts only the current tested commit, builds before replacing the bot, and checks its Discord connection. Failed startup restores the previous image and deployed Compose configuration. The server's `.env` and data volume are preserved.

Operators use `/root/linky`, configure `LINKY_DEPLOY_HOST`, `LINKY_SSH_KEY` and `LINKY_SSH_KNOWN_HOSTS`, and install `ops/ssh-deploy.sh` as `/usr/local/sbin/linky-deploy` with a restricted SSH key and pinned host key. After the first successful manual deployment, run `git rev-parse HEAD > .git/linky-deployed-revision` to initialize the rollback marker. Connection establishment retries automatically; for a failed deployment, inspect its logs and rerun the failed Deploy job. Disable Deploy in GitHub Actions to pause updates.

[MIT license](LICENSE).
