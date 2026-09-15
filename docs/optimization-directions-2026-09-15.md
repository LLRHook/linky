# Five optimization directions for Linky

Research date: September 15, 2026. Implementation reviewed: `6f1c192`, including the Erome preview-dimension fix in [PR #30](https://github.com/LLRHook/linky/pull/30). This is a proposal, not an implementation or a new production benchmark.

The highest-value work is to improve reliable completion, reuse prepared media, and prevent expensive video jobs from delaying other requests. Linky already has original-quality media delivery, regional range downloads, duplicate-request coalescing, provider fallbacks, private setup, and owner-only removal. Reimplementing those features would add little.

## Evidence and limits

This review combines current source code, the recent production incident, and primary documentation from Discord, FFmpeg, Node.js, Google SRE, Microsoft, OpenTelemetry, Vercel, Cloudflare, and Embed Fixer's maintainer. Recommendations and experiments below are engineering judgments based on those sources.

The recent incident demonstrated a correctness failure: Discord supplied useful media metadata, but Linky rejected a one-pixel difference. Previous individual playback and timing tests establish that particular examples worked; they do not establish a fleet-wide success rate, latency percentile, cache-hit ratio, or capacity limit. No new live messages, load tests, production configuration changes, or subscriptions were created for this research.

| Direction | What members would notice | First deliverable | Relative scope |
| --- | --- | --- | --- |
| 1. Measure delivery and catch regressions | Fewer failures discovered by members | Structured per-stage outcomes and a release smoke check | Medium |
| 2. Recover from provider trouble sooner | Fewer long waits followed by failure notices | Gateway-first verification for ordinary embeds | Medium; adaptive routing comes later |
| 3. Reuse prepared video effectively | Repeated albums avoid unnecessary downloads | A bounded larger cache, followed by persistent reuse | Small first step; medium persistent design |
| 4. Separate and schedule expensive work | One long video interferes less with other requests | Resource measurements and separate network/encoding admission | Medium to large |
| 5. Finish the Discord experience | Clear progress and useful failure controls | Shared progress states and private request diagnostics | Small to medium; full albums are a separate extension |

Scope is relative to this codebase, not a delivery-time estimate. The first useful release would combine basic measurement from direction 1 with the narrow verification improvement in direction 2.

## 1. Measure delivery and catch regressions before members report them

### What exists

`src/services/PreviewRecovery.ts:117` maintains process-local counts and the last observation by provider. `src/bot.ts:58` creates that observer, which feeds diagnostics. It does not record a durable request timeline. Erome paths can call the observer with an empty expected-preview list, so the provider loop does not record those outcomes. Some original-media successes also reach a log message describing translated text.

CI already builds on Node 22 and 24 and runs real FFmpeg tests. Its production video tests explicitly disable network access in `.github/workflows/ci.yml`; they cannot validate a provider's current responses or Discord playback.

### Proposed work

Assign each attempt a random correlation ID and record bounded timings for queue wait, album/metadata lookup, source transfer, inspection or conversion, storage, Discord send, and preview confirmation. Classify the final result: confirmed, unavailable source, permission/configuration rejection, provider failure, deadline, busy queue, Discord failure, or inconclusive metadata.

Keep successful and failed latency distributions separate. Report medians and slow-tail percentiles by platform and delivery path, cache hit/miss, fallback usage, queue saturation, store occupancy, and regional bytes. Do not use album URLs, captions, user IDs, or server IDs as metric labels. Preserve the new safe error serializer. Detailed request diagnostics need short retention and access checks.

Add a controlled release check using maintained, non-sensitive examples. Bot API checks can establish message creation and matching media metadata. A separate browser playback check can establish that a particular client actually plays a video. Keep those results distinct; Discord does not expose every viewer's playback through the bot events we use.

Google's monitoring guidance distinguishes internal signals from tests of externally visible behavior and recommends measuring latency, demand, failures, and saturation. OpenTelemetry explains how a request trace can connect its individual stages. Neither requires that we install an entire monitoring stack immediately. Start with a small structured event schema and retained aggregates. [Google SRE monitoring](https://sre.google/sre-book/monitoring-distributed-systems/), [OpenTelemetry concepts](https://opentelemetry.io/docs/concepts/observability-primer/).

### First experiment and tradeoff

Instrument normal traffic without recording message content. Reproduce controlled failures for an unavailable post, delayed metadata, a failed worker, and a queue rejection. Confirm each lands in the right category and that timing includes queueing. Then establish a baseline across multiple days and content types before choosing service targets.

Live provider failures should produce a service-health result, not automatically label an unrelated code change as broken. Controlled test posting requires a designated channel and cleanup. A passing metadata check must never be presented as universal playback telemetry.

## 2. Recover from provider trouble sooner

### What exists

`src/services/SocialProviders.ts:14` defines a fixed provider order. Instagram, X, and Bluesky have alternates. TikTok, Reddit, and Twitch do not currently have verified alternatives. `nextProviderContent` in `src/services/PreviewRecovery.ts:103` already switches providers after failure; adding basic fallback would duplicate existing behavior.

Generic preview verification in `src/services/PreviewRecovery.ts:88` waits 1, 2, then 3 seconds between REST fetches. The delays accumulate, with network time on top. Erome's original-media verifier already listens for Gateway updates and has a bounded reconciliation path.

### Proposed work

First, extend the existing event-driven verification approach to ordinary social embeds. Register the watcher before publishing, merge partial updates carefully, verify message and post identity, and keep a bounded REST fallback. Track the provider attempt too: a late update from an earlier provider must not confirm a newer attempt incorrectly. This can recognize already-arrived metadata sooner and reduce polling requests. The improvement must be measured; a Gateway notification cannot make Discord fetch media faster.

Next, use recent observations to adjust the order of compatible providers. Repeated failures across distinct known-public posts can temporarily move a provider behind a working alternate. After a cooldown, allow a limited probe to determine whether it recovered. A deleted/private post or caption-mode mismatch must not disable an entire provider. Caption-free media and video support remain selection constraints.

Discord documents message-update events and instructs applications to follow returned rate-limit information. Microsoft's circuit-breaker pattern describes temporarily stopping repeated calls to a failing dependency and testing its recovery with limited requests. These support the design; they do not establish that any current provider is down. [Discord Gateway events](https://docs.discord.com/developers/events/gateway-events), [Discord rate limits](https://docs.discord.com/developers/topics/rate-limits), [Circuit breaker](https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker).

### First experiment and tradeoff

Compare the current polling verifier with a watcher on early, late, missing, partial, wrong-post, and duplicate events. Measure confirmation latency and Discord fetches per successful preview. Verify that source deletion still requires the same evidence.

Trial routing decisions in observation-only mode before changing delivery order. Measure whether the suggested alternate actually succeeds. Do not retry an uncertain Discord send blindly: a timeout can occur after a message was created, so preserve the existing reconciliation behavior. [Microsoft retry guidance](https://learn.microsoft.com/en-us/azure/architecture/patterns/retry).

## 3. Reuse prepared video effectively, keeping source quality

### What exists

The attachment cache in `src/services/Erome.ts:8` holds two entries for five minutes with a 128 MiB byte cap. The original-video cache in `src/services/EromeMediaRuntime.ts:35` also holds two entries for five minutes, but references files in the persistent store. Its album-to-asset lookup is lost on restart. Bound assets can remain on disk, yet a later request can download and publish another copy because that lookup expired.

Compatible media is already preserved. `src/services/VideoAttachment.ts:207` supports stream copy when appropriate, and original-video delivery stores unchanged bytes. FFmpeg confirms that stream copy avoids decoding and encoding; changing container metadata is different from changing video quality. [FFmpeg stream copy](https://ffmpeg.org/ffmpeg.html#Streamcopy).

### Proposed work

Expand the caches using measured demand and explicit byte, entry, and age budgets. The hosted path should cache small asset descriptors rather than duplicate video buffers in RAM. The attachment path needs separate budgeting because it holds and copies buffers.

Add a private persistent index from a canonical album fingerprint to an existing asset and preparation version. Reuse must verify that the asset still exists, the source is sufficiently fresh, the current destination policy permits it, and another message reference can be bound. The store currently allows 64 message references per asset, so define rollover behavior when that limit is reached. Retain no raw album URLs in public metadata or metrics. Invalidate appropriately on deletion, changed source validators, incompatible policy, or failed inspection. Preserve the existing reference-counted removal semantics. A matching byte validator does not by itself prove that the source album is still publicly available.

After measuring cache performance, investigate adaptive regional collection. The current collector waits for all ten disjoint parts and aborts the entire operation when a part fails (`src/services/RegionalDownloader.ts:128`). A smaller source might not need ten workers; a failed part might be recoverable without discarding successful parts. Both are hypotheses, not measured wins.

Adaptive collection is a protocol change: current signatures, claims, ranges, and regional admission are deliberately bound together. Any experiment must preserve exact byte ranges, a consistent strong validator, total-byte/deadline limits, and single-use authorization. Vercel documents a 4.5 MB function payload limit; the current implementation independently caps a part at 4 MiB. Keep platform limits and the deployed streaming behavior under test before changing part sizes. [Vercel function limits](https://vercel.com/docs/functions/limitations), [Vercel streaming](https://vercel.com/docs/functions/streaming-functions).

### First experiment and tradeoff

Replay a bounded corpus with repeats separated by more than two other albums, by cache expiry, and by restart. Compare source bytes fetched, prepared assets created, cache hits, first-preview time, and memory/storage consumption. Test source changes and owner removal as well as hits.

Longer reuse introduces freshness and retention decisions. Internal reuse is also different from CDN caching: the media endpoint intentionally returns `Cache-Control: no-store`. Changing that header would change how retained copies behave after removal. [HTTP caching specification](https://www.rfc-editor.org/rfc/rfc9111.html#section-5.2.2.5).

## 4. Separate and schedule expensive work

### What exists

Both Erome delivery paths share one preparation slot and two waiting slots, with a five-minute waiting deadline (`src/services/Erome.ts:6` and `:129`). An expensive fallback can occupy that shared slot while a short original-video request waits. FFmpeg already runs as a subprocess; moving it to a subprocess would not be a new optimization.

The Hostinger machine has 32 GB RAM and eight vCPUs from the prior deployment inspection. However, `docker-compose.yml` gives `/tmp` only 256 MiB. More concurrent 64 MiB inputs, output files, and conversion intermediates can exhaust that temporary filesystem even when host RAM remains available. `src/services/MediaServer.ts:8` separately limits active media HTTP requests to eight. That is a request limit, not an eight-viewer limit.

### Proposed work

Separate network preparation, CPU conversion, and Discord publishing into explicitly bounded stages. Introduce fair scheduling between servers and cancellation when a request is no longer useful. The current preparer interface has no guild identity, so this requires an explicit scheduling interface rather than a configuration switch. An initial candidate could admit one original-media job alongside one fallback while retaining the existing single collector and encoder. Reserve enough CPU and I/O capacity for ordinary link processing and bot event handling. Avoid starting several full regional collectors or encoders merely because RAM is available.

Measure peak temporary storage, RSS, event-loop delay, CPU utilization, source bandwidth, and queue wait. Then trial a small concurrency increase with explicit per-job budgets. Node.js describes the different behavior of CPU and I/O work; Google's overload guidance supports admitting work according to capacity rather than allowing demand to consume every resource. [Node.js event-loop guidance](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop), [Google SRE overload handling](https://sre.google/sre-book/handling-overload/).

Keep one owner of the current persistent media store and live claim registry. A second independent bot process is not a safe scaling shortcut: the current claims and state are not designed for multiple writers.

### First experiment and tradeoff

Use controlled workloads that mix a long conversion, several short compatible videos, and ordinary social links from multiple test servers. Compare queue-wait percentiles, normal-link latency, failures, memory, and temporary storage. Test cancellation, restart, and per-server fairness. Increase concurrency only when these measurements support it.

A later storage step may separate file serving from the bot. The current store defaults to 10 GiB and retains bound previews instead of evicting them. Publication inventories the directory, while reads and mutations share a serialized operation queue; measure that cost before increasing the asset count substantially. Object storage could decouple playback availability from bot restarts and expand capacity, but it does not accelerate the first source download. Cloudflare R2 is one candidate: its current Standard storage list price is $0.015/GB-month, with operation charges and no direct R2 egress fee. This is not a total Linky cost estimate. [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

Any CDN/storage migration must preserve seek/range behavior, deletion of the final reference, and existing URLs. Cache removal needs an explicit purge strategy; merely deleting the origin object is insufficient for already-cached copies. [Cloudflare cache purge](https://developers.cloudflare.com/cache/how-to/purge-cache/). Actual occupancy and traffic have not been measured in this research, so a storage purchase is not the first recommendation.

## 5. Finish the Discord experience

### What exists

Linky already has a private setup panel, server opt-in, reply/replace modes, channel scope, per-platform switches, manual commands, and owner-only Remove controls. Its attachment `/fix` path shows progress. The newer original-media path starts before that progress handler (`src/commands/fix.ts:99` versus `:147`) and can leave the deferred response looking idle.

Failure notices recommend `/diagnose`, but that command requires Manage Server (`src/commands/diagnose.ts:21`). Its Erome description still describes the attachment path without explaining the newer hosted-original path (`:89`). Ordinary members therefore lack a directly usable explanation of their own failed request.

### Proposed work

Use common request states across both delivery paths: waiting, fetching, preparing when conversion is necessary, posting, confirmed, or failed. Update a single message when work takes long enough to justify a progress display. Report known state rather than inventing a percentage or ETA. Preserve quiet joins and avoid unsolicited status messages for fast requests.

Add a private details/status action for the original requester. It should explain that request's result and offer a relevant retry, while keeping administrative diagnostics and server configuration restricted. Recheck authorization on each action. Discord interactions require prompt acknowledgement and allow later updates; a private response is possible after a user's interaction, not as a selectively hidden part of a public message. [Discord interaction responses](https://docs.discord.com/developers/interactions/receiving-and-responding).

Offer a small set of presentation choices such as compact media versus a full caption, and make actual channel readiness clearer inside setup. The competitor evidence supports demand for controls: Embed Fixer documents channel inclusion/exclusion, provider choice, original-link visibility, and media extraction. Linky already covers several of these, so the opportunity is fewer confusing steps rather than duplicating every toggle. [Embed Fixer maintainer documentation](https://github.com/seriaati/embed-fixer/blob/main/README.md), [Embed Fixer site](https://ef.seria.moe/).

If product breadth is the priority, extend the existing first-video Erome handling with an on-demand next-item action, then image-only albums. Avoid fetching an entire large album before showing the first item. Discord galleries support up to ten media items, but obtaining, validating, budgeting, and owning those items remains Linky's work. [Discord media galleries](https://docs.discord.com/developers/components/reference#media-gallery).

### First experiment and tradeoff

Test new-server setup with someone who has not used Linky, and test a slow video and a failed request as an ordinary member. Record time to the first successful fix, abandoned attempts, repeated Retry clicks, and whether users can correctly explain the current state. More status edits consume Discord requests and can clutter chat; update on meaningful state changes and keep detailed explanations private.

## Recommended sequence

Start with a small request-outcome schema and the generic Gateway verifier. Next improve recent-media reuse and shared progress reporting. Use the resulting traffic measurements to decide whether fair concurrency, a persistent reuse index, adaptive regions, or separate file hosting delivers the greatest benefit.

Defer GPU purchases, indiscriminate thread increases, extra bot replicas, and additional platforms until a measured workload justifies them. Keep native source resolution and avoid new lossy conversions introduced solely to make a benchmark look faster.
