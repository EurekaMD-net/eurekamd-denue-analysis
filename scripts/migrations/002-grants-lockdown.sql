-- 002-grants-lockdown.sql — audit #111 #112 #113 (2026-09-26)
--
-- PostgREST (db.mycommit.net) serves schema public as role anon, and the anon
-- JWT ships in the public SPA bundle. Supabase's default ACLs left the DENUE
-- relations open to it:
--   * #111 the ogr2ogr-loaded polygon tables (owner supabase_admin) granted
--     anon/authenticated arwdDxt with RLS off: any visitor could rewrite or
--     delete the AGEB/municipio geometry every AGEB-level analytic rests on.
--   * #112 anon/authenticated could SELECT establecimientos (16 GB) and
--     mv_coverage, and no role had a statement_timeout, so one crafted
--     ILIKE ran unbounded on the shared instance.
--   * #113 postgres' default ACL granted trustr_app (another app's
--     internet-facing role) arwdDxt on every DENUE relation.
--
-- Nothing in DENUE needs those grants: the API reads through docker exec
-- psql or the service_role key, and the SPA uses Supabase only for auth.
--
-- Scope, on purpose:
--   * An explicit DENUE relation list, never ALL TABLES IN SCHEMA public:
--     other apps (mission-control, trustr, GoTrue) keep their tables there.
--   * Relations missing on this instance are skipped (to_regclass guard), so
--     the file applies on a partial load too.
--   * postgres' default ACL for trustr_app is left as is; the loaders' post-load
--     REVOKE (scripts/_psql-tx.ts postLoadGrants) strips it again on reload.
--   * public.schema_migrations (GoTrue) and jarvis_kb_backup (mission-control)
--     carry the same anon exposure but are not DENUE's; left to their owners.
--   * The statement timeouts are Supabase's stock values but apply to every
--     app on this shared instance.
--
-- Idempotent. Apply as the operator:
--
--   docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/migrations/002-grants-lockdown.sql

BEGIN;

-- #111: take the polygon tables away from supabase_admin's default ACL.
ALTER TABLE ageb_polygons OWNER TO postgres;
ALTER TABLE mun_polygons OWNER TO postgres;
ALTER TABLE ent_polygons OWNER TO postgres;
ALTER TABLE loc_polygons OWNER TO postgres;

-- #111 #112 #113: no anon / authenticated / trustr_app rights on DENUE relations.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY[
    'ageb_polygons', 'mun_polygons', 'ent_polygons', 'loc_polygons',
    'establecimientos', 'establecimientos_geo',
    'mv_coverage', 'mv_sector_summary', 'mv_estrato_por_entidad',
    'mv_national_treemap', 'mv_sector_grade_matrix',
    'mv_delitos_municipal_yearly', 'mv_mortalidad_municipal_yearly',
    'aeropuertos_by_municipio', 'aeropuertos_cvemun_lookup',
    'aeropuertos_movements_raw', 'aeropuertos_movements_yearly',
    'bienestar_estatal_latest', 'bienestar_estatal_trimestral',
    'bienestar_padron_estatal_trimestral_raw',
    'calibrators_enigh_state', 'calibrators_enoe_state',
    'ce2024_municipal', 'ce2024_raw',
    'censo_ageb', 'censo_ageb_raw', 'censo_entidades', 'censo_iter',
    'censo_localidades', 'censo_manzana', 'censo_municipios',
    'clues', 'clues_raw',
    'cnbv_credito_2025', 'cnbv_credito_by_estado', 'cnbv_credito_by_municipio',
    'cnbv_credito_estado_grain_2025', 'cnbv_credito_raw_2025',
    'cnbv_intermediarios', 'cnbv_modalidades', 'cnbv_vivienda_tiers',
    'cnbv_panorama_estatal', 'cnbv_panorama_estatal_raw',
    'cnbv_panorama_municipal', 'cnbv_panorama_municipal_raw',
    'cofepris_farmacias', 'cofepris_farmacias_by_ageb',
    'cofepris_farmacias_by_municipio',
    'coneval_grs_ageb', 'coneval_grs_ageb_raw',
    'coneval_irs_municipal', 'coneval_irs_municipal_raw',
    'coneval_pobreza_municipal', 'coneval_pobreza_municipal_raw',
    'enigh_concentradohogar_raw', 'enoe_sdem_raw',
    'inegi_edr_defunciones_raw',
    'osm_ageb_aggregates',
    'sage_threads', 'sage_turns_audit',
    'sedatu_destinos', 'sedatu_modalidades', 'sedatu_organismos',
    'sedatu_vivienda_tiers',
    'sedatu_financiamientos_2025', 'sedatu_financiamientos_estado_grain_2025',
    'sedatu_financiamientos_raw_2025',
    'sedatu_financing_by_estado', 'sedatu_financing_by_municipio',
    'sesnsp_delitos_municipal', 'sesnsp_delitos_municipal_raw',
    'sict_estaciones_viales', 'sict_estaciones_viales_raw_2024',
    'sict_traffic_by_estado', 'sict_traffic_by_municipio',
    'sinba_ec_raw', 'sinba_morbidity_municipal'
  ] LOOP
    IF to_regclass(format('public.%I', r)) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated, trustr_app', r);
    END IF;
  END LOOP;
END
$$;

-- #112: bound every PostgREST role (Supabase stock values).
ALTER ROLE anon SET statement_timeout = '3s';
ALTER ROLE authenticated SET statement_timeout = '8s';
ALTER ROLE service_role SET statement_timeout = '30s';

COMMIT;

NOTIFY pgrst, 'reload config';
