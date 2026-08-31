#!/usr/bin/env bash
set -euo pipefail

: "${TREND_RADAR_PUBLIC_URL:?TREND_RADAR_PUBLIC_URL is required}"
: "${TREND_RADAR_MIN_FREE_PERCENT:?TREND_RADAR_MIN_FREE_PERCENT is required}"

if [[ ! "$TREND_RADAR_MIN_FREE_PERCENT" =~ ^[1-9][0-9]*$ ]] \
  || (( TREND_RADAR_MIN_FREE_PERCENT > 99 )); then
  echo "TREND_RADAR_MIN_FREE_PERCENT must be between 1 and 99" >&2
  exit 1
fi

curl --fail --silent --show-error --max-time 15 \
  --header 'Accept: application/json' \
  "$TREND_RADAR_PUBLIC_URL/health" \
  | grep --fixed-strings '"status":"ok"' > /dev/null

used_percent=$(df --portability / | awk 'NR == 2 { gsub(/%/, "", $5); print $5 }')
if [[ ! "$used_percent" =~ ^[0-9]+$ ]]; then
  echo "Root filesystem usage could not be determined" >&2
  exit 1
fi
free_percent=$((100 - used_percent))
if (( free_percent < TREND_RADAR_MIN_FREE_PERCENT )); then
  echo "Root filesystem has ${free_percent}% free space" >&2
  exit 1
fi
