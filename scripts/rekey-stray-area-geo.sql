-- Re-key establecimientos.area_geo (and entidad) for rows whose key is not a
-- real municipio, using the MG 2025 polygon that contains the establishment's
-- point.
--
-- Why: src/db/loader.ts (transform) sets area_geo from the source AreaGeo and
-- falls back to CLEE chars 1-5, and entidad from CLEE chars 1-2. INEGI's source
-- sometimes carries a bogus CLEE prefix (Irapuato as 01067, Acapulco de Juarez
-- as 50991, several NN999). DENUE 05/2026: 16 codes / 24 rows, each resolved
-- by ST_Contains to exactly one mun_polygons_2025 polygon whose nomgeo equals
-- the row's municipio (docs/EIC-2025-RECON-2026-09-28.md §3); 4 of them lie in
-- another entidad than their prefix says.
--
-- What it touches: ONLY establecimientos.area_geo and entidad, and only on
-- rows whose current area_geo is absent from municipios_2025.cve_mun. Never
-- municipio or raw_json. The new key is mun_polygons_2025.cvegeo (5 chars; its
-- cve_mun column is the 3-digit suffix); entidad becomes its first 2 chars, so
-- entidad-filtered handlers and the entidad-keyed matviews agree with the
-- point. A stray row with NULL geom, no containing polygon, or more than one
-- is left untouched and counted in the NOTICE: never guessed.
--
-- Why every refresh: the loader's upsert (PostgREST merge-duplicates on clee,
-- i.e. ON CONFLICT DO UPDATE SET every payload column; only ageb is left out)
-- rewrites area_geo and entidad from the source on each load, so the bogus
-- keys come back and this post-step re-fixes them. It needs geom, which the
-- geometry post-step sets, so it runs after ageb_backfill.
--
-- updated_at is untouched by design: trg_estab_updated_at (migration 014)
-- fires only when raw_json changes. Matviews keyed on area_geo pick the change
-- up at the next denue-matview-refresh.timer run (scripts/refresh-matviews.sh).
--
-- Shape: the stray keys come from DISTINCT area_geo (index-only on
-- idx_estab_area_geo) anti-joined to municipios_2025; the rows are then read
-- with area_geo = ANY(<stray keys>), index-driven. A full-table anti-join
-- times out on 6.1M rows. Explicit BEGIN/COMMIT, COMMIT only after the DO
-- assertion (psql --single-transaction commits a truncated stdin).
--
-- Idempotent: a second run finds 0 stray rows and exits 0. Runs as the
-- area_geo_rekey post-step of ops/denue-refresh.sh.
--
-- Apply:
--   docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/rekey-stray-area-geo.sql

BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '300s';
-- supabase-db has a 64 MB /dev/shm: no parallel workers (AGENT_LEARNINGS 09-28).
SET LOCAL max_parallel_workers_per_gather = 0;

CREATE TEMP TABLE stray_keys ON COMMIT DROP AS
WITH keys AS (
  SELECT DISTINCT area_geo FROM establecimientos WHERE area_geo IS NOT NULL
)
SELECT k.area_geo
  FROM keys k
 WHERE NOT EXISTS (SELECT 1 FROM municipios_2025 m WHERE m.cve_mun = k.area_geo);

CREATE TEMP TABLE stray_rows ON COMMIT DROP AS
SELECT e.id, e.area_geo AS old_area_geo, e.entidad AS old_entidad, e.geom
  FROM establecimientos e
 WHERE e.area_geo = ANY (ARRAY(SELECT area_geo FROM stray_keys));

-- Resolvable = geom present and exactly one containing polygon.
CREATE TEMP TABLE stray ON COMMIT DROP AS
SELECT r.id, r.old_area_geo, r.old_entidad, min(p.cvegeo)::text AS new_area_geo
  FROM stray_rows r
  JOIN mun_polygons_2025 p ON ST_Contains(p.geom, r.geom)
 WHERE r.geom IS NOT NULL
 GROUP BY r.id, r.old_area_geo, r.old_entidad
HAVING count(*) = 1;

DO $$
DECLARE
  n_rows    int;
  n_keys    int;
  n_stray   int;
BEGIN
  SELECT count(*) INTO n_rows FROM stray_rows;
  SELECT count(*) INTO n_keys FROM stray_keys;
  SELECT count(*) INTO n_stray FROM stray;
  RAISE NOTICE 'rekey-stray-area-geo: % stray rows over % keys; % resolvable, % unresolved (left untouched)',
    n_rows, n_keys, n_stray, n_rows - n_stray;
END$$;

SELECT old_area_geo, new_area_geo, count(*),
       count(*) FILTER (WHERE old_entidad IS DISTINCT FROM left(new_area_geo, 2)) AS entidad_changes
  FROM stray
 GROUP BY 1, 2
 ORDER BY 1, 2;

UPDATE establecimientos e
   SET area_geo = s.new_area_geo,
       entidad = left(s.new_area_geo, 2)
  FROM stray s
 WHERE e.id = s.id
   AND (e.area_geo IS DISTINCT FROM s.new_area_geo
        OR e.entidad IS DISTINCT FROM left(s.new_area_geo, 2));

DO $$
DECLARE
  n_stray    int;
  n_rekeyed  int;
  n_invalid  int;
  n_ent_bad  int;
BEGIN
  SELECT count(*) INTO n_stray FROM stray;
  SELECT count(*) INTO n_rekeyed
    FROM stray s JOIN establecimientos e ON e.id = s.id
   WHERE e.area_geo = s.new_area_geo
     AND e.area_geo IS DISTINCT FROM s.old_area_geo;
  SELECT count(*) INTO n_invalid
    FROM stray s JOIN establecimientos e ON e.id = s.id
   WHERE NOT EXISTS (SELECT 1 FROM municipios_2025 m WHERE m.cve_mun = e.area_geo);
  SELECT count(*) INTO n_ent_bad
    FROM stray s JOIN establecimientos e ON e.id = s.id
   WHERE e.entidad IS DISTINCT FROM left(e.area_geo, 2);
  IF n_rekeyed <> n_stray OR n_invalid <> 0 OR n_ent_bad <> 0 THEN
    RAISE EXCEPTION
      'rekey-stray-area-geo: check failed: rekeyed=% (want %) still_invalid=% (want 0) entidad_mismatch=% (want 0)',
      n_rekeyed, n_stray, n_invalid, n_ent_bad;
  END IF;
  RAISE NOTICE 'rekey-stray-area-geo: % rows re-keyed', n_rekeyed;
END$$;

COMMIT;
