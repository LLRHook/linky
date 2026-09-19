# Operator delivery history and daily review

The bot collects delivery measurements on its own host. Public Linky runs on Hostinger, with the archive in its existing persistent Docker volume. No separate log server, paid monitoring account or public dashboard is required.

## Two histories with different purposes

| Store | Purpose | Limits |
| --- | --- | --- |
| `data/delivery-diagnostics.json` | Bind a Discord Details button to its exact preview; private-response and DM records also require their requester | Seven days, 4,096 attempts, 4 MiB |
| `data/delivery-logs/` | Private operator analysis of finalized delivery attempts across days and restarts | Default 30 days, configurable 1–90 days; 64 MiB maximum |
| Docker operational logs | Startup, permissions, API errors and cleanup investigations | Three files of about 10 MiB per container; size rotation, not a time guarantee |

The archive is separate from the website's optional metrics adapter. No log endpoint is exposed. Keep it outside the public media directory and retain the existing `linky-data` volume during deployment. The Linux archive directory is owner-only, with owner-only daily record files. One bot process owns an archive directory.

## What is recorded

Each finalized attempt has a random attempt ID, start timestamp, platform, automatic/manual mode, a fixed outcome, delivery path, elapsed time, bounded stage timings and a cache hit/miss when observed. Only those allowed fields are copied. Discord user, server, channel and message IDs, source and media URLs, captions, message text, media bytes, credentials and arbitrary error messages are excluded.

The `explicit` path identifies messages containing Linky-authored YouTube community cards. Their confirmation checks Discord's returned creator, text and ordered image references against the prepared cards. It is not a native provider observation or a video-playback check; do not combine it with native video confirmation when comparing reliability.

The attempt ID is the one shown by Details. It can connect a user's report to a retained measurement, but the archive does not preserve the original message or its identity. Interactive Details remains subject to its shorter retention and existing authorization.

Finalization queues a record without awaiting disk I/O in the delivery path. Startup imports available finalized Details records, marks unfinished restored attempts interrupted, and avoids recounting imported attempt IDs. It cannot reconstruct records that had already expired or were never saved. A finalized attempt can still be archived after its interactive Details entry is evicted.

Daily files rotate on UTC boundaries. Retention and the disk cap can remove older files sooner than the configured number of days. The bounded queue can drop records during sustained storage failure or overload. Fixed warnings and archive health counters report these conditions; the bot keeps serving previews. Host downtime and failed physical cleanup can delay expiry. A backed-up copy has its own retention, which the operator must manage.

Set `DELIVERY_LOG_RETENTION_DAYS=30` in the host's `.env`, then restart or deploy to apply it. The parser rejects values outside 1–90. Changing retention does not change Details permissions or expand the data recorded.

## Pull a daily report with trend context

In a compiled checkout:

```sh
npm run build
npm run report:deliveries -- --days 1 --json
npm run report:deliveries -- --days 7 --json
```

In the production container, which intentionally has no npm:

```sh
docker exec linky node ops/delivery-archive-report.mjs --days 1 --json
docker exec linky node ops/delivery-archive-report.mjs --days 7 --json
```

When a platform shows repeated unconfirmed previews, run `npm run check:providers` from the same checkout to separate provider metadata from Discord's embed generation; see [preview providers](provider-checks.md#provider-metadata-control). It prints the corpus links it fetched and nothing from the archive.

Reports are read-only. They aggregate the selected period without printing attempt IDs or Discord data. Review outcomes by platform and delivery path, confirmed and nonconfirmed counts, latency sample sizes, medians and p95, failed stages, observed cache hits/misses, and archive coverage or loss warnings. Keep reports private unless deliberately publishing a reviewed aggregate.

The existing `node ops/delivery-report.mjs --file data/delivery-diagnostics.json` remains available for controlled release checks against the short Details history. Its filters, minimum-sample requirements and rejected-outcome checks are unchanged; see [delivery reliability](delivery-reliability.md).

## Interpret the results

Check coverage first. A day with no records is not evidence that everything worked, and no observed heartbeat is not the same as a confirmed outage. Startup backfill is historical delivery data, not proof that the archive was running on those days. Writer counters can outlive the reporting window; treat them as cumulative unless a report says otherwise.

`confirmed` means Linky's delivery check passed for that path. It can mean matching Discord metadata or delivered translated text; it does not establish playback on every device. Interrupted requests have unknown completed latency. A p95 from a small sample can be its maximum. Stage durations can overlap and must not be added to estimate total latency.

These are instrumented delivery attempts, not a census of all messages, installs or active users. Ignored links and passive native previews do not create deliveries. Button-only YouTube refreshes, translation quality and provider-specific outcomes are not separate product metrics in this archive. Add those measurements only when a decision needs them, with a bounded schema and an updated privacy notice.

Each day, review the previous 24 hours and compare with the previous daily window only when coverage is comparable. Use seven days for qualified trend context. The archive began September 17, 2026; earlier imported media tests are not current hosted-platform coverage. First investigate repeated failures and slow stages on advertised hosted platforms. Choose one evidence-backed item from the [product roadmap](product-roadmap.md), define a regression test or measured acceptance criterion, and validate it through a PR. Record sample sizes and unknowns. Keep self-hosted media work separate from the public hosted product's reliability and acquisition measures.

The first week establishes a baseline; it does not justify a comparative uptime or speed claim. [The competitor research](growth-research-2026-09-17.md) records user requests and documented capabilities, not head-to-head performance results.
