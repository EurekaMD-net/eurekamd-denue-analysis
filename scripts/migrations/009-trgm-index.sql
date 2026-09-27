-- 009: trigram index for /search `nombre ILIKE '%q%'` (audit #36/#96,
-- package P09, 2026-09-26).
--
-- The only nombre index (idx_estab_nombre) is a GIN over
-- to_tsvector('spanish', nombre), which cannot serve a leading-wildcard
-- ILIKE. Without this index a rare or misspelled term walks the clee index
-- over all ~6.1M rows (> 20 s). The API now also requires q >= 3 chars,
-- the minimum for a trigram lookup.
--
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction, so there is no
-- BEGIN/COMMIT. Expect several minutes of IO on the 13 GB heap: run it
-- off-hours. Idempotent.
--
-- Apply:
--   docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/migrations/009-trgm-index.sql
--
-- Verify (expect Bitmap Index Scan on idx_estab_nombre_trgm, under 1 s):
--   EXPLAIN (ANALYZE, BUFFERS) SELECT clee FROM establecimientos
--   WHERE nombre ILIKE '%xyzzyqq%' ORDER BY clee LIMIT 50;
--
-- If a previous run was interrupted, the index may exist but be INVALID
-- (pg_index.indisvalid = false); IF NOT EXISTS would then skip it. Check
-- first and DROP INDEX CONCURRENTLY idx_estab_nombre_trgm before re-running.

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_estab_nombre_trgm
  ON public.establecimientos USING gin (nombre extensions.gin_trgm_ops);
