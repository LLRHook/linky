# Social requirements — Linky

Related: [SRS index](../SRS.md) · [Data Contracts](../DATA_CONTRACTS.md) · [Architecture](../ARCHITECTURE.md). ADOPT baseline `1a69229`, 2026-11-26.

This file owns per-platform behavior. Eligibility, source preservation, confirmation, attribution, controls, mentions and product-wide outbound/privacy constraints: see docs/srs/core.md. Settings and manual command surfaces: see docs/srs/commands.md. Public reply/comment threads: see docs/srs/replies.md. General article retrieval and shared upload allowances: see docs/srs/articles.md. Operator tools and relay worker deployment: see docs/srs/ops.md.

Delivery is conservative: Implemented means source inspection, not a new runtime or playback check. Verification below is Inspection of the named source and its acceptance behavior. Existing tests are supporting evidence, without a new Verified claim. In-progress feature tickets retain Proposed status despite present implementation. Acceptance marked `(derived, confirm)` is awaiting product-owner confirmation under TBD-SOC-001. Paths in Source are repository-relative; code paths also substantiate Delivery. Original source phrases are retained in quotation marks for this first adoption pass.

### 3.1 Functions

| ID | Priority | Requirement | Rationale | Source | Verification | Status | Delivery | UI | Acceptance | Traces | Tickets |
|---|---|---|---|---|---|---|---|---|---|---|---|
| SOC-FR-001 | Must | The system shall rewrite supported X/Twitter status permalinks to the ordered X provider candidates. | Repair X previews. | README.md §Supported links: “including /i/web/status/ and media paths”; src/services/SocialProviders.ts | Inspection | Approved | Implemented | Discord — preview result | Given a supported status or photo/video subpath, when rewritten, then fixupx.com is preferred and vxtwitter.com is available for recovery. | API-059, CMP-069 | — |
| SOC-FR-002 | Must | The system shall rewrite canonical TikTok video and photo links to tnktok.com. | Repair TikTok previews. | README.md §Supported links: “Videos, photos and mobile share links”; src/services/SocialProviders.ts | Inspection | Approved | Implemented | Discord — preview result | Given a canonical video/photo link, when rewritten, then the same post path is retained on tnktok.com; mobile shares require resolution before identity confirmation. | API-059, CMP-069 | — |
| SOC-FR-003 | Must | The system shall rewrite public Reddit post URLs and deterministic redd.it aliases to vxreddit.com with its legacy switch. | Request the supported provider format. | docs/provider-checks.md §Reddit conventional embeds: “adds ... ?legacy”; src/services/SocialProviders.ts; src/services/MobileShareLinks.ts | Inspection | Approved | Implemented | Discord — preview result | Given a supported permalink or redd.it alias, when normalized, then the post ID is retained and ?legacy precedes any fragment; community/profile indexes and gallery shortcuts remain unchanged. | API-059, API-049, CMP-069, CMP-043 | — |
| SOC-FR-004 | Must | The system shall rewrite Twitch clip permalinks to fxtwitch.seria.moe by clip identity. | Repair clips without broadening support. | README.md §Supported links: “streams and VODs stay unchanged”; src/services/SocialProviders.ts | Inspection | Approved | Implemented | Discord — preview result | Given clips.twitch.tv or a channel /clip/ link, when rewritten, then the same clip is targeted; streams and VODs remain unchanged. | API-059, CMP-069 | — |
| SOC-FR-005 | Must | The system shall rewrite Facebook Reel and page-video permalinks to facebed.com by numeric video identity. | Repair supported public videos. | README.md §Supported links: “photo posts, /watch and fb.watch links stay unchanged”; src/services/SocialProviders.ts | Inspection | Approved | Implemented | Discord — preview result | Given /reel/ID or /page/videos/ID, when rewritten, then that video is targeted; photo, watch and fb.watch URLs remain unchanged. | API-059, CMP-069 | — |
| SOC-FR-006 | Must | The system shall resolve eligible Instagram, TikTok, Reddit and Facebook mobile shares to an allowed post on the same platform before previewing. | Establish exact post identity. | README.md §Supported links: “exact video or photo ID”; src/services/MobileShareLinks.ts | Inspection | Approved | Implemented | Discord — preview result or unchanged source | Given Instagram /share/, TikTok /t/, vm. or vt., Reddit /r/name/s/ or /u/name/s/, or Facebook /share/r/ or /share/v/, when a valid destination resolves, then that post is used; failed, unsafe and over-budget lookups retain the original token. | API-049, CMP-043, CMP-069 | — |
| SOC-FR-007 | Must | The system shall use one fixed rxddit.com redirect fallback for Reddit shares after first-party HTTP 403, 429 or server-error responses. | Recover blocked share resolution. | docs/provider-checks.md §Reddit app-share recovery: “only the original share path”; src/services/MobileShareLinks.ts | Inspection | Approved | Implemented | Discord — preview result or unchanged source | Given a blocked share, when fallback runs, then only the share path without tracking query reaches rxddit.com within the existing hop/time budget, and only a validated public Reddit post proceeds to vxReddit. | API-049, CMP-043 | — |
| SOC-FR-008 | Must | The system shall generate recovery candidates only from the current platform catalogue. | Avoid unsupported provider substitutions. | docs/provider-checks.md candidates table; src/services/SocialProviders.ts: “Catalog order is the preferred delivery order” | Inspection | Approved | Implemented | none (system-only) | Given a supported source, when candidates are generated, then X has fixupx/vxtwitter and Bluesky has bskx/fxbsky, while Instagram, TikTok, Reddit, Twitch and Facebook each have one provider; aliases and Instagram gallery mode are not independent recovery providers. | API-059, CMP-069 | — |
| SOC-FR-009 | Must | The system shall recognize retired Instagram7 and fkinstagram hosts only as identities of earlier previews. | Preserve old-preview recognition. | docs/provider-checks.md §Instagram recovery: “never generated”; src/services/SocialProviders.ts | Inspection | Approved | Implemented | none (system-only) | Given a retired provider URL, when matched, then its earlier post identity can be recognized; new candidates never use a retired host. | API-059, CMP-069 | — |
| SOC-FR-010 | Must | The system shall present an eligible lone X media post as one panel containing author, post and quoted text, and all accepted media. | Keep one coherent media block. | README.md §Supported links: “one block in any language”; src/services/TweetPanel.ts; src/services/TweetPresentation.ts; src/services/SocialLinkService.ts | Inspection | Approved | Implemented | Discord — Components V2 post panel | Given a lone supported X media post, when all own/quoted photos, MP4 videos or GIFs fit ten gallery items and 4000 component-text characters, then one panel contains the content without a second native card; text-only, polls, broadcasts, foreign-host media, excess text/media and multiple links keep the native path. | API-036, API-058, CMP-072, CMP-073, CMP-068 | — |
| SOC-FR-011 | Must | The system shall substitute available English translated tweet text with a source-language label when translation is enabled. | Make non-English tweet text readable. | README.md §Supported links: “translated tweet text replaces the original”; src/services/TweetTranslation.ts; src/services/TweetPresentation.ts | Inspection | Approved | Implemented | Discord — translated text in panel/card/caption | Given enabled translation, when non-English text or a quote has a usable translation, then that part shows translated text and language label, including quotes beneath an empty outer post; English and disabled-translation posts retain original text; failed translation retains the native path. | API-036, CMP-074, CMP-073 | — |
| SOC-FR-012 | Must | The system shall apply the effective server translation preference to server previews and the operator preference to manual DM previews. | Respect translation scope. | README.md §Supported links: “server requests honor ... translate_tweets”; src/services/SocialLinkService.ts; src/commands/fix.ts | Inspection | Approved | Implemented | Discord — automatic/manual translated result | Given an automatic or manual server fix or a manual DM fix, when translation is considered, then the corresponding preference controls it. Setting controls: see docs/srs/commands.md. | ENT-001, API-006, API-007, CMP-068, CMP-074 | — |
| SOC-FR-013 | Must | The system shall retain playable own or directly quoted media in the translated native-preview path. | Preserve video with translated text. | README.md §Supported links: “captions above the native preview”; src/services/TweetPresentation.ts | Inspection | Approved | Implemented | Discord — caption above native preview | Given a translated video ineligible for a panel, when composed, then its caption appears above the native preview; an outer post without own media uses its direct quote media while retaining one link. | API-036, CMP-073, CMP-074 | — |
| SOC-FR-014 | Must | The system shall deliver long tweet translations across bounded cards or a text attachment. | Avoid silently losing translation text. | README.md §Supported links: “Long translations continue across cards or include a text attachment”; src/services/TweetPresentation.ts; src/commands/fix.ts | Inspection | Approved | Implemented | Discord — continuation cards/text attachment | Given text exceeding card space, when delivered, then continuation cards or a text attachment carry it; a manual fix unable to send its required attachment keeps the native preview. | API-006, API-007, CMP-073 | — |
| SOC-FR-015 | Must | The system shall present an eligible lone Instagram post as an author-and-media panel without reading or retaining its caption. | Remove caption noise. | docs/instagram-media.md §How a post is shown: “never reads or keeps the content (caption)”; src/services/InstagramPost.ts; src/services/InstagramPresentation.ts | Inspection | Approved | Implemented | Discord — caption-free post panel | Given a matching Note, valid provider account and offload address for every item, when at most ten items fit a lone-post panel, then the linked author and every photo/video appear without caption. | API-038, CMP-032, CMP-033 | — |
| SOC-FR-016 | Must | The system shall use the caption-free g.oginstagram.com gallery when an Instagram panel cannot be prepared. | Preserve caption-free fallback. | docs/instagram-media.md §How a post is shown: “Every other case uses ... caption-free gallery”; src/services/InstagramPresentation.ts; src/services/SocialProviders.ts | Inspection | Approved | Implemented | Discord — caption-free gallery preview | Given multiple links, copied files, other rich cards, missing offload addresses, excess items or unavailable metadata, when composing, then the gallery is used; legacy /tv/ normalizes to /p/ and a gallery containing post text does not satisfy caption-free confirmation. | API-038, API-059, CMP-033, CMP-069 | — |
| SOC-FR-017 | Must | The system shall present an eligible lone Bluesky image post and its direct quote as one panel from public AppView data. | Show original text and images together. | README.md §Supported links: “display name and @handle linked to the profile”; src/services/BlueskyPost.ts; src/services/BlueskyPanel.ts | Inspection | Approved | Implemented | Discord — Bluesky image panel | Given an unlabelled public post with own/quoted images and matching actor/record-key data, when the panel fits, then author/profile, original text, direct quote text and all accepted images share one panel. | API-039, CMP-009, CMP-010 | — |
| SOC-FR-018 | Must | The system shall use the bskx.app native path for Bluesky posts ineligible for an image panel. | Keep unsupported panel shapes usable. | README.md §Supported links: “Video posts, link cards ... keep the bskx.app card”; src/services/BlueskyPost.ts; src/services/BlueskyPanel.ts; src/services/SocialProviders.ts | Inspection | Approved | Implemented | Discord — native provider card | Given video, link cards, no images, content labels, quotes of quotes, unavailable or oversized data, when panel preparation fails, then the native path remains with fxbsky.app recovery available. | API-039, API-059, CMP-009, CMP-010, CMP-069 | — |
| SOC-FR-019 | Must | The system shall use the platform-specific recovery path for an unconfirmed X, Bluesky or Instagram panel. | Preserve source safety after panel failure. | README.md §Supported links; docs/instagram-media.md §How a post is shown; src/services/SocialLinkService.ts; src/commands/fix.ts | Inspection | Approved | Implemented | Discord — fallback card or Retry notice | Given media unconfirmed within the shared ten-second panel check, when recovering X or Bluesky, then a checked native card replaces the panel (a new reply for manual delivery); Instagram retains the source with Retry guidance and manual original-link controls. Generic confirmation/controls: see docs/srs/core.md. | API-058, CMP-068, CMP-072, CMP-033, CMP-009 | — |
| SOC-FR-020 | Must | The system shall apply eligible X, Instagram and Bluesky panel presentations to explicit manual fixes. | Keep manual presentation consistent. | README.md §Supported links: “behave the same way”; src/commands/fix.ts; src/services/TweetPanel.ts; src/services/InstagramPresentation.ts; src/services/BlueskyPanel.ts | Inspection | Approved | Implemented | Discord — /fix and Apps → Fix with Linky result | Given an eligible manual request, when prepared, then the platform presentation matches automatic delivery. Request limits, private responses and permissions: see docs/srs/commands.md. | API-006, API-007, CMP-072, CMP-033, CMP-009 | — |
| SOC-FR-021 | Must | The system shall retain native YouTube playback for accepted video routes with valid start timestamps. | Preserve the existing player. | README.md §Supported links: “watch, youtu.be, Shorts, live and embed”; src/services/YouTube.ts; src/services/SocialLinkService.ts | Inspection | Approved | Implemented | Discord — native video preview | Given an accepted eleven-character video ID and valid t/start parameter, when normalized, then the same video and valid offset are retained; unsupported shapes do not become API targets. | API-041, CMP-078, CMP-068 | — |
| SOC-FR-022 | Must | The system shall leave native YouTube-only video messages untouched without video API calls in preview-only mode. | Honor optional enrichment. | README.md §Settings: “makes no video API calls”; src/services/YouTube.ts; src/services/SocialLinkService.ts | Inspection | Approved | Implemented | Discord — native preview | Given preview-only mode, when a video is shared, then no statistics lookup starts and the native message remains. | ENT-001, API-041, CMP-078, CMP-068 | — |
| SOC-FR-023 | Must | The system shall attach compact count controls to the native YouTube message when public video statistics are available. | Disclose counts without a second player/card. | README.md §Supported links: “compact counts on buttons”; src/services/YouTube.ts; src/services/YouTubeControls.ts; src/services/YouTubeStats.ts | Inspection | Approved | Implemented | Discord — compact count buttons | Given public embeddable video statistics, when controls are composed, then supplied view/like/comment counts retain zero and integer precision, missing fields are omitted and the player stays native. Compact labels are en-US counts with at most one fractional digit, scoped to the identified video snapshot, with indexed labels for multiple videos; no baseline/sample/noise inference is made from these provider totals. | API-041, API-015, ENT-008, CMP-078, CMP-081, CMP-084 | — |
| SOC-FR-024 | Must | The system shall disclose exact recent YouTube counts privately on an authorized count-control click. | Keep detail optional and current. | README.md §Supported links: “Click counts for exact values”; src/services/YouTubeInteractions.ts; src/services/YouTubeStats.ts | Inspection | Approved | Implemented | Discord — private count detail | Given a matching unexpired bot-message/video record in enabled server/channel scope, when clicked, then the private recent snapshot identifies the video and supplied exact counts; unavailable data produces the private unavailable notice. Counts echo an API snapshot cached at most five minutes, not an estimate from a sample or a comparison with a baseline. | API-015, API-041, ENT-008, CMP-082, CMP-084 | — |
| SOC-FR-025 | Must | The system shall offer a private attributed top-comment excerpt selected by YouTube relevance order in counts-and-comment mode. | Provide optional contextual reading. | README.md §Supported links: “selected by YouTube’s relevance order”; src/services/YouTube.ts; src/services/YouTubeInteractions.ts; src/services/YouTubeControls.ts | Inspection | Approved | Implemented | Discord — Top comment button/private excerpt | Given a usable first relevance-order top-level comment for the video, when clicked, then an excerpt of at most 240 characters with author and video link is shown; missing data omits the button or gives an unavailable notice. The sample is one API-ranked result, with no most-liked, baseline or noise-floor claim; counts-only mode performs no comment request. | API-015, API-041, CMP-078, CMP-081, CMP-082 | — |
| SOC-FR-026 | Must | The system shall preserve native YouTube delivery when optional API enrichment fails. | Keep API availability optional. | README.md §Supported links: “missing API key or failed video lookup leaves ... untouched”; src/services/YouTube.ts; src/services/SocialLinkService.ts | Inspection | Approved | Implemented | Discord — native video without unavailable extras | Given missing key, private/deleted video, timeout or invalid/API failure, when enriching, then delivery stays native; comment failure preserves available counts. | API-041, CMP-078, CMP-068 | — |
| SOC-FR-027 | Must | The system shall remove expired YouTube controls through durable cleanup while preserving the video, source text and unrelated controls. | Limit stale data access and retention. | README.md §Supported links: “expire after 24 hours”; docs/youtube-embedding-research.md §Playback and persistent messages; src/services/YouTubeStats.ts; src/services/YouTubeControls.ts; src/services/YouTubeInteractions.ts | Inspection | Approved | Implemented | Discord — expired controls removed or privately refused | Given 24-hour expiry, when startup/hourly cleanup runs, then only YouTube data controls are removed with legacy suffix/card cleanup supported; failures retry across restart and retire after more than seven days past expiry. Expired/retired records never authorize statistics access even if stale buttons remain; the refusal invites sharing again. | ENT-008, API-015, CMP-084, CMP-081, CMP-082 | — |
| SOC-FR-028 | Must | The system shall render public YouTube /post/ text and image posts from the signed-out page without a video API key. | Support community posts independently. | README.md §Supported links: “creator, text and ordered images”; src/services/YouTubeCommunity.ts | Inspection | Approved | Implemented | Discord — community cards | Given a matching supported community text/image post, when parsed, then creator, text and ordered images appear without video counts or Top comment; polls, quizzes, video attachments, unavailable posts and unknown formats retain the source. | API-042, CMP-080 | — |
| SOC-FR-029 | Must | The system shall prepare up to five distinct community posts within the shared ten-card limit before publishing. | Stay within Discord card capacity. | README.md §Supported links: “Up to five community posts ... ten-card limit”; src/services/YouTubeCommunity.ts; src/services/SocialLinkService.ts; src/commands/fix.ts | Inspection | Approved | Implemented | Discord — combined community preview | Given up to five posts, when every post prepares within the shared card budget, then their cards share a preview; failed preparation or exceeded budget preserves the source. | API-042, API-006, CMP-080, CMP-068 | — |
| SOC-FR-030 | Must | The system shall preserve community/native mixtures with separate-message guidance without community lookup or futile Retry. | Explain unsupported combinations. | README.md §Supported links: “without looking them up or offering a futile Retry”; src/services/YouTubeCommunity.ts; src/services/SocialLinkService.ts; src/commands/fix.ts | Inspection | Approved | Implemented | Discord — split-message guidance | Given community links beside supported fixer or YouTube video links, when locally detected, then the source remains, automatic guidance retains sharer Remove, manual guidance is private and no community lookup occurs. | API-042, API-006, CMP-080, CMP-068 | — |
| SOC-FR-031 | Must | The system shall prepare Truth Social cards from the first usable matching source in direct API, optional relay, eligible archive, then page order. | Recover public post data. | docs/article-previews.md §Truth Social posts: numbered source chain; src/services/ArticlePreview.ts; src/services/TruthSocial.ts | Inspection | Proposed | Implemented | Discord — Truth Social card | Given either supported @user permalink shape, when data is unusable, then the next source is tried within retrieval limits; the archive applies only to its designated account and caches the feed 30 seconds; page placeholder data can trigger one revisit after 1.2 seconds with matched oEmbed author. | API-045, API-046, API-055, CMP-006, CMP-071 | FEAT-1793013312 |
| SOC-FR-032 | Must | The system shall show validated Truth Social author, post text, first image/poster, available counts, time and supported quote/ReTruth attribution. | Preserve post context. | docs/article-previews.md §Truth Social posts; src/services/TruthSocial.ts | Inspection | Proposed | Implemented | Discord — post card | Given usable public matching data, when formatted, then available fields and archive credit appear and in-text links become [link]; private, direct, sensitive, content-warning, removed or mismatched data receives no card. Counts echo the same source snapshot, with missing values omitted and no inferred ranking, baseline or sample metric. | API-045, API-046, CMP-071 | FEAT-1793013312 |
| SOC-FR-033 | Must | The system shall prepare bounded Truth Social first-image, avatar and allowed MP4 uploads with link/poster fallback. | Work around inaccessible image proxies. | docs/article-previews.md §Truth Social posts: “up to 8 MiB ... up to 1 MiB”; src/services/ArticlePreview.ts; src/services/TruthSocial.ts; src/services/ArticlePosts.ts | Inspection | Proposed | Implemented | Discord — uploaded media or poster/Play video | Given allowed media and upload permission/budget, when preparing, then first image is bounded to 8 MiB, avatar to 1 MiB and MP4 to 15 MiB with its own 15-second window and MIME/ftyp validation; failed uploads keep original links or poster/Play video. Further images are disclosed as remaining at source; shared six-upload/16 MiB message allowances: see docs/srs/articles.md. | API-047, CMP-006, CMP-071, CMP-005 | FEAT-1793034185 |
| SOC-FR-034 | Should | The system shall attempt the configured Truth Social relay at most once per source-chain lookup after unusable direct status data. | Support hosts refused by the API. | docs/truth-social-relay.md: “Linky asks the status API first”; src/services/ArticlePreview.ts | Inspection | Proposed | Implemented | none (deploy-config) | Given both relay configuration values, when direct data fails validation, then one authenticated /status/numeric-id request is independently parsed; disabled or failed relay continues the chain. Intended operator authentication versus blanket outbound wording remains TBD-S0-001. | API-055, CMP-006, CMP-071 | FEAT-1793034185 |
| SOC-FR-035 | Must | The system shall prepare public LinkedIn post cards from matching signed-out VideoObject or SocialMediaPosting JSON-LD. | Recover post-specific text/media. | docs/article-previews.md §LinkedIn posts: “@id must name the same /posts/ permalink”; src/services/LinkedIn.ts; src/services/ArticlePreview.ts | Inspection | Proposed | Implemented | Discord — LinkedIn post card | Given /posts/, /feed/update/urn:li:activity: or resolvable lnkd.in shares, when JSON-LD identity matches canonical og:url, then author/profile, post text, title/shared-link title, first image, supplied reactions/comments and time appear; unrelated metadata falls back to ordinary articles. Image/engagement counts echo the parsed post snapshot with unavailable values omitted, without baseline/sample inference. | API-048, CMP-037, CMP-006 | FEAT-1794395496 |
| SOC-FR-036 | Must | The system shall prepare the page-named signed LinkedIn CDN MP4 for upload with poster/Play video fallback. | Enable in-message video. | docs/article-previews.md §LinkedIn posts: “own 15-second window ... at most 15 MiB”; src/services/LinkedIn.ts; src/services/ArticlePreview.ts; src/services/ArticlePosts.ts | Inspection | Proposed | Implemented | Discord — uploaded video or fallback card | Given an approved signed CDN rendition, when downloaded within 15 seconds and 15 MiB with video/mp4 and MP4 header, then it is available for upload; missing Attach Files, exhausted budget or validation failure keeps poster/Play video. The post request strips utm_* and rcm tracking. | API-047, API-048, CMP-037, CMP-006, CMP-005 | FEAT-1794395496 |
| SOC-FR-037 | Should | The system shall publish a lone Truth Social or LinkedIn uploaded video card as a Components V2 panel with text above the video. | Keep video inside its post. | docs/article-previews.md §General video panels; src/services/ArticlePosts.ts; src/services/SocialLinkService.ts; src/commands/fix.ts | Inspection | Proposed | Implemented | Discord — single video panel | Given one MP4 and optional avatar, fitting text and no unrelated uploads/cards, when automatically or manually published, then text, video and counts/time share a panel and the returned video is confirmed; mixed/oversized cases retain embed plus attachment or poster/Play video. Generic failed confirmation: see docs/srs/core.md. | API-047, CMP-005, CMP-068 | FEAT-1794398737 |
| SOC-FR-038 | Must | The system shall apply the Articles platform gate to Truth Social and LinkedIn posts. | Respect shared platform configuration. | README.md §Supported links: “under the same setting”; src/services/ArticlePreview.ts; src/services/SocialLinkService.ts | Inspection | Approved | Implemented | Discord — preview eligibility | Given articles disabled in effective scope, when these posts are shared, then preparation does not bypass that gate. General article retrieval/cache behavior: see docs/srs/articles.md. | ENT-001, CMP-006, CMP-068 | — |
| SOC-FR-039 | Must | The system shall temporarily defer a provider only on repeated distinct-post losses paired with successful alternate previews for the same capability. | Avoid declaring outages from unavailable posts. | README.md §Supported links: “an unavailable post alone does not establish an outage”; src/services/ProviderHealth.ts | Inspection | Approved | Implemented | none (system-only routing decision) | Given three distinct paired losses in 15 minutes, when ordering that provider/caption-free/video mode, then it is deferred two minutes without removing candidates; retries for one post count once. Given no alternate success or insufficient sample, when ordering, then it abstains from degradation. Given cooldown expiry, when probing, then at most one preferred-provider probe per 30 seconds occurs; confirmed success clears state and expired loss evidence clears it. Unit/scope: distinct paired post losses per provider/capability, baseline: alternate success for that same post, noise floor: one validated distinct identity, minimum sample: three; this is routing evidence, not global uptime or sustained service health. | API-059, CMP-049, CMP-069 | — |
| SOC-FR-040 | Could | The system shall support one opt-in target-language pilot selected with willing admins before choosing a locale. | Explore demand beyond English. | docs/product-roadmap.md item 6: “Ask willing admins which language they need” | Inspection | Proposed | Not started | deferred (TBD-SOC-002: locale and pilot control) | Given an approved pilot locale, when translation is requested, then target-keyed caches and availability/quota disclosure preserve the preview on failure (derived, confirm); locale, script variants and UI remain TBD-SOC-002. | CMP-074, CMP-073 | — |

### 3.2 Performance requirements

#### SOC-NFR-001 — Mobile resolution bounds
The system shall bound mobile-share normalization by candidate, concurrency, hop and deadline limits.

- Priority: Must
- Rationale: Keep redirect work finite.
- Source: src/services/MobileShareLinks.ts constants MAX_LINKS, MAX_HOPS, MAX_ACTIVE_RESOLUTIONS, MAX_TIMEOUT_MS; “consumed response-body limit is zero”.
- Verification: Inspection
- Status: Approved
- Delivery: Implemented — src/services/MobileShareLinks.ts
- Measure: At most five candidates per call, eight active resolutions per process, four redirect iterations and 4000 ms per normalizer call; zero response-body bytes consumed.
- Acceptance:
  - Given a cap or deadline reached, when normalization ends, then unresolved tokens remain unchanged (derived, confirm).
- Traces: API-049, CMP-043

#### SOC-NFR-002 — Social metadata cache bounds
The system shall bound X, Instagram and Bluesky post lookups by finite pending sets and expiring memory caches.

- Priority: Must
- Rationale: Coalesce duplicate requests without indefinite retention.
- Source: src/services/TweetTranslation.ts, src/services/InstagramPost.ts, src/services/BlueskyPost.ts constants and create lookup functions; docs/instagram-media.md §How a post is shown: “five minutes ... 30 seconds”.
- Verification: Inspection
- Status: Approved
- Delivery: Implemented — the three cited lookup services
- Measure: Each lookup has at most 100 entries and eight pending keys, success TTL 300000 ms, miss TTL 30000 ms and caller wait limit 20000 ms. Fetch deadline is 5000 ms; response caps are X 1 MiB, Instagram 64 KiB, Bluesky 256 KiB. X retains at most 50000 text characters per cached result.
- Acceptance:
  - Given repeated unexpired keys, when looked up, then requests coalesce or use cache; pending overflow returns no authored-panel data and expires to the platform fallback (derived, confirm).
- Traces: API-036, API-038, API-039, CMP-074, CMP-032, CMP-010

#### SOC-NFR-003 — YouTube API admission
The system shall bound YouTube enrichment through batching, cache reuse and rate/backoff admission.

- Priority: Must
- Rationale: Keep optional enrichment within quota and memory bounds.
- Source: src/services/YouTube.ts createYouTubeLookup; docs/youtube-embedding-research.md: “Avoid retrying quota exhaustion for every incoming link”.
- Verification: Inspection
- Status: Approved
- Delivery: Implemented — src/services/YouTube.ts
- Measure: At most five video IDs per batch, 1000 pending IDs and 1000 cached entries, five-minute cache, 30 API requests per minute and default five-second request timeout. Quota/credential and applicable 400/401/403/429 failures block for one hour; ordinary failures use exponential backoff up to 60 seconds. Comment-specific non-quota 403/404 abstains without that global penalty.
- Acceptance:
  - Given a blocked lookup window, when videos arrive, then API enrichment abstains while native delivery remains available (derived, confirm).
- Traces: API-041, CMP-078

#### SOC-NFR-004 — Community lookup bounds
The system shall bound community-page lookups independently of the video API.

- Priority: Must
- Rationale: Keep public-page work finite without consuming video API quota.
- Source: src/services/YouTubeCommunity.ts createYouTubeCommunityLookup: “bounded concurrency/cache”.
- Verification: Inspection
- Status: Approved
- Delivery: Implemented — src/services/YouTubeCommunity.ts
- Measure: Four pending post keys, 30 new requests per minute, 100 cache entries, success TTL 60000 ms, miss TTL 15000 ms, 2 MiB HTML cap and default 5000 ms deadline (configurable up to 10000 ms). Duplicate subscribers share a request; the final departing subscriber aborts outstanding work.
- Acceptance:
  - Given an admission cap or expired deadline, when looking up a community post, then the lookup abstains; cancelling one subscriber does not cancel another subscriber's shared lookup (derived, confirm).
- Traces: API-042, CMP-080

### 3.3 Usability requirements

No separate social usability metric is evidenced. Per-platform content and private disclosure are specified in §3.1. Shared controls and accessibility scope: see docs/srs/core.md.

### 3.4 Interface requirements

| ID | Priority | Requirement | Rationale | Source | Verification | Status | Delivery | Acceptance | Traces |
|---|---|---|---|---|---|---|---|---|---|
| SOC-IR-001 | Must | The system shall request FxEmbed data by validated numeric status ID and parse supported status text/media before using source or translated text. | Reject malformed or unsupported status payloads. | src/services/TweetTranslation.ts fetchTweetStatus/parseStatus: “Only the public status ID is sent” | Inspection | Approved | Implemented | Given a malformed ID, failed response, unsupported status type, poll, broadcast or external-media payload, when looking up/parsing, then no authored panel or translation is derived; translated non-English parts require usable English text (derived, confirm). | API-036, CMP-074 |
| SOC-IR-002 | Must | The system shall accept Instagram ActivityStreams metadata only for the requested provider shortcode and validated provider account. | Reject unrelated Notes. | docs/instagram-media.md §How a post is shown: “id names the requested shortcode”; src/services/InstagramPost.ts | Inspection | Approved | Implemented | Given an unrelated Note, invalid account or invalid attachment type, when parsed, then panel metadata is rejected; caption content is never copied. | API-038, CMP-032 |
| SOC-IR-003 | Must | The system shall validate Bluesky actor and record-key identities against public AppView data before panel preparation. | Preserve post identity. | src/services/BlueskyPost.ts parseBlueskyThread/fetchBlueskyPost; docs/provider-checks.md: “does not resolve handles to DIDs” | Inspection | Approved | Implemented | Given mismatched identities or invalid approved-CDN image ownership, when parsed, then no panel is prepared (derived, confirm); native confirmation does not infer handle/DID equivalence. | API-039, CMP-010 |
| SOC-IR-004 | Must | The system shall consume public embeddable video statistics and relevance-ordered top-level comment data through YouTube Data API v3. | Use public authoritative video data. | docs/youtube-embedding-research.md §Data API; src/services/YouTube.ts | Inspection | Approved | Implemented | Given foreign/duplicate IDs, private status or explicitly non-embeddable status, when parsing video results, then they are excluded; a selected comment must match the video (derived, confirm). | API-041, CMP-078 |
| SOC-IR-005 | Must | The system shall accept community-page content only for a matching requested post and recognized text/image renderer. | Abstain on changed public formats. | README.md §Supported links: “unrecognized page formats keep their source”; src/services/YouTubeCommunity.ts | Inspection | Approved | Implemented | Given another post or unsupported renderer, when parsing, then extraction abstains instead of guessing content. | API-042, CMP-080 |
| SOC-IR-006 | Should | The system shall validate relayed Truth Social status JSON with the same post/privacy/media parser as direct status JSON. | Keep relay transport from bypassing validation. | docs/truth-social-relay.md: “Linky still validates every field itself”; src/services/TruthSocial.ts; src/services/ArticlePreview.ts | Inspection | Approved | Implemented | Given relayed data with invalid identity, visibility or media paths, when parsed, then it cannot authorize a card (derived, confirm). | API-045, API-055, CMP-071, CMP-006 |
| SOC-IR-007 | Must | The system shall require LinkedIn JSON-LD identity to match the page canonical post before using post fields. | Reject unrelated structured data. | docs/article-previews.md §LinkedIn posts: “same /posts/ permalink”; src/services/LinkedIn.ts | Inspection | Approved | Implemented | Given unrelated JSON-LD or foreign media hosts, when parsed, then those fields are not used for a LinkedIn post card. | API-048, API-047, CMP-037 |

### 3.5 Logical database requirements

#### SOC-CON-001 — Journal controls before publication
The system shall persist YouTube message/video expiry ownership before publishing statistics controls.

- Priority: Must
- Rationale: Make expiry cleanup recoverable after restart.
- Source: docs/youtube-embedding-research.md §Playback and persistent messages: “before adding the controls”; src/services/YouTubeStats.ts.
- Verification: Inspection
- Status: Approved
- Delivery: Implemented — src/services/YouTubeStats.ts
- Acceptance:
  - Given a failed journal save, when controls would be added, then unjournalled data controls are not published (derived, confirm).
- Traces: ENT-008, CMP-084

ENT-008 owns durable YouTube expiry shapes. Other social metadata caches are memory-only; bounds appear in §3.2 and integration contracts rather than invented durable entities.

### 3.6 Design constraints

Product-wide HTTPS/host/credential/redirect/byte restrictions: see docs/srs/core.md. Intended authenticated relay and article-family public retrieval exceptions remain subject to foundation TBD-S0-001; no blanket rule is redefined here. Relay upstream/deployment operation: see docs/srs/ops.md.

### 3.7 Software system attributes

#### 3.7.1 Reliability
Provider routing and optional enrichment abstention are specified above. Generic recovery: see docs/srs/core.md.

#### 3.7.2 Availability
No social-provider uptime or client-playback SLO is evidenced; see docs/srs/core.md.

#### 3.7.3 Security
Product-wide outbound and mention restrictions: see docs/srs/core.md.

#### 3.7.4 Maintainability
The catalogue owns provider identities. No separate maintainability target is evidenced.

#### 3.7.5 Portability
Self-host configuration and worker deployment: see docs/srs/ops.md.

#### 3.7.6 Privacy and compliance
Global privacy rules: see docs/srs/core.md. Cache bounds and YouTube expiry are specified above. No compliance certification is claimed.

#### 3.7.7 Observability
Paired-loss routing evidence is scoped per provider/capability, not global uptime. Recent diagnostic observations and operator reports: see docs/srs/ops.md.

### 3.8 Supporting information

Historical docs/youtube-single-message-layout.md and docs/youtube-embedding-research.md explain the native-player/legacy-controls decision. docs/tiktok-test-analysis-2026-10-12.md describes selected misses and post-identity analysis, not a platform-wide outage or a present availability target. docs/provider-checks.md distinguishes provider metadata, Discord identity/media confirmation and observed client playback; a metadata success cannot certify playback. No external service was queried during this adoption.

Existing tests that can support later verification include tests/social-providers.test.ts, tests/mobile-share-links.test.ts, tests/provider-health.test.ts, tests/tweet-panel.test.ts, tests/tweet-translation.test.ts, tests/instagram-post.test.ts, tests/instagram-panel.test.ts, tests/bluesky-post.test.ts, tests/bluesky-panel.test.ts, tests/youtube.test.ts, tests/youtube-controls.test.ts, tests/youtube-interactions.test.ts, tests/youtube-stats.test.ts, tests/youtube-community.test.ts, tests/truth-social.test.ts and tests/linkedin.test.ts. The CHANGELOG V&V pass remains dated evidence for its stated scope; this pass does not promote every requirement to Verified.

Open corpus-stage, latency/measurement and mutation-coverage tickets span operator/core/replies ownership: see docs/srs/ops.md, docs/srs/core.md and docs/srs/replies.md. The four in-progress Truth Social/LinkedIn feature tickets are retained in the applicable rows above. Pilot locale/script/UI decisions are not inferred from the roadmap.

### 5.1 Traceability matrix

| Req | Priority | Delivery | Entities | APIs / Events | Components | Verification |
|---|---|---|---|---|---|---|
| `SOC-FR-001` | Must | Implemented | — | API-059 | CMP-069 | Inspection |
| `SOC-FR-002` | Must | Implemented | — | API-059 | CMP-069 | Inspection |
| `SOC-FR-003` | Must | Implemented | — | API-059, API-049 | CMP-069, CMP-043 | Inspection |
| `SOC-FR-004` | Must | Implemented | — | API-059 | CMP-069 | Inspection |
| `SOC-FR-005` | Must | Implemented | — | API-059 | CMP-069 | Inspection |
| `SOC-FR-006` | Must | Implemented | — | API-049 | CMP-043, CMP-069 | Inspection |
| `SOC-FR-007` | Must | Implemented | — | API-049 | CMP-043 | Inspection |
| `SOC-FR-008` | Must | Implemented | — | API-059 | CMP-069 | Inspection |
| `SOC-FR-009` | Must | Implemented | — | API-059 | CMP-069 | Inspection |
| `SOC-FR-010` | Must | Implemented | — | API-036, API-058 | CMP-072, CMP-073, CMP-068 | Inspection |
| `SOC-FR-011` | Must | Implemented | — | API-036 | CMP-074, CMP-073 | Inspection |
| `SOC-FR-012` | Must | Implemented | ENT-001 | API-006, API-007 | CMP-068, CMP-074 | Inspection |
| `SOC-FR-013` | Must | Implemented | — | API-036 | CMP-073, CMP-074 | Inspection |
| `SOC-FR-014` | Must | Implemented | — | API-006, API-007 | CMP-073 | Inspection |
| `SOC-FR-015` | Must | Implemented | — | API-038 | CMP-032, CMP-033 | Inspection |
| `SOC-FR-016` | Must | Implemented | — | API-038, API-059 | CMP-033, CMP-069 | Inspection |
| `SOC-FR-017` | Must | Implemented | — | API-039 | CMP-009, CMP-010 | Inspection |
| `SOC-FR-018` | Must | Implemented | — | API-039, API-059 | CMP-009, CMP-010, CMP-069 | Inspection |
| `SOC-FR-019` | Must | Implemented | — | API-058 | CMP-068, CMP-072, CMP-033, CMP-009 | Inspection |
| `SOC-FR-020` | Must | Implemented | — | API-006, API-007 | CMP-072, CMP-033, CMP-009 | Inspection |
| `SOC-FR-021` | Must | Implemented | — | API-041 | CMP-078, CMP-068 | Inspection |
| `SOC-FR-022` | Must | Implemented | ENT-001 | API-041 | CMP-078, CMP-068 | Inspection |
| `SOC-FR-023` | Must | Implemented | ENT-008 | API-041, API-015 | CMP-078, CMP-081, CMP-084 | Inspection |
| `SOC-FR-024` | Must | Implemented | ENT-008 | API-015, API-041 | CMP-082, CMP-084 | Inspection |
| `SOC-FR-025` | Must | Implemented | — | API-015, API-041 | CMP-078, CMP-081, CMP-082 | Inspection |
| `SOC-FR-026` | Must | Implemented | — | API-041 | CMP-078, CMP-068 | Inspection |
| `SOC-FR-027` | Must | Implemented | ENT-008 | API-015 | CMP-084, CMP-081, CMP-082 | Inspection |
| `SOC-FR-028` | Must | Implemented | — | API-042 | CMP-080 | Inspection |
| `SOC-FR-029` | Must | Implemented | — | API-042, API-006 | CMP-080, CMP-068 | Inspection |
| `SOC-FR-030` | Must | Implemented | — | API-042, API-006 | CMP-080, CMP-068 | Inspection |
| `SOC-FR-031` | Must | Implemented | — | API-045, API-046, API-055 | CMP-006, CMP-071 | Inspection |
| `SOC-FR-032` | Must | Implemented | — | API-045, API-046 | CMP-071 | Inspection |
| `SOC-FR-033` | Must | Implemented | — | API-047 | CMP-006, CMP-071, CMP-005 | Inspection |
| `SOC-FR-034` | Should | Implemented | — | API-055 | CMP-006, CMP-071 | Inspection |
| `SOC-FR-035` | Must | Implemented | — | API-048 | CMP-037, CMP-006 | Inspection |
| `SOC-FR-036` | Must | Implemented | — | API-047, API-048 | CMP-037, CMP-006, CMP-005 | Inspection |
| `SOC-FR-037` | Should | Implemented | — | API-047 | CMP-005, CMP-068 | Inspection |
| `SOC-FR-038` | Must | Implemented | ENT-001 | — | CMP-006, CMP-068 | Inspection |
| `SOC-FR-039` | Must | Implemented | — | API-059 | CMP-049, CMP-069 | Inspection |
| `SOC-FR-040` | Could | Not started | — | — | CMP-074, CMP-073 | Inspection |
| `SOC-NFR-001` | Must | Implemented | — | API-049 | CMP-043 | Inspection |
| `SOC-NFR-002` | Must | Implemented | — | API-036, API-038, API-039 | CMP-074, CMP-032, CMP-010 | Inspection |
| `SOC-NFR-003` | Must | Implemented | — | API-041 | CMP-078 | Inspection |
| `SOC-NFR-004` | Must | Implemented | — | API-042 | CMP-080 | Inspection |
| `SOC-IR-001` | Must | Implemented | — | API-036 | CMP-074 | Inspection |
| `SOC-IR-002` | Must | Implemented | — | API-038 | CMP-032 | Inspection |
| `SOC-IR-003` | Must | Implemented | — | API-039 | CMP-010 | Inspection |
| `SOC-IR-004` | Must | Implemented | — | API-041 | CMP-078 | Inspection |
| `SOC-IR-005` | Must | Implemented | — | API-042 | CMP-080 | Inspection |
| `SOC-IR-006` | Should | Implemented | — | API-045, API-055 | CMP-071, CMP-006 | Inspection |
| `SOC-IR-007` | Must | Implemented | — | API-048, API-047 | CMP-037 | Inspection |
| `SOC-CON-001` | Must | Implemented | ENT-008 | — | CMP-084 | Inspection |

## Revision history

| Rev | Date | Commit | Mode | Summary |
|---|---|---|---|---|
| 1 | 2026-11-26T15:31:28-05:00 | b7bd5580c7db | ADOPT | SOC-FR-001 through SOC-FR-040; SOC-NFR-001 through SOC-NFR-004; SOC-IR-001 through SOC-IR-007; SOC-CON-001 |
