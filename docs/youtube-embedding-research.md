# YouTube previews and statistics

Researched 11 September 2026 against current primary documentation and public provider endpoints. This is implementation research, not a claim that the feature is deployed.

The selected implementation preserves Discord's native YouTube preview and appends compact counts plus a top comment to Linky's reply or replacement. The user explicitly chose both counts and a comment. Metadata comes from the official YouTube Data API, is cached for five minutes, and is scheduled for removal from the message after 24 hours. The hosted Linky operator supplies one API key; people adding Linky to a server need no Google credentials. Without a working key, leave YouTube links alone.

The operator verified successful HTTP 200 responses from both `videos.list` and `commentThreads.list` on the production host on 11 September 2026, using the restricted operator key. That verifies credentials and API access. It does not prove native playback or the rendered Discord layout.

## What the official API provides

`videos.list` retrieves `statistics` and `status` for a known video ID in one request. It costs **1 quota unit**. Several IDs can be requested together; do not add `maxResults` or pagination parameters when using `id`, because those parameters are not supported with this filter. Handle a missing item or `videoNotFound` without publishing a YouTube-only replacement. [Method reference](https://developers.google.com/youtube/v3/docs/videos/list)

Request only the fields needed for display, for example:

```text
GET https://www.googleapis.com/youtube/v3/videos
  ?part=statistics,status
  &id=VIDEO_ID
  &fields=items(id,statistics(viewCount,likeCount,commentCount),status(embeddable,privacyStatus))
X-Goog-Api-Key: OPERATOR_API_KEY
```

The request requires an API key from a Google Cloud project with YouTube Data API v3 enabled. Public video metadata does not require viewers to authorize through OAuth. Keep the key on the bot host, restrict it to this API, and avoid recording credential-bearing request URLs in logs. OAuth is required for private user data. [Credentials](https://developers.google.com/youtube/registering_an_application)

Current documentation allocates a default **10,000 units per day for the combined endpoints other than `search.list` and `videos.insert`**, which now have separate defaults. The project's Cloud Console is authoritative for its allowance. Looking up IDs from links avoids a search request. Linky's bounded cache lasts five minutes and simultaneous lookups are deduplicated. Five minutes is an engineering choice, not Google's required refresh interval. [Getting started and quotas](https://developers.google.com/youtube/v3/getting-started)

| Field or case | Display behavior |
| --- | --- |
| `statistics.viewCount` | Views, if the API returns a valid count. |
| `statistics.likeCount` | Likes, if returned. |
| `statistics.commentCount` | Comment count, if returned. It is not comment text. |
| Valid `"0"` | Display zero. Do not treat it as missing. |
| Absent, null, malformed, or negative count | Omit that metric. Do not invent zero or a reason for its absence. |
| `statistics.dislikeCount` | Exclude. Public dislikes are unavailable; access is restricted to the authenticated video owner. |
| `status.embeddable` | A useful signal, but even `true` does not guarantee playback in every context. |
| `status.publicStatsViewable=false` | Do not interpret this as hiding all counts. It controls extended watch-page statistics; the documentation says views and ratings remain visible. |

The API documents count fields as unsigned integer strings. Keep valid zero values and avoid lossy conversion if a count exceeds JavaScript's safe integer range. Omission handling above is a defensive recommendation; the resource reference does not promise a distinct missing-field reason for every hidden or disabled case. [Video resource](https://developers.google.com/youtube/v3/docs/videos)

The selected top-comment feature uses `commentThreads.list` with `part=snippet`, `videoId=VIDEO_ID`, `order=relevance`, `maxResults=1`, and `textFormat=plainText`. Each video's comment request costs **1 additional quota unit**; it cannot share the video-ID batch. One uncached video with a comment therefore costs two units, while three batched videos with comments cost four. The returned comment is selected by YouTube's relevance order, not a guarantee of the most-liked comment. On `403 commentsDisabled`, an empty result, or a comment-request failure, retain available counts and omit the comment. Do not infer disabled comments from an absent count. [Comment threads](https://developers.google.com/youtube/v3/docs/commentThreads/list)

On invalid credentials, timeout, missing/private/deleted video, malformed response, or `403 quotaExceeded`, preserve the original message and skip the statistics. Avoid retrying quota exhaustion for every incoming link. [API errors](https://developers.google.com/youtube/v3/docs/errors)

## Playback and persistent messages

Discord's Create Message API cannot set an embed's `video`, `provider`, or `type`; bot-created embeds are `rich`. A custom statistics card cannot supply a native playable YouTube video just by setting an embed field. Discord also deduplicates embeds with the same URL. Linky keeps a native YouTube URL in its message and adds the statistics/comment as a text suffix with a suppressed attribution link. Server preference controls whether that message replies to or safely replaces the original. Mention notifications are disabled. Actual playback still needs a real Discord check. [Discord message API](https://docs.discord.com/developers/resources/message)

A normal public [YouTube oEmbed request](https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json) returned title, author, thumbnail, provider, and player HTML during this research. It contained no likes, views, or comments. This observed response supplies no replacement for the statistics API.

YouTube's policy section III.E.4 says non-authorized API data may be stored for at most **30 calendar days**, after which it must be refreshed or deleted. Public data obtained with an API key falls in that category. Display current data, or label historical values accurately with their time. A timestamp alone does not waive storage limits. Applying this to persistent bot-authored Discord statistics is a conservative implementation interpretation: an in-memory cache expiry does not remove old displayed counts. The policy also prohibits obtaining scraped YouTube data. [Developer policies](https://developers.google.com/youtube/terms/developer-policies)

Linky's durable queue stores IDs, expiry times and character lengths before adding API data. Cleanup starts after 24 hours, runs at startup and hourly, and retries failed edits. It removes only the recorded suffix, retaining the native video and message body. These intervals are implementation choices.

Attribute the statistics to YouTube with an appropriate approved mark and a link back to the video; keep Linky's avatar and name. The branding guidelines describe which logo or icon fits a mixed-source interface and require linked attribution. [Branding guidelines](https://developers.google.com/youtube/terms/branding-guidelines)

Update Linky's public terms/privacy documentation for the YouTube API feature, including required YouTube terms and Google privacy links and how metadata is handled. [Policy section III.A](https://developers.google.com/youtube/terms/developer-policies)

## Existing fixers examined

**Koutube** advertises native Discord playback with likes, views, subscribers, and dates. Its README says it uses an Invidious instance. Its documented API and current video handler expose no comment count. Its API documentation calls the API a work in progress, permits missing data, describes roughly one-week caching, and warns that access conditions may change. [README](https://github.com/iGerman00/koutube/blob/main/README.md), [API contract](https://github.com/iGerman00/koutube/blob/main/API.md), [video handler](https://github.com/iGerman00/koutube/blob/main/src/handlers/videoHandler.ts)

A normal request to `https://koutube.com/api/watch?v=dQw4w9WgXcQ` returned HTTP 403 with `Cf-Mitigated: challenge` on 11 September 2026 at 23:14 UTC. No challenge bypass was attempted. This is a failure from our environment, not evidence of a global outage. Embed Fixer's own README disables its Koutube integration by default because it sometimes produces no embed or no video. [Embed Fixer](https://github.com/seriaati/embed-fixer)

**FxYouTube** advertises similar playback and count features and links its fork ancestry to the repository now named Koutube. Its feature list does not promise comment counts. Its public claims are insufficient to verify that it meets Linky's requested behavior. [FxYouTube](https://www.yfxtube.com/)

No examined provider established a dependable, supported combination of native playback, likes, and comment counts without Linky obtaining an official API key. The official API route needs a small amount of credential and expiry handling, but has a documented source for the requested counts.

Before enabling the feature publicly, verify a standard video, Shorts, a timestamped URL, missing counts, true zero counts, disabled comments, inaccessible video, quota failure, restart with expired messages, and a failed Discord cleanup edit. Confirm the video remains playable, the comment is compact, and mention notifications remain disabled.
