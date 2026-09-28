-- API least-privilege role (audit finding #8, 2026-09-26).
--
-- The API's psql runner (src/api/db/psql-runner.ts) logs in as denue_api
-- instead of the postgres superuser, so a mistake in any interpolated SQL
-- builder runs without superuser rights: no COPY ... TO PROGRAM, no reads or
-- writes on other projects' data (auth.*, trustr, mission-control).
--
-- Allowlist principles:
--   * SELECT on exactly the relations the runner's callers read
--     (src/api/handlers/{analytics,layers-values,search,sectors,
--     summary-sector,tiles}.ts, src/analysis/cluster-by-sector.ts and
--     src/osm/osmium.ts, the municipio bbox for street-geometry.ts).
--     Handlers that go through PostgREST (entidades, establishment,
--     summary-entidad, coverage-report) use service_role, not this role.
--   * SELECT/INSERT/UPDATE/DELETE on the two Sage thread tables only.
--   * Re-run-safe: the role is reset to no privileges, then granted again.
--     A relation that does not exist yet (a pending migration) is skipped
--     with a NOTICE; re-run this script after applying that migration.
--
-- Adding a relation to an API query? Add it to the list below, re-run this
-- script, and make whatever script re-creates it re-grant SELECT to
-- denue_api (DROP + CREATE loses the ACL).
--
-- Run via: docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/api-role.sql

\set ON_ERROR_STOP on

BEGIN;

-- Role: LOGIN, no password. The app connects AS denue_api (psql -U
-- denue_api over the container's local socket, which pg_hba trusts). TCP
-- connections require scram-sha-256, and with PASSWORD NULL there is
-- nothing to match, so the role cannot log in from outside the container.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'denue_api') THEN
    CREATE ROLE denue_api LOGIN;
  END IF;
END$$;
ALTER ROLE denue_api LOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS;

-- Strip any prior privileges (idempotent: REVOKE is no-op when absent).
REVOKE ALL ON SCHEMA public FROM denue_api;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM denue_api;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM denue_api;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM denue_api;

GRANT USAGE ON SCHEMA public TO denue_api;

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY[
    -- base tables
    'establecimientos',
    'ageb_polygons',
    'mun_polygons',
    'censo_iter',
    'inegi_edr_defunciones_raw',
    'calibrators_enigh_state',
    'calibrators_enoe_state',
    -- materialized views
    'ce2024_municipal',
    'clues',
    'cnbv_credito_by_estado',
    'cnbv_credito_by_municipio',
    'mv_delitos_municipal_yearly',
    'mv_mortalidad_municipal_yearly',
    'mv_national_treemap',
    'mv_sector_grade_matrix',
    'mv_sector_summary',
    'mv_sinba_morbidity_municipal',
    'sedatu_financing_by_estado',
    'sedatu_financing_by_municipio',
    'sesnsp_delitos_municipal',
    'sict_traffic_by_estado',
    'sict_traffic_by_municipio',
    -- views
    'aeropuertos_movements_yearly',
    'bienestar_estatal_latest',
    'censo_ageb',
    'censo_entidades',
    'censo_localidades',
    'censo_manzana',
    'censo_municipios',
    'cnbv_panorama_estatal',
    'cnbv_panorama_municipal',
    'cofepris_farmacias_by_ageb',
    'cofepris_farmacias_by_municipio',
    'coneval_grs_ageb',
    'coneval_irs_municipal',
    'coneval_pobreza_municipal',
    'sinba_morbidity_municipal'
  ]
  LOOP
    IF to_regclass(format('public.%I', r)) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON public.%I TO denue_api', r);
    ELSE
      RAISE NOTICE 'api-role: public.% does not exist yet; re-run after creating it', r;
    END IF;
  END LOOP;

  -- Sage thread store (src/api/sage/thread-store.ts).
  FOREACH r IN ARRAY ARRAY['sage_threads', 'sage_turns_audit']
  LOOP
    IF to_regclass(format('public.%I', r)) IS NOT NULL THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO denue_api', r);
    ELSE
      RAISE NOTICE 'api-role: public.% does not exist yet; re-run after scripts/sage-tables.sql', r;
    END IF;
  END LOOP;
END$$;

COMMIT;

-- Verification:
--   SELECT rolname, rolsuper, rolcanlogin FROM pg_roles WHERE rolname = 'denue_api';
--   SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--   WHERE n.nspname='public' AND has_table_privilege('denue_api', c.oid, 'SELECT')
--   ORDER BY relname;
