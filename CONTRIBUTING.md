# Contributing

Patches and bug reports welcome.

## Local setup

```bash
git clone https://github.com/llrhook/wanna-bet.git
cd wanna-bet
npm install
cp .env.example .env   # add your DISCORD_TOKEN
npm run db:migrate
npm run register-commands
npm run dev            # tsx watch — auto-reloads on save
```

**Don't use Docker on macOS for local dev.** Docker Desktop's network layer adds multi-second latency to Discord's WebSocket gateway, which causes interactions to expire before the bot can ack them. Run natively with `npm run dev`. Docker on Linux (the production VPS deploy) is fine.

## The one rule

**`BalanceService.transfer()` is the only function that may UPDATE `players.balance` or `bank.balance`.** Every grant, payout, fee, escrow, and refund goes through it. If you're writing `UPDATE players SET balance` anywhere else, stop.

## Before opening a PR

- `npm run build` passes cleanly under strict TypeScript
- `npm test` passes (type-checks and runs the offline message replacement tests; no token needed)
- `npm run db:migrate` succeeds against a fresh database
- If you touched a command, you tested it in a real Discord server
- No `.env` or token in the diff

For message replacement changes, follow the optional channel setup in [`README.md`](README.md). The offline tests exercise rewriting, quoted context, Markdown and whitespace preservation, explicit channel lists across servers, legacy configuration, mentions, attachments, permission failures and send-before-delete behavior. They also verify that Discord's link-warning metadata can change without discarding an unchanged repost, while content edits and changes to Suppress Embeds still preserve the original. Before activating a release, smoke-test in a configured Discord test channel with a plain X link, a message with an attachment, and a lookalike domain. Confirm attribution, native previews and attachment preservation, and that only the successful replacements delete their originals. Then remove Manage Messages temporarily and confirm a new matching message stays untouched. A local test run does not verify live Discord permissions or link previews.

## Reporting bugs

Open an issue with: what you ran, what happened, what you expected, the bot logs, and the Discord error code if any. For security issues, email me privately at `victor.n.ivanov@gmail.com` instead of opening a public issue.
