# Delivery, progress and private details

Linky keeps an original message until its replacement is useful and ownership is saved. Automatic Erome previews follow the server's Replace or Reply mode; the repost preserves the album URL and **Original post** access. Manual fixes and retries keep the source. Discord preview metadata confirms the type and dimensions of media; it does not prove playback on a particular device.

## What members see

Quick requests publish directly. Slower media requests show the current stage, such as checking the album, waiting for a preparation slot, downloading or preparing compatible media. Updates are coalesced and rate-limited; they do not invent a completion percentage or arrival time. An automatic request edits its single progress reply into the result. An explicit `/fix` request updates its existing response.

**Details** on a public server preview opens a private report for anyone who can see and click it. It shows the delivery outcome and stage timings. Timings can overlap when downloading and conversion run together, and a request that joins shared work measures from the time it joins. The button is exposed only after its requester, message, channel and server binding is saved. The exact bot message, channel and server must still match. Details on private replies and DMs stay restricted to their requester. `/diagnose` remains a separate Manage Server tool for settings and permissions.

An unavailable preview keeps its original. Where ownership can be saved, automatic failures offer **Retry preview**; any channel member with current view/send permission who is not timed out can retry. A shared retry keeps the original attribution and Remove ownership, and the existing per-source cooldown still applies. **Remove** remains restricted to the original sharer for automatic previews and the requester for manual previews. Discord's native moderation is unchanged.

## Mention notifications

Fresh automatic Replace allows only user tags that appear in the source text and are present in Discord's source `mentions.users` metadata. Attribution, reply excerpts, translated/provider text, roles and `@everyone`/`@here` never add recipients. Tags in code, escaped tags and spoiler tags remain quiet. Provider fallback edits retain the original allowed-user list.

Reply mode, manual fixes, retries and refreshes do not add mention notifications. Linky preserves the source message's `@silent` setting. Recipient notification settings still apply, and the original message can notify before the replacement, so exactly one alert is not guaranteed.

## Preview detection and provider recovery

The ordinary-preview watcher subscribes to the existing Discord Gateway before publishing or editing. A useful early update can finish verification immediately. If the update is missed, Linky waits up to four seconds and performs one bounded REST reconciliation. Watchers have capacity and lifetime limits and close on cancellation. This replaces repeated polling; it cannot make a third-party provider render faster.

Health-based ordering requires three distinct posts for which a provider failed and a catalogued alternative demonstrably succeeded. Repeated retries of one unavailable post do not qualify. Canonical source URLs and delayed embeds from a prior provider can establish useful delivery but do not credit the new provider. Capability modes remain separate, including caption-free translated previews and known video requirements. Deprioritization is temporary, with limited recovery probes; fallback candidates are never removed. Platforms with only one verified provider still have no automatic alternate.

## Scheduling and reuse

One server cannot fill every media preparation slot. Queued work rotates between servers and stays in arrival order within each server. At most one job per server runs, with eight waiting jobs globally and two per server. Compatible profiles let one original-media job overlap one attachment job from a different server. The original profile reserves 24 MiB of temporary capacity; the attachment profile reserves 128 MiB, against a shared 192 MiB budget below Docker's 256 MiB temporary mount. These are preparation limits, not a total process-memory bound.

The Discord delivery attempt has a two-minute deadline including queue time. Cancellation does not release encoder capacity until the process exits and its temporary files are cleaned. Failed cleanup blocks further admission instead of reusing uncertain capacity. Media work also retains its lower-level network, byte, duration and decoding limits. No extra regional requests are speculatively raced: the deployed version-three protocol still requires all ten disjoint parts.

Attachment reuse holds up to 32 successful variants for five minutes, with a 128 MiB byte limit. Variants distinguish album, selected item and destination upload budget. Independent attachment objects share prepared bytes; Discord still constructs its own upload bodies. Failed preparation is not cached. This short-lived cache can serve a recently prepared attachment without another source lookup.

Hosted originals use a small memory index and a persistent index of at most 1,024 entries, 2 MiB and seven days since use. A fresh request reopens the public album and verifies that the selected item, strong ETag, exact length and media type still match. It also checks the stored asset. A persistent index entry alone never permits reuse, fetches a private album or keeps an asset alive. Index keys are salted hashes; raw source URLs are not stored there. Assets still have their independent message-reference lifecycle.

See the [controlled scheduling benchmark](../benchmarks/erome-scheduling.md) for measured gains and costs. Its transport latency is simulated; it is not a live regional speed guarantee. More RAM permits useful bounded caches, but bandwidth and encoding still determine many first-request delays.

## Additional album items

An eligible hosted album starts with its first video, or its first supported image when no video exists. **Load next item** prepares one remaining item on demand and appends it to the same gallery. It never downloads the entire album in advance. The person clicking must still be able to view and send in the channel and must not be timed out; Linky rechecks source availability, channel policy and item identity. Another eligible member can load an item without taking ownership of the preview. Only one item can be prepared for a gallery at a time, regardless of who clicks.

A gallery holds at most ten items and 192 MiB in total. JPEG and PNG images have their own 8 MiB and dimension limits; animated or unsupported image formats are skipped. Expired, changed or unavailable items leave existing items intact. A failed or ambiguous Discord edit retains a file reference when the item might still be visible; removing the message releases its references.

Album controls use at most 512 in-memory sessions, expiring after 24 hours or a bot restart. An expired control asks the requester to run **Fix with Linky** again. The existing preview and its Remove ownership are independent of the session. The session contains the current album URL, item fingerprints, public media URLs and requester/location IDs; it is not a chat-history store.

## Local retention and operations

The seven-day history below powers Discord Details. A separate private operator archive retains sanitized finalized measurements for 30 days by default within a 64 MiB cap, without Discord identities, URLs or message content. Run `npm run report:deliveries -- --days 7` after building, or the container command in [operator reliability](operator-reliability.md), for weekly analysis. It reports coverage and data-loss limitations. Public hosted Linky excludes Erome; the Erome paths in this document apply to self-hosted instances and the dated historical validation below.

`data/delivery-diagnostics.json` holds at most 4,096 attempts, 4 MiB and seven days. It contains finite outcomes, elapsed/stage timings, platform/path labels and the IDs needed to bind Details to its message and restrict private replies. It contains no message text, captions, URLs, media or credentials. Diagnostics expiry cleanup runs periodically and on access. The reuse index removes expired descriptors during startup, activity and minute-by-minute maintenance. Unfinished attempts restored after restart are marked interrupted, not submitted again. A slow or failed diagnostics write omits Details while the preview continues.

The reuse index is the private `erome-reuse` sibling of the configured media directory. Never put it inside the strict media directory. Its failures disable reuse without turning an index record into permission to retain or serve media. The optional website analytics collector remains separate and inactive for these local attempt records; this feature does not send them to a new analytics service.

Keep the persistent data volume and media URLs intact during an upgrade. Media metadata reads legacy MP4 records and writes a version that also identifies JPEG and PNG assets. Rollback to an older MP4-only image requires compatible backed-up state; do not point an old image at new image records and assume compatibility. Review the [runtime security audit](runtime-security-2026-09-15.md) and [self-hosting guide](self-hosting.md) before changing process or storage bounds.

## Read-only operator report and release checks

Run `node ops/delivery-report.mjs --file data/delivery-diagnostics.json` for aggregate platform, path, outcome and cache counts, completed-attempt latency, and stage median/p95. The tool makes no network requests or changes. It rejects nonregular, oversized or malformed files and unknown schema fields. Its output contains no requester, server, channel, message or attempt IDs, URLs, captions or raw errors. Missing cache observations are counted as unknown.

For a controlled release trial, select its start time and require the outcomes actually exercised:

```sh
node ops/delivery-report.mjs --file data/delivery-diagnostics.json \
  --since 2026-09-15T12:00:00Z --platform erome --path hosted-original \
  --min-completed 2 --require erome:confirmed:2 \
  --reject-outcome pending --reject-outcome interrupted \
  --reject-outcome metadata-unconfirmed
```

Use the trial's actual timestamp. `--platform`, `--path` and `--cache hit|miss|unknown` filter all counts and checks; omit a filter to include every value. Repeat `--require platform:outcome[:minimum]` for expected combinations, and `--reject-outcome outcome` for outcomes that must be absent. Uncertainty or other failures are rejected only when explicitly selected. A minimum of completed samples or an expected combination prevents an empty history from passing a release check. Pending and interrupted attempts are excluded from completed latency samples; confirmed samples have a separate summary. Exit status is 0 for a report or passing check, 1 for unmet requirements, and 2 for invalid arguments or input.

The script can read the container's existing file without installing code or exposing its environment: `docker exec -i linky node --input-type=module - --file /app/data/delivery-diagnostics.json < ops/delivery-report.mjs`. Add the same filters and checks after the file argument. This reads only; it neither starts a trial nor posts messages.

Statistics describe the selected local sample. A small sample's nearest-rank p95 can be its maximum; it is not a representative production percentile. Stage summaries total same-named spans per completed attempt, while stage outcome counts count individual spans. Different stages can overlap. A `confirmed` result records the delivery check for that path, such as matching media metadata or delivered translated text. It does not prove playback; check the intended Discord client separately.

## Release validation on September 15, 2026

Bot revision `bd174c537f50b6a4ef76326e1c943b3464e6ed46` passed 944 TypeScript tests, 41 workflow/report tests and 24 deployment checks. Its production container passed seven tests with real FFmpeg, including generated still JPEG/PNG images, animation rejection and unchanged original media. Both Node 22 and 24 passed CI; dependency and image checks found no fixable vulnerabilities. Unfixed distribution advisories remain documented in the runtime security audit.

A controlled Discord trial between 20:20 and 20:27 UTC produced three confirmed Erome deliveries and one confirmed X preview. The first original-video request completed in 8.7 seconds, including 4.7 seconds downloading and 2.5 seconds awaiting Discord metadata. A repeated request and another after a bot restart each completed in about 1.4 seconds, reused the same validated asset and performed no new media download or encoding. The operator report required those four outcomes and found no pending, interrupted or unconfirmed attempts in that sample.

The original video played in Discord's Chrome client at 1280×720 with a 160.097-second duration. Playback advanced beyond seven seconds without a media error. Details displayed a requester-only response. Owner removal deleted one controlled preview while the other previews sharing its asset remained available. This proves those individual paths, not a general latency percentile or playback guarantee across devices.

The supplied public albums contained one item. Multi-item loading, image-only albums, permission changes, cancellation and rollback were tested with synthetic album/Discord fixtures and generated media; a public multi-item image album was not part of this live trial.
