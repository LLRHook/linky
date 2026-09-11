#!/usr/bin/env bash
set -euo pipefail

compose() {
  docker compose -f "$repo_dir/docker-compose.yml" --project-directory "$repo_dir" -p linky "$@"
}

bot_ready() {
  local state running restarts created logs
  state=$(docker inspect --format '{{.State.Running}} {{.RestartCount}} {{.Created}}' linky 2>/dev/null) || return 1
  read -r running restarts created <<< "$state"
  [[ "$running" == true && "$restarts" == 0 ]] || return 1
  logs=$(docker logs --since "$created" linky 2>&1) || return 1
  [[ "$logs" == *'Logged in as '* && "$logs" == *'Serving '* ]]
}

wait_for_bot() {
  local attempt
  for ((attempt = 0; attempt < 30; attempt++)); do
    if bot_ready; then return 0; fi
    sleep 2
  done
  return 1
}

rollback() {
  local previous_image=$1 previous_compose=$2
  printf 'Startup failed; restoring the previous image and configuration.\n' >&2
  if docker tag "$previous_image" linky:latest &&
    docker compose -f "$previous_compose" --project-directory "$repo_dir" -p linky \
      up -d --no-build --force-recreate linky && wait_for_bot; then
    printf 'Previous bot restored.\n' >&2
  else
    printf 'Rollback failed; inspect the linky container immediately.\n' >&2
  fi
  return 1
}

main() {
  if [[ $# != 1 || ! "$1" =~ ^[0-9a-f]{40}$ ]]; then
    printf 'Usage: deploy.sh <40-character commit SHA>\n' >&2
    return 2
  fi
  local revision=$1 current_revision deployed_revision working_tree previous_image previous_compose
  repo_dir=${LINKY_DEPLOY_DIR:-/root/linky}
  cd "$repo_dir"
  exec 9> .git/linky-deploy.lock
  flock -x 9

  [[ $(git symbolic-ref --quiet --short HEAD) == main ]] || {
    printf 'Deployment requires the main branch.\n' >&2; return 1;
  }
  working_tree=$(git status --porcelain)
  [[ -z "$working_tree" ]] || {
    printf 'Deployment requires a clean working tree.\n' >&2; return 1;
  }
  GIT_TERMINAL_PROMPT=0 git fetch origin main
  current_revision=$(git rev-parse refs/remotes/origin/main)
  if [[ "$revision" != "$current_revision" ]]; then
    printf 'Skipping superseded commit %s; main is %s.\n' "$revision" "$current_revision"
    return 0
  fi

  previous_image=$(docker inspect --format '{{.Image}}' linky) || {
    printf 'An existing linky container is required.\n' >&2; return 1;
  }
  deployed_revision=$(cat .git/linky-deployed-revision 2>/dev/null) || {
    printf 'The last successful deployment revision is required for rollback.\n' >&2; return 1;
  }
  [[ "$deployed_revision" =~ ^[0-9a-f]{40}$ ]] || {
    printf 'The recorded deployment revision is invalid.\n' >&2; return 1;
  }
  umask 077
  mkdir -p "$repo_dir/.git/linky-deploy"
  previous_compose="$repo_dir/.git/linky-deploy/previous-compose.yml"
  # A failed attempt leaves this checkout ahead of the running container. Always
  # restore the configuration from its successful deployment, including on retries.
  git show "$deployed_revision:docker-compose.yml" > "$previous_compose" || {
    printf 'Could not recover the deployed Compose configuration.\n' >&2; return 1;
  }
  docker tag "$previous_image" linky:rollback
  git merge --ff-only "$revision"

  if ! compose build linky; then
    printf 'Build failed; the existing bot is still running.\n' >&2
    return 1
  fi
  if ! compose up -d --no-build linky || ! wait_for_bot; then
    rollback "$previous_image" "$previous_compose"
    return 1
  fi
  printf '%s\n' "$revision" > "$repo_dir/.git/linky-deployed-revision"
  printf 'Deployed %s; Discord connection verified.\n' "$revision"
}

# Parse every function before main updates this checkout.
main "$@"
