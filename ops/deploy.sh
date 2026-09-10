#!/usr/bin/env bash
set -euo pipefail

compose() {
  docker compose -f "$repo_dir/docker-compose.yml" --project-directory "$repo_dir" -p wanna-bet "$@"
}

bot_ready() {
  local state running restarts created logs
  state=$(docker inspect --format '{{.State.Running}} {{.RestartCount}} {{.Created}}' wannabet 2>/dev/null) || return 1
  read -r running restarts created <<< "$state"
  [[ "$running" == true && "$restarts" == 0 ]] || return 1
  logs=$(docker logs --since "$created" wannabet 2>&1) || return 1
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
  local previous_image=$1 previous_compose=$2 db_backup=$3
  printf 'Startup failed; restoring previous image. Database backup: %s\n' "$db_backup" >&2
  if docker tag "$previous_image" wanna-bet:latest &&
    docker compose -f "$previous_compose" --project-directory "$repo_dir" -p wanna-bet \
      up -d --no-build --force-recreate wannabet && wait_for_bot; then
    printf 'Previous bot restored. Database contents were retained.\n' >&2
  else
    printf 'Rollback failed; inspect the wannabet container immediately.\n' >&2
  fi
  return 1
}

main() {
  if [[ $# != 1 || ! "$1" =~ ^[0-9a-f]{40}$ ]]; then
    printf 'Usage: deploy.sh <40-character commit SHA>\n' >&2
    return 2
  fi
  local revision=$1 current_revision deployed_revision working_tree previous_image stamp previous_compose db_backup
  repo_dir=${WANNA_BET_DEPLOY_DIR:-/root/wanna-bet}
  cd "$repo_dir"
  exec 9> .git/wanna-bet-deploy.lock
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

  previous_image=$(docker inspect --format '{{.Image}}' wannabet) || {
    printf 'An existing wannabet container is required.\n' >&2; return 1;
  }
  deployed_revision=$(cat .git/wanna-bet-deployed-revision 2>/dev/null) || {
    printf 'The last successful deployment revision is required for rollback.\n' >&2; return 1;
  }
  [[ "$deployed_revision" =~ ^[0-9a-f]{40}$ ]] || {
    printf 'The recorded deployment revision is invalid.\n' >&2; return 1;
  }
  umask 077
  mkdir -p "$repo_dir/backups"
  stamp=$(date -u +%Y%m%dT%H%M%SZ)-$$
  previous_compose="$repo_dir/backups/compose-before-$revision-$stamp.yml"
  db_backup="$repo_dir/backups/pre-$revision-$stamp.db"
  # A failed attempt leaves this checkout ahead of the running container. Always
  # restore the configuration from its successful deployment, including on retries.
  git show "$deployed_revision:docker-compose.yml" > "$previous_compose" || {
    printf 'Could not recover the deployed Compose configuration.\n' >&2; return 1;
  }
  docker tag "$previous_image" wanna-bet:rollback
  git merge --ff-only "$revision"

  if ! compose build wannabet; then
    printf 'Build failed; the existing bot is still running.\n' >&2
    return 1
  fi
  # The retired economy runtime writes SQLite; back it up before its final replacement.
  # The link-only runtime keeps that volume read-only and needs no database tooling.
  case "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.RW}}{{end}}{{end}}' wannabet)" in
    true)
      if ! docker exec -u 0 wannabet sqlite3 /app/data/wanna-bet.db \
        ".backup '/app/backups/$(basename "$db_backup")'"; then
        printf 'Database backup failed; the existing bot is still running.\n' >&2
        return 1
      fi ;;
    false) db_backup='not needed; legacy data remains mounted read-only' ;;
    *) printf 'Could not verify the legacy data mount; deployment stopped.\n' >&2; return 1 ;;
  esac
  if ! compose up -d --no-build wannabet || ! wait_for_bot; then
    rollback "$previous_image" "$previous_compose" "$db_backup"
    return 1
  fi
  printf '%s\n' "$revision" > "$repo_dir/.git/wanna-bet-deployed-revision"
  printf 'Deployed %s; Discord connection verified. Database backup: %s\n' "$revision" "$db_backup"
}

# Parse every function before main updates this checkout.
main "$@"
