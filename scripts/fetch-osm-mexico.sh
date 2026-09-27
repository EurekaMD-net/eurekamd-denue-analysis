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

fetch_md5() {
  echo "[fetch-osm] fetching upstream MD5..."
  curl -fsSL -o "$MD5.tmp" "$URL_BASE/mexico-latest.osm.pbf.md5"
  mv "$MD5.tmp" "$MD5"
}

# True when the downloaded $PBF.tmp matches the hash in the .md5 (whose line
# names mexico-latest.osm.pbf, so compare the hashes, not md5sum -c).
tmp_matches_md5() {
  local want got
  want="$(awk '{print $1; exit}' "$MD5")"
  got="$(md5sum "$PBF.tmp" | awk '{print $1}')"
  [[ -n "$want" && "$want" == "$got" ]]
}

# Always pull the latest .md5 — cheap, lets us decide whether to skip the PBF.
fetch_md5

if [[ "$FORCE" -eq 0 && -f "$PBF" ]]; then
  if (cd "$OUT_DIR" && md5sum -c mexico-latest.osm.pbf.md5 >/dev/null 2>&1); then
    echo "[fetch-osm] ✓ existing PBF matches upstream MD5, skipping download"
    ls -lh "$PBF"
    exit 0
  fi
  echo "[fetch-osm] local PBF stale, re-downloading"
fi

# Verify $PBF.tmp BEFORE it replaces the known-good $PBF (audit #158). The
# .md5 was fetched minutes before the PBF, so on a mismatch refetch it first
# (Geofabrik may have rolled to a new daily snapshot in between), and only
# then retry the download once.
for attempt in 1 2; do
  echo "[fetch-osm] downloading mexico-latest.osm.pbf (~750 MB)..."
  curl -fSL --progress-bar -o "$PBF.tmp" "$URL_BASE/mexico-latest.osm.pbf"
  echo "[fetch-osm] verifying MD5..."
  if tmp_matches_md5; then break; fi
  fetch_md5
  if tmp_matches_md5; then break; fi
  if [[ "$attempt" -eq 2 ]]; then
    rm -f "$PBF.tmp"
    echo "[fetch-osm] ✗ MD5 mismatch after retry; existing PBF left untouched" >&2
    exit 1
  fi
  echo "[fetch-osm] MD5 mismatch, retrying the download once" >&2
done
mv "$PBF.tmp" "$PBF"

echo "[fetch-osm] ✓ done"
ls -lh "$PBF"
