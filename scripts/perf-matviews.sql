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
-- Audit W4 (2026-05-05): require 5-char keys so orphan rows (4-char federal
-- districts pre-2017, missing zero-pad) don't produce never-joining rollups.
-- Matches CVE_MUN_RE on the API side. Removes ~0 rows in the current data
-- but defends future emissions.
WHERE cve_mun IS NOT NULL AND LENGTH(cve_mun) = 5
GROUP BY cve_mun, ano;

CREATE INDEX idx_mv_dmy_cve_mun ON mv_delitos_municipal_yearly(cve_mun);
CREATE INDEX idx_mv_dmy_ano ON mv_delitos_municipal_yearly(ano);
CREATE INDEX idx_mv_dmy_cve_mun_ano ON mv_delitos_municipal_yearly(cve_mun, ano);


-- =============================================================================
-- mv_mortalidad_municipal_yearly — pre-rolled annual mortality per cve_mun
-- =============================================================================
-- v0.2.3-A (2026-05-05). Aggregates the ~820k-row inegi_edr_defunciones_raw
-- (per-record microdata, residence-based) down to ~2.5k rows per year-loaded.
-- Surfaces the high-signal cause groupings used by /analytics/mortality-*:
--   - total_defunciones       — count of deaths attributed to this cve_mun
--   - def_menores_1ano        — infant mortality (edad codes 1xxx/2xxx/3xxx
--                               are horas/días/meses; 4xxx is años)
--   - def_circulatorio        — capitulo IX (CIE-10 chapter "I")
--   - def_neoplasias          — capitulo II (CIE-10 chapter "C/D")
--   - def_endocrinas          — capitulo IV (CIE-10 chapter "E", incl. diabetes)
--   - def_externas            — capitulo XX (CIE-10 chapters V-Y, accidents +
--                               suicides + homicides). Distinct from SESNSP
--                               counts: SESNSP is reported crime, EDR is
--                               registered death — overlap is partial.
--
-- Filtering: ent_resid IN ('01'..'32') AND mun_resid != '999'. Excludes
-- foreign-resident deaths (codes 33-35) and unknown-residence rows (99/999).
-- Source rows excluded ≈ 1.3% (10,609 of 819,672 in the 2024 load).
--
-- "ano" column is INT (cast from raw TEXT anio_ocur). Per-year scope is
-- "year of occurrence" (anio_ocur), NOT registration (anio_regis). EDR
-- registers deaths ~10-12mo after occurrence; using occurrence avoids
-- the lag artifact where 2023 deaths show up in 2024 totals.
--
-- Read cost ~3ms after btree lookup. Build cost ~4s for a single year.
-- Refresh after each load: REFRESH MATERIALIZED VIEW mv_mortalidad_municipal_yearly;
-- (or use scripts/refresh-matviews.sh which sweeps all 4 analytics MVs)
-- =============================================================================
DROP MATERIALIZED VIEW IF EXISTS mv_mortalidad_municipal_yearly CASCADE;
CREATE MATERIALIZED VIEW mv_mortalidad_municipal_yearly AS
SELECT
  (ent_resid || mun_resid)                                       AS cve_mun,
  NULLIF(anio_ocur, '')::int                                     AS ano,
  COUNT(*)::bigint                                               AS total_defunciones,
  COUNT(*) FILTER (WHERE LEFT(edad, 1) IN ('1', '2', '3'))::bigint
    AS def_menores_1ano,
  -- capitulo ships as unpadded TEXT integers ("9" not "09"). Cast to int so
  -- single-digit and double-digit codes both compare correctly. NULLIF
  -- guards rare empty strings (none in 2024 data, defensive for future loads).
  COUNT(*) FILTER (WHERE NULLIF(capitulo, '')::int = 9)::bigint   AS def_circulatorio,
  COUNT(*) FILTER (WHERE NULLIF(capitulo, '')::int = 2)::bigint   AS def_neoplasias,
  COUNT(*) FILTER (WHERE NULLIF(capitulo, '')::int = 4)::bigint   AS def_endocrinas,
  COUNT(*) FILTER (WHERE NULLIF(capitulo, '')::int = 20)::bigint  AS def_externas
FROM inegi_edr_defunciones_raw
WHERE ent_resid IN ('01','02','03','04','05','06','07','08','09','10',
                    '11','12','13','14','15','16','17','18','19','20',
                    '21','22','23','24','25','26','27','28','29','30',
                    '31','32')
  AND mun_resid IS NOT NULL AND mun_resid != '999'
  AND NULLIF(anio_ocur, '') IS NOT NULL
  AND anio_ocur ~ '^[0-9]{4}$'
GROUP BY ent_resid || mun_resid, NULLIF(anio_ocur, '')::int;

CREATE INDEX idx_mv_mmy_cve_mun ON mv_mortalidad_municipal_yearly(cve_mun);
CREATE INDEX idx_mv_mmy_ano ON mv_mortalidad_municipal_yearly(ano);
CREATE INDEX idx_mv_mmy_cve_mun_ano ON mv_mortalidad_municipal_yearly(cve_mun, ano);
