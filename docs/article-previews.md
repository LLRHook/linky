# Public article previews

Post a public HTTPS article in a channel where Linky is enabled. In Replace mode, Linky credits the sender and removes the source only after Discord returns the complete prepared card and source/ownership checks pass. Reply mode keeps the source. Manual `/fix link:` and **Apps → Fix with Linky** keep it too.

The card contains a publisher-labelled headline, an excerpt of up to 300 characters, and a publisher image and publication date when available. Text comes from the page's metadata. Linky does not generate a summary, evaluate accuracy, translate the article, execute page scripts or bypass access restrictions.

## Supported pages and controls

- Pages need `og:type=article` or Schema.org `Article`, `NewsArticle` or `BlogPosting` JSON-LD in their HTML head, with a usable title. Pages without article metadata, logins and private pages remain unchanged.
- Media pages keep Discord's native player. Pages declaring `og:video`, a `video.*`/`music.*` `og:type` or a Twitter player card are skipped even when they also carry Article JSON-LD (Tenor does). Discord's own domains and hosts it plays natively (Tenor, Giphy, Imgur, Streamable, Vimeo, Spotify, SoundCloud and similar) are never article candidates.
- Up to three distinct article links can share a message. All must be prepared before replacing it. Keep articles separate from social and other links because authored cards can suppress Discord's native unfurls. Mixed messages retain the source and receive split-message guidance when supported.
- Keep unrelated website links separate too. When a message contains an article candidate without usable metadata, automatic processing leaves the entire message unchanged, including any social links beside it.
- `/settings articles:false` or the setup Platforms menu disables articles. Server enablement, channel scope, personal `/autofix` choices, `!nolinky`, hidden links, source-edit checks and owner-only Remove still apply. Original post and Details remain available to viewers.
- No API key is required. Operators using an explicit `REWRITE_PLATFORMS` list must add `articles`; an empty list enables available platforms. Social/provider and Erome URLs cannot fall back through articles to bypass their own settings.

## Truth Social posts

Truth Social serves the same placeholder metadata for every post, so Discord and the article reader see no post content. For public post links (`https://truthsocial.com/@user/ID` or `/@user/posts/ID`) Linky tries three signed-out public sources in order and uses the first that returns the requested post:

1. Truth Social's status API (`/api/v1/statuses/ID`): author name, handle and avatar, text, the first image or video poster, link-preview title, quoted text, ReTruth credit, reply/ReTruth/like counts and post time. Truth Social's bot protection rejects this API from datacenter addresses, including the hosted bot's (checked October 26, 2026), so it mainly serves self-hosted instances on other networks.
2. For `@realDonaldTrump`, the [Trump's Truth](https://www.trumpstruth.org) archive feed, which lists his latest 100 posts with text and archived media. Image posts show the image; video posts show the poster and a **Play video** link to the archived MP4. The footer credits the archive; counts and the avatar are unavailable. One feed request is cached for 30 seconds across lookups.
3. Truth Social's own post page metadata, which carries the full text of most posts with text, plus the author's name from Truth Social's oEmbed endpoint and the avatar. Truth Social renders that metadata only after a page has been visited once, so Linky revisits the page after 1.2 seconds when the first visit returns the placeholder. Images and videos are not in this metadata.

Videos and additional images otherwise stay on Truth Social; the card says so. Private, direct, sensitive and content-warning posts, IDs that do not match the link, removed archive entries and responses that are not the expected type leave the original unchanged. A media-only post by another account, or one older than the archive feed with no text, has no usable public source from the hosted bot and stays unchanged. Links inside post text show as `[link]`. Images come only from Truth Social's `static-assets` hosts or the archive's storage. These cards follow the Articles setting and every rule above; all requests share the five-second limit and rate limits below.

## Request limits and privacy

Linky requests only public HTTPS pages, with no cookies or user credentials. DNS results must be public IPv4 addresses and the connection is pinned to a validated address while retaining normal TLS verification. Each redirect is checked again. Literal IPs, local hostnames, credentials, explicit ports, common account/API paths and known social-provider endpoints are rejected. Some otherwise public pages therefore remain unsupported.

Retrieval stops after the HTML head, 512 KiB or five seconds, with at most three redirects. Compressed responses that ignore the identity request are skipped. A process allows four active lookups and 30 new lookups per minute; it does not queue an unlimited backlog. Those limits are shared across servers. Successful metadata is cached in memory for five minutes, misses for 15 seconds, with at most 100 entries. URLs and metadata are not written to the delivery archive. Cache contents disappear on restart.

The publisher sees a request from the bot host. Discord retrieves the optional public image separately; source changes or Discord's image proxy can still make that image unavailable. A confirmed card proves that Discord returned the prepared fields, not that the article is accurate or an image rendered on every device. Missing usable metadata leaves the original; manual requests explain the limitation.

The initial requested example is the Manhattan Institute's *The Fiscal Impact of Immigration (2025 Update)*. Support is based on metadata format, not a publisher allowlist.
