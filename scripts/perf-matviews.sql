-- Performance materialized views for /analytics/* endpoints.
--
-- Run once after pipeline + censo + coneval loads complete:
--   docker exec -i supabase-db psql -U postgres -d postgres < scripts/perf-matviews.sql
--
-- Refresh on every DENUE pipeline reload:
--   REFRESH MATERIALIZED VIEW mv_sector_grade_matrix;
--   REFRESH MATERIALIZED VIEW mv_national_treemap;
--
-- Backend handlers in src/api/handlers/analytics.ts use a mat-view-first
-- read with graceful fallback to live SQL on relation-missing — so the
-- analyzer keeps working on a DB that hasn't run this migration, just
-- 100-150× slower.
--
-- Build cost (DENUE 6.1M rows): mv_sector_grade_matrix ~14s,
-- mv_national_treemap ~1.4s. Read cost: ~90ms each. Audit P3-perf
-- (2026-05-04).

-- =============================================================================
-- mv_sector_grade_matrix — SCIAN sector × IRS grade counts
-- (drives the heatmap chart at /locust)
-- =============================================================================
DROP MATERIALIZED VIEW IF EXISTS mv_sector_grade_matrix;
CREATE MATERIALIZED VIEW mv_sector_grade_matrix AS
SELECT
  e.sector_actividad_id AS scian,
  COALESCE(i.irs_grado, 'sin_dato') AS irs_grado,
  COUNT(*)::bigint AS count
FROM establecimientos e
LEFT JOIN coneval_irs_municipal i ON i.cve_mun = e.area_geo
WHERE e.sector_actividad_id IS NOT NULL
GROUP BY 1, 2;

CREATE INDEX idx_mv_sgm_scian ON mv_sector_grade_matrix(scian);
CREATE INDEX idx_mv_sgm_irs ON mv_sector_grade_matrix(irs_grado);

-- =============================================================================
-- mv_national_treemap — 32 entidades with establecimientos count, modal IRS
-- grade, and population-weighted average pobreza %
-- (drives the treemap chart at /locust)
-- =============================================================================
DROP MATERIALIZED VIEW IF EXISTS mv_national_treemap;
CREATE MATERIALIZED VIEW mv_national_treemap AS
WITH entidad_counts AS (
  SELECT entidad, COUNT(*)::bigint AS establecimientos
  FROM establecimientos
  WHERE entidad IS NOT NULL
  GROUP BY entidad
),
entidad_irs AS (
  SELECT
    LEFT(cve_mun, 2) AS entidad,
    irs_grado,
    COUNT(*)::int AS muns_with_grade,
    ROW_NUMBER() OVER (
      PARTITION BY LEFT(cve_mun, 2)
      ORDER BY COUNT(*) DESC
    ) AS rn
  FROM coneval_irs_municipal
  GROUP BY 1, 2
),
entidad_pobreza AS (
  SELECT
    LEFT(cve_mun, 2) AS entidad,
    ROUND(
      SUM(pobreza_pct * COALESCE(poblacion, 0))::numeric
      / NULLIF(SUM(COALESCE(poblacion, 0)), 0),
      2
    ) AS pobreza_pct_promedio
  FROM coneval_pobreza_municipal
  GROUP BY 1
)
SELECT
  ec.entidad,
  ec.establecimientos,
  ei.irs_grado AS modal_irs_grado,
  ep.pobreza_pct_promedio
FROM entidad_counts ec
LEFT JOIN entidad_irs ei
  ON ei.entidad = ec.entidad AND ei.rn = 1
LEFT JOIN entidad_pobreza ep
  ON ep.entidad = ec.entidad;

CREATE INDEX idx_mv_treemap_entidad ON mv_national_treemap(entidad);

-- =============================================================================
-- mv_delitos_municipal_yearly — per-municipality, per-year SESNSP rollup
-- (drives /analytics/risk-summary and /analytics/risk-trend)
--
-- Aggregates the 31.6M-row sesnsp_delitos_municipal long-form table down to
-- ~30k rows (2,469 munis × 12 years). Surfaces the four high-signal subtypes
-- the analyzer cares about for operational-risk scoring:
--   - robo_negocio        — direct retail risk (Robo a negocio subtipo)
--   - homicidio_doloso    — violence severity proxy
--   - extorsion           — extortion of any business class
--   - patrimoniales       — all "El patrimonio" bien_juridico (broader property)
--   - violentos           — all "La vida y la Integridad corporal" (broader violent)
--   - total_delitos       — sum of count across all subtipos
--
-- Read cost ~5ms after the index lookup. Build cost ~6s on a freshly-loaded DB.
-- Refresh after every SESNSP load: REFRESH MATERIALIZED VIEW mv_delitos_municipal_yearly;
-- =============================================================================
DROP MATERIALIZED VIEW IF EXISTS mv_delitos_municipal_yearly CASCADE;
CREATE MATERIALIZED VIEW mv_delitos_municipal_yearly AS
SELECT
  cve_mun,
  ano,
  COALESCE(SUM(count) FILTER (WHERE subtipo_delito = 'Robo a negocio'), 0)::bigint
    AS robo_negocio,
  COALESCE(SUM(count) FILTER (WHERE subtipo_delito = 'Homicidio doloso'), 0)::bigint
    AS homicidio_doloso,
  COALESCE(SUM(count) FILTER (WHERE subtipo_delito = 'Extorsión'), 0)::bigint
    AS extorsion,
  COALESCE(SUM(count) FILTER (WHERE bien_juridico = 'El patrimonio'), 0)::bigint
    AS patrimoniales,
  COALESCE(SUM(count) FILTER (WHERE bien_juridico = 'La vida y la Integridad corporal'), 0)::bigint
    AS violentos,
  SUM(count)::bigint AS total_delitos
FROM sesnsp_delitos_municipal
WHERE cve_mun IS NOT NULL
GROUP BY cve_mun, ano;

CREATE INDEX idx_mv_dmy_cve_mun ON mv_delitos_municipal_yearly(cve_mun);
CREATE INDEX idx_mv_dmy_ano ON mv_delitos_municipal_yearly(ano);
CREATE INDEX idx_mv_dmy_cve_mun_ano ON mv_delitos_municipal_yearly(cve_mun, ano);
