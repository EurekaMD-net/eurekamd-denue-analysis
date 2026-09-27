-- 014-estab-updated-at-trigger.sql — audit #127 (2026-09-26)
--
-- trg_estab_updated_at stamped NOW() on every UPDATE, so each maintenance
-- backfill (geom, area_geo, ageb, SCIAN/municipio) moved updated_at: every row
-- carried the same 2026-05-04 14:58 value and mv_coverage.last_updated_at said
-- nothing about DENUE freshness. It now fires only when the DENUE source
-- record changes (raw_json), i.e. on a re-load that brought new data.
--
-- Apply BEFORE 014-estab-scian-municipio-backfill.sql (the backfill refuses
-- to run until this trigger is in place). Idempotent.
--
--   docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/migrations/014-estab-updated-at-trigger.sql

BEGIN;

DROP TRIGGER IF EXISTS trg_estab_updated_at ON establecimientos;
CREATE TRIGGER trg_estab_updated_at
  BEFORE UPDATE ON establecimientos
  FOR EACH ROW
  WHEN (OLD.raw_json IS DISTINCT FROM NEW.raw_json)
  EXECUTE FUNCTION update_updated_at();

COMMIT;
