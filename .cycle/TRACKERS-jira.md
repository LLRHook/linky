# Trackers: Jira

Read with `.cycle/TRACKERS.md` (entry shape, lifecycle, branches). Jira is read and written
only through `trackers.py`.

## Commands

| Command | Does |
|---|---|
| `plan --from FILE [--dry-run] [--no-jira]` | write `Target` from a release plan; create or describe the Jira versions; set each issue's planned fix version ("Planned releases") |
| `bundle create ID ID… --summary S [--dry-run]` | Jira Task for a batch: creates it, links it to each member, writes `Bundle:`, prints the branch |
| `bundle add BKEY ID…` / `bundle remove ID…` | join or leave a bundle (link and `Bundle:` field) |
| `bundle sync BKEY` | move the bundle level with its members (retries) |
| `jira push FILE [--dry-run]` | create issues for an export file's entries; keys go back into the trackers and the file |
| `jira sync [--app A] [--dry-run] [--limit N]` | create or link issues for every entry with `Jira: pending`; each new issue is moved to the column its entry's `Status` maps to |
| `jira doctor [--write]` | check credentials, create screens, statuses and permissions; `--write` saves the field map and `jira.workflow` |
| `jira status [--apply] [--app A]` | pending entries against the board: ready, waiting (QA), rejected; `--apply` sets rejected ones back to `in-progress` |
| `jira done [KEY…] [--dry-run]` | move every issue on a CHANGELOG ledger line that is not Done to Done (catch-up, retries); with KEYs, only those (issues whose entries left with no keyed ledger line) |
| `jira release VERSION [--dry-run] [--force]` | set fix version VERSION on the issues of that CHANGELOG section; refuses when VERSION already holds other issues (a planned version with the same name: rename it in Jira first) |
| `jira versions [--json]` | versions with released/date, issue and open counts, and the entries targeting each |
| `jira report [--since D] [--until D] [--out F]` | read-only JSON for `/status-log`: versions; every issue unresolved, on an unreleased version, resolved since D or with a worklog in the window (type, status category, epic, fix versions, created/resolved); every worklog by any author started in the window (no comment text). Window defaults to the last 365 days |
| `jira version add NAME [--description D] [--released [--date D]]` / `edit NAME [--rename NEW] [--description D]` | create or change a version (`--rename` rewrites `Target`) |
| `jira version renumber OLD=NEW… [--dry-run]` | rename planned versions in a collision-free order and rewrite `Target` on their entries |
| `jira version release NAME [--date D] [--dry-run]` | mark released; the date defaults to the CHANGELOG section's |
| `jira version show [NAME…] [--open] [--app A] [--json]` | the issues in a version (no NAME: every unreleased version and every `Target:` in use), left ones first, joined to their entries, each with its drift from the trackers |
| `jira version reconcile [NAME…] [--app A] [--dry-run]` | make Jira match the trackers for those versions: fix versions from `Target:`, columns from `Status` (forward only), ledger issues to Done; exit 1 while drift remains |
| `jira epics [--json]` | list the project's open epics (key, name; `--json` adds each one's description, i.e. its scope) |
| `jira epic add "NAME" [--scope S] [--req IDS] [--dry-run] [--json]` | create an epic (description: scope and requirement ids), or reuse the open epic with that name; prints the key |
| `jira parents [--dry-run] [--force]` | reconcile epics: set Jira's from `Jira parent` (or a rule) where Jira has none; take Jira's into the entry where the entry names none or a non-epic |

issue is created, `jira push` and `jira sync` look the External ID up in Jira, so
re-running them links issues that already exist instead of making duplicates.

## Field map

Required custom fields on the project's create screen (Steps to Reproduce, Components,
Acceptance Criteria, …) are filled from tracker fields through `jira.fields.map`, per
issue kind. `jira doctor` reads the project's create screen, lists every required field
and suggests a source; `jira doctor --write` saves the suggestions.

```json
"fields": {
  "externalId": "customfield_10247",
  "map": {
    "bug":     {"customfield_10251": "Repro / Notes",
                "customfield_10246": {"from": "@areas", "valueMap": {"frontend": "ui"}, "default": "tooling"}},
    "feature": {"customfield_10248": "Acceptance criteria", "customfield_10249": "Test plan",
                "customfield_10246": {"from": "@areas", "default": "tooling"}}
  }
}
```

Sources: a tracker field name, `@areas` (Area tags, also split on `/`), `@title`, `@id`,
`@app`, `@external`, or `=literal`. Values are shaped by the field's type (text,
single or multi select, labels, number). Select options are matched case-insensitively;
`valueMap` renames tags first; `default` fills a field when nothing matches. A mapped
tracker field is left out of the description. `jira sync --dry-run` (with credentials)
lists each entry that would still miss a required field.

## Epics

Every issue goes under an epic: the entry's `Jira parent`. Whoever files the entry picks
the epic from `trackers.py jira epics --json` by what each epic covers, and asks the user when
none clearly fits. An epic is a capability, not a release, app or single ticket. A new one is
made only with `trackers.py jira epic add` (after approval; `/groom` §1.8), which reuses an
open epic of the same name. Data Center's required Epic Name gets the name; any other field
the Epic create screen requires needs a literal in `jira.fields.map.epic`; `jira doctor`
checks it (`jira.issueTypes.epic` renames the type). Optional fallbacks in `.cycle/tracker.json`, first match wins:

```json
"epics": {
  "required": true,
  "rules": [{"match": {"app": "tlm"}, "epic": "KED-211"},
            {"match": {"area": "perf"}, "epic": "KED-221"},
            {"match": {"req": "SCORE-FR"}, "epic": "KED-623"}],
  "default": null,
  "field": "parent"
}
```

`match` keys: `app`, `area`, `req` (id prefix), `title` (regex), `kind` (`bug`/`feature`).
`required` makes lint warn `NOEPIC`. `field` is `parent` on Jira Cloud; on Data Center
use the Epic Link field id. Only open epics of the project count: a bundle, story or
tracker id in `Jira parent` is ignored. `jira sync --dry-run` shows each entry's epic;
`jira parents` reconciles existing issues (a differing epic on both sides is kept unless
`--force`, which makes the tracker win).

## Bundles

A batch (`/implement-batch`) is one Jira **bundle**: a Task (label `cycle-bundle`;
`jira.issueTypes.bundle`) that is linked `implements` to each member, so each member shows
"is implemented by <bundle>". Jira modes `enforce` and `optional`, with credentials.

- `bundle create <IDs> --summary "<summary>"` at plan approval (members without an issue get
  one first); the branch is `bundle/<KEY>-<summary>`. Required Task fields with no tracker
  source take literals: `jira.fields.map.bundle {"<field id>": "=<value>"}`.
- The bundle moves with its members: `set … Status` moves it to the least-advanced member's
  status; `migrate` gates each member on the **bundle's** status (QA moves only the bundle)
  and moves the bundle to Done once no member is left; `close` of the last member does too.
- `bundle remove <ID>` takes a ticket out (link and field). `jira doctor --write` checks the
  Task type and the link type (`jira.bundles.link`, default `Implements`) and saves them.

## Jira workflow

Status changes move the issue (Jira modes `enforce` and `optional`, with credentials; never
backwards, one transition at a time). Board setup and the Bitbucket rule for staging:
the bundle's `docs/jira-workflow.md`.

| Tracker | Jira (`jira.workflow`) |
|---|---|
| `set … Status in-progress` | `inProgress` (default: first In Progress-category status) |
| `set … Status *-pending-migration` | `review`, if set |
| `migrate` | `done` (default: the Done-category status). With `gate` set, only entries whose issue (a bundle member: the bundle) is in a `gate` status migrate; the others are reported "waiting on QA" |
| `close` | `done`, resolution from `resolutions` (`duplicate` → Duplicate, `wontfix` → Won't Do, …) |

```json
"workflow": {"inProgress": "IN PROGRESS", "review": "CODE REVIEW", "gate": ["AWAITING MIGRATION"],
             "done": "DONE", "order": ["TODO", "IN PROGRESS", "CODE REVIEW", "QA (STAGING)", "AWAITING MIGRATION", "DONE"]}
```

- Statuses the project does not have are skipped: no `review` status, no review move; no
  `gate` status, no gate. Leave them out for a small board.
- An issue moved back before `review` (or to To Do) means review or QA sent it back:
  `migrate` and `jira status --apply` set the entry back to `in-progress` and log it.
- A configured gate needs credentials: without them `migrate` refuses (`--skip-gate` overrides).
  An entry whose id is already in the CHANGELOG (a hotfix) skips the gate.
- A Jira error never undoes a migrate: the ledger line stays, and `jira done` retries.

## Planned releases

A release plan (from `/prioritize`, on request) lives in each entry's `Target` and in Jira's
unreleased fix versions; `trackers.py` keeps them equal.

```markdown
## v1.4.1 - Lock and sync fixes
- BUG-12, FEAT-30
## v1.5.0 - Search
- FEAT-31 FEAT-33
## Unscheduled
- FEAT-40
```

- `plan --from FILE` (this Markdown or JSON `{"versions": [{"name", "description", "ids"}],
  "unscheduled": [ids]}`) prints per version added / left / kept and the unplanned entries,
  then writes. Re-plans move an issue (set semantics); released fix versions are never removed.
- A version number already used by a release (CHANGELOG section) is stale: lint warns
  `STALE-TARGET`; `jira release` refuses while open entries still target it. After a merge that
  released planned numbers: `jira version renumber v1.3.0=v1.5.0 v1.4.0=v1.6.0`.
- `/release`: move entries still targeting the version, `jira release vX.Y.Z` after the tag, then
  `jira version release vX.Y.Z` only once deploy verify is green.
- What is left in a version, and whether Jira agrees: `jira version show vX.Y.Z --open`. The
  trackers are the source. `reconcile` fixes what they decide (an issue's fix version follows
  `Target:`; In Progress follows `in-progress`; a CHANGELOG issue goes to Done) and only reports
  the rest: an issue with no entry, an entry with no `Target:` (`set <ID> Target` adopts Jira's
  plan), Done in Jira but active in the tracker, open in the tracker but started in Jira, a pending
  entry moved back (`jira status --apply`), slices that disagree, `Jira: pending` (`jira sync`).
- Jira is read and written only through `trackers.py`; the `jira-guard` hook blocks REST calls
  and imports of `tracker_ops` / `worklog` from Bash. If no command fits, stop and say which.
  The same hook blocks direct CI/CD API and CLI calls (`gh workflow|run|api`, `glab ci`, the
  Bitbucket/GitHub/GitLab APIs, CodeBuild/CodePipeline starts); CI results are read only with
  `local-gate`'s `ci_evidence.py`.

## Jira setup

`.cycle/tracker.json` (committed):

```json
{
  "format": 2,
  "jira": {
    "site": "https://<site>.atlassian.net",
    "project": "KED",
    "enforce": true,
    "issueTypes": {"bug": "Bug", "feature": "Story", "bundle": "Task"},
    "bundles": {"link": "Implements"},
    "fields": {"externalId": "customfield_10247", "acceptanceCriteria": null, "testPlan": null},
    "components": false
  },
  "apps": {"apps/tlm": "tlm"}
}
```

Each repo points at its own Jira: any Atlassian Cloud site or a Data Center server.
Credentials live in each person's environment and are never committed: the Atlassian
login email and a classic API token from id.atlassian.com (no scopes).

**Credentials, in order of precedence** (`jira doctor` prints the variable it used):

1. Variables the repo names: `"auth": {"emailEnv": "X", "tokenEnv": "Y"}`.
2. Site-specific variables, so one person can hold several Jira accounts at once:
   `JIRA_EMAIL_<SITE>` / `JIRA_API_TOKEN_<SITE>`, where `<SITE>` is the first part of the
   host in capitals with `-` → `_` (`paradigmtest-dev1.atlassian.net` → `PARADIGMTEST_DEV1`).
3. `JIRA_EMAIL` / `JIRA_API_TOKEN`.

Data Center with a personal access token: `"auth": {"type": "bearer", "tokenEnv": "Y"}`.

The config's `site` and `project` always win; `JIRA_SITE` / `JIRA_PROJECT` only fill a
missing value. `jira doctor` prints the custom-field ids for the config (without an
External ID field, duplicates are found by the `<id>` + `<app>` labels instead). Without
credentials, `add` writes `Jira: pending` (enforce) and the next `jira sync` fills it in.
