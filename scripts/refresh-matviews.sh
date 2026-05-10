#!/usr/bin/env bash
# Refresh every aggregation-based analytics MV in one shot.
#
# Run after any loader pass that changes establecimientos / sesnsp /
# mortalidad / sict / sedatu / cnbv:
#   - DENUE pipeline reload         → mv_sector_grade_matrix, mv_national_treemap, mv_coverage
#   - SESNSP loader (load-sesnsp.ts) → mv_delitos_municipal_yearly
#   - EDR loader (load-edr.ts)       → mv_mortalidad_municipal_yearly
#   - CONEVAL/CLUES reloads          → mv_sector_grade_matrix, mv_national_treemap
#   - SICT loader OR mun_polygons reload → sict_traffic_by_municipio + sict_traffic_by_estado
#   - SEDATU loader (load-sedatu-financiamientos.ts) → sedatu_financing_by_municipio + sedatu_financing_by_estado
#   - CNBV loader (load-cnbv-credito.ts) → cnbv_credito_by_municipio + cnbv_credito_by_estado
#
# The handlers fall back to live aggregation when an MV is missing entirely
# (audit M1, 2026-05-05), but they have NO way to detect "MV exists but is
# stale." Skipping a refresh after a loader rerun produces silent wrong
# answers with no upper bound on staleness — this script makes refreshing
# a one-line habit.
#
# NOT INCLUDED (intentional, audit C2 round-1 closure 2026-05-10):
#   - clues, ce2024_municipal, sesnsp_delitos_municipal — these are
#     atomically rebuilt via DROP+CREATE by their loaders. The MV is
#     1:1 with the underlying raw table; the raw table doesn't change
#     between loader runs. Daily REFRESH would be wasteful (sesnsp
#     alone is 4975 MB / 31.6M rows). If a future loader switches to
#     INSERT-without-rebuild, add them here.
#
# ORDER (cheap-first, audit W3 round-1 closure 2026-05-10):
#   Run small/sub-second MVs first; mv_sector_grade_matrix LAST since
#   it's the only one that takes minutes. A partial-run kill (systemd
#   timeout, container restart) then loses only the most expensive MV
#   instead of also dropping the cheap wins.
#
# Idempotent. Runtime baseline 2026-05-09 SUCCESS run:
#   mv_sector_grade_matrix=294s, mv_national_treemap=2s, delitos=22s,
#   mortalidad=1s, others sub-second. Total 194s end-to-end. Plan for
#   ~5min growth headroom; systemd TimeoutStartSec=1800 reflects that.

set -euo pipefail

CONTAINER="${SUPABASE_DB_CONTAINER:-supabase-db}"

echo "[refresh-matviews] using container: $CONTAINER"

start=$(date +%s)
docker exec -i "$CONTAINER" psql -U postgres -d postgres <<'SQL'
-- ===== Cheap MVs first (sub-second each) =====

\echo Refreshing mv_national_treemap...
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_national_treemap;

\echo Refreshing mv_coverage...
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_coverage;

\echo Refreshing sict_traffic_by_municipio...
REFRESH MATERIALIZED VIEW CONCURRENTLY sict_traffic_by_municipio;

\echo Refreshing sict_traffic_by_estado...
REFRESH MATERIALIZED VIEW CONCURRENTLY sict_traffic_by_estado;

\echo Refreshing sedatu_financing_by_municipio...
REFRESH MATERIALIZED VIEW CONCURRENTLY sedatu_financing_by_municipio;

\echo Refreshing sedatu_financing_by_estado...
REFRESH MATERIALIZED VIEW CONCURRENTLY sedatu_financing_by_estado;

\echo Refreshing cnbv_credito_by_municipio...
REFRESH MATERIALIZED VIEW CONCURRENTLY cnbv_credito_by_municipio;

\echo Refreshing cnbv_credito_by_estado...
REFRESH MATERIALIZED VIEW CONCURRENTLY cnbv_credito_by_estado;

\echo Refreshing mv_mortalidad_municipal_yearly...
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_mortalidad_municipal_yearly;

-- ===== Mid-cost (~22s) =====

\echo Refreshing mv_delitos_municipal_yearly...
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_delitos_municipal_yearly;

-- ===== Expensive (~5min) — LAST so a mid-run kill loses only this one =====

\echo Refreshing mv_sector_grade_matrix...
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_sector_grade_matrix;
SQL
end=$(date +%s)

echo "[refresh-matviews] done in $((end - start))s"
