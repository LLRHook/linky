# Erome video previews

Linky prepares the first MP4 video from the first Erome album in a message and posts a reply. Optional regional hosting serves an eligible original file in a media gallery; the existing attachment path handles other inputs. Both keep the original album and support `/fix` and **Fix with Linky**. Automatic processing requires the existing server/channel scope and the Erome platform switch.

The server preference `eromeChannels` defaults to `age-restricted`: Erome requires an age-restricted channel or a thread whose parent is age-restricted. Admins with Manage Server permission can select `/settings erome_channels:all` to allow ordinary server channels and their threads. This does not change automatic channel enablement, platform switches or permissions. DMs and unknown channels remain excluded. Manual previews use the same saved server policy, even for a personally installed command. The policy is checked again after preparation, so a revoked permission prevents an upload in an ordinary channel. Linky does not classify video content.

## Why an ordinary rewrite fails

Metadata-only checks of the reported album found HTTP 200 HTML with one distinct MP4 but no `og:video`. Its CDN returned 403 for a Discordbot HEAD request without an album Referer, and 200 `video/mp4` with the original album Referer. The reported length was 32,179,163 bytes, too large for an unboosted server attachment. No video or image bytes were retrieved for that investigation.

No maintained rewrite provider was verified. An independently written extractor uses the public album's video-source attributes, validates the CDN URL, and fetches with the album Referer. Linky does not solve challenges, send cookies, follow redirects, or accept arbitrary media hosts. The attachment path produces a local MP4. Regional hosting serves only complete registered files; a public media request cannot start an Erome download.

## Bounds and failure behavior

Only exact HTTPS `erome.com` or `www.erome.com` album links are accepted; profiles, nested URLs, ports and credentials are rejected. Album lookup has a 10-second deadline and selects the first video. There are no image, search or related-album requests.

### Optional regional original-video path

- The complete source must be at most 24 MiB and five minutes, with H.264/yuv420p video, at most one AAC audio stream when audio is present, and no extra streams or attached pictures. Baseline, Constrained Baseline, Main and High video profiles are accepted. Average and nominal frame rates must be at most 60 fps, and the native dimensions must fit 1920×1080 or 1080×1920. No re-encoding or upscaling occurs.
- A two-second HEAD request establishes the exact size and strong ETag. Ten disjoint ranges then cover the file: nine fixed Vercel regions and one Hostinger request. At the 24 MiB source limit, each range is about 2.4 MiB; the 4 MiB hard cap and eight-second range deadline also apply. The collector has a ten-second overall deadline including HEAD. Only one collector job is admitted at a time. These transfer limits exclude album lookup, queueing, inspection, storage and Discord delivery.
- Workers require an HMAC-signed job for their fixed route and a live, one-use claim from the bot before fetching. Origin DNS results must be public IPv4 addresses and are pinned for the connection. Exact range, length, ETag, identity encoding and EOF checks reject changed or incomplete bytes. Failure cancels peer transfers; workers have their own deadline if the collector disconnects.
- Hostinger assembles and inspects the complete file, then atomically saves it before posting a random media URL. The public server provides GET, HEAD and single-range seeks for stored assets only. Workers may stream their bounded parts to Hostinger, but Discord never receives an incomplete stored file.
- The dedicated store holds at most 10 GiB and 4,096 files, with at most 64 message references per asset. Referenced files survive restarts and are not evicted to admit another video. Unknown files or unsafe storage block new admissions. Removing the final bound preview releases its asset; unbound publishes expire after 15 minutes, with bounded cleanup during startup, operations and a timer.
- Recent successful originals can be reused by album for five minutes, with at most two cached asset references and eight consumers per shared job. The complete bytes remain in the persistent store. Larger, incompatible, unavailable or rejected regional preparations use the attachment path. Mixed-platform messages also use the existing attachment publisher.

The feature defaults off. See [regional hosting and live-test status](erome-regional-hosting.md) for configuration and the limits of the experimental timings.

### Attachment fallback

- One video fetch accepts up to 64 MiB input and five minutes, with a two-minute download deadline. MP4 files with complete metadata near the beginning can encode while downloading; other layouts use a complete local file. A preview can still take more than a minute.
- Output normally reserves 1 MiB below the destination's upload allowance, capped at 63 MiB. Manual requests use Discord's interaction allowance; automatic requests use the documented default or server boost tier. Invalid allowances and oversized results are rejected before upload.
- Compatible H.264/yuv420p video and AAC audio up to 1080p can be remuxed without re-encoding when the source has a known size and fits. Otherwise the encoder preserves source resolution and aspect ratio up to 1920×1080, or 1080×1920 for portrait video, without upscaling smaller sources. It avoids raising the source frame rate. Compression can reduce quality; it never truncates a clip to fit.
- Requests share an attachment job when the canonical album and output budget match. Each consumer receives independent attachment bytes and metadata. At most two successful variants, 128 MiB total, stay in memory for five minutes; failures are not cached. Different upload budgets use separate variants. This attachment cache clears on restart.
- Local conversion uses fixed arguments, file/pipe-only protocols, process timeouts and private temporary files. Downloads are spooled to the bounded temporary mount; subprocesses and stream work finish or are cancelled before cleanup. FFmpeg never receives an external URL, cookies or bot credentials.

### Shared delivery rules

One preparation runs at a time across servers and manual commands; up to two other jobs wait in arrival order for at most five minutes. Waiting jobs do not fetch or retain video bytes. A full queue or expired wait leaves the original untouched. Channel policy, source edits and delivery permissions are checked again before accepting the result. Attach Files remains required so attachment fallback is available.

The original album is always kept. The original sharer owns **Remove** for an automatic preview, and the requester owns it for a manual preview; regional media uses these same controls. The first-video notice remains when an album has more videos. Image-only albums are not handled. An uncertain Discord POST is reconciled once without automatically submitting the same preview again.

Manual attachment previews report processing progress without blocking shared preparation. Attachment delivery checks Discord's returned file metadata. Gallery delivery checks the returned message and Discord's video type, dimensions and proxy metadata. Neither check proves playback in every client. Failed preparation or delivery preserves the source message.

## Validation

Automated tests use synthetic HTML, bytes, media metadata and Discord interactions. They cover URL validation, redirected/oversized/failed upstream responses, processing bounds, cleanup, channel restrictions, original preservation and ownership. FFmpeg runtime tests use generated non-sensitive clips.

Regional tests additionally cover HMAC and one-use claims, ten-part assembly, rejection of older protocol versions, stalled reads and cancellation races, original-file inspection, persistent quotas and references, and HTTP file serving. The [hosting guide](erome-regional-hosting.md#measured-results-and-pending-validation) records both the experiments with an already resolved source and the generic six- and eight-location trials. Validation of the ten-location candidate and activation in the hosted bot are pending.

A Hostinger reproduction of the album reported in GAMBA found that the 32 MB music video downloaded successfully in about 51 seconds. The original 30-second video deadline rejected it before conversion. Regression tests now cover a progressing transfer beyond 30 seconds and cancellation at the two-minute deadline. Channel eligibility is checked independently before any media request.

A later live test reproduced a second failure: an automatic preview in GAMBA occupied the preparer while a manual preview in kruski klowns was rejected immediately. The bounded queue lets overlapping requests wait instead. Tests cover ordering across preparer instances, capacity, expired waits and recovery after a failed job.

On September 15, 2026, an isolated Hostinger comparison used identical source bytes for a 160-second, 1280×720 music video at 23.976 fps. Sequential download and the old 9 MiB encoder took 82.7 seconds; overlapping download and encoding with a 19 MiB budget took 42.2 seconds. The latter spent 41.1 seconds downloading. Output grew from 8.7 MB to 18.9 MB, and whole-video SSIM against the source improved from 0.8264 to 0.9485 after aligning both outputs to the same comparison frame rate. This measures one clip's similarity and preparation time, excluding Discord upload and playback startup; other sources and server load can differ.

A separate 49 MiB allowance test completed in 39.2 seconds including download. Its video and audio stream hashes matched the original exactly after remuxing. Remuxing an already downloaded copy of the same source took 1.5 seconds. Actual-FFmpeg regression tests also check full decoding, streamed and file input, remux fidelity, cancellation and frame timing.

The native-1080p fallback was compared on the same Hostinger server in an isolated, network-free container limited to two CPUs. A generated 160-second, 1920×1080 source with 3,840 frames and AAC audio exceeded the 19 MiB output budget. These results measure encoding only, excluding download and Discord delivery:

| Output and preset | Encode time | Output bytes | Whole-video SSIM |
| --- | ---: | ---: | ---: |
| Previous 720p, veryfast | 40.638 s | 19,305,120 | 0.971632 |
| Native 1080p, superfast | 41.890 s | 19,304,428 | 0.980011 |
| Native 1080p, ultrafast | 29.727 s | 19,294,235 | 0.971281 |

Each result kept all frames and 160 seconds of audio. The quality comparison aligned the 720p output to the original's dimensions only inside the metric calculation; delivered videos are never upscaled. The superfast preset improved similarity with a 3.1% encoding-time increase in this run. Ultrafast reduced quality and was rejected. An earlier native-1080p veryfast run scored 0.981950 but took 56.077 seconds. Linky therefore uses superfast for sources with more pixels than 1280×720, while smaller sources keep veryfast. This synthetic sample supports that choice, but does not establish quality or latency for every video. The reported 720p album still needs roughly 38–41 seconds to download.

Channel-policy tests cover default behavior, explicit ordinary-channel permission, threads, separate server settings, persistence, non-admin rejection, unchanged channel/platform scope and revocation during preparation. Before rolling back to a version without this setting, remove the `eromeChannels` key from saved server preferences while the bot is stopped: older releases deliberately reject unknown preference keys.

## Primary technical sources

- [gallery-dl Erome extractor](https://github.com/mikf/gallery-dl/blob/master/gallery_dl/extractor/erome.py): observed album path and source-element layout; no implementation code copied.
- [Discord file uploads](https://docs.discord.com/developers/reference#uploading-files): default per-file limit.
- [Discord message resource](https://docs.discord.com/developers/resources/message): attachments and bot embed limitations.
- [FFmpeg documentation](https://www.ffmpeg.org/ffmpeg.html): bounded local MP4 conversion and stream selection.
- [Debian Bookworm FFmpeg](https://packages.debian.org/bookworm/ffmpeg): maintained runtime package.
