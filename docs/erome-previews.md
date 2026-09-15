# Erome video previews

Linky prepares the first MP4 video from the first Erome album in a message and uploads it as a reply. It always keeps the original album. The same preparation is used by `/fix` and **Fix with Linky**. Automatic processing requires the existing server/channel scope and the Erome platform switch.

The server preference `eromeChannels` defaults to `age-restricted`: Erome requires an age-restricted channel or a thread whose parent is age-restricted. Admins with Manage Server permission can select `/settings erome_channels:all` to allow ordinary server channels and their threads. This does not change automatic channel enablement, platform switches or permissions. DMs and unknown channels remain excluded. Manual previews use the same saved server policy, even for a personally installed command. The policy is checked again after preparation, so a revoked permission prevents an upload in an ordinary channel. Linky does not classify video content.

## Why an ordinary rewrite fails

Metadata-only checks of the reported album found HTTP 200 HTML with one distinct MP4 but no `og:video`. Its CDN returned 403 for a Discordbot HEAD request without an album Referer, and 200 `video/mp4` with the original album Referer. The reported length was 32,179,163 bytes, too large for an unboosted server attachment. No video or image bytes were retrieved for that investigation.

No maintained rewrite provider was verified. An independently written extractor uses the public album's video-source attributes, validates the CDN URL, and fetches with the album Referer. Linky does not solve challenges, send cookies, follow redirects, or accept arbitrary media hosts. FFmpeg produces a compact MP4 instead of exposing a public proxy.

## Bounds and failure behavior

- Exact HTTPS `erome.com` or `www.erome.com` album links only; profiles, nested URLs, ports and credentials are rejected.
- One bounded HTML fetch and one bounded video fetch; no image, search or related-album requests. Album lookup has a 10-second deadline and video download has a two-minute deadline. MP4 files with complete metadata near the beginning can encode while downloading; other layouts use a complete local file. A preview can still take more than a minute.
- Up to 64 MiB input and five minutes. Output normally reserves 1 MiB below the destination's upload allowance, capped at 63 MiB. Manual requests use Discord's interaction allowance; automatic requests use the documented default or server boost tier. Invalid allowances and oversized results are rejected before upload.
- Compatible H.264/yuv420p video and AAC audio up to 1080p can be remuxed without re-encoding when the source has a known size and fits. Otherwise the encoder preserves aspect ratio up to 720p, avoids raising the source frame rate, and uses the output budget for video and audio. It never truncates a clip to fit.
- One preparation job at a time across servers and manual commands. Up to two other jobs wait in arrival order, each for at most five minutes. Queued jobs do not fetch or retain video bytes until their turn. A full queue or expired wait leaves the original untouched.
- Requests for the same canonical album and output budget share one job, with at most eight consumers per job. Different budgets use separate variants. Each consumer receives independent attachment bytes and metadata. Successful previews are cached only in memory: at most two entries, 128 MiB total and five minutes from completion, with timed eviction. Failures are not cached. Channel eligibility and output allowance are still checked separately for each delivery.
- Manual previews report waiting, downloading, preparation or reuse of a recent preview. Progress edits are serialized for each interaction and finish before its final response; they do not block shared preparation.
- Local conversion has fixed arguments, file/pipe-only protocols, process timeouts and private temporary files. Downloads are spooled to the bounded temporary mount; subprocesses and stream work finish or are cancelled before cleanup. FFmpeg never receives an external URL, cookies or bot credentials.
- Discord must return matching attachment name, size, MP4 content type and video dimensions before an automatic output is accepted. This verifies video metadata, not every client's playback.
- Disabled scope, changed messages, revoked channel eligibility, missing Attach Files, unavailable/protected media, conversion failure and missing attachment metadata preserve the original.
- Albums with multiple videos show a first-video notice. Image-only albums are not handled.

## Validation

Tests use synthetic HTML, bytes, media metadata and Discord interactions. They cover URL validation, redirected/oversized/failed upstream responses, processing bounds, cleanup, channel restrictions, original preservation and ownership. Runtime validation uses a generated non-sensitive test clip; no adult media is used as a test fixture or posted to a test server.

A Hostinger reproduction of the album reported in GAMBA found that the 32 MB music video downloaded successfully in about 51 seconds. The original 30-second video deadline rejected it before conversion. Regression tests now cover a progressing transfer beyond 30 seconds and cancellation at the two-minute deadline. Channel eligibility is checked independently before any media request.

A later live test reproduced a second failure: an automatic preview in GAMBA occupied the preparer while a manual preview in kruski klowns was rejected immediately. The bounded queue lets overlapping requests wait instead. Tests cover ordering across preparer instances, capacity, expired waits and recovery after a failed job.

On September 15, 2026, an isolated Hostinger comparison used identical source bytes for a 160-second, 1280×720 music video at 23.976 fps. Sequential download and the old 9 MiB encoder took 82.7 seconds; overlapping download and encoding with a 19 MiB budget took 42.2 seconds. The latter spent 41.1 seconds downloading. Output grew from 8.7 MB to 18.9 MB, and whole-video SSIM against the source improved from 0.8264 to 0.9485 after aligning both outputs to the same comparison frame rate. This measures one clip's similarity and preparation time, excluding Discord upload and playback startup; other sources and server load can differ.

A separate 49 MiB allowance test completed in 39.2 seconds including download. Its video and audio stream hashes matched the original exactly after remuxing. Remuxing an already downloaded copy of the same source took 1.5 seconds. Actual-FFmpeg regression tests also check full decoding, streamed and file input, remux fidelity, cancellation and frame timing.

Channel-policy tests cover default behavior, explicit ordinary-channel permission, threads, separate server settings, persistence, non-admin rejection, unchanged channel/platform scope and revocation during preparation. Before rolling back to a version without this setting, remove the `eromeChannels` key from saved server preferences while the bot is stopped: older releases deliberately reject unknown preference keys.

## Primary technical sources

- [gallery-dl Erome extractor](https://github.com/mikf/gallery-dl/blob/master/gallery_dl/extractor/erome.py): observed album path and source-element layout; no implementation code copied.
- [Discord file uploads](https://docs.discord.com/developers/reference#uploading-files): default per-file limit.
- [Discord message resource](https://docs.discord.com/developers/resources/message): attachments and bot embed limitations.
- [FFmpeg documentation](https://www.ffmpeg.org/ffmpeg.html): bounded local MP4 conversion and stream selection.
- [Debian Bookworm FFmpeg](https://packages.debian.org/bookworm/ffmpeg): maintained runtime package.
