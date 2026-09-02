#!/bin/sh
set -eu

psql \
  --set=ON_ERROR_STOP=1 \
  --set=authenticator_password="$POSTGREST_DB_PASSWORD" \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --file /opt/trend-radar/schema.sql

psql \
  --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --file /opt/trend-radar/migrations/006_operational_hardening.sql

psql \
  --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --file /opt/trend-radar/migrations/007_discovery_track_record.sql

psql \
  --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --file /opt/trend-radar/migrations/008_archive_page.sql

psql \
  --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --file /opt/trend-radar/migrations/009_github_trending_page.sql
