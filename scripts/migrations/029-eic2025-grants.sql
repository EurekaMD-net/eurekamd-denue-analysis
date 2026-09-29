-- 029: grants of the EIC 2025 municipal relations (step 2 of the municipio
-- bridge ruling, docs/EIC-2025-LOADER-BRIEF-2026-09-28.md): the raw table
-- eic_2025_municipio_raw and the views eic_2025_municipio,
-- eic_2025_municipio_moe and eic_2025_municipio_censo_parity.
--
-- The relations are created by scripts/load-eic2025.ts, which strips the
-- Supabase default ACL and restores the denue_sage SELECT in its load
-- transaction (postLoadGrants + scripts/sage-role.sql). denue_api's SELECT
-- comes from scripts/api-role.sql. This file re-applies the same end state
-- in one idempotent step for a grants audit (002-grants-lockdown style):
--
--   * anon / authenticated / trustr_app: nothing;
--   * denue_sage: SELECT (published INEGI statistics, raw table included);
--   * denue_api: SELECT.
--
-- Relations not loaded yet are skipped (to_regclass guard). The denue_api and
-- denue_sage roles must exist (scripts/api-role.sql, scripts/sage-role.sql).
-- Apply as the operator:
--
--   docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/migrations/029-eic2025-grants.sql

\set ON_ERROR_STOP on

BEGIN;

-- eic_2025_municipio_raw
DO $$
BEGIN
  IF to_regclass('public.eic_2025_municipio_raw') IS NOT NULL THEN
    REVOKE ALL ON public.eic_2025_municipio_raw FROM anon, authenticated, trustr_app;
    GRANT SELECT ON public.eic_2025_municipio_raw TO denue_sage;
    GRANT SELECT ON public.eic_2025_municipio_raw TO denue_api;
  END IF;
END $$;

-- eic_2025_municipio
DO $$
BEGIN
  IF to_regclass('public.eic_2025_municipio') IS NOT NULL THEN
    REVOKE ALL ON public.eic_2025_municipio FROM anon, authenticated, trustr_app;
    GRANT SELECT ON public.eic_2025_municipio TO denue_sage;
    GRANT SELECT ON public.eic_2025_municipio TO denue_api;
  END IF;
END $$;

-- eic_2025_municipio_moe
DO $$
BEGIN
  IF to_regclass('public.eic_2025_municipio_moe') IS NOT NULL THEN
    REVOKE ALL ON public.eic_2025_municipio_moe FROM anon, authenticated, trustr_app;
    GRANT SELECT ON public.eic_2025_municipio_moe TO denue_sage;
    GRANT SELECT ON public.eic_2025_municipio_moe TO denue_api;
  END IF;
END $$;

-- eic_2025_municipio_censo_parity
DO $$
BEGIN
  IF to_regclass('public.eic_2025_municipio_censo_parity') IS NOT NULL THEN
    REVOKE ALL ON public.eic_2025_municipio_censo_parity FROM anon, authenticated, trustr_app;
    GRANT SELECT ON public.eic_2025_municipio_censo_parity TO denue_sage;
    GRANT SELECT ON public.eic_2025_municipio_censo_parity TO denue_api;
  END IF;
END $$;

COMMIT;
