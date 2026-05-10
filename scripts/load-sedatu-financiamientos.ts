#!/usr/bin/env npx tsx --env-file=.env
/**
 * Loader: SEDATU SNIIV Financiamientos a la Vivienda 2025.
 *
 * Source: https://sistemas.sedatu.gob.mx/repositorio/proxy/alfresco-noauth/api/internal/shared/node/BOZvuxwVRmy62_qG966obQ/content/financiamientos_2025.csv?a=true
 * Codebook: see docs/scan-sedatu-financiamientos-2025.md
 *
 * Pipeline:
 *   1. Pre-pass: iconv ISO-8859-1 → UTF-8 (raw is Latin-1 with `año` as 0xf1).
 *   2. \copy raw CSV into `sedatu_financiamientos_raw_2025` (all TEXT).
 *   3. Atomic BEGIN/COMMIT block builds:
 *      - 4 lookup tables (organismos, modalidades, destinos, vivienda_tiers)
 *        seeded from the codebook (hardcoded INSERTs — codebook is small + stable).
 *      - View `sedatu_financiamientos_2025` (typed cast + LPAD cve_mun + INEGI
 *        5-char `cve_mun_full` join key).
 *      - View `sedatu_financiamientos_estado_grain_2025` (v0.2.16: filters on
 *        cve_ent only, re-includes the 384 state-level "no distribuido"
 *        rows the muni view excludes — needed for estado-grain rollup).
 *      - MATERIALIZED VIEW `sedatu_financing_by_municipio` (per-muni aggregates:
 *        acciones_total, monto_total, mean loan size, top organismo + share,
 *        modality % breakdown, demographic %s, housing-tier % composition).
 *      - MATERIALIZED VIEW `sedatu_financing_by_estado` (v0.2.16: same shape
 *        as muni MV, grouped by cve_ent, sourced from estado-grain base view).
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/load-sedatu-financiamientos.ts \
 *     [--csv=raw/sedatu/financiamientos_2025.csv] [--force]
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { argv } from "node:process";

interface Args {
  csv: string;
  force: boolean;
  container: string;
}

const SAFE_CONTAINER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const SAFE_PATH_RE = /^[A-Za-z0-9._\-/]+$/;

function assertSafePath(p: string): void {
  const r = resolve(p);
  if (!SAFE_PATH_RE.test(r)) {
    throw new Error(`unsafe path: ${p}`);
  }
}

function parseArgs(): Args {
  const args = argv.slice(2);
  let csv = "raw/sedatu/financiamientos_2025.csv";
  let force = false;
  for (const a of args) {
    if (a.startsWith("--csv=")) csv = a.slice(6);
    else if (a === "--force") force = true;
  }
  return {
    csv,
    force,
    container: process.env.SUPABASE_DB_CONTAINER ?? "supabase-db",
  };
}

// --- Schema ---

export const RAW_HEADER_COLS = [
  "ano",
  "mes",
  "cve_ent",
  "entidad",
  "cve_mun",
  "municipio",
  "organismo",
  "modalidad",
  "destino",
  "tipo",
  "sexo",
  "edad_rango",
  "ingresos_rango",
  "vivienda_valor",
  "acciones",
  "monto",
] as const;

export const NUMERIC_RAW_COLS = [
  "ano",
  "mes",
  "organismo",
  "modalidad",
  "destino",
  "tipo",
  "sexo",
  "edad_rango",
  "ingresos_rango",
  "vivienda_valor",
  "acciones",
  "monto",
] as const;

export const RAW_DDL = `
CREATE TABLE IF NOT EXISTS sedatu_financiamientos_raw_2025 (
  ano TEXT,
  mes TEXT,
  cve_ent TEXT,
  entidad TEXT,
  cve_mun TEXT,
  municipio TEXT,
  organismo TEXT,
  modalidad TEXT,
  destino TEXT,
  tipo TEXT,
  sexo TEXT,
  edad_rango TEXT,
  ingresos_rango TEXT,
  vivienda_valor TEXT,
  acciones TEXT,
  monto TEXT,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sedatu_raw_cve_ent
  ON sedatu_financiamientos_raw_2025(cve_ent);
CREATE INDEX IF NOT EXISTS idx_sedatu_raw_organismo
  ON sedatu_financiamientos_raw_2025(organismo);
`.trim();

// Lookup table seeds — hardcoded from codebook (diccionario_financiamiento.xlsx).
// Re-running is idempotent because LOOKUPS_DDL drops + recreates each time.
export const ORGANISMOS_SEED = [
  [1, "INFONAVIT"],
  [2, "CNBV (banca múltiple)"],
  [3, "FOVISSSTE"],
  [4, "SHF"],
  [5, "CONAVI"],
  [6, "INVI Ciudad de México"],
  [7, "Banjercito"],
  [8, "Hábitat México"],
  [9, "CFE"],
  [10, "ISSFAM"],
  [11, "PEMEX"],
  [12, "FONHAPO"],
  [13, "PDZP SEDESOL"],
  [14, "SOFOLES AMFE"],
  [15, "ISSSTELEON Nuevo León"],
  [16, "INDIVI Baja California"],
  [17, "COVEG Guanajuato"],
  [18, "COESVI Durango"],
  [19, "IMEVIS Estado de México"],
  [20, "IVEM Michoacán"],
  [21, "ITAVU Tamaulipas"],
  [22, "IVNL Nuevo León"],
  [23, "INVIVIENDA Veracruz"],
  [24, "IVEY Yucatán"],
  [25, "INFOVIR"],
  [26, "Instituto Nacional del Suelo Sustentable"],
] as const;

export const MODALIDADES_SEED = [
  [1, "Vivienda nueva"],
  [2, "Mejoramientos"],
  [3, "Vivienda usada"],
  [4, "Otros programas"],
] as const;

export const DESTINOS_SEED = [
  [1, "Mejoramientos"],
  [2, "Vivienda nueva"],
  [3, "Vivienda usada"],
  [4, "Pago de pasivos"],
  [5, "Con disponibilidad de terreno"],
  [6, "Liquidez"],
  [7, "Adquisición de suelo"],
  [8, "Reconstrucción"],
  [9, "Ampliación"],
  [10, "Autoproducción"],
  [11, "Arrendamiento"],
  [12, "Insumos para vivienda"],
  [13, "Urbanización para uso habitacional"],
  [14, "Lotes con servicios"],
  [15, "Garantías"],
  [16, "Programas institucionales"],
  [17, "Contragarantías"],
  [18, "Regularización de asentamientos"],
] as const;

export const VIVIENDA_TIERS_SEED = [
  [1, "Económica"],
  [2, "Popular"],
  [3, "Tradicional"],
  [4, "Media"],
  [5, "Residencial"],
  [6, "Residencial plus"],
] as const;

function buildSeedSql(
  table: string,
  rows: ReadonlyArray<readonly [number, string]>,
): string {
  const values = rows
    .map(([code, label]) => `(${code}, '${label.replace(/'/g, "''")}')`)
    .join(",\n  ");
  return `
DROP TABLE IF EXISTS ${table};
CREATE TABLE ${table} (
  code INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL
);
INSERT INTO ${table} (code, nombre) VALUES
  ${values};
`.trim();
}

export const LOOKUPS_DDL = [
  buildSeedSql("sedatu_organismos", ORGANISMOS_SEED),
  buildSeedSql("sedatu_modalidades", MODALIDADES_SEED),
  buildSeedSql("sedatu_destinos", DESTINOS_SEED),
  buildSeedSql("sedatu_vivienda_tiers", VIVIENDA_TIERS_SEED),
].join("\n\n");

const numericCast = (col: string): string =>
  // Empty string OR whitespace → NULL, then cast to numeric. Defense
  // against future rows with `' '`/`'  '` from inconsistent SEDATU output.
  `NULLIF(TRIM(${col}), '')::numeric AS ${col}`;

// View 1: typed cast + INEGI 5-char cve_mun composed via LPAD.
// Filters out 11 + 384 catch-all rows (cve_ent/cve_mun empty = "No
// distribuido" national/state-level rolls; preserved in raw table).
// Defense in depth: cve_ent ~ '^(0[1-9]|[12][0-9]|3[0-2])$' rejects
// any future rogue catch-all sentinel like '99' or '00'.
// Audit W4 round-2 (symmetric fix to R4): dropped `cve_mun AS cve_mun_short`
// + `municipio` from the muni view's projection too. Both were dead — the
// muni MV groups on the LPAD-composed `cve_mun` (5-char) below; no handler
// SELECTs the short or string forms. Verified zero downstream consumers
// via grep across src/ + scripts/.
export const FINANCIAMIENTOS_VIEW_DDL = `
CREATE VIEW sedatu_financiamientos_2025 AS
SELECT
  ${NUMERIC_RAW_COLS.map(numericCast).join(",\n  ")},
  cve_ent,
  entidad,
  cve_ent || LPAD(cve_mun, 3, '0') AS cve_mun
FROM sedatu_financiamientos_raw_2025
WHERE NULLIF(TRIM(cve_ent), '') IS NOT NULL
  AND NULLIF(TRIM(cve_mun), '') IS NOT NULL
  -- TRIM-then-match: defensive against future SEDATU rows with whitespace
  -- around codes (audit W1 round-2). Also bounds entidad to canonical
  -- '01..32' so a future '99' national catch-all is rejected even if
  -- the empty-cve_ent filter doesn't catch it.
  AND TRIM(cve_ent) ~ '^(0[1-9]|[12][0-9]|3[0-2])$'
  AND TRIM(cve_mun) ~ '^[0-9]{1,3}$';
`.trim();

// View 1b (v0.2.16): estado-grain sibling. Same typed-cast shape as the
// muni view, but the cve_mun filter is INTENTIONALLY DROPPED so that
// state-level "No distribuido por municipio" rows are RE-INCLUDED in
// estado aggregates. Empirically these add 384 rows / 0 acciones / $265M
// MXN at the 2025 ingest — typically pure-monto entries from publishers
// that don't break out per-muni for state-level grants/subsidies.
//
// The muni-grain view INTENTIONALLY EXCLUDES these (no cve_mun → can't
// attribute to a muni); estado-grain intentionally INCLUDES them. The
// sums therefore differ by exactly the catch-all volume — pinned in
// the MV docstring so analyzer/operators don't flag the discrepancy
// as a bug.
// Audit R4 round-1: dropped `cve_mun AS cve_mun_short` + `municipio` from
// the projection. Both were copy-paste residue from the muni view; the
// estado MV groups on cve_ent and never references either column.
// Re-add only if a future estado-grain consumer needs the strings.
export const FINANCIAMIENTOS_ESTADO_VIEW_DDL = `
CREATE VIEW sedatu_financiamientos_estado_grain_2025 AS
SELECT
  ${NUMERIC_RAW_COLS.map(numericCast).join(",\n  ")},
  cve_ent,
  entidad
FROM sedatu_financiamientos_raw_2025
WHERE NULLIF(TRIM(cve_ent), '') IS NOT NULL
  AND TRIM(cve_ent) ~ '^(0[1-9]|[12][0-9]|3[0-2])$';
  -- NO cve_mun filter (deliberate — see comment above).
`.trim();

// View 2: per-muni aggregates with code-label resolution.
// Composition pcts are exclude-suppressed: e.g. pct_femenino divides by
// `acciones WHERE sexo IS NOT NULL`, not by total acciones — so the
// reported % is among rows where sexo is known. Same posture for
// edad/ingresos/vivienda_valor.
export const FINANCING_BY_MUNI_DDL = `
CREATE MATERIALIZED VIEW sedatu_financing_by_municipio AS
WITH per_muni AS (
  SELECT
    cve_mun,
    cve_ent,
    -- Expose the period from the data itself so future yearly ingests
    -- (2026/2027/etc) don't require a marshaller code change. Every row
    -- in this file has ano=2025; if a future load mixes years, the MIN
    -- surfaces the earliest. Audit W4 round-2.
    MIN(ano)::INTEGER::TEXT AS periodo,
    SUM(acciones)::INTEGER AS acciones_total,
    SUM(monto)::NUMERIC(20, 2) AS monto_total,
    -- Modality % over ALL acciones (modality is always known).
    -- COALESCE wraps the FILTER aggregate so a muni with zero rows in a
    -- given modality returns 0%, not NULL — SUM of an empty filter is NULL.
    ROUND(
      (COALESCE(SUM(acciones) FILTER (WHERE modalidad = 1), 0) * 100.0
       / NULLIF(SUM(acciones), 0))::numeric, 2
    ) AS pct_vivienda_nueva,
    ROUND(
      (COALESCE(SUM(acciones) FILTER (WHERE modalidad = 2), 0) * 100.0
       / NULLIF(SUM(acciones), 0))::numeric, 2
    ) AS pct_mejoramientos,
    ROUND(
      (COALESCE(SUM(acciones) FILTER (WHERE modalidad = 3), 0) * 100.0
       / NULLIF(SUM(acciones), 0))::numeric, 2
    ) AS pct_vivienda_usada,
    ROUND(
      (COALESCE(SUM(acciones) FILTER (WHERE modalidad = 4), 0) * 100.0
       / NULLIF(SUM(acciones), 0))::numeric, 2
    ) AS pct_otros,
    -- Demographic % over rows where the dim is known (sexo IS NOT NULL etc.).
    -- Numerator COALESCE'd to 0 (zero-women muni → 0%, not NULL); denominator
    -- NULLIF'd so a muni where sexo is unknown for ALL rows returns NULL
    -- (signals "we can't tell" rather than confidently reporting 0%).
    ROUND(
      (COALESCE(SUM(acciones) FILTER (WHERE sexo = 2), 0) * 100.0
       / NULLIF(SUM(acciones) FILTER (WHERE sexo IS NOT NULL), 0))::numeric, 2
    ) AS pct_femenino,
    ROUND(
      (COALESCE(SUM(acciones) FILTER (WHERE tipo = 1), 0) * 100.0
       / NULLIF(SUM(acciones) FILTER (WHERE tipo IS NOT NULL), 0))::numeric, 2
    ) AS pct_credito_individual,
    -- Housing-tier counters: NULL preserved here (used in CASE-WHEN below
    -- so the tier subtree returns NULL when 100% of rows lack vivienda_valor).
    SUM(acciones) FILTER (WHERE vivienda_valor IS NOT NULL) AS acciones_with_tier,
    COALESCE(SUM(acciones) FILTER (WHERE vivienda_valor = 1), 0) AS acciones_economica,
    COALESCE(SUM(acciones) FILTER (WHERE vivienda_valor = 2), 0) AS acciones_popular,
    COALESCE(SUM(acciones) FILTER (WHERE vivienda_valor = 3), 0) AS acciones_tradicional,
    COALESCE(SUM(acciones) FILTER (WHERE vivienda_valor = 4), 0) AS acciones_media,
    COALESCE(SUM(acciones) FILTER (WHERE vivienda_valor = 5), 0) AS acciones_residencial,
    COALESCE(SUM(acciones) FILTER (WHERE vivienda_valor = 6), 0) AS acciones_residencial_plus
  FROM sedatu_financiamientos_2025
  GROUP BY cve_mun, cve_ent
),
top_org AS (
  SELECT
    cve_mun,
    organismo AS top_organismo_code,
    SUM(acciones)::INTEGER AS top_organismo_acciones,
    ROW_NUMBER() OVER (
      PARTITION BY cve_mun
      ORDER BY SUM(acciones) DESC, organismo ASC
    ) AS rk
  FROM sedatu_financiamientos_2025
  GROUP BY cve_mun, organismo
)
SELECT
  pm.cve_mun,
  pm.cve_ent,
  pm.periodo,
  pm.acciones_total,
  pm.monto_total,
  ROUND(pm.monto_total / NULLIF(pm.acciones_total, 0), 2) AS monto_per_accion_avg,
  t.top_organismo_code,
  o.nombre AS top_organismo_nombre,
  ROUND(t.top_organismo_acciones * 100.0 / NULLIF(pm.acciones_total, 0), 2) AS top_organismo_share,
  pm.pct_vivienda_nueva,
  pm.pct_mejoramientos,
  pm.pct_vivienda_usada,
  pm.pct_otros,
  pm.pct_femenino,
  pm.pct_credito_individual,
  -- Housing-tier composition: NULL when 100% of muni rows lack vivienda_valor
  CASE WHEN pm.acciones_with_tier > 0
    THEN ROUND(pm.acciones_economica * 100.0 / pm.acciones_with_tier, 2)
  END AS pct_economica,
  CASE WHEN pm.acciones_with_tier > 0
    THEN ROUND(pm.acciones_popular * 100.0 / pm.acciones_with_tier, 2)
  END AS pct_popular,
  CASE WHEN pm.acciones_with_tier > 0
    THEN ROUND(pm.acciones_tradicional * 100.0 / pm.acciones_with_tier, 2)
  END AS pct_tradicional,
  CASE WHEN pm.acciones_with_tier > 0
    THEN ROUND(pm.acciones_media * 100.0 / pm.acciones_with_tier, 2)
  END AS pct_media,
  CASE WHEN pm.acciones_with_tier > 0
    THEN ROUND(pm.acciones_residencial * 100.0 / pm.acciones_with_tier, 2)
  END AS pct_residencial,
  CASE WHEN pm.acciones_with_tier > 0
    THEN ROUND(pm.acciones_residencial_plus * 100.0 / pm.acciones_with_tier, 2)
  END AS pct_residencial_plus
FROM per_muni pm
LEFT JOIN top_org t ON t.cve_mun = pm.cve_mun AND t.rk = 1
LEFT JOIN sedatu_organismos o ON o.code = t.top_organismo_code;

CREATE UNIQUE INDEX idx_sedatu_fin_cve_mun
  ON sedatu_financing_by_municipio(cve_mun);
CREATE INDEX idx_sedatu_fin_cve_ent
  ON sedatu_financing_by_municipio(cve_ent);
CREATE INDEX idx_sedatu_fin_monto_total
  ON sedatu_financing_by_municipio(monto_total DESC);
`.trim();

// MV 2 (v0.2.16): estado-grain aggregates. Same composition formulas as the
// muni MV (modality % over ALL acciones, demographic % with known-rows
// denominators, vivienda-tier subtree-NULL guard) but grouped by cve_ent
// and sourced from the estado-grain base view (which re-includes the 384
// state-level catch-all rows the muni base view excludes). Net result:
// estado.acciones_total = SUM(muni.acciones_total) (catch-alls have 0 acciones)
// estado.monto_total    > SUM(muni.monto_total)    (catch-alls add $265M MXN)
//
// top_organismo at estado grain breaks ties by lower organismo code
// (deterministic), same as muni grain.
//
// Audit W1/W2 round-1 caveats — both deliberate:
//  * `monto_per_accion_avg` divides catch-all-inclusive monto by
//    catch-all-exclusive acciones. The "avg" is biased upward by the
//    catch-all share — material at small estados with concentrated
//    state-level grant programs. Not directly comparable to muni avg.
//  * `top_organismo` ranks by acciones (catch-alls have 0 acciones, so
//    a publisher that ships only state-level pure-monto entries does
//    not surface in the ranking even though its monto is captured).
export const FINANCING_BY_ESTADO_DDL = `
CREATE MATERIALIZED VIEW sedatu_financing_by_estado AS
WITH per_estado AS (
  SELECT
    cve_ent,
    MIN(ano)::INTEGER::TEXT AS periodo,
    SUM(acciones)::INTEGER AS acciones_total,
    SUM(monto)::NUMERIC(20, 2) AS monto_total,
    ROUND(
      (COALESCE(SUM(acciones) FILTER (WHERE modalidad = 1), 0) * 100.0
       / NULLIF(SUM(acciones), 0))::numeric, 2
    ) AS pct_vivienda_nueva,
    ROUND(
      (COALESCE(SUM(acciones) FILTER (WHERE modalidad = 2), 0) * 100.0
       / NULLIF(SUM(acciones), 0))::numeric, 2
    ) AS pct_mejoramientos,
    ROUND(
      (COALESCE(SUM(acciones) FILTER (WHERE modalidad = 3), 0) * 100.0
       / NULLIF(SUM(acciones), 0))::numeric, 2
    ) AS pct_vivienda_usada,
    ROUND(
      (COALESCE(SUM(acciones) FILTER (WHERE modalidad = 4), 0) * 100.0
       / NULLIF(SUM(acciones), 0))::numeric, 2
    ) AS pct_otros,
    ROUND(
      (COALESCE(SUM(acciones) FILTER (WHERE sexo = 2), 0) * 100.0
       / NULLIF(SUM(acciones) FILTER (WHERE sexo IS NOT NULL), 0))::numeric, 2
    ) AS pct_femenino,
    ROUND(
      (COALESCE(SUM(acciones) FILTER (WHERE tipo = 1), 0) * 100.0
       / NULLIF(SUM(acciones) FILTER (WHERE tipo IS NOT NULL), 0))::numeric, 2
    ) AS pct_credito_individual,
    SUM(acciones) FILTER (WHERE vivienda_valor IS NOT NULL) AS acciones_with_tier,
    COALESCE(SUM(acciones) FILTER (WHERE vivienda_valor = 1), 0) AS acciones_economica,
    COALESCE(SUM(acciones) FILTER (WHERE vivienda_valor = 2), 0) AS acciones_popular,
    COALESCE(SUM(acciones) FILTER (WHERE vivienda_valor = 3), 0) AS acciones_tradicional,
    COALESCE(SUM(acciones) FILTER (WHERE vivienda_valor = 4), 0) AS acciones_media,
    COALESCE(SUM(acciones) FILTER (WHERE vivienda_valor = 5), 0) AS acciones_residencial,
    COALESCE(SUM(acciones) FILTER (WHERE vivienda_valor = 6), 0) AS acciones_residencial_plus
  FROM sedatu_financiamientos_estado_grain_2025
  GROUP BY cve_ent
),
top_org_estado AS (
  SELECT
    cve_ent,
    organismo AS top_organismo_code,
    SUM(acciones)::INTEGER AS top_organismo_acciones,
    ROW_NUMBER() OVER (
      PARTITION BY cve_ent
      ORDER BY SUM(acciones) DESC, organismo ASC
    ) AS rk
  FROM sedatu_financiamientos_estado_grain_2025
  GROUP BY cve_ent, organismo
)
SELECT
  pe.cve_ent,
  pe.periodo,
  pe.acciones_total,
  pe.monto_total,
  ROUND(pe.monto_total / NULLIF(pe.acciones_total, 0), 2) AS monto_per_accion_avg,
  t.top_organismo_code,
  o.nombre AS top_organismo_nombre,
  ROUND(t.top_organismo_acciones * 100.0 / NULLIF(pe.acciones_total, 0), 2) AS top_organismo_share,
  pe.pct_vivienda_nueva,
  pe.pct_mejoramientos,
  pe.pct_vivienda_usada,
  pe.pct_otros,
  pe.pct_femenino,
  pe.pct_credito_individual,
  CASE WHEN pe.acciones_with_tier > 0
    THEN ROUND(pe.acciones_economica * 100.0 / pe.acciones_with_tier, 2)
  END AS pct_economica,
  CASE WHEN pe.acciones_with_tier > 0
    THEN ROUND(pe.acciones_popular * 100.0 / pe.acciones_with_tier, 2)
  END AS pct_popular,
  CASE WHEN pe.acciones_with_tier > 0
    THEN ROUND(pe.acciones_tradicional * 100.0 / pe.acciones_with_tier, 2)
  END AS pct_tradicional,
  CASE WHEN pe.acciones_with_tier > 0
    THEN ROUND(pe.acciones_media * 100.0 / pe.acciones_with_tier, 2)
  END AS pct_media,
  CASE WHEN pe.acciones_with_tier > 0
    THEN ROUND(pe.acciones_residencial * 100.0 / pe.acciones_with_tier, 2)
  END AS pct_residencial,
  CASE WHEN pe.acciones_with_tier > 0
    THEN ROUND(pe.acciones_residencial_plus * 100.0 / pe.acciones_with_tier, 2)
  END AS pct_residencial_plus
FROM per_estado pe
LEFT JOIN top_org_estado t ON t.cve_ent = pe.cve_ent AND t.rk = 1
LEFT JOIN sedatu_organismos o ON o.code = t.top_organismo_code;

CREATE UNIQUE INDEX idx_sedatu_fin_est_cve_ent
  ON sedatu_financing_by_estado(cve_ent);
CREATE INDEX idx_sedatu_fin_est_monto_total
  ON sedatu_financing_by_estado(monto_total DESC);
`.trim();

// Audit-W1 pattern from v0.2.13: views in ONE atomic transaction so a
// partial failure (transient psql restart, OOM during MV materialization)
// cannot leave the API in a broken state.
//
// DROP ordering (v0.2.16 extends from v0.2.15 lesson — Postgres DROP VIEW
// does NOT cascade, so dependent MVs must be dropped before their base
// view OR before their lookup-table dependencies):
//   1. estado MV (depends on lookups + estado base view)
//   2. muni MV   (depends on lookups + muni base view)
//   3. estado base view (no dependents now)
//   4. muni base view   (no dependents now)
//   5. LOOKUPS_DDL      (drops + recreates lookup tables — safe now)
//
// Without step 1, a second --force reload after v0.2.16 ships errors with
// "cannot drop table sedatu_organismos because materialized view
// sedatu_financing_by_estado depends on it". Mirrors the v0.2.15 SICT C1.
export const VIEWS_DDL_TRANSACTION = `
BEGIN;

\\echo [load-sedatu] dropping dependent views before lookup-table rebuild...

DROP MATERIALIZED VIEW IF EXISTS sedatu_financing_by_estado;
DROP MATERIALIZED VIEW IF EXISTS sedatu_financing_by_municipio;
DROP VIEW IF EXISTS sedatu_financiamientos_estado_grain_2025;
DROP VIEW IF EXISTS sedatu_financiamientos_2025;

\\echo [load-sedatu] applying lookup tables (organismos / modalidades / destinos / vivienda_tiers)...

${LOOKUPS_DDL}

\\echo [load-sedatu] building financiamientos view (typed cast + LPAD cve_mun)...

${FINANCIAMIENTOS_VIEW_DDL}

\\echo [load-sedatu] building financiamientos estado-grain view (re-includes state-level catch-alls)...

${FINANCIAMIENTOS_ESTADO_VIEW_DDL}

\\echo [load-sedatu] building financing-by-municipio MV + indexes...

${FINANCING_BY_MUNI_DDL}

\\echo [load-sedatu] building financing-by-estado MV + indexes...

${FINANCING_BY_ESTADO_DDL}

COMMIT;
`.trim();

export const POST_LOAD_VERIFY_SQL = `
SELECT
  (SELECT COUNT(*) FROM sedatu_financiamientos_raw_2025) AS raw_rows,
  (SELECT COUNT(*) FROM sedatu_financiamientos_2025) AS view_rows,
  (SELECT COUNT(DISTINCT cve_mun) FROM sedatu_financiamientos_2025) AS distinct_muni,
  (SELECT COUNT(*) FROM sedatu_financing_by_municipio) AS muni_with_financing,
  (SELECT COUNT(*) FROM sedatu_financing_by_estado) AS estados_with_financing,
  (SELECT TO_CHAR(SUM(acciones_total), 'FM999,999,999') FROM sedatu_financing_by_municipio) AS total_acciones,
  (SELECT TO_CHAR(SUM(monto_total) / 1e9, 'FM999.99') FROM sedatu_financing_by_municipio) AS total_monto_b_mxn;
`.trim();

// --- Loader ---

function dockerExec(container: string, args: string[]): string {
  if (!SAFE_CONTAINER_RE.test(container)) {
    throw new Error(`unsafe container name: ${container}`);
  }
  return execFileSync("docker", ["exec", "-i", container, ...args], {
    encoding: "utf-8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

function dockerExecStdin(
  container: string,
  args: string[],
  stdin: string | Buffer,
): string {
  if (!SAFE_CONTAINER_RE.test(container)) {
    throw new Error(`unsafe container name: ${container}`);
  }
  return execFileSync("docker", ["exec", "-i", container, ...args], {
    encoding: "utf-8",
    input: stdin,
    maxBuffer: 256 * 1024 * 1024,
  });
}

/**
 * Convert ISO-8859-1 → UTF-8 in-memory. Raw bytes 0xf1 (`ñ`), 0xe9 (`é`),
 * 0xfa (`ú`) etc. need transcoding before psql ingests with default UTF-8
 * server encoding — otherwise `Ciudad de México` arrives as `Ciudad de
 * M\xe9xico` and silently corrupts.
 *
 * Implementation: read as Latin-1 buffer (faithful 1-byte-per-char),
 * decode each byte into its Unicode code point (Latin-1 happens to be a
 * 1:1 prefix of Unicode), then re-encode as UTF-8.
 */
export function transcodeLatin1ToUtf8(input: Buffer): Buffer {
  // Node's built-in 'latin1' encoding maps each byte to U+0000–U+00FF
  // exactly (this IS the ISO-8859-1 → Unicode codepoint mapping).
  const text = input.toString("latin1");
  return Buffer.from(text, "utf-8");
}

export async function loadSedatuFinanciamientos(args: Args): Promise<void> {
  if (!existsSync(args.csv)) {
    throw new Error(
      `[load-sedatu] CSV not found: ${args.csv}. Download from https://sistemas.sedatu.gob.mx/repositorio/proxy/alfresco-noauth/api/internal/shared/node/BOZvuxwVRmy62_qG966obQ/content/financiamientos_2025.csv?a=true`,
    );
  }
  assertSafePath(args.csv);

  // 1. Apply schema (idempotent).
  console.log("[load-sedatu] applying schema...");
  dockerExecStdin(
    args.container,
    ["psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
    RAW_DDL,
  );

  // 2. Idempotency guard.
  const countOut = dockerExec(args.container, [
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-tA",
    "-c",
    "SELECT COUNT(*) FROM sedatu_financiamientos_raw_2025;",
  ]).trim();
  const existing = Number.parseInt(countOut || "0", 10);
  if (existing > 0 && !args.force) {
    throw new Error(
      `[load-sedatu] sedatu_financiamientos_raw_2025 has ${existing} rows. Use --force to truncate + reload.`,
    );
  }

  // 3. Transcode ISO-8859-1 → UTF-8 in tempdir.
  const tempdir = mkdtempSync(join(tmpdir(), "sedatu-financiamientos-"));
  try {
    const utf8Path = join(tempdir, "financiamientos_2025.utf8.csv");
    const raw = readFileSync(args.csv);
    writeFileSync(utf8Path, transcodeLatin1ToUtf8(raw));

    // 4. Truncate raw + \copy.
    console.log(
      "[load-sedatu] truncating + loading raw CSV (UTF-8 transcoded)...",
    );
    dockerExecStdin(
      args.container,
      ["psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
      `TRUNCATE TABLE sedatu_financiamientos_raw_2025;`,
    );

    const copyCmd = `\\copy sedatu_financiamientos_raw_2025 (${RAW_HEADER_COLS.join(", ")}) FROM STDIN WITH (FORMAT csv, HEADER true)`;
    const csvBuf = readFileSync(utf8Path);
    execFileSync(
      "docker",
      [
        "exec",
        "-i",
        args.container,
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        copyCmd,
      ],
      { input: csvBuf, maxBuffer: 256 * 1024 * 1024 },
    );

    // 5. Build views atomically (audit W1: one transaction).
    console.log("[load-sedatu] building views (atomic transaction)...");
    dockerExecStdin(
      args.container,
      ["psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
      VIEWS_DDL_TRANSACTION,
    );

    // 6. Verify.
    const stats = dockerExec(args.container, [
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-tA",
      "-c",
      POST_LOAD_VERIFY_SQL,
    ]).trim();
    console.log(`[load-sedatu] done. ${stats}`);
  } finally {
    rmSync(tempdir, { recursive: true, force: true });
  }
}

// Auto-invoke when run directly (not when imported by tests).
const isMain =
  import.meta.url === `file://${process.argv[1] ?? ""}`.replace(/\\/g, "/");
if (isMain) {
  loadSedatuFinanciamientos(parseArgs()).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[load-sedatu] ✗ ${msg}`);
    process.exit(1);
  });
}
