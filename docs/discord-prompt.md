# Discord coding requests

This optional integration lets administrators in operator-approved servers submit
`/prompt request:<feature>`. It is disabled by default. It changes the shared Linky
application, so the coding allowlist is separate from ordinary `/setup` access.

## Where the work runs

- The Discord bot continues running in the `linky` container on Hostinger, with its
  checkout at `/root/linky` and persistent data in `/app/data`.
- Source and PRs live in [LLRHook/linky](https://github.com/LLRHook/linky).
- Coding and independent review use fresh GitHub-hosted Linux runners. They do not
  receive the production Discord token, translation/YouTube keys, Hostinger SSH key,
  publishing token, or access to the running bot.
- A separate trusted job publishes an approved candidate through the GitHub API,
  waits for the exact PR commit's checks, and performs a protected squash merge.
  The existing CI → Deploy pipeline then updates Hostinger. A successful coding
  workflow means the deployment job for that merged commit also succeeded.

The CLI is pinned to **0.154.0**, model **`gpt-6-astra`**, effort **`ultra`**. Ultra
is a Codex orchestration setting; the official CLI resolves the model's inference
setting and enables proactive delegation. It is not a literal `reasoning.effort`
value to send directly to the Responses API. There is no automatic model fallback.
[Codex models](https://learn.chatgpt.com/docs/models),
[pinned effort resolution](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/protocol/src/openai_models/reasoning_effort.rs).

## Operator setup

1. Create a dedicated OpenAI Platform project with billing and Astra access. Store a
   restricted project API key in the repository secret `LINKY_OPENAI_API_KEY`.
   ChatGPT subscription usage does not pay for API requests. Configure project
   billing alerts and inspect actual usage after the first job. The application
   limits below are **not a dollar spending cap**.
2. Create a separate repository-scoped GitHub App installation credential or
   fine-grained token for publishing. It needs Contents and Pull requests write,
   and Actions/Checks read. Store it as `PROMPT_PUBLISH_TOKEN`. Do not grant
   administration, workflow editing, secret management, or branch-protection bypass.
   App tokens need a renewal mechanism; a manually stored short-lived installation
   token alone is not a durable setup. A fine-grained token needs an expiry/rotation plan.
3. Keep main protected with strict required checks `Build (Node 22)`,
   `Build (Node 24)`, and `Production container`, administrator enforcement, and
   conversation resolution. The publisher uses GitHub's normal merge endpoint;
   it never edits these rules. The default `GITHUB_TOKEN` cannot replace the
   publishing credential because its pushes do not start the ordinary CI workflows.
   See [GitHub's workflow-trigger rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
4. Create a distinct fine-grained credential for the bot, restricted to this
   repository with Actions read/write and Pull requests read. Put it in the
   Hostinger `.env` as `PROMPT_GITHUB_TOKEN`. It has no code-publishing permission.
5. Set the GitHub repository variable `PROMPT_WORKER_ENABLED=true` only when the
   worker credentials are ready. Verify an isolated test run with a small real
   request. Check the exact model, reviewer output, PR checks, merge, deployment,
   and OpenAI usage before enabling Discord intake.
6. Set `PROMPT_GUILD_IDS` to the specific trusted Discord server IDs and
   `PROMPT_ENABLED=true`; restart Linky. Test `/prompt` as an Administrator and
   verify rejection for an ordinary member and an unapproved server. Keep the
   journal in the existing persistent data volume.

Use the [Codex action's authentication and isolation guidance](https://learn.chatgpt.com/docs/github-action).
Keys stay in their respective secret stores, never in source, prompts, artifacts,
or public logs. Update the hosted privacy notice before enabling this data flow.

## Limits and failure handling

The bot admits one active job globally, at most three jobs per UTC day, and one
request per user per 30 minutes. The workflow also checks its daily run count.
Coding has a 30-minute timeout, independent review 20 minutes, and publishing plus
checks/deployment 45 minutes. Subagents share their parent job's deadline.

The candidate is limited to 30 files and 200,000 bytes of UTF-8 content. It may
change application TypeScript, add test files, and update feature documentation.
It cannot edit existing tests, dependencies, startup/wiring, command registration, configuration or its shared parser/response reader,
deployment files, workflows, or the coding controller. Requests needing these
changes require ordinary maintainer work. Path checks supplement the independent
review; passing tests alone does not establish that a feature is secure or correct.

If main changes during a job, the controller stops instead of rebasing and merging
an unreviewed result. If a PR's head changes, required checks fail, or review
requests changes, automatic merging stops. After a merge, a deployment failure
still makes the coding job fail; inspect the PR and Deploy logs before submitting
anything again. Existing Hostinger startup rollback remains in effect.

Use **Check status** to reconcile a delayed or lost dispatch response. Linky records
the latest job per server for recovery through `/prompt` with no request text. It records
the request before calling GitHub and never automatically resubmits it. If no run
appears and the job remains uncertain, the operator must inspect the Actions run
history before marking that specific journal record failed. Do not delete the
whole journal, which would reset admission limits. GitHub workflow reruns are
rejected to avoid charging for the same request twice.

Set `PROMPT_ENABLED=false` and restart to stop new Discord requests. Cancel any
active coding workflow separately. Set `PROMPT_WORKER_ENABLED=false` to stop new
worker executions. Ordinary link fixing continues.

## Data retained

Only the submitted feature description and its job ID are sent to GitHub and
OpenAI. Linky does not attach surrounding Discord messages or user/server IDs.
The public workflow contains the request, generated code, and review output;
do not submit private information. Temporary candidate/review artifacts expire
after seven days; PRs, commits, and run logs follow GitHub retention settings.

`data/prompt-jobs.json` stores job, user and server IDs, submission time, progress,
and GitHub links. It contains no feature text or credentials. Completed records
expire after 14 days on the next journal write; active or uncertain records stay
until reconciled. A malformed journal disables coding instead of resetting limits
or stopping ordinary link fixing.
