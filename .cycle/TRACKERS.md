# Trackers: format and commands

`bugs.md` and `features.md` hold **active work only**. Write them with
`python .cycle/trackers.py`; hand edits are blocked by the Claude Code hook and the
pre-commit lint. `CHANGELOG.md` is the ledger of shipped work and
`trackers.py show <id>` recovers any removed entry from git history. Jira is used
in the mode chosen at `/cycle-init` (Jira modes, below). Jira details (field map, epics,
bundles, workflow, planned releases, setup): `.cycle/TRACKERS-jira.md`. Worklogs:
`.cycle/TRACKERS-worklogs.md`. Read those only when the step needs them.

**Setup, once per clone:** `python .cycle/trackers.py install` (PowerShell:
`python .cycle\trackers.py install`). It sets the merge driver and the pre-commit lint, which
git never commits. Claude Code sessions (SessionStart hook) and every other `trackers.py`
command run it automatically when it is missing; `lint` warns `NODRIVER` until it has run.

## Entry shape

```
### [BUG-1792636958] Short title
- [ ] **Severity:** crit | high | med | low
- **Area:** comma-separated tags
- **Field:** single-line value
- **Field:**
  multi-line values continue on lines indented two spaces
  ```lang
  fenced blocks are indented two spaces too
  ```
```

- One `## Open` section per file; entries separated by one blank line.
- Exactly the first field carries the checkbox; it is `[x]` only at `*-pending-migration`.
- Fields appear in this order. `?` marks optional; every other field is required.

| bugs.md | features.md |
|---|---|
| Severity, Area, File(s), Observation, Expected, Req, Depends on, Repro / Notes, Found by?, Class?, Bump, Target?, Jira¹, Jira parent?, Bundle?, Assignee?, Status, Fix?, Docs?, Cross-ref?, Log? | Priority, Area, File(s), Req, Depends on, UI, Why, Approach, Library / dependency notes, Acceptance criteria, Test plan, Out of scope, Found by?, Class?, Bump, Target?, Jira¹, Jira parent?, Bundle?, Assignee?, Status, Implementation?, Docs?, Cross-ref?, Log? |

¹ Required in `enforce` mode, optional otherwise.

| Field | Allowed values |
|---|---|
| Severity / Priority | `crit`, `high`, `med`, `low` |
| Bump | `major`, `minor`, `patch` (bug default `patch`, feature default `minor`) |
| Status | `open`, `in-progress`, `fixed-pending-migration` (bugs) / `shipped-pending-migration` (features) |
| Target | the planned release `vX.Y.Z`, or `unscheduled`; written by `plan` or `set` (`TRACKERS-jira.md`, "Planned releases") |
| Jira | one issue key (`PROJ-123`) or `pending`; required only in `enforce` mode |
| Jira parent | the epic's key (pick from `trackers.py jira epics`); sets the issue's parent in Jira |
| Bundle | the bundle Task's key; written only by `trackers.py bundle` (`TRACKERS-jira.md`, "Bundles") |
| Assignee | who is building it: written by `set <ID> Status in-progress` (the Jira issue's assignee with Jira on, else `git config user.name`); `set <ID> Assignee me` takes it over |
| Found by | where a finding was found, set by whoever files it: `build` (the implementer, outside its own ticket), `panel-qa`, `panel-review`, `panel-security`, `protocol`, `gui-walkthrough`, `audit`, `ci`, `human-qa`, `human-review`, `human-security`, `staging`, `production`, `user`. Every BUG carries it; a feature carries it only when it is a gap a check found, not planned work |
| Class | the risk dimension the finding belongs to, from `.cycle/RISKS.md` when present (else the bundle's default list); one short phrase |
| Req, Depends on | ids, or `none` with the source; `unknown` only on pre-schema entries |
| Log | bullets `  - YYYY-MM-DD <label>: <text>`: sightings, decisions, audit notes |

Any other field name is an error: put that content in `Log`.

## Ids and cross-app work

- New ids are epoch seconds (`BUG-$(date +%s)`); `add` mints them. Never reuse an id.
- A cross-app item is filed in each app's tracker under the **same id** (`add --id`).
  Each app's slice gets **its own Jira issue**; its External ID is `<app>:<id>`.

## Lifecycle

| Step | Command |
|---|---|
| File | `trackers.py add --tracker apps/<app>/bugs.md --json entry.json` (with Jira on, creates the issue and fills `Jira:`) |
| Start | `trackers.py set <ID> Status in-progress` (moves the issue to In Progress; assigns it, and its bundle Task, to the Jira token's user when unassigned, and writes `Assignee`; an issue a teammate holds stays theirs: `set <ID> Assignee me` takes it) |
| Finish | `set <ID> Status fixed-pending-migration` (or `shipped-…`; moves the issue to the review status, if any), then `set <ID> Fix "<summary>"` (`Implementation` for features) and `set <ID> Docs "<files or none>"` |
| Migrate (protocol only, after a green run) | `trackers.py migrate <ID>` or `migrate --all`: appends `- [ID] KEY Title (Req: …) [bump]` to `CHANGELOG.md / Unreleased / Fixed\|Added` (`--section Changed` etc.) and removes the entry; moves the issue to Done (QA gate: `TRACKERS-jira.md`, "Jira workflow") |
| Close without shipping | `trackers.py close <ID> --reason duplicate\|wontfix\|superseded\|cannot-reproduce\|not-a-defect` (Done, with the matching resolution) |
| Note | `trackers.py log <ID> "<text>" [--label Sighting]` |

In `enforce` mode, `migrate` and `close` refuse an entry whose `Jira:` is `pending`: run `jira sync` first.

## Commands

| Command | Does |
|---|---|
| `add --tracker P (--json F\|- \| --field "Name=value"…) [--id ID] [--no-jira] [--dry-run]` | validate, append to `## Open`, create the Jira issue; a JSON array files a batch (per-item `tracker`, `prov` ids resolved in `Depends on`/`Cross-ref`; all or nothing) |
| `set ID FIELD VALUE\|-\|--file F [--app A] [--no-jira]` | replace one field (or `title`); `-` reads stdin (UTF-8); a `Status` change moves the issue; `in-progress` assigns it (Lifecycle); a `Target` change sets the planned fix version |
| `set --json F\|-` | an array of `{id, field, value[, tracker, app]}` in one write, all or nothing; `Status`, `Target`, `Assignee`, `Jira`, `Jira parent`, `Bundle` and `title` are refused (one `set` each) |
| `log ID TEXT [--label L] [--date D]` | append a Log bullet |
| `migrate ID… \| --all [--section S] [--skip-gate] [--no-jira]` | ledger line + removal + Done; entries waiting on the QA gate stay |
| `close ID --reason R [--force] [--no-jira]` | removal without a ledger line; Done with a resolution |
| `show ID [--app A]` | current entry, or the last version in git history |
| `freeze vX.Y.Z [--date D] [--dry-run]` | `/release` only: `CHANGELOG.md` `## Unreleased` → `## [vX.Y.Z] - D`, fresh empty `Unreleased`; no-op when already frozen |
| `branch ID [ID…] [--type feature\|bugfix\|hotfix\|bundle] [--slug S] [--max N]` | the branch name for these tickets |
| `worklog …` | opt-in Jira worklogs (`.cycle/TRACKERS-worklogs.md`) |
| `bundle …`, `plan …`, `jira …` | Jira commands (`.cycle/TRACKERS-jira.md`, "Commands") |
| `commit-msg FILE` | the git commit-msg hook ("Branches and commits") |
| `escapes [--since REF \| --days N] [--json]` | the bugs (and features with `Found by`) filed since the last tag, a ref or N days, counted by `Found by` and severity, and by `Class`; migrated and closed ones count |
| `export [--status open\|todo\|in-progress\|pending\|all] [--type bug\|feature] [--app A] [--area T] [--ids I,J] [--no-key] [-o F \| --json]` | entries to a Markdown file for review; `--json`: entries as data plus shipped ids (`/prioritize`) |
| `lint [--fix] [--staged]` | schema + integrity (`NESTED`: an entry heading indented inside another entry; `UIDEFER` warns when `UI: deferred (…)` names no id; `NOFILES` when no tracker exists); `--fix` applies order, checkbox and indent repairs, and `Jira: pending` where Jira is enforced and the field is missing |
| `adopt [--dry-run] [--report F] [--accept-missing ID,…] [--no-jira]` | one-time upgrade of legacy trackers to this format; writes nothing if an entry would vanish (an unclosed code fence); removed entries' Jira issues go to Done |
| `install [--auto] [--no-config] [--no-docs]` | vendor to `.cycle/`; `.gitattributes`; Claude hooks (block hand edits, set up the clone at session start); git hooks (pre-commit lint, commit-msg key check); merge driver; `CLAUDE.md` and `README.md` setup blocks. `--auto`: clone setup only, quiet |

`--app` picks one tracker when a cross-app id is filed in several.

## Jira modes

Chosen when `/cycle-init` sets the project up (or upgrades it) and stored in
`.cycle/tracker.json`. Change it later with `/cycle-init jira enforce|optional|off`, which
runs `trackers.py jira configure`.

| Mode | `tracker.json` | `add` | `Jira:` field | `migrate` / `close` |
|---|---|---|---|---|
| `enforce` | `jira` block, `"enforce": true` | creates the issue; `pending` when offline | required; lint warns `PENDING` | refuse `pending` |
| `optional` | `jira` block, `"enforce": false` | creates the issue when credentials are set | optional | no Jira check |
| `off` | no `jira` block | no Jira call | optional | no Jira check |

`jira push`, `jira sync` and `jira doctor` work in `enforce` and `optional`.

## Branches and commits

- Branch: `python .cycle/trackers.py branch <ID> [<ID>...] [--type hotfix|bundle] [--slug "<summary>"]`
  prints `feature/<KEY>-<summary>` (features), `bugfix/<KEY>-<summary>` (bugs),
  `hotfix/<KEY>-<summary>` (`/hotfix`) or `bundle/<KEY>-<summary>` (the bundle's key). `<KEY>` is
  the issue key in this project's own Jira (`ARC-42`, `LUM-7`), else the tracker id until the
  issue exists (then `git branch -m`); lowercase ASCII words, at most 60 characters (Bitbucket
  Data Center allows 89 for a branch name; Cloud documents no limit).
- Commit: line 1 is the branch's key, alone; line 2 blank; then the message,
  `<title> (<tracker id>)` plus any body. A commit for a ticket other than the branch's
  (a bundle member, a second ticket on one branch) starts the message with that ticket's key:

  ```
  ARC-310

  ARC-301 Reject expired invite tokens (BUG-1792636958)
  ```

  `git commit -m ARC-310 -m "ARC-301 Reject expired invite tokens (BUG-1792636958)"`.
  Jira links a commit to every key in its message, so it shows on both issues. With Jira
  off (no keys), the message alone.
- Enforced in `enforce` mode by the `commit-msg` hook (`install` adds it to every clone).
  Exempt: `main`, `master`, `trunk`, `release/*`, the remote's default branch
  (`jira.commits.exempt` replaces the list), detached HEAD, merges, `fixup!`/`squash!`/
  `amend!` and `Revert "` commits. A branch with no key, or still named for a tracker id, is
  refused. Never bypass it with `--no-verify`.
- Fix up an earlier commit by its SHA, not its subject (every subject on a branch is the
  same key): `git commit -m "fixup! <full sha>"`, then before pushing
  `GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash <base>`.
- A PR title lists every key. Jira links commits, branches and PRs to issues only by key.
