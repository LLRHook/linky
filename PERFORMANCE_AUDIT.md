# Linky performance baseline

Measured on 2026-09-30 against `a3375b4` and the cleanup branch. This is the first baseline owned by the performance-audit workflow. It measures local CPU work; Discord publication, provider requests and client playback are separate.

## Environment and method

Windows x64, Node v24.15.0, Intel(R) Core(TM) i7-14700, 28 logical CPUs and 31.77 GiB RAM. The measurements were taken on the development machine, not Hostinger.

The focused probes used 1,000 messages assembled from 13 synthetic cases: ordinary text, six social platforms, YouTube, a public-article candidate, unrelated URLs with nested links, code, spoilers and suppressed links. Source inputs were at most 1,920 characters. Preview construction used 1, 8 and 40 distinct X posts; inspection used 8 video embeds, within Discord's ten-embed limit. Forty expected posts measure local handling of a dense message; they do not imply Discord can display forty previews.

Each case had three warm-up rounds and seven measured rounds, with 10,000 rewrite calls, 500 one/eight-link construction calls, 100 forty-link calls or 1,000 inspection calls per round. The complete before/after comparison was repeated using the same compiled baseline and machine. The table records the repeat, which agreed with the first run's larger multi-link improvements. The p95 column is the p95 of seven round averages, not individual-message tail latency or production p95.

Run the repository-owned CPU probe after `npm run build` as `node benchmarks/link-handling.cjs`, or pass a compiled app directory to compare revisions. It preserves the synthetic corpus and measurement loop used for this baseline. The operator's cold-module-load probe and raw JSON results stay outside the repository. The existing isolated media experiment is documented in [benchmarks/erome-scheduling.md](benchmarks/erome-scheduling.md).

## Local CPU measurements

| Path | Before median ms/call | Current median ms/call | Current p95 round average ms/call | Median change |
| --- | ---: | ---: | ---: | ---: |
| rewrite-mixed-corpus | 0.003119 | 0.003101 | 0.003123 | -0.6% |
| expectations-1-links | 0.005689 | 0.005902 | 0.006120 | +3.7% |
| expectations-8-links | 0.264302 | 0.046413 | 0.046642 | -82.4% |
| expectations-40-links | 6.635045 | 0.244583 | 0.247218 | -96.3% |
| inspect-8-video-previews | 0.370148 | 0.245877 | 0.246754 | -33.6% |

There is no approved absolute CPU budget. [FEAT-1790270881](features.md#feat-1790270881-latency-guard-for-the-ordinary-link-rewrite-hot-path) still proposes a budget and a repeatable CI guard; this cleanup does not mark that feature shipped. All five paths were measured; none had a slowdown over the audit's 10% flag threshold in the repeat. Future comparisons must use the same environment and inputs. A slowdown over 25% is a candidate investigation, not proof of a defect from one run. No absolute-budget pass/fail classification is possible yet.

## Cleanup and measured improvements

`expectedPreviews` now indexes rendered provider links once rather than rescanning the rendered message for every source. The last visible provider for a post identity still wins, and source order, aliases, fragments and deliberately hidden links retain their existing behavior. `inspectPreviews` computes missing expectations once instead of matching the full set twice.

Automatic reposts and `/fix` share the native/authored preview-composition check. Their source, permission, cancellation, ownership and deletion checks remain at their entry points. Tweet rendering lives in `TweetPresentation`; source attachment verification lives in `RepostAttachments`; pure social rewriting lives in `SocialProviders`. The original `SocialLinkService` exports remain available to existing callers.

The pure rewrite API can now be loaded through `SocialProviders` without importing the Discord delivery graph. Across seven fresh child processes after one warm-up process, median module-load time was 297.01 ms through the former handler import and 2.50 ms through the pure module. Median child-process RSS snapshots were 83.20 MiB and 44.57 MiB. These are different entry-point imports for the same pure function, not a reduction in the running bot's memory or login time. The isolated scheduler benchmark uses the lighter import.

## Coverage and next measurements

The existing media benchmark requires an isolated Linux container and FFmpeg. It was not re-run in this audit because this cleanup changes neither media processing nor scheduling. Its September 15 results are historical context, not a fresh baseline. Production stress/load, full bot startup and sustained memory profiling were not run. There is no frontend in this repository.

Read-only delivery archives are useful for identifying slow stages, but their attempts do not include every posted link or establish client playback. Mobile-share normalization currently precedes creation of the delivery attempt in both entry points, so its network time is absent from reported duration. Ordinary-provider cache decisions also lack observed hit/miss coverage. These measurement gaps are tracked in `features.md`; private production reports and failure-code observations stay outside this repository.

## Accepted slow paths

No slow path has been accepted against an absolute budget. Provider and Discord delays have not been classified as CPU regressions. Improve measured diagnostics before changing preview wait windows, cache limits or concurrency.
