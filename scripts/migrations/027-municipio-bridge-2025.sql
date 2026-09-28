-- 027: municipio key bridge 2020 -> 2025 and the canonical 2,478-key
-- municipio universe (docs/EIC-2025-RECON-2026-09-28.md §2-§5, ruling (b)
-- staged, step 1). The EIC 2025 loader and MG 2025 polygons come later.
--
-- DENUE 05/2026 (4,950 rows), CLUES, SESNSP and CE 2024 already use 9
-- municipio keys that Censo 2020 lacks. This migration creates:
--   * municipio_bridge_2025: 11 (2025 child, 2020 parent) pairs for the 9
--     new municipios (02007 and 25020 have two parents each).
--   * municipios_2025: censo_municipios' 2,469 rows + the 9 children, with
--     is_new_2025 and parent_cve_mun_2020 (text[]). The children's census
--     columns are NULL, not inherited from their parents.
-- /analytics/locust-muni and /analytics/municipio-detail drive from
-- municipios_2025, /analytics/municipios joins it for nom_mun / pobtot.
--
-- The section between the >>> / <<< markers is a verbatim copy of the
-- canonical one in scripts/migrate-censo-views.sql (load-censo.ts re-runs
-- that file on every Censo reload; psql fed over stdin cannot \i it).
-- 027-municipio-bridge-2025.test.ts fails when the two drift: edit
-- migrate-censo-views.sql first, then paste here.
--
-- Grants: SELECT to denue_sage (also in scripts/sage-role.sql) and denue_api
-- (also in scripts/api-role.sql; guarded so the migration applies before
-- that role exists). anon, authenticated and trustr_app lose the Supabase
-- default ACL, as in 002-grants-lockdown.
--
-- The DO block at the end aborts the whole transaction unless the bridge
-- holds exactly 11 pairs over 9 children, every parent exists in
-- censo_municipios under the same name, no child already does, and the view
-- has exactly 2,478 rows on 2,478 distinct keys.
--
-- Idempotent (IF NOT EXISTS, upsert, CREATE OR REPLACE). New relations
-- only: no lock on anything live beyond the catalog.
--
-- Apply:
--   docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/migrations/027-municipio-bridge-2025.sql
--
-- Verify:
--   SELECT count(*), count(DISTINCT cve_mun), count(*) FILTER (WHERE is_new_2025) FROM municipios_2025;
--   SELECT cve_mun, nom_mun, nom_ent, parent_cve_mun_2020, pobtot FROM municipios_2025 WHERE is_new_2025 ORDER BY 1;
--   SELECT relname, relacl FROM pg_class WHERE relname IN ('municipio_bridge_2025', 'municipios_2025');

BEGIN;

-- >>> municipios_2025 section
-- NOTE: the seed below is upsert-only; re-parenting a child later needs an explicit DELETE of the old pair.
CREATE TABLE IF NOT EXISTS municipio_bridge_2025 (
  cve_mun_2025        TEXT NOT NULL CHECK (cve_mun_2025 ~ '^[0-9]{5}$'),
  nom_mun_2025        TEXT NOT NULL,
  cve_mun_2020_parent TEXT NOT NULL CHECK (cve_mun_2020_parent ~ '^[0-9]{5}$'),
  nom_mun_2020_parent TEXT NOT NULL,
  decreto             DATE,
  PRIMARY KEY (cve_mun_2025, cve_mun_2020_parent),
  CHECK (cve_mun_2025 <> cve_mun_2020_parent),
  CHECK (left(cve_mun_2025, 2) = left(cve_mun_2020_parent, 2))
);

INSERT INTO municipio_bridge_2025
  (cve_mun_2025, nom_mun_2025, cve_mun_2020_parent, nom_mun_2020_parent, decreto)
VALUES
  ('02007', 'San Felipe',            '02001', 'Ensenada',             '2021-07-01'),
  ('02007', 'San Felipe',            '02002', 'Mexicali',             '2021-07-01'),
  ('04013', 'Dzitbalché',            '04001', 'Calkiní',              '2019-04-26'),
  ('12082', 'Las Vigas',             '12053', 'San Marcos',           '2021-09-28'),
  ('12083', 'Ñuu Savi',              '12012', 'Ayutla de los Libres', '2021-09-28'),
  ('12084', 'Santa Cruz del Rincón', '12041', 'Malinaltepec',         '2021-09-28'),
  ('12085', 'San Nicolás',           '12023', 'Cuajinicuilapa',       '2021-09-28'),
  ('24059', 'Villa de Pozos',        '24028', 'San Luis Potosí',      '2024-07-22'),
  ('25019', 'Eldorado',              '25006', 'Culiacán',             '2021-03-22'),
  ('25020', 'Juan José Ríos',        '25011', 'Guasave',              '2023-04-28'),
  ('25020', 'Juan José Ríos',        '25001', 'Ahome',                '2023-04-28')
ON CONFLICT (cve_mun_2025, cve_mun_2020_parent) DO UPDATE SET
  nom_mun_2025        = EXCLUDED.nom_mun_2025,
  nom_mun_2020_parent = EXCLUDED.nom_mun_2020_parent,
  decreto             = EXCLUDED.decreto;

CREATE OR REPLACE VIEW municipios_2025 AS
SELECT
  cve_mun, entidad, mun, nom_mun, nom_ent,
  false AS is_new_2025,
  '{}'::text[] AS parent_cve_mun_2020,
  pobtot, pobfem, pobmas, p_60ymas, p_15ymas, p_18ymas, p_12ymas,
  pea, pocupada, graproes, tvivhab, tvivpar, vph_inter, vph_autom,
  pcatolica, pro_crieva, potras_rel, psin_relig,
  p3ym_hli, p3hlinhe, p3hli_he, phog_ind, pob_afro,
  pnacent, pnacoe, pres2015, presoe15,
  p15ym_an, p15ym_se, p15pri_in, p15pri_co, p15sec_in, p15sec_co, p18ym_pb,
  p12ym_solt, p12ym_casa, p12ym_sepa,
  pcon_disc, pcon_limi, psind_lim,
  psinder, pder_ss, pder_imss, pder_iste, pder_segp, pder_imssb, pafil_ipriv,
  vph_refri, vph_lavad, vph_hmicro, vph_moto, vph_bici, vph_radio, vph_tv,
  vph_pc, vph_telef, vph_cel, vph_stvp, vph_spmvpi, vph_cvj, vph_snbien
FROM censo_municipios
UNION ALL
SELECT
  b.cve_mun_2025, left(b.cve_mun_2025, 2), right(b.cve_mun_2025, 3),
  b.nom_mun_2025, ce.nom_ent,
  true,
  array_agg(b.cve_mun_2020_parent ORDER BY b.cve_mun_2020_parent),
  -- Census columns: NULL, never the parent's (see header). Same order as
  -- the first branch; each NULL takes that branch's type.
  NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL,
  NULL, NULL, NULL,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL
FROM municipio_bridge_2025 b
LEFT JOIN censo_entidades ce ON ce.cve_ent = left(b.cve_mun_2025, 2)
GROUP BY b.cve_mun_2025, b.nom_mun_2025, ce.nom_ent;
-- <<< municipios_2025 section

ALTER TABLE municipio_bridge_2025 OWNER TO postgres;
REVOKE ALL ON municipio_bridge_2025 FROM anon, authenticated, trustr_app;
REVOKE ALL ON municipios_2025 FROM anon, authenticated, trustr_app;
GRANT SELECT ON municipio_bridge_2025 TO denue_sage;
GRANT SELECT ON municipios_2025 TO denue_sage;
-- The API reads municipios_2025 as denue_api (scripts/api-role.sql, audit
-- #8); guarded so the migration still applies before that role exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'denue_api') THEN
    GRANT SELECT ON municipio_bridge_2025 TO denue_api;
    GRANT SELECT ON municipios_2025 TO denue_api;
  END IF;
END$$;

DO $$
DECLARE
  n_pairs     int;
  n_children  int;
  n_bad_par   int;
  n_clash     int;
  n_rows      int;
  n_keys      int;
BEGIN
  SELECT count(*), count(DISTINCT cve_mun_2025)
    INTO n_pairs, n_children FROM municipio_bridge_2025;
  -- A parent missing from censo_municipios, or spelled differently there.
  SELECT count(*) INTO n_bad_par
    FROM municipio_bridge_2025 b
    LEFT JOIN censo_municipios c ON c.cve_mun = b.cve_mun_2020_parent
   WHERE c.nom_mun IS DISTINCT FROM b.nom_mun_2020_parent;
  -- A child key Censo 2020 already has would appear twice in the view.
  SELECT count(*) INTO n_clash
    FROM municipio_bridge_2025 b
    JOIN censo_municipios c ON c.cve_mun = b.cve_mun_2025;
  SELECT count(*), count(DISTINCT cve_mun)
    INTO n_rows, n_keys FROM municipios_2025;
  IF n_pairs <> 11 OR n_children <> 9 OR n_bad_par <> 0 OR n_clash <> 0
     OR n_rows <> 2478 OR n_keys <> 2478 THEN
    RAISE EXCEPTION
      '027: bridge/universe check failed: pairs=% (want 11) children=% (want 9) bad_parents=% child_clash=% rows=% keys=% (want 2478/2478)',
      n_pairs, n_children, n_bad_par, n_clash, n_rows, n_keys;
  END IF;
  RAISE NOTICE '027: municipios_2025 = % rows / % keys; bridge = % pairs / % children',
    n_rows, n_keys, n_pairs, n_children;
END$$;

COMMIT;
