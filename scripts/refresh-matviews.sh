#!/usr/bin/env bash
# Refresh every analytics-backing materialized view in one shot.
#
# Run after any loader pass that changes the underlying tables:
#   - DENUE pipeline reload         → mv_sector_grade_matrix, mv_national_treemap
#   - SESNSP loader (load-sesnsp.ts) → mv_delitos_municipal_yearly
#   - CONEVAL/CLUES reloads          → mv_sector_grade_matrix, mv_national_treemap
#
# The handlers fall back to live aggregation when an MV is missing entirely
# (audit M1, 2026-05-05), but they have NO way to detect "MV exists but is
# stale." Skipping a refresh after a loader rerun produces silent wrong
# answers with no upper bound on staleness — this script makes refreshing
# a one-line habit.
#
# Idempotent. Per-MV refresh times: ~6s (delitos_yearly), ~14s (sector_grade),
# ~1.4s (national_treemap). Total ~22s on the current dataset.

set -euo pipefail

CONTAINER="${SUPABASE_DB_CONTAINER:-supabase-db}"

echo "[refresh-matviews] using container: $CONTAINER"

start=$(date +%s)
docker exec -i "$CONTAINER" psql -U postgres -d postgres <<'SQL'
\echo Refreshing mv_sector_grade_matrix...
REFRESH MATERIALIZED VIEW mv_sector_grade_matrix;

\echo Refreshing mv_national_treemap...
REFRESH MATERIALIZED VIEW mv_national_treemap;

\echo Refreshing mv_delitos_municipal_yearly...
REFRESH MATERIALIZED VIEW mv_delitos_municipal_yearly;
SQL
end=$(date +%s)

echo "[refresh-matviews] done in $((end - start))s"
