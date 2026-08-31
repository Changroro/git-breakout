#!/usr/bin/env bash
set -euo pipefail

: "${TREND_RADAR_REPO:?TREND_RADAR_REPO is required}"
: "${TREND_RADAR_BACKUP_DIR:?TREND_RADAR_BACKUP_DIR is required}"

compose_file="$TREND_RADAR_REPO/deploy/oracle/docker-compose.yml"
env_file="$TREND_RADAR_REPO/deploy/oracle/.env"
verify_database=github_trend_radar_restore_verify
test -f "$compose_file" || { echo "Compose file is unavailable: $compose_file" >&2; exit 1; }
test -f "$env_file" || { echo "Environment file is unavailable: $env_file" >&2; exit 1; }

backup_file=$(find "$TREND_RADAR_BACKUP_DIR" -maxdepth 1 -type f \
  -name 'github-trend-radar-*.dump' -printf '%T@ %p\n' \
  | sort -nr | head -n 1 | cut -d' ' -f2-)
test -n "$backup_file" || { echo "No database backup is available" >&2; exit 1; }

database_exists=$(docker compose --env-file "$env_file" -f "$compose_file" exec -T db sh -lc \
  'psql --tuples-only --no-align --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --command "select 1 from pg_database where datname = '\''github_trend_radar_restore_verify'\''"')
test -z "$database_exists" || { echo "Restore verification database already exists" >&2; exit 1; }

cleanup() {
  docker compose --env-file "$env_file" -f "$compose_file" exec -T db sh -lc \
    'dropdb --force --if-exists --username "$POSTGRES_USER" github_trend_radar_restore_verify'
}
trap cleanup EXIT

docker compose --env-file "$env_file" -f "$compose_file" exec -T db sh -lc \
  'createdb --username "$POSTGRES_USER" github_trend_radar_restore_verify'
docker compose --env-file "$env_file" -f "$compose_file" exec -T db sh -lc \
  'pg_restore --exit-on-error --no-owner --no-privileges --username "$POSTGRES_USER" --dbname github_trend_radar_restore_verify' \
  < "$backup_file"
docker compose --env-file "$env_file" -f "$compose_file" exec -T db sh -lc \
  'psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname github_trend_radar_restore_verify --command "select count(*) from radar.snapshots"' \
  > /dev/null
printf '%s\n' "$backup_file"
