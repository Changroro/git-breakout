#!/usr/bin/env bash
set -euo pipefail

: "${TREND_RADAR_REPO:?TREND_RADAR_REPO is required}"
: "${TREND_RADAR_BACKUP_DIR:?TREND_RADAR_BACKUP_DIR is required}"
: "${TREND_RADAR_BACKUP_RETENTION_DAYS:?TREND_RADAR_BACKUP_RETENTION_DAYS is required}"

if [[ "$TREND_RADAR_BACKUP_DIR" != /* ]]; then
  echo "TREND_RADAR_BACKUP_DIR must be an absolute path" >&2
  exit 1
fi
if [[ ! "$TREND_RADAR_BACKUP_RETENTION_DAYS" =~ ^[1-9][0-9]*$ ]]; then
  echo "TREND_RADAR_BACKUP_RETENTION_DAYS must be a positive integer" >&2
  exit 1
fi

compose_file="$TREND_RADAR_REPO/deploy/oracle/docker-compose.yml"
env_file="$TREND_RADAR_REPO/deploy/oracle/.env"
test -f "$compose_file" || { echo "Compose file is unavailable: $compose_file" >&2; exit 1; }
test -f "$env_file" || { echo "Environment file is unavailable: $env_file" >&2; exit 1; }

mkdir -p "$TREND_RADAR_BACKUP_DIR"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_file="$TREND_RADAR_BACKUP_DIR/github-trend-radar-$timestamp.dump"
temporary_file="$backup_file.tmp"
trap 'rm -f "$temporary_file"' EXIT

docker compose --env-file "$env_file" -f "$compose_file" exec -T db sh -lc \
  'pg_dump --format=custom --no-owner --no-privileges --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"' \
  > "$temporary_file"
test -s "$temporary_file" || { echo "Database backup is empty" >&2; exit 1; }
docker compose --env-file "$env_file" -f "$compose_file" exec -T db pg_restore --list \
  < "$temporary_file" > /dev/null
mv "$temporary_file" "$backup_file"
trap - EXIT

find "$TREND_RADAR_BACKUP_DIR" -maxdepth 1 -type f \
  -name 'github-trend-radar-*.dump' \
  -mtime "+$TREND_RADAR_BACKUP_RETENTION_DAYS" \
  -delete
printf '%s\n' "$backup_file"
