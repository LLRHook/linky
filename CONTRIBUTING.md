# Contributing to Linky

Use Node.js 22+ and `npm ci`. Tests need no Discord token. For a local bot, copy `.env.example` to `.env`, set its token, then run `npm run dev`. Commands register automatically at startup. Enable a test server with `/setup enabled:True` or configure a test channel as described in the [README](README.md).

Before opening a PR, run:

```bash
npm test
npm run build
bash tests/deploy.test.sh
```

Keep the message handler focused on copying safely. Test observable behavior: channel scope, exact URL matching, attribution, attachment integrity, source edits, permissions and provider failures. Use synthetic or non-sensitive fixtures for translation regressions, including quoted media and long text. Avoid network calls or bot login in unit tests. Never commit tokens, `.env` or private chat exports.

For rendering changes, test in a configured Discord test channel. Check X, Instagram and TikTok (including a real `vm.tiktok.com` share link), profile and lookalike URLs, an attachment, replies and missing Manage Messages permission. With translation enabled, inspect text/photo cards, playable videos, quoted posts and long text; confirm English replaces the original and the language label stays small. Offline tests cannot prove live preview rendering or channel permissions.

The bot must remain silent when joining a server. `/help` and `/setup` are private. New servers require an administrator with Manage Server permission to enable them. Preserve original messages whenever copying cannot be verified, and disable all mention notifications.

For bugs, include expected and actual behavior, a reproducible public link where possible, sanitized logs and any Discord error code. Report security issues privately to `victor.n.ivanov@gmail.com`.
