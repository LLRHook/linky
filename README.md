# Linky

<img src="assets/linky-avatar.png" alt="Linky's smiling chain-link avatar" width="112">

[![CI](https://github.com/LLRHook/linky/actions/workflows/ci.yml/badge.svg)](https://github.com/LLRHook/linky/actions/workflows/ci.yml)
[![Deploy](https://github.com/LLRHook/linky/actions/workflows/deploy.yml/badge.svg)](https://github.com/LLRHook/linky/actions/workflows/deploy.yml)

Linky is a free, hosted Discord bot that fixes X, Instagram and TikTok previews. It reposts links with credit to the person who shared them, preserves attachments, and can translate tweets into English. Self-hosting is optional.

Visit the [Linky website](https://linky-discord.victor-n-ivanov.chatgpt.site) for setup guides and troubleshooting.

## Add to Discord

**[Add Linky to your server](https://discord.com/oauth2/authorize?client_id=1491240385031311470&permissions=277025516544&integration_type=0&scope=bot+applications.commands)**

1. Choose your server and authorize Linky.
2. An administrator with **Manage Server** permission runs `/setup enabled:True` to enable link fixing throughout the server.
3. Share an Instagram, TikTok or X link. Use `/help` to check whether Linky is enabled in the current channel.

New servers stay inactive until an admin enables them. `/setup enabled:False` disables the server again. Both commands reply privately, and setup choices survive restarts and deployments. Linky sends nothing when it joins; Discord may display its own system join notice.

Linky needs **View Channel**, **Read Message History**, **Send Messages**, **Send Messages in Threads**, **Embed Links**, **Attach Files** and **Manage Messages**. The invite requests these permissions. If a link stays unchanged, check the channel or category overrides for the **Linky** role; an `@everyone` denial can override a server-level grant. Private threads must also be accessible to the bot.

## Supported links

| Platform | Preview service | Posts |
| --- | --- | --- |
| X | `fixupx.com` | HTTPS `x.com` links; tweets can be translated |
| Instagram | `www.instagram7.com` | Posts, reels and TV links |
| TikTok | `tnktok.com` | Videos, photos and mobile share links |

Tracking query strings are removed. Surrounding text and fragments are preserved. Instagram and TikTok profiles stay untouched. Only new messages from people trigger reposting; edits, old messages, other bots and webhooks do not.

When English translation is enabled, translated tweet text replaces the original with a small source-language label. Photos, playable videos and quoted posts retain their media. Long translations continue across cards or include a text attachment. Unsupported posts and failed translations keep the native preview. Preview availability and translation quality depend on the listed services and FxEmbed.

Linky verifies the replacement before deleting the original. It preserves reply links and attachment names, descriptions and spoilers, and disables mention notifications. Missing permissions, failed copies and size limits leave the original intact. Some message types, including polls, stickers, forwards, pinned messages and thread starters, are skipped. Sending and deleting are separate Discord requests, so a failed deletion can leave both messages.

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

Linky registers `/help` and `/setup` automatically at startup. Use `/setup enabled:True` in your server. Server Members Intent is unnecessary.

| Setting | Meaning |
| --- | --- |
| `DISCORD_TOKEN` | Required bot token; keep it private |
| `LINK_CHANNEL_IDS` | Optional comma-separated exact channel IDs to enable initially |
| `LINK_SERVER_IDS` | Optional comma-separated server IDs to enable initially, including accessible threads |
| `LINK_SETTINGS_PATH` | Saved admin choices; default `data/servers.json` |
| `REWRITE_PLATFORMS` | Subset of `x,instagram,tiktok`; empty enables all three |
| `TRANSLATE_TWEETS` | `true` enables English translation; default `false` |
| `LOG_LEVEL` | Logging level; default `info` |

The optional ID lists preserve an operator's existing channel restrictions. A saved `/setup` choice takes priority for that server: enabling covers every accessible channel and thread, disabling stops all reposting there. With no saved choice or configured IDs, a server stays inactive. Exact channel scope requires each thread's own ID. DMs are excluded. Malformed settings stop startup rather than silently changing scope.

For production:

```bash
docker compose up -d --build
docker compose logs -f
```

The container runs Node.js 24 as a non-root user. The `linky-data` volume keeps server choices across updates; back it up with the server's `.env`. Keep one running instance per bot token. Restart after changing environment settings; `/setup` takes effect immediately.

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
