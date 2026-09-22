# Linky

<img src="assets/linky-avatar.png" alt="Linky's smiling chain-link avatar" width="112">

[![CI](https://github.com/LLRHook/linky/actions/workflows/ci.yml/badge.svg)](https://github.com/LLRHook/linky/actions/workflows/ci.yml)
[![Deploy](https://github.com/LLRHook/linky/actions/workflows/deploy.yml/badge.svg)](https://github.com/LLRHook/linky/actions/workflows/deploy.yml)

Linky fixes social links in Discord: X/Twitter, Instagram, TikTok, YouTube, Bluesky, Reddit and Twitch clips. It also previews public articles using the publisher's headline, excerpt and image when available. Add it to your server for automatic previews or to your account for links you choose to fix. The hosted bot is free; you do not need to run a server or supply API keys. Self-hosting is optional for these features. **Erome video and image albums require your own Linky instance and hosting; they are not included in the public hosted bot.**

Visit the [Linky website](https://linkybot.dev) for setup guides and troubleshooting.

See the [product roadmap](docs/product-roadmap.md) for planned improvements and the [dated competitor research](docs/growth-research-2026-09-17.md) for the evidence behind them. Planned features are not available until marked shipped.

## Add to Discord

**[Add Linky to your server](https://discord.com/oauth2/authorize?client_id=1491240385031311470&permissions=277025516544&integration_type=0&scope=bot+applications.commands)**

**[Add Linky to your account](https://discord.com/oauth2/authorize?client_id=1491240385031311470&integration_type=1&scope=applications.commands)** to use `/fix link:` and a message's **Apps → Fix with Linky** action in servers or DMs. Each request handles up to three supported links, or five YouTube community posts together within Discord's shared card limits. Share community posts separately from other supported links and YouTube videos. It keeps the source message; YouTube videos use native previews without API statistics. Personal installation does not watch your DMs or enable automatic fixing in servers.

You must be the server owner or have **Administrator** or **Manage Server** permission in that server to enable Linky.

1. Choose your server and authorize Linky.
2. Open a text channel in that server, type `/setup`, select **Linky's `/setup` command** from the command picker and send it.
3. The private setup card shows whether Linky is active in this channel. Choose your posting mode, platforms and channels, then select **Enable server**. Menu selections save automatically.
4. Check the card’s effective scope, missing permissions and Reply/Replace examples. **Test here** explicitly posts one sample if X or YouTube is enabled; it checks preview delivery, not replacement or playback. Then send your own supported link. If the preview does not appear, run `/diagnose link:` there to check permissions, settings, URL support and recent provider observations.

If Linky's `/setup` command is missing from the picker, follow the [setup troubleshooting guide](https://linkybot.dev/setup).

New servers stay inactive until an admin enables them. Changing preferences alone never enables a server. Choose specific channels or **All channels**; selected parent channels include their accessible threads. **Disable server** stops automatic processing. `/setup enabled:true` and `/setup enabled:false` also work and preserve channel selections. Setup, settings, help and diagnostics are private; saved choices survive restarts. Linky sends nothing when it joins. Discord may display its own system join notice.

The default Replace mode uses **View Channel**, **Read Message History**, **Send Messages**, **Send Messages in Threads**, **Embed Links**, **Attach Files** and **Manage Messages**. The invite requests these permissions. Reply mode does not require **Manage Messages** or copy the original attachments. If a link stays unchanged, check channel/category overrides for the **Linky** role. Private threads must also be accessible to the bot.

## Server preferences

With **Manage Server** permission, run `/settings` without options to see the effective configuration. Use `/settings mode:reply` to keep original messages and add replies, or `/settings mode:replace` to restore the default. Replace mode credits the author and preserves attachments before removing the original.

Each platform has a `/settings` switch, such as `/settings instagram:false`. `translate_tweets` controls English tweet translation; `translate_instagram` separately controls Instagram captions when the operator has configured a translation key. `youtube_display` selects **preview**, **counts**, or **counts-and-comment**. Preview-only leaves native YouTube video messages untouched and makes no video API calls; counts skips comment requests. Existing servers retain Replace mode and counts plus comment until an admin changes them. A server cannot enable an operator-disabled feature.

Use `/autofix enabled:false` to stop automatic fixing of your messages in this server, including its threads. The response is private and the preference survives restarts. `/autofix enabled:true` restores automatic fixing wherever the server allows it. Manual `/fix`, Apps → Fix with Linky and an explicit Retry remain available; turning automatic fixing back on does not scan old messages.

Put `!nolinky` in a message to skip automatic fixing. Links inside `<angle brackets>`, code or spoilers are also left alone. Anyone who can see a preview can open its **Original post** link and **Details**; the details response is private to the person who clicks. Only the original sharer can use **Remove** on an automatic preview; only the requester can remove a manual preview. This also applies to moderators and administrators using the button. Discord's native moderation remains available. **Retry preview** and **Load next item** are available to channel members with current view/send permission who are not timed out. Using them does not transfer ownership of Remove. Replies follow edits and deletions of their source while their ownership record is retained (up to 30 days).

## Supported links

| Platform | Preview service | Posts |
| --- | --- | --- |
| X/Twitter | `fixupx.com`, with `vxtwitter.com` recovery | Post URLs on X and Twitter, including `/i/web/status/` and media paths |
| Instagram | `www.instagram7.com`, with `oginstagram.com` recovery | Posts, reels and TV links, including resolvable `/share/` links |
| TikTok | `tnktok.com` | Videos, photos and mobile share links |
| YouTube | Native video preview, optional Data API statistics and public-page community cards | HTTPS watch, `youtu.be`, Shorts, live and embed links; valid start timestamps retained; public `/post/` text and image posts |
| Bluesky | `bskx.app`, with `fxbsky.app` recovery | Public `/profile/actor/post/id` URLs |
| Reddit | `vxreddit.com` | Public post URLs, `redd.it` links and resolvable `/r/name/s/` or `/u/name/s/` mobile shares; profile and community index pages stay unchanged |
| Twitch clips | `fxtwitch.seria.moe` | Clip URLs, including channel `/clip/` links; streams and VODs stay unchanged |
| Articles | Publisher metadata in a Linky card | Public HTTPS pages with Open Graph article metadata or Article JSON-LD; up to three articles together |
| Erome (self-host only) | Your own media gallery, with attachment fallback | HTTPS `/a/album-id` albums; video and supported JPEG/PNG images, additional items on demand; follows Replace or Reply mode |

Instagram and Reddit mobile shares follow a bounded, cookie-free HTTPS lookup to an allowed public post on the same platform. A failed or unsafe redirect leaves the original untouched.

The September 18 Hostinger check resolved an Instagram share but received HTTP 403 for the tested Reddit app share. Use a full Reddit `/comments/` URL or a `redd.it` link when the source refuses resolution; Linky does not bypass login or access restrictions.

Supported links must use HTTPS and point to posts or public articles. Social tracking query strings are removed; article queries, valid YouTube start timestamps and surrounding text are retained. Automatic fixing starts with new messages from people; editing an unrelated old message does not start a repost. Bots and webhooks are ignored.

Public article previews show the publisher's headline, a labelled publisher, an excerpt of up to 300 characters, and an image and publication date when available. They work automatically in enabled channels and through `/fix` or **Apps → Fix with Linky**, without an API key. Share up to three article links together, separately from social or other links: authored cards can suppress Discord's other native previews. Linky preserves the original when metadata is missing, a page is unavailable, or any article in the set cannot be prepared. It does not summarize, fact-check, translate or bypass paywalls. `/settings articles:false` or the setup Platforms menu disables articles. See [article support and limits](docs/article-previews.md).

On your own instance, Erome needs media delivery because its video CDN can reject Discord's direct fetch. Linky starts with the first video from the first album, or a supported image when the album has no video. By default, Erome requires an age-restricted server channel or a thread in one. An admin with Manage Server permission can allow ordinary channels using `/settings erome_channels:all`; select `age-restricted` to restore the default. The same channel policy applies to `/fix` and **Fix with Linky**. DMs are excluded. The setting does not enable Linky in new channels or turn Erome on when disabled; `/setup` controls automatic channel scope and `/settings erome:false` disables automatic Erome previews. Linky does not scan the video's content.

A self-hosted instance with original-media hosting configured delivers eligible Erome originals as playable media galleries without re-encoding: MP4, up to 24 MiB, five minutes, 60 fps and native 1080p. Larger or incompatible media uses attachment preparation, with a 64 MiB input limit and compression when needed to fit Discord. Smaller sources stay at their original resolution. JPEG/PNG image albums are supported within separate limits. On a hosted gallery, eligible channel members can use **Load next item** to append one item at a time, up to ten items and 192 MiB total. Existing items stay if the next one fails. Controls expire after 24 hours or a restart; **Original post** opens the full album. Automatic Erome previews follow the server's posting mode: Replace removes the source message after confirmation and ownership checks; Reply keeps it. Source attachments are copied through attachment delivery before replacement. Failed previews, manual fixes and retries keep the source. Availability and speed depend on the source, hosting services and Discord.

Slow requests show their current stage, and **Details** gives the person who clicks a private outcome and timing report. Details on private replies and DMs remain restricted to their requester. Media jobs rotate fairly between servers and reuse validated results where possible. See [delivery reliability and retention](docs/delivery-reliability.md), [Erome limits](docs/erome-previews.md) and [regional hosting](docs/erome-regional-hosting.md).

When English translation is enabled, translated tweet text replaces the original with a small source-language label. Photos, playable videos and quoted posts retain their media. Long translations continue across cards or include a text attachment. Unsupported posts and failed translations keep the native preview. Preview availability and translation quality depend on the listed services and FxEmbed.

Optional Instagram translation reads Instagram7's full available caption and shows a compact English excerpt with a small source-language label. It uses gallery previews from Instagram7, with OGInstagram recovery, to hide the original caption while retaining native media. Only captions are translated; text inside images and audio are unchanged. Captions use one paragraph of up to 300 characters, ending with an ellipsis when shortened. No full-caption text file is added; **Original post** opens the source caption. If a single translated Instagram preview cannot be verified, Linky keeps the source message and the English caption. Lookup failures, exhausted translation allowance and disabled translation keep normal preview handling. Manual fixes also use the server’s caption setting when translation is available. Run `/settings` to check availability, or `/settings translate_instagram:true` to enable it when the operator provides translation.

Choose `/settings instagram_presentation:standard`, `compact` or `media-first`. Standard keeps translated captions within 300 characters; Compact uses 120. Media-first requests a caption-free provider preview and skips caption translation. Native captions in Standard or Compact when translation is unavailable remain controlled by the provider. Attribution, Original post and owner-only Remove remain in every mode.

Public YouTube `/post/` links can show the creator, text and ordered images without an API key. Linky reads the public YouTube page without signing in. Polls, quizzes, video attachments, unavailable posts and unrecognized page formats keep their source. These cards have no video counts or top-comment button. Public-page changes can break extraction independently of the video API. Up to five community posts can share one preview, within the ten-card limit. Community cards cannot reliably appear alongside native fixer or YouTube video previews in the same message. For that combination, Linky keeps the original and explains how to share the posts in separate messages, without looking them up or offering a futile Retry. Automatic guidance retains the sharer's Remove control; manual guidance is private.

When enabled, YouTube keeps one native video message with compact counts on buttons. Click counts for exact values or **Top comment** for a private, attributed excerpt selected by YouTube's relevance order. Missing fields are omitted; comment failure can still leave counts available. A missing API key or failed video lookup leaves the native YouTube message untouched. YouTube buttons expire after 24 hours; cleanup is retried across restarts while preserving the video, source text and other controls.

Before removing an original, Linky waits for a useful preview tied to each rewritten post, checks attachments, and rechecks the source and settings. Known videos require video metadata; translated text delivered as a caption does not need a separate native embed. Failed previews try an alternate provider when available. Instagram normally starts with Instagram7 and can try OGInstagram in the same message. Its Gateway check allows up to eight seconds for cold media to arrive and returns as soon as a matching preview appears; other platforms retain the four-second window. One bounded REST reconciliation follows a missed event. Repeated, attributable recovery evidence can temporarily reorder providers; an unavailable post alone does not establish an outage. If both fail, the original stays with a **Retry preview** notice; retrying posts a reply and keeps the source. Manual fixes check previews and try alternates in the same response. TikTok, Reddit and Twitch currently have no verified alternate provider. Preview metadata cannot guarantee playback in every Discord client.

Attachment names, descriptions, spoilers and reply context are preserved. Replies name the original author and show a short excerpt in small italic text. Replies to Linky reposts name the person who shared that post and quote its content. Link-only messages use their existing preview text when available. Excerpts hide spoilers and omit link targets; messages that cannot be read in the same channel show "Original message unavailable." Missing permissions, failed copies and size limits leave the original intact. Polls, stickers, forwards, pinned messages and thread starters are skipped. A failed source deletion can leave both messages. Reply mode keeps the source and its attachments.

On fresh automatic posts, **Shared by** can notify the original sharer in both Replace and Reply mode. Replace also allows explicit user tags that Discord recognized in the source; Reply allows only the sharer. Quoted replies, provider text, role tags and `@everyone`/`@here` never add recipients. Manual fixes, retries, refreshes, failure notices and progress updates stay quiet. Linky preserves `@silent`. Recipient settings control actual alerts, and the original may already have notified someone before the repost.

## Reliability and operations

Delivery Details remain available in Discord for up to seven days. A separate, private operator archive on Hostinger keeps sanitized attempt outcomes and timings for 30 days, bounded by a 64 MiB cap. It contains no Discord user, server, channel or message IDs, message text, captions, source URLs or credentials. The random attempt ID can connect an operator investigation to a Details report. Capacity and storage failures can shorten coverage and are surfaced in the report.

After building, run `npm run report:deliveries -- --days 7` on the bot host to compare outcomes, latency and problem stages. This is an operator command, not a Discord command or a public log page. See [operator reliability](docs/operator-reliability.md) for storage, reports and daily review. Metadata confirmation is not proof of playback. `npm run check:providers` checks provider metadata for a public link corpus without Discord; see [preview providers](docs/provider-checks.md#provider-metadata-control).

## Self-hosting and development

The hosted bot is free to add for the seven social platforms above, public article previews and available translations. Run your own instance for Erome or your own extensions; self-hosting does not automatically add support for arbitrary websites. The [self-hosting guide](docs/self-hosting.md) covers Node/Docker setup, environment variables, API keys, quotas, persistent data, logs, deployment and rollback. The optional [Discord coding integration](docs/discord-prompt.md) is disabled on the hosted bot.

```bash
npm ci
npm test
npm run build
npm run check:workers
bash tests/deploy.test.sh
```

CI tests Node.js 22 and 24, deployment safeguards and the production container. See [CONTRIBUTING.md](CONTRIBUTING.md) for live checks and [SECURITY_AUDIT.md](SECURITY_AUDIT.md) for dependency, secret-scan and supply-chain results. The bot deploys to Hostinger after the tested `main` commit passes CI; website deployment is separate.

[MIT license](LICENSE).
