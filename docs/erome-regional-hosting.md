# Regional hosting for Erome originals

**Self-hosted feature.** The public hosted Linky does not prepare Erome previews for public servers. These instructions apply to your own bot, media host and configured workers. Existing supported formats, quotas and channel rules still apply.

This optional path keeps eligible original MP4 bytes and posts a Discord media gallery after the complete file has been downloaded, inspected and saved. Self-hosted instances default to `EROME_MEDIA_ENABLED=false`, which uses the attachment path. Hosted Linky has regional delivery enabled; the running Hostinger revision was verified as `6f1c192` on September 15, 2026.

Enable regional hosting only after deploying matching bot and worker revisions, provisioning persistent storage and HTTPS, and completing the activation checks below. The dedicated worker project uses the ten-location protocol version 3. The measured results describe the tested source and conditions; they do not establish a ten-second production guarantee.

## Delivery and limits

An original must be at most 24 MiB, five minutes and 60 fps, with H.264/yuv420p video and AAC audio when present. The accepted video profiles are Constrained Baseline, Baseline, Main and High. Inspection accepts one video stream and at most one audio stream, with no attached pictures or other streams. Both average and nominal frame rates must fit the limit. Native dimensions must fit 1920×1080 or 1080×1920; a 720p source stays 720p. This path does not transcode or upscale.

Discord's reported preview dimensions can differ from the source by one pixel. Verification accepts that rounding in either orientation while requiring the exact hosted file URL, an MP4 type and a proxy URL. Larger dimension mismatches still fail verification. This tolerance changes only the metadata check; it does not resize or re-encode the stored original.

The bot resolves the selected video from the album (the first video for the initial preview) and uses a HEAD request to establish its size and strong ETag. It divides the exact size into ten consecutive ranges using `ceil(size / 10)` bytes per part, shortening the last part to the end of the file. At the 24 MiB source limit, each part is about 2.4 MiB. The independent 4 MiB part cap remains in place.

| Part | Fetch location | Worker route |
| --- | --- | --- |
| 0 | Vercel Virginia, `iad1` | `/api/iad` |
| 1 | Vercel Frankfurt, `fra1` | `/api/fra` |
| 2 | Vercel London, `lhr1` | `/api/lhr` |
| 3 | Vercel Cleveland, `cle1` | `/api/cle` |
| 4 | Vercel San Francisco, `sfo1` | `/api/sfo` |
| 5 | Vercel Paris, `cdg1` | `/api/cdg` |
| 6 | Vercel Dublin, `dub1` | `/api/dub` |
| 7 | Vercel Portland, `pdx1` | `/api/pdx` |
| 8 | Vercel Montreal, `yul1` | `/api/yul` |
| 9 | The Hostinger bot process | Local source request |

Each worker receives an HMAC-signed job bound to its route, source, range, validator and expiry. Before fetching, it must obtain a one-use claim from the currently active bot job. A replay or a job absent from that process is rejected. Workers verify their actual runtime region. They accept only the allowed Erome source hosts, require public IPv4 DNS answers and pin the chosen address for HTTPS. Redirects, cookies, compressed responses, changed validators, wrong ranges and incomplete bodies are rejected.

Album lookup has a ten-second deadline. The source HEAD has two seconds, each range has eight seconds, and the collector has ten seconds including HEAD. Each Vercel function is configured for a maximum duration of ten seconds, with an eight-second application deadline. One collector runs at a time; startup and uncertain failures leave an eight-second admission gap, extended when a later claim may still be running. Inspection has a two-second process deadline. Queueing, local disk operations and Discord delivery add time beyond the source transfer.

Hostinger assembles all ten parts and inspects the complete original before publishing it to the store. Only then does the bot post a URL such as `https://media.linkybot.dev/media/<32-hex-id>.mp4`. Public requests can read registered files or seek within them; they cannot select an origin URL or trigger a download. Responses are marked `no-store` and `noindex, nofollow`.

Larger or incompatible files, failed regional preparation, a full store and mixed-platform messages use the existing attachment publisher. Its input limit is 64 MiB and five minutes; it remuxes or encodes to the destination's upload allowance. The same channel policy, retained original album and owner-only **Remove** controls apply to both paths. Hosted galleries also support selected JPEG/PNG items through a separate bounded image transport; the signed regional MP4 protocol is unchanged. [Delivery reliability](delivery-reliability.md) describes persistent source-validated reuse, fair scheduling, private diagnostics and album controls. An uncertain Discord POST is reconciled once, without an automatic second submission. See [Erome previews](erome-previews.md) for the shared delivery rules and attachment limits.

## Persistent storage and ownership

Run one bot process with one media store on the existing `linky-data` volume. Live claims are process-local, while media and references survive restart. Multiple independent bot processes cannot coordinate these claims or safely share this store.

The default store is `/app/data/media` in Docker, selected by `EROME_MEDIA_PATH=data/media`. It has a 10 GiB byte limit and a 4,096-file limit. Each file is at most 24 MiB and can have up to 64 Discord message references. The directory uses mode `0700`, and files use `0600`. The runtime user must be able to write it.

Writes use private temporary files, atomic renames and filesystem synchronization. Metadata records the random asset ID, byte count, SHA-256, creation time and bound message IDs; it contains no album/CDN URLs or Discord message text. A failed write stops further store mutations until restart recovery. Unknown, corrupt or linked files block new admissions and are preserved. An unindexed MP4 left by a crash still counts against quota; owned temporary files can be cleaned during recovery.

Bound assets are not evicted to admit new work. When the bot observes removal of the last bound preview, it removes the owned file through a durable deletion record. Unbound publishes expire after 15 minutes, with bounded cleanup at startup, during operations and on a timer. The bot reconciles uncertain posts within that window. Retain the volume across deployments and back it up with the bot's other state.

Anyone with a retained media URL can read that file. Keep the media server behind the HTTPS proxy and avoid serving the data directory directly. Disabling regional media also stops this listener, so existing gallery URLs become unavailable until it is restored; the stored files themselves remain in the volume.

## Operator configuration

The bot's settings are documented in [`.env.example`](../.env.example):

| Bot environment variable | Value |
| --- | --- |
| `EROME_MEDIA_ENABLED` | `true` only when workers, persistent storage and HTTPS are ready; default `false` |
| `EROME_WORKER_KEY` | A generated shared HMAC secret, 32–512 printable ASCII characters; use the same value as the workers' `REGIONAL_JOB_KEY` |
| `EROME_WORKER_BASE_URL` | The dedicated worker project's deployed HTTPS origin, with no explicit port, path, credentials, query or fragment |
| `EROME_MEDIA_BASE_URL` | `https://media.linkybot.dev`, or the operator's equivalent HTTPS media origin |
| `EROME_MEDIA_PATH` | `data/media` with the supplied Compose volume |
| `EROME_MEDIA_PORT` | `8092` with the supplied Compose and proxy configuration |

Configure the dedicated `linky-media-workers` Vercel project from this repository's root. [`vercel.json`](../vercel.json) pins the nine functions to their regions; [`tsconfig.worker.json`](../tsconfig.worker.json) checks their shared protocol and transport code. Use the Node.js 22/24 versions covered by the repository checks. The deployed worker routes must be reachable by the bot without an interactive login; the handlers enforce the HMAC and live-claim checks before source access.

Deploy matching bot and worker revisions. Protocol version 3 fixes the ten-part topology in both the job payload and the job/claim HMAC domains. Version-one and version-two jobs and signatures from the former six- and eight-part topologies are rejected before source access. A mixed deployment fails regional preparation and uses attachment fallback.

The worker environment needs these two values:

| Worker environment variable | Value |
| --- | --- |
| `REGIONAL_JOB_KEY` | Exactly the bot's `EROME_WORKER_KEY` |
| `REGIONAL_CLAIM_URL` | `https://media.linkybot.dev/internal/regional/claim` |

Set secrets through the operator's environment configuration. Workers do not need the Discord token. A key mismatch, unreachable claim endpoint, expired job or wrong function region causes regional preparation to fail and leaves attachment fallback available.

## Hostinger HTTPS routing

The listener runs inside the bot container on port `8092`. [`docker-compose.yml`](../docker-compose.yml) publishes it only at `127.0.0.1:8092` on Hostinger and keeps media on the shared data volume. Keep the environment port, container port mapping and proxy upstream consistent if changing this value.

Point `media.linkybot.dev` at Hostinger and configure its HTTPS site to forward only `/media/*` and the exact claim endpoint. A Caddy site can use the following routes. `handle` preserves the request path, and its unmatched block returns 404. [Caddy handle documentation](https://caddyserver.com/docs/caddyfile/directives/handle), [request matchers](https://caddyserver.com/docs/caddyfile/matchers).

```caddyfile
media.linkybot.dev {
    @media {
        method GET HEAD
        path /media/*
    }
    handle @media {
        reverse_proxy 127.0.0.1:8092
    }

    @claim {
        method POST
        path /internal/regional/claim
    }
    handle @claim {
        reverse_proxy 127.0.0.1:8092
    }

    handle {
        respond 404
    }
}
```

Preserve the original path, request body and `X-Linky-Signature` header on the claim route. The media application validates the complete path and supports GET, HEAD and one byte range per request. It admits at most eight active media requests, with a 20-second deadline, and ten independent claim requests, each bounded to 4,096 bytes and two seconds. Existing playback therefore does not consume the slots needed by the nine worker claims. `/healthz` stays local and is not routed through the public site. The proxy forwards to the host's loopback address. [Caddy reverse proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

## Activation and checks

1. Review the bot and worker revision, then run `npm test`, `npm run build`, `npm run check:workers` and the existing deployment checks. Provision the persistent directory, matching secrets, DNS and HTTPS configuration.
2. Deploy the reviewed worker revision to `linky-media-workers` and use its stable HTTPS origin in `EROME_WORKER_BASE_URL`. Verify that all nine routes use the regions in the table. Confirm that unsigned jobs, version-one and version-two jobs, and invalid claims are rejected without source requests.
3. Deploy the matching bot revision, set `EROME_MEDIA_ENABLED=true` and restart the single bot process. Check listener health from inside the container: `docker compose exec -T linky node -e "fetch('http://127.0.0.1:8092/healthz').then(r => process.exit(r.status === 200 ? 0 : 1)).catch(() => process.exit(1))"`.
4. Run an authorized live check through the actual automatic and manual Discord flows. Start with an empty media cache and include generic album lookup, inspection and disk publication in the measurement. Verify the returned video's metadata, visible playback and seeking separately. Check that the original remains, another user cannot use **Remove**, and the owner's removal releases the final asset reference.
5. Restart the bot with a retained bound asset and verify that its URL still supports GET, HEAD and seeks. Check attachment fallback for incompatible or oversized originals and for a regional failure. Record the tested commit, source properties and observed timings with the deployment checks.

Turning `EROME_MEDIA_ENABLED` off restores preparation through the attachment path after restart, but also takes existing hosted gallery URLs offline. Keep the data volume if restoring those URLs later. Rotating the shared key requires updating both bot and workers; mismatched deployments fail their claims.

## Historical measurements and validation scope

Earlier experiments tested an already resolved 25,026,293-byte, 1280×720 source. They began with an empty media cache and measured monotonic time from before the original Discord POST until a gateway event contained matching video dimensions, `video/mp4` type and proxy metadata.

| Experimental run | Valid Discord video metadata |
| --- | ---: |
| Initial instrumented run | 8.918 s |
| Repeat 1 | 8.382 s |
| Repeat 2 | 8.288 s |
| Reply posted only after complete source download | 9.440 s |

The first three runs posted an experimental gallery while preparation was still in progress. The fourth waited until the complete file was ready before sending the reply, matching the intended publication order. All used a pre-known 720p source and previously established source properties. They omitted generic album lookup, the new original-file inspection and durable store publication. The recorded metadata events are distinct from UI playback. Separate browser checks played the initial instrumented run and Repeat 2 through to the natural end at 1280×720 without a reported player error.

The retained setup-workspace records are `linky-six-region-instrumented-discord-result.json`, `linky-six-region-repeat1-discord-result.json`, `linky-six-region-repeat2-discord-result.json` and `linky-six-region-after-ready-discord-result.json`. The [earlier research report](erome-fast-embed-research.md) records the preceding attachment, single-host range and placement experiments; its final decision predates these six-location results.

The generic candidate was then tested with six fetch locations on September 15, 2026. These cold runs included album lookup, original-file inspection and durable publication before the Discord reply. They used the same 25,026,293-byte, 1280×720 original with a container duration of 160.121 seconds. Both preserved the exact complete file, with SHA-256 `722463420f013fce39b7afb6f733fce9614390f63c5e5da318601da60cb3e836`.

| Generic candidate run | Valid Discord video metadata |
| --- | ---: |
| First cold run | 9.494 s |
| Cold repeat | 11.717 s |

Both timings started before the original Discord source POST. In the repeat, collection took 7.788 seconds and the reply was created at 9.083 seconds; Discord supplied verified video metadata at 11.717 seconds. The repeat therefore exceeded ten seconds even though the complete file was ready and the reply existed earlier.

The first gallery played to its natural end in Chrome's Discord client at 1280×720, with `currentTime` and `duration` both 160.097007 seconds, `ended=true` and `error=null`. Playback continued across a candidate-service restart. Separate checks after that restart returned HTTP 200 for the retained asset's HEAD, HTTP 206 for a byte range, and the same SHA-256 for the complete file. The setup-workspace records are `linky-regional-generic-trial-2.jsonl` and `linky-regional-generic-trial-3.jsonl`.

Two further runs tested eight locations with protocol v2 and an empty media cache, using the same generic preparation path and source. Both retained the exact 25,026,293-byte original and the SHA-256 above. The complete file was downloaded, inspected and saved before each gallery was posted. Admission probes had called all seven workers before the first source trial, so these measurements do not establish cold-compute performance.

| Eight-location candidate run | Source collection | Gallery creation event | Valid video metadata |
| --- | ---: | ---: | ---: |
| First empty-cache run | 5.593 s | 6.452 s | 7.777 s |
| Empty-cache repeat | 5.534 s | 6.718 s | 10.237 s |

Source collection is the elapsed duration of the collector operation. Gallery creation and metadata are monotonic times from before the original Discord source POST. The metadata event followed the gallery's creation event by 1.325 seconds in the first run and 3.519 seconds in the repeat. The repeat exceeded ten seconds despite similar source collection times. Neither run required an uncertain-POST reconciliation or retry.

The setup-workspace records are `linky-regional-v2-trial-1.jsonl` and `linky-regional-v2-trial-2.jsonl`; the latter also retains the first run's log. These records verify Discord video metadata and full-file integrity. A separate Chrome Discord check then played the first gallery to its natural end at 1280×720, with `currentTime` and `duration` both 160.097007 seconds, `ended=true` and `error=null`. Playback continued across a candidate-service restart.

The ten-location protocol-v3 candidate was then tested twice with the same source. Both runs began after a candidate-service restart with an empty runtime media cache. The first made no separate per-worker admission probes before the source trial; the workers' cold-compute state was not verified.

| Ten-location candidate run | Source collection | Complete preparation | Gallery creation event | Valid video metadata |
| --- | ---: | ---: | ---: | ---: |
| First empty-cache run | 4.888 s | 5.341 s | 6.530 s | 7.832 s |
| Empty-cache repeat | 4.572 s | 4.976 s | 5.719 s | 7.294 s |

Complete preparation includes album resolution, source collection, original-file inspection and durable publication. It is an elapsed operation duration; gallery creation and metadata remain monotonic times from before the original Discord source POST. Both runs preserved the exact 25,026,293-byte original, its SHA-256 above, 1280×720 resolution and 160.121-second container duration. Both bound the gallery to the saved asset and verified metadata without an uncertain-POST reconciliation or retry.

The records are `linky-regional-v3-trial-1.jsonl` and `linky-regional-v3-trial-2.jsonl` in the setup workspace. Their run IDs are `db4afb36bff0` and `dcf7ad72ef43`; the second file also retains the first run's log. These records establish complete-file integrity and Discord video metadata for the ten-location candidate. UI playback is a separate check, as recorded for earlier galleries above.

The candidate results do not establish hosted-bot activation or a ten-second guarantee for other sources, native 1080p files, worker cold starts, queueing, persistent storage or Discord playback. Operators should repeat the activation checks for their deployed revision and environment.

## Hosted verification on September 15, 2026

[PR #30](https://github.com/LLRHook/linky/pull/30) shipped the one-pixel metadata tolerance without changing source bytes. After deployment, an existing user-owned GAMBA post successfully retried, and a fresh ordinary link automatically produced a video gallery. The 480×852 source played through its full 33.526 seconds in the checked Chrome Discord client with no player error, while Discord reported 479×852 preview metadata. That observation validates this source and client; it is not a fleet-wide latency or playback guarantee. The earlier experiments above retain their original conditions.
