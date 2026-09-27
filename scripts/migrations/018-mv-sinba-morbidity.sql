-- 018: mv_sinba_morbidity_municipal (audit #140, 2026-09-26).
--
-- The sinba_morbidity_municipal view re-aggregates ~141k sinba_ec_raw rows
-- with regex filters on every read (~200 ms; opportunity-by-ageb paid it
-- twice). /analytics/locust-muni and /analytics/opportunity-by-ageb now
-- read this mat-view and fall back to the view only when it is missing.
--
-- Built FROM the view (scripts/load-sinba.ts owns its definition), so the
-- two cannot drift. UNIQUE (cve_mun, anio) enables REFRESH ... CONCURRENTLY
-- in scripts/refresh-matviews.sh (verified 2026-09-26: 2204 rows, 2204
-- distinct keys, 0 NULL keys).
--
-- load-sinba.ts runs DROP TABLE sinba_ec_raw CASCADE, which drops this MV
-- too. After every SINBA reload, re-run this file (REFRESH cannot recreate
-- a dropped MV; the handlers serve from the view until then).
--
-- Idempotent. Apply:
--   docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/migrations/018-mv-sinba-morbidity.sql

BEGIN;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_sinba_morbidity_municipal AS
SELECT
  cve_mun,
  anio,
  casos_dm2_promedio,
  casos_hta_promedio,
  casos_obesidad_promedio,
  clues_reportando
FROM sinba_morbidity_municipal;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_smm_unique
  ON mv_sinba_morbidity_municipal(cve_mun, anio);

GRANT SELECT ON mv_sinba_morbidity_municipal TO denue_sage;
-- The API reads this as denue_api (scripts/api-role.sql, audit #8); guarded
-- so the migration still applies before that role exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'denue_api') THEN
    GRANT SELECT ON mv_sinba_morbidity_municipal TO denue_api;
  END IF;
END$$;

COMMIT;
