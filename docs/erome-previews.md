# Erome video previews

Linky prepares the first MP4 video from the first Erome album in a message and uploads it as a reply. It always keeps the original album. The same preparation is used by `/fix` and **Fix with Linky**. Automatic processing requires the existing server/channel scope and the Erome platform switch; all Erome processing requires an age-restricted server channel or a thread whose parent is age-restricted.

## Why an ordinary rewrite fails

Metadata-only checks of the reported album found HTTP 200 HTML with one distinct MP4 but no `og:video`. Its CDN returned 403 for a Discordbot HEAD request without an album Referer, and 200 `video/mp4` with the original album Referer. The reported length was 32,179,163 bytes, above Discord's default 10 MiB file limit. No video or image bytes were retrieved for that investigation.

No maintained rewrite provider was verified. An independently written extractor uses the public album's video-source attributes, validates the CDN URL, and fetches with the album Referer. Linky does not solve challenges, send cookies, follow redirects, or accept arbitrary media hosts. FFmpeg produces a compact MP4 instead of exposing a public proxy.

## Bounds and failure behavior

- Exact HTTPS `erome.com` or `www.erome.com` album links only; profiles, nested URLs, ports and credentials are rejected.
- One bounded HTML fetch and one bounded video fetch; no image, search or related-album requests.
- Up to 64 MiB input and five minutes; output is at most 9 MiB, H.264/AAC, up to 720p.
- One preparation at a time; busy requests fail open instead of forming an unbounded queue.
- Local conversion has fixed arguments, file-only input protocols, process timeouts and private temporary files removed in `finally`.
- Discord must return matching attachment name, size, MP4 content type and video dimensions before an automatic output is accepted. This verifies video metadata, not every client's playback.
- Disabled scope, changed messages, changed age restrictions, missing Attach Files, unavailable/protected media, conversion failure and missing attachment metadata preserve the original.
- Albums with multiple videos show a first-video notice. Image-only albums are not handled.

## Validation

Tests use synthetic HTML, bytes, media metadata and Discord interactions. They cover URL validation, redirected/oversized/failed upstream responses, processing bounds, cleanup, channel restrictions, original preservation and ownership. Runtime validation uses a generated non-sensitive test clip; no adult media is used as a test fixture or posted to a test server.

## Primary technical sources

- [gallery-dl Erome extractor](https://github.com/mikf/gallery-dl/blob/master/gallery_dl/extractor/erome.py): observed album path and source-element layout; no implementation code copied.
- [Discord file uploads](https://docs.discord.com/developers/reference#uploading-files): default per-file limit.
- [Discord message resource](https://docs.discord.com/developers/resources/message): attachments and bot embed limitations.
- [FFmpeg documentation](https://www.ffmpeg.org/ffmpeg.html): bounded local MP4 conversion and stream selection.
- [Debian Bookworm FFmpeg](https://packages.debian.org/bookworm/ffmpeg): maintained runtime package.
