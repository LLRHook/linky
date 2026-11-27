# Trackers: worklogs

Read with `.cycle/TRACKERS.md`.

## Worklogs

Opt-in per person: nothing is tracked or posted unless the person whose time it is chose it.
The repo can only turn worklogs off (`"jira": {"worklog": "off"}`), never on for anyone. Needs
Jira on and time tracking on the site (`jira doctor` reports it). Used by `/implement`,
`/implement-batch`, `/hotfix` and `/spec` (REVISION, ADOPT); `auto` also covers plain requests.

| When | Do |
|---|---|
| Start of the run, before other work | `worklog state`. It lists any `unposted` time: post it first (`worklog finish <label>`, posting rules below) |
| `off`, `never` | nothing; do not ask |
| `unavailable` (credentials not loaded) | say so in one line, then as for the saved mode (`ask` or `auto`): tracking is local; posting waits for the credentials |
| `ask` | ask once, as a message of its own before any other work or question, and wait for the answer (a question folded into a plan goes unanswered): "Log this run's time to Jira? 1) yes, this run 2) no 3) always for me in this repo 4) never for me in this repo". 1 → `worklog start run --consent run`; 3 → `worklog mode auto`, then `start run --consent auto`; 4 → `worklog mode never`. No answer (unattended run) → nothing |
| `auto` | `worklog start run --consent auto`; say so in one line |
| Ticket known | `worklog retarget run <ID>`; use `<ID>` from then on (`run` stays an alias). A batch: `retarget run <bundle KEY>` (one worklog on the bundle Task); `/spec`: the branch's key, none → `drop run` and say so |
| Waiting on the person (approval gate, question) | `worklog pause <label>` before asking, `resume <label>` on the answer |
| Work committed, pushed or rebased | `worklog finish <label> --comment-file -` with one to three plain sentences on the work this session did (what changed, what was fixed or verified); no links, ids, branch names or git steps. It prints the entry. Work that leaves no git trace: `--force` |
| After `finish` posts | a follow-up session opens on its own (same ticket, branch and consent): push, PR, CI fixes, rebases, builds. A later run on the ticket joins it; its `finish` needs activity, not a commit |
| Run ends without any of that | `worklog drop <label>` |

`auto` also tracks work outside these commands: activity on a branch named for a Jira key with
no session open starts an implicit session for that key, finished like a follow-up. Unposted
follow-up and implicit time, and runs left open, are named at the next session start.

Posting:
- `run` consent, or `auto` with preview on (default): show the entry; on the person's go,
  `finish <label> --yes` (posts exactly what the preview showed, within 2 h; `--minutes N`
  when they edit the duration, `--started ISO` to post one block at a given time).
- `auto` with preview off (`worklog mode auto --preview off`): `finish <label> --yes` at once;
  report the posted line and `worklog undo <label>`. Unposted time also posts at session end.
- **Over 8 hours** (`OVER 8 HOURS`, exit 3): always ask the person, in every mode; post only
  after they confirm, with `--yes --confirm-long` (plus `--minutes N` if edited). Never pass
  `--confirm-long` without that answer.
- **Overlap with the person's other Jira worklogs** (`OVERLAPS your worklog …`, exit 3; any
  issue, machine or hand entry; checked on the blocks exactly as they will post, edits
  included): same rule, with `--confirm-overlap`. Not checkable → not posted, session kept.
- One worklog **per active window**: a quiet stretch over twice the idle cap, or a new day,
  starts a new block with its own start time. `undo` removes every block of that post.
- Runs of the same person that overlap in time (two repos, two worktrees, on this machine)
  split each shared active minute evenly, whichever finishes first; the entry lists
  `shared … with …`. Registry: `~/.claude/cycle-worklog-registry.json` (personal).
- **Cross-app id** (one id filed in several apps' trackers): every slice gets time, weighted by
  the share of changed files under its app folder (files elsewhere split evenly); `--app A` or
  `--tracker P` puts it all on one slice. Also accepted by `pause`, `resume`, `retarget`, `drop`.

After the fact: `worklog log <KEY> --started ISO --minutes N [--comment-file F]` (same checks,
marker and split; `--exact` skips the split); `worklog backfill <KEY> --transcript <session.jsonl>
[--since ISO] [--until ISO]` rebuilds untracked time from a Claude Code transcript;
`worklog sync` refreshes this clone's record of posted worklogs from Jira (edits, deletions).

Measured: active time only. Pauses are excluded. Time while a tool call or sub-agent runs
always counts; so does a background task (`run_in_background`, from launch to its completion
notification, or its output file's last write; with neither, to the next prompt, at most 4 h)
and a detached container the session started (`docker run -d`, until it exits). Between those,
activity (tool calls, `trackers.py` commands, commits, changed-file times) splits the time,
and a quiet gap longer than the idle cap (30 min; `worklog mode <mode> --idle MIN`) is
dropped. Follow-up and implicit sessions count only activity on their branch; a tool call's end
counts whichever branch it was logged on, and a call with no end of its own counts at most the
idle cap. The hooks that
see tool calls, sub-agents and transcripts are added by `start` / `mode auto` to this person's
`.claude/settings.local.json` (kept out of git; `mode never` removes them). The comment says what
was done: the `--comment-file` summary (else the `Fix` / `Implementation` line), then the work
items taken from the commit descriptions (not their key lines; merges and fixups skipped;
de-duplicated). Links, tracker ids and this project's Jira keys are removed (Jira would render
them as link cards); pushes and rebases appear only in the local preview. Each block ends with a
`[cycle-worklog <session>#<n>]` marker, so a re-run never posts twice. The personal choice lives
in this clone's `.git/config` (`cycle.worklog.*`, never committed) and is tied to the Jira
account that saved it; another account's token sees `ask`. Sessions: `.git/cycle-worklog.json`;
`worklog status` lists them.
