# Linky

<img src="assets/linky-avatar.png" alt="Linky's smiling chain-link avatar" width="112">

[![CI](https://github.com/LLRHook/linky/actions/workflows/ci.yml/badge.svg)](https://github.com/LLRHook/linky/actions/workflows/ci.yml)
[![Deploy](https://github.com/LLRHook/linky/actions/workflows/deploy.yml/badge.svg)](https://github.com/LLRHook/linky/actions/workflows/deploy.yml)

Linky is a free, hosted Discord bot that fixes X, Instagram and TikTok previews, can translate tweets into English, and optionally adds YouTube counts and a top comment. Server admins choose whether it replaces messages or replies while keeping the originals. Self-hosting is optional.

Visit the [Linky website](https://linkybot.dev) for setup guides and troubleshooting.

## Add to Discord

**[Add Linky to your server](https://discord.com/oauth2/authorize?client_id=1491240385031311470&permissions=277025516544&integration_type=0&scope=bot+applications.commands)**

You must be the server owner or have **Administrator** or **Manage Server** permission in that server to enable Linky.

1. Choose your server and authorize Linky.
2. In Discord, open a text channel in the server you just added Linky to.
3. Type `/setup` in the message box, then select **Linky's `/setup` command** from the command picker.
4. Choose **True** for the **enabled** option, then press **Enter** or tap **Send** to run the command.
5. Wait for Linky's private confirmation that it is enabled, then send a fresh Instagram, TikTok or X link in that channel. Use `/help` to check whether Linky is enabled in the current channel.

If Linky's `/setup` command is missing from the picker, follow the [setup troubleshooting guide](https://linkybot.dev/setup).

Run setup once per server. It enables link fixing in all channels and threads where Linky has the required permissions, including new ones. New servers stay inactive until an authorized person enables them. Choosing **False** for **enabled** disables the server again. `/setup`, `/settings` and `/help` replies are private, and saved choices survive restarts and deployments. Linky sends nothing when it joins; Discord may display its own system join notice.

The default Replace mode uses **View Channel**, **Read Message History**, **Send Messages**, **Send Messages in Threads**, **Embed Links**, **Attach Files** and **Manage Messages**. The invite requests these permissions. Reply mode does not require **Manage Messages** or copy the original attachments. If a link stays unchanged, check channel/category overrides for the **Linky** role. Private threads must also be accessible to the bot.

## Server preferences

With **Manage Server** permission, run `/settings` without options to see the effective configuration. Use `/settings mode:reply` to keep original messages and add replies, or `/settings mode:replace` to restore the default. Replace mode credits the author and preserves attachments before removing the original.

The optional `instagram`, `tiktok`, `x` and `youtube` switches control each platform; for example, `/settings youtube:false` disables YouTube for this server. `translate_tweets` controls English tweet translation. A server cannot enable a feature disabled by the bot operator. Preferences apply immediately but never enable a server or change its channel scope; `/setup` remains the enable/disable command. Existing servers keep their defaults until an admin changes them.

## Supported links

| Platform | Preview service | Posts |
| --- | --- | --- |
| X | `fixupx.com` | HTTPS `x.com` links; tweets can be translated |
| Instagram | `www.instagram7.com` | Posts, reels and TV links |
| TikTok | `tnktok.com` | Videos, photos and mobile share links |
| YouTube | Native YouTube preview and optional YouTube Data API | HTTPS watch, `youtu.be`, Shorts, live and embed links; valid start timestamps retained |

Tracking query strings are removed; valid YouTube start timestamps are retained. Surrounding text is preserved. Instagram and TikTok profiles stay untouched. Only new messages from people trigger processing; edits, old messages, other bots and webhooks do not.

When English translation is enabled, translated tweet text replaces the original with a small source-language label. Photos, playable videos and quoted posts retain their media. Long translations continue across cards or include a text attachment. Unsupported posts and failed translations keep the native preview. Preview availability and translation quality depend on the listed services and FxEmbed.

When the operator enables YouTube, Linky keeps the native video preview and sends a compact details card underneath it. Views, likes and comments have separate labeled counts; a shortened top comment appears below them, with its author on a separate line. YouTube selects the comment by relevance. Playback depends on Discord and YouTube. Unavailable counts or comments are omitted, and a failed comment request can still leave the counts visible. A missing API key or failed video lookup leaves YouTube untouched. The details card is sent without a second push notification and is scheduled for removal after 24 hours, leaving the video link and message body. Failed cleanup is retried, including after restarts.

In Replace mode, Linky verifies the replacement before deleting the original. It preserves reply links and attachment names, descriptions and spoilers. Missing permissions, failed copies and size limits leave the original intact. Some message types, including polls, stickers, forwards, pinned messages and thread starters, are skipped. A failed deletion can leave both messages. Reply mode keeps the original and its attachments. Both modes disable mention notifications.

## Self-host

Requires Node.js 22+ and npm, or Docker Compose on Linux. Create an application in the [Discord developer portal](https://discord.com/developers/applications), enable **Message Content Intent**, and put its bot token in `.env`. The invite above adds the hosted Linky; for your own application, create a server-install link with the `bot` and `applications.commands` scopes and the permissions listed above.

```bash
git clone https://github.com/LLRHook/linky.git
cd linky
npm ci
cp .env.example .env
# Set DISCORD_TOKEN in .env.
npm run dev
```

Linky registers `/help`, `/setup` and `/settings` automatically at startup. Use `/setup enabled:True` in your server. Server Members Intent is unnecessary.

| Setting | Meaning |
| --- | --- |
| `DISCORD_TOKEN` | Required bot token; keep it private |
| `LINK_CHANNEL_IDS` | Optional comma-separated exact channel IDs to enable initially |
| `LINK_SERVER_IDS` | Optional comma-separated server IDs to enable initially, including accessible threads |
| `LINK_SETTINGS_PATH` | Saved enablement and preferences; default `data/servers.json` |
| `REWRITE_PLATFORMS` | Subset of `x,instagram,tiktok,youtube`; empty enables available platforms, with YouTube requiring its API key |
| `TRANSLATE_TWEETS` | `true` enables English translation; default `false` |
| `YOUTUBE_API_KEY` | Optional operator key for YouTube Data API v3; absent means YouTube is left untouched |
| `LOG_LEVEL` | Logging level; default `info` |

The optional ID lists preserve an operator's existing channel restrictions. A saved `/setup` choice takes priority for that server: enabling covers every accessible channel and thread, disabling stops all reposting there. With no saved choice or configured IDs, a server stays inactive. Exact channel scope requires each thread's own ID. DMs are excluded. Malformed settings stop startup rather than silently changing scope.

For YouTube, the bot operator enables [YouTube Data API v3](https://developers.google.com/youtube/v3/getting-started) in a Google Cloud project and sets `YOUTUBE_API_KEY` in the bot's `.env`. [Restrict the key](https://docs.cloud.google.com/api-keys/docs/add-restrictions-api-keys) to that API and the host's outbound IP address. Server owners using the hosted bot do not need a key. API results are cached in memory for five minutes. The durable cleanup queue, `data/youtube-stats.json`, stores channel/message IDs, expiry times and a card marker. Older records also contain character lengths so their original text additions can still be removed. It stores no chat text, counts or comments; keep its volume available so expired details can be removed.

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
