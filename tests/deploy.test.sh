#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "$0")/../ops" && pwd)
test_parent=$(cd "${TMPDIR:-/tmp}" && pwd -P)
test_dir=$(mktemp -d "$test_parent/linky-deploy-tests.XXXXXX")
cleanup() {
  local resolved
  resolved=$(cd "$test_dir" && pwd -P) || return
  [[ "$resolved" == "$test_dir" && "$resolved" == "$test_parent"/linky-deploy-tests.* ]] || return 1
  rm -rf -- "$resolved"
}
trap cleanup EXIT
mkdir -p "$test_dir/bin"

cat > "$test_dir/bin/git" <<'MOCK'
#!/usr/bin/env bash
printf 'git %s\n' "$*" >> "$MOCK_DIR/events"
case "$1" in
  symbolic-ref) printf '%s\n' "${MOCK_BRANCH:-main}" ;;
  status) [[ "$MOCK_CASE" != dirty ]] || printf ' M src/index.ts\n' ;;
  fetch) [[ "$MOCK_CASE" != fetch ]] ;;
  rev-parse) printf '%s\n' "$MOCK_SHA" ;;
  show)
    [[ "$2" == 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:docker-compose.yml' && "$MOCK_CASE" != compose-missing ]] || exit 1
    cat "$MOCK_DIR/active-compose.yml" ;;
  merge)
    [[ "$MOCK_CASE" != merge ]] || exit 1
    printf '%s\n' "$3" > "$MOCK_DIR/merged"
    cp "$MOCK_DIR/next-compose.yml" "$LINKY_DEPLOY_DIR/docker-compose.yml" ;;
  *) exit 90 ;;
esac
MOCK

cat > "$test_dir/bin/docker" <<'MOCK'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >> "$MOCK_DIR/events"
case "$1" in
  inspect)
    [[ "$MOCK_CASE" != missing ]] || exit 1
    if [[ "$3" == '{{.Image}}' ]]; then
      printf 'sha256:previous\n'
    elif [[ "$MOCK_CASE" == restart && ! -f "$MOCK_DIR/rolled-back" ]]; then
      printf 'true 1 2026-09-11T00:00:00Z\n'
    elif [[ "$MOCK_CASE" == stopped && ! -f "$MOCK_DIR/rolled-back" ]]; then
      printf 'false 0 2026-09-11T00:00:00Z\n'
    else
      printf 'true 0 2026-09-11T00:00:00Z\n'
    fi ;;
  logs)
    if [[ "$MOCK_CASE" != *startup || -f "$MOCK_DIR/rolled-back" ]]; then
      printf 'Logged in as Linky#0805\nServing 2 guild(s).\n'
    fi ;;
  tag) [[ "$3" != linky:latest ]] || touch "$MOCK_DIR/rolled-back" ;;
  compose)
    [[ " $* " == *' -p linky '* ]] || exit 91
    if [[ " $* " == *' build '* ]]; then
      [[ "$MOCK_CASE" != build ]] || exit 1
      touch "$MOCK_DIR/built"
    elif [[ " $* " == *' up '* ]]; then
      [[ -f "$MOCK_DIR/built" ]] || exit 92
      if [[ -f "$MOCK_DIR/rolled-back" ]]; then
        cmp -s "$3" "$MOCK_DIR/active-compose.yml" || exit 93
      fi
      touch "$MOCK_DIR/started"
      [[ "$MOCK_CASE" != rollback-failure ]] || exit 1
      [[ "$MOCK_CASE" != up || -f "$MOCK_DIR/rolled-back" ]] || exit 1
    else exit 94; fi ;;
  *) exit 95 ;;
esac
MOCK

cat > "$test_dir/bin/flock" <<'MOCK'
#!/usr/bin/env bash
printf 'flock %s\n' "$*" >> "$MOCK_DIR/events"
MOCK
cat > "$test_dir/bin/sleep" <<'MOCK'
#!/usr/bin/env bash
exit 0
MOCK
chmod +x "$test_dir/bin/"*
export PATH="$test_dir/bin:$PATH"
export MOCK_SHA=1111111111111111111111111111111111111111

run_case() {
  local name=$1 expected=$2 revision=${3:-$MOCK_SHA} result=0
  export MOCK_CASE=$name MOCK_DIR="$test_dir/$name" LINKY_DEPLOY_DIR="$test_dir/$name/repo"
  mkdir -p "$LINKY_DEPLOY_DIR/.git"
  printf 'services: {linky: {image: "linky:latest", environment: {LOG_LEVEL: info}}}\n' > "$MOCK_DIR/active-compose.yml"
  printf 'services: {linky: {image: "linky:latest", environment: {LOG_LEVEL: debug}}}\n' > "$MOCK_DIR/next-compose.yml"
  cp "$MOCK_DIR/active-compose.yml" "$LINKY_DEPLOY_DIR/docker-compose.yml"
  local marker="$LINKY_DEPLOY_DIR/.git/linky-deployed-revision" previous_revision=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  [[ "$name" != marker-invalid ]] || previous_revision=invalid
  printf '%s\n' "$previous_revision" > "$marker"
  [[ "$name" != marker-missing ]] || rm "$marker"
  bash "$script_dir/deploy.sh" "$revision" > "$MOCK_DIR/output" 2>&1 || result=$?
  if [[ "$result" != "$expected" ]]; then
    cat "$MOCK_DIR/output" >&2
    printf 'FAIL: %s exited %s, expected %s\n' "$name" "$result" "$expected" >&2
    exit 1
  fi
  if [[ "$name" == success ]]; then
    [[ $(cat "$marker") == "$MOCK_SHA" && $(cat "$MOCK_DIR/merged") == "$MOCK_SHA" ]]
    [[ -f "$MOCK_DIR/built" && -f "$MOCK_DIR/started" && ! -e "$MOCK_DIR/rolled-back" ]]
    [[ $(head -n 1 "$MOCK_DIR/events") == 'flock -x 9' ]]
  elif [[ "$name" != marker-missing ]]; then
    [[ $(cat "$marker") == "$previous_revision" ]]
  fi
  case "$name" in
    invalid) [[ ! -e "$MOCK_DIR/events" ]] ;;
    stale|dirty|branch|fetch|missing|marker-missing|marker-invalid|compose-missing|merge)
      [[ ! -e "$MOCK_DIR/merged" && ! -e "$MOCK_DIR/started" ]] ;;
    build) [[ -e "$MOCK_DIR/merged" && ! -e "$MOCK_DIR/started" ]] ;;
    startup|restart|stopped|up|retry-startup|rollback-failure)
      [[ -e "$MOCK_DIR/rolled-back" ]]
      grep -q -- '--force-recreate linky' "$MOCK_DIR/events"
      grep -q -- 'docker compose -f .*/.git/linky-deploy/previous-compose.yml' "$MOCK_DIR/events"
      if [[ "$name" == rollback-failure ]]; then
        grep -q 'Rollback failed' "$MOCK_DIR/output"
        ! grep -q 'Previous bot restored' "$MOCK_DIR/output"
      else
        grep -q 'Previous bot restored' "$MOCK_DIR/output"
      fi ;;
  esac
  printf 'PASS: %s\n' "$name"
}

run_case invalid 2 'main;echo unsafe'
run_case stale 0 2222222222222222222222222222222222222222
run_case dirty 1
MOCK_BRANCH=feature/test run_case branch 1
run_case fetch 1
run_case missing 1
run_case marker-missing 1
run_case marker-invalid 1
run_case compose-missing 1
run_case merge 1
run_case build 1
run_case startup 1
run_case restart 1
run_case stopped 1
run_case up 1
run_case rollback-failure 1
run_case success 0

# A failed attempt advances the checkout. A retry must still restore the running
# deployment's configuration, rather than the newer configuration in the checkout.
run_case retry-startup 1
cmp -s "$LINKY_DEPLOY_DIR/docker-compose.yml" "$MOCK_DIR/next-compose.yml"
rm "$MOCK_DIR/rolled-back"
retry_result=0
bash "$script_dir/deploy.sh" "$MOCK_SHA" > "$MOCK_DIR/retry-output" 2>&1 || retry_result=$?
[[ "$retry_result" == 1 && -f "$MOCK_DIR/rolled-back" ]]
grep -q 'Previous bot restored' "$MOCK_DIR/retry-output"
[[ $(cat "$LINKY_DEPLOY_DIR/.git/linky-deployed-revision") == aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ]]
printf 'PASS: retry restores the deployed configuration\n'

for command in '' 'deploy main' "deploy $MOCK_SHA; echo unsafe" "echo deploy $MOCK_SHA"; do
  result=0
  SSH_ORIGINAL_COMMAND="$command" bash "$script_dir/ssh-deploy.sh" > "$test_dir/ssh-output" 2>&1 || result=$?
  [[ "$result" == 2 ]]
done
printf 'PASS: SSH wrapper rejects invalid commands\n'
