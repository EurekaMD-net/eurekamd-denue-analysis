-- 019: censo view repairs, deterministic national treemap, AGEB geometry
-- repair (audit #59-#73/#118/#124 package P19, 2026-09-26).
--
-- 1. censo_municipios gains p_12ymas as its LAST column (CREATE OR REPLACE
--    can only append). /analytics/locust-muni now computes
--    pct_pea = pea / p_12ymas: Censo PEA covers ages 12+ (#67).
-- 2. censo_localidades: cve_mun is the raw censo_iter column and
--    cve_loc = cve_mun || loc (no LPAD), so the new partial index serves
--    localities-by-municipio / locality-detail instead of a Parallel Seq
--    Scan over 195k rows (#118); INEGI's 9998/9999 "Localidades de una/dos
--    viviendas" buckets are excluded (#68). Names and types are unchanged,
--    so CREATE OR REPLACE keeps the denue_sage grant.
-- 3. mv_national_treemap is rebuilt: only entidades 01-32 (a stray '50'
--    made a 33rd tile) and a deterministic modal IRS grade
--    (COUNT DESC, SUM(pob_total) DESC, irs_grado; NULL grade excluded) so a
--    tie (Colima today) cannot flip between refreshes (#63/#124).
-- 4. The 22 invalid ageb_polygons geometries (ring self-intersection) are
--    repaired with ST_MakeValid, kept MultiPolygon (#71). Dry run
--    2026-09-26: 22/22 valid non-empty MultiPolygons, max area delta 3e-17.
-- 5. CREATE INDEX CONCURRENTLY runs last, outside the transaction (it
--    cannot run inside one).
--
-- The view bodies are copied verbatim from scripts/migrate-censo-views.sql
-- and scripts/perf-matviews.sql (the canonical definitions) — edit those
-- first and keep this file in sync.
--
-- Idempotent. Apply:
--   docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/migrations/019-censo-views-treemap-geoms.sql

BEGIN;

CREATE OR REPLACE VIEW censo_municipios AS
SELECT
  cve_mun,
  entidad,
  mun,
  nom_mun,

  -- ─── Population (already exposed pre-v0.2.10) ───────────────────────────
  NULLIF(NULLIF(pobtot,    ''), 'N/D')::int     AS pobtot,
  NULLIF(NULLIF(pobfem,    ''), 'N/D')::int     AS pobfem,
  NULLIF(NULLIF(pobmas,    ''), 'N/D')::int     AS pobmas,
  NULLIF(NULLIF(p_60ymas,  ''), 'N/D')::int     AS p_60ymas,
  NULLIF(NULLIF(p_15ymas,  ''), 'N/D')::int     AS p_15ymas,
  NULLIF(NULLIF(p_18ymas,  ''), 'N/D')::int     AS p_18ymas,
  NULLIF(NULLIF(pea,       ''), 'N/D')::int     AS pea,
  NULLIF(NULLIF(pocupada,  ''), 'N/D')::int     AS pocupada,
  NULLIF(NULLIF(graproes,  ''), 'N/D')::numeric AS graproes,
  NULLIF(NULLIF(tvivhab,   ''), 'N/D')::int     AS tvivhab,
  NULLIF(NULLIF(tvivpar,   ''), 'N/D')::int     AS tvivpar,
  NULLIF(NULLIF(vph_inter, ''), 'N/D')::int     AS vph_inter,
  NULLIF(NULLIF(vph_autom, ''), 'N/D')::int     AS vph_autom,

  -- ─── Religion (v0.2.10 NEW) ─────────────────────────────────────────────
  NULLIF(NULLIF(pcatolica,  ''), 'N/D')::int    AS pcatolica,    -- católica
  NULLIF(NULLIF(pro_crieva, ''), 'N/D')::int    AS pro_crieva,   -- protestante / evangélico
  NULLIF(NULLIF(potras_rel, ''), 'N/D')::int    AS potras_rel,   -- otras religiones
  NULLIF(NULLIF(psin_relig, ''), 'N/D')::int    AS psin_relig,   -- sin religión

  -- ─── Indigenous & Afro (v0.2.10 NEW) ────────────────────────────────────
  NULLIF(NULLIF(p3ym_hli,  ''), 'N/D')::int     AS p3ym_hli,     -- 3+ habla LI
  NULLIF(NULLIF(p3hlinhe,  ''), 'N/D')::int     AS p3hlinhe,     -- LI sin español
  NULLIF(NULLIF(p3hli_he,  ''), 'N/D')::int     AS p3hli_he,     -- LI con español
  NULLIF(NULLIF(phog_ind,  ''), 'N/D')::int     AS phog_ind,     -- en hogar indígena
  NULLIF(NULLIF(pob_afro,  ''), 'N/D')::int     AS pob_afro,     -- afromexicano

  -- ─── Migration (v0.2.10 NEW) ────────────────────────────────────────────
  NULLIF(NULLIF(pnacent,   ''), 'N/D')::int     AS pnacent,      -- nacida en entidad
  NULLIF(NULLIF(pnacoe,    ''), 'N/D')::int     AS pnacoe,       -- nacida en otra entidad
  NULLIF(NULLIF(pres2015,  ''), 'N/D')::int     AS pres2015,     -- residente misma ent en 2015
  NULLIF(NULLIF(presoe15,  ''), 'N/D')::int     AS presoe15,     -- residente otra ent en 2015

  -- ─── Education detail (v0.2.10 NEW; supplements graproes) ───────────────
  NULLIF(NULLIF(p15ym_an,  ''), 'N/D')::int     AS p15ym_an,     -- 15+ analfabeta
  NULLIF(NULLIF(p15ym_se,  ''), 'N/D')::int     AS p15ym_se,     -- 15+ sin escolaridad
  NULLIF(NULLIF(p15pri_in, ''), 'N/D')::int     AS p15pri_in,    -- 15+ primaria incompleta
  NULLIF(NULLIF(p15pri_co, ''), 'N/D')::int     AS p15pri_co,    -- 15+ primaria completa
  NULLIF(NULLIF(p15sec_in, ''), 'N/D')::int     AS p15sec_in,    -- 15+ secundaria incompleta
  NULLIF(NULLIF(p15sec_co, ''), 'N/D')::int     AS p15sec_co,    -- 15+ secundaria completa
  NULLIF(NULLIF(p18ym_pb,  ''), 'N/D')::int     AS p18ym_pb,     -- 18+ con educ. postbásica

  -- ─── Civil status (v0.2.10 NEW) ─────────────────────────────────────────
  NULLIF(NULLIF(p12ym_solt, ''), 'N/D')::int    AS p12ym_solt,
  NULLIF(NULLIF(p12ym_casa, ''), 'N/D')::int    AS p12ym_casa,
  NULLIF(NULLIF(p12ym_sepa, ''), 'N/D')::int    AS p12ym_sepa,

  -- ─── Disability summary (v0.2.10 NEW) ───────────────────────────────────
  NULLIF(NULLIF(pcon_disc, ''), 'N/D')::int     AS pcon_disc,    -- con discapacidad
  NULLIF(NULLIF(pcon_limi, ''), 'N/D')::int     AS pcon_limi,    -- con limitación
  NULLIF(NULLIF(psind_lim, ''), 'N/D')::int     AS psind_lim,    -- sin discap/limit

  -- ─── Health coverage (v0.2.10 NEW; complements v0.2.7 AGEB-grain) ───────
  NULLIF(NULLIF(psinder,    ''), 'N/D')::int    AS psinder,      -- sin derechohabiencia
  NULLIF(NULLIF(pder_ss,    ''), 'N/D')::int    AS pder_ss,      -- con servicios salud
  NULLIF(NULLIF(pder_imss,  ''), 'N/D')::int    AS pder_imss,    -- IMSS
  NULLIF(NULLIF(pder_iste,  ''), 'N/D')::int    AS pder_iste,    -- ISSSTE
  NULLIF(NULLIF(pder_segp,  ''), 'N/D')::int    AS pder_segp,    -- SegPop / INSABI
  NULLIF(NULLIF(pder_imssb, ''), 'N/D')::int    AS pder_imssb,   -- IMSS-Bienestar
  NULLIF(NULLIF(pafil_ipriv,''), 'N/D')::int    AS pafil_ipriv,  -- privada

  -- ─── Household assets (v0.2.10 NEW; vph_inter+autom already exposed) ────
  NULLIF(NULLIF(vph_refri,  ''), 'N/D')::int    AS vph_refri,
  NULLIF(NULLIF(vph_lavad,  ''), 'N/D')::int    AS vph_lavad,
  NULLIF(NULLIF(vph_hmicro, ''), 'N/D')::int    AS vph_hmicro,
  NULLIF(NULLIF(vph_moto,   ''), 'N/D')::int    AS vph_moto,
  NULLIF(NULLIF(vph_bici,   ''), 'N/D')::int    AS vph_bici,
  NULLIF(NULLIF(vph_radio,  ''), 'N/D')::int    AS vph_radio,
  NULLIF(NULLIF(vph_tv,     ''), 'N/D')::int    AS vph_tv,
  NULLIF(NULLIF(vph_pc,     ''), 'N/D')::int    AS vph_pc,
  NULLIF(NULLIF(vph_telef,  ''), 'N/D')::int    AS vph_telef,
  NULLIF(NULLIF(vph_cel,    ''), 'N/D')::int    AS vph_cel,
  NULLIF(NULLIF(vph_stvp,   ''), 'N/D')::int    AS vph_stvp,     -- TV de paga
  NULLIF(NULLIF(vph_spmvpi, ''), 'N/D')::int    AS vph_spmvpi,   -- streaming
  NULLIF(NULLIF(vph_cvj,    ''), 'N/D')::int    AS vph_cvj,      -- consola
  NULLIF(NULLIF(vph_snbien, ''), 'N/D')::int    AS vph_snbien,   -- sin bienes

  -- nom_ent appended at the end (CREATE OR REPLACE VIEW can only add cols
  -- at the END of the SELECT list — not insert in the middle). Surfaces
  -- the human-readable entidad name for /analytics/municipio-detail
  -- responses, mirroring censo_localidades which already exposes nom_ent.
  -- Audit W1 (2026-05-09).
  nom_ent,

  -- p_12ymas appended at the end (same rule): Censo PEA covers ages 12+,
  -- so it is the denominator of locust-muni's pct_pea (audit #67).
  NULLIF(NULLIF(p_12ymas, ''), 'N/D')::int     AS p_12ymas
FROM censo_iter
WHERE loc = '0000' AND mun <> '000';

CREATE OR REPLACE VIEW censo_localidades AS
SELECT
  -- ─── Identity ───────────────────────────────────────────────────────────
  cve_mun || loc                                                   AS cve_loc,
  cve_mun,
  entidad,
  mun,
  loc,
  nom_loc,
  nom_mun,
  nom_ent,
  NULLIF(NULLIF(tamloc, ''), 'N/D')::int                           AS tamloc,
  -- INEGI ITER ships latitud/longitud as DMS strings (19°21'32.414" N) which
  -- can't be cast to numeric without a parser; deferred to a follow-up
  -- sprint if downstream needs decimal coords. Establishment-level geo is
  -- already in establecimientos.geom (decimal degrees, SRID 4326).
  -- altitud is plain numeric for 189,409 / 193,094 localities; the 23
  -- legacy "00-N" coded rows return NULL via the regex guard.
  CASE WHEN altitud ~ '^-?[0-9]+(\.[0-9]+)?$'
       THEN altitud::numeric ELSE NULL END                         AS altitud_m,

  -- ─── Population ─────────────────────────────────────────────────────────
  NULLIF(NULLIF(pobtot,   ''), 'N/D')::int     AS pobtot,
  NULLIF(NULLIF(pobfem,   ''), 'N/D')::int     AS pobfem,
  NULLIF(NULLIF(pobmas,   ''), 'N/D')::int     AS pobmas,
  NULLIF(NULLIF(p_60ymas, ''), 'N/D')::int     AS p_60ymas,
  NULLIF(NULLIF(p_15ymas, ''), 'N/D')::int     AS p_15ymas,
  NULLIF(NULLIF(p_18ymas, ''), 'N/D')::int     AS p_18ymas,
  NULLIF(NULLIF(pea,      ''), 'N/D')::int     AS pea,
  NULLIF(NULLIF(pocupada, ''), 'N/D')::int     AS pocupada,
  NULLIF(NULLIF(graproes, ''), 'N/D')::numeric AS graproes,
  NULLIF(NULLIF(tvivhab,  ''), 'N/D')::int     AS tvivhab,
  NULLIF(NULLIF(tvivpar,  ''), 'N/D')::int     AS tvivpar,

  -- ─── Religion ───────────────────────────────────────────────────────────
  NULLIF(NULLIF(pcatolica,  ''), 'N/D')::int   AS pcatolica,
  NULLIF(NULLIF(pro_crieva, ''), 'N/D')::int   AS pro_crieva,
  NULLIF(NULLIF(potras_rel, ''), 'N/D')::int   AS potras_rel,
  NULLIF(NULLIF(psin_relig, ''), 'N/D')::int   AS psin_relig,

  -- ─── Indigenous & Afro ──────────────────────────────────────────────────
  NULLIF(NULLIF(p3ym_hli, ''), 'N/D')::int     AS p3ym_hli,
  NULLIF(NULLIF(p3hlinhe, ''), 'N/D')::int     AS p3hlinhe,
  NULLIF(NULLIF(p3hli_he, ''), 'N/D')::int     AS p3hli_he,
  NULLIF(NULLIF(phog_ind, ''), 'N/D')::int     AS phog_ind,
  NULLIF(NULLIF(pob_afro, ''), 'N/D')::int     AS pob_afro,

  -- ─── Migration ──────────────────────────────────────────────────────────
  NULLIF(NULLIF(pnacent,  ''), 'N/D')::int     AS pnacent,
  NULLIF(NULLIF(pnacoe,   ''), 'N/D')::int     AS pnacoe,
  NULLIF(NULLIF(pres2015, ''), 'N/D')::int     AS pres2015,
  NULLIF(NULLIF(presoe15, ''), 'N/D')::int     AS presoe15,

  -- ─── Education detail ───────────────────────────────────────────────────
  NULLIF(NULLIF(p15ym_an, ''), 'N/D')::int     AS p15ym_an,
  NULLIF(NULLIF(p15ym_se, ''), 'N/D')::int     AS p15ym_se,
  NULLIF(NULLIF(p18ym_pb, ''), 'N/D')::int     AS p18ym_pb,

  -- ─── Health coverage ────────────────────────────────────────────────────
  NULLIF(NULLIF(psinder,     ''), 'N/D')::int  AS psinder,
  NULLIF(NULLIF(pder_ss,     ''), 'N/D')::int  AS pder_ss,
  NULLIF(NULLIF(pder_imss,   ''), 'N/D')::int  AS pder_imss,
  NULLIF(NULLIF(pder_iste,   ''), 'N/D')::int  AS pder_iste,
  NULLIF(NULLIF(pder_segp,   ''), 'N/D')::int  AS pder_segp,
  NULLIF(NULLIF(pder_imssb,  ''), 'N/D')::int  AS pder_imssb,
  NULLIF(NULLIF(pafil_ipriv, ''), 'N/D')::int  AS pafil_ipriv,

  -- ─── Household assets ───────────────────────────────────────────────────
  NULLIF(NULLIF(vph_inter,  ''), 'N/D')::int   AS vph_inter,
  NULLIF(NULLIF(vph_autom,  ''), 'N/D')::int   AS vph_autom,
  NULLIF(NULLIF(vph_refri,  ''), 'N/D')::int   AS vph_refri,
  NULLIF(NULLIF(vph_lavad,  ''), 'N/D')::int   AS vph_lavad,
  NULLIF(NULLIF(vph_pc,     ''), 'N/D')::int   AS vph_pc,
  NULLIF(NULLIF(vph_cel,    ''), 'N/D')::int   AS vph_cel,
  NULLIF(NULLIF(vph_tv,     ''), 'N/D')::int   AS vph_tv,
  NULLIF(NULLIF(vph_snbien, ''), 'N/D')::int   AS vph_snbien
FROM censo_iter
WHERE loc <> '0000' AND mun <> '000' AND loc NOT IN ('9998', '9999');

DROP MATERIALIZED VIEW IF EXISTS mv_national_treemap;
CREATE MATERIALIZED VIEW mv_national_treemap AS
WITH entidad_counts AS (
  SELECT entidad, COUNT(*)::bigint AS establecimientos
  FROM establecimientos
  -- audit #124: only the 32 real entidades (a stray '50' made a 33rd tile).
  WHERE entidad ~ '^(0[1-9]|[12][0-9]|3[0-2])$'
  GROUP BY entidad
),
entidad_irs AS (
  SELECT
    LEFT(cve_mun, 2) AS entidad,
    irs_grado,
    COUNT(*)::int AS muns_with_grade,
    -- audit #63/#124: deterministic tiebreak (population, then name) so a
    -- tied mode cannot flip between refreshes; NULL grade never wins.
    ROW_NUMBER() OVER (
      PARTITION BY LEFT(cve_mun, 2)
      ORDER BY COUNT(*) DESC, SUM(pob_total) DESC, irs_grado
    ) AS rn
  FROM coneval_irs_municipal
  WHERE irs_grado IS NOT NULL
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_treemap_entidad_unique
  ON mv_national_treemap(entidad);

GRANT SELECT ON mv_national_treemap TO denue_sage;
-- The API reads this as denue_api (scripts/api-role.sql, audit #8); guarded
-- so the migration still applies before that role exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'denue_api') THEN
    GRANT SELECT ON mv_national_treemap TO denue_api;
  END IF;
END$$;

UPDATE ageb_polygons
SET geom = ST_Multi(ST_CollectionExtract(ST_MakeValid(geom), 3))
WHERE NOT ST_IsValid(geom);

COMMIT;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_censo_iter_cve_mun_loc
  ON censo_iter(cve_mun, loc) WHERE loc <> '0000' AND mun <> '000';
