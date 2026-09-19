# Preview providers and verification

Reviewed September 18, 2026. Provider availability changes independently of Linky. A successful HTML response, a Discord embed and actual video playback are separate observations. Dated samples below retain their original test dates.

Linky's catalog accepts fixed HTTPS hosts and post-shaped paths. It does not fetch arbitrary URLs supplied by members. Discord generates previews; Linky checks the returned embed's post identity before removing the source. Known video paths and videos identified by translation metadata require a video reference. Caption-mode translated text is checked as delivered content rather than waiting for an intentionally suppressed native embed.

| Platform | Candidates, in order | Selection evidence and limits |
| --- | --- | --- |
| X/Twitter | `fixupx.com`, `vxtwitter.com` | FxEmbed and BetterTwitFix are separate implementations. `fxtwitter.com` is an alias of the primary, and `fixvx.com` is an alias of the alternate; aliases are not independent recovery providers. |
| Instagram | `www.instagram7.com`, `oginstagram.com` | OGInstagram produced matching image previews for two public posts that failed on Instagram7, plus video metadata for a public Reel in Discord. These samples establish a useful fallback, not an uptime or playback guarantee. Legacy `/tv/` paths have not been verified with OGInstagram. |
| TikTok | `tnktok.com` | fxTikTok supports long post URLs and mobile shares. Short URLs still depend on redirect resolution. No verified alternate is configured. |
| Bluesky | `bskx.app`, `fxbsky.app` | VixBluesky returned image and video metadata for current public examples. FxBluesky returned text but no media URL in sampled HTML; actual Discord checks decide whether a fallback is useful. |
| Reddit | `vxreddit.com` | Maintainer image and video examples returned corresponding media metadata. `rxddit.com` returned 502 and was excluded. `redd.it` post IDs and mobile post aliases normalize directly. App `/s/` shares use bounded public redirects when Reddit permits them; galleries and feeds remain excluded. |
| Twitch clips | `fxtwitch.seria.moe` | The maintainer's clip returned canonical clip identity and video metadata. Its media URL uses the provider's shortening service. Linky requires no Twitch or shortening-service credential. Streams and VODs are excluded. |
| YouTube | Native video preview; public-page community cards | Counts and optional comments use YouTube Data API v3. Public `/post/` text and images use a separate cookie-free page lookup. Statistics and authored community cards never substitute for video playback evidence. |

Sources: [FxEmbed documentation](https://docs.fxembed.com/guide/getting-started/), [BetterTwitFix](https://github.com/dylanpdx/BetterTwitFix), [Instagram7](https://www.instagram7.com/), [fxTikTok](https://github.com/okdargy/fxTikTok), [VixBluesky pinned README](https://github.com/Lexedia/VixBluesky/blob/37280716ff389847d8f410edcc7258e550dccf63/README.md), [vxReddit pinned README](https://github.com/dylanpdx/vxReddit/blob/d3f7876fb3fc9045aebcca6fa41d0352ec3697c6/README.md), and [fxTwitch pinned README](https://github.com/seriaati/fxtwitch/blob/4519f7ad601077d5e8226895d04348657d97b656/README.md).

## Repeatable checks

On September 18, a public Instagram mobile share resolved from Hostinger through HTTP 302. A Reddit app share returned HTTP 403 and stayed unchanged; its canonical `/comments/` URL and deterministic `redd.it` form avoid that resolution step. Tests reject unsafe redirects, non-public DNS answers, loops, excess hops and expired requests. These observations do not guarantee all mobile shares resolve.

Controlled Discord checks that day confirmed the previously reported X text post both directly and with attribution in under half a second. One Instagram Reel produced useful video metadata around 7.5 seconds, after the old check had ended; the Instagram Gateway window now allows eight seconds and still wakes immediately on success. Empty Instagram media cards remained unusable after 20 seconds. The historical captioned image post had a working OGInstagram gallery while Instagram7 lacked media. Keep those causes separate; a longer wait cannot repair an empty provider response.

### Provider metadata control

`npm run check:providers` (after `npm run build`) fetches every catalog provider for each entry in `ops/preview-corpus.json` with Discord's crawler user agent and asks Linky's own preview matcher whether the returned Open Graph metadata would satisfy it. It is the first of three separate observations: provider metadata, Discord's generated embed, and playback on a client. A passing corpus says nothing about the other two. Pass `--json` for a machine-readable report, or one or more `https://` links instead of the corpus for an ad hoc check. Every corpus entry records an expected media kind; a provider that answers with the wrong kind is shown but does not pass the entry.

On September 19, the nine-entry corpus (public X text, Instagram Reel, TikTok share link and long URL, Bluesky image, Reddit video, gallery and image, Twitch clip) met every expectation from a residential network. fxTikTok answered ten additional cold NBA posts with video metadata in under one second each, and its generated video URL redirected to a signed TikTok CDN URL that returned bytes in under one second; provider latency does not explain the four unconfirmed TikTok previews in the September 18 window. fxTikTok publishes the canonical `/@user/video/ID` post URL for `/t/` and `vm.` share links, which Linky's matcher rejected as a different post until the September 18 fix; that defect is the only confirmed cause and the share-link case is now in the corpus. OGInstagram returned HTTP 403 to the crawler user agent from the same network, so the Instagram fallback had no evidence of working that day; instagram7 still served the Reel with video metadata. vxreddit publishes `og:url` without the subreddit segment, which Linky already accepts. Repeat the control from the bot host before treating any provider result as a hosted observation.

### Instagram recovery

Instagram7 remains the first choice. If Discord does not return useful media for the requested post, Linky edits the same preview to use OGInstagram. Both automatic reposts and manual fixes use this order. A failed alternate leaves the original intact; an error card or a Reel thumbnail without video metadata does not count as success. No additional API key or operator setting is required.

The [OGInstagram maintainer's README](https://github.com/seirenkr/OGInstagram/blob/87110e42eb4b4b99ef4ec09c97c6971e95f97ce7/README.md) documents the normal `oginstagram.com` URL form and its `www` alias. Gallery and direct-media modes use the same service, so Linky does not count them as independent fallbacks. Private, restricted and unavailable posts can still fail on both services.

On September 12, public posts `DdKVPMEhTXe` and `DdFwAIqgncQ` returned image previews through OGInstagram in Discord, and Reel `DdFKS1ABmK4` returned video metadata. The synthetic unavailable post `LinkyMissingPost20260912` returned an error card without media. Hostinger received HTTP 403 from OGInstagram during a separate probe while Discord successfully embedded the same post; a server-side HTTP probe must not veto a successful Discord preview.

### Regression and live checks

Offline tests cover strict hosts, post identities, known provider errors, delayed/missing previews, bounded fallback, attachments, source edits, permission changes and durable ownership. Canonical Reddit URLs match by post ID; Twitch aliases match by clip ID. Bluesky identity uses actor and record key; Linky does not resolve handles to DIDs.

For authorized live tests, use current public posts and a dedicated channel. Record source URL, provider, Discord embed identity, image/video presence, source preservation and cleanup. Use the [vxReddit maintainer test list](https://github.com/dylanpdx/vxReddit/blob/d3f7876fb3fc9045aebcca6fa41d0352ec3697c6/tests.sh) and provider READMEs for reproducible samples. Keep private message bodies, API keys and signed media URLs out of reports.

Test an unavailable post too: Linky must preserve the original and offer an owned Retry notice. Retry uses the same provider when no alternate is configured. Confirm playback separately in a Discord client; never mark it passed from embed metadata alone.

Recent provider observations in `/diagnose` describe a last check, not global service uptime. They expire from diagnostic relevance after 15 minutes and are lost on restart.

On September 18, public Google community gallery and Veritasium text posts passed exact Discord echo checks and a Discord client rendering check. A two-message control used identical content with the Google link suppressed and the public Jack X post visible. Without explicit cards, the X preview appeared immediately. With the two explicit Google image cards, the X preview was absent from send, Gateway and REST checks through 20 seconds while both community cards matched. Both temporary controls were removed. This supports the bounded separate-message rule for community/native mixtures; it does not establish behavior for every Discord client or provider.

The same release check visually confirmed a standalone X preview, a Compact Instagram caption with an OGInstagram image, a Media-first caption-free OGInstagram image, and a manual Instagram mobile share resolved to its canonical post with its Original post control. The mobile share's caption lookup was unavailable, so the provider's untranslated caption remained as documented. The public Reel `DdFKS1ABmK4` had matching Instagram7 metadata, a video URL and Discord proxy URL, but the checked Chrome client still showed a blurred placeholder. That Reel observation confirms metadata only; playback was not verified.
