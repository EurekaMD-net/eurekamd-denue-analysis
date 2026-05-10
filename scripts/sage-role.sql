-- Sage read-only role + allowlist.
--
-- The denue_sage role backs the Sage SQL fallback path. The LLM-drafted SQL
-- runs as this role so even if the parser+EXPLAIN gates fail, the worst the
-- query can do is SELECT from the allowlisted views/MVs below.
--
-- Allowlist principles:
--   * MVs + views ONLY. No raw tables.
--   * Explicitly NOT: establecimientos (16M rows), sesnsp_delitos_municipal_raw
--     (31.6M rows), censo_ageb_raw (1.6M rows), establecimientos_geo (joins
--     establecimientos at runtime, slow), any *_raw table.
--   * Re-run-safe: every GRANT/REVOKE is idempotent.
--
-- Run via: docker exec -i supabase-db psql -U postgres -d postgres < scripts/sage-role.sql

\set ON_ERROR_STOP on

BEGIN;

-- Role: NOLOGIN; the app server SETs ROLE to it after a transaction
-- begin. Password is for emergency direct-psql access; rotated in .env.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'denue_sage') THEN
    CREATE ROLE denue_sage NOLOGIN;
  END IF;
END$$;

-- Strip any prior privileges (idempotent: REVOKE is no-op when absent).
REVOKE ALL ON SCHEMA public FROM denue_sage;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM denue_sage;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM denue_sage;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM denue_sage;

-- Allow seeing the schema (needed for any SELECT).
GRANT USAGE ON SCHEMA public TO denue_sage;

-- Materialized views (cheap aggregations).
GRANT SELECT ON ce2024_municipal             TO denue_sage;
GRANT SELECT ON clues                        TO denue_sage;
GRANT SELECT ON cnbv_credito_by_estado       TO denue_sage;
GRANT SELECT ON cnbv_credito_by_municipio    TO denue_sage;
GRANT SELECT ON mv_coverage                  TO denue_sage;
GRANT SELECT ON mv_delitos_municipal_yearly  TO denue_sage;
GRANT SELECT ON mv_mortalidad_municipal_yearly TO denue_sage;
GRANT SELECT ON mv_national_treemap          TO denue_sage;
GRANT SELECT ON mv_sector_grade_matrix       TO denue_sage;
GRANT SELECT ON sedatu_financing_by_estado   TO denue_sage;
GRANT SELECT ON sedatu_financing_by_municipio TO denue_sage;
GRANT SELECT ON sict_traffic_by_estado       TO denue_sage;
GRANT SELECT ON sict_traffic_by_municipio    TO denue_sage;

-- Analytical views (no expensive base joins).
GRANT SELECT ON aeropuertos_by_municipio       TO denue_sage;
GRANT SELECT ON aeropuertos_movements_yearly   TO denue_sage;
GRANT SELECT ON bienestar_estatal_latest       TO denue_sage;
GRANT SELECT ON bienestar_estatal_trimestral   TO denue_sage;
GRANT SELECT ON censo_ageb                     TO denue_sage;
GRANT SELECT ON censo_entidades                TO denue_sage;
GRANT SELECT ON censo_localidades              TO denue_sage;
GRANT SELECT ON censo_manzana                  TO denue_sage;
GRANT SELECT ON censo_municipios               TO denue_sage;
GRANT SELECT ON cnbv_credito_2025              TO denue_sage;
GRANT SELECT ON cnbv_credito_estado_grain_2025 TO denue_sage;
GRANT SELECT ON cnbv_panorama_estatal          TO denue_sage;
GRANT SELECT ON cnbv_panorama_municipal        TO denue_sage;
GRANT SELECT ON cofepris_farmacias_by_ageb     TO denue_sage;
GRANT SELECT ON cofepris_farmacias_by_municipio TO denue_sage;
GRANT SELECT ON coneval_grs_ageb               TO denue_sage;
GRANT SELECT ON coneval_irs_municipal          TO denue_sage;
GRANT SELECT ON coneval_pobreza_municipal      TO denue_sage;
GRANT SELECT ON sedatu_financiamientos_2025    TO denue_sage;
GRANT SELECT ON sedatu_financiamientos_estado_grain_2025 TO denue_sage;
GRANT SELECT ON sict_estaciones_viales         TO denue_sage;
GRANT SELECT ON sinba_morbidity_municipal      TO denue_sage;

-- Lookup tables (small, safe).
GRANT SELECT ON cnbv_intermediarios   TO denue_sage;
GRANT SELECT ON cnbv_modalidades      TO denue_sage;
GRANT SELECT ON cnbv_vivienda_tiers   TO denue_sage;
GRANT SELECT ON sedatu_modalidades    TO denue_sage;
GRANT SELECT ON sedatu_organismos     TO denue_sage;
GRANT SELECT ON sedatu_destinos       TO denue_sage;
GRANT SELECT ON sedatu_vivienda_tiers TO denue_sage;
GRANT SELECT ON aeropuertos_cvemun_lookup TO denue_sage;

-- Defense in depth: explicitly REVOKE on the dangerous tables. Redundant
-- given the schema USAGE-only grant, but documented for auditors.
REVOKE ALL ON establecimientos              FROM denue_sage;
REVOKE ALL ON sesnsp_delitos_municipal      FROM denue_sage;
REVOKE ALL ON sesnsp_delitos_municipal_raw  FROM denue_sage;
REVOKE ALL ON censo_ageb_raw                FROM denue_sage;
REVOKE ALL ON ce2024_raw                    FROM denue_sage;
REVOKE ALL ON enigh_concentradohogar_raw    FROM denue_sage;
REVOKE ALL ON enoe_sdem_raw                 FROM denue_sage;
REVOKE ALL ON inegi_edr_defunciones_raw     FROM denue_sage;
REVOKE ALL ON sinba_ec_raw                  FROM denue_sage;
REVOKE ALL ON cofepris_farmacias            FROM denue_sage;
REVOKE ALL ON clues_raw                     FROM denue_sage;
REVOKE ALL ON cnbv_credito_raw_2025         FROM denue_sage;
REVOKE ALL ON cnbv_panorama_estatal_raw     FROM denue_sage;
REVOKE ALL ON cnbv_panorama_municipal_raw   FROM denue_sage;
REVOKE ALL ON coneval_grs_ageb_raw          FROM denue_sage;
REVOKE ALL ON coneval_irs_municipal_raw     FROM denue_sage;
REVOKE ALL ON coneval_pobreza_municipal_raw FROM denue_sage;
REVOKE ALL ON sedatu_financiamientos_raw_2025 FROM denue_sage;
REVOKE ALL ON sict_estaciones_viales_raw_2024 FROM denue_sage;
REVOKE ALL ON bienestar_padron_estatal_trimestral_raw FROM denue_sage;
REVOKE ALL ON aeropuertos_movements_raw     FROM denue_sage;
REVOKE ALL ON censo_iter                    FROM denue_sage;
REVOKE ALL ON ageb_polygons                 FROM denue_sage;
REVOKE ALL ON ent_polygons                  FROM denue_sage;
REVOKE ALL ON mun_polygons                  FROM denue_sage;
REVOKE ALL ON loc_polygons                  FROM denue_sage;

COMMIT;

-- Verification:
--   SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--   WHERE n.nspname='public' AND has_table_privilege('denue_sage', c.oid, 'SELECT')
--   ORDER BY relname;
