-- 021: mv_sector_summary + mv_estrato_por_entidad (audit #39 #98 #99 #107
-- #126 #132, 2026-09-27).
--
-- Both MVs were defined in src/db/materialized-views.sql but never created
-- live, so /summary/entidad returned empty top_sectors and
-- estrato_distribution with 200 OK. They are now applied, and /sectors and
-- /summary/sector/:scian read mv_sector_summary instead of re-aggregating
-- the 6.1M-row establecimientos heap on every request (0.4-14 s).
--
-- mv_sector_summary groups by sector_actividad_id as well, so /sectors can
-- SUM it per sector and /summary/sector per (sector, entidad). The label is
-- MAX(clase_actividad), not a GROUP BY key, so label drift inside one
-- clase_actividad_id cannot split a group. sector_actividad_id is part of
-- the unique key: the loader derives it as left(clase_actividad_id, 2), but
-- rows loaded before that fix are not guaranteed to agree, and a disagreeing
-- row must not break REFRESH ... CONCURRENTLY with a duplicate key.
--
-- Built WITH NO DATA, then one plain REFRESH each (CONCURRENTLY is not
-- allowed on an unpopulated MV). scripts/refresh-matviews.sh refreshes both
-- CONCURRENTLY afterwards. Grants follow scripts/migrations/002 (loaders):
-- service_role (PostgREST, the API's key) and denue_sage read; anon,
-- authenticated and trustr_app get nothing.
--
-- Idempotent (IF NOT EXISTS; the REFRESH re-runs). Apply:
--   docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/migrations/021-summary-mvs.sql

BEGIN;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_sector_summary AS
SELECT
  entidad,
  sector_actividad_id,
  clase_actividad_id,
  MAX(clase_actividad) AS clase_actividad,
  COUNT(*)::BIGINT AS total
FROM establecimientos
GROUP BY entidad, sector_actividad_id, clase_actividad_id
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS mv_sector_summary_pk
  ON mv_sector_summary (entidad, sector_actividad_id, clase_actividad_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_estrato_por_entidad AS
SELECT
  entidad,
  estrato,
  COUNT(*)::BIGINT AS total
FROM establecimientos
WHERE estrato IS NOT NULL
GROUP BY entidad, estrato
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS mv_estrato_por_entidad_pk
  ON mv_estrato_por_entidad (entidad, estrato);

REFRESH MATERIALIZED VIEW mv_sector_summary;
REFRESH MATERIALIZED VIEW mv_estrato_por_entidad;

REVOKE ALL ON mv_sector_summary FROM anon, authenticated, trustr_app;
REVOKE ALL ON mv_estrato_por_entidad FROM anon, authenticated, trustr_app;
GRANT SELECT ON mv_sector_summary TO service_role, denue_sage;
GRANT SELECT ON mv_estrato_por_entidad TO service_role, denue_sage;
-- The API reads this as denue_api (scripts/api-role.sql, audit #8); guarded
-- so the migration still applies before that role exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'denue_api') THEN
    GRANT SELECT ON mv_sector_summary TO denue_api;
  END IF;
END$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
