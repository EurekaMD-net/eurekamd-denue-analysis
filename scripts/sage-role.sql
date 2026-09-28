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
-- Run via: docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/sage-role.sql

\set ON_ERROR_STOP on

BEGIN;

-- Role: LOGIN, no password. The app connects AS denue_sage (psql -U
-- denue_sage over the container's local socket, which pg_hba trusts) so the
-- session is never a superuser and cannot RESET ROLE / set_config('role').
-- pg_hba also trusts 127.0.0.1/::1 inside the container; every other TCP
-- source (including the published port) needs scram-sha-256, and with
-- PASSWORD NULL there is nothing to match, so the role cannot log in from
-- outside the container.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'denue_sage') THEN
    CREATE ROLE denue_sage LOGIN;
  END IF;
END$$;
ALTER ROLE denue_sage LOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS NOINHERIT;
-- Session defaults for every denue_sage login. The app also opens each
-- script with BEGIN READ ONLY + SET LOCAL statement_timeout; these hold
-- even if a statement slips past the gate outside that transaction.
ALTER ROLE denue_sage SET statement_timeout = '8s';
ALTER ROLE denue_sage SET default_transaction_read_only = on;
ALTER ROLE denue_sage SET search_path = public;

-- Secret masking (audit #110). Custom settings stored with ALTER DATABASE
-- (on 2026-09-27: app.service_role_key and app.webhook_url on database
-- postgres) are readable by EVERY role through current_setting(), and
-- current_setting / set_config cannot be revoked from PUBLIC on this shared
-- instance (PostgREST and RLS policies call them) nor shadowed for one role
-- (grants are additive). A role-level value wins instead: "The ALTER
-- DATABASE command allows global settings to be overridden on a
-- per-database basis. The ALTER ROLE command allows both global and
-- per-database settings to be overridden with user-specific values."
-- (PostgreSQL 15 docs, 20.1.3 Parameter Interaction via SQL). So each such
-- setting reads as '' in every denue_sage session, RESET included, whatever
-- SQL reaches it (ts_stat, a U& identifier, ...). It applies at login, so
-- re-run this script after any new ALTER DATABASE ... SET of a dotted name.
-- NOT covered: the pg_db_role_setting catalog itself stays readable by
-- PUBLIC (non-superusers such as PostgREST's in-database config read it),
-- so the stored value is only name-gated by sql-gate.ts until ALTER
-- DATABASE ... RESET removes it.
DO $$
DECLARE
  guc text;
BEGIN
  FOR guc IN
    SELECT DISTINCT split_part(cfg, '=', 1)
    FROM pg_db_role_setting s, unnest(s.setconfig) AS cfg
    WHERE s.setrole = 0
      AND s.setdatabase IN (
        0, (SELECT oid FROM pg_database WHERE datname = current_database()))
      AND split_part(cfg, '=', 1) LIKE '%.%'
  LOOP
    EXECUTE format(
      'ALTER ROLE denue_sage SET %s = %L',
      (SELECT string_agg(quote_ident(part), '.' ORDER BY ord)
         FROM unnest(string_to_array(guc, '.')) WITH ORDINALITY AS u(part, ord)),
      '');
  END LOOP;
END$$;

-- Functions that run a SQL string (or read server files) must not be
-- callable by denue_sage. Revoked from PUBLIC too, because a PUBLIC grant
-- cannot be shadowed for one role. No stored function or view on this
-- instance calls the SQL-running ones (read-only pg_depend/prosrc check,
-- 2026-09-27) and superusers are unaffected. The file functions and
-- lo_import/lo_export already have no PUBLIC grant; revoking again is a
-- no-op. dblink is not installed; if it ever is, a re-run revokes it from
-- PUBLIC as well. current_setting / set_config are deliberately absent
-- (see Secret masking above). Only signatures that exist are touched.
DO $$
DECLARE
  fn text;
BEGIN
  FOR fn IN
    SELECT to_regprocedure(sig)::text
    FROM unnest(ARRAY[
      'pg_catalog.ts_stat(text)',
      'pg_catalog.ts_stat(text,text)',
      'pg_catalog.ts_rewrite(tsquery,text)',
      'pg_catalog.query_to_xml(text,boolean,boolean,text)',
      'pg_catalog.query_to_xmlschema(text,boolean,boolean,text)',
      'pg_catalog.query_to_xml_and_xmlschema(text,boolean,boolean,text)',
      'pg_catalog.schema_to_xml(name,boolean,boolean,text)',
      'pg_catalog.schema_to_xmlschema(name,boolean,boolean,text)',
      'pg_catalog.schema_to_xml_and_xmlschema(name,boolean,boolean,text)',
      'pg_catalog.database_to_xml(boolean,boolean,text)',
      'pg_catalog.database_to_xmlschema(boolean,boolean,text)',
      'pg_catalog.database_to_xml_and_xmlschema(boolean,boolean,text)',
      'pg_catalog.pg_read_file(text)',
      'pg_catalog.pg_read_file(text,bigint,bigint)',
      'pg_catalog.pg_read_file(text,bigint,bigint,boolean)',
      'pg_catalog.pg_read_binary_file(text)',
      'pg_catalog.pg_read_binary_file(text,bigint,bigint)',
      'pg_catalog.pg_read_binary_file(text,bigint,bigint,boolean)',
      'pg_catalog.pg_ls_dir(text)',
      'pg_catalog.pg_ls_dir(text,boolean,boolean)',
      'pg_catalog.pg_stat_file(text)',
      'pg_catalog.pg_stat_file(text,boolean)',
      'pg_catalog.lo_import(text)',
      'pg_catalog.lo_import(text,oid)',
      'pg_catalog.lo_export(oid,text)'
    ]) AS sig
    WHERE to_regprocedure(sig) IS NOT NULL
    UNION
    SELECT p.oid::regprocedure::text FROM pg_proc p WHERE p.proname LIKE 'dblink%'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, denue_sage', fn);
  END LOOP;
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
-- osm_ageb_aggregates is optional (built by the OSM loader, absent on a DB
-- that never ran it). A bare GRANT on a missing relation aborts this whole
-- ON_ERROR_STOP transaction, so grant it only when it exists.
DO $$
BEGIN
  IF to_regclass('public.osm_ageb_aggregates') IS NOT NULL THEN
    GRANT SELECT ON osm_ageb_aggregates TO denue_sage;
  END IF;
  -- Loaded-edition ledger (migration 026), absent until that migration runs.
  IF to_regclass('public.dataset_versions') IS NOT NULL THEN
    GRANT SELECT ON dataset_versions TO denue_sage;
  END IF;
  -- 2020 -> 2025 municipio key bridge (11 rows) and the canonical 2,478-key
  -- universe over it (migration 027 / migrate-censo-views.sql), absent until
  -- that migration runs.
  IF to_regclass('public.municipio_bridge_2025') IS NOT NULL THEN
    GRANT SELECT ON municipio_bridge_2025 TO denue_sage;
  END IF;
  IF to_regclass('public.municipios_2025') IS NOT NULL THEN
    GRANT SELECT ON municipios_2025 TO denue_sage;
  END IF;
END$$;

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
-- SNIIV years beyond 2025 (docs/SNIIV-2026-H1.md): created by
-- load-sedatu-financiamientos.ts / load-cnbv-credito.ts --year=2026 and absent
-- until then, so each GRANT is existence-guarded like osm_ageb_aggregates. The
-- loaders re-apply these lines after every load (postLoadGrants reads them).
DO $$
BEGIN
  IF to_regclass('public.sedatu_financiamientos_2026') IS NOT NULL THEN
    GRANT SELECT ON sedatu_financiamientos_2026 TO denue_sage;
  END IF;
  IF to_regclass('public.sedatu_financiamientos_estado_grain_2026') IS NOT NULL THEN
    GRANT SELECT ON sedatu_financiamientos_estado_grain_2026 TO denue_sage;
  END IF;
  IF to_regclass('public.cnbv_credito_2026') IS NOT NULL THEN
    GRANT SELECT ON cnbv_credito_2026 TO denue_sage;
  END IF;
  IF to_regclass('public.cnbv_credito_estado_grain_2026') IS NOT NULL THEN
    GRANT SELECT ON cnbv_credito_estado_grain_2026 TO denue_sage;
  END IF;
END$$;

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
DO $$
BEGIN
  IF to_regclass('public.cnbv_credito_raw_2026') IS NOT NULL THEN
    REVOKE ALL ON cnbv_credito_raw_2026 FROM denue_sage;
  END IF;
  IF to_regclass('public.sedatu_financiamientos_raw_2026') IS NOT NULL THEN
    REVOKE ALL ON sedatu_financiamientos_raw_2026 FROM denue_sage;
  END IF;
END$$;

COMMIT;

-- Verification:
--   SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--   WHERE n.nspname='public' AND has_table_privilege('denue_sage', c.oid, 'SELECT')
--   ORDER BY relname;
