#!/usr/bin/env bash
# End-to-end OSM road aggregates refresh.
#
# Fetches the latest Geofabrik Mexico PBF, then runs the loader. Run it
# manually; nothing schedules it (ops/osm-refresh.timer is in the repo but
# is NOT installed on the host, audit #151):
#   ./scripts/refresh-osm.sh
#
# Set OSM_KEEP_PBF=1 to keep the downloaded PBF after the load (useful
# when iterating). Default behavior is to leave the PBF in place — the
# fetch script checksums against upstream MD5 on the next run and skips
# re-download when unchanged.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "[refresh-osm] $(date -u +%Y-%m-%dT%H:%M:%SZ) starting"

./scripts/fetch-osm-mexico.sh

CONTAINER="${SUPABASE_DB_CONTAINER:-supabase-db}"
echo "[refresh-osm] loading aggregates → $CONTAINER"
npx --no-install tsx scripts/load-osm-ageb.ts \
  --pbf=./raw/osm/mexico-latest.osm.pbf \
  --workdir=./raw/osm

echo "[refresh-osm] $(date -u +%Y-%m-%dT%H:%M:%SZ) done"
