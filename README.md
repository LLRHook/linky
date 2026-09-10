# Wanna Bet Bot

[![CI](https://github.com/llrhook/wanna-bet/actions/workflows/ci.yml/badge.svg)](https://github.com/llrhook/wanna-bet/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Discord bot with per-server virtual balances, two-sided bet pools, elected admins, and optional embed-fixing reposts for X, Instagram and TikTok links. Built with TypeScript, discord.js v14, and SQLite.

**[Add Wanna Bet to your server](https://discord.com/oauth2/authorize?client_id=1491240385031311470&permissions=2147568640&integration_type=0&scope=bot+applications.commands)**, then run `/help`. The public bot's operator must configure channels for social link replacement.

## Self-hosting

Requires Node.js 20+ and npm, or Docker Compose on a Linux host.

1. Create an application in the [Discord developer portal](https://discord.com/developers/applications). Enable **Server Members Intent** on its Bot page and copy the token.
2. Generate an invite with scopes `bot` and `applications.commands`. Grant **View Channel**, **Send Messages**, **Embed Links**, and **Read Message History**.
3. Add the bot to your server, then configure and run your copy:

```bash
git clone https://github.com/LLRHook/wanna-bet.git
cd wanna-bet
npm ci
cp .env.example .env       # set DISCORD_TOKEN
npm run db:migrate
npm run register-commands  # register slash commands before first use
npm run dev
```

Use native Node.js for local development, especially on macOS where Docker Desktop gateway latency has caused interaction timeouts in this project.

For a Linux VPS, clone the repository and set `.env`, then run:

```bash
docker compose up -d --build
docker compose run --rm wannabet node dist/commands/register.js
```

`docker compose logs -f` shows logs. `docker compose down` stops the bot while retaining its database volume. Keep that volume and the `backups/` directory when updating; never commit `.env` or database files.

## Social link replacement

Enable **Message Content Intent**, then set `FIXUPX_CHANNEL_IDS` to comma-separated channel IDs in `.env` and rebuild/restart. Use Discord's Developer Mode → **Copy Channel ID**. Channels can span servers; only exact IDs are included. Threads need their own IDs, and DMs are excluded.

| Permission | Required in each configured channel |
| --- | --- |
| View Channel, Read Message History, Embed Links, Manage Messages | Always |
| Send Messages | Text channels |
| Send Messages in Threads | Threads |
| Attach Files | Messages with attachments; otherwise they stay untouched |

Check role and channel overrides. The public invite above omits reposting permissions; an admin can [reauthorize the public bot](https://discord.com/oauth2/authorize?client_id=1491240385031311470&permissions=2147609600&integration_type=0&scope=bot+applications.commands). Permission updates preserve balances and bets when the existing SQLite database is retained. Apps requiring privileged-intent approval must obtain it before enabling this feature.

The legacy `FIXUPX_CHANNEL_ID` is combined with the list and deduplicated. Invalid IDs or empty list entries, including trailing commas, stop startup. Clear both settings and restart to disable replacement and its extra gateway intents. Slash commands need no re-registration.

For new human messages, links on these hosts are swapped for an embed fixer, with paths, fragments and surrounding text preserved; the query string (share/tracking params like `?s=..&t=..` or `?igsh=..`) is dropped.

| Platform | Rewritten to | Accepted subdomains | Paths rewritten |
| --- | --- | --- | --- |
| `x.com` | `fixupx.com` | none | all |
| `instagram.com` | `kkclip.com` | `www.`, `m.`, `mobile.` | `/p/`, `/reel/`, `/reels/`, `/tv/` |
| `tiktok.com` | `tnktok.com` | `www.`, `m.`, `vm.`, `vt.` | `/@user/video/`, `/@user/photo/`, `/t/`, and share codes on `vm.`/`vt.` |

Accepted subdomains are dropped when rewriting to the fixer. Profile and index pages, malformed post paths, Instagram `/share/` links, and TikTok `/v/` links stay untouched because the fixers do not reliably resolve them. Host matching ignores case; HTTP, unlisted subdomains, credentials, explicit ports, nested URLs inside other URLs, and lookalike hosts stay unchanged. Existing messages, edits, bots and webhooks do not trigger reposting.

Set `REWRITE_PLATFORMS` to a comma-separated subset of `x,instagram,tiktok` to skip a platform whose fixer is down; leave it empty for all three. An unrecognized name stops startup.

Reposts use quoted **Shared by @author** credit and plain leading context, followed by the URL and its full native preview. One separator space may become a newline. Complex Markdown or whitespace keeps the full rewritten body beneath the credit. Reply links, suppressed embeds, and attachment names, descriptions and spoilers are retained. All mention notifications are disabled.

The bot sends and checks the copy, reads the source again, then deletes it if unchanged. Failed permissions, copies or size checks keep the original; edits during copying discard the stale repost. Limits are 2,000 characters including credit, 10 attachments, and 25 MiB total. Polls, stickers, components, forwards, voice messages, ephemeral attachments, pinned messages, thread starters and crossposts are skipped.

Set `TRANSLATE_TWEETS=true` to request English translations of non-English tweets. The bot looks up each distinct tweet once per message via `api.fxtwitter.com`, then appends FxEmbed's [`/en` modifier](https://docs.fxembed.com/guide/url-modifiers/translate/) to eligible X links. Translation availability depends on FxEmbed; some posts still embed only the original text. English or unknown languages and lookups that fail or exceed five seconds repost untranslated. The translation pass skips existing fixer links and links with path modifiers.

Discord sends and deletes are separate requests: failed final reads/deletions can leave both messages, and edits after the final check can still race deletion. Check logs by source message ID. See Discord's [intent](https://docs.discord.com/developers/events/gateway) and [permission](https://docs.discord.com/developers/topics/permissions) references.

## Commands

| Command | Purpose |
| --- | --- |
| `/register`, `/unregister` | Join with $100; leave with your balance preserved. |
| `/balance`, `/daily`, `/bank` | Wallet, $5 daily claim at UTC midnight, bank balance/cap. |
| `/leaderboard`, `/stats [@user]`, `/history [@user]` | Rankings, performance, paginated bet history. |
| `/wanna-bet` | Create a pool with two labels, your side and wager. |
| `/accept <bet-id>` | Join either side of an open bet. |
| `/decline <bet-id>` | Decline a direct invite; refund stake and fee. |
| `/resolve <bet-id> <A\|B\|neither>` | Propose an outcome; participants confirm or dispute through DM buttons. |
| `/bets active` | List open bets. |
| `/vote-admin start\|nominate\|cast\|status` | One-hour election, ≥50% quorum, plurality wins, random ties. |
| `/admin grant\|seize\|resolve\|cancel\|ban\|unban` | Elected-admin controls; no money printing or rate changes. |
| `/setup role` | Set the role for lobby bets; requires Manage Guild. |
| `/help` | Show commands and getting-started steps. |

## Economy and code

Amounts are integer cents. The fee is `max(100, floor(wager * 0.01))`, deducted from the wager: a $5 wager sends $1 to the bank and $4 to the pool. Winners recover their stake plus `floor(stake / winner_pool * loser_pool)`; the largest stake receives the rounding remainder. "Neither" returns stakes and retains fees. Registration and daily claims mint $100 and $5 respectively; the bank grows only from fees, with no automatic seeding.

**Only `BalanceService.transfer()` may update wallet or bank balances**, inside `BEGIN IMMEDIATE`. `BetService` owns the lifecycle and payouts, `PlayerService` registration/activity, `ElectionService` elections, and `AuditService` the audit log. `XLinkService` handles reposts. Commands use these services and the shared embeds. SQLite uses one WAL connection.

## Development

```bash
npm test           # strict typecheck + isolated regression tests; no Discord token needed
npm run build      # compile production TypeScript
npm run db:migrate # apply the schema to data/wanna-bet.db
```

CI runs the build, tests and fresh migration on Node 20 and 22. See [CONTRIBUTING.md](CONTRIBUTING.md) for the balance invariant, local setup and Discord smoke checks.

MIT license. See [LICENSE](LICENSE).
