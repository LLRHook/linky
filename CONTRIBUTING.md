# Contributing to Linky

Use Node.js 22+ and `npm ci`. Tests need no Discord token. For a local bot, copy `.env.example` to `.env`, set its token, then run `npm run dev`. Commands register automatically at startup. Enable a test server with `/setup enabled:True` or configure a test channel as described in the [README](README.md).

Before opening a PR, run:

```bash
npm test
npm run build
bash tests/deploy.test.sh
```

Test observable behavior: channel scope, exact URL matching, attribution, attachment integrity, source edits, permissions and provider failures. Cover preference migration and concurrent writes, operator limits, and `/settings` changing preferences without enabling a server. Use synthetic or non-sensitive translation and YouTube API fixtures. Avoid network calls or bot login in unit tests. Never commit tokens, API keys, `.env` or private chat exports.

For rendering changes, use an authorized Discord test channel. Check X, Instagram and TikTok (including a real `vm.tiktok.com` share link), profile and lookalike URLs, attachments and replies. In Replace mode, missing Manage Messages permission must preserve the original. Reply mode must work without that permission, keep the original and avoid copying its attachments. Check per-platform switches and translation limits. With translation enabled, inspect text/photo cards, playable videos, quoted posts and long text; confirm the language label stays small. Offline tests cannot prove live preview rendering or channel permissions.

YouTube checks need an operator-provided API key configured as described in the README. Check HTTPS watch, short, Shorts, live and embed links, valid timestamps, lookalikes and malformed URLs. Confirm native playback, available counts, and a compact top comment selected by relevance. Omit unavailable fields. Missing keys and API failures must preserve the original YouTube link. Use controlled expiry in tests to verify 24-hour cleanup and durable retry across restarts while retaining the video/body. The queue must contain only IDs, expiry times and character lengths; API counts and comment text belong only in the five-minute memory cache and temporary Discord additions.

The bot must remain silent when joining a server. `/help`, `/setup` and `/settings` are private. New servers require an owner or member with Manage Server permission to enable them. Preserve original messages whenever replacement cannot be verified, and disable all mention notifications. Keep legacy boolean settings readable, preserve preferences when `/setup` changes enablement, and document data compatibility when a rollback needs a settings backup.

For bugs, include expected and actual behavior, a reproducible public link where possible, sanitized logs and any Discord error code. Report security issues privately to `victor.n.ivanov@gmail.com`.
