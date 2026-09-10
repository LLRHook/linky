#!/bin/bash
set -euo pipefail

if [[ ! ${SSH_ORIGINAL_COMMAND:-} =~ ^deploy\ ([0-9a-f]{40})$ ]]; then
  printf 'This key accepts only deploy <40-character commit SHA>.\n' >&2
  exit 2
fi
revision=${BASH_REMATCH[1]}
deploy_script=/root/wanna-bet/ops/deploy.sh
if [[ ! -f "$deploy_script" ]]; then
  deploy_script=/usr/local/libexec/wanna-bet-deploy-bootstrap
fi

exec /usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  HOME=/root GIT_TERMINAL_PROMPT=0 \
  /usr/bin/timeout --signal=TERM --kill-after=30s 18m /bin/bash "$deploy_script" "$revision"
