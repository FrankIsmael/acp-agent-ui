#!/usr/bin/env bash
# Pull the latest main and rebuild the app container. Run as `opc` on the VM,
# either by hand or through OCI Run Command (see docs/oracle-deployment.md).
#
# Everything lives in main() so bash parses the whole file before `git pull`
# can rewrite it mid-run.
set -euo pipefail

main() {
  cd "$(dirname "$0")/../.."
  local log=/tmp/acp-deploy.log

  git fetch --quiet origin main
  git merge --ff-only --quiet origin/main
  echo "deploying $(git log -1 --format='%h %s')"

  # Build output is long; Run Command only returns a small text tail.
  if ! docker compose build app >"$log" 2>&1; then
    tail -n 40 "$log"
    echo "build failed"
    exit 1
  fi
  docker compose up -d --remove-orphans >>"$log" 2>&1

  for _ in $(seq 1 30); do
    if docker compose exec -T app wget -qO /dev/null http://127.0.0.1:3000/ 2>/dev/null; then
      docker image prune -f >/dev/null
      echo "app is up"
      exit 0
    fi
    sleep 2
  done

  docker compose logs --tail 40 app
  echo "app did not respond within 60s"
  exit 1
}

main "$@"
