#!/usr/bin/env bash
# Operator script: rebuild mv_mortalidad_municipal_yearly from its canonical DDL in
# scripts/perf-matviews.sql (after the 2026-09-28 fence of the EDR sentinel anio_ocur = '9999').
#
#   bash ops/rebuild-mortalidad-mv.sh
#
# Why a rebuild and not REFRESH: a WHERE change needs the DDL re-run; REFRESH MATERIALIZED VIEW
# re-executes the stored definition, so the old filter would stay. Do not re-run all of
# perf-matviews.sql for this: it also rebuilds mv_sector_grade_matrix (~5 min) and its sections
# DROP ... CASCADE.
#
# One psql transaction (--single-transaction, ON_ERROR_STOP): DROP without CASCADE (an unknown
# dependent fails the DROP and rolls back), the MV's perf-matviews.sql section (CREATE + indexes +
# denue_sage grant), postLoadGrants (REVOKE anon/authenticated/trustr_app) and the denue_api grant
# that the DROP loses. Then prints `rows with ano = 9999 | total rows` (expect 0|5697) and the ACL.
set -euo pipefail

REPO=/root/claude/projects/data-intelligence/denue-data-analysis
MV=mv_mortalidad_municipal_yearly

cd "$REPO"
npx tsx -e 'import("./scripts/_psql-tx.ts").then(m => process.stdout.write(["DROP MATERIALIZED VIEW IF EXISTS mv_mortalidad_municipal_yearly;", m.perfMatviewSql("mv_mortalidad_municipal_yearly"), m.postLoadGrants(["mv_mortalidad_municipal_yearly"]), "GRANT SELECT ON mv_mortalidad_municipal_yearly TO denue_api;", ""].join("\n")))' \
  | docker exec -i supabase-db psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 --single-transaction -f -

docker exec supabase-db psql -U postgres -d postgres -qtA \
  -c "SELECT COUNT(*) FILTER (WHERE ano = 9999) || '|' || COUNT(*) FROM $MV" \
  -c "SELECT relacl FROM pg_class WHERE relname = '$MV'"
