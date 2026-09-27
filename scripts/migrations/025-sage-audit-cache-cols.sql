-- 025: record prompt-cache usage per Sage LLM call (audit #204, package
-- P25, 2026-09-27).
--
-- sage_turns_audit.input_tokens stays the total input (base + cache write
-- + cache read). The two new columns hold the cache parts of it, so the
-- router's cache hit rate is measurable now that the static endpoint
-- catalog and SQL schema sit in the cacheable system prompt.
--
-- Apply BEFORE restarting the API with the P25 code (the new code writes
-- both columns). Idempotent. ADD COLUMN with a constant default is a
-- metadata-only change; the ACCESS EXCLUSIVE lock is momentary.
--
-- Apply:
--   docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/migrations/025-sage-audit-cache-cols.sql
--
-- Verify:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'sage_turns_audit'
--      AND column_name IN ('cache_read_input_tokens', 'cache_creation_input_tokens');

BEGIN;

ALTER TABLE public.sage_turns_audit
  ADD COLUMN IF NOT EXISTS cache_read_input_tokens integer NOT NULL DEFAULT 0;

ALTER TABLE public.sage_turns_audit
  ADD COLUMN IF NOT EXISTS cache_creation_input_tokens integer NOT NULL DEFAULT 0;

COMMIT;
