#!/usr/bin/env bash
# Pull the latest main and rebuild the app container. Run as `opc` on the VM,
# either by hand or through OCI Run Command (see docs/oracle-deployment.md).
#
# Everything lives in main() so bash parses the whole file before `git pull`
# can rewrite it mid-run.
set -Eeuo pipefail
# Say where it stopped; otherwise a failing step exits with no output.
trap 'echo "failed at line $LINENO: $BASH_COMMAND"' ERR

healthy() {
  for _ in $(seq 1 30); do
    if docker compose exec -T app wget -qO /dev/null http://127.0.0.1:3000/healthz 2>/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

main() {
  cd "$(dirname "$0")/../.."
  local log=/tmp/acp-deploy.log
  # Must match `image:` of the app service in docker-compose.yml.
  local image=acp-agent-ui-app

  git fetch --quiet origin main
  git merge --ff-only --quiet origin/main
  echo "deploying $(git log -1 --format='%h %s')"

  # Keep the running image so a failed deploy can go back to it. The tag also
  # keeps `image prune` from deleting it.
  if docker image inspect "$image:latest" >/dev/null 2>&1; then
    docker tag "$image:latest" "$image:previous"
  fi

  # Build output is long; Run Command only returns a small text tail.
  if ! docker compose build app >"$log" 2>&1; then
    tail -n 40 "$log"
    echo "build failed; the running app was not touched"
    exit 1
  fi
  if docker compose up -d --remove-orphans >>"$log" 2>&1 && healthy; then
    # Cleanup only; never fail a healthy deploy over it.
    docker image prune -f >/dev/null 2>&1 || true
    echo "app is up"
    exit 0
  fi

  # No app logs here: this output lands in the public Actions log, and request
  # logs can carry secrets (e.g. /whatsapp?key=...). Read them on the VM.
  docker compose ps app
  echo "new image did not respond within 60s; check: docker compose logs app"

  if ! docker image inspect "$image:previous" >/dev/null 2>&1; then
    echo "no previous image to roll back to"
    exit 1
  fi
  echo "rolling back to the previous image"
  docker tag "$image:previous" "$image:latest"
  if docker compose up -d --no-build app >>"$log" 2>&1 && healthy; then
    echo "rolled back; the app runs the previous image while the checkout is at the failed commit"
  else
    echo "rollback did not come up either; check: docker compose logs app"
  fi
  exit 1
}

main "$@"
