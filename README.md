# Wanna Bet Bot

[![CI](https://github.com/llrhook/wanna-bet/actions/workflows/ci.yml/badge.svg)](https://github.com/llrhook/wanna-bet/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Discord gambling-economy bot. Per-guild virtual currency, two-sided bet pools with escrow, an elected admin who can grant/seize/force-resolve, and a daily inflation tap. TypeScript + discord.js v14 + SQLite.

> **[➤ Add Wanna Bet Bot to your Discord server](https://discord.com/oauth2/authorize?client_id=1491240385031311470&permissions=2147568640&integration_type=0&scope=bot+applications.commands)**
> No setup, no hosting, no `.env` — click, pick a server, authorize, then run `/help`.

The Quickstart below is for **self-hosting** your own copy of the bot. The invite above enables the public bot's slash commands. X link replacement also needs the channel configuration and permissions described below; the public bot's operator manages its channel configuration.

## Quickstart

### 1. Create the bot in Discord

1. https://discord.com/developers/applications → New Application → Bot tab → Add Bot
2. Enable **SERVER MEMBERS INTENT** (required)
3. OAuth2 → URL Generator → scopes: `bot` + `applications.commands`, permissions: View Channel, Send Messages, Embed Links, Read Message History
4. Visit the generated URL, add the bot to your server
5. Copy the bot token

### 2. Run it locally

```bash
git clone https://github.com/llrhook/wanna-bet.git
cd wanna-bet
npm install
cp .env.example .env        # paste your DISCORD_TOKEN
npm run db:migrate          # creates data/wanna-bet.db
npm run register-commands   # one-time, registers slash commands
npm run dev                 # tsx watch — auto-reloads on save
```

> ⚠️ On macOS, **don't use Docker for local dev**. Docker Desktop's network layer adds multi-second latency to Discord's gateway and breaks interaction acks. Run natively as above. Docker on Linux is fine.

### 3. Deploy to a VPS (Docker)

```bash
git clone https://github.com/llrhook/wanna-bet.git
cd wanna-bet
cp .env.example .env && nano .env
docker compose up -d --build
docker compose run --rm wannabet node dist/commands/register.js
```

`docker compose down` stops it (data preserved in named volume), `docker compose logs -f` tails logs.

### Optional: replace X links in selected channels

Set `FIXUPX_CHANNEL_IDS` in `.env` to a comma-separated list of exact Discord channel IDs where the bot should replace links. Channels may belong to different servers where the bot is installed. Enable Developer Mode in Discord, then right-click each channel and choose **Copy Channel ID**. Only the listed channels are included; other channels, DMs and child threads are excluded. To use a thread, include that thread's own ID.

The existing `FIXUPX_CHANNEL_ID` setting remains supported. If both settings are present, their channel IDs are combined and duplicates are removed. Leave both settings empty or unset to disable this feature. Malformed IDs or empty entries within a comma-separated list stop startup; a trailing comma is invalid.

Before starting the bot with this setting:

1. In the [Discord developer portal](https://discord.com/developers/applications), open your application, select **Bot**, and enable **Message Content Intent**. Keep the existing **Server Members Intent** enabled. Apps that require approval for privileged intents must obtain it first.
2. Grant the bot **View Channel**, **Embed Links**, **Read Message History**, and **Manage Messages** in every configured channel. Text channels also need **Send Messages**; configured threads need **Send Messages in Threads**. Grant **Attach Files** to copy attachments; without it, messages containing attachments stay untouched. Check channel permission overrides as well as the bot's role in each server. The existing invite link does not grant all of these additional permissions.
3. Set `FIXUPX_CHANNEL_IDS=first_channel_id,second_channel_id` alongside your existing token, then build and restart the bot through your normal deployment process. A single ID is also valid. Slash commands do not need to be registered again.

Reauthorizing the same bot in the same server preserves balances and bets as long as the existing SQLite database is kept. Updating Discord permissions does not reset the bot's economy data.

For each new human message, the bot changes literal `https://x.com` links to `https://fixupx.com`, preserving paths, query strings, fragments and surrounding text. Host matching is case-insensitive. Subdomains, credentials, explicit ports, HTTP links and lookalike domains are left alone. Existing messages and edits do not trigger replacement.

The bot posts quoted, bold `Shared by @author` credit. Plain leading context is quoted beneath it, followed by the first URL and all remaining text in their original order. A single space between inline context and its URL becomes a line break. If quoting could alter Markdown, link wrappers, code, lists, indentation, trailing whitespace or blank lines, the full rewritten body stays unchanged beneath the quoted credit. The bot keeps reply context as a link in the credit and disables all mention notifications, including `@everyone`, role mentions and the author credit. Attachments are downloaded and checked before upload; filenames, descriptions and spoiler markings are retained. Native previews are generated from the rewritten links, while an author's suppressed-embed setting and existing URL formatting are respected.

The original is deleted only after the repost succeeds, every attachment is present in Discord's response, and a fresh read confirms the source content and relevant settings have not changed. Missing permissions, failed downloads/uploads, or content that will not fit leave the original in place. Copying is limited to 2,000 characters including attribution and quote formatting, 10 attachments and 25 MiB of attachments in total. The bot skips voice messages, crossposts, pinned messages, messages with attached threads, and messages containing polls, stickers, components, forwarded snapshots or ephemeral attachments.

Discord sends and deletes are separate requests. If deletion or the final read fails, both messages may remain; check the logs for the source message ID. If the author edits the original during copying, the bot keeps it and attempts to remove its stale repost. If Discord confirms the original was deleted during copying, the bot attempts to remove the repost too. An edit arriving after the final check can still race deletion. Bot and webhook messages are ignored to prevent repost loops.

To disable replacement, clear both `FIXUPX_CHANNEL_IDS` and `FIXUPX_CHANNEL_ID` and restart. When disabled, the bot does not request the additional Guild Messages or Message Content gateway intents. The underlying requirements are documented in Discord's [gateway intent reference](https://docs.discord.com/developers/events/gateway) and [channel permission reference](https://docs.discord.com/developers/topics/permissions).

## Commands

| Command | What it does |
|---|---|
| `/register` | Join the economy. New players start with $100. |
| `/unregister` | Leave the economy. Balance preserved for re-registration. |
| `/balance` | Your wallet balance. |
| `/daily` | Claim $5/day. Resets at UTC midnight. |
| `/wanna-bet` | Create a two-sided pool. Pick Side A label, Side B label, your side, your wager. |
| `/accept <bet-id>` | Join an open bet on either side. |
| `/decline <bet-id>` | Decline a direct bet (full refund — fee included). |
| `/resolve <bet-id> <A\|B\|neither>` | Propose an outcome. Other participants confirm or dispute via DM buttons. |
| `/bets active` | List open bets. |
| `/bank` | Bank balance + cap. |
| `/leaderboard` | Top 10 by balance. |
| `/stats [@user]` | W/L, total wagered, net P/L, biggest win/loss, current streak. |
| `/history [@user]` | Paginated bet history. |
| `/vote-admin start\|nominate\|cast\|status` | Elect a server admin. 1-hour window, ≥50% quorum, plurality wins, ties random. |
| `/admin grant\|seize\|resolve\|cancel\|ban\|unban` | Admin powers (elected admin only). Cannot print money or change rates. |
| `/setup role` | Set the gambler role required for lobby bets (Manage Guild permission). |

## Economy model

All amounts stored as integer **cents**. $1.00 = 100.

- **Fee per bet side**: `max($1, 1% of wager)`, deducted from the wager (not on top). $5 wager → $5 leaves your wallet, $1 to bank, $4 enters the pool.
- **Settlement**: winners get their stake back plus a pro-rata share of the loser pool (`floor(stake / total_winner_stake * loser_pool)`). Rounding remainder goes to the largest-stake winner.
- **"Neither" outcome**: each participant gets their stake back, fees stay in bank.
- **Inflation taps**: starting balance $100, daily $5 (per-user, UTC midnight). The bank only grows from bet fees — no automatic seeding.

## Architecture

`BalanceService.transfer()` is the **only** function that mutates `players.balance` or `bank.balance`. Every grant, payout, fee, escrow, and refund goes through it, wrapped in a `BEGIN IMMEDIATE` transaction. No exceptions. This is the load-bearing invariant of the codebase.

Other services: `BetService` (bet lifecycle, settlement math), `PlayerService` (registration, lifecycle), `ElectionService` (admin elections), `AuditService` (synchronous append to the `audit_log` table). One SQLite connection in WAL mode.

Slash commands are registered globally — first registration takes up to ~1 hour to propagate, updates are near-instant.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). The short version: clone, install, `npm run dev`, follow the BalanceService rule, run the build and tests before opening a PR.

## License

MIT — see [`LICENSE`](LICENSE).
