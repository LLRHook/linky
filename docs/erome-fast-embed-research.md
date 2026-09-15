# Erome preview latency findings

Historical experiments from September 15, 2026, before the ten-location regional implementation shipped. The later [regional hosting guide](erome-regional-hosting.md) describes the active implementation and subsequent measurements. In the experiments below, the ten-second cold-preview target was not met. The reported source is 720p, and the owner chose to preserve its resolution rather than upscale it.

Discord displayed a native 1080p fixture from a local Hostinger file, but both Media Gallery and Open Graph delivery failed on the uncached Erome source. In those tests Discord requested the whole file and stopped near ten seconds, while the source needed roughly 38 seconds to arrive. Parallel ranges, HTTP/2 and three Vercel regions did not improve the transfer rate. The measurements below explain why this earlier relay candidate was not integrated. Later regional work superseded that decision; attachment fallback remains available.

## What the exact album provides

A metadata-only fetch of the reported [music-video album](https://www.erome.com/a/9f9EJu3q) found two source elements referring to the same URL:

```text
https://v63.erome.com/7242/9f9EJu3q/eMbG5fMA_720p.mp4
type='video/mp4' label='HD' res='720'
```

No other MP4, HLS playlist, DASH manifest, 1080p variant or original-file URL appeared in its HTML. The page enables a quality selector, but advertises only this source. At 06:21 UTC a HEAD request using a Discordbot user agent returned 403 without a Referer. With the album Referer it returned 200, `video/mp4`, `Content-Length: 25026293` and `Accept-Ranges: bytes`. The latter request took 103 ms from the research machine; this is a metadata timing, not a Hostinger transfer benchmark. That initial check downloaded no media body.

The current [gallery-dl Erome extractor](https://github.com/mikf/gallery-dl/blob/master/gallery_dl/extractor/erome.py) selects the video source from each media group. It does not reveal a separate quality-discovery API. This is evidence about that implementation, not proof that Erome never stores another rendition.

The owner chose to preserve source resolution and use native 1080p when available. Do not upscale this 720p clip. A genuine 1080p synthetic fixture can verify transport capability, but cannot prove the exact album has native 1080p detail.

## Discord has an external-media API

Ordinary bot embeds cannot set `video`, `type` or `provider`. Setting `EmbedBuilder` properties cannot make a custom playable video card. [Discord message resource](https://docs.discord.com/developers/resources/message#create-message)

Components V2 provides a Media Gallery. Its media item accepts a direct external asset URL, and Discord supplies dimensions, media type and proxy URL. Use flag `32768`, Text Display for attribution, and an Action Row for the existing buttons. V2 disables ordinary message `content` and `embeds`, and its flag cannot later be removed. [Discord component reference](https://docs.discord.com/developers/components/reference#media-gallery), [unfurled media items](https://docs.discord.com/developers/components/reference#unfurled-media-item)

An illustrative request shape, using a reserved example domain:

```json
{
  "flags": 32768,
  "allowed_mentions": { "parse": [] },
  "components": [
    { "type": 10, "content": "Shared video" },
    { "type": 12, "items": [
      { "media": { "url": "https://media.example.com/video/opaque-id.mp4" } }
    ] }
  ]
}
```

The docs do not promise external-video processing latency or a particular byte limit. Test a fresh external URL, inspect the returned metadata, and play it in Discord. A reported [V2 editing issue](https://github.com/discord/discord-api-docs/issues/7529) concerns attachment references during edits; it is a reason to test deferred manual commands separately, not proof that an external URL has that bug.

## Endpoint design evaluated

Keep album lookup and policy checks in Linky. Create an opaque identifier for a validated album source, then return a public HTTPS MP4 URL. The endpoint resolves only identifiers issued by Linky; it never accepts arbitrary destination URLs. Preserve the existing CDN allowlist and fail on upstream challenges or authentication requirements.

The endpoint should implement HEAD plus ordinary and single-range GET. Forward a validated range to the source with its album Referer, preserve the source bytes and MIME type, and verify the returned range and total length. HTTP defines ranges through `Range`, `Content-Range`, status 206, and status 416 for unsatisfied requests. Reject unsupported or excessive range requests and cancel upstream work when the client disconnects. [RFC 9110, range requests](https://www.rfc-editor.org/rfc/rfc9110.html#section-14)

The hypothesis was that a fast-start H.264/AAC source could retain its original streams without waiting for a complete download or encode. It depended on Discord using partial fetches. The live tests instead observed full downloads, leaving the upstream bottleneck in place.

Record request method, requested range, response status, byte count and elapsed time during the experiment. Give transfers explicit size, concurrency and time limits. Keep cookies and bot credentials out of this service. Use bounded cache storage and document the actual retention period. A five-minute link lifetime may break later playback or seeking, so test expiry behavior before choosing one. Do not assume Discord permanently copies an external file.

## Open Graph fallback and MP4 formats

A small HTML page can publish a video URL, MIME type and dimensions through Open Graph. The [Open Graph specification](https://ogp.me/#structured) defines those fields. [FxEmbed's video renderer](https://github.com/FxEmbed/FxEmbed/blob/main/src/render/video.ts) emits both Open Graph video and Twitter player-stream metadata, and uses a proxy for sources needing special headers. This demonstrates a maintained implementation pattern; it does not establish Erome support or an unfurl timing guarantee. An OG page adds another fetch and Discord crawler behavior, so test Media Gallery first.

FFmpeg stream copy skips decoding and encoding, preserving compressed streams. It is the preferred quality path when codecs already work. [FFmpeg stream copy](https://www.ffmpeg.org/ffmpeg.html#Streamcopy)

For conventional MP4, `+faststart` moves the index to the front in a second pass. Fragmented MP4 puts metadata beside groups of packets and can be read before writing finishes, but FFmpeg documents lower application compatibility. `frag_keyframe` and `default_base_moof` are useful for an isolated streaming experiment. They do not establish Discord compatibility; neither do HLS or DASH support in a browser. Do not replace the validated MP4 output until full playback and seeking pass in Discord. [FFmpeg MOV/MP4 formats](https://ffmpeg.org/ffmpeg-formats.html#mov_002c-mp4_002c-ismv)

## Validation criteria

1. Serve a generated genuine 1920x1080 H.264/AAC fast-start MP4 through the candidate HTTPS endpoint. Send a Media Gallery to GAMBA, measure source-message timestamp to visible playable reply, and inspect Discord's actual range requests. Use a new URL for each cold trial.
2. Run the exact Erome source through the bounded range proxy with no transcoding. Verify complete playback, seek near the end, audio and original dimensions. Measure visible-preview latency and playback startup separately.
3. Repeat with a native 1080p fixture whose size exceeds the ordinary attachment allowance. This distinguishes external-media behavior from the old upload budget. A successful fixture does not settle the exact album's resolution limitation.
4. If Discord requires a complete source first, benchmark a small bounded number of parallel ranges on Hostinger. Validate every `Content-Range`, representation validator and final digest before using assembled bytes. Range support permits the experiment; it does not guarantee aggregate throughput or authorize ignoring a server rate limit.
5. Preserve the actual source dimensions. Include whole-video quality comparisons and CPU time when an encode is needed. Do not count a thumbnail, immediate progress reply, false metadata, cached-only timing or truncated clip as the goal.

No maintained Erome URL-rewrite service was verified in this search. Results identified downloaders and source extractors, which are not evidence of a working Discord embedding provider. The external-gallery experiment addressed delivery separately from encoding; another encoder preset alone cannot eliminate the observed full-file transfer delay.

## Measured follow-up, September 15, 2026

The full source took 37.770 seconds to download from Hostinger. Four parallel byte ranges took 37.656 seconds; eight took 37.668 seconds. The assembled file hashes matched. Range splitting did not improve aggregate throughput, so it was rejected.

A disposable HTTPS relay preserved the source bytes and implemented validated HEAD and single-range GET requests. Its 24 tests passed, including cancellation, body limits, range and validator checks. It served a generated 54,494,052-byte native 1920×1080 H.264/AAC fixture separately from the real Erome source.

Discord's Media Gallery recognized the local fixture as 1920×1080 `video/mp4` by the 6.137-second observation. Playback advanced to 0:20 of 2:40. Relay logs showed two complete Discord downloads, taking 1.390 and 0.961 seconds. This proves the external gallery can handle native 1080p above the ordinary attachment budget. It does not measure an automatic source-message-to-reply flow.

The same gallery failed for the uncached Erome source. Discord cancelled the full GET at 9.897 seconds, after 6,499,896 bytes, and displayed an unavailable-image state. No video metadata appeared during the 60-second observation. A simple streaming relay therefore does not solve the cold-source delay.

Small direct-source probes received HTTP 403 without the album Referer and HTTP 200/206 with it. This rules out handing Discord the raw source URL under the tested request conditions.

The Open Graph page experiment added real per-source posters and supplied the validated dimensions and duration. All 29 relay tests passed. Discord fetched the Erome page and poster quickly, then attempted another full media GET. It cancelled after 9.597 seconds and 6,271,017 bytes. No embed appeared during the 75-second observation. The native 1080p control produced a playable video embed; its complete 54 MB crawler transfer took 0.730 seconds. Playback and seeking to 2:33 of 2:40 both worked, and playback reached the end. Open Graph did not remove the cold-source bottleneck.

All four temporary Discord messages were removed after recording results. The relay container, temporary Caddy route, firewall rule and DNS record were retired. The production bot continued using its existing attachment path.

### HTTP/1.1 versus HTTP/2 on Hostinger

At 06:45:59–06:46:13 UTC, curl 8.5.0 with nghttp2 1.59.0 fetched the same first 4 MiB range sequentially over HTTP/1.1 and HTTP/2. Both requests included the album Referer, accepted only HTTPS, had a 12-second deadline, discarded the response body, and completed successfully. Each response was validated as `206 video/mp4`, `Content-Length: 4194304` and `Content-Range: bytes 0-4194303/25026293`.

| Negotiated protocol | Time to first byte | Complete 4 MiB range | Average bytes/second |
| --- | ---: | ---: | ---: |
| HTTP/1.1 | 0.067 s | 6.376 s | 657,776 |
| HTTP/2 | 0.082 s | 6.390 s | 656,411 |

The reported negotiated protocols were `1.1` and `2`, respectively; the HTTP/2 request did not fall back to HTTP/1.1. The comparison used curl's documented protocol selectors and transfer metrics. [curl manual](https://curl.se/docs/manpage.html#--http2)

Changing protocol did not improve throughput in this measurement. The result rejects HTTP/2 as the next fix for the observed cold-source delay, without claiming to identify the origin's internal rate-control mechanism. No bot or proxy settings were changed. Subsequent regional tests were scheduled after this measurement finished to avoid overlapping transfers.

### Network placement

An isolated, authenticated Vercel preview streamed the fixed public source into a hash counter and returned only small timing reports. Its routes accepted no source URL input and had a 12-second transfer deadline. Requests ran sequentially, including a Hostinger control. The reported execution region was checked before measuring each route; an incorrectly placed Frankfurt attempt was rejected before fetching the source.

Vercel documents per-function placement and exposes the actual runtime region through its system environment. The probe returned timing JSON rather than a media response. [Function regions](https://vercel.com/docs/functions/configuring-functions/region), [system region variable](https://vercel.com/docs/environment-variables/system-environment-variables#vercel_region)

| Execution location | Bytes received before deadline | Elapsed time |
| --- | ---: | ---: |
| Vercel Virginia (`iad1`) | 7,911,406 | 12.004 s |
| Vercel Frankfurt (`fra1`) | 7,752,486 | 12.004 s |
| Vercel London (`lhr1`) | 7,772,944 | 12.005 s |
| Hostinger control | 7,893,452 | 12.005 s |

All four transfers remained incomplete. Only 3.10–3.26 MB arrived in the first five seconds. Moving the fetch did not provide the throughput needed for a complete 25 MB source within the ten-second reply budget. These are measured partial transfers; the roughly 38-second full-fetch estimate is an extrapolation consistent with the earlier complete Hostinger measurement.

The handler's three focused tests and preview builds passed. Both temporary preview deployments were deleted, and the CLI-created temporary protection bypass was revoked. The production Vercel deployment and its aliases remained unchanged.

### Decision

Keep the working attachment path and its existing no-upscaling behavior. Both reported albums expose only 720p video sources; their repeated source tags represent inline and modal players. Do not add resolution-selection logic without an observed higher-quality alternative, and do not advertise these videos as 1080p.

The ten-second cold-preview target remains unmet. A faster source or a previously cached full video would change the transfer constraint. Neither a larger RAM allocation, HTTP/2, parallel ranges, a simple relay, Open Graph metadata nor the tested network locations removed it. The successful native fixture establishes format support, not production completion.
