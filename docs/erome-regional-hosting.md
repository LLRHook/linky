# Regional hosting for Erome originals

This optional path keeps eligible original MP4 bytes and posts a Discord media gallery after the complete file has been downloaded, inspected and saved. The default remains `EROME_MEDIA_ENABLED=false`, which uses the existing attachment path.

As of September 15, 2026, the dedicated Vercel project `linky-media-workers` is deployed for candidate validation. The generic production path still needs a live test before activation in the hosted bot. The earlier experiment results below do not establish a ten-second production guarantee.

## Delivery and limits

An original must be at most 24 MiB, five minutes and 60 fps, with H.264/yuv420p video and AAC audio when present. The accepted video profiles are Constrained Baseline, Baseline, Main and High. Inspection accepts one video stream and at most one audio stream, with no attached pictures or other streams. Both average and nominal frame rates must fit the limit. Native dimensions must fit 1920×1080 or 1080×1920; a 720p source stays 720p. This path does not transcode or upscale.

The bot resolves the first video from the album and uses a HEAD request to establish its size and strong ETag. It divides the exact size into six consecutive ranges using `ceil(size / 6)` bytes per part, shortening the last part to the end of the file. Each part is at most 4 MiB.

| Part | Fetch location | Worker route |
| --- | --- | --- |
| 0 | Vercel Virginia, `iad1` | `/api/iad` |
| 1 | Vercel Frankfurt, `fra1` | `/api/fra` |
| 2 | Vercel London, `lhr1` | `/api/lhr` |
| 3 | Vercel Cleveland, `cle1` | `/api/cle` |
| 4 | Vercel San Francisco, `sfo1` | `/api/sfo` |
| 5 | The Hostinger bot process | Local source request |

Each worker receives an HMAC-signed job bound to its route, source, range, validator and expiry. Before fetching, it must obtain a one-use claim from the currently active bot job. A replay or a job absent from that process is rejected. Workers verify their actual runtime region. They accept only the allowed Erome source hosts, require public IPv4 DNS answers and pin the chosen address for HTTPS. Redirects, cookies, compressed responses, changed validators, wrong ranges and incomplete bodies are rejected.

Album lookup has a ten-second deadline. The source HEAD has two seconds, each range has eight seconds, and the collector has ten seconds including HEAD. Each Vercel function is configured for a maximum duration of ten seconds, with an eight-second application deadline. One collector runs at a time; startup and uncertain failures leave an eight-second admission gap, extended when a later claim may still be running. Inspection has a two-second process deadline. Queueing, local disk operations and Discord delivery add time beyond the source transfer.

Hostinger assembles all six parts and inspects the complete original before publishing it to the store. Only then does the bot post a URL such as `https://media.linkybot.dev/media/<32-hex-id>.mp4`. Public requests can read registered files or seek within them; they cannot select an origin URL or trigger a download. Responses are marked `no-store` and `noindex, nofollow`.

Larger or incompatible files, failed regional preparation, a full store and mixed-platform messages use the existing attachment publisher. Its input limit is 64 MiB and five minutes; it remuxes or encodes to the destination's upload allowance. The same channel policy, retained original album and owner-only **Remove** controls apply to both paths. An uncertain Discord POST is reconciled once, without an automatic second submission. See [Erome previews](erome-previews.md) for the shared delivery rules and attachment limits.

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

Configure the dedicated `linky-media-workers` Vercel project from this repository's root. [`vercel.json`](../vercel.json) pins the five functions to their regions; [`tsconfig.worker.json`](../tsconfig.worker.json) checks their shared protocol and transport code. Use the Node.js 22/24 versions covered by the repository checks. The deployed worker routes must be reachable by the bot without an interactive login; the handlers enforce the HMAC and live-claim checks before source access.

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

Preserve the original path, request body and `X-Linky-Signature` header on the claim route. The media application validates the complete path and supports GET, HEAD and one byte range per request. It admits at most eight active requests, with a 20-second deadline. `/healthz` stays local and is not routed through the public site. The proxy forwards to the host's loopback address. [Caddy reverse proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

## Activation and checks

1. Review the bot and worker revision, then run `npm test`, `npm run build`, `npm run check:workers` and the existing deployment checks. Provision the persistent directory, matching secrets, DNS and HTTPS configuration.
2. Deploy the reviewed worker revision to `linky-media-workers` and use its stable HTTPS origin in `EROME_WORKER_BASE_URL`. Verify that all five routes use the regions in the table. Confirm that unsigned jobs and invalid claims are rejected without source requests.
3. Deploy the matching bot revision, set `EROME_MEDIA_ENABLED=true` and restart the single bot process. Check listener health from inside the container: `docker compose exec -T linky node -e "fetch('http://127.0.0.1:8092/healthz').then(r => process.exit(r.status === 200 ? 0 : 1)).catch(() => process.exit(1))"`.
4. Run an authorized live check through the actual automatic and manual Discord flows. Start with an empty media cache and include generic album lookup, inspection and disk publication in the measurement. Verify the returned video's metadata, visible playback and seeking separately. Check that the original remains, another user cannot use **Remove**, and the owner's removal releases the final asset reference.
5. Restart the bot with a retained bound asset and verify that its URL still supports GET, HEAD and seeks. Check attachment fallback for incompatible or oversized originals and for a regional failure. Record the tested commit, source properties and observed timings before changing the status below.

Turning `EROME_MEDIA_ENABLED` off restores preparation through the attachment path after restart, but also takes existing hosted gallery URLs offline. Keep the data volume if restoring those URLs later. Rotating the shared key requires updating both bot and workers; mismatched deployments fail their claims.

## Measured results and pending validation

Earlier experiments tested an already resolved 25,026,293-byte, 1280×720 source. They began with an empty media cache and measured monotonic time from before the original Discord POST until a gateway event contained matching video dimensions, `video/mp4` type and proxy metadata.

| Experimental run | Valid Discord video metadata |
| --- | ---: |
| Initial instrumented run | 8.918 s |
| Repeat 1 | 8.382 s |
| Repeat 2 | 8.288 s |
| Reply posted only after complete source download | 9.440 s |

The first three runs posted an experimental gallery while preparation was still in progress. The fourth waited until the complete file was ready before sending the reply, matching the intended publication order. All used a pre-known 720p source and previously established source properties. They omitted generic album lookup, the new original-file inspection and durable store publication. The recorded metadata events are distinct from UI playback. Separate browser checks played the initial instrumented run and Repeat 2 through to the natural end at 1280×720 without a reported player error.

The retained setup-workspace records are `linky-six-region-instrumented-discord-result.json`, `linky-six-region-repeat1-discord-result.json`, `linky-six-region-repeat2-discord-result.json` and `linky-six-region-after-ready-discord-result.json`. The [earlier research report](erome-fast-embed-research.md) records the preceding attachment, single-host range and placement experiments; its final decision predates these six-location results.

The generic production live test is pending and must supersede these experiments for production claims. No ten-second guarantee is established for other sources, native 1080p files, worker cold starts, queueing, persistent storage or Discord playback.
