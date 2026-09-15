# Erome scheduling experiment, 15 September 2026

The isolated benchmark shows that a small original can finish while another server's attachment is being encoded. It also measures the CPU and temporary-storage cost of that overlap. It does not measure regional network latency or Discord publication.

`erome-scheduling.mjs` generated an 8-second 1280×720 H.264 fixture (11,578,046 bytes). Each arm submitted an attachment conversion to a 1 MiB budget for server A and two original inspections for servers B and C. Each original had a controlled 200 ms local delay standing in for its download. The baseline serialized these three requests, matching the previous single active preparation and two waiters. The new scheduler used its real fixed profiles. Arms ran baseline, scheduler, scheduler, baseline; there are only two observations per mode, so these are exploratory results, not production percentiles.

The disposable Node 24/Trixie candidate had two CPUs, a 1 GiB memory limit, a 256 MiB `/tmp` tmpfs, no network, a read-only root filesystem, no capabilities and no privilege escalation. It used actual FFmpeg conversion and original inspection with generated media; it had no production environment or data mounts.

| Measurement | Baseline arms | Scheduler arms |
| --- | --- | --- |
| Original B completed | 2,959 / 2,815 ms | 568 / 532 ms |
| Original C completed | 3,324 / 3,164 ms | 1,177 / 1,041 ms |
| Attachment completed | 2,591 / 2,461 ms | 2,930 / 2,687 ms |
| Whole workload | 3,330 / 3,164 ms | 2,932 / 2,687 ms |
| Original items completed before encoder | 0 / 0 | 2 / 2 |
| Temporary-storage peak increase | 11.32 / 11.32 MiB | 22.09 / 22.09 MiB |
| Container memory peak | 214.75 / 218.13 MiB | 237.75 / 241.64 MiB |
| Node RSS peak | 107.44 / 110.69 MiB | 108.69 / 109.07 MiB |
| Event-loop delay p95 within arm | 23.51 / 19.33 ms | 34.28 / 26.87 ms |
| Ordinary link rewrite p95 within arm | 0.439 / 0.307 ms | 0.336 / 0.655 ms |

Both original items retained their source hash and native dimensions. Mean workload completion improved by about 13%; attachment completion was about 11% slower. Peak temporary storage roughly doubled, and container memory increased by about 24 MiB. Ordinary rewrite calls remained below 1 ms at the measured p95, although timer lag and event-loop delay increased. The synthetic ordinary-link probe exercises the local rewrite function, not the full Discord event handler. It provides no evidence about ordinary link publication latency.

Scheduler regression tests separately cover round-robin eligible servers, FIFO within each server, one active job per server, the eight global/two per-server pending limits, queue deadlines, cancellation, draining and cleanup quarantine. The benchmark's three servers do not by themselves establish fairness under arbitrary workloads. Reservations peaked at 152 MiB (24 MiB original plus 128 MiB attachment), within the 192 MiB scheduler ceiling.

A later real cancellation check used the current close-aware process adapter. Cancellation reached the caller in 1.943 ms. The next attachment was admitted after 687.151 ms, only after the producer settled, with zero FFmpeg/ffprobe children and zero video temporary directories. An earlier compiled adapter failed this check because process completion could precede child exit; that failure prompted the close-aware fix. All six existing real FFmpeg tests passed in the same hardened candidate setup: native original inspection, complete playable output, portrait/rotation/no upscaling, lossless fitting remux plus truncation rejection, variable timing and high-frame-rate conversion. The quality suite completed in 35.94 seconds.

The final current-adapter run also included the new image regression: all seven tests passed in 34.25 seconds. Generated JPEG and PNG retained their exact bytes and native dimensions; malformed, truncated, wrong-type, animated-PNG, oversized-dimension and oversized-byte inputs were rejected. This run used the same isolated container limits and had no network or production data access.

To repeat locally after compiling the bot, run `node benchmarks/erome-scheduling.mjs` with FFmpeg and ffprobe available. `LINKY_BENCH_APP` can select a compiled application directory. `LINKY_BENCH_CANCELLATION=true` adds the Linux process/temp-file cleanup check; `LINKY_BENCH_CANCELLATION_ONLY=true` skips the four workload arms. Use an isolated container with the limits above. The script emits bounded JSON and removes its generated fixture.

No adaptive-region change is justified by this experiment: transport is mocked, and it contains no regional-tail-latency evidence. Production protocol v3 and its ten fixed parts remain unchanged.
