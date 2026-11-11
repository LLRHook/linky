# Media inside Linky cards

Single LinkedIn and Truth Social video cards use a Components V2 panel: post text above the uploaded video, with author, counts, time and controls. The shared article builder accepts an uploaded MP4 from any article provider, with an optional uploaded author avatar. Automatic reposts, `/fix` and **Apps → Fix with Linky** use it. A missing gallery keeps the automatic source and removes its replacement; a manual response clears media and uploads and retains a V2 notice and original-link controls.

Private manual responses can confirm uploads under Discord's `/ephemeral-attachments/` path as well as `/attachments/`. Both require HTTPS on `cdn.discordapp.com` or `media.discordapp.net`, two 17–20 digit identifiers and the exact prepared filename, without ports or user credentials. Signed CDN query strings are permitted. `tests/uploaded-media.test.ts` covers both paths and their rejection boundaries; `tests/manual-fix.test.ts` covers private slash and Apps video confirmation.

Standalone Erome prepared attachments, including transcoded MP4s and JPEG/PNG images, now put their text and media in one V2 panel too. Hosted Erome originals and additional-item galleries already use V2. Erome media verification requires the matching file, Discord media type, proxy and positive dimensions. Legacy loose attachments also require the prepared byte size. These are Discord metadata checks; they do not establish playback on a client.

## Publication paths and compatibility constraints

This audit covers every media upload publisher in `src/commands` and `src/services`, plus image-card formatters. Source files are references to this implementation, rather than dated production playback evidence.

| Path | Disposition and evidence |
| --- | --- |
| One article-family video card, automatic or manual | Shared V2 panel. `src/services/ArticlePosts.ts:114`, `src/services/SocialLinkService.ts:374`, `src/commands/fix.ts:323`; manual verification and rollback: `src/commands/fixMedia.ts:26`. |
| Standalone Erome prepared attachment | V2 container with text and gallery, for video or image. `src/services/UploadedMedia.ts:4`, `src/services/SocialLinkService.ts:377`, `src/commands/fix.ts:325`; media metadata: `src/services/EromeDelivery.ts:52`. |
| Erome hosted original and Load next item | Existing V2 gallery, unchanged. `src/services/EromeMedia.ts:47`, `src/services/EromeAlbumSessions.ts:154`, `src/commands/fixMedia.ts:127`. |
| Article video or Erome media beside copied source attachments | Keeps legacy attachment delivery: source files may be documents, spoilers or arbitrary media with their own names and descriptions. The single-media panel cannot represent that complete set; this batch preserves source-file integrity instead of silently dropping or reinterpreting them. Selection: `src/services/SocialLinkService.ts:374` and `:377`; copy loop: `:344`. Tests: `tests/social-links.test.ts` “a LinkedIn video beside copied source attachments keeps the card with the video as an attachment”; `tests/erome-delivery.test.ts` “Replace copies source attachments through the attachment path; failed copies keep the original”. |
| Erome beside native fixer links, translated cards or YouTube cards | Keeps legacy content, embeds and attachment so each native preview remains eligible. V2 cannot carry content or embeds; this batch provides no replacement for those other previews. Guards: `src/services/SocialLinkService.ts:377`, `src/commands/fix.ts:325`. Tests include “manual mixed-platform failure is still reported when the Erome upload succeeds”. |
| Multiple article cards, unrelated uploads, or more than 4000 text characters | Keeps the established card and attachment path. The builder intentionally represents only one card with one video and its optional avatar; converting the whole mixed set would require a separate layout. `src/services/ArticlePosts.ts:116`; tests: `tests/article-video.test.ts` “article video blocks retain multi-card, multiple-video, unrelated-upload and text-limit fallbacks”. |
| Suppressed automatic embeds | Keeps the existing suppressed publication path; a V2 gallery would override the sharer's suppression choice. `src/services/SocialLinkService.ts:375` and `:379`. |
| No Attach Files, exhausted upload budget, failed download | No uploaded video; the embed shows the poster and Play video link. Truth Social image cards retain original image addresses when their upload cannot be sent. `src/services/ArticlePosts.ts:72`, `src/services/ArticlePreview.ts:579`. |
| Long X translations | A text attachment preserves the complete translation; it is not loose card media. Photos stay inside embeds and videos retain their native fixer preview. `src/services/TweetPresentation.ts:61`, `:66`, `:148`. |
| Native Discord unfurls, including fixer-domain X/Instagram/TikTok/Facebook and YouTube video players | Discord owns these players. Linky cannot restructure them. They remain outside this change; authored statistics or caption text does not turn the native player into an uploaded bot card. |

Copied source attachments, mixed previews and the other explicit fallbacks above remain compatibility exceptions to a single media panel. They are not claimed as converted. Reply mode leaves source attachments on the original, so an otherwise eligible single-card reply can use the panel.

## Image cards already contain their images

These paths were already correct on baseline `b803f79`. Their image presentation remains unchanged; no new layout was needed. Images are embed images (or, for Erome above, gallery items), rather than loose uploads beside card text. A Truth Social image/avatar upload is referenced from its embed and omitted when it cannot be used.

| Card family | File and line evidence | Named passing test |
| --- | --- | --- |
| Public articles | `src/services/ArticlePreview.ts:763` assigns the full image to the embed `image` field. | `tests/article-preview.test.ts`: “publisher metadata produces a compact attributed card without extracting body prose”. |
| MyAnimeList anime and manga | The catalogue branch at `src/services/ArticlePreview.ts:758` uses the same image field at `:763`. | `tests/article-preview.test.ts`: “the reported MyAnimeList anime uses its synopsis and full-size cover without requiring Article metadata”; “MyAnimeList manga entries use books.book metadata and a Manga label”. |
| LinkedIn image posts | `src/services/LinkedIn.ts:184` embeds the first image; no image upload is required. | `tests/linkedin.test.ts`: “image posts need no upload; pages without matching post JSON-LD keep the generic article card”. |
| Truth Social image posts | `src/services/TruthSocial.ts:277` embeds the first image, using an uploaded `attachment://` URL when available. `src/services/ArticlePosts.ts:88` retains only referenced images or the post video. | `tests/truth-social.test.ts`: “public statuses become one inert card with author, text, first image, counts and time”; “the article lookup requests the public status API and prepares a confirmable card with uploaded media”. |
| YouTube community posts | `src/services/YouTubeCommunity.ts:297` and `:298` put the first and additional full images into embeds. | `tests/youtube-community.test.ts`: “single and multiple image posts choose the largest supplied images and keep source order”. |
| X translation cards | `src/services/TweetPresentation.ts:61` and `:66` put all photos inside embeds; playable videos keep native unfurls. | `tests/social-links.test.ts`: “translated photo cards preserve every photo without repeating the caption”. |

Removing each formatter's image field temporarily makes the corresponding tests fail. The shared article-field mutation fails both article and MyAnimeList assertions. These offline checks establish the requested payload and confirmation behavior, rather than live image rendering on every Discord client.

## Evidence and reproduction

All automated tests use synthetic bytes and injected HTTP/Discord responses, without a Discord token or network requests. Run `node --import tsx --test tests/article-video.test.ts tests/linkedin.test.ts tests/truth-social.test.ts tests/social-links.test.ts tests/manual-fix.test.ts tests/erome-delivery.test.ts` on Node 26. The standalone Erome tests cover both media types and both manual entry points, missing-gallery rollback, and metadata rejection for wrong filename, type, proxy, dimensions or host. The article and manual tests cover exact media matching and source/settings/cancellation races. Run `npm run validate` for the repository's complete local gate. Live Discord rendering and client playback remain separate release checks.
