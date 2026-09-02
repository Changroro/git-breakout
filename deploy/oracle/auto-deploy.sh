#!/usr/bin/env bash
set -euo pipefail

: "${TREND_RADAR_REPO:?TREND_RADAR_REPO is required}"
: "${TREND_RADAR_STATE_DIR:?TREND_RADAR_STATE_DIR is required}"

compose_file="$TREND_RADAR_REPO/deploy/oracle/docker-compose.yml"
env_file="$TREND_RADAR_REPO/deploy/oracle/.env"
migration_file="$TREND_RADAR_REPO/deploy/oracle/db/migrations/009_github_trending_page.sql"
deployed_file="$TREND_RADAR_STATE_DIR/deployed-revision"

exec 9>/run/lock/github-trend-radar-deploy.lock
flock -n 9 || exit 0

test -d "$TREND_RADAR_REPO/.git" || { echo "Git repository is unavailable: $TREND_RADAR_REPO" >&2; exit 1; }
test -f "$compose_file" || { echo "Compose file is unavailable: $compose_file" >&2; exit 1; }
test -f "$env_file" || { echo "Environment file is unavailable: $env_file" >&2; exit 1; }

git -C "$TREND_RADAR_REPO" fetch --prune origin refs/heads/main:refs/remotes/origin/main
git -C "$TREND_RADAR_REPO" merge --ff-only refs/remotes/origin/main
target_revision=$(git -C "$TREND_RADAR_REPO" rev-parse HEAD)
test -f "$migration_file" || { echo "Database migration is unavailable: $migration_file" >&2; exit 1; }

if test -f "$deployed_file" && test "$(<"$deployed_file")" = "$target_revision"; then
  exit 0
fi

docker compose --env-file "$env_file" -f "$compose_file" build web
docker compose --env-file "$env_file" -f "$compose_file" exec -T db sh -lc \
  'psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"' \
  < "$migration_file"
docker compose --env-file "$env_file" -f "$compose_file" up -d
web_container=$(docker compose --env-file "$env_file" -f "$compose_file" ps -q web)
test -n "$web_container" || { echo "Web container was not created" >&2; exit 1; }

for attempt in $(seq 1 30); do
  health=$(docker inspect "$web_container" --format '{{.State.Health.Status}}')
  if test "$health" = healthy; then
    mkdir -p "$TREND_RADAR_STATE_DIR"
    temporary_file=$(mktemp "$TREND_RADAR_STATE_DIR/deployed-revision.XXXXXX")
    printf '%s\n' "$target_revision" > "$temporary_file"
    mv "$temporary_file" "$deployed_file"
    exit 0
  fi
  if test "$health" = unhealthy; then
    docker logs --tail 100 "$web_container" >&2
    exit 1
  fi
  sleep 2
done

echo "Web health check timed out for revision $target_revision" >&2
exit 1
