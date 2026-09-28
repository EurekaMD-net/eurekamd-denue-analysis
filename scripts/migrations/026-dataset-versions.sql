-- 026: dataset_versions ledger, one row per (dataset, edition) loaded
-- (data-freshness recon 2026-09-27, docs/DATA-FRESHNESS-2026-09-27.md §2).
--
-- DENUE rows carry no edition (the API returns an empty fecha_alta) and the
-- other loaders record none either, so "which edition is loaded" lived only
-- in docs and data/state json. This table is the record; loaders do not
-- write it yet: after a load the operator runs
--   npx tsx scripts/record-dataset-version.ts --dataset=<d> --edition=<e> --rows=<n> --apply
--
-- Seed: the editions docs/DATA-FRESHNESS-2026-09-27.md §1 lists as loaded,
-- in that table's own wording. Aeropuertos (March-only semantics pending)
-- and EIC 2025 (not loaded) are left out. Only denue and osm_ageb_aggregates
-- have a known load date; every other seed row's loaded_at is the time this
-- migration ran, and its note says so.
--
-- Grants: Sage can answer "which edition is loaded" (denue_sage SELECT, also
-- in scripts/sage-role.sql). No API handler reads it, so denue_api gets
-- nothing (scripts/api-role.sql grants only what handlers read). anon,
-- authenticated and trustr_app lose the Supabase default ACL, as in
-- 002-grants-lockdown.
--
-- Idempotent (IF NOT EXISTS, ON CONFLICT DO NOTHING). New table: no lock on
-- anything live.
--
-- Apply:
--   docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/migrations/026-dataset-versions.sql
--
-- Verify:
--   SELECT dataset, edition, row_count, loaded_at FROM dataset_versions ORDER BY dataset;
--   SELECT relacl FROM pg_class WHERE relname = 'dataset_versions';

BEGIN;

CREATE TABLE IF NOT EXISTS public.dataset_versions (
  id         bigserial PRIMARY KEY,
  dataset    text NOT NULL CHECK (dataset ~ '^[a-z][a-z0-9_]*$'),
  edition    text NOT NULL,
  source     text,
  row_count  bigint,
  loaded_at  timestamptz NOT NULL DEFAULT now(),
  note       text
);

CREATE UNIQUE INDEX IF NOT EXISTS dataset_versions_dataset_edition_uq
  ON public.dataset_versions (dataset, edition);

ALTER TABLE public.dataset_versions OWNER TO postgres;
REVOKE ALL ON public.dataset_versions FROM anon, authenticated, trustr_app;
REVOKE ALL ON SEQUENCE public.dataset_versions_id_seq FROM anon, authenticated, trustr_app;
GRANT SELECT ON public.dataset_versions TO denue_sage;

INSERT INTO public.dataset_versions (dataset, edition, source, row_count, loaded_at, note) VALUES
  ('denue', '05/2026', 'INEGI DENUE API', 6138075, '2026-09-27 19:59+00',
   'stale cleanup 2026-09-28: 1,146,694 re-keyed/departed CLEE rows removed, count = extraction'),
  ('osm_ageb_aggregates', 'May 24 Geofabrik extract', 'Geofabrik mexico-latest.osm.pbf', 81451, '2026-09-28',
   'reloaded from the local May 24 extract (--reuse-export)')
ON CONFLICT (dataset, edition) DO NOTHING;

INSERT INTO public.dataset_versions (dataset, edition, source, row_count, note) VALUES
  ('clues', '2026-04', 'DGIS CLUES', 63708,
   'clues_raw; movements to 2026-04-21. loaded_at = ledger seed time, load date not recorded'),
  ('sesnsp_incidencia', 'through 2026-03', 'SESNSP incidencia delictiva', NULL,
   'loaded_at = ledger seed time, load date not recorded'),
  ('cofepris_farmacias', 'PDF 1020177', 'COFEPRIS', NULL,
   'licences to 2025-07. loaded_at = ledger seed time, load date not recorded'),
  ('sedatu_financiamientos', '2025', 'SEDATU SNIIV', NULL,
   '2025 full year. loaded_at = ledger seed time, load date not recorded'),
  ('cnbv_credito_vivienda', '2025', 'CNBV via SNIIV', NULL,
   '2025 full year. loaded_at = ledger seed time, load date not recorded'),
  ('marco_geoestadistico', 'MG 2020', 'INEGI Marco Geoestadístico', NULL,
   'loaded_at = ledger seed time, load date not recorded'),
  ('edr_defunciones', '2024 definitive', 'INEGI EDR', NULL,
   'loaded_at = ledger seed time, load date not recorded'),
  ('enoe', '2025 Q1–Q4', 'INEGI ENOE', NULL,
   'loaded_at = ledger seed time, load date not recorded'),
  ('cnbv_panorama', '2025 edition', 'CNBV Panorama', NULL,
   'data 2024. loaded_at = ledger seed time, load date not recorded'),
  ('coneval_pobreza_municipal', '2020', 'CONEVAL', NULL,
   'loaded_at = ledger seed time, load date not recorded'),
  ('coneval_irs_municipal', '2020', 'CONEVAL', NULL,
   'loaded_at = ledger seed time, load date not recorded'),
  ('ce2024', 'definitive (2025-07-24)', 'INEGI Censos Económicos 2024', NULL,
   'loaded_at = ledger seed time, load date not recorded'),
  ('censo_2020', 'CPV 2020', 'INEGI Censo 2020 ITER + AGEB', NULL,
   'loaded_at = ledger seed time, load date not recorded'),
  ('enigh', '2024', 'INEGI ENIGH', NULL,
   'loaded_at = ledger seed time, load date not recorded'),
  ('sinba_ec', '2023', 'SINBA DA_EC_SIS_2023', NULL,
   'loaded_at = ledger seed time, load date not recorded'),
  ('bienestar_padron', '2019Q1–2024Q3', 'Bienestar padrón', NULL,
   'loaded_at = ledger seed time, load date not recorded'),
  ('sict_datos_viales', '2024 TDPA', 'SICT datos viales', NULL,
   'loaded_at = ledger seed time, load date not recorded'),
  ('coneval_grs_ageb', '2020', 'CONEVAL GRS por AGEB', NULL,
   'loaded_at = ledger seed time, load date not recorded')
ON CONFLICT (dataset, edition) DO NOTHING;

COMMIT;
