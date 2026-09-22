# Public article previews

Post a public HTTPS article in a channel where Linky is enabled. In Replace mode, Linky credits the sender and removes the source only after Discord returns the complete prepared card and source/ownership checks pass. Reply mode keeps the source. Manual `/fix link:` and **Apps → Fix with Linky** keep it too.

The card contains a publisher-labelled headline, an excerpt of up to 300 characters, and a publisher image and publication date when available. Text comes from the page's metadata. Linky does not generate a summary, evaluate accuracy, translate the article, execute page scripts or bypass access restrictions.

## Supported pages and controls

- Pages need `og:type=article` or Schema.org `Article`, `NewsArticle` or `BlogPosting` JSON-LD in their HTML head, with a usable title. Pages without article metadata, logins and private pages remain unchanged.
- Up to three distinct article links can share a message. All must be prepared before replacing it. Keep articles separate from social and other links because authored cards can suppress Discord's native unfurls. Mixed messages retain the source and receive split-message guidance when supported.
- Keep unrelated website links separate too. When a message contains an article candidate without usable metadata, automatic processing leaves the entire message unchanged, including any social links beside it.
- `/settings articles:false` or the setup Platforms menu disables articles. Server enablement, channel scope, personal `/autofix` choices, `!nolinky`, hidden links, source-edit checks and owner-only Remove still apply. Original post and Details remain available to viewers.
- No API key is required. Operators using an explicit `REWRITE_PLATFORMS` list must add `articles`; an empty list enables available platforms. Social/provider and Erome URLs cannot fall back through articles to bypass their own settings.

## Request limits and privacy

Linky requests only public HTTPS pages, with no cookies or user credentials. DNS results must be public IPv4 addresses and the connection is pinned to a validated address while retaining normal TLS verification. Each redirect is checked again. Literal IPs, local hostnames, credentials, explicit ports, common account/API paths and known social-provider endpoints are rejected. Some otherwise public pages therefore remain unsupported.

Retrieval stops after the HTML head, 512 KiB or five seconds, with at most three redirects. Compressed responses that ignore the identity request are skipped. A process allows four active lookups and 30 new lookups per minute; it does not queue an unlimited backlog. Those limits are shared across servers. Successful metadata is cached in memory for five minutes, misses for 15 seconds, with at most 100 entries. URLs and metadata are not written to the delivery archive. Cache contents disappear on restart.

The publisher sees a request from the bot host. Discord retrieves the optional public image separately; source changes or Discord's image proxy can still make that image unavailable. A confirmed card proves that Discord returned the prepared fields, not that the article is accurate or an image rendered on every device. Missing usable metadata leaves the original; manual requests explain the limitation.

The initial requested example is the Manhattan Institute's *The Fiscal Impact of Immigration (2025 Update)*. Support is based on metadata format, not a publisher allowlist.
