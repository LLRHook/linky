# Linky

<img src="assets/linky-avatar.png" alt="Linky's smiling chain-link avatar" width="128">

[![CI](https://github.com/LLRHook/wanna-bet/actions/workflows/ci.yml/badge.svg)](https://github.com/LLRHook/wanna-bet/actions/workflows/ci.yml)

Linky fixes X, Instagram and TikTok previews in selected Discord channels. It reposts links with credit to the person who shared them, preserves their attachments, and can translate tweets into English. It joins servers silently. `/help` replies privately.

**[Add Linky to your server](https://discord.com/oauth2/authorize?client_id=1491240385031311470&permissions=2147609600&integration_type=0&scope=bot+applications.commands)**. The operator must add your channel IDs to enable reposting.

## What it does

| Platform | Preview service | Supported links |
| --- | --- | --- |
| X | `fixupx.com` | HTTPS `x.com` links; status links can be translated |
| Instagram | `kkclip.com` | `/p/`, `/reel/`, `/reels/`, `/tv/`; apex, `www.`, `m.`, `mobile.` |
| TikTok | `tnktok.com` | `/@user/video/`, `/@user/photo/`, `/t/`; apex, `www.`, `m.`; share codes on `vm.` and `vt.` |

Share/tracking query strings are removed. Paths, fragments and surrounding text are retained, and accepted subdomains are dropped. Instagram/TikTok profiles and unsupported paths stay untouched. HTTP, other subdomains, lookalike hosts, explicit ports and nested URLs inside other URLs are excluded. Existing messages, edits, bots and webhooks do not trigger reposting.

With `TRANSLATE_TWEETS=true`, text/photo tweets use English cards with a small source-language footer. Videos keep a playable media preview and English caption. Quoted posts retain their own text, attribution and media. Long text spans cards where possible; content beyond Discord's limits includes the full translation as a text attachment. Original-language tweet text is replaced when a translation is available.

Translations come from FxEmbed, with one request per distinct tweet and a five-second timeout. English text stays as written. Missing translations, malformed quotes, polls, broadcasts, external media and quote chains deeper than three posts fall back to the native preview. Suppressed previews, code and spoiler links skip translation. Translation quality and preview-service availability depend on those providers.

## Configure and run

Requires Node.js 20+ and npm, or Docker Compose on Linux. Create an application in the [Discord developer portal](https://discord.com/developers/applications), enable **Message Content Intent**, and put its bot token in `.env`.

```bash
git clone https://github.com/LLRHook/wanna-bet.git
cd wanna-bet
npm ci
cp .env.example .env
# Set DISCORD_TOKEN and LINK_CHANNEL_IDS in .env.
npm run register-commands
npm run dev
```

| Setting | Meaning |
| --- | --- |
| `DISCORD_TOKEN` | Required bot token; keep it private |
| `LINK_CHANNEL_IDS` | Comma-separated exact channel IDs; empty disables reposting |
| `REWRITE_PLATFORMS` | Subset of `x,instagram,tiktok`; empty enables all three |
| `TRANSLATE_TWEETS` | `true` enables English translation; default `false` |
| `LOG_LEVEL` | Optional logging level; default `info` |

Use Developer Mode > Copy Channel ID in Discord. Channels can span servers; threads need their own IDs, and DMs are excluded. Invalid IDs, empty list entries and unknown platform names stop startup. For existing installations, when `LINK_CHANNEL_IDS` is absent, `FIXUPX_CHANNEL_IDS` and `FIXUPX_CHANNEL_ID` are combined and deduplicated. Setting `LINK_CHANNEL_IDS` explicitly overrides both legacy settings. Restart after configuration changes.

In each configured channel, grant **View Channel**, **Read Message History**, **Manage Messages**, **Embed Links**, and **Send Messages** (or **Send Messages in Threads**). **Attach Files** is needed to copy files or attach long translations. The invite above requests these permissions; channel overrides still apply. Server Members Intent is unnecessary.

For production:

```bash
docker compose up -d --build
docker compose exec wannabet node dist/commands/register.js
docker compose logs -f
```

Registration replaces the global command list with `/help`, removing the retired gambling commands. Linky has no gambling features or runtime database. The repository URL, Compose service `wannabet`, deployment identifiers and existing data-volume name are retained for upgrade compatibility. Legacy data remains mounted read-only for rollback; existing backups are retained.

## Repost safeguards

Linky sends and checks the replacement, reads the source again, then deletes it only if unchanged. It retains reply links, suppressed embeds, and attachment names, descriptions and spoilers. Mention notifications are disabled. Plain leading context is quoted beneath **Shared by @author**; complex Markdown keeps its original structure.

Missing permissions, failed copies and size limits leave the source intact. Limits are 2,000 message characters including credit, 10 files and 25 MiB total files. English cards obey Discord's per-card and combined limits. Polls, stickers, components, forwards, voice messages, ephemeral attachments, pinned messages, thread starters and crossposts are skipped. Discord sends and deletes are separate requests: a failed final deletion may leave both messages, and an edit after the final check can still race deletion.

## Updates and development

The public bot deploys automatically after CI passes for a push to `main`. The [Deploy workflow](https://github.com/LLRHook/wanna-bet/actions/workflows/deploy.yml) sends the tested commit to the VPS. Deployments are serialized and accept only current `main`. Builds run before replacing the bot; failed startup restores the previous image and deployed Compose configuration. The transition from a writable legacy database requires a final backup; later deployments leave read-only legacy data untouched. The server's `.env` is preserved.

Operators configure `WANNA_BET_DEPLOY_HOST`, `WANNA_BET_SSH_KEY` and `WANNA_BET_SSH_KNOWN_HOSTS`, install `ops/ssh-deploy.sh` as `/usr/local/sbin/wanna-bet-deploy`, restrict the SSH key to that command, and pin the host key. After the first manual deployment connects successfully, record its checked-out commit with `git rev-parse HEAD > .git/wanna-bet-deployed-revision`; subsequent deployments maintain this rollback marker. To retry, rerun CI for current `main`; to pause updates, disable Deploy in GitHub Actions.

```bash
npm test             # strict typecheck and isolated tests; no token needed
npm run build        # production TypeScript
bash tests/deploy.test.sh
```

`bot.ts` wires Discord events and private help. `SocialLinkService` owns URL rewriting and safe reposts. `TweetTranslation` validates provider responses; `TweetPresentation` fits English text and media into Discord messages. CI tests Node 20 and 22 plus deployment failure/rollback scenarios. See [CONTRIBUTING.md](CONTRIBUTING.md).

[MIT license](LICENSE).
