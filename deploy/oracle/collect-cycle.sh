#!/usr/bin/env bash
set -euo pipefail

: "${TREND_RADAR_REPO:?TREND_RADAR_REPO is required}"
: "${TREND_RADAR_COLLECTOR_TOKEN:?TREND_RADAR_COLLECTOR_TOKEN is required}"

compose_file="$TREND_RADAR_REPO/deploy/oracle/docker-compose.yml"
env_file="$TREND_RADAR_REPO/deploy/oracle/.env"

exec 9>/run/lock/github-trend-radar-collector.lock
if ! flock -n 9; then
  echo "A GitBreakout collection is already running"
  exit 0
fi

test -d "$TREND_RADAR_REPO/.git" || { echo "Git repository is unavailable: $TREND_RADAR_REPO" >&2; exit 1; }
test -f "$compose_file" || { echo "Compose file is unavailable: $compose_file" >&2; exit 1; }
test -f "$env_file" || { echo "Environment file is unavailable: $env_file" >&2; exit 1; }

credentials=$(printf 'protocol=https\nhost=github.com\n\n' | git -C "$TREND_RADAR_REPO" credential fill)
github_token=$(printf '%s\n' "$credentials" | sed -n 's/^password=//p')
test -n "$github_token" || { echo "GitHub credential is unavailable" >&2; exit 1; }
export GITHUB_TOKEN="$github_token"
trap 'unset credentials github_token GITHUB_TOKEN' EXIT

schedule=$(docker compose --env-file "$env_file" -f "$compose_file" exec -T \
  -e TREND_RADAR_API_URL=http://rest:3000 \
  -e TREND_RADAR_COLLECTOR_TOKEN \
  web node server-dist/server/read-collection-schedule.js)
next_due_at=$(printf '%s' "$schedule" | python3 -c '
import json
import sys

value = json.load(sys.stdin)
next_due_at = value.get("next_due_at") if isinstance(value, dict) else None
if not isinstance(next_due_at, str) or not next_due_at:
    raise ValueError("Collection schedule.next_due_at is required")
print(next_due_at)
')
next_due_epoch=$(date -u -d "$next_due_at" +%s)
current_epoch=$(date -u +%s)
if (( current_epoch < next_due_epoch )); then
  echo "Collection is due at $next_due_at"
  exit 0
fi

event_failures=0
for offset in 3 2; do
  bucket_at=$(date -u -d "$offset hours ago" +'%Y-%m-%dT%H:00:00.000Z')
  if ! docker compose --env-file "$env_file" -f "$compose_file" run --rm --no-deps \
      -e TREND_RADAR_API_URL=http://rest:3000 \
      -e TREND_RADAR_COLLECTOR_TOKEN \
      web node server-dist/server/collect-events-remote.js --hour="$bucket_at" --limit=5000; then
    echo "GH Archive collection failed for $bucket_at" >&2
    event_failures=$((event_failures + 1))
  fi
done

docker compose --env-file "$env_file" -f "$compose_file" run --rm --no-deps \
  -e GITHUB_TOKEN \
  -e TREND_RADAR_API_URL=http://rest:3000 \
  -e TREND_RADAR_COLLECTOR_TOKEN \
  web node server-dist/server/collect-remote.js

if (( event_failures > 0 )); then
  echo "$event_failures GH Archive collections failed" >&2
  exit 1
fi
