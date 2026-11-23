# Instagram media

Linky shows an Instagram post's media without its caption; captions were almost always noise. Since November 23, 2026 there is no caption translation and no caption setting.

## How a post is shown

A message whose only link is one Instagram post becomes one Linky block: the sharer credit, then a container with the author (`@username`, linked to the profile) and a gallery of every photo and video, at most ten. Linky reads the post from OGInstagram, served at `oginstagram.com`. Asked for `application/activity+json`, its post URL (`/p/{shortcode}/`, or `/reel/{shortcode}/` for Reels) returns an ActivityStreams `Note`: `attributedTo` names the account and `attachment` lists each item's media type and a signed `/offload/{shortcode}/{n}` address. Linky accepts a Note only when its `id` names the requested shortcode on that origin and its account name is a valid Instagram username; it never reads or keeps the `content` (caption). Discord fetches the offload addresses through its media proxy; the provider redirects them to Instagram's CDN for Discord's agent, and Cloudflare challenges other agents. The block is kept only after, within 10 s, Discord reports each item as fetched with its media type or its media proxy serves each item as its kind of content (the probe described in [media blocks](media-blocks.md)). Otherwise the automatic replacement is removed and the source stays with a **Retry preview** notice; a manual response keeps its notice and **Original post** control. [OGInstagram source](https://github.com/seirenkr/OGInstagram).

Every other case uses the provider's caption-free gallery card at `g.oginstagram.com/p/{shortcode}/`: several links in one message, a failed or refused lookup, a Note without an offload address for every item, more than ten items, copied attachments or a message with other rich cards. A card that shows post text does not count as a successful caption-free preview, and a known video requires video metadata. The gallery is a mode of the same provider, not an independent fallback; no second Instagram provider is configured. [OGInstagram gallery documentation](https://github.com/seirenkr/OGInstagram/blob/87110e42eb4b4b99ef4ec09c97c6971e95f97ce7/README.md).

These are unversioned provider interfaces, so requests are bounded (5 s, 64 KiB, eight pending) and failures fall back to the gallery card. The provider's gateway allows an unverified automated client 50 requests per address per hour ([commit c790ec7](https://github.com/seirenkr/OGInstagram/commit/c790ec7)). Linky looks up only a lone post, caches a result for five minutes and a failure for 30 seconds; a refused lookup shows the gallery card. A lookup sends only the public post shortcode.

## Observed example

On September 11, 2026, public post `DdFwAIqgncQ` returned a full mixed English/Estonian caption, including hard-wrapped Estonian lines. The API returned `GraphImage`, but normal, gallery and direct preview modes all advertised the same inaccessible static Instagram resource. A GET failed with `Unsigned URL`. Its caption is available for translation; its image needs a working upstream media source. The native Discord description is truncated, so it must not be used as if it contained the complete caption.

On September 12, OGInstagram gallery previews returned the correct image for `DdKVPMEhTXe` and video metadata for `DdFKS1ABmK4` using both `/reel/` and `/reels/` routes in Discord, without the original caption. All temporary provider-check messages were removed. Caption metadata still comes from Instagram7; OGInstagram HTTP requests from the bot host were blocked even when Discord could embed its links, so it is not used as a caption metadata source.

On November 18, 2026, `fkinstagram.com` no longer resolved, so the Instagram7 caption route was unreachable; Linky now reads captions from OGInstagram. From the bot host, OGInstagram returned HTTP 200 Notes within 0.3 seconds for public post `DeIfsDPo0zx` (one `image/jpeg` attachment) and Reel `DdFKS1ABmK4` (one `video/mp4`), under both `/p/` and `/reel/`. A missing shortcode and the `/tv/` route returned HTTP 404 problem documents, and post `DdKVPMEhTXe` returned HTTP 503. These eight requests carried only public shortcodes; they did not exercise Google translation, Discord rendering or playback.

Those observations concern these posts at the time of testing. A successful metadata request or `GraphImage` hint does not establish working media. Automated tests use synthetic captions and media URLs, and cannot establish Google translation accuracy or Discord playback.

The September and November observations above predate the November 23 removal of caption translation; they describe the caption route as it was.

## Live checks

1. In an authorized Discord test channel, share one image post, one carousel and one Reel. Each must appear as one block: the sharer credit, `@author` once, every item in the gallery, no caption and no second card. Confirm actual playback; video metadata alone is not proof.
2. Share two Instagram links in one message, and one Instagram link beside another platform's link. Each Instagram link must show the caption-free gallery card.
3. Check a post with broken upstream media. The original must remain with the **Retry preview** notice, and no block without media may be left.
4. Run `/fix` and **Apps → Fix with Linky** on a post, including from a DM with the user-installed app. The response must be the same block, with **Original post** and Remove.
5. Test Replace and Reply modes, and `/settings instagram:false`, without broadening server or channel scope.

Automated tests use synthetic Notes and media URLs; they cannot establish Discord rendering or playback.
