# Changelog

Bug fixes are migrated here from `bugs.md` once verified. Features are
migrated from `features.md`. Each entry keeps the original `BUG-<id>` /
`FEAT-<id>` so history can be traced both ways.

The format is loosely [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
with `Verified`, `Added`, `Changed`, `Fixed`, `Removed`, and `Security`
sections under each release/date heading. Each migrated line ends with its
version-bump marker (`[major]`, `[minor]` or `[patch]`), which `/release` reads.

Work that shipped before the trackers existed (2026-09-24) is recorded in the
Git history and pull requests, not here.

---

## Unreleased

### Verified

### Added

### Changed

### Fixed

- [BUG-1790270870] Docs named the CI Node matrix as 22 and 24; now 22, 24 and 26, and `SECURITY_AUDIT.md` points at `bugs.md`. [patch]
- [BUG-1790785731] Discord two-factor or permission refusals while deleting an original now keep the verified preview as a reply with Remove/Details controls and report a permission outcome; /diagnose flags servers that require moderator 2FA. [patch]

- [BUG-1792536754] Manual `/fix` and Apps → Fix with Linky now translate tweets and quotes in servers and DMs, honor translation settings, and preserve native previews when translation or required attachments are unavailable. [patch]
- [BUG-1792537162] Empty outer X posts now preserve their media while showing usable English translations of quoted text without an invented source-language label. [patch]

### Removed

### Security
