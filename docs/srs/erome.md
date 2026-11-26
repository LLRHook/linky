# Erome requirements — Linky

Related: [SRS index](../SRS.md). ADOPT baseline `1a69229`, 2026-11-26.

Erome is self-host only; public hosted-bot enablement is outside this area. See docs/srs/commands.md for settings and command UI; see docs/srs/core.md for automatic/manual eligibility, Replace/Reply, ownership, shared confirmation/reconciliation, Retry, source preservation, deletion failure, media-job fairness, progress, Details and product-wide security/privacy constraints. This file defines only Erome-specific admission, preparation, album controls and media hosting. Hosted below means an original served by the optional media store, not activation on the public bot.

Delivery is conservatively Implemented from inspected code; this pass runs no application or live-provider tests and claims no Verified requirements. Historical trials in docs/erome-fast-embed-research.md and docs/erome-regional-hosting.md remain dated finite-source observations, not performance targets. No open Erome-only feature ticket is present in features.md; cross-platform evidence and command refactoring belong to ops/commands.

## 3. Requirements

### 3.1 Functions

#### ERO-FR-001 — Operator availability
The system shall admit Erome only in a server enabled by the operator platform and optional Erome server allowlist.

- Priority: Should
- Rationale: Keeps Erome a self-hosted extension
- Source: src/services/EromeAvailability.ts; README.md, Erome self-host only
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/EromeAvailability.ts)
- UI: Discord - automatic/manual unavailable notice
- Acceptance:
  - Given the platform is disabled, the server is outside an explicit allowlist, or the request is a DM, when evaluated, then preparation is unavailable and server preferences cannot override it.
  - Given an omitted allowlist, when Erome is otherwise enabled in a server, then self-host availability is unrestricted; an explicit none admits no servers.
- Traces: ENT-001, API-006, API-007, CMP-024

#### ERO-FR-002 — Saved channel admission
The system shall apply the saved Erome age-restricted channel policy to automatic and manual requests.

- Priority: Should
- Rationale: Uses channel policy without inspecting video content
- Source: src/services/EromeDelivery.ts (canPreviewErome); src/services/EromeAlbumPolicy.ts; docs/erome-previews.md, introduction
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/EromeDelivery.ts (canPreviewErome))
- UI: Discord - Erome channel admission
- Acceptance:
  - Given the default policy, when the channel or thread parent is not age-restricted, then Erome is rejected.
  - Given the all policy, when the server channel or thread parent has a known nsfw boolean, then it is eligible subject to existing permissions; DMs and unknown channels are excluded.
  - Given policy or permissions are revoked during preparation, when publication is attempted, then fresh checks prevent delivery.
- Traces: ENT-001, API-050, CMP-022, CMP-025

#### ERO-FR-003 — Initial album selection
The system shall prepare the first video of the first distinct Erome album in the message or the first supported image if the album has no video.

- Priority: Should
- Rationale: Provides a bounded initial preview
- Source: src/services/EromeAlbum.ts (selectEromeItem); src/services/EromeDelivery.ts (findEromeLinks); README.md, Erome
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/EromeAlbum.ts (selectEromeItem))
- UI: Discord - initial album preview
- Acceptance:
  - Given several albums, when starting a preview, then the first album supplies the first video, or first supported image if no video exists.
  - Given the preview is published, when its text is shown, then all original album links remain available and Original post opens the selected album.
- Traces: API-050, CMP-020, CMP-021, CMP-025

#### ERO-FR-004 — Canonical album parsing
The system shall accept only exact HTTPS erome.com or www.erome.com album paths with a one-to-64-character alphanumeric/underscore album identifier.

- Priority: Should
- Rationale: Prevents arbitrary origin selection
- Source: src/services/EromeAlbum.ts (parseEromeUrl); docs/erome-previews.md, Bounds and failure behavior
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/EromeAlbum.ts (parseEromeUrl))
- UI: none (system-only URL validation)
- Acceptance:
  - Given an accepted /a/identifier path with optional trailing slash, query or fragment, when parsed, then it becomes the canonical www.erome.com album URL without query or fragment.
  - Given profiles, nested paths, ports, credentials or malformed syntax, when parsed, then no album is admitted.
- Traces: API-050, CMP-021

#### ERO-FR-005 — Album media inventory
The system shall extract distinct accepted media only from actual album media containers.

- Priority: Should
- Rationale: Excludes unrelated page assets
- Source: src/services/EromeAlbum.ts (parseEromeItems); docs/erome-previews.md, Bounds and failure behavior
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/EromeAlbum.ts (parseEromeItems))
- UI: none (system-only extraction)
- Acceptance:
  - Given album HTML, when parsed, then only accepted MP4 source tags or JPEG/PNG img-front items within media-group containers enter the inventory.
  - Given avatars, posters, ads, scripts, related albums or duplicate sources, when parsed, then they do not add selectable items; at most 100 accepted descriptors are retained with truncation signalled.
- Traces: API-050, CMP-021

#### ERO-FR-006 — Original video eligibility
The system shall retain original MP4 bytes only when complete-file inspection establishes the original-video profile.

- Priority: Should
- Rationale: Preserves native quality for eligible media
- Source: src/services/VideoAttachment.ts (createOriginalVideoInspector, copyable); docs/erome-previews.md, Optional regional original-video path
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/VideoAttachment.ts (createOriginalVideoInspector, copyable))
- UI: Discord - original-media gallery
- Acceptance:
  - Given a complete MP4 no larger than 24 MiB or 300 seconds, when inspected, then original hosting requires one H.264/yuv420p video with Baseline, Constrained Baseline, Main or High profile, at most one AAC audio stream, and no attached pictures or other streams.
  - Given both average and nominal rates at most 60 fps and native dimensions fitting 1920 by 1080 or 1080 by 1920, when accepted, then bytes are not re-encoded or upscaled; incompatible media falls back.
- Traces: API-053, CMP-076, CMP-029

#### ERO-FR-007 — Regional fallback
The system shall use attachment preparation when original hosting is disabled, incompatible, unavailable, rejected, out of storage capacity or unsuitable for a mixed-platform message.

- Priority: Should
- Rationale: Keeps supported media deliverable through the existing publisher
- Source: src/services/EromeMediaRuntime.ts; src/services/SocialLinkService.ts; src/commands/fixMedia.ts; docs/erome-regional-hosting.md, Delivery and limits
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/EromeMediaRuntime.ts)
- UI: Discord - attachment fallback
- Acceptance:
  - Given any original-hosting rejection with an otherwise eligible request, when fallback runs, then attachment preparation is attempted under its own input and destination limits; failure retains the source.
- Traces: API-051, API-053, CMP-029, CMP-068, CMP-088

#### ERO-FR-008 — Attachment video input
The system shall download only a bounded complete accepted MP4 into the attachment preparer.

- Priority: Should
- Rationale: Rejects partial or wrong-type inputs
- Source: src/services/Erome.ts (createEromePreparer); src/services/VideoAttachment.ts; docs/erome-previews.md, Attachment fallback
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/Erome.ts (createEromePreparer))
- UI: none (background preparation)
- Acceptance:
  - Given a media response, when downloaded, then it must be successful nonredirected video/mp4, no larger than 64 MiB, with exact known-length agreement and a two-minute transfer deadline.
  - Given metadata is complete near the beginning, when conversion supports streaming, then encoding can overlap download; otherwise complete local input is used.
- Traces: API-051, CMP-020, CMP-076

#### ERO-FR-009 — Destination upload budget
The system shall limit a prepared attachment to the destination upload allowance with the implemented reserve and output cap.

- Priority: Should
- Rationale: Avoids uploading results Discord cannot accept
- Source: src/services/AttachmentLimits.ts; src/services/VideoAttachment.ts (normalizeAttachmentLimit); src/commands/fixMedia.ts; docs/erome-previews.md, Attachment fallback
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/AttachmentLimits.ts)
- UI: Discord - preparation/upload outcome
- Acceptance:
  - Given a manual request, when budgeting output, then the interaction allowance is used; automatic requests use the supported default or guild boost allowance, reserving 1 MiB and capping output at 63 MiB (20 MiB default allowance; tier 2 uses 50 MiB and tier 3 uses 100 MiB).
  - Given an invalid allowance or an output above budget, when checked, then it is rejected before upload.
- Traces: API-035, API-051, CMP-008, CMP-076, CMP-088

#### ERO-FR-010 — Complete video conversion
The system shall remux compatible fitting H.264/yuv420p and AAC input or encode a complete non-upscaled MP4 within the upload budget.

- Priority: Should
- Rationale: Balances size and source quality
- Source: src/services/VideoAttachment.ts (argumentsFor, validOutput); docs/erome-previews.md, Attachment fallback
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/VideoAttachment.ts (argumentsFor, validOutput))
- UI: Discord - prepared MP4 attachment
- Acceptance:
  - Given a compatible known-size source fitting the allowance, when converted, then stream-copy is attempted.
  - Given encoding is needed, when converted, then aspect ratio is preserved within landscape/portrait 1080p bounds, smaller sources are not upscaled, and frame rate is not raised; high-cadence encoding caps at 30 fps.
  - Given output cannot retain the complete clip within budget, when validated, then it is rejected rather than truncated; superfast is selected above 1280 by 720 pixels and veryfast otherwise.
- Traces: API-051, CMP-076

#### ERO-FR-011 — Still-image preparation
The system shall retain accepted JPEG or nonanimated PNG source bytes only after exact transport and bounded image inspection.

- Priority: Should
- Rationale: Supports image-only albums without arbitrary image decoding
- Source: src/services/EromeImage.ts; src/services/VideoAttachment.ts (createOriginalImageInspector); docs/erome-previews.md, Bounds and failure behavior
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/EromeImage.ts)
- UI: Discord - image attachment/gallery
- Acceptance:
  - Given an accepted Erome s-number image CDN source, when fetched, then a strong ETag and matching exact MIME and length are required.
  - Given image bytes, when inspected, then at most 8 MiB, 8192 pixels per side and 33554432 total pixels are accepted; APNG and other formats are rejected.
- Traces: API-052, CMP-026, CMP-076

#### ERO-FR-012 — Standalone media panel
The system shall publish a standalone prepared MP4/JPEG/PNG in a Components V2 panel with its album text above the uploaded media.

- Priority: Should
- Rationale: Keeps text and the selected media in one block
- Source: src/services/EromeDelivery.ts; src/services/UploadedMedia.ts; src/services/SocialLinkService.ts; src/commands/fixMedia.ts; docs/erome-previews.md, Text and media together
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/EromeDelivery.ts)
- UI: Discord - Components V2 media panel
- Acceptance:
  - Given a standalone prepared media upload, when automatically or manually published, then its panel contains the matching uploaded media with text above it.
  - Given source files or other native/translated previews must be retained, when published, then the existing attachment delivery preserves them.
- Traces: API-035, CMP-025, CMP-075, CMP-068, CMP-088

#### ERO-FR-013 — Prepared upload verification
The system shall accept a prepared Erome upload only after matching Discord media evidence is returned.

- Priority: Should
- Rationale: Distinguishes accepted media from a missing upload
- Source: src/services/EromeDelivery.ts (verifyEromeAttachment); src/services/UploadedMedia.ts; docs/erome-previews.md, Text and media together
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/EromeDelivery.ts (verifyEromeAttachment))
- UI: Discord - confirmed panel or rollback notice
- Acceptance:
  - Given a loose uploaded file, when confirmed, then its filename, exact byte size, MIME and positive dimensions match.
  - Given uploaded panel media, when confirmed, then it identifies the expected uploaded filename with the required MIME, proxy and positive dimensions; absent matching evidence causes preview rollback, with manual uploads cleared while retaining V2.
- Traces: API-035, API-057, CMP-025, CMP-075

#### ERO-FR-014 — Hosted gallery evidence
The system shall confirm a hosted original against its exact URL, MIME, proxy and native dimensions with the implemented one-pixel tolerance.

- Priority: Should
- Rationale: Allows observed Discord rounding without changing source bytes
- Source: src/services/EromeMedia.ts (matchesMedia); docs/erome-regional-hosting.md, Delivery and limits
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/EromeMedia.ts (matchesMedia))
- UI: Discord - hosted gallery confirmation
- Acceptance:
  - Given returned gallery metadata, when matched, then the exact retained asset URL and MIME and a proxy URL are required.
  - Given expected width/height, when matched in either orientation, then each returned dimension is an integer at least two and differs by at most one pixel; a larger mismatch fails.
- Traces: API-035, CMP-028

#### ERO-FR-015 — Album item expansion
The system shall append one freshly validated next unloaded item to the existing hosted gallery per accepted Load next item action.

- Priority: Should
- Rationale: Offers incremental album viewing
- Source: src/services/EromeAlbumSessions.ts (handle); src/services/EromeAlbumPolicy.ts; docs/erome-previews.md, Shared delivery rules
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/EromeAlbumSessions.ts (handle))
- UI: Discord - Load next item gallery action
- Acceptance:
  - Given a valid session and successful fresh album/selection checks, when Load next item completes, then exactly one next unloaded fingerprint is appended and bound to that message.
  - Given changed album identity, unavailable media or failed verification, when expansion fails, then prior items remain and the newly prepared asset is not retained as a successful append.
- Traces: API-014, API-050, ENT-012, CMP-023, CMP-022

#### ERO-FR-016 — Album actor policy
The system shall permit gallery expansion only after fresh server, channel, member and bot permission checks.

- Priority: Should
- Rationale: Public expansion follows current visibility and send rights
- Source: src/services/EromeAlbumPolicy.ts; docs/erome-previews.md, Shared delivery rules
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/EromeAlbumPolicy.ts)
- UI: Discord - album action or private denial
- Acceptance:
  - Given a viewer with current View Channel and send permission who is not timed out, when current bot Embed Links, Attach Files and send rights and channel policy permit, then expansion may proceed.
  - Given an automatic session, when checked, then automatic scope and platform preference must remain enabled; manual sessions remain subject to operator availability and channel policy.
- Traces: API-014, ENT-001, CMP-022

#### ERO-FR-017 — Album source lifecycle
The system shall validate retained source messages for album actions while allowing a completed Replace gallery to operate without its deleted source.

- Priority: Should
- Rationale: Separates durable gallery ownership from source presence
- Source: src/services/EromeAlbumPolicy.ts; src/services/EromeAlbumSessions.ts; docs/erome-previews.md, introduction
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/EromeAlbumPolicy.ts)
- UI: Discord - gallery lifecycle
- Acceptance:
  - Given a Reply/manual source-bound session, when expanded, then the current source must still contain the canonical album; automatic sources must retain the expected human author and remain eligible.
  - Given a completed Replace session with no retained source binding, when expanded, then its deleted source is not fetched as a prerequisite.
- Traces: API-014, ENT-004, CMP-022, CMP-023

#### ERO-FR-018 — Album session limits
The system shall expire and bound album expansion sessions without deleting retained media solely because the control expires.

- Priority: Should
- Rationale: Bounds interactive album state
- Source: src/services/EromeAlbumSessions.ts; docs/erome-previews.md, Shared delivery rules
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/EromeAlbumSessions.ts)
- UI: Discord - busy, limit and expired notices
- Acceptance:
  - Given ten loaded items or a would-exceed 192 MiB total, when expansion is requested, then no additional item is appended and Original post remains the route to the complete album.
  - Given a 24-hour-old session or restart, when clicked, then the expired notice suggests Fix with Linky on the original album.
  - Given one in-progress expansion, when clicked again, then another preparation is not started; at most 512 sessions exist and idle oldest sessions are evicted at capacity.
- Traces: API-014, ENT-012, CMP-023

#### ERO-FR-019 — Inventory count labels
The system shall label the gallery count as loaded items out of its bounded parsed inventory with a plus sign when truncated.

- Priority: Should
- Rationale: Avoids presenting a bounded parse as the entire remote album
- Source: src/services/EromeMedia.ts (eromeMediaComponents); src/services/EromeDelivery.ts (eromeNotice); docs/erome-previews.md, Shared delivery rules
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/EromeMedia.ts (eromeMediaComponents))
- UI: Discord - gallery inventory notice
- Acceptance:
  - Given item metadata, when displayed, then the unit is distinct accepted items in the selected album and the numerator is loaded gallery items; the denominator is the at-most-100 parsed inventory and gains a plus sign if truncated.
  - Given no item count, when displayed, then the fallback is First of N videos when N is greater than one, otherwise Video preview; N describes accepted distinct video descriptors, not playback success. No statistical baseline, time window or sustained-status claim applies.
- Traces: API-050, CMP-021, CMP-028, CMP-025

### 3.2 Performance requirements

#### ERO-NFR-001 — Album and original transfer bounds
The system shall bound album and original-media transfer work to the implemented transport budgets.

- Priority: Should
- Rationale: Limits origin bandwidth and wait time
- Source: src/services/EromeAlbum.ts; src/services/RegionalDownloader.ts; src/services/RegionalProtocol.ts; docs/erome-previews.md, Bounds and failure behavior
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/EromeAlbum.ts)
- Measure: Album: 10 seconds, 1 MiB HTML, 100 descriptors. Original HEAD: 2 seconds; collector: 10 seconds including HEAD; 10 parts, each at most 4 MiB and 8 seconds; complete original at most 24 MiB. Inspection: 2-second original-video process deadline; these exclude queue, publication and Discord delivery.
- Acceptance:
  - Given a deadline or byte limit is exceeded, when reading, then preparation fails without publishing an incomplete original.
- Traces: API-050, API-053, API-054, CMP-021, CMP-050, CMP-052

#### ERO-NFR-002 — Attachment result cache
The system shall bound successful attachment variants in memory.

- Priority: Should
- Rationale: Avoids repeated conversion while bounding retained bytes
- Source: src/services/Erome.ts (CACHE_TTL_MS, remember); docs/erome-previews.md, Attachment fallback
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/Erome.ts (CACHE_TTL_MS, remember))
- Measure: 32 variants; 128 MiB total; 300000 ms success lifetime; key includes album, selected item and destination budget. Test target: tests/erome.test.ts.
- Acceptance:
  - Given the same canonical album, selection and upload budget, when the cached variant remains valid, then independent attachment builders reuse immutable bytes; failures are not cached.
  - Given entry or byte capacity is exceeded, when remembering success, then oldest entries are evicted.
- Traces: API-051, CMP-020

#### ERO-NFR-003 — Media-server capacity
The system shall bound concurrent HTTP media and claim handling with explicit server deadlines.

- Priority: Should
- Rationale: Limits the public listener resource cost
- Source: src/services/MediaServer.ts; docs/erome-regional-hosting.md, Delivery and limits
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/MediaServer.ts)
- Measure: 8 active media requests; 10 active claims; 20-second maximum request deadline; headers at most 5 seconds and 8192 bytes; 24 headers; 64 connections; 1-second keepalive; claims at most 4096 bytes within 2 seconds.
- Acceptance:
  - Given active read or claim capacity is exhausted, when another request arrives, then HTTP 429 and Retry-After: 1 are returned.
  - Given timeout or a disconnected reader, when serving, then file streaming is aborted and handles are closed.
- Traces: API-021, API-023, CMP-041

### 3.3 Usability requirements

No separate usability NFR: observable album states are specified above and shared interaction behavior is in docs/srs/core.md.

### 3.4 Interface requirements

#### ERO-IR-001 — Validated regional protocol
The system shall accept only protocol-v3 regional jobs with route-bound HMAC and a live one-use bot claim before source access.

- Priority: Should
- Rationale: Prevents replay and arbitrary worker downloads
- Source: src/services/RegionalProtocol.ts; src/services/RegionalWorker.ts; src/services/RegionalDownloader.ts; docs/erome-regional-hosting.md, Delivery and limits
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/RegionalProtocol.ts)
- Acceptance:
  - Given a signed job, when a worker receives it, then route, source, range, validator, expiry and actual execution region must match and a one-use claim must succeed; canonical jobs are at most 4096 bytes, expire within 30 seconds and allow at most 5 seconds of future issue-time skew.
  - Given an absent active job, replay, wrong route/region, old protocol or invalid signature, when checked, then source access is refused.
- Traces: API-023, API-024, API-054, CMP-052, CMP-053, CMP-050

#### ERO-IR-002 — Exact regional source assembly
The system shall assemble originals only from complete validated consecutive source ranges.

- Priority: Should
- Rationale: Rejects changed and partial representations
- Source: src/services/RegionalDownloader.ts; src/services/RegionalHttp.ts; docs/erome-regional-hosting.md, Delivery and limits
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/RegionalDownloader.ts)
- Acceptance:
  - Given an exact size and strong ETag from HEAD, when collected, then ceil(size/10) partitions cover the complete file using nine fixed worker regions and one local part.
  - Given any changed ETag, encoding, range, length or EOF mismatch, when observed, then collection fails and cancels peers; public IPv4 origin DNS is pinned and redirects are rejected.
  - Given a new collector, when admission is uncertain or follows startup, then the eight-second safety gap and any later running-claim extension are respected.
- Traces: API-053, API-054, CMP-050, CMP-051, CMP-052

#### ERO-IR-003 — Stored media reads
The system shall serve only registered complete media assets through exact opaque media paths with GET, HEAD and single-range seeking.

- Priority: Should
- Rationale: A public read must not trigger an origin download
- Source: src/services/MediaServer.ts; docs/erome-regional-hosting.md, Delivery and limits
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/MediaServer.ts)
- Acceptance:
  - Given a retained random asset path and matching extension, when read, then MIME, exact length, SHA-derived ETag, no-store and noindex/nofollow headers describe the saved representation.
  - Given a satisfiable single range, when read, then 206 and exact Content-Range are returned; invalid ranges give 416, missing assets give 404, and unsupported methods give 405.
  - Given URL parameters, arbitrary destinations or unknown paths, when requested, then they cannot select or start an origin fetch; mismatching If-Range serves the complete representation.
- Traces: API-021, ENT-012, CMP-041, CMP-039

#### ERO-IR-004 — Local health isolation
The system shall answer media-listener health checks only for unforwarded loopback clients.

- Priority: Should
- Rationale: Keeps the listener probe local
- Source: src/services/MediaServer.ts; docs/erome-regional-hosting.md, Activation and checks
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/MediaServer.ts)
- Acceptance:
  - Given an unforwarded loopback request, when /healthz is read, then 200 is returned; remote or forwarded requests receive 404.
- Traces: API-022, CMP-041

### 3.5 Logical database requirements

#### ERO-FR-020 — Durable original publication
The system shall save complete inspected assets atomically before exposing their public gallery URLs.

- Priority: Should
- Rationale: Discord receives a saved complete representation
- Source: src/services/MediaAssetStore.ts; src/services/EromeMediaRuntime.ts; docs/erome-regional-hosting.md, Persistent storage and ownership
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/MediaAssetStore.ts)
- UI: none (background storage)
- Acceptance:
  - Given accepted original bytes, when published, then private temporary writes, sync and atomic publication precede the returned random asset URL with byte count and SHA-256 metadata.
  - Given the configured default store is full, when publishing, then referenced assets are not evicted to admit work; defaults are 10 GiB and 4096 assets, with at most 64 message references per asset.
- Traces: ENT-012, API-021, CMP-039, CMP-029

#### ERO-FR-021 — Reference and orphan retention
The system shall retain assets while message references exist and delete final-reference releases through durable deletion intent.

- Priority: Should
- Rationale: Preserves active playback URLs across restart
- Source: src/services/MediaAssetStore.ts; docs/erome-regional-hosting.md, Persistent storage and ownership
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/MediaAssetStore.ts)
- UI: none (background storage lifecycle)
- Acceptance:
  - Given a bound asset, when restarted, then its references survive and it remains retained.
  - Given the last bound preview is removed, when release is observed, then the asset is deleted through recorded intent; an unbound publish expires after 15 minutes with bounded startup, operation and timer cleanup.
  - Given an unsafe, corrupt, linked or unknown store entry, when recovering, then admission is blocked as required while evidence is preserved; failed writes stop mutations until recovery.
- Traces: ENT-012, CMP-039

#### ERO-FR-022 — Original reuse validation
The system shall revalidate public album and source identity before reusing retained original bytes.

- Priority: Should
- Rationale: Avoids publishing an obsolete or changed source as current
- Source: src/services/EromeMediaRuntime.ts; src/services/MediaReuseIndex.ts; docs/erome-previews.md, Optional regional original-video path
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/EromeMediaRuntime.ts)
- UI: none (background reuse)
- Acceptance:
  - Given a recent original, when a fresh request uses it, then current album selection, source validators and locally verified size/hash must agree before publication.
  - Given a persistent reuse index, when bounded, then it holds at most 1024 entries and 2 MiB with seven-day since-use expiry and private salted source identity rather than source URLs.
  - Given recent memory descriptors, when bounded, then at most 64 persist for five minutes; failure of reuse disables reuse without overwriting authority.
- Traces: ENT-013, ENT-012, CMP-040, CMP-029

### 3.6 Design constraints

#### ERO-CON-001 — Optional single-process hosting
The system shall run optional original-media hosting with a single bot/store owner and matching bot/worker protocol behind operator HTTPS routing.

- Priority: Should
- Rationale: Process-local claims and durable files need one authority
- Source: src/config.ts; src/services/EromeMediaRuntime.ts; docs/erome-regional-hosting.md, Operator configuration and Persistent storage and ownership
- Verification: Analysis
- Status: Approved
- Delivery: Implemented (code: src/config.ts)
- Acceptance:
  - Given EROME_MEDIA_ENABLED is absent or false, when configured, then original hosting is disabled and attachments remain the preparation path.
  - Given original hosting is enabled, when started, then validated media base URL, worker configuration, signing key and writable persistent store are required; stopping the listener makes existing URLs unavailable without deleting retained files.
- Traces: ENT-012, API-021, API-024, CMP-003, CMP-029

### 3.7 Software system attributes

#### 3.7.1 Reliability

See docs/srs/core.md for product-wide attributes. Scoped storage, transport and album behavior is specified above.

#### 3.7.2 Availability

See docs/srs/core.md for product-wide attributes. Scoped storage, transport and album behavior is specified above.

#### 3.7.3 Security

See docs/srs/core.md for product-wide attributes. Scoped storage, transport and album behavior is specified above.

#### 3.7.4 Maintainability

See docs/srs/core.md for product-wide attributes. Scoped storage, transport and album behavior is specified above.

#### 3.7.5 Portability

See docs/srs/core.md for product-wide attributes. Scoped storage, transport and album behavior is specified above.

#### 3.7.6 Privacy and compliance

See docs/srs/core.md for product-wide attributes. Scoped storage, transport and album behavior is specified above.

#### 3.7.7 Observability

See docs/srs/core.md for product-wide attributes. Scoped storage, transport and album behavior is specified above.

### 3.8 Supporting information

Verification targets: tests/erome-album.test.ts, tests/erome-availability.test.ts, tests/erome-album-policy.test.ts, tests/erome-album-sessions.test.ts, tests/erome-image.test.ts, tests/erome.test.ts, tests/erome-media-runtime.test.ts, tests/erome-reuse-runtime.test.ts, tests/original-video.test.ts, tests/video-attachment.test.ts, tests/video-runtime.test.mjs, tests/regional-downloader.test.ts, tests/regional-http.test.ts, tests/regional-worker.test.ts, tests/media-asset-store.test.ts, tests/media-reuse-index.test.ts and tests/media-server.test.ts. These are verification targets; they were not executed here. No production playback or latency result is asserted.

## 5. Appendices

### 5.1 Traceability matrix

| Req | Priority | Delivery | Entities | APIs / Events | Components | Verification |
|---|---|---|---|---|---|---|
| `ERO-FR-001` | Should | Implemented | ENT-001 | API-006, API-007 | CMP-024 | Test |
| `ERO-FR-002` | Should | Implemented | ENT-001 | API-050 | CMP-022, CMP-025 | Test |
| `ERO-FR-003` | Should | Implemented | - | API-050 | CMP-020, CMP-021, CMP-025 | Test |
| `ERO-FR-004` | Should | Implemented | - | API-050 | CMP-021 | Test |
| `ERO-FR-005` | Should | Implemented | - | API-050 | CMP-021 | Test |
| `ERO-FR-006` | Should | Implemented | - | API-053 | CMP-076, CMP-029 | Test |
| `ERO-FR-007` | Should | Implemented | - | API-051, API-053 | CMP-029, CMP-068, CMP-088 | Test |
| `ERO-FR-008` | Should | Implemented | - | API-051 | CMP-020, CMP-076 | Test |
| `ERO-FR-009` | Should | Implemented | - | API-035, API-051 | CMP-008, CMP-076, CMP-088 | Test |
| `ERO-FR-010` | Should | Implemented | - | API-051 | CMP-076 | Test |
| `ERO-FR-011` | Should | Implemented | - | API-052 | CMP-026, CMP-076 | Test |
| `ERO-FR-012` | Should | Implemented | - | API-035 | CMP-025, CMP-075, CMP-068, CMP-088 | Test |
| `ERO-FR-013` | Should | Implemented | - | API-035, API-057 | CMP-025, CMP-075 | Test |
| `ERO-FR-014` | Should | Implemented | - | API-035 | CMP-028 | Test |
| `ERO-FR-015` | Should | Implemented | ENT-012 | API-014, API-050 | CMP-023, CMP-022 | Test |
| `ERO-FR-016` | Should | Implemented | ENT-001 | API-014 | CMP-022 | Test |
| `ERO-FR-017` | Should | Implemented | ENT-004 | API-014 | CMP-022, CMP-023 | Test |
| `ERO-FR-018` | Should | Implemented | ENT-012 | API-014 | CMP-023 | Test |
| `ERO-FR-019` | Should | Implemented | - | API-050 | CMP-021, CMP-028, CMP-025 | Test |
| `ERO-NFR-001` | Should | Implemented | - | API-050, API-053, API-054 | CMP-021, CMP-050, CMP-052 | Test |
| `ERO-NFR-002` | Should | Implemented | - | API-051 | CMP-020 | Test |
| `ERO-NFR-003` | Should | Implemented | - | API-021, API-023 | CMP-041 | Test |
| `ERO-IR-001` | Should | Implemented | - | API-023, API-024, API-054 | CMP-052, CMP-053, CMP-050 | Test |
| `ERO-IR-002` | Should | Implemented | - | API-053, API-054 | CMP-050, CMP-051, CMP-052 | Test |
| `ERO-IR-003` | Should | Implemented | ENT-012 | API-021 | CMP-041, CMP-039 | Test |
| `ERO-IR-004` | Should | Implemented | - | API-022 | CMP-041 | Test |
| `ERO-FR-020` | Should | Implemented | ENT-012 | API-021 | CMP-039, CMP-029 | Test |
| `ERO-FR-021` | Should | Implemented | ENT-012 | - | CMP-039 | Test |
| `ERO-FR-022` | Should | Implemented | ENT-013, ENT-012 | - | CMP-040, CMP-029 | Test |
| `ERO-CON-001` | Should | Implemented | ENT-012 | API-021, API-024 | CMP-003, CMP-029 | Analysis |

## Revision history

| Rev | Date | Commit | Mode | Summary |
|---|---|---|---|---|
