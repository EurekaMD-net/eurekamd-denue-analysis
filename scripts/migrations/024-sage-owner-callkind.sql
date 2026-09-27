-- 024: bind Sage threads to their owner and widen the audit call_kind
-- (audit #11 #28 #83 #207, package P24, 2026-09-27).
--
-- sage_threads.owner_sub: the JWT sub of the caller, or 'api-key' for the
-- shared X-Api-Key. The API reads, appends and deletes a thread only when
-- thread_id AND owner_sub match, and 404s otherwise. Existing rows keep a
-- NULL owner and become unreachable through the API (accepted: 5 of the 9
-- live rows are empty; the rest are pre-ownership demo threads).
--
-- sage_turns_audit.call_kind gains 'dispatch' and 'sql_gate', written for
-- turns whose endpoint dispatch or SQL gate failed.
--
-- Apply BEFORE restarting the API with the P24 code (the new code writes
-- owner_sub and the new call_kind values). Idempotent. Both tables are
-- tiny, so the ACCESS EXCLUSIVE locks are momentary.
--
-- Apply:
--   docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/migrations/024-sage-owner-callkind.sql
--
-- Verify:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'sage_threads' AND column_name = 'owner_sub';
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conname = 'sage_turns_audit_call_kind_check';

BEGIN;

ALTER TABLE public.sage_threads ADD COLUMN IF NOT EXISTS owner_sub text;

CREATE INDEX IF NOT EXISTS sage_threads_owner_idx
  ON public.sage_threads (owner_sub);

ALTER TABLE public.sage_turns_audit
  DROP CONSTRAINT IF EXISTS sage_turns_audit_call_kind_check;

ALTER TABLE public.sage_turns_audit
  ADD CONSTRAINT sage_turns_audit_call_kind_check
  CHECK (call_kind IN ('router', 'narrative', 'dispatch', 'sql_gate'));

COMMIT;
