#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "$0")/../ops" && pwd)
test_parent=$(cd "${TMPDIR:-/tmp}" && pwd -P)
test_dir=$(mktemp -d "$test_parent/wannabet-deploy-tests.XXXXXX")
cleanup() {
  local resolved
  resolved=$(cd "$test_dir" && pwd -P) || return
  [[ "$resolved" == "$test_dir" && "$resolved" == "$test_parent"/wannabet-deploy-tests.* ]] || return 1
  rm -rf -- "$resolved"
}
trap cleanup EXIT
mkdir -p "$test_dir/bin"

cat > "$test_dir/bin/git" <<'MOCK'
#!/usr/bin/env bash
printf 'git %s\n' "$*" >> "$MOCK_DIR/events"
case "$1" in
  symbolic-ref) printf '%s\n' "${MOCK_BRANCH:-main}" ;;
  status) [[ ${MOCK_CASE:-} != dirty ]] || printf ' M src/index.ts\n' ;;
  fetch) exit 0 ;;
  rev-parse) printf '%s\n' "$MOCK_SHA" ;;
  merge) printf '%s\n' "$3" > "$MOCK_DIR/merged" ;;
  *) exit 90 ;;
esac
MOCK

cat > "$test_dir/bin/docker" <<'MOCK'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >> "$MOCK_DIR/events"
case "$1" in
  inspect)
    [[ ${MOCK_CASE:-} != missing ]] || exit 1
    if [[ "$3" == '{{.Image}}' ]]; then
      printf 'sha256:previous\n'
    elif [[ ${MOCK_CASE:-} == restart && -f "$MOCK_DIR/started" && ! -f "$MOCK_DIR/rolled-back" ]]; then
      printf 'true 1 2026-09-10T00:00:00Z\n'
    else
      printf 'true 0 2026-09-10T00:00:00Z\n'
    fi ;;
  logs)
    if [[ ${MOCK_CASE:-} != startup || -f "$MOCK_DIR/rolled-back" ]]; then
      printf 'Logged in as WannaBet#0805\nServing 2 guild(s).\n'
    fi ;;
  tag) [[ "$3" != wanna-bet:latest ]] || touch "$MOCK_DIR/rolled-back" ;;
  exec)
    [[ -f "$MOCK_DIR/built" ]] || exit 94
    [[ ${MOCK_CASE:-} != backup ]] || exit 1
    touch "$MOCK_DIR/backed-up" ;;
  compose)
    if [[ " $* " == *' build '* ]]; then
      [[ ${MOCK_CASE:-} != build ]] || exit 1
      touch "$MOCK_DIR/built"
    elif [[ " $* " == *' up '* ]]; then
      [[ -f "$MOCK_DIR/backed-up" ]] || exit 91
      touch "$MOCK_DIR/started"
      [[ ${MOCK_CASE:-} != up || -f "$MOCK_DIR/rolled-back" ]] || exit 1
    else exit 92; fi ;;
  *) exit 93 ;;
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
  export MOCK_CASE=$name MOCK_DIR="$test_dir/$name" WANNA_BET_DEPLOY_DIR="$test_dir/$name/repo"
  mkdir -p "$WANNA_BET_DEPLOY_DIR/.git"
  printf 'services: {wannabet: {image: "wanna-bet:latest"}}\n' > "$WANNA_BET_DEPLOY_DIR/docker-compose.yml"
  printf '%s\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa > "$WANNA_BET_DEPLOY_DIR/.git/wanna-bet-deployed-revision"
  bash "$script_dir/deploy.sh" "$revision" > "$MOCK_DIR/output" 2>&1 || result=$?
  if [[ "$result" != "$expected" ]]; then
    cat "$MOCK_DIR/output" >&2
    printf 'FAIL: %s exited %s, expected %s\n' "$name" "$result" "$expected" >&2
    exit 1
  fi
  if [[ "$name" == success ]]; then
    [[ $(cat "$WANNA_BET_DEPLOY_DIR/.git/wanna-bet-deployed-revision") == "$MOCK_SHA" ]]
    [[ $(cat "$MOCK_DIR/merged") == "$MOCK_SHA" ]]
    [[ -f "$MOCK_DIR/built" && -f "$MOCK_DIR/backed-up" && -f "$MOCK_DIR/started" ]]
    [[ ! -e "$MOCK_DIR/rolled-back" ]]
    [[ $(head -n 1 "$MOCK_DIR/events") == 'flock -x 9' ]]
  else
    [[ $(cat "$WANNA_BET_DEPLOY_DIR/.git/wanna-bet-deployed-revision") == aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ]]
  fi
  case "$name" in
    invalid) [[ ! -e "$MOCK_DIR/events" ]] ;;
    stale|dirty|branch|missing) [[ ! -e "$MOCK_DIR/merged" && ! -e "$MOCK_DIR/started" ]] ;;
    build) [[ -e "$MOCK_DIR/merged" && ! -e "$MOCK_DIR/backed-up" && ! -e "$MOCK_DIR/started" ]] ;;
    backup) [[ -e "$MOCK_DIR/built" && ! -e "$MOCK_DIR/started" ]] ;;
    startup|restart|up)
      [[ -e "$MOCK_DIR/rolled-back" ]]
      grep -q -- '--force-recreate wannabet' "$MOCK_DIR/events"
      grep -q -- 'docker compose -f .*backups/compose-before-' "$MOCK_DIR/events"
      grep -q 'Previous bot restored' "$MOCK_DIR/output" ;;
  esac
  printf 'PASS: %s\n' "$name"
}

run_case invalid 2 'main;echo unsafe'
run_case stale 0 2222222222222222222222222222222222222222
run_case dirty 1
MOCK_BRANCH=feature/test run_case branch 1
run_case missing 1
run_case build 1
run_case backup 1
run_case startup 1
run_case restart 1
run_case up 1
run_case success 0
