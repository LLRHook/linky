# Preview providers and verification

Reviewed September 11, 2026. Provider availability changes independently of Linky. A successful HTML response, a Discord embed and actual video playback are separate observations.

Linky's catalog accepts fixed HTTPS hosts and post-shaped paths. It does not fetch arbitrary URLs supplied by members. Discord generates previews; Linky checks the returned embed's post identity before removing the source. Known video paths and videos identified by translation metadata require a video reference. Caption-mode translated text is checked as delivered content rather than waiting for an intentionally suppressed native embed.

| Platform | Candidates, in order | Selection evidence and limits |
| --- | --- | --- |
| X/Twitter | `fixupx.com`, `vxtwitter.com` | FxEmbed and BetterTwitFix are separate implementations. `fxtwitter.com` is an alias of the primary, and `fixvx.com` is an alias of the alternate; aliases are not independent recovery providers. |
| Instagram | `www.instagram7.com` | Current Instagram7 post and reel paths. Sampled alternatives did not provide a verified usable reel response, so failure preserves the source. |
| TikTok | `tnktok.com` | fxTikTok supports long post URLs and mobile shares. Short URLs still depend on redirect resolution. No verified alternate is configured. |
| Bluesky | `bskx.app`, `fxbsky.app` | VixBluesky returned image and video metadata for current public examples. FxBluesky returned text but no media URL in sampled HTML; actual Discord checks decide whether a fallback is useful. |
| Reddit | `vxreddit.com` | Maintainer image and video examples returned corresponding media metadata. `rxddit.com` returned 502 and was excluded. Short `/s/` shares, `redd.it`, galleries and feeds are not resolved. |
| Twitch clips | `fxtwitch.seria.moe` | The maintainer's clip returned canonical clip identity and video metadata. Its media URL uses the provider's shortening service. Linky requires no Twitch or shortening-service credential. Streams and VODs are excluded. |
| YouTube | Native YouTube preview | Counts and optional comments use YouTube Data API v3. Statistics never substitute for a video preview. |

Sources: [FxEmbed documentation](https://docs.fxembed.com/guide/getting-started/), [BetterTwitFix](https://github.com/dylanpdx/BetterTwitFix), [Instagram7](https://www.instagram7.com/), [fxTikTok](https://github.com/okdargy/fxTikTok), [VixBluesky pinned README](https://github.com/Lexedia/VixBluesky/blob/37280716ff389847d8f410edcc7258e550dccf63/README.md), [vxReddit pinned README](https://github.com/dylanpdx/vxReddit/blob/d3f7876fb3fc9045aebcca6fa41d0352ec3697c6/README.md), and [fxTwitch pinned README](https://github.com/seriaati/fxtwitch/blob/4519f7ad601077d5e8226895d04348657d97b656/README.md).

## Repeatable checks

Offline tests cover strict hosts, post identities, known provider errors, delayed/missing previews, bounded fallback, attachments, source edits, permission changes and durable ownership. Canonical Reddit URLs match by post ID; Twitch aliases match by clip ID. Bluesky identity uses actor and record key; Linky does not resolve handles to DIDs.

For authorized live tests, use current public posts and a dedicated channel. Record source URL, provider, Discord embed identity, image/video presence, source preservation and cleanup. Use the [vxReddit maintainer test list](https://github.com/dylanpdx/vxReddit/blob/d3f7876fb3fc9045aebcca6fa41d0352ec3697c6/tests.sh) and provider READMEs for reproducible samples. Keep private message bodies, API keys and signed media URLs out of reports.

Test an unavailable post too: Linky must preserve the original and offer an owned Retry notice. Retry uses the same provider when no alternate is configured. Confirm playback separately in a Discord client; never mark it passed from embed metadata alone.

Recent provider observations in `/diagnose` describe a last check, not global service uptime. They expire from diagnostic relevance after 15 minutes and are lost on restart.
