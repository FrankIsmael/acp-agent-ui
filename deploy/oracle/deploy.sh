#!/usr/bin/env bash
# Deploy the newest image CI published as ghcr.io/frankismael/acp-agent-ui:main.
# Runs as `opc`: from deploy-hook.py when CI calls POST /_deploy, daily from
# acp-deploy.timer as a fallback, or by hand (see docs/oracle-deployment.md).
# Its output is the deploy result CI shows, so it must never print secrets.
#
# DEPLOY_EXPECT (optional, set by the hook): the commit CI just published. The
# run fails if :main turns out to be another commit, so CI never reports a
# deploy that did not happen.
#
# The running image is pinned by digest in docker-compose.override.yml, which
# Compose loads on its own: a manual `docker compose up` keeps that image.
#
# Everything lives in main() so bash parses the whole file before `git merge`
# can rewrite it mid-run.
set -Eeuo pipefail
# Say where it stopped; otherwise a failing step exits with no output.
trap 'echo "failed at line $LINENO: $BASH_COMMAND"' ERR

readonly IMAGE=ghcr.io/frankismael/acp-agent-ui
readonly OVERRIDE=docker-compose.override.yml
# Digest that failed its health check; skipped until :main moves past it, so
# the webhook and the daily fallback do not deploy and roll it back again.
readonly FAILED=.deploy-failed

healthy() {
  for _ in $(seq 1 30); do
    if docker compose exec -T app wget -qO /dev/null http://127.0.0.1:3000/healthz 2>/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

pin() {
  printf 'services:\n  app:\n    image: %s\n' "$1" >"$OVERRIDE"
}

main() {
  cd "$(dirname "$0")/../.."
  local log=/tmp/acp-deploy.log
  # One deploy at a time; a second caller waits, then usually finds nothing to do.
  exec 9>/tmp/acp-deploy.lock
  if ! flock -w 900 9; then
    echo "another deploy has been running for 15 minutes"
    exit 1
  fi

  docker pull --quiet "$IMAGE:main" >/dev/null
  local new current rev
  new=$(docker image inspect --format '{{index .RepoDigests 0}}' "$IMAGE:main")
  rev=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$new")
  current=$(sed -n 's/^    image: //p' "$OVERRIDE" 2>/dev/null || true)
  if [ -n "${DEPLOY_EXPECT:-}" ] && [ "$rev" != "$DEPLOY_EXPECT" ]; then
    echo ":main is ${rev:0:7}, not ${DEPLOY_EXPECT:0:7}; a newer push will deploy instead"
    exit 1
  fi
  if [ "$new" = "$current" ]; then
    echo "already running ${rev:0:7}"
    exit 0
  fi
  if [ "$new" = "$(cat "$FAILED" 2>/dev/null || true)" ]; then
    echo "${rev:0:7} already failed its health check; push a fix (or rm $FAILED to retry it)"
    exit 1
  fi

  # Move the checkout to the image's commit, for docker-compose.yml, the
  # Caddyfile and these scripts. Local changes here make this fail: edit through git.
  git fetch --quiet origin main
  git merge --ff-only --quiet "$rev"
  echo "deploying $(git log -1 --format='%h %s')"

  pin "$new"
  if docker compose up -d --remove-orphans >"$log" 2>&1 && healthy; then
    rm -f "$FAILED"
    # Cleanup only; never fail a healthy deploy over it. Older images stay in GHCR.
    docker image prune -f >/dev/null 2>&1 || true
    echo "app is up"
    exit 0
  fi

  # No app logs here: request logs can carry secrets (e.g. /whatsapp?key=...).
  docker compose ps app
  echo "new image did not respond within 60s; check: docker compose logs app"
  echo "$new" >"$FAILED"

  if [ -z "$current" ]; then
    echo "no previous image to roll back to"
    exit 1
  fi
  echo "rolling back to $current"
  pin "$current"
  if docker compose up -d app >>"$log" 2>&1 && healthy; then
    echo "rolled back; the checkout stays at the failed commit until a new image ships"
  else
    echo "rollback did not come up either; check: docker compose logs app"
  fi
  exit 1
}

main "$@"
