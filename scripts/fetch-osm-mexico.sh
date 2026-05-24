#!/usr/bin/env bash
# Download the Geofabrik Mexico OSM extract + verify checksum.
#
# Output: raw/osm/mexico-latest.osm.pbf
#
# Idempotent: rerun freely. If the file already exists AND its checksum
# matches the upstream .md5, the download is skipped. Pass --force to
# always re-download.
#
# Geofabrik publishes daily snapshots; this script always pulls "latest".
# The companion .md5 file is published alongside and updated atomically.
#
# Usage:
#   ./scripts/fetch-osm-mexico.sh           # download if missing/stale
#   ./scripts/fetch-osm-mexico.sh --force   # always re-download
#
# Logs to stdout. Exit codes: 0 ok, 1 download/verify failed.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$REPO_ROOT/raw/osm"
PBF="$OUT_DIR/mexico-latest.osm.pbf"
MD5="$OUT_DIR/mexico-latest.osm.pbf.md5"
URL_BASE="https://download.geofabrik.de/north-america"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    *) echo "[fetch-osm] unknown arg: $arg" >&2; exit 1 ;;
  esac
done

mkdir -p "$OUT_DIR"

# Always pull the latest .md5 — cheap, lets us decide whether to skip the PBF.
echo "[fetch-osm] fetching upstream MD5..."
curl -fsSL -o "$MD5.tmp" "$URL_BASE/mexico-latest.osm.pbf.md5"
mv "$MD5.tmp" "$MD5"

if [[ "$FORCE" -eq 0 && -f "$PBF" ]]; then
  if (cd "$OUT_DIR" && md5sum -c mexico-latest.osm.pbf.md5 >/dev/null 2>&1); then
    echo "[fetch-osm] ✓ existing PBF matches upstream MD5, skipping download"
    ls -lh "$PBF"
    exit 0
  fi
  echo "[fetch-osm] local PBF stale, re-downloading"
fi

echo "[fetch-osm] downloading mexico-latest.osm.pbf (~750 MB)..."
curl -fSL --progress-bar -o "$PBF.tmp" "$URL_BASE/mexico-latest.osm.pbf"
mv "$PBF.tmp" "$PBF"

echo "[fetch-osm] verifying MD5..."
(cd "$OUT_DIR" && md5sum -c mexico-latest.osm.pbf.md5)

echo "[fetch-osm] ✓ done"
ls -lh "$PBF"
