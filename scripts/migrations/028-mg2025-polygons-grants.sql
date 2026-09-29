-- 028: grants, revokes and comments of the MG 2025 polygon tables
-- (mun_polygons_2025, ageb_polygons_2025), step 3 of the municipio bridge
-- ruling (docs/MG-2025-LOAD-BRIEF-2026-09-28.md).
--
-- The tables themselves are created by scripts/load-mg2025-polygons.ts,
-- which is the source of truth: it applies these exact statements inside its
-- load transaction. This file only lets a grants audit (002-grants-lockdown
-- style) re-apply them. scripts/load-mg2025-polygons.test.ts fails when the
-- two drift: change the loader's grantAndCommentStatements() first, then
-- paste its output here.
--
--   * owner postgres; anon / authenticated / trustr_app lose the Supabase
--     default ACL on the table AND its ogc_fid sequence;
--   * denue_sage gets nothing (Sage never reads polygons; sage-role.sql,
--     src/api/sage/sql-gate.ts FORBIDDEN_RELATIONS);
--   * denue_api gets SELECT (src/osm/osmium.ts reads mun_polygons_2025;
--     scripts/api-role.sql allowlist).
--
-- Tables not loaded yet are skipped (to_regclass guard). The denue_api and
-- denue_sage roles must exist (scripts/api-role.sql, scripts/sage-role.sql).
-- Idempotent. Apply as the operator:
--
--   docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/migrations/028-mg2025-polygons-grants.sql

\set ON_ERROR_STOP on

BEGIN;

-- mun_polygons_2025
DO $$
BEGIN
  IF to_regclass('public.mun_polygons_2025') IS NOT NULL THEN
    ALTER TABLE public.mun_polygons_2025 OWNER TO postgres;
    REVOKE ALL ON public.mun_polygons_2025 FROM anon, authenticated, trustr_app;
    REVOKE ALL ON SEQUENCE public.mun_polygons_2025_ogc_fid_seq FROM anon, authenticated, trustr_app;
    REVOKE ALL ON public.mun_polygons_2025 FROM denue_sage;
    GRANT SELECT ON public.mun_polygons_2025 TO denue_api;
    COMMENT ON TABLE public.mun_polygons_2025 IS 'INEGI Marco Geoestadístico 2025 (MG 2025, UPC 794551163061, cartographic cut July 2025), layer 00mun (areas geoestadisticas municipales). Source 794551163061_s.zip sha256 e87c83c6613026dceaff44c1ac0e949926f6cf055b4522fa16cfa5bb1a594303. Reprojected from MEXICO_ITRF_2008_LCC to EPSG:4326 by ogr2ogr; invalid geometries repaired with ST_MakeValid. Loaded by scripts/load-mg2025-polygons.ts alongside MG 2020 (mun_polygons), which stays the Censo 2020 edition.';
  END IF;
END $$;

-- ageb_polygons_2025
DO $$
BEGIN
  IF to_regclass('public.ageb_polygons_2025') IS NOT NULL THEN
    ALTER TABLE public.ageb_polygons_2025 OWNER TO postgres;
    REVOKE ALL ON public.ageb_polygons_2025 FROM anon, authenticated, trustr_app;
    REVOKE ALL ON SEQUENCE public.ageb_polygons_2025_ogc_fid_seq FROM anon, authenticated, trustr_app;
    REVOKE ALL ON public.ageb_polygons_2025 FROM denue_sage;
    GRANT SELECT ON public.ageb_polygons_2025 TO denue_api;
    COMMENT ON TABLE public.ageb_polygons_2025 IS 'INEGI Marco Geoestadístico 2025 (MG 2025, UPC 794551163061, cartographic cut July 2025), layer 00a (AGEB urbanas 13-char + rurales 9-char). Source 794551163061_s.zip sha256 e87c83c6613026dceaff44c1ac0e949926f6cf055b4522fa16cfa5bb1a594303. Reprojected from MEXICO_ITRF_2008_LCC to EPSG:4326 by ogr2ogr; invalid geometries repaired with ST_MakeValid. Loaded by scripts/load-mg2025-polygons.ts alongside MG 2020 (ageb_polygons), which stays the Censo 2020 edition.';
  END IF;
END $$;

COMMIT;
