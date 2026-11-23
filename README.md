# Linky

<img src="assets/linky-avatar.png" alt="Linky's smiling chain-link avatar" width="112">

[![CI](https://github.com/LLRHook/linky/actions/workflows/ci.yml/badge.svg)](https://github.com/LLRHook/linky/actions/workflows/ci.yml)
[![Deploy](https://github.com/LLRHook/linky/actions/workflows/deploy.yml/badge.svg)](https://github.com/LLRHook/linky/actions/workflows/deploy.yml)

Linky fixes social links in Discord: X/Twitter, Instagram, TikTok, YouTube, Bluesky, Reddit, Twitch clips and Facebook Reels. It also previews public articles and MyAnimeList entries using the page's title, excerpt and image when available, and public PDFs with their title, page count and size. Add it to your server for automatic previews or to your account for links you choose to fix. The hosted bot is free; you do not need to run a server or supply API keys. Self-hosting is optional for these features. **Erome video and image albums require your own Linky instance and hosting; they are not included in the public hosted bot.**

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

Each platform has a `/settings` switch, such as `/settings instagram:false`. `translate_tweets` controls English tweet translation. `youtube_display` selects **preview**, **counts**, or **counts-and-comment**. Preview-only leaves native YouTube video messages untouched and makes no video API calls; counts skips comment requests. Existing servers retain Replace mode and counts plus comment until an admin changes them. A server cannot enable an operator-disabled feature.

Use `/autofix enabled:false` to stop automatic fixing of your messages in this server, including its threads. The response is private and the preference survives restarts. `/autofix enabled:true` restores automatic fixing wherever the server allows it. Manual `/fix`, Apps → Fix with Linky and an explicit Retry remain available; turning automatic fixing back on does not scan old messages.

Put `!nolinky` in a message to skip automatic fixing. Links inside `<angle brackets>`, code or spoilers are also left alone. Anyone who can see a preview can open its **Original post** link and **Details**; the details response is private to the person who clicks. Only the original sharer can use **Remove** on an automatic preview; only the requester can remove a manual preview. This also applies to moderators and administrators using the button. Discord's native moderation remains available. **Retry preview** and **Load next item** are available to channel members with current view/send permission who are not timed out. Using them does not transfer ownership of Remove. Replies follow edits and deletions of their source while their ownership record is retained (up to 30 days).

## Supported links

| Platform | Preview service | Posts |
| --- | --- | --- |
| X/Twitter | One Linky block with the author, text and media for a lone post with photos, videos or GIFs, otherwise `fixupx.com`, with `vxtwitter.com` recovery | Post URLs on X and Twitter, including `/i/web/status/` and media paths |
| Instagram | `oginstagram.com` (OGInstagram): one Linky block with the author and media for a lone post, otherwise its caption-free `g.oginstagram.com` gallery | Posts, reels and TV links, including resolvable `/share/` links |
| TikTok | `tnktok.com` | Videos, photos and mobile share links |
| YouTube | Native video preview, optional Data API statistics and public-page community cards | HTTPS watch, `youtu.be`, Shorts, live and embed links; valid start timestamps retained; public `/post/` text and image posts |
| Bluesky | One Linky block with the author, text and images for a lone post with images, otherwise `bskx.app`, with `fxbsky.app` recovery | Public `/profile/actor/post/id` URLs |
| Reddit | `vxreddit.com`; `rxddit.com` resolves blocked app-share redirects only | Public post URLs, `redd.it` links and resolvable `/r/name/s/` or `/u/name/s/` mobile shares; profile and community index pages stay unchanged |
| Twitch clips | `fxtwitch.seria.moe` | Clip URLs, including channel `/clip/` links; streams and VODs stay unchanged |
| Facebook | `facebed.com` | Public Reel and page video URLs (`/reel/ID`, `/page/videos/ID`) and resolvable `/share/r/` or `/share/v/` mobile shares; photo posts, `/watch` and `fb.watch` links stay unchanged |
| Articles, PDFs and MyAnimeList | Page metadata in a Linky card; Bing News headlines (or labelled URL titles) for blocked Telegraph articles; PDF document cards | Public HTTPS pages with Open Graph article metadata or Article JSON-LD, public PDF files, MyAnimeList anime/manga entries, and supported dated Telegraph article links; up to three together |
| Truth Social | Linky post card under the Articles setting, from Truth Social's status API (any account, with bounded MP4 uploads and playable-link fallback; an optional [Cloudflare relay](docs/truth-social-relay.md) covers hosts it refuses), the Trump's Truth archive (for `@realDonaldTrump`) or Truth Social's page metadata (text and first image) | Public `truthsocial.com/@user/ID` and `/@user/posts/ID` posts; if the API refuses the host and no relay is set, video-only posts by other accounts may stay unchanged |
| Erome (self-host only) | Your own media gallery, with attachment fallback | HTTPS `/a/album-id` albums; video and supported JPEG/PNG images, additional items on demand; follows Replace or Reply mode |

Instagram, Reddit, TikTok and Facebook mobile shares follow a bounded, cookie-free HTTPS lookup to an allowed public post on the same platform. TikTok `/t/`, `vm.` and `vt.` shares resolve to the exact video or photo ID before previewing. If Reddit rejects an app-share lookup, Linky can send the share path without tracking parameters to FixReddit (`rxddit.com`) to resolve it, then use vxReddit for the preview. A failed or unsafe redirect cannot authorize deletion from an unrelated preview.

The September 29 Hostinger check reproduced Reddit's HTTP 403 and resolved the reported app share through the fallback. Its vxReddit video played in a GAMBA Discord control. This is one tested public post, not a guarantee for every share. Full Reddit `/comments/` URLs and `redd.it` links avoid the share-resolution request. Private or unavailable posts can still fail.

Supported links must use HTTPS and point to posts, public articles, PDFs or supported MyAnimeList entries. Social tracking query strings are removed; article queries, valid YouTube start timestamps and surrounding text are retained. Automatic fixing starts with new messages from people; editing an unrelated old message does not start a repost. Bots and webhooks are ignored.

Public article previews show the publisher's headline, a labelled publisher, an excerpt of up to 300 characters, and an image and publication date when available. When The Telegraph refuses bot access to a dated article, Linky looks up Bing News's entry for that exact article URL and shows its headline, excerpt and thumbnail, labelled **Headline via Bing News**; if Bing News has no entry, the card is labelled **Title from URL**, with a readable title taken from the link and no excerpt, image or publication time. Public PDFs get a **PDF document** card with the document's declared title, its first-page heading or its file name (the footer says which), the declared author, page count, size and creation time. MyAnimeList anime and manga entries use the same compact card with a synopsis and cover when available, labelled Source with Anime or Manga metadata. They work automatically in enabled channels and through `/fix` or **Apps → Fix with Linky**, without an API key. Share up to three article or MyAnimeList links together, separately from social or other links: authored cards can suppress Discord's other native previews. Linky preserves the original when neither metadata nor a supported fallback is available, a page returns an unavailable response, or any page in the set cannot be prepared. It does not summarize, fact-check, translate or bypass paywalls. `/settings articles:false` or the setup Platforms menu disables article, PDF and MyAnimeList entry previews. Truth Social pages carry no per-post metadata, so its public posts use a Linky card with the author, text, first image or uploaded video, counts and post time under the same setting. A single automatic or manual video post plays inside its panel; unavailable uploads keep the poster and Play video link. LinkedIn posts, including `lnkd.in` share links, get a card with the author, post text, first image, counts and post time; video posts upload their MP4 so Discord plays it in the message, inside the post's panel for a single automatic repost or manual fix. See [article support and limits](docs/article-previews.md).

On your own instance, Erome needs media delivery because its video CDN can reject Discord's direct fetch. Linky starts with the first video from the first album, or a supported image when the album has no video. By default, Erome requires an age-restricted server channel or a thread in one. An admin with Manage Server permission can allow ordinary channels using `/settings erome_channels:all`; select `age-restricted` to restore the default. The same channel policy applies to `/fix` and **Fix with Linky**. DMs are excluded. The setting does not enable Linky in new channels or turn Erome on when disabled; `/setup` controls automatic channel scope and `/settings erome:false` disables automatic Erome previews. Linky does not scan the video's content.

A self-hosted instance with original-media hosting configured delivers eligible Erome originals as playable media galleries without re-encoding: MP4, up to 24 MiB, five minutes, 60 fps and native 1080p. Larger or incompatible media uses attachment preparation, with a 64 MiB input limit and compression when needed to fit Discord. Smaller sources stay at their original resolution. JPEG/PNG image albums are supported within separate limits. On a hosted gallery, eligible channel members can use **Load next item** to append one item at a time, up to ten items and 192 MiB total. Existing items stay if the next one fails. Controls expire after 24 hours or a restart; **Original post** opens the full album. Automatic Erome previews follow the server's posting mode: Replace removes the source message after confirmation and ownership checks; Reply keeps it. Standalone prepared Erome video and image attachments share a Components V2 panel with their text, including manual fixes. Messages that must copy source attachments or retain other preview types keep attachment delivery before replacement; see the [media presentation audit](docs/media-blocks.md). Failed previews, manual fixes and retries keep the source. Availability and speed depend on the source, hosting services and Discord.

Slow requests show their current stage, and **Details** gives the person who clicks a private outcome and timing report. Details on private replies and DMs remain restricted to their requester. Media jobs rotate fairly between servers and reuse validated results where possible. See [delivery reliability and retention](docs/delivery-reliability.md), [Erome limits](docs/erome-previews.md) and [regional hosting](docs/erome-regional-hosting.md).

A message whose only link is one X post with photos, videos or GIFs, its own or in a quoted post, appears as one block in any language: the sharer credit, the author, the post text, each quoted post's text and every item together, with **Original post** and Remove, and no second native card. English posts keep their own text. With English translation enabled, other languages show the translation with a small source-language label; with it disabled, they show the original text. Linky confirms within 10 seconds that Discord has loaded every item of the block, or that Discord's media proxy already serves it; otherwise it deletes the block and posts the usual card for that link instead, which is checked the same way as any other card. Text-only posts, several links, polls, broadcasts, posts with media from other sites, more than ten items and text too long for one block keep the native preview. `/fix` and **Apps → Fix with Linky** behave the same way; a manual card that replaces an unconfirmed block is a new reply.

When English translation is enabled, translated tweet text replaces the original with a small source-language label. This also applies to `/fix` and **Apps → Fix with Linky**: server requests honor the server's `translate_tweets` setting, and DMs use the operator's translation setting. Photos, playable videos and quoted posts retain their media, including translated quotes beneath an outer post with no text. Video posts that cannot be one block show the captions above the native preview, and a shared post without media of its own shows its directly quoted post's photos or video in its card, so the message keeps one link. Long translations continue across cards or include a text attachment; manual fixes keep the native preview if the required attachment cannot be sent. Unsupported posts and failed translations keep the native preview. Preview availability and translation quality depend on the listed services and FxEmbed.

Instagram posts never show their caption. A message whose only link is one Instagram post appears as one block: the sharer credit, the author and every photo and video, with **Original post** and Remove. Linky confirms Discord has loaded every item; otherwise the source is kept with a **Retry preview** notice. Several links, or a post OGInstagram cannot describe, use its caption-free gallery card instead. `/fix` and **Apps → Fix with Linky** behave the same way. See [Instagram media](docs/instagram-media.md).

A message whose only link is one Bluesky post with images, its own or in a quoted post, appears as one block: the sharer credit, the display name and @handle linked to the profile, the post text, the quoted post's text and every image, with **Original post** and Remove. Linky reads the post from Bluesky's public AppView. Video posts, link cards, posts without images, posts with content labels, quotes of quotes and posts the AppView does not return keep the `bskx.app` card. As for X, a block whose images Discord does not confirm within 10 seconds is replaced by that card. `/fix` and **Apps → Fix with Linky** behave the same way.

Public YouTube `/post/` links can show the creator, text and ordered images without an API key. Linky reads the public YouTube page without signing in. Polls, quizzes, video attachments, unavailable posts and unrecognized page formats keep their source. These cards have no video counts or top-comment button. Public-page changes can break extraction independently of the video API. Up to five community posts can share one preview, within the ten-card limit. Community cards cannot reliably appear alongside native fixer or YouTube video previews in the same message. For that combination, Linky keeps the original and explains how to share the posts in separate messages, without looking them up or offering a futile Retry. Automatic guidance retains the sharer's Remove control; manual guidance is private.

When enabled, YouTube keeps one native video message with compact counts on buttons. Click counts for exact values or **Top comment** for a private, attributed excerpt selected by YouTube's relevance order. Missing fields are omitted; comment failure can still leave counts available. A missing API key or failed video lookup leaves the native YouTube message untouched. YouTube buttons expire after 24 hours; cleanup is retried across restarts while preserving the video, source text and other controls. A cleanup record is retired if removal still fails more than seven days after expiry; stale buttons can remain visible but no longer authorize statistics access.

Before removing an original, Linky waits for a useful preview tied to each rewritten post, checks attachments, and rechecks the source and settings. Known videos require video metadata; translated text delivered as a caption does not need a separate native embed. Failed previews try an alternate provider when available, in the same message. X and Reddit Gateway checks allow up to ten seconds for large-video previews; Instagram, TikTok and Facebook allow up to eight seconds for cold media. Checks return as soon as a matching useful preview appears, or return unconfirmed when every unresolved post has a recognised error card for that post from the provider currently being attempted; other platforms retain the four-second window. One bounded REST reconciliation follows a missed event. Repeated, attributable recovery evidence can temporarily reorder providers; an unavailable post alone does not establish an outage. If no provider confirms, the original stays with a **Retry preview** notice; retrying posts a reply and keeps the source. Manual fixes check previews and try alternates in the same response, reading their own reply, so a user-installed fix in a DM or a server without Linky is confirmed too. Instagram, TikTok, Reddit, Twitch and Facebook currently have no verified alternate provider. Preview metadata cannot guarantee playback in every Discord client.

Attachment names, descriptions, spoilers and reply context are preserved. Replies name the original author and show a short excerpt in small italic text. Replies to Linky reposts name the person who shared that post and quote its content. Link-only messages use their existing preview text when available. Excerpts hide spoilers and omit link targets; messages that cannot be read in the same channel show "Original message unavailable." Missing permissions, failed copies and size limits leave the original intact. Polls, stickers, forwards, pinned messages and thread starters are skipped. If Discord refuses source deletion because of moderator 2FA (60003) or missing permissions (50013), Linky keeps the verified preview as a tracked reply copy with Remove/Details controls and reports a permission outcome. Other deletion failures can leave both messages without final controls. Reply mode keeps the source and its attachments.

On fresh automatic posts, **Shared by** can notify the original sharer in both Replace and Reply mode. Replace also allows explicit user tags that Discord recognized in the source; Reply allows only the sharer. Quoted replies, provider text, role tags and `@everyone`/`@here` never add recipients. Manual fixes, retries, refreshes, failure notices and progress updates stay quiet. Linky preserves `@silent`. Recipient settings control actual alerts, and the original may already have notified someone before the repost.

## Reliability and operations

Restarts and updates let running deliveries finish first. The hosted bot then fixes links posted while it was offline, up to two minutes old, in the 20 channels where it most recently saw a link. Self-hosters can turn this on with `CATCH_UP_ENABLED`; see [self-hosting](docs/self-hosting.md).

Delivery Details remain available in Discord for up to seven days. A separate, private operator archive on Hostinger keeps sanitized attempt outcomes and timings for 30 days, bounded by a 64 MiB cap. It contains no Discord user, server, channel or message IDs, message text, captions, source URLs or credentials. The random attempt ID can connect an operator investigation to a Details report. Capacity and storage failures can shorten coverage and are surfaced in the report.

After building, run `npm run report:deliveries -- --days 7` on the bot host to compare outcomes, latency and problem stages. This is an operator command, not a Discord command or a public log page. See [operator reliability](docs/operator-reliability.md) for storage, reports and daily review. Metadata confirmation is not proof of playback. `npm run check:providers` checks provider metadata for a public link corpus without Discord; see [preview providers](docs/provider-checks.md#provider-metadata-control).

## Self-hosting and development

The hosted bot is free to add for the seven social platforms above, public article previews and available translations. Run your own instance for Erome or your own extensions; self-hosting does not automatically add support for arbitrary websites. The [self-hosting guide](docs/self-hosting.md) covers Node/Docker setup, environment variables, API keys, quotas, persistent data, logs, deployment and rollback. The optional [Discord coding integration](docs/discord-prompt.md) is disabled on the hosted bot.

```bash
npm ci
npm run validate
```

`npm run validate` runs CI's build, worker, test, deployment-safeguard and audit commands and reports every result; see [CONTRIBUTING.md](CONTRIBUTING.md) for the Node version and Windows notes.

CI tests Node.js 22, 24 and 26, deployment safeguards and the production container, with the dependency audit and secret scan as separate jobs; the `CI gate` check passes only when every job passes. See [CONTRIBUTING.md](CONTRIBUTING.md) for live checks and [SECURITY_AUDIT.md](SECURITY_AUDIT.md) for dependency, secret-scan and supply-chain results. The bot deploys to Hostinger after the tested `main` commit passes CI; website deployment is separate. Deployment labels the image with its full source commit and checks the running image before confirming success; a mismatch restores the previous image and configuration. Read the latest image label with `docker image inspect linky:latest --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'`. See [self-hosting](docs/self-hosting.md#checks-and-deployment) for running-image inspection and the initial rollout's empty-label limitation.

[PERFORMANCE_AUDIT.md](PERFORMANCE_AUDIT.md) records measured local CPU costs, the delivery module boundaries and remaining measurement gaps. Its synthetic timings are separate from provider delays and Discord playback checks.

[VERIFICATION.md](VERIFICATION.md) is the release-readiness protocol: it runs the CI commands verbatim, maps every shipped change to its proving test and re-ticks the privacy and safety constraints above. Known defects are tracked in [bugs.md](bugs.md), planned work in [features.md](features.md), and verified fixes and features are migrated into [CHANGELOG.md](CHANGELOG.md).

[MIT license](LICENSE).

## Setup

<!-- cycle:tracker-setup begin (written by trackers.py install) -->
**Once per clone**, set up the tracker merge driver and pre-commit lint (Claude Code sessions do this automatically):

```bash
python3 .cycle/trackers.py install
```

```powershell
python .cycle\trackers.py install
```
<!-- cycle:tracker-setup end -->
