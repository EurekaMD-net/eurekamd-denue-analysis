-- 020-indexes.sql — index hygiene, audit #120 #121 #123 #125 #135 #141
-- (package P20, 2026-09-27).
--
--   #120       UNIQUE (cvegeo) on ageb/mun/loc/ent_polygons. ageb-detail
--              (`WHERE cvegeo = X`) seq-scanned 14,683 pages of
--              ageb_polygons, and an ogr2ogr -append reload could duplicate
--              AGEBs. Live data was duplicate-free when this was written
--              (ageb 81,451 / mun 2,469 / loc 50,308 / ent 32, all distinct,
--              no NULL); the guard below re-checks before building.
--   #121/#135  idx_estab_ent_mun_cov (entidad, area_geo) INCLUDE
--              (clase_actividad_id, sector_actividad_id): municipios,
--              locust-muni and top-sectors become index-only scans instead
--              of reading ~124k heap pages for entidad 15. It replaces
--              idx_estab_entidad, a redundant prefix of it.
--   #123       partial index for the CE 2024 per-entidad rollup lookup
--              (`WHERE sector IS NULL AND id_estrato IS NULL AND cve_ent = X`).
--              scripts/load-ce2024.ts creates the same index on every rebuild.
--   #125/#141  drops duplicate / prefix-redundant / unused indexes:
--              idx_mv_dmy_cve_mun_ano, idx_mv_mmy_cve_mun_ano (exact
--              duplicates of the UNIQUE (cve_mun, ano) indexes),
--              idx_mv_dmy_cve_mun, idx_mv_mmy_cve_mun, idx_mv_sgm_scian
--              (left prefixes of a unique index), idx_censo_ageb_raw_cvegeo
--              (identical to idx_censo_ageb_raw_cvegeo_ageb_only, 0 scans),
--              idx_estab_nombre (GIN full-text over nombre, ~150 MB, 0 scans:
--              /search uses ILIKE; 009-trgm-index.sql adds the index it uses).
--              perf-matviews.sql, load-censo-ageb.ts and src/db/schema.sql no
--              longer create them.
--
-- CREATE/DROP INDEX CONCURRENTLY and VACUUM cannot run inside a transaction:
-- apply WITHOUT --single-transaction (each statement autocommits). Run it
-- after the establecimientos compaction (P17), off-hours: the covering index
-- and the VACUUM each read the whole establecimientos heap. Idempotent.
--
--   docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/migrations/020-indexes.sql
--
-- If a run is interrupted mid-build, a CONCURRENTLY index can be left INVALID
-- and IF NOT EXISTS would then skip it; the validity guard below stops the
-- script before any DROP. Recover with DROP INDEX CONCURRENTLY <name> and
-- re-run.
--
-- Verify (expect Index Only Scan using idx_estab_ent_mun_cov, Heap Fetches ~0):
--   EXPLAIN (ANALYZE, BUFFERS) SELECT sector_actividad_id, count(*)
--   FROM establecimientos WHERE entidad = '15' GROUP BY 1;

\set ON_ERROR_STOP on
SET statement_timeout = 0;

-- #120: refuse to build a UNIQUE index over duplicated or NULL keys (the
-- CONCURRENTLY build would fail halfway and leave an INVALID index behind).
DO $$
DECLARE
  t text;
  dup bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY['ageb_polygons', 'mun_polygons', 'loc_polygons', 'ent_polygons'] LOOP
    EXECUTE format(
      'SELECT count(*) - count(DISTINCT cvegeo) + count(*) FILTER (WHERE cvegeo IS NULL) FROM public.%I',
      t
    ) INTO dup;
    IF dup > 0 THEN
      RAISE EXCEPTION '%: % duplicate or NULL cvegeo rows; dedupe before applying 020', t, dup;
    END IF;
  END LOOP;
END $$;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ageb_polygons_cvegeo_uq
  ON public.ageb_polygons (cvegeo);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS mun_polygons_cvegeo_uq
  ON public.mun_polygons (cvegeo);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS loc_polygons_cvegeo_uq
  ON public.loc_polygons (cvegeo);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ent_polygons_cvegeo_uq
  ON public.ent_polygons (cvegeo);

-- #121/#135
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_estab_ent_mun_cov
  ON public.establecimientos (entidad, area_geo)
  INCLUDE (clase_actividad_id, sector_actividad_id);

-- #123
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ce2024_mun_ent_rollup
  ON public.ce2024_municipal (cve_ent)
  WHERE sector IS NULL AND id_estrato IS NULL;

-- Every index built above must exist and be VALID before anything is dropped
-- (idx_estab_entidad in particular is only redundant once its replacement
-- is usable). idx_estab_nombre_trgm is built by 009-trgm-index.sql, not
-- here: idx_estab_nombre is dropped below only once /search has it.
DO $$
DECLARE
  i text;
BEGIN
  FOREACH i IN ARRAY ARRAY['ageb_polygons_cvegeo_uq', 'mun_polygons_cvegeo_uq',
                           'loc_polygons_cvegeo_uq', 'ent_polygons_cvegeo_uq',
                           'idx_estab_ent_mun_cov', 'idx_ce2024_mun_ent_rollup'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_index x
       WHERE x.indexrelid = to_regclass('public.' || i)
         AND x.indisvalid
    ) THEN
      RAISE EXCEPTION 'index % is missing or INVALID: DROP INDEX CONCURRENTLY it and re-run 020', i;
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index x
     WHERE x.indexrelid = to_regclass('public.idx_estab_nombre_trgm')
       AND x.indisvalid
  ) THEN
    RAISE EXCEPTION 'index idx_estab_nombre_trgm is missing or INVALID: apply 009-trgm-index.sql (DROP INDEX CONCURRENTLY an INVALID one first), then re-run 020';
  END IF;
END $$;

-- #121/#135: prefix of idx_estab_ent_mun_cov.
DROP INDEX CONCURRENTLY IF EXISTS public.idx_estab_entidad;

-- #125/#141 (DROP INDEX CONCURRENTLY takes one index per statement).
DROP INDEX CONCURRENTLY IF EXISTS public.idx_mv_dmy_cve_mun_ano;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_mv_mmy_cve_mun_ano;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_mv_dmy_cve_mun;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_mv_mmy_cve_mun;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_mv_sgm_scian;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_censo_ageb_raw_cvegeo;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_estab_nombre;

-- Set the visibility map so idx_estab_ent_mun_cov scans skip the heap.
VACUUM (ANALYZE) public.establecimientos;
