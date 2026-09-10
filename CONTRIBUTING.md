# Contributing

Patches and bug reports welcome.

## Local setup

```bash
git clone https://github.com/llrhook/wanna-bet.git
cd wanna-bet
npm ci
cp .env.example .env   # add your DISCORD_TOKEN
npm run db:migrate
npm run register-commands
npm run dev            # tsx watch — auto-reloads on save
```

Use native Node.js for local development. Docker Desktop on macOS has caused gateway latency and interaction timeouts in this project; production uses Docker on Linux.

## The one rule

**`BalanceService.transfer()` is the only function that may UPDATE `players.balance` or `bank.balance`.** Every grant, payout, fee, escrow, and refund goes through it. If you're writing `UPDATE players SET balance` anywhere else, stop.

## Before opening a PR

- `npm run build` passes cleanly under strict TypeScript
- `npm test` passes (strict typecheck, message replacement, bet lifecycle and command tests; no token needed)
- `npm run db:migrate` succeeds against a fresh database
- If you touched a command, you tested it in a real Discord server
- No `.env` or token in the diff

Add characterization tests before refactoring untested behavior. Bet tests use in-memory SQLite; command tests isolate the existing bot/database entry points to avoid login and persistent writes. Keep payout rounding, transaction boundaries, command responses and audit ordering intact.

For repost changes, follow the [README setup](README.md). In a Discord test channel, check a plain X link, an attached file and a lookalike domain; verify attribution, native previews, preserved attachments and source deletion. Temporarily remove Manage Messages and confirm new matching messages stay untouched. Offline tests cover formatting, scope, copy failures, mentions and source edits, including Discord's automatic link-warning metadata. They cannot prove live permissions or preview rendering. With `TRANSLATE_TWEETS=true`, also post a known non-English tweet link and confirm the repost carries the translate suffix and the embed shows a translation.

## Reporting bugs

Open an issue with: what you ran, what happened, what you expected, the bot logs, and the Discord error code if any. For security issues, email me privately at `victor.n.ivanov@gmail.com` instead of opening a public issue.
