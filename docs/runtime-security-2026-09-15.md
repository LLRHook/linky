# Bot runtime image comparison, 2026-09-15

Recommend the official Node 24 Trixie slim image, applying Debian updates and removing bundled package managers only in the runtime stage. The current application files were copied unchanged from production into two separate candidate images. Production was not retagged, restarted, or given any candidate data.

| Image | Debian/Alpine package scan | Fixable findings | Image bytes | Existing real FFmpeg tests |
| --- | --- | --- | --- | --- |
| Production Bookworm | 10 critical, 239 high, 341 medium, 221 low, 70 unknown | 15: 6 high, 7 medium, 2 low | 712,863,557 | Baseline |
| Trixie candidate | 1 critical, 200 high, 197 medium, 165 low, 27 unknown | 0 | 738,749,187 | 6 passed, 37.50 seconds |
| Alpine comparison | 0 reported | 0 reported | 325,077,111 | 6 passed, 29.84 seconds |

Trixie residuals deduplicate to 1 critical and 36 high CVEs. The table below lists every one. Repeated findings across FFmpeg or util-linux binary packages do not mean independent vulnerabilities. The Trixie candidate has no node-pkg vulnerability findings; bundled npm/Corepack removal eliminated the vulnerable global tooling without changing the application's dependencies.

Alpine's zero is not equivalent coverage: [Trivy's Alpine documentation](https://trivy.dev/docs/latest/coverage/os/alpine/) says unfixed vulnerabilities are unsupported. The installed FFmpeg 8.1.2-r0 still falls in affected upstream ranges, including [CVE-2026-64830](https://security-tracker.debian.org/tracker/CVE-2026-64830). Its [official Alpine recipe](https://raw.githubusercontent.com/alpinelinux/aports/3.24-stable/community/ffmpeg/APKBUILD) has no corresponding backport patch. Alpine uses musl; the [Node image project](https://github.com/nodejs/docker-node/blob/main/README.md#musl-builds-for-alpine) classifies amd64 musl support as experimental. Current installed application dependencies contain no .node binaries, and all six tests passed, but this does not establish compatibility with future native modules. FFmpeg is an Alpine community package, whose normal support lasts until the next stable release according to [Alpine's policy](https://alpinelinux.org/releases/).

The Trixie manifest was verified against the public Docker registry: the response digest matched SHA-256 of the exact manifest bytes. The official Node image is Node 24.21.0. The candidate installed Debian FFmpeg 7:7.1.5-0+deb13u1.

The remaining critical finding is libxml2 CVE-2026-6653. [Debian](https://security-tracker.debian.org/tracker/CVE-2026-6653) records it as a minor issue with no DSA for Trixie; the scanner's critical severity should be retained alongside that distro assessment. FFmpeg's 16 high CVEs are deferred pending fixes in its 7.1 branch. No fixed-version update was available from the enabled stable repositories at the scan time. Keep an unfiltered scan report in addition to the CI gate using --ignore-unfixed, so newly patched or newly disclosed residuals remain visible.

The application already restricts ffprobe/FFmpeg input to the MOV demuxer and local file protocols (file,pipe for streamed conversion), disables external data references and absolute data paths, caps individual allocations at 128 MiB, strips subprocess environment variables to PATH/LANG/LC_ALL, and uses private temporary files. Original inspection is capped at 24 MiB and 2 seconds; conversion probes have 15-second deadlines and encoding has a 150-second deadline. Output is bounded, with fixed MP4/H.264/AAC options and two decoding/filter threads. The runtime user is nonroot. These controls reduce relevant attack paths; they do not prove codec probing safe, and environment stripping does not isolate the child from other processes/files owned by the same user.

Compose provides a bounded /tmp tmpfs and a dedicated /app/data volume. The reviewed Compose change adds a read-only root filesystem, all capabilities dropped, and no-new-privileges. The hardened rerun passed all six tests in 35.246 seconds, with zero failures or skipped tests; a separate smoke test passed module loading, rootfs write rejection, settings write/reload with mode 0600, and media publish/bind/reload/release. Tests ran with those restrictions, plus --network none, a fresh anonymous /app/data volume, 1 GiB memory, 2 CPUs, and 128 PIDs. All six video tests passed under the hardened flags in 35.246 seconds. The memory/CPU/PID limits are test constraints; they are not configured in production. There is no separate per-FFmpeg process namespace, custom syscall policy, or sandbox that hides the bot's same-UID files. Protocol restrictions do not block post-exploitation network syscalls.

The main residual groups involving mount/nsenter, systemd-homed, infocmp, tiffcrop, Perl Archive::Tar, and cJSON patch APIs are not invoked by the bot's media path. Some findings apply to source packages while only libraries are installed. This is reachability triage, not an assertion that the whole package is unaffected. The forced MOV input and fixed MP4 output exclude the specifically identified VobSub/RTP/DASH demuxers and S/PDIF/MPEG-PS muxers; arbitrary codec parsing during probing remains a concern. See each Debian advisory for scope before suppressing any finding.

Use the maintained repository's normal builder stage for the release image, then scan and test that image. The scratch recipes deliberately copied production application bits to isolate this OS comparison.

| CVE | Severity | Trivy/Debian status | Affected installed packages | Debian advisory |
| --- | --- | --- | --- | --- |
| CVE-2026-76642 | HIGH | affected | bsdutils, libblkid1, liblastlog2-2, libmount1, libsmartcols1, libuuid1, login, mount, util-linux | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-76642) |
| CVE-2026-78408 | HIGH | affected | bsdutils, libblkid1, liblastlog2-2, libmount1, libsmartcols1, libuuid1, login, mount, util-linux | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-78408) |
| CVE-2026-78409 | HIGH | affected | bsdutils, libblkid1, liblastlog2-2, libmount1, libsmartcols1, libuuid1, login, mount, util-linux | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-78409) |
| CVE-2026-78410 | HIGH | affected | bsdutils, libblkid1, liblastlog2-2, libmount1, libsmartcols1, libuuid1, login, mount, util-linux | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-78410) |
| CVE-2026-58049 | HIGH | fix_deferred | ffmpeg, libavcodec61, libavdevice61, libavfilter10, libavformat61, libavutil59, libpostproc58, libswresample5, libswscale8 | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-58049) |
| CVE-2026-64830 | HIGH | fix_deferred | ffmpeg, libavcodec61, libavdevice61, libavfilter10, libavformat61, libavutil59, libpostproc58, libswresample5, libswscale8 | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-64830) |
| CVE-2026-64832 | HIGH | fix_deferred | ffmpeg, libavcodec61, libavdevice61, libavfilter10, libavformat61, libavutil59, libpostproc58, libswresample5, libswscale8 | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-64832) |
| CVE-2026-64833 | HIGH | fix_deferred | ffmpeg, libavcodec61, libavdevice61, libavfilter10, libavformat61, libavutil59, libpostproc58, libswresample5, libswscale8 | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-64833) |
| CVE-2026-64834 | HIGH | fix_deferred | ffmpeg, libavcodec61, libavdevice61, libavfilter10, libavformat61, libavutil59, libpostproc58, libswresample5, libswscale8 | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-64834) |
| CVE-2026-64835 | HIGH | fix_deferred | ffmpeg, libavcodec61, libavdevice61, libavfilter10, libavformat61, libavutil59, libpostproc58, libswresample5, libswscale8 | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-64835) |
| CVE-2026-66036 | HIGH | fix_deferred | ffmpeg, libavcodec61, libavdevice61, libavfilter10, libavformat61, libavutil59, libpostproc58, libswresample5, libswscale8 | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-66036) |
| CVE-2026-66039 | HIGH | fix_deferred | ffmpeg, libavcodec61, libavdevice61, libavfilter10, libavformat61, libavutil59, libpostproc58, libswresample5, libswscale8 | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-66039) |
| CVE-2026-66040 | HIGH | fix_deferred | ffmpeg, libavcodec61, libavdevice61, libavfilter10, libavformat61, libavutil59, libpostproc58, libswresample5, libswscale8 | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-66040) |
| CVE-2026-66041 | HIGH | fix_deferred | ffmpeg, libavcodec61, libavdevice61, libavfilter10, libavformat61, libavutil59, libpostproc58, libswresample5, libswscale8 | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-66041) |
| CVE-2026-70628 | HIGH | fix_deferred | ffmpeg, libavcodec61, libavdevice61, libavfilter10, libavformat61, libavutil59, libpostproc58, libswresample5, libswscale8 | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-70628) |
| CVE-2026-70632 | HIGH | fix_deferred | ffmpeg, libavcodec61, libavdevice61, libavfilter10, libavformat61, libavutil59, libpostproc58, libswresample5, libswscale8 | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-70632) |
| CVE-2026-75142 | HIGH | fix_deferred | ffmpeg, libavcodec61, libavdevice61, libavfilter10, libavformat61, libavutil59, libpostproc58, libswresample5, libswscale8 | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-75142) |
| CVE-2026-75143 | HIGH | fix_deferred | ffmpeg, libavcodec61, libavdevice61, libavfilter10, libavformat61, libavutil59, libpostproc58, libswresample5, libswscale8 | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-75143) |
| CVE-2026-75144 | HIGH | fix_deferred | ffmpeg, libavcodec61, libavdevice61, libavfilter10, libavformat61, libavutil59, libpostproc58, libswresample5, libswscale8 | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-75144) |
| CVE-2026-75146 | HIGH | fix_deferred | ffmpeg, libavcodec61, libavdevice61, libavfilter10, libavformat61, libavutil59, libpostproc58, libswresample5, libswscale8 | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-75146) |
| CVE-2026-54369 | HIGH | affected | libacl1 | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-54369) |
| CVE-2026-16554 | HIGH | affected | libcjson1 | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-16554) |
| CVE-2026-29036 | HIGH | affected | libcjson1 | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-29036) |
| CVE-2026-67215 | HIGH | affected | libcjson1 | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-67215) |
| CVE-2026-67216 | HIGH | affected | libcjson1 | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-67216) |
| CVE-2026-87933 | HIGH | affected | libcjson1 | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-87933) |
| CVE-2026-76956 | HIGH | affected | libexpat1 | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-76956) |
| CVE-2026-76957 | HIGH | affected | libexpat1 | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-76957) |
| CVE-2025-69720 | HIGH | affected | libncursesw6, libtinfo6, ncurses-base, ncurses-bin | [advisory](https://security-tracker.debian.org/tracker/CVE-2025-69720) |
| CVE-2026-37555 | HIGH | affected | libsndfile1 | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-37555) |
| CVE-2026-16742 | HIGH | affected | libsystemd0, libudev1 | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-16742) |
| CVE-2026-36849 | HIGH | will_not_fix | libtiff6 | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-36849) |
| CVE-2026-52490 | HIGH | affected | libtiff6 | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-52490) |
| CVE-2026-6653 | CRITICAL | affected | libxml2 | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-6653) |
| CVE-2026-74860 | HIGH | affected | libxml2 | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-74860) |
| CVE-2026-86140 | HIGH | affected | libxml2 | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-86140) |
| CVE-2026-9538 | HIGH | fix_deferred | perl-base | [advisory](https://security-tracker.debian.org/tracker/CVE-2026-9538) |


