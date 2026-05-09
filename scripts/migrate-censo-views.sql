-- v0.2.10 — Censo 2020 wider variable surface + locality grain.
--
-- Apply once after Censo ITER is loaded:
--   docker exec -i supabase-db psql -U postgres -d postgres < scripts/migrate-censo-views.sql
--
-- Idempotent: CREATE OR REPLACE for both views. No data movement.
-- censo_iter raw has 287 cols; v0.2.x exposed 14 in censo_municipios. This
-- migration extends censo_municipios to ~50 cols (religion / language /
-- migration / assets / education detail / civil status / disability) and
-- adds censo_localidades (~193k rows, sub-municipal grain).
--
-- Coverage note: v0.2.10 ships 2 endpoints reading censo_localidades but
-- ZERO endpoints reading the new muni-level extended cols. Those cols are
-- staged for a future /analytics/municipio-detail handler — exposing them
-- without a handler is intentional (the schema migration is reversible
-- only via DROP+CREATE; better to land it once and consume incrementally).
--
-- INEGI suppression sentinel is 'N/D' (152 locality rows in 2020 ITER on
-- privacy-protected fields). Every numeric cast is wrapped:
--   NULLIF(NULLIF(col, ''), 'N/D')::int    -- counts
--   NULLIF(NULLIF(col, ''), 'N/D')::numeric -- ratios / averages
-- Without both NULLIFs the cast throws on the first sentinel row and the
-- view becomes unqueryable. Mirrors the v0.2.6 CONEVAL '*' precedent.

-- =============================================================================
-- censo_municipios — extended (additive only; existing consumers unaffected)
-- =============================================================================
-- Filter loc='0000' AND mun<>'000' selects the 2,469 muni-rolled rows
-- (excludes the 32 entidad-rolled rows where mun='000' AND loc='0000').
-- All 6 existing analytics consumers SELECT explicit fields from cm — none
-- use SELECT *, so adding columns is a pure superset change.

CREATE OR REPLACE VIEW censo_municipios AS
SELECT
  cve_mun,
  entidad,
  mun,
  nom_mun,

  -- ─── Population (already exposed pre-v0.2.10) ───────────────────────────
  NULLIF(NULLIF(pobtot,    ''), 'N/D')::int     AS pobtot,
  NULLIF(NULLIF(pobfem,    ''), 'N/D')::int     AS pobfem,
  NULLIF(NULLIF(pobmas,    ''), 'N/D')::int     AS pobmas,
  NULLIF(NULLIF(p_60ymas,  ''), 'N/D')::int     AS p_60ymas,
  NULLIF(NULLIF(p_15ymas,  ''), 'N/D')::int     AS p_15ymas,
  NULLIF(NULLIF(p_18ymas,  ''), 'N/D')::int     AS p_18ymas,
  NULLIF(NULLIF(pea,       ''), 'N/D')::int     AS pea,
  NULLIF(NULLIF(pocupada,  ''), 'N/D')::int     AS pocupada,
  NULLIF(NULLIF(graproes,  ''), 'N/D')::numeric AS graproes,
  NULLIF(NULLIF(tvivhab,   ''), 'N/D')::int     AS tvivhab,
  NULLIF(NULLIF(tvivpar,   ''), 'N/D')::int     AS tvivpar,
  NULLIF(NULLIF(vph_inter, ''), 'N/D')::int     AS vph_inter,
  NULLIF(NULLIF(vph_autom, ''), 'N/D')::int     AS vph_autom,

  -- ─── Religion (v0.2.10 NEW) ─────────────────────────────────────────────
  NULLIF(NULLIF(pcatolica,  ''), 'N/D')::int    AS pcatolica,    -- católica
  NULLIF(NULLIF(pro_crieva, ''), 'N/D')::int    AS pro_crieva,   -- protestante / evangélico
  NULLIF(NULLIF(potras_rel, ''), 'N/D')::int    AS potras_rel,   -- otras religiones
  NULLIF(NULLIF(psin_relig, ''), 'N/D')::int    AS psin_relig,   -- sin religión

  -- ─── Indigenous & Afro (v0.2.10 NEW) ────────────────────────────────────
  NULLIF(NULLIF(p3ym_hli,  ''), 'N/D')::int     AS p3ym_hli,     -- 3+ habla LI
  NULLIF(NULLIF(p3hlinhe,  ''), 'N/D')::int     AS p3hlinhe,     -- LI sin español
  NULLIF(NULLIF(p3hli_he,  ''), 'N/D')::int     AS p3hli_he,     -- LI con español
  NULLIF(NULLIF(phog_ind,  ''), 'N/D')::int     AS phog_ind,     -- en hogar indígena
  NULLIF(NULLIF(pob_afro,  ''), 'N/D')::int     AS pob_afro,     -- afromexicano

  -- ─── Migration (v0.2.10 NEW) ────────────────────────────────────────────
  NULLIF(NULLIF(pnacent,   ''), 'N/D')::int     AS pnacent,      -- nacida en entidad
  NULLIF(NULLIF(pnacoe,    ''), 'N/D')::int     AS pnacoe,       -- nacida en otra entidad
  NULLIF(NULLIF(pres2015,  ''), 'N/D')::int     AS pres2015,     -- residente misma ent en 2015
  NULLIF(NULLIF(presoe15,  ''), 'N/D')::int     AS presoe15,     -- residente otra ent en 2015

  -- ─── Education detail (v0.2.10 NEW; supplements graproes) ───────────────
  NULLIF(NULLIF(p15ym_an,  ''), 'N/D')::int     AS p15ym_an,     -- 15+ analfabeta
  NULLIF(NULLIF(p15ym_se,  ''), 'N/D')::int     AS p15ym_se,     -- 15+ sin escolaridad
  NULLIF(NULLIF(p15pri_in, ''), 'N/D')::int     AS p15pri_in,    -- 15+ primaria incompleta
  NULLIF(NULLIF(p15pri_co, ''), 'N/D')::int     AS p15pri_co,    -- 15+ primaria completa
  NULLIF(NULLIF(p15sec_in, ''), 'N/D')::int     AS p15sec_in,    -- 15+ secundaria incompleta
  NULLIF(NULLIF(p15sec_co, ''), 'N/D')::int     AS p15sec_co,    -- 15+ secundaria completa
  NULLIF(NULLIF(p18ym_pb,  ''), 'N/D')::int     AS p18ym_pb,     -- 18+ con educ. postbásica

  -- ─── Civil status (v0.2.10 NEW) ─────────────────────────────────────────
  NULLIF(NULLIF(p12ym_solt, ''), 'N/D')::int    AS p12ym_solt,
  NULLIF(NULLIF(p12ym_casa, ''), 'N/D')::int    AS p12ym_casa,
  NULLIF(NULLIF(p12ym_sepa, ''), 'N/D')::int    AS p12ym_sepa,

  -- ─── Disability summary (v0.2.10 NEW) ───────────────────────────────────
  NULLIF(NULLIF(pcon_disc, ''), 'N/D')::int     AS pcon_disc,    -- con discapacidad
  NULLIF(NULLIF(pcon_limi, ''), 'N/D')::int     AS pcon_limi,    -- con limitación
  NULLIF(NULLIF(psind_lim, ''), 'N/D')::int     AS psind_lim,    -- sin discap/limit

  -- ─── Health coverage (v0.2.10 NEW; complements v0.2.7 AGEB-grain) ───────
  NULLIF(NULLIF(psinder,    ''), 'N/D')::int    AS psinder,      -- sin derechohabiencia
  NULLIF(NULLIF(pder_ss,    ''), 'N/D')::int    AS pder_ss,      -- con servicios salud
  NULLIF(NULLIF(pder_imss,  ''), 'N/D')::int    AS pder_imss,    -- IMSS
  NULLIF(NULLIF(pder_iste,  ''), 'N/D')::int    AS pder_iste,    -- ISSSTE
  NULLIF(NULLIF(pder_segp,  ''), 'N/D')::int    AS pder_segp,    -- SegPop / INSABI
  NULLIF(NULLIF(pder_imssb, ''), 'N/D')::int    AS pder_imssb,   -- IMSS-Bienestar
  NULLIF(NULLIF(pafil_ipriv,''), 'N/D')::int    AS pafil_ipriv,  -- privada

  -- ─── Household assets (v0.2.10 NEW; vph_inter+autom already exposed) ────
  NULLIF(NULLIF(vph_refri,  ''), 'N/D')::int    AS vph_refri,
  NULLIF(NULLIF(vph_lavad,  ''), 'N/D')::int    AS vph_lavad,
  NULLIF(NULLIF(vph_hmicro, ''), 'N/D')::int    AS vph_hmicro,
  NULLIF(NULLIF(vph_moto,   ''), 'N/D')::int    AS vph_moto,
  NULLIF(NULLIF(vph_bici,   ''), 'N/D')::int    AS vph_bici,
  NULLIF(NULLIF(vph_radio,  ''), 'N/D')::int    AS vph_radio,
  NULLIF(NULLIF(vph_tv,     ''), 'N/D')::int    AS vph_tv,
  NULLIF(NULLIF(vph_pc,     ''), 'N/D')::int    AS vph_pc,
  NULLIF(NULLIF(vph_telef,  ''), 'N/D')::int    AS vph_telef,
  NULLIF(NULLIF(vph_cel,    ''), 'N/D')::int    AS vph_cel,
  NULLIF(NULLIF(vph_stvp,   ''), 'N/D')::int    AS vph_stvp,     -- TV de paga
  NULLIF(NULLIF(vph_spmvpi, ''), 'N/D')::int    AS vph_spmvpi,   -- streaming
  NULLIF(NULLIF(vph_cvj,    ''), 'N/D')::int    AS vph_cvj,      -- consola
  NULLIF(NULLIF(vph_snbien, ''), 'N/D')::int    AS vph_snbien,   -- sin bienes

  -- nom_ent appended at the end (CREATE OR REPLACE VIEW can only add cols
  -- at the END of the SELECT list — not insert in the middle). Surfaces
  -- the human-readable entidad name for /analytics/municipio-detail
  -- responses, mirroring censo_localidades which already exposes nom_ent.
  -- Audit W1 (2026-05-09).
  nom_ent
FROM censo_iter
WHERE loc = '0000' AND mun <> '000';

-- =============================================================================
-- censo_localidades — locality-grain (v0.2.10 NEW)
-- =============================================================================
-- One row per (entidad, mun, loc) where loc is a real INEGI locality.
-- ~193k rows (vs 2,469 munis). Localities range from 1-pop ranchos to
-- 1.8M-pop cities. tamloc 1-14 size code (1=1-249, 14=1M+).
--
-- Key derivations (loc/mun/entidad in censo_iter are zero-padded text;
-- LPAD is defensive in case of historical drift):
--   cve_loc = ent(2) || mun(3) || loc(4) — 9-char DGIS-style
--   cve_mun = ent(2) || mun(3) — joins to censo_municipios
--
-- Filter excludes the 2 rolled-up rows (loc='0000' AND mun<>'000' = muni
-- total; loc='0000' AND mun='000' = entidad total).
--
-- INEGI suppresses small localities for privacy: pobtot is always
-- emitted; derived fields (religion, language, assets) become 'N/D' when
-- the locality has fewer than ~50 households. Same NULLIF guards as muni.
--
-- Geocoded via censo_iter.{longitud,latitud,altitud} — these come as
-- numeric strings in the raw load. For localities with only 1-2 households
-- INEGI sometimes ships these as 'N/D' too. Cast guards apply.

-- DROP+CREATE (not CREATE OR REPLACE): Postgres doesn't allow dropping or
-- renaming columns on a replacement. Safe here on first deploy (no
-- dependents). For future maintenance: add columns only at the end of the
-- SELECT and use CREATE OR REPLACE; reach for DROP+CREATE only when
-- removing or renaming, and grep consumers first.
DROP VIEW IF EXISTS censo_localidades;
CREATE VIEW censo_localidades AS
SELECT
  -- ─── Identity ───────────────────────────────────────────────────────────
  LPAD(entidad, 2, '0') || LPAD(mun, 3, '0') || LPAD(loc, 4, '0') AS cve_loc,
  LPAD(entidad, 2, '0') || LPAD(mun, 3, '0')                       AS cve_mun,
  entidad,
  mun,
  loc,
  nom_loc,
  nom_mun,
  nom_ent,
  NULLIF(NULLIF(tamloc, ''), 'N/D')::int                           AS tamloc,
  -- INEGI ITER ships latitud/longitud as DMS strings (19°21'32.414" N) which
  -- can't be cast to numeric without a parser; deferred to a follow-up
  -- sprint if downstream needs decimal coords. Establishment-level geo is
  -- already in establecimientos.geom (decimal degrees, SRID 4326).
  -- altitud is plain numeric for 189,409 / 193,094 localities; the 23
  -- legacy "00-N" coded rows return NULL via the regex guard.
  CASE WHEN altitud ~ '^-?[0-9]+(\.[0-9]+)?$'
       THEN altitud::numeric ELSE NULL END                         AS altitud_m,

  -- ─── Population ─────────────────────────────────────────────────────────
  NULLIF(NULLIF(pobtot,   ''), 'N/D')::int     AS pobtot,
  NULLIF(NULLIF(pobfem,   ''), 'N/D')::int     AS pobfem,
  NULLIF(NULLIF(pobmas,   ''), 'N/D')::int     AS pobmas,
  NULLIF(NULLIF(p_60ymas, ''), 'N/D')::int     AS p_60ymas,
  NULLIF(NULLIF(p_15ymas, ''), 'N/D')::int     AS p_15ymas,
  NULLIF(NULLIF(p_18ymas, ''), 'N/D')::int     AS p_18ymas,
  NULLIF(NULLIF(pea,      ''), 'N/D')::int     AS pea,
  NULLIF(NULLIF(pocupada, ''), 'N/D')::int     AS pocupada,
  NULLIF(NULLIF(graproes, ''), 'N/D')::numeric AS graproes,
  NULLIF(NULLIF(tvivhab,  ''), 'N/D')::int     AS tvivhab,
  NULLIF(NULLIF(tvivpar,  ''), 'N/D')::int     AS tvivpar,

  -- ─── Religion ───────────────────────────────────────────────────────────
  NULLIF(NULLIF(pcatolica,  ''), 'N/D')::int   AS pcatolica,
  NULLIF(NULLIF(pro_crieva, ''), 'N/D')::int   AS pro_crieva,
  NULLIF(NULLIF(potras_rel, ''), 'N/D')::int   AS potras_rel,
  NULLIF(NULLIF(psin_relig, ''), 'N/D')::int   AS psin_relig,

  -- ─── Indigenous & Afro ──────────────────────────────────────────────────
  NULLIF(NULLIF(p3ym_hli, ''), 'N/D')::int     AS p3ym_hli,
  NULLIF(NULLIF(p3hlinhe, ''), 'N/D')::int     AS p3hlinhe,
  NULLIF(NULLIF(p3hli_he, ''), 'N/D')::int     AS p3hli_he,
  NULLIF(NULLIF(phog_ind, ''), 'N/D')::int     AS phog_ind,
  NULLIF(NULLIF(pob_afro, ''), 'N/D')::int     AS pob_afro,

  -- ─── Migration ──────────────────────────────────────────────────────────
  NULLIF(NULLIF(pnacent,  ''), 'N/D')::int     AS pnacent,
  NULLIF(NULLIF(pnacoe,   ''), 'N/D')::int     AS pnacoe,
  NULLIF(NULLIF(pres2015, ''), 'N/D')::int     AS pres2015,
  NULLIF(NULLIF(presoe15, ''), 'N/D')::int     AS presoe15,

  -- ─── Education detail ───────────────────────────────────────────────────
  NULLIF(NULLIF(p15ym_an, ''), 'N/D')::int     AS p15ym_an,
  NULLIF(NULLIF(p15ym_se, ''), 'N/D')::int     AS p15ym_se,
  NULLIF(NULLIF(p18ym_pb, ''), 'N/D')::int     AS p18ym_pb,

  -- ─── Health coverage ────────────────────────────────────────────────────
  NULLIF(NULLIF(psinder,     ''), 'N/D')::int  AS psinder,
  NULLIF(NULLIF(pder_ss,     ''), 'N/D')::int  AS pder_ss,
  NULLIF(NULLIF(pder_imss,   ''), 'N/D')::int  AS pder_imss,
  NULLIF(NULLIF(pder_iste,   ''), 'N/D')::int  AS pder_iste,
  NULLIF(NULLIF(pder_segp,   ''), 'N/D')::int  AS pder_segp,
  NULLIF(NULLIF(pder_imssb,  ''), 'N/D')::int  AS pder_imssb,
  NULLIF(NULLIF(pafil_ipriv, ''), 'N/D')::int  AS pafil_ipriv,

  -- ─── Household assets ───────────────────────────────────────────────────
  NULLIF(NULLIF(vph_inter,  ''), 'N/D')::int   AS vph_inter,
  NULLIF(NULLIF(vph_autom,  ''), 'N/D')::int   AS vph_autom,
  NULLIF(NULLIF(vph_refri,  ''), 'N/D')::int   AS vph_refri,
  NULLIF(NULLIF(vph_lavad,  ''), 'N/D')::int   AS vph_lavad,
  NULLIF(NULLIF(vph_pc,     ''), 'N/D')::int   AS vph_pc,
  NULLIF(NULLIF(vph_cel,    ''), 'N/D')::int   AS vph_cel,
  NULLIF(NULLIF(vph_tv,     ''), 'N/D')::int   AS vph_tv,
  NULLIF(NULLIF(vph_snbien, ''), 'N/D')::int   AS vph_snbien
FROM censo_iter
WHERE loc <> '0000' AND mun <> '000';

-- Smoke-tests (manual; run after applying):
--   SELECT cve_mun, pobtot, pcatolica, vph_inter FROM censo_municipios WHERE cve_mun='09015';
--   SELECT count(*) FROM censo_localidades;
--   SELECT cve_loc, nom_loc, pobtot, tamloc FROM censo_localidades
--     WHERE cve_mun='09015' ORDER BY pobtot DESC NULLS LAST LIMIT 10;
--   SELECT cve_loc, nom_loc, pobtot FROM censo_localidades
--     WHERE pcatolica IS NULL AND pobtot > 0 LIMIT 5;  -- N/D suppression hits
