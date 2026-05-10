#!/usr/bin/env bash
# Refresh every analytics-backing materialized view in one shot.
#
# Run after any loader pass that changes the underlying tables:
#   - DENUE pipeline reload         → mv_sector_grade_matrix, mv_national_treemap
#   - SESNSP loader (load-sesnsp.ts) → mv_delitos_municipal_yearly
#   - EDR loader (load-edr.ts)       → mv_mortalidad_municipal_yearly
#   - CONEVAL/CLUES reloads          → mv_sector_grade_matrix, mv_national_treemap
#   - SICT loader OR mun_polygons reload → sict_traffic_by_municipio
#   - SEDATU loader (load-sedatu-financiamientos.ts) → sedatu_financing_by_municipio
#
# The handlers fall back to live aggregation when an MV is missing entirely
# (audit M1, 2026-05-05), but they have NO way to detect "MV exists but is
# stale." Skipping a refresh after a loader rerun produces silent wrong
# answers with no upper bound on staleness — this script makes refreshing
# a one-line habit.
#
# Idempotent. Total ~34s on current dataset (5 MVs benched 2026-05-10):
# mv_sector_grade_matrix dominates; sict_traffic_by_municipio is sub-second
# (only 1,153 muni rows aggregated from 6,827-station view). Re-bench after
# any major loader pass.

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

\echo Refreshing mv_mortalidad_municipal_yearly...
REFRESH MATERIALIZED VIEW mv_mortalidad_municipal_yearly;

\echo Refreshing sict_traffic_by_municipio...
REFRESH MATERIALIZED VIEW sict_traffic_by_municipio;

\echo Refreshing sedatu_financing_by_municipio...
REFRESH MATERIALIZED VIEW sedatu_financing_by_municipio;
SQL
end=$(date +%s)

echo "[refresh-matviews] done in $((end - start))s"
