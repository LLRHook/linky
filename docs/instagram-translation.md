# Instagram caption translation

## Why a separate translator is needed

Instagram7 supplies original captions. Its maintained route and embed source has no translation modifier. The metadata route `GET /api/{shortcode}` returns `Username`, `Caption` and `Medias`; Reel lookups accept `?kind=reel`. Gallery mode on `g.instagram7.com` suppresses the caption while retaining provider media. These are unversioned provider interfaces, so requests are bounded and failures leave normal preview handling available. [Route source](https://github.com/Bl0ck154/InstaFix-Revived/blob/main/main.go#L220), [embed source](https://github.com/Bl0ck154/InstaFix-Revived/blob/main/handlers/embed.go#L372).

Linky uses Google Cloud Translation Basic v2 with `target: "en"` and `format: "text"`. Omitted `source` enables language detection. Paragraphs are translated independently so an English introduction does not hide a foreign-language body. English paragraphs and non-prose separators remain unchanged. Caption URLs, handles and hashtags must survive translation intact; ambiguous or malformed results are discarded. [Translation API](https://docs.cloud.google.com/translate/docs/reference/rest/v2/translate).

The English caption appears with a small source-language label and the provider's native gallery preview in one message. If Instagram7's gallery fails, Linky tries `g.oginstagram.com` on the same output. Gallery modes remain aliases of their providers, with one bounded fallback; a normal embed containing the original caption cannot count as a translated-preview success. [OGInstagram gallery documentation](https://github.com/seirenkr/OGInstagram/blob/87110e42eb4b4b99ef4ec09c97c6971e95f97ce7/README.md).

Long captions continue in a text attachment. A failed single-post preview keeps the original message and a tracked English-caption output. A mixed/multiple-post preview failure uses the existing rollback path. An alternate URL that would exceed Discord's message limit is skipped so the full caption and failure notice can still fit. Only captions are translated: no image OCR, audio transcription or replacement media is produced. Manual `/fix` commands are unchanged, and messages already using rich translated X cards skip Instagram translation to preserve media.

## Observed example

On September 11, 2026, public post `DdFwAIqgncQ` returned a full mixed English/Estonian caption, including hard-wrapped Estonian lines. The API returned `GraphImage`, but normal, gallery and direct preview modes all advertised the same inaccessible static Instagram resource. A GET failed with `Unsigned URL`. Its caption is available for translation; its image needs a working upstream media source. The native Discord description is truncated, so it must not be used as if it contained the complete caption.

On September 12, OGInstagram gallery previews returned the correct image for `DdKVPMEhTXe` and video metadata for `DdFKS1ABmK4` using both `/reel/` and `/reels/` routes in Discord, without the original caption. All temporary provider-check messages were removed. Caption metadata still comes from Instagram7; OGInstagram HTTP requests from the bot host were blocked even when Discord could embed its links, so it is not used as a caption metadata source.

Those observations concern these posts at the time of testing. A successful metadata request or `GraphImage` hint does not establish working media. Automated tests use synthetic captions and media URLs, and cannot establish Google translation accuracy or Discord playback.

## Activation checks

1. Complete the billing, dedicated key and quota setup in the [README](../README.md#self-host). Keep Instagram translation disabled until the key is restricted and the daily Cloud quota is set. Preserve the usage journal across restarts. Publish the caption-processing privacy notice before enabling hosted translation.
2. With the real API, check a mixed English/Estonian caption, an English-only caption and paragraphs with hard wraps, handles, URLs and hashtags. Confirm all foreign prose is translated and tokens remain intact. API failure, unknown language and an exhausted budget must leave normal preview handling available.
3. In an authorized Discord test channel, check a healthy image, Reel and video posted through `/p/`. Confirm the source-language label, no duplicate original caption, intact image/player and actual playback. Native video metadata alone is insufficient proof of playback.
4. Check a post with broken upstream media. Its original must remain, with one English-caption output and working Original post/Remove controls. Edit or delete the source and verify the tracked output follows it.
5. Disable `/settings translate_instagram`, disable Instagram, and change source text while lookup is pending. No stale translated output should remain. Test Replace and Reply modes without broadening server/channel scope.
6. Confirm long captions have a complete attachment and a visible language label, including a URL longer than the message preview. Confirm caption URLs never create extra embeds or override the gallery preview expectation.

The feature defaults off. Complete the real API and Discord checks above before enabling it on the hosted bot; provider-gallery checks alone do not establish translation accuracy.
